import { errorMessage, fetchJson, makeCapabilities, posInt, str } from "./base.js";

/**
 * OpenAI-compatible single-model servers (vLLM, llama.cpp, SGLang): GET /v1/models lists what
 * is served; a health path confirms readiness. There is no direct start/stop here: lifecycle
 * comes only from a launch profile on the same port.
 */

const capabilities = makeCapabilities({ discover: true });

/**
 * @param {object} spec
 * @param {string} spec.engine
 * @param {string} spec.label
 * @param {string[]} spec.healthPaths  tried in order; a 404 moves on to the next one
 * @returns {import("./base.js").FleetAdapter}
 */
export function createOpenAiCompatAdapter({ engine, label, healthPaths }) {
  const paths = Array.isArray(healthPaths) ? healthPaths : [];

  /**
   * @returns {Promise<{ ready: boolean|null, error: string|null }>} ready null = no health path
   */
  async function checkHealth(ctx) {
    for (const path of paths) {
      try {
        const body = await fetchJson(`${ctx.baseUrl}${path}`, {
          timeoutMs: ctx.timeoutMs,
          apiKey: ctx.apiKey ?? null,
          fetchImpl: ctx.fetchImpl,
          allowEmpty: true,
        });
        // llama.cpp answers {"status":"ok"} when ready, {"status":"loading model"} (503) while loading.
        if (body && typeof body === "object" && typeof body.status === "string" && !/^ok$/i.test(body.status)) {
          return { ready: false, error: null };
        }
        return { ready: true, error: null };
      } catch (err) {
        if (err?.status === 404 || err?.status === 405) continue;
        // A 503 is "not ready yet", not a discovery failure.
        if (err?.status === 503) return { ready: false, error: null };
        if (err?.code === "parse" && err?.status >= 200 && err?.status < 300) return { ready: true, error: null };
        return { ready: false, error: errorMessage(err) };
      }
    }
    return { ready: null, error: null };
  }

  /** @param {import("./base.js").AdapterContext} ctx @returns {Promise<import("./base.js").DiscoveryResult>} */
  async function discover(ctx) {
    const errors = [];
    const [modelsRes, health] = await Promise.all([
      fetchJson(`${ctx.baseUrl}/v1/models`, {
        timeoutMs: ctx.timeoutMs,
        apiKey: ctx.apiKey ?? null,
        fetchImpl: ctx.fetchImpl,
      }).then(
        (value) => ({ ok: true, value }),
        (err) => ({ ok: false, err })
      ),
      checkHealth(ctx),
    ]);
    if (health.error) errors.push(health.error);
    const models = [];
    let listOk = false;
    if (!modelsRes.ok) {
      errors.unshift(errorMessage(modelsRes.err));
    } else {
      const data = Array.isArray(modelsRes.value?.data) ? modelsRes.value.data : null;
      if (!data) errors.unshift(`GET ${ctx.baseUrl}/v1/models: unexpected response (no data array)`);
      else listOk = true;
      const seen = new Set();
      for (const m of data ?? []) {
        const id = str(m?.id);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        models.push({
          modelId: id,
          label: id,
          listed: true,
          loaded: true,
          contextLength: posInt(m?.max_model_len),
          quantization: null,
          sizeBytes: null,
          estMemoryBytes: null,
          sources: ["api"],
        });
      }
    }
    // Without a health path the model listing itself is the readiness signal.
    const ready = health.ready === null ? listOk : health.ready && listOk;
    const reachable = modelsRes.ok || (health.ready !== null && !health.error);
    return { reachable, ready, models, errors };
  }

  return { engine, label, capabilities, discover };
}

export const vllmAdapter = createOpenAiCompatAdapter({ engine: "vllm", label: "vLLM", healthPaths: ["/health"] });
export const llamaCppAdapter = createOpenAiCompatAdapter({
  engine: "llama.cpp",
  label: "llama.cpp server",
  healthPaths: ["/health"],
});
export const sglangAdapter = createOpenAiCompatAdapter({
  engine: "sglang",
  label: "SGLang",
  healthPaths: ["/health", "/get_model_info"],
});
