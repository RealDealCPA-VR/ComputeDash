import crypto from "crypto";
import { getAdapter } from "./adapters/index.js";
import { errorMessage } from "./adapters/base.js";
import { isValidModelId } from "./modelStates.js";
import { nodeTargetId } from "./targets.js";

/**
 * Fleet lifecycle operations (plan §3.3): start, stop, reload and switch, one at a time per
 * target. A cluster operation also locks every member node, and a node operation blocks any
 * cluster that contains the node.
 *
 * Each operation is a list of steps with a timestamped log. Readiness is confirmed from a fresh
 * inventory (the model listed by the serving API and the health check passing), polled with
 * backoff until the readiness timeout. Cancel only stops the waiting: nothing that already
 * started is killed. Every network / exec call goes through the host (FleetModelManager), so
 * tests are hermetic.
 *
 * @typedef {import("./inventory.js").FleetInventory} FleetInventory
 * @typedef {import("./inventory.js").FleetModel} FleetModel
 *
 * @typedef {"start"|"stop"|"reload"|"switch"} OperationAction
 * @typedef {"running"|"succeeded"|"failed"|"cancelled"} OperationStatus
 * @typedef {{ id: string, label: string, status: "pending"|"running"|"done"|"failed"|"skipped", detail: string|null }} OperationStep
 *
 * @typedef {object} FleetOperation
 * @property {string} id
 * @property {string} targetId
 * @property {OperationAction} action
 * @property {string} modelKey
 * @property {string|null} fromModelKey   first of fromModelKeys (compatibility)
 * @property {string[]} fromModelKeys     every model a switch stops on the runtime (and restores on rollback)
 * @property {OperationStatus} status
 * @property {string} step
 * @property {OperationStep[]} steps
 * @property {number} startedAt
 * @property {number|null} finishedAt
 * @property {string|null} error
 *
 * @typedef {object} RunnerTarget
 * @property {string} targetId
 * @property {"node"|"cluster"} kind
 * @property {string} name
 * @property {string[]} memberIds          cluster member unit ids ([] for nodes)
 * @property {string} unitId               the unit that runs the actions (node, or cluster head)
 * @property {number|null} memoryTotalBytes
 *
 * @typedef {object} RunnerScope  tunnels / connections held for one operation
 * @property {() => void} close
 *
 * @typedef {object} RunnerHost
 * @property {(targetId: string) => RunnerTarget|null} getTarget
 * @property {() => RunnerScope} openScope
 * @property {(targetId: string, scope: RunnerScope) => Promise<FleetInventory>} collect
 *   fresh inventory with raw evidence (no operation overlay, backoff ignored); never cached
 * @property {(targetId: string) => Promise<FleetInventory|null>} refresh   normal refresh (cached)
 * @property {(targetId: string, model: FleetModel, scope: RunnerScope, inv: FleetInventory) => Promise<object>} contextFor
 *   adapter context for acting on this model's runtime
 * @property {{ readJob?: (unitId: string, jobId: string, since: number) => any }|null} [launchers]
 * @property {(lockIds: string[]) => void} [onChange]  an operation started / changed phase / ended
 */

export const OPERATION_ACTIONS = Object.freeze(["start", "stop", "reload", "switch"]);
export const OPERATION_ID_RE = /^op-[a-f0-9]{12}$/;
export const DEFAULT_READINESS_TIMEOUT_MS = Object.freeze({ node: 10 * 60_000, cluster: 30 * 60_000 });
export const DEFAULT_STOP_TIMEOUT_MS = 5 * 60_000;
/** A port-less launch profile: how long its start job is watched before the process is checked. */
export const DEFAULT_START_SETTLE_MS = 20_000;
export const CANCEL_REFUSED_REASON = "Cancel is only possible while waiting for readiness";
export const NO_PORT_SWITCH_ERROR = "Set a port on this launch profile so readiness can be verified before switching";
export const MAX_LOG_LINES = 2000;
export const MAX_FINISHED_RECORDS = 50;
const MAX_FAILURES = 500;

/** States in which a model holds its runtime (must be stopped before another single model starts). */
const ACTIVE_STATES = new Set(["serving", "loaded", "starting", "stopping"]);

const STEP_LABELS = {
  reachable: "Confirm the target is reachable",
  available: "Confirm the model is available",
  capacity: "Check memory capacity",
  guard: "Check running operations and in-flight requests",
  "stop-current": "Stop the current model",
  stop: "Stop the model",
  start: "Start the model",
  ready: "Wait for readiness",
  refresh: "Refresh the inventory",
  "rollback-stop": "Rollback: stop the requested model",
  "rollback-start": "Rollback: restore the previous model",
  "rollback-ready": "Rollback: wait for readiness",
};

const PLANS = {
  start: ["reachable", "available", "capacity", "guard", "start", "ready", "refresh"],
  stop: ["reachable", "available", "guard", "stop", "refresh"],
  reload: ["reachable", "available", "guard", "stop", "start", "ready", "refresh"],
  switch: ["reachable", "available", "capacity", "guard", "stop-current", "start", "ready", "refresh"],
};

/**
 * A step failure with a machine-readable code. `modelKey`: the model the failure is about (the
 * one being stopped or started); a failure only marks a model "failed" when the operation
 * actually dispatched a stop or start for that model.
 */
export class OperationError extends Error {
  /** @param {string} code @param {string} message @param {{ modelKey?: string|null }} [opts] */
  constructor(code, message, { modelKey = null } = {}) {
    super(message);
    this.name = "OperationError";
    this.code = code;
    this.modelKey = modelKey;
  }
}

class Cancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "Cancelled";
  }
}

const GB = 1024 ** 3;
const fmtGb = (b) => `${(b / GB).toFixed(b >= 10 * GB ? 0 : 1)} GB`;
const fmtDuration = (ms) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

/** How a model is brought up / taken down. */
function mechanismOf(model, inv) {
  if (model.launcherId) return { kind: "launcher", adapter: getAdapter("launch-profile") };
  if (model.macRuntime) return { kind: "mac", adapter: getAdapter("mac-profile") };
  const runtime = (inv?.runtimes ?? []).find((r) => r.engine === model.engine && r.port === model.port);
  const adapter = getAdapter(model.engine);
  if (adapter && runtime?.capabilities?.multiModel) return { kind: "multi", adapter };
  return null;
}

function canStart(mech) {
  if (!mech?.adapter) return false;
  return mech.kind === "multi" ? typeof mech.adapter.load === "function" : typeof mech.adapter.start === "function";
}

function canStop(mech) {
  if (!mech?.adapter) return false;
  return mech.kind === "multi" ? typeof mech.adapter.unload === "function" : typeof mech.adapter.stop === "function";
}

const MECH_LABEL = { launcher: "launch profile", mac: "macOS runtime profile", multi: "multi-model runtime" };

/**
 * Models that hold the runtime the requested model will use (plan §3.3 step 5), strictly the
 * same runtime: multi-model engines → the same engine and port; launch profiles → the same
 * port; mac profiles → the same mac runtime or the same port. Models on other ports keep running.
 * @param {FleetInventory} inv
 * @param {FleetModel} model
 * @param {"multi"|"launcher"|"mac"} kind
 */
export function currentModelsFor(inv, model, kind) {
  return (inv.models ?? []).filter((m) => {
    if (m.modelKey === model.modelKey || !ACTIVE_STATES.has(m.state)) return false;
    const samePort = model.port != null && m.port === model.port;
    if (kind === "multi") return m.engine === model.engine && samePort;
    if (kind === "launcher") return samePort;
    return (m.macRuntime != null && m.macRuntime === model.macRuntime) || samePort;
  });
}

function reasonNotAllowed(action, model) {
  if (model.state === "unreachable") return `${model.label} is unreachable`;
  if (model.state === "unknown") return `the state of ${model.label} is unknown; refresh the inventory`;
  if (model.state === "starting" || model.state === "stopping") return `${model.label} is ${model.state}; wait for it to settle`;
  if ((action === "start" || action === "switch") && (model.state === "serving" || model.state === "loaded")) {
    return `${model.label} is already ${model.state}`;
  }
  if ((action === "stop" || action === "reload") && !ACTIVE_STATES.has(model.state) && model.state !== "failed") {
    return `${model.label} is ${model.state}, not running`;
  }
  return `${action} is not supported for ${model.label} on this runtime`;
}

export class OperationRunner {
  /**
   * @param {object} opts
   * @param {RunnerHost} opts.host
   * @param {(event: object) => void} [opts.recordEvent]
   * @param {() => number} [opts.now]
   * @param {{ node?: number, cluster?: number }} [opts.readinessTimeoutMs]
   * @param {number} [opts.stopTimeoutMs]
   * @param {number} [opts.startSettleMs]  port-less launch profile: start-job watch window
   * @param {{ initial?: number, max?: number, factor?: number, job?: number }} [opts.pollMs]
   * @param {number} [opts.maxLogLines]
   * @param {number} [opts.maxRecords]   finished operations kept for GET by id
   */
  constructor({
    host,
    recordEvent = () => {},
    now = Date.now,
    readinessTimeoutMs = {},
    stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
    startSettleMs = DEFAULT_START_SETTLE_MS,
    pollMs = {},
    maxLogLines = MAX_LOG_LINES,
    maxRecords = MAX_FINISHED_RECORDS,
  }) {
    this.host = host;
    this.recordEvent = recordEvent;
    this.now = now;
    this.readinessTimeoutMs = { ...DEFAULT_READINESS_TIMEOUT_MS, ...readinessTimeoutMs };
    this.stopTimeoutMs = stopTimeoutMs;
    this.startSettleMs = startSettleMs;
    this.pollMs = { initial: 2000, max: 15_000, factor: 1.5, job: 1000, ...pollMs };
    this.maxLogLines = maxLogLines;
    this.maxRecords = maxRecords;
    /** @type {Map<string, object>} id → internal record */
    this.records = new Map();
    /** @type {Map<string, string>} lock id (target id) → operation id */
    this.locks = new Map();
    /** @type {Map<string, { at: number, error: string }>} "<targetId>#<modelKey>" → last failure */
    this.failures = new Map();
    this.closed = false;
  }

  // ─── queries used by the inventory and the targets list ────────────────────

  /** Target ids locked by a running operation (the target and, for clusters, its member nodes). */
  busyTargetIds() {
    return new Set(this.locks.keys());
  }

  /** @param {string} targetId */
  isBusy(targetId) {
    return this.locks.has(targetId);
  }

  /** @returns {Map<string, string>} lock id (target id) → id of the running operation holding it */
  activeLocks() {
    return new Map(this.locks);
  }

