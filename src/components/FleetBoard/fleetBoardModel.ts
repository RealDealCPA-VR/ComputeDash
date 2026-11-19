import type { FleetOperation, FleetTarget } from "../../api/fleetTypes";
import type { SparkSnapshot } from "../../api/types";

/** Where the Models page shows a target (`?target=` deep link; the page selects it). */
export function modelsHref(targetId?: string | null): string {
  return targetId ? `/models?target=${encodeURIComponent(targetId)}` : "/models";
}

/** Board order: nodes first, then clusters, keeping the server's order inside each group. */
export function boardOrder(targets: FleetTarget[]): FleetTarget[] {
  return [...targets.filter((x) => x.kind === "node"), ...targets.filter((x) => x.kind === "cluster")];
}

/**
 * What a target is serving right now, without guessing:
 * - `models`: the server's fresh list (servingModels);
 * - `none`: known to serve nothing;
 * - `count`: an older server that only reports servingCount;
 * - `unknown`: with the reason it is not known. An unreachable target never shows a model list.
 */
export type ServingView =
  | { kind: "models"; models: string[] }
  | { kind: "none" }
  | { kind: "count"; count: number }
  | { kind: "unknown"; reason: "unreachable" | "group" | "noInventory" | "notReported" };

export function servingView(target: FleetTarget): ServingView {
  if (target.online === false || target.health === "unreachable") return { kind: "unknown", reason: "unreachable" };
  // A group cluster has no inference instance of its own: its members' rows say what runs.
  if (target.kind === "cluster" && target.clusterKind === "group") return { kind: "unknown", reason: "group" };
  const models = target.servingModels;
  if (Array.isArray(models)) {
    const names = models.filter((m) => typeof m === "string" && m.length > 0);
    return names.length ? { kind: "models", models: names } : { kind: "none" };
  }
  if (models === null) return { kind: "unknown", reason: "noInventory" };
  // Older server (no servingModels field): the count is still a fact when it is known.
  if (typeof target.servingCount === "number" && Number.isFinite(target.servingCount)) {
    return target.servingCount > 0 ? { kind: "count", count: target.servingCount } : { kind: "none" };
  }
  return { kind: "unknown", reason: "notReported" };
}

/** Status dot class: an unknown health is never shown as healthy. */
export function statusDotClass(target: FleetTarget): string {
  switch (target.health) {
    case "ready": return "sdot";
    case "degraded": return "sdot sdot--warn";
    case "unreachable": return "sdot sdot--off";
    default: return target.online === false ? "sdot sdot--off" : "sdot sdot--warn";
  }
}

/** True while an operation holds the target (or one of its member nodes). */
export function isTargetBusy(target: FleetTarget): boolean {
  return target.busy === true || (typeof target.activeOperationId === "string" && target.activeOperationId.length > 0);
}

/** The running operation for a target: by the id the target names, else one started on it. */
export function operationFor(target: FleetTarget, operations: FleetOperation[] | null): FleetOperation | null {
  if (!operations?.length) return null;
  const running = operations.filter((op) => op.status === "running");
  if (target.activeOperationId) {
    const byId = running.find((op) => op.id === target.activeOperationId);
    if (byId) return byId;
  }
  return running.find((op) => op.targetId === target.targetId) ?? null;
}

/** The model id part of a modelKey ("<engine>|<port|profile>|<modelId>"); the key itself when it has no id part. */
export function modelIdOf(modelKey: string | null | undefined): string {
  if (!modelKey) return "";
  const parts = modelKey.split("|");
  return parts.length >= 3 ? parts.slice(2).join("|") || modelKey : modelKey;
}

/** 1-based position of the current step and the step count; null when the server sent no steps. */
export function operationProgress(op: FleetOperation): { step: number; total: number; label: string | null } | null {
  const steps = Array.isArray(op.steps) ? op.steps : [];
  if (!steps.length) return null;
  let index = steps.findIndex((s) => s.id === op.step);
  if (index < 0) index = steps.findIndex((s) => s.status === "running");
  if (index < 0) index = Math.max(0, steps.filter((s) => s.status === "done" || s.status === "skipped").length - 1);
  return { step: index + 1, total: steps.length, label: steps[index]?.label ?? null };
}

/** A unit id from a node targetId ("node:<unitId>"), else null. */
export function unitIdOf(targetId: string): string | null {
  return targetId.startsWith("node:") ? targetId.slice(5) : null;
}

/** Live readings of one unit from the dashboard snapshot. Every unavailable value is null, never 0. */
export interface NodeLive {
  online: boolean;
  /** Decode tok/s of the first serving endpoint; null = nothing serving or not measured. */
  tps: number | null;
  /** True when an endpoint answers but its rate could not be read. */
  tpsUnmeasured: boolean;
  memory: { usedMb: number; totalMb: number; pct: number; unified: boolean } | null;
  /** GPU temperature in °C; null when the unit does not report one. */
  gpuTempC: number | null;
}

export function nodeLive(spark: SparkSnapshot | null | undefined): NodeLive | null {
  if (!spark) return null;
  if (!spark.online) return { online: false, tps: null, tpsUnmeasured: false, memory: null, gpuTempC: null };
  const llm = Array.isArray(spark.metrics.llm) ? spark.metrics.llm.find((l) => l.available) ?? null : null;
  const measured = llm != null && llm.measurementValid !== false && Number.isFinite(llm.generationTps);
  const gpu = spark.metrics.gpu;
  const avail = gpu?.metricAvailability;
  const vramKnown = avail?.vramUsed !== false && avail?.vramTotal !== false;
  const vram = gpu?.vram?.total ? gpu.vram : null;
  const um = spark.metrics.unifiedMemory;
  let memory: NodeLive["memory"] = null;
  if (vram && vramKnown) memory = { usedMb: vram.used, totalMb: vram.total, pct: vram.percentage, unified: false };
  else if (um && um.total > 0) memory = { usedMb: um.used, totalMb: um.total, pct: um.percentage, unified: true };
  const temp = gpu && avail?.temperature !== false && typeof gpu.temperature === "number" && gpu.temperature > 0 ? gpu.temperature : null;
  return {
    online: true,
    tps: measured ? llm!.generationTps : null,
    tpsUnmeasured: llm != null && !measured,
    memory,
    gpuTempC: temp,
  };
}

/** Bytes as a short GB/TB figure; null stays null. */
export function formatCapacity(bytes: number | null | undefined): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return null;
  const gb = bytes / 1024 ** 3;
  if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`;
  return `${Math.round(gb)} GB`;
}

export function platformLabel(platform: FleetTarget["platform"]): string | null {
  switch (platform) {
    case "linux": return "Linux";
    case "darwin": return "macOS";
    case "windows": return "Windows";
    default: return null;
  }
}
