import { errorMessage, isValidPortNumber, makeCapabilities, str } from "./base.js";
import { isValidModelId } from "../modelStates.js";

/**
 * macOS / MLX runtime profiles through the Mac agent's control endpoint
 * (server/collectors/MacRuntimeControl.js). The functions come in through ctx so tests never
 * touch the network:
 *   ctx.mac.readRuntimeControl(unit) → RuntimeControlView
 *   ctx.mac.beginRuntimeControl(unit, "start"|"stop", { runtime, model? }) → RuntimeControlView
 *
 * Configured models are targets[].models; serving evidence is the view's `serving` list
 * (null = the probe did not answer, which is not "nothing serving").
 */

const capabilities = makeCapabilities({ discover: true, start: true, stop: true, logs: true });

export const MAC_PROFILE_SLOT = (runtime) => `mac:${runtime}`;
export const MAC_BUSY_ERROR = "Mac agent is busy with another operation";

function viewError(view) {
  return str(view?.error) ?? str(view?.reason) ?? `mac runtime control is ${view?.state ?? "unavailable"}`;
}

/** @param {import("./base.js").AdapterContext & { mac?: object }} ctx */
async function discover(ctx) {
  const read = ctx?.mac?.readRuntimeControl;
  if (typeof read !== "function") {
    return { reachable: null, ready: null, models: [], errors: ["mac runtime control is not available"] };
  }
  let view;
  try {
    view = await read(ctx.unit);
  } catch (err) {
    return { reachable: false, ready: null, models: [], errors: [errorMessage(err)] };
  }
  const errors = [];
  if (!view || typeof view !== "object") {
    return { reachable: false, ready: null, models: [], errors: ["mac runtime control returned no view"] };
  }
  if (view.state !== "ready") errors.push(viewError(view));
  const serving = Array.isArray(view.serving) ? view.serving : null;
  const targets = Array.isArray(view.targets) ? view.targets : [];
  const op = view.operation && typeof view.operation === "object" ? view.operation : null;
  const models = [];
  for (const t of targets) {
    const runtime = str(t?.name);
    if (!runtime) continue;
    const entries = serving ? serving.filter((r) => r?.name === runtime) : null;
    const list = Array.isArray(t.models) ? t.models : [];
    for (const m of list) {
      const id = str(m?.id);
      if (!id) continue;
      let processRunning = null;
      let listed = false;
      let ready = null;
      let port = null;
      if (entries) {
        const forModel = entries.filter((r) => r?.model === id || (r?.model == null && list.length === 1));
        processRunning = forModel.length > 0;
        const servingEntry = forModel.find((r) => r?.state === "serving");
        const anyEntry = servingEntry ?? forModel[0];
        if (anyEntry && isValidPortNumber(anyEntry.port)) port = anyEntry.port;
        if (servingEntry) {
          listed = true;
          ready = servingEntry.health ? servingEntry.health.ok === true : true;
        }
      }
      const opForThis =
        op && op.runtime === runtime && (op.model == null || op.model === id) ? op : null;
      const operation = opForThis && opForThis.state === "running" ? (opForThis.action === "stop" ? "stop" : "start") : null;
      const failed = Boolean(opForThis && opForThis.state === "complete" && opForThis.ok === false);
      models.push({
        modelId: id,
        label: str(m?.label) ?? id,
        macRuntime: runtime,
        port,
        hasProfile: true,
        processRunning,
        listed,
        loaded: listed,
        ready,
        operation,
        lastOperationFailed: failed,
        lastError: failed ? str(opForThis.error) : null,
        startable: t.startable === true,
        stoppable: t.stoppable === true,
        startReason: str(t.reason),
        sources: listed ? ["mac-profile", "api"] : ["mac-profile"],
      });
    }
  }
  return {
    reachable: serving != null ? true : view.state === "ready" ? true : null,
    ready: serving != null,
    models,
    errors: serving == null && view.state === "ready" ? ["mac agent did not report serving runtimes"] : errors,
  };
}

async function act(ctx, action, model) {
  const begin = ctx?.mac?.beginRuntimeControl;
  if (typeof begin !== "function") return { ok: false, unsupported: true, error: "mac runtime control is not available" };
  const runtime = str(model?.macRuntime);
  if (!runtime) return { ok: false, error: "model has no mac runtime" };
  const modelId = model?.modelId;
  if (action === "start" && !isValidModelId(modelId)) return { ok: false, error: "invalid model id" };
  try {
    const view = await begin(ctx.unit, action, action === "start" ? { runtime, model: modelId } : { runtime });
    if (!view || view.state !== "ready" || view.ok === false) return { ok: false, error: viewError(view) };
    // A busy view (another pending job, or the agent busy) carries someone else's operation:
    // success only when the operation is the one asked for.
    const op = view.operation && typeof view.operation === "object" ? view.operation : null;
    const matches =
      op != null &&
      op.runtime === runtime &&
      op.action === action &&
      (action !== "start" || op.model == null || op.model === modelId);
    if (!matches) return { ok: false, error: MAC_BUSY_ERROR };
    return { ok: true, operation: op, detail: str(view.output) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** @type {import("./base.js").FleetAdapter} */
export const macProfileAdapter = {
  engine: "mac-profile",
  label: "macOS runtime profiles",
  capabilities,
  discover,
  start: (ctx, model) => act(ctx, "start", model),
  stop: (ctx, model) => act(ctx, "stop", model),
  /** Output of the latest control operation, as log lines. */
  logs: async (ctx) => {
    try {
      const view = await ctx?.mac?.readRuntimeControl?.(ctx.unit);
      const text = str(view?.operation?.output) ?? str(view?.output) ?? "";
      return { source: "mac-agent", lines: text ? text.split("\n").map((t, i) => ({ seq: i + 1, text: t })) : [] };
    } catch (err) {
      return { source: "mac-agent", lines: [], note: errorMessage(err) };
    }
  },
};

export default macProfileAdapter;