  /**
   * Operations newest first (by startedAt): every running one, plus, unless `activeOnly`, those
   * that finished within the last `recentMs`. Same shape as read(id).operation.
   * @param {{ activeOnly?: boolean, recentMs?: number }} [opts]
   * @returns {FleetOperation[]}
   */
  list({ activeOnly = false, recentMs = 10 * 60_000 } = {}) {
    const now = this.now();
    const out = [];
    for (const rec of this.records.values()) {
      const op = rec.op;
      const keep =
        op.status === "running" ||
        (!activeOnly && Number.isFinite(op.finishedAt) && now - /** @type {number} */ (op.finishedAt) <= recentMs);
      if (keep) out.push(snapshotOp(op));
    }
    return out.sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  }

  /**
   * Operation phase for one model while an operation acts on it.
   * @returns {"start"|"stop"|null}
   */
  inFlight(targetId, modelKey) {
    for (const rec of this.records.values()) {
      if (rec.op.status !== "running" || rec.op.targetId !== targetId || !rec.phase) continue;
      if (rec.phase.keys.includes(modelKey)) return rec.phase.kind;
    }
    return null;
  }

  /** @returns {{ at: number, error: string }|null} */
  lastFailure(targetId, modelKey) {
    return this.failures.get(`${targetId}#${modelKey}`) ?? null;
  }

  /** @returns {FleetOperation|null} */
  get(id) {
    const rec = this.records.get(id);
    return rec ? snapshotOp(rec.op) : null;
  }

  /**
   * @param {string} id
   * @param {number} [since]  lines with seq ≥ since
   * @returns {{ operation: FleetOperation, lines: {seq:number,text:string}[], nextSeq: number }|null}
   */
  read(id, since = 0) {
    const rec = this.records.get(id);
    if (!rec) return null;
    const from = Number.isInteger(since) && since > 0 ? since : 0;
    return {
      operation: snapshotOp(rec.op),
      lines: rec.lines.filter((l) => l.seq >= from).map((l) => ({ ...l })),
      nextSeq: rec.seq + 1,
    };
  }

  /** Running operation on a target (or locking it), if any. */
  activeFor(targetId) {
    const id = this.locks.get(targetId);
    return id ? this.get(id) : null;
  }

  // ─── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Start an operation. Locks are taken synchronously, so a second request gets `busy` at once.
   * @param {string} targetId
   * @param {{ action: OperationAction, modelKey: string, force?: boolean, rollback?: boolean }} request
   * @returns {{ ok: true, operation: FleetOperation } | { ok: false, code: string, error: string, operation?: FleetOperation }}
   */
  start(targetId, request) {
    if (this.closed) return { ok: false, code: "shutting_down", error: "the dashboard is shutting down" };
    const action = request?.action;
    if (!OPERATION_ACTIONS.includes(action)) return { ok: false, code: "validation", error: "action must be start, stop, reload or switch" };
    if (typeof request.modelKey !== "string" || !request.modelKey) return { ok: false, code: "validation", error: "modelKey is required" };
    const target = this.host.getTarget(targetId);
    if (!target) return { ok: false, code: "unknown_target", error: `target ${targetId} does not exist` };
    const lockIds = [targetId, ...(target.kind === "cluster" ? target.memberIds.map(nodeTargetId) : [])];
    const holder = lockIds.map((l) => this.locks.get(l)).find(Boolean);
    // A node operation also blocks clusters containing the node: their lock list includes it.
    if (holder) {
      const other = this.records.get(holder)?.op;
      const where = other && other.targetId !== targetId ? ` (${other.targetId})` : "";
      return {
        ok: false,
        code: "busy",
        error: `another operation is running on this target${where}`,
        operation: other ? snapshotOp(other) : undefined,
      };
    }
    const now = this.now();
    /** @type {FleetOperation} */
    const op = {
      id: `op-${crypto.randomBytes(6).toString("hex")}`,
      targetId,
      action,
      modelKey: request.modelKey,
      fromModelKey: null,
      fromModelKeys: [],
      status: "running",
      step: PLANS[action][0],
      steps: PLANS[action].map((id) => ({ id, label: STEP_LABELS[id], status: "pending", detail: null })),
      startedAt: now,
      finishedAt: null,
      error: null,
    };
    let cancel;
    const cancelled = new Promise((_, reject) => {
      cancel = () => reject(new Cancelled());
    });
    cancelled.catch(() => {});
    const rec = {
      op,
      target,
      lockIds,
      force: request.force === true,
      rollback: request.rollback !== false,
      lines: [],
      seq: 0,
      phase: null,
      cancelRequested: false,
      cancellable: false, // true only while waiting for readiness
      cancelled,
      cancel,
      scope: null,
      jobs: new Map(), // jobId → since
      /** @type {Map<string, Set<"stop"|"start">>} model key → actions actually dispatched */
      effects: new Map(),
    };
    for (const l of lockIds) this.locks.set(l, op.id);
    this.records.set(op.id, rec);
    this._log(rec, `${action} ${op.modelKey} on ${target.name} (force: ${rec.force ? "yes" : "no"}${action === "switch" ? `, rollback: ${rec.rollback ? "yes" : "no"}` : ""})`);
    this._event(rec, "started", "info", `${capitalize(action)} ${op.modelKey} on ${target.name}`);
    this._changed(rec);
    rec.done = this._run(rec).catch((err) => {
      // _run never throws; this is a last-resort guard so the lock is not left behind.
      this._log(rec, `internal error: ${errorMessage(err)}`);
      this._finish(rec, "failed", errorMessage(err));
    });
    return { ok: true, operation: snapshotOp(op) };
  }

