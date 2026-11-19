import { checkModelId, errorMessage, fetchJson, makeCapabilities, num, posInt, str } from "./base.js";

/**
 * Ollama: /api/tags lists installed models, /api/ps the loaded ones. Load / unload use
 * keep_alive on POST /api/generate with no prompt (-1 = keep loaded, 0 = unload now).
 */

const capabilities = makeCapabilities({ discover: true, load: true, unload: true, multiModel: true });

const call = (ctx, path, extra = {}) =>
  fetchJson(`${ctx.baseUrl}${path}`, {
    timeoutMs: ctx.timeoutMs,
    apiKey: ctx.apiKey ?? null,
    fetchImpl: ctx.fetchImpl,
    ...extra,
  });

/** @param {import("./base.js").AdapterContext} ctx @returns {Promise<import("./base.js").DiscoveryResult>} */
async function discover(ctx) {
  const errors = [];
  const [tags, ps] = await Promise.allSettled([call(ctx, "/api/tags"), call(ctx, "/api/ps")]);
  /** @type {Map<string, import("./base.js").DiscoveredModel>} */
  const byId = new Map();
  const tagsOk = tags.status === "fulfilled";
  const psOk = ps.status === "fulfilled";
  if (!tagsOk) errors.push(errorMessage(tags.reason));
  if (!psOk) errors.push(errorMessage(ps.reason));

  if (tagsOk) {
    const list = Array.isArray(tags.value?.models) ? tags.value.models : null;
    if (!list) errors.push(`GET ${ctx.baseUrl}/api/tags: unexpected response (no models array)`);
    for (const m of list ?? []) {
      const id = str(m?.name) ?? str(m?.model);
      if (!id) continue;
      const size = num(m?.size);
      byId.set(id, {
        modelId: id,
        label: id,
        installed: true,
        quantization: str(m?.details?.quantization_level),
        parameterSize: str(m?.details?.parameter_size),
        sizeBytes: size,
        estMemoryBytes: size,
        contextLength: null,
        sources: ["catalog"],
      });
    }
  }
  if (psOk) {
    const list = Array.isArray(ps.value?.models) ? ps.value.models : null;
    if (!list) errors.push(`GET ${ctx.baseUrl}/api/ps: unexpected response (no models array)`);
    for (const m of list ?? []) {
      const id = str(m?.name) ?? str(m?.model);
      if (!id) continue;
      const prev = byId.get(id);
      const vram = num(m?.size_vram);
      const total = num(m?.size);
      byId.set(id, {
        modelId: id,
        label: id,
        installed: prev?.installed ?? false,
        quantization: prev?.quantization ?? str(m?.details?.quantization_level),
        parameterSize: prev?.parameterSize ?? str(m?.details?.parameter_size),
        sizeBytes: prev?.sizeBytes ?? null,
        estMemoryBytes: total ?? vram ?? prev?.estMemoryBytes ?? null,
        sizeVramBytes: vram,
        expiresAt: str(m?.expires_at),
        contextLength: posInt(m?.context_length) ?? prev?.contextLength ?? null,
        loaded: true,
        listed: true,
        sources: [...new Set([...(prev?.sources ?? []), "ps"])],
      });
    }
  }
  return {
    reachable: tagsOk || psOk,
    // Readiness: the server answered both its catalog and its process list.
    ready: tagsOk && psOk,
    // Without /api/ps nobody knows which installed models are loaded.
    loadedKnown: psOk,
    models: [...byId.values()],
    errors,
  };
}

async function keepAlive(ctx, modelId, keepAliveValue) {
  const problem = checkModelId(modelId, ctx.catalog);
  if (problem) return { ok: false, error: problem };
  try {
    const res = await call(ctx, "/api/generate", {
      method: "POST",
      body: { model: modelId, keep_alive: keepAliveValue, stream: false },
      allowEmpty: true,
      timeoutMs: ctx.actionTimeoutMs ?? 300000,
    });
    if (res && typeof res === "object" && typeof res.error === "string") return { ok: false, error: res.error };
    return { ok: true, detail: str(res?.done_reason) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** @type {import("./base.js").FleetAdapter} */
export const ollamaAdapter = {
  engine: "ollama",
  label: "Ollama",
  capabilities,
  discover,
  load: (ctx, modelId) => keepAlive(ctx, modelId, -1),
  unload: (ctx, modelId) => keepAlive(ctx, modelId, 0),
};

export default ollamaAdapter;
