import type { TagTone } from "../ui/Tag";
import type { FleetOperationStatus, FleetOperationStepStatus, ModelState, TargetHealth } from "../../api/fleetTypes";

export type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * Tag tone per model state. `unknown` (discovery failed) and `unreachable` (target down) never
 * share the neutral look of `stopped`: a failed measurement must not read as a healthy idle model.
 */
export function modelStateTone(state: ModelState | string): TagTone {
  switch (state) {
    case "serving": return "good";
    case "loaded": return "info";
    case "starting": return "acc";
    case "stopping": return "acc";
    case "failed": return "bad";
    case "unreachable": return "bad";
    case "unknown": return "warn";
    case "installed": return "neutral";
    case "configured": return "neutral";
    case "stopped": return "neutral";
    default: return "warn";
  }
}

/** Extra class so uncertain states also differ in shape (dashed outline), not only in colour. */
export function modelStateClass(state: ModelState | string): string {
  switch (state) {
    case "unknown": return "mm-state mm-state--uncertain";
    case "unreachable": return "mm-state mm-state--uncertain";
    default: return "mm-state";
  }
}

/** Literal keys only: the i18n check rejects dynamic keys. */
export function modelStateLabel(t: Translate, state: ModelState | string): string {
  switch (state) {
    case "installed": return t("state.installed");
    case "configured": return t("state.configured");
    case "starting": return t("state.starting");
    case "loaded": return t("state.loaded");
    case "serving": return t("state.serving");
    case "stopping": return t("state.stopping");
    case "stopped": return t("state.stopped");
    case "failed": return t("state.failed");
    case "unknown": return t("state.unknown");
    case "unreachable": return t("state.unreachable");
    default: return state;
  }
}

export function targetHealthTone(health: TargetHealth | string): TagTone {
  switch (health) {
    case "ready": return "good";
    case "degraded": return "warn";
    case "unreachable": return "bad";
    // Same tone as a model whose state is unknown: an unmeasured target is not a healthy-looking grey.
    default: return "warn";
  }
}

export function targetHealthLabel(t: Translate, health: TargetHealth | string): string {
  switch (health) {
    case "ready": return t("health.ready");
    case "degraded": return t("health.degraded");
    case "unreachable": return t("health.unreachable");
    case "unknown": return t("health.unknown");
    default: return health;
  }
}

export function operationStatusTone(status: FleetOperationStatus | string): TagTone {
  switch (status) {
    case "running": return "acc";
    case "succeeded": return "good";
    case "failed": return "bad";
    case "cancelled": return "warn";
    default: return "neutral";
  }
}

export function operationStatusLabel(t: Translate, status: FleetOperationStatus | string): string {
  switch (status) {
    case "running": return t("operation.status.running");
    case "succeeded": return t("operation.status.succeeded");
    case "failed": return t("operation.status.failed");
    case "cancelled": return t("operation.status.cancelled");
    default: return status;
  }
}

export function stepStatusTone(status: FleetOperationStepStatus | string): TagTone {
  switch (status) {
    case "running": return "acc";
    case "done": return "good";
    case "failed": return "bad";
    case "skipped": return "neutral";
    default: return "neutral";
  }
}

export function stepStatusLabel(t: Translate, status: FleetOperationStepStatus | string): string {
  switch (status) {
    case "pending": return t("operation.step.pending");
    case "running": return t("operation.step.running");
    case "done": return t("operation.step.done");
    case "failed": return t("operation.step.failed");
    case "skipped": return t("operation.step.skipped");
    default: return status;
  }
}

export function actionLabel(t: Translate, action: string): string {
  switch (action) {
    case "start": return t("actions.start");
    case "stop": return t("actions.stop");
    case "reload": return t("actions.reload");
    case "switch": return t("actions.switch");
    default: return action;
  }
}

/** Bytes as GB/TB for memory estimates; null stays unknown. */
export function formatMemory(bytes: number | null | undefined, unknown: string): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return unknown;
  const gb = bytes / 1024 ** 3;
  if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`;
  if (gb >= 100) return `${Math.round(gb)} GB`;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** Context length as tokens (e.g. 131072 → "128K"); null stays unknown, like memory. */
export function formatContext(tokens: number | null | undefined, unknown: string): string {
  if (tokens == null || !Number.isFinite(tokens) || tokens <= 0) return unknown;
  if (tokens >= 1024 && tokens % 1024 === 0) return `${tokens / 1024}K`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

/** "5 minutes ago" in the given locale (Intl, so no catalog strings are needed). */
export function formatRelativeTime(at: number, now: number, locale: string): string {
  const seconds = Math.round((at - now) / 1000);
  const abs = Math.abs(seconds);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (abs < 60) return rtf.format(seconds, "second");
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), "hour");
  return rtf.format(Math.round(seconds / 86400), "day");
}