  /**
   * Cancel the waiting of a running operation. Only honoured while it waits for readiness (the
   * ready / rollback-ready steps): stopping in the middle of a stop or start could leave nothing
   * running. Never kills anything that already started.
   * @returns {{ cancelled: boolean, reason?: string }|null}  null when the operation does not exist
   */
  cancel(id) {
    const rec = this.records.get(id);
    if (!rec) return null;
    if (rec.op.status !== "running") return { cancelled: false, reason: "The operation is no longer running" };
    if (rec.cancelRequested) return { cancelled: false, reason: "Cancel was already requested" };
    if (!rec.cancellable) {
      this._log(rec, `cancel refused: ${CANCEL_REFUSED_REASON.toLowerCase()}`);
      return { cancelled: false, reason: CANCEL_REFUSED_REASON };
    }
    rec.cancelRequested = true;
    this._log(rec, "cancel requested: no longer waiting; anything already started keeps running");
    rec.cancel();
    return { cancelled: true };
  }

  /** Stop waiting on every running operation (dashboard shutdown). */
  shutdown() {
    this.closed = true;
    for (const rec of this.records.values()) {
      if (rec.op.status === "running" && !rec.cancelRequested) {
        rec.cancelRequested = true;
        this._log(rec, "the dashboard is shutting down: no longer waiting");
        rec.cancel();
      }
    }
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  _log(rec, text) {
    rec.seq += 1;
    rec.lines.push({ seq: rec.seq, text: `${new Date(this.now()).toISOString()} ${text}` });
    if (rec.lines.length > this.maxLogLines) rec.lines.splice(0, rec.lines.length - this.maxLogLines);
  }

  _event(rec, outcome, severity, message) {
    try {
      const t = rec.target;
      this.recordEvent({
        type: `fleet.${rec.op.action}.${outcome}`,
        severity,
        sparkId: t.unitId,
        sparkName: t.name,
        message,
        data: { targetId: rec.op.targetId, operationId: rec.op.id, modelKey: rec.op.modelKey, fromModelKey: rec.op.fromModelKey },
      });
    } catch {
      /* events never break an operation */
    }
  }

  _changed(rec) {
    try {
      this.host.onChange?.(rec.lockIds);
    } catch {
      /* ignore */
    }
  }

  _setPhase(rec, kind, keys) {
    rec.phase = kind ? { kind, keys } : null;
    this._changed(rec);
  }

  /** Await `promise`, or reject with Cancelled when the operation is cancelled first. */
  _race(rec, promise) {
    const p = Promise.resolve(promise);
    p.catch(() => {}); // a call we stopped waiting for must not become an unhandled rejection
    return Promise.race([p, rec.cancelled]);
  }

  _sleep(rec, ms) {
    let timer;
    const p = new Promise((resolve) => {
      timer = setTimeout(resolve, Math.max(0, ms));
    });
    return this._race(rec, p).finally(() => clearTimeout(timer));
  }

  _step(rec, id) {
    return rec.op.steps.find((s) => s.id === id);
  }

  /**
   * Run one step. `fn` returns a detail string, or `{ skip: detail }` to mark the step skipped.
   */
  async _runStep(rec, id, fn) {
    let step = this._step(rec, id);
    if (!step) {
      step = { id, label: STEP_LABELS[id] ?? id, status: "pending", detail: null };
      rec.op.steps.push(step);
    }
    if (rec.cancelRequested) throw new Cancelled();
    step.status = "running";
    rec.op.step = id;
    this._log(rec, `▶ ${step.label}`);
    try {
      const out = await fn(step);
      if (out && typeof out === "object" && "skip" in out) {
        step.status = "skipped";
        step.detail = out.skip ?? null;
        this._log(rec, `– ${step.label}: skipped${step.detail ? ` (${step.detail})` : ""}`);
      } else {
        step.status = "done";
        step.detail = typeof out === "string" ? out : step.detail;
        this._log(rec, `✓ ${step.label}${step.detail ? `: ${step.detail}` : ""}`);
      }
    } catch (err) {
      if (err instanceof Cancelled) {
        step.status = "skipped";
        step.detail = "cancelled";
        this._log(rec, `– ${step.label}: cancelled`);
      } else {
        step.status = "failed";
        step.detail = errorMessage(err);
        this._log(rec, `✗ ${step.label}: ${step.detail}`);
      }
      throw err;
    }
  }

  async _run(rec) {
    const { op } = rec;
    const state = { inv: null, model: null, mech: null, current: [], stopped: [], startAttempted: false };
    try {
      rec.scope = this.host.openScope();
    } catch (err) {
      rec.scope = { close() {} };
      this._log(rec, `could not prepare connections: ${errorMessage(err)}`);
    }
    try {
      await this._execute(rec, state);
      this._finish(rec, "succeeded", null);
      this.failures.delete(`${op.targetId}#${op.modelKey}`);
    } catch (err) {
      if (err instanceof Cancelled) {
        this._skipPending(rec);
        this._finish(rec, "cancelled", null);
      } else {
        const message = errorMessage(err);
        // Only a model the operation actually acted on can turn "failed"; a precheck, an
        // unreachable target or an error before any dispatch leaves every model as it was.
        const failedKey = err?.modelKey ?? op.modelKey;
        if (rec.effects.has(failedKey)) this._recordFailure(op.targetId, failedKey, message);
        if (op.action === "switch" && rec.rollback && state.stopped.length && !rec.cancelRequested) {
          await this._rollback(rec, state);
        } else if (op.action === "switch" && state.stopped.length) {
          this._log(rec, "rollback is off: the previous model stays stopped");
        }
        this._skipPending(rec);
        this._finish(rec, "failed", message);
      }
    } finally {
      try {
        rec.scope?.close();
      } catch {
        /* ignore */
      }
    }
    // After a failure or cancel, refresh anyway so the page shows what is true now.
    if (!rec.refreshed) {
      try {
        await this.host.refresh(op.targetId);
      } catch {
        /* the next inventory read retries */
      }
    }
  }

  _skipPending(rec) {
    for (const s of rec.op.steps) if (s.status === "pending") s.status = "skipped";
  }

  _finish(rec, status, error) {
    const { op } = rec;
    if (op.status !== "running") return;
    op.status = status;
    op.error = error;
    op.finishedAt = this.now();
    rec.phase = null;
    for (const l of rec.lockIds) if (this.locks.get(l) === op.id) this.locks.delete(l);
    if (status === "succeeded") {
      this._log(rec, `operation succeeded`);
      this._event(rec, "succeeded", "success", `${capitalize(op.action)} ${op.modelKey} on ${rec.target.name} succeeded`);
    } else if (status === "cancelled") {
      this._log(rec, `operation cancelled`);
      this._event(rec, "cancelled", "warn", `${capitalize(op.action)} ${op.modelKey} on ${rec.target.name} was cancelled (waiting stopped)`);
    } else {
      this._log(rec, `operation failed: ${error}`);
      this._event(rec, "failed", "error", `${capitalize(op.action)} ${op.modelKey} on ${rec.target.name} failed: ${error}`);
    }
    this._prune();
  }

  _recordFailure(targetId, modelKey, error) {
    const key = `${targetId}#${modelKey}`;
    this.failures.delete(key);
    this.failures.set(key, { at: this.now(), error });
    while (this.failures.size > MAX_FAILURES) this.failures.delete(this.failures.keys().next().value);
  }

  _prune() {
    const finished = [...this.records.values()].filter((r) => r.op.status !== "running");
    const excess = finished.length - this.maxRecords;
    if (excess <= 0) return;
    finished.sort((a, b) => (a.op.finishedAt ?? 0) - (b.op.finishedAt ?? 0));
    for (const r of finished.slice(0, excess)) this.records.delete(r.op.id);
  }

  async _collect(rec) {
    return this._race(rec, this.host.collect(rec.op.targetId, rec.scope));
  }

  async _execute(rec, state) {
    const { op, target } = rec;
    const timeout = target.kind === "cluster" ? this.readinessTimeoutMs.cluster : this.readinessTimeoutMs.node;

    // 1. Reachable, from a fresh inventory (never the cached one).
    await this._runStep(rec, "reachable", async () => {
      const inv = await this._collect(rec);
      state.inv = inv;
      if (inv?.reachable !== true) {
        const why = inv?.reachable === false ? "is not reachable" : "could not be confirmed reachable";
        const errs = (inv?.errors ?? []).slice(0, 3).join("; ");
        throw new OperationError("unreachable", `${target.name} ${why}${errs ? `: ${errs}` : ""}`);
      }
      return `${target.name} answered (${inv.runtimes.length} runtime${inv.runtimes.length === 1 ? "" : "s"})`;
    });

    // 2. The model is on the target and its adapter supports the action.
    await this._runStep(rec, "available", async () => {
      const inv = state.inv;
      const model = inv.models.find((m) => m.modelKey === op.modelKey);
      if (!model) throw new OperationError("unknown_model", `model ${op.modelKey} is not on ${target.name}`);
      state.model = model;
      const flag = { start: "start", stop: "stop", reload: "reload", switch: "switchTo" }[op.action];
      if (!model.actions?.[flag]) throw new OperationError("unavailable", reasonNotAllowed(op.action, model));
      const mech = mechanismOf(model, inv);
      const needStart = op.action !== "stop";
      const needStop = op.action === "stop" || op.action === "reload";
      if (!mech || (needStart && !canStart(mech)) || (needStop && !canStop(mech))) {
        throw new OperationError("unsupported", `${op.action} is not supported for ${model.label} on this runtime`);
      }
      if (mech.kind === "multi" && !isValidModelId(model.modelId)) {
        throw new OperationError("validation", `model id ${JSON.stringify(model.modelId)} is not a valid model id`);
      }
      state.mech = mech;
      // A port-less launch profile can not be verified as serving: refuse anything that would
      // stop a model first and then depend on that unverifiable readiness.
      if ((op.action === "switch" || op.action === "reload") && mech.kind === "launcher" && model.port == null) {
        throw new OperationError("no_port", NO_PORT_SWITCH_ERROR);
      }
      if (op.action === "switch") {
        const current = currentModelsFor(inv, model, mech.kind);
        for (const c of current) {
          const cm = mechanismOf(c, inv);
          if (!c.actions?.stop || !canStop(cm)) {
            throw new OperationError(
              "unsupported",
              `${c.label} is ${c.state} on the same runtime and cannot be stopped from the dashboard`
            );
          }
          if (cm.kind === "multi" && !isValidModelId(c.modelId)) {
            throw new OperationError("validation", `model id ${JSON.stringify(c.modelId)} is not a valid model id`);
          }
        }
        state.current = current;
        op.fromModelKeys = current.map((c) => c.modelKey);
        op.fromModelKey = op.fromModelKeys[0] ?? null;
        const from = current.length
          ? `; will stop on the same runtime: ${current.map((c) => `${c.label} (${c.state})`).join(", ")}`
          : "; nothing else is running on this runtime";
        return `${model.label} is ${model.state} (${MECH_LABEL[mech.kind]})${from}`;
      }
      return `${model.label} is ${model.state} (${MECH_LABEL[mech.kind]})`;
    });

    // 3. Capacity: estimate vs total memory; unknown stays unknown.
    if (this._step(rec, "capacity")) {
      await this._runStep(rec, "capacity", async () => {
        const est = state.model.estMemoryBytes;
        const cap = target.memoryTotalBytes;
        if (est == null || cap == null) {
          return `unknown (estimate ${est == null ? "unknown" : fmtGb(est)}, capacity ${cap == null ? "unknown" : fmtGb(cap)})`;
        }
        if (est > cap) {
          if (!rec.force) {
            throw new OperationError(
              "needs_force",
              `estimated ${fmtGb(est)} exceeds the target's ${fmtGb(cap)}; confirm with force to continue`
            );
          }
          return `estimated ${fmtGb(est)} exceeds ${fmtGb(cap)}; continuing because force is set`;
        }
        return `estimated ${fmtGb(est)} of ${fmtGb(cap)}`;
      });
    }

    // 4. No other operation (the lock), and no in-flight requests on what will be stopped.
    await this._runStep(rec, "guard", async () => {
      const affected = op.action === "switch" ? state.current : op.action === "start" ? [] : [state.model];
      const ports = [...new Set(affected.map((m) => m.port).filter((p) => p != null))];
      let total = 0;
      let unknown = false;
      for (const p of ports) {
        const rt = state.inv.runtimes.find((r) => r.port === p && typeof r.requestsRunning === "number");
        if (!rt) unknown = true;
        else total += rt.requestsRunning;
      }
      const parts = ["no other operation on this target"];
      if (total > 0) {
        if (!rec.force) {
          throw new OperationError(
            "in_flight_requests",
            `${total} request${total === 1 ? " is" : "s are"} in flight on port ${ports.join(", ")}; confirm with force to interrupt`
          );
        }
        parts.push(`${total} in-flight request(s) will be interrupted (force)`);
      } else if (affected.length && (unknown || ports.length === 0)) {
        parts.push("in-flight requests unknown — not checked");
      } else if (affected.length) {
        parts.push("no in-flight requests");
      }
      return parts.join("; ");
    });

    // 5. Stop / unload what holds the runtime.
    if (op.action === "switch") {
      await this._runStep(rec, "stop-current", async () => {
        if (!state.current.length) return { skip: "nothing else is running on this runtime" };
        for (const m of state.current) {
          await this._stopModel(rec, m, state.inv);
          state.stopped.push(m);
        }
        return `stopped ${state.current.map((m) => m.label).join(", ")}`;
      });
    } else if (op.action === "stop" || op.action === "reload") {
      await this._runStep(rec, "stop", async () => {
        await this._stopModel(rec, state.model, state.inv);
        return `${state.model.label} stopped`;
      });
      if (op.action === "stop") {
        await this._refreshStep(rec, state.model);
        return;
      }
    }

    // 6. Start / load the requested model.
    await this._runStep(rec, "start", async () => {
      state.startAttempted = true;
      const detail = await this._startModel(rec, state.model, state.inv);
      return detail;
    });

    // 7. Readiness.
    await this._runStep(rec, "ready", async () => this._cancellableWait(rec, () => this._waitReady(rec, state.model, timeout)));

    await this._refreshStep(rec, state.model);
  }

  /** Step 9: refresh the cached inventory so the page shows the result. */
  async _refreshStep(rec, model) {
    // The waiting is over: the refreshed (cached) inventory must show real states, not our phase.
    rec.phase = null;
    await this._runStep(rec, "refresh", async () => {
      const inv = await this._race(rec, this.host.refresh(rec.op.targetId));
      const m = inv?.models?.find((x) => x.modelKey === model.modelKey);
      return m ? `${model.label} is ${m.state}` : `${model.label} is not listed`;
    });
    rec.refreshed = true;
  }

  /** Remember that a stop / start request for this model actually went out. */
  _dispatched(rec, modelKey, kind) {
    let set = rec.effects.get(modelKey);
    if (!set) rec.effects.set(modelKey, (set = new Set()));
    set.add(kind);
  }

  /** Run a readiness wait during which cancel is honoured. */
  async _cancellableWait(rec, fn) {
    rec.cancellable = true;
    try {
      return await fn();
    } finally {
      rec.cancellable = false;
    }
  }

  /** Stop / unload one model and wait until it no longer holds the runtime. */
  async _stopModel(rec, model, inv) {
    const mech = mechanismOf(model, inv);
    if (!canStop(mech)) throw new OperationError("unsupported", `${model.label} cannot be stopped from the dashboard`, { modelKey: model.modelKey });
    this._setPhase(rec, "stop", [model.modelKey]);
    try {
      const ctx = await this._race(rec, this.host.contextFor(rec.op.targetId, model, rec.scope, inv));
      if (mech.kind === "multi") ctx.catalog = catalogOf(inv, model);
      this._log(rec, `${mech.kind === "multi" ? "unloading" : "stopping"} ${model.label}`);
      this._dispatched(rec, model.modelKey, "stop");
      const res =
        mech.kind === "multi"
          ? await this._race(rec, mech.adapter.unload(ctx, model.modelId))
          : await this._race(rec, mech.adapter.stop(ctx, model));
      if (!res?.ok) throw new OperationError("action_failed", `could not stop ${model.label}: ${res?.error ?? "no answer"}`, { modelKey: model.modelKey });
      if (res.detail) this._log(rec, res.detail);
      if (mech.kind === "launcher" && res.job?.id) {
        const job = await this._waitJobExit(rec, rec.target.unitId, res.job.id, this.stopTimeoutMs, model.modelKey);
        if (job?.status === "failed") {
          throw new OperationError("action_failed", `stop script for ${model.label} failed${job.error ? `: ${job.error}` : job.exitCode != null ? ` (exit ${job.exitCode})` : ""}`, { modelKey: model.modelKey });
        }
      }
      await this._waitStopped(rec, model, this.stopTimeoutMs);
    } finally {
      this._setPhase(rec, null);
    }
  }

  /** Start / load one model. Returns a detail string. */
  async _startModel(rec, model, inv) {
    const mech = mechanismOf(model, inv);
    if (!canStart(mech)) throw new OperationError("unsupported", `${model.label} cannot be started from the dashboard`);
    this._setPhase(rec, "start", [model.modelKey]);
    const ctx = await this._race(rec, this.host.contextFor(rec.op.targetId, model, rec.scope, inv));
    if (mech.kind === "multi") ctx.catalog = catalogOf(inv, model);
    this._log(rec, `${mech.kind === "multi" ? "loading" : "starting"} ${model.label}`);
    this._dispatched(rec, model.modelKey, "start");
    const res =
      mech.kind === "multi"
        ? await this._race(rec, mech.adapter.load(ctx, model.modelId))
        : await this._race(rec, mech.adapter.start(ctx, model));
    if (!res?.ok) throw new OperationError("action_failed", `could not start ${model.label}: ${res?.error ?? "no answer"}`, { modelKey: model.modelKey });
    if (res.detail) this._log(rec, res.detail);
    if (mech.kind === "launcher" && res.job?.id) {
      rec.startJob = { unitId: rec.target.unitId, id: res.job.id };
      rec.jobs.set(res.job.id, 0);
      if (res.job.status === "failed") {
        this._mirrorJob(rec, rec.target.unitId, res.job.id);
        throw new OperationError("action_failed", `start script for ${model.label} failed${res.job.error ? `: ${res.job.error}` : ""}`, { modelKey: model.modelKey });
      }
      return `start script running (job ${res.job.id})`;
    }
    return mech.kind === "multi" ? `load requested` : `start requested`;
  }

  /** Copy new launcher job lines into the operation log. @returns the job summary or null */
  _mirrorJob(rec, unitId, jobId) {
    const read = this.host.launchers?.readJob;
    if (typeof read !== "function") return null;
    let out;
    try {
      out = read(unitId, jobId, rec.jobs.get(jobId) ?? 0);
    } catch {
      return null;
    }
    if (!out) return null;
    for (const l of out.lines ?? []) this._log(rec, `│ ${l.text}`);
    if (Number.isInteger(out.nextSeq)) rec.jobs.set(jobId, out.nextSeq);
    return out.job ?? null;
  }

  async _waitJobExit(rec, unitId, jobId, timeoutMs, modelKey = null) {
    rec.jobs.set(jobId, rec.jobs.get(jobId) ?? 0);
    const deadline = this.now() + timeoutMs;
    for (;;) {
      const job = this._mirrorJob(rec, unitId, jobId);
      if (!job) return null; // replaced or unreadable: the inventory decides
      if (job.status !== "running") return job;
      if (this.now() >= deadline) {
        throw new OperationError("timeout", `stop script still running after ${fmtDuration(timeoutMs)}`, { modelKey });
      }
      await this._sleep(rec, this.pollMs.job);
    }
  }

  /** Poll fresh inventories until the model no longer holds the runtime. */
  async _waitStopped(rec, model, timeoutMs) {
    const deadline = this.now() + timeoutMs;
    let delay = this.pollMs.initial;
    let last = null;
    for (;;) {
      const inv = await this._collect(rec);
      const m = inv?.models?.find((x) => x.modelKey === model.modelKey);
      if (inv?.reachable === true) {
        if (!m || !ACTIVE_STATES.has(m.state)) {
          if (m?.state === "failed") {
            throw new OperationError("action_failed", `stopping ${model.label} failed${m.lastError ? `: ${m.lastError}` : ""}`, { modelKey: model.modelKey });
          }
          this._log(rec, `${model.label} is ${m ? m.state : "no longer listed"}`);
          return;
        }
      }
      const now = m?.state ?? (inv?.reachable === false ? "unreachable" : "unknown");
      if (now !== last) this._log(rec, `waiting for ${model.label} to stop (now ${now})`);
      last = now;
      if (this.now() >= deadline) {
        throw new OperationError("timeout", `${model.label} still ${now} after ${fmtDuration(timeoutMs)}`, { modelKey: model.modelKey });
      }
      await this._sleep(rec, delay);
      delay = Math.min(this.pollMs.max, Math.round(delay * this.pollMs.factor));
    }
  }

  /** Poll fresh inventories (with backoff) until the model is serving. Returns a detail string. */
  async _waitReady(rec, model, timeoutMs) {
    if (model.launcherId && model.port == null) return this._settlePortless(rec, model);
    const started = this.now();
    const deadline = started + timeoutMs;
    let delay = this.pollMs.initial;
    let last = null;
    for (;;) {
      if (rec.startJob) {
        const job = this._mirrorJob(rec, rec.startJob.unitId, rec.startJob.id);
        if (job?.status === "failed") {
          throw new OperationError("action_failed", `start script for ${model.label} failed${job.error ? `: ${job.error}` : job.exitCode != null ? ` (exit ${job.exitCode})` : ""}`, { modelKey: model.modelKey });
        }
      }
      const inv = await this._collect(rec);
      const m = inv?.models?.find((x) => x.modelKey === model.modelKey);
      if (m?.state === "serving") return `${model.label} is serving after ${fmtDuration(this.now() - started)}`;
      if (m?.state === "failed") {
        throw new OperationError("action_failed", `${model.label} failed to start${m.lastError ? `: ${m.lastError}` : ""}`, { modelKey: model.modelKey });
      }
      const now = m?.state ?? (inv?.reachable === false ? "unreachable" : "not listed");
      if (now !== last) this._log(rec, `waiting for ${model.label} to serve (now ${now})`);
      last = now;
      if (this.now() >= deadline) {
        throw new OperationError("timeout", `${model.label} was not ready after ${fmtDuration(timeoutMs)} (last state: ${now})`, { modelKey: model.modelKey });
      }
      await this._sleep(rec, Math.min(delay, Math.max(0, deadline - this.now())));
      delay = Math.min(this.pollMs.max, Math.round(delay * this.pollMs.factor));
    }
  }

  /**
   * A launch profile without a port: watch its start job for the settle window (a script that
   * fails or exits non-zero fails the step), then require a fresh launcher status of running.
   * The model is never reported serving: there is no endpoint to verify.
   */
  async _settlePortless(rec, model) {
    const deadline = this.now() + this.startSettleMs;
    this._log(rec, `${model.label} has no port: watching its start script for ${fmtDuration(this.startSettleMs)}`);
    for (;;) {
      if (rec.startJob) {
        const job = this._mirrorJob(rec, rec.startJob.unitId, rec.startJob.id);
        const exitedBad = job && job.status !== "running" && job.exitCode != null && job.exitCode !== 0;
        if (job?.status === "failed" || exitedBad) {
          throw new OperationError(
            "action_failed",
            `start script for ${model.label} failed${job.error ? `: ${job.error}` : job.exitCode != null ? ` (exit ${job.exitCode})` : ""}`,
            { modelKey: model.modelKey }
          );
        }
      }
      if (this.now() >= deadline) break;
      await this._sleep(rec, Math.min(this.pollMs.job, Math.max(0, deadline - this.now())));
    }
    const inv = await this._collect(rec);
    const m = inv?.models?.find((x) => x.modelKey === model.modelKey);
    // Without a port the profile row is "starting" exactly when its process is running.
    if (m?.state !== "starting") {
      throw new OperationError(
        "action_failed",
        `${model.label}: the start script's process is not running (${m ? m.state : "not listed"})`,
        { modelKey: model.modelKey }
      );
    }
    return "process running; serving not verified (no port)";
  }

  /** Plan §3.3 step 8: restore the previous model(s), logged as their own steps. */
  async _rollback(rec, state) {
    const { target } = rec;
    const timeout = target.kind === "cluster" ? this.readinessTimeoutMs.cluster : this.readinessTimeoutMs.node;
    this._log(rec, `rolling back to ${state.stopped.map((m) => m.label).join(", ")}`);
    rec.startJob = null;
    try {
      if (state.startAttempted) {
        await this._runStep(rec, "rollback-stop", async () => {
          const inv = await this._collect(rec);
          const m = inv?.models?.find((x) => x.modelKey === state.model.modelKey);
          if (!m || !ACTIVE_STATES.has(m.state)) {
            if (m?.state !== "failed" || !m.actions?.stop) return { skip: `${state.model.label} is ${m ? m.state : "not listed"}` };
          }
          await this._stopModel(rec, m, inv);
          return `${state.model.label} stopped`;
        });
      }
      await this._runStep(rec, "rollback-start", async () => {
        for (const prev of state.stopped) await this._startModel(rec, prev, state.inv);
        return `restarting ${state.stopped.map((m) => m.label).join(", ")}`;
      });
      await this._runStep(rec, "rollback-ready", async () => this._cancellableWait(rec, async () => {
        const details = [];
        for (const prev of state.stopped) {
          const d = await this._waitReady(rec, prev, timeout);
          details.push(typeof d === "string" ? d : `${prev.label}: ${d.skip}`);
        }
        return details.join("; ");
      }));
      this._log(rec, "rollback succeeded: the previous model is back");
    } catch (err) {
      if (err instanceof Cancelled) {
        this._log(rec, "rollback cancelled: no longer waiting");
        return;
      }
      const message = errorMessage(err);
      this._log(rec, `rollback failed: ${message}`);
      for (const prev of state.stopped) this._recordFailure(rec.op.targetId, prev.modelKey, `rollback failed: ${message}`);
    }
  }
}

function catalogOf(inv, model) {
  return (inv?.models ?? []).filter((m) => m.engine === model.engine && m.port === model.port).map((m) => m.modelId);
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** @returns {FleetOperation} a copy safe to hand out */
function snapshotOp(op) {
  return { ...op, fromModelKeys: [...op.fromModelKeys], steps: op.steps.map((s) => ({ ...s })) };
}
