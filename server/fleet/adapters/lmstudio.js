import { checkModelId, errorMessage, fetchJson, makeCapabilities, posInt, str } from "./base.js";
import { isValidModelId } from "../modelStates.js";

/**
 * LM Studio: GET /api/v0/models lists every downloaded model with state "loaded" | "not-loaded".
 * Load / unload run the `lms` CLI on the unit through a FIXED template over SSH (ctx.exec).
 * The model id must pass MODEL_ID_RE (no quotes possible) and be in the discovered catalog,
 * and is single-quoted in the command.
 */

const capabilities = makeCapabilities({ discover: true, load: true, unload: true, multiModel: true });
const discoverOnly = makeCapabilities({ discover: true, multiModel: true });

export const LMS_UNSUPPORTED_REASON =
  "LM Studio load/unload needs a shell on the unit (SSH); none is available for this unit";

/** `lms` is often only under ~/.lmstudio/bin, which non-interactive SSH shells do not add to PATH. */
const LMS_PREFIX = 'PATH="$HOME/.lmstudio/bin:$PATH" lms';

/** @param {"load"|"unload"} action @param {string} modelId must pass isValidModelId (throws otherwise) */
export function lmsCommand(action, modelId) {
  // Defence in depth: the id is single-quoted below, which is only safe for MODEL_ID_RE ids.
  if (!isValidModelId(modelId)) throw new Error("invalid model id");
  if (action === "load") return `${LMS_PREFIX} load '${modelId}' --yes`;
  if (action === "unload") return `${LMS_PREFIX} unload '${modelId}'`;
  throw new Error(`unknown lms action ${action}`);
}

/** @param {import("./base.js").AdapterContext} ctx @returns {Promise<import("./base.js").DiscoveryResult>} */
async function discover(ctx) {
  try {
    const body = await fetchJson(`${ctx.baseUrl}/api/v0/models`, {
      timeoutMs: ctx.timeoutMs,
      apiKey: ctx.apiKey ?? null,
      fetchImpl: ctx.fetchImpl,
    });
    const list = Array.isArray(body?.data) ? body.data : null;
    if (!list) {
      return {
        reachable: true,
        ready: false,
        models: [],
        errors: [`GET ${ctx.baseUrl}/api/v0/models: unexpected response (no data array)`],
      };
    }
    const models = [];
    const seen = new Set();
    for (const m of list) {
      const id = str(m?.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const loaded = m?.state === "loaded";
      models.push({
        modelId: id,
        label: id,
        type: str(m?.type),
        installed: true,
        loaded,
        listed: loaded,
        quantization: str(m?.quantization),
        contextLength: posInt(m?.loaded_context_length) ?? posInt(m?.max_context_length),
        sizeBytes: null,
        estMemoryBytes: null,
        sources: loaded ? ["catalog", "api"] : ["catalog"],
      });
    }
    return { reachable: true, ready: true, models, errors: [] };
  } catch (err) {
    return { reachable: false, ready: null, models: [], errors: [errorMessage(err)] };
  }
}

async function runLms(ctx, action, modelId) {
  if (typeof ctx.exec !== "function") return { ok: false, unsupported: true, error: LMS_UNSUPPORTED_REASON };
  const problem = checkModelId(modelId, ctx.catalog);
  if (problem) return { ok: false, error: problem };
  try {
    const cmd = lmsCommand(action, modelId);
    const out = await ctx.exec(cmd);
    return { ok: true, detail: str(String(out ?? "").slice(-2000)) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** @type {import("./base.js").FleetAdapter} */
export const lmstudioAdapter = {
  engine: "lmstudio",
  label: "LM Studio",
  capabilities,
  capabilitiesFor: (ctx) => (typeof ctx?.exec === "function" ? capabilities : discoverOnly),
  /** Why load/unload are off for this context, or null. */
  unsupportedReason: (ctx) => (typeof ctx?.exec === "function" ? null : LMS_UNSUPPORTED_REASON),
  discover,
  load: (ctx, modelId) => runLms(ctx, "load", modelId),
  unload: (ctx, modelId) => runLms(ctx, "unload", modelId),
};

export default lmstudioAdapter;
