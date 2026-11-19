import { errorMessage, isValidPortNumber, makeCapabilities, str } from "./base.js";

/**
 * Custom launch profiles (server/llmlaunch): each launcher is a configured model whose
 * process is started / stopped by its start.sh / stop.sh. Everything comes in through
 * ctx.launchers so tests are hermetic:
 *   list(sparkId) → launcher[]                       (LauncherStore.list)
 *   statuses(spark, launchers) → { [id]: "running"|"stopped"|"unknown" }  (LauncherManager.statuses)
 *   startJob(spark, launcher, "start"|"stop") → { ok, job } | { ok: false, reason }
 *   latestJob(sparkId) → job | null                  (LauncherManager.latestJob, optional)
 *   readJob(sparkId, jobId, since) → { lines, nextSeq } | null   (optional)
 *
 * modelId = launcher.name; the inventory replaces it with the id the serving API reports on
 * launcher.port when there is one.
 */

const capabilities = makeCapabilities({ discover: true, start: true, stop: true, logs: true });

export const LAUNCHER_SLOT = (launcherId) => `launcher:${launcherId}`;

/** @param {import("./base.js").AdapterContext & { launchers?: object, launcherFilter?: (l: object) => boolean }} ctx */
async function discover(ctx) {
  const api = ctx?.launchers;
  if (!api || typeof api.list !== "function") {
    return { reachable: null, ready: null, models: [], errors: ["launch profiles are not available"] };
  }
  let launchers;
  try {
    launchers = api.list(ctx.unit.id) ?? [];
  } catch (err) {
    return { reachable: null, ready: null, models: [], errors: [errorMessage(err)] };
  }
  if (typeof ctx.launcherFilter === "function") launchers = launchers.filter((l) => ctx.launcherFilter(l));
  if (launchers.length === 0) return { reachable: null, ready: null, models: [], errors: [] };

  const errors = [];
  /** @type {Record<string, string>} */
  let statuses = {};
  let statusOk = false;
  try {
    statuses = (await api.statuses(ctx.unit, launchers)) ?? {};
    // LauncherManager reports every launcher "unknown" when the host could not be reached.
    statusOk = launchers.some((l) => statuses[l.id] === "running" || statuses[l.id] === "stopped");
    if (!statusOk) errors.push(`launch profile status is unknown on ${ctx.unit.id} (host did not answer)`);
  } catch (err) {
    errors.push(errorMessage(err));
  }
  let job = null;
  try {
    job = typeof api.latestJob === "function" ? api.latestJob(ctx.unit.id) : null;
  } catch {
    job = null;
  }
  const models = launchers.map((l) => {
    const st = statuses[l.id];
    const mine = job && job.launcherId === l.id ? job : null;
    // A start job is a watcher that keeps "running" while the script runs, so only a stop job in
    // progress is an operation in flight here; the operation runner reports its own operations.
    const operation = mine && mine.status === "running" && mine.action === "stop" ? "stop" : null;
    const failed = Boolean(mine && mine.status === "failed");
    return {
      modelId: l.name,
      label: l.name,
      launcherId: l.id,
      port: isValidPortNumber(l.port) ? l.port : null,
      hasProfile: true,
      processRunning: st === "running" ? true : st === "stopped" ? false : null,
      operation,
      lastOperationFailed: failed,
      lastFailureAt: failed && Number.isFinite(mine.finishedAt) ? mine.finishedAt : null,
      lastError: failed ? str(mine.error) ?? `${mine.action} script failed (exit ${mine.exitCode ?? "unknown"})` : null,
      sources: ["launcher"],
    };
  });
  return { reachable: statusOk ? true : null, ready: null, models, errors };
}

function findLauncher(ctx, model) {
  const id = model?.launcherId;
  if (typeof id !== "string") return null;
  try {
    return (ctx.launchers.list(ctx.unit.id) ?? []).find((l) => l.id === id) ?? null;
  } catch {
    return null;
  }
}

async function act(ctx, action, model) {
  if (!ctx?.launchers || typeof ctx.launchers.startJob !== "function") {
    return { ok: false, unsupported: true, error: "launch profiles are not available" };
  }
  const launcher = findLauncher(ctx, model);
  if (!launcher) return { ok: false, error: "launch profile not found" };
  try {
    const res = await ctx.launchers.startJob(ctx.unit, launcher, action);
    if (!res?.ok) return { ok: false, error: res?.reason === "busy" ? "another launch script is running on this unit" : str(res?.reason) ?? `${action} failed` };
    return { ok: true, job: res.job };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** @type {import("./base.js").FleetAdapter} */
export const launchProfileAdapter = {
  engine: "launch-profile",
  label: "Launch profiles",
  capabilities,
  capabilitiesFor: (ctx) =>
    ctx?.unit?.platform === "windows" ? makeCapabilities({ discover: true }) : capabilities,
  discover,
  start: (ctx, model) => act(ctx, "start", model),
  stop: (ctx, model) => act(ctx, "stop", model),
  /** Lines of the unit's latest launcher job for this model. */
  logs: async (ctx, model, since = 0) => {
    const api = ctx?.launchers;
    const job = typeof api?.latestJob === "function" ? api.latestJob(ctx.unit.id) : null;
    if (!job || job.launcherId !== model?.launcherId || typeof api.readJob !== "function") {
      return { source: "launcher", lines: [], note: "no launcher output for this model yet" };
    }
    const read = api.readJob(ctx.unit.id, job.id, since);
    return { source: "launcher", lines: read?.lines ?? [], nextSeq: read?.nextSeq ?? since };
  },
};

export default launchProfileAdapter;
