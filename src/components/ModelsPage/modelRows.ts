import type { FleetModel, FleetRuntime, FleetTarget, ModelState } from "../../api/fleetTypes";

/**
 * Display order of a model row: what is serving first, then what is warming up or loaded,
 * then what could be started, then everything idle, failed or unmeasured.
 */
export function modelStateRank(state: ModelState | string): number {
  switch (state) {
    case "serving": return 0;
    case "loaded":
    case "starting":
    case "stopping": return 1;
    case "configured":
    case "installed": return 2;
    default: return 3;
  }
}

/** Rows sorted by state rank, then by label (case-insensitive), then by key so the order is stable. */
export function sortModelsForDisplay(models: FleetModel[]): FleetModel[] {
  return [...models].sort(
    (a, b) =>
      modelStateRank(a.state) - modelStateRank(b.state) ||
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) ||
      a.modelKey.localeCompare(b.modelKey)
  );
}

/** True when a runtime can change what is running at all (start/stop a server or load/unload a model). */
export function runtimeHasLifecycle(runtime: FleetRuntime): boolean {
  const c = runtime.capabilities;
  return Boolean(c.start || c.stop || c.load || c.unload);
}

/** The runtime a model row belongs to: same engine, and the same port when both are known. */
export function runtimeForModel(model: FleetModel, runtimes: FleetRuntime[]): FleetRuntime | null {
  return runtimes.find((r) => r.engine === model.engine && (model.port == null || r.port == null || r.port === model.port)) ?? null;
}

export type NoActionReason = "windowsOllamaOnly" | "engineNoLifecycle" | "noLaunchProfile" | "notInThisState";

/**
 * Why a row offers no lifecycle action (start, stop, reload), or null when it offers one.
 * Derived from the platform, the runtime's capabilities and the model's launch source; the server's
 * `actions` stay the only authority on what is allowed.
 */
export function noActionReason(model: FleetModel, target: Pick<FleetTarget, "platform">, runtimes: FleetRuntime[]): NoActionReason | null {
  if (model.actions.start || model.actions.stop || model.actions.reload) return null;
  if (target.platform === "windows" && model.engine.toLowerCase() !== "ollama") return "windowsOllamaOnly";
  const runtime = runtimeForModel(model, runtimes);
  if (runtime && !runtimeHasLifecycle(runtime)) return "engineNoLifecycle";
  const engineCanLoad = runtime != null && (runtime.capabilities.load || runtime.capabilities.unload);
  if (!model.launcherId && !model.macRuntime && !engineCanLoad) return "noLaunchProfile";
  return "notInThisState";
}

/**
 * Windows nodes can only be controlled through Ollama today: true when the node has no runtime
 * able to start, stop, load or unload (falls back to the target's lifecycle capability before
 * the inventory has arrived).
 */
export function windowsWithoutControl(target: FleetTarget, runtimes: FleetRuntime[] | null): boolean {
  if (target.kind !== "node" || target.platform !== "windows") return false;
  if (runtimes) return !runtimes.some(runtimeHasLifecycle);
  return !target.capabilities.lifecycle;
}
