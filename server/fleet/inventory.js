import { llmProbeHost } from "../collectors/llmHost.js";
import { deriveModelState, makeModelKey } from "./modelStates.js";
import { clusterTargetId, isClusterEndpoint, servedModelIds } from "./targets.js";
import { getAdapter } from "./adapters/index.js";
import {
  NO_CAPABILITIES,
  baseUrlFor,
  canStartModels,
  canStopModels,
  capabilitiesFor,
  errorMessage,
  makeCapabilities,
  mergeCapabilities,
} from "./adapters/base.js";
import { LAUNCHER_SLOT } from "./adapters/launchProfile.js";
import { MAC_PROFILE_SLOT } from "./adapters/macProfile.js";

/**
 * Per-target model inventory (plan §3.1, §3.2, §4 FleetInventory).
 *
 * Evidence comes from: the SparkMonitor snapshot (which engine answers on which port), the
 * engine adapter for that port, launch profiles and mac profiles (configured models), and the
 * operation runner (in-flight / failed operations). Duplicates merge by modelKey with their
 * `sources` unioned, and every state comes from deriveModelState. A failed source is reported
 * verbatim in `errors` and its models become unknown / unreachable — never guessed.
 *
 * Every network or exec call goes through `deps`, so tests are hermetic.
 *
 * @typedef {import("./modelStates.js").ModelState} ModelState
 * @typedef {import("./adapters/base.js").AdapterCapabilities} AdapterCapabilities
 * @typedef {import("./clusterStore.js").FleetCluster} FleetCluster
 *
 * @typedef {object} FleetRuntime
 * @property {string} engine
 * @property {number|null} port
 * @property {string|null} endpoint
 * @property {boolean|null} reachable
 * @property {AdapterCapabilities} capabilities
 * @property {string|null} error
 * @property {number|null} [requestsRunning]  from the monitor snapshot (extra field)
 * @property {string|null} [note]            why a capability is off (extra field)
 *
 * @typedef {object} FleetModel
 * @property {string} modelKey
 * @property {string} modelId
 * @property {string} label
 * @property {string} engine
 * @property {number|null} port
 * @property {ModelState} state
 * @property {string[]} sources
 * @property {string|null} quantization
 * @property {number|null} contextLength
 * @property {number|null} sizeBytes
 * @property {number|null} estMemoryBytes
 * @property {string|null} launcherId
 * @property {string|null} macRuntime
 * @property {string|null} [endpoint]  runtime base URL the model is served from (extra field; dedupe key)
 * @property {string|null} servedBy
 * @property {{ start: boolean, stop: boolean, reload: boolean, switchTo: boolean }} actions
 * @property {string|null} lastError
 * @property {{ state: ModelState, at: number|null }} [lastSeen]  last known state of an unreachable target's model
 *
 * @typedef {object} FleetInventory
 * @property {string} targetId
 * @property {number} collectedAt
 * @property {boolean|null} reachable
 * @property {FleetRuntime[]} runtimes
 * @property {FleetModel[]} models
 * @property {FleetModel[]} clusterModels
 * @property {string[]} errors
 * @property {boolean} stale
 *
 * @typedef {object} InventoryDeps
 * @property {object[]} units                       registry public units
 * @property {(id: string) => object|null} [getSpark]  full unit config (secrets), defaults to the public unit
 * @property {Map<string, object>} [snapshots]      unitId → SparkMonitor snapshot
 * @property {FleetCluster[]} [clusters]
 * @property {typeof fetch} [fetchImpl]
 * @property {number} [timeoutMs]                   per discovery request (default 4000)
 * @property {number} [actionTimeoutMs]             load / unload / CLI (default 300000)
 * @property {((unit: object, cmd: string, timeoutMs: number) => Promise<string>)|null} [exec]
 *   fixed-template exec on a unit; undefined → LauncherManager.defaultExec (SSH / local), null → none
 * @property {(unit: object, port: number) => string|Promise<string>} [resolveBaseUrl]
 * @property {(unit: object, port: number) => string|null} [apiKeyFor]
 * @property {object|null} [launchers]              see adapters/launchProfile.js
 * @property {object|null} [mac]                    { readRuntimeControl, beginRuntimeControl }; undefined → MacRuntimeControl
 * @property {{ inFlight?: (targetId: string, modelKey: string) => ("start"|"stop"|null),
 *   lastFailure?: (targetId: string, modelKey: string) => ({ at: number, error: string }|null) }} [operations]
 * @property {Set<string>} [servedKeys]             "<targetId>#<modelKey>" seen serving this session
 * @property {TargetBackoff|null} [backoff]
 * @property {boolean} [force]                      ignore backoff (explicit refresh)
 * @property {FleetInventory|null} [previous]       last inventory of this target (lastSeen)
 * @property {(targetId: string) => FleetInventory|null} [getCachedInventory]
 * @property {() => number} [now]
 */

const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_ACTION_TIMEOUT_MS = 300000;
const DEFAULT_CLUSTER_CACHE_MAX_AGE_MS = 60000;
/** Process-wide memory of models seen serving (rule 7: stopped vs configured). */
const sessionServed = new Set();

const STATE_ORDER = ["serving", "loaded", "starting", "stopping", "failed", "configured", "stopped", "installed", "unknown", "unreachable"];

/**
 * Per-target exponential backoff for unreachable targets (2 s → 60 s).
 */
export class TargetBackoff {
  constructor({ minMs = 2000, maxMs = 60000, now = Date.now } = {}) {
    this.minMs = minMs;
    this.maxMs = maxMs;
    this.now = now;
    /** @type {Map<string, { failures: number, nextAt: number }>} */
    this.state = new Map();
  }

  canAttempt(targetId) {
    const s = this.state.get(targetId);
    return !s || this.now() >= s.nextAt;
  }

  /** @returns {number} ms until the next attempt */
  retryInMs(targetId) {
    const s = this.state.get(targetId);
    return s ? Math.max(0, s.nextAt - this.now()) : 0;
  }

  /** @returns {number} the delay applied */
  recordFailure(targetId) {
    const s = this.state.get(targetId) ?? { failures: 0, nextAt: 0 };
    const delay = Math.min(this.maxMs, this.minMs * 2 ** Math.min(s.failures, 20));
    this.state.set(targetId, { failures: s.failures + 1, nextAt: this.now() + delay });
    return delay;
  }

  recordSuccess(targetId) {
    this.state.delete(targetId);
  }
}

/**
 * The adapter context for one unit / port, built the same way for discovery and operations.
 * @param {{ unit: object, port?: number|null, baseUrl?: string|null, deps?: InventoryDeps }} args
 * @returns {Promise<import("./adapters/base.js").AdapterContext & { launchers?: object, mac?: object }>}
 */
export async function buildAdapterContext({ unit, port = null, baseUrl = null, deps = {} }) {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const actionTimeoutMs = deps.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  let url = baseUrl;
  if (!url && port != null) {
    url = deps.resolveBaseUrl ? await deps.resolveBaseUrl(unit, port) : baseUrlFor(llmProbeHost(unit), port);
  }
  const apiKeyFor = deps.apiKeyFor ?? ((u, p) => u?.llmApiKeys?.[p] ?? u?.llmApiKeys?.[String(p)] ?? null);
  return {
    unit,
    port,
    baseUrl: url ?? undefined,
    fetchImpl: deps.fetchImpl ?? globalThis.fetch,
    timeoutMs,
    actionTimeoutMs,
    apiKey: port != null ? apiKeyFor(unit, port) ?? null : null,
    exec: unitExec(unit, deps, actionTimeoutMs),
    launchers: deps.launchers ?? undefined,
    mac: macFns(unit, deps),
  };
}

function unitExec(unit, deps, timeoutMs) {
  if (!unit || unit.platform === "windows") return null;
  if (deps.exec === null) return null;
  if (typeof deps.exec === "function") return (cmd) => deps.exec(unit, cmd, timeoutMs);
  return async (cmd) => {
    const { defaultExec } = await import("../llmlaunch/LauncherManager.js");
    return defaultExec(unit, cmd, timeoutMs);
  };
}

function macFns(unit, deps) {
  if (unit?.kind !== "mac") return undefined;
  if (deps.mac === null) return undefined;
  if (deps.mac) return deps.mac;
  return {
    readRuntimeControl: async (u) => (await import("../collectors/MacRuntimeControl.js")).readRuntimeControl(u),
    beginRuntimeControl: async (u, action, request) =>
      (await import("../collectors/MacRuntimeControl.js")).beginRuntimeControl(u, action, request),
  };
}

// ─── model table ─────────────────────────────────────────────────────────────

function newRecord({ key, modelId, label, engine, port = null, caps = NO_CAPABILITIES, profile = false }) {
  return {
    key,
    modelId,
    label: label || modelId,
    engine,
    port,
    profile,
    sources: new Set(),
    quantization: null,
    contextLength: null,
    sizeBytes: null,
    estMemoryBytes: null,
    launcherId: null,
    macRuntime: null,
    endpoint: null,
    caps,
    lastError: null,
    lastSeen: undefined,
    ev: {},
  };
}

const firstNonNull = (a, b) => (a != null ? a : b != null ? b : null);
const triBool = (a, b) => (a === true || b === true ? true : a === false || b === false ? false : null);

function mergeEvidence(into, ev) {
  for (const k of ["listed", "loaded", "installed", "hasProfile", "discoveryFailed", "lastOperationFailed"]) {
    if (ev[k] === true) into[k] = true;
    else if (ev[k] === false && into[k] == null) into[k] = false;
  }
  if (ev.reachable === false) into.reachable = false;
  else if (ev.reachable === true && into.reachable == null) into.reachable = true;
  into.ready = triBool(into.ready, ev.ready);
  if (ev.processRunning != null && into.processRunning == null) into.processRunning = ev.processRunning;
  if (ev.operation && !into.operation) into.operation = ev.operation;
  if (ev.lastFailureAt != null) into.lastFailureAt = ev.lastFailureAt;
}

function fillFields(rec, m) {
  rec.quantization = firstNonNull(rec.quantization, m.quantization);
  rec.contextLength = firstNonNull(rec.contextLength, m.contextLength);
  rec.sizeBytes = firstNonNull(rec.sizeBytes, m.sizeBytes);
  rec.estMemoryBytes = firstNonNull(rec.estMemoryBytes, m.estMemoryBytes);
  rec.launcherId = firstNonNull(rec.launcherId, m.launcherId);
  rec.macRuntime = firstNonNull(rec.macRuntime, m.macRuntime);
  rec.endpoint = firstNonNull(rec.endpoint, m.endpoint);
  rec.lastError = firstNonNull(rec.lastError, m.lastError);
  for (const s of m.sources ?? []) rec.sources.add(s);
}

class ModelTable {
  constructor() {
    /** @type {Map<string, ReturnType<typeof newRecord>>} */
    this.map = new Map();
  }

  upsert(spec, fields, ev) {
    let rec = this.map.get(spec.key);
    if (!rec) {
      rec = newRecord(spec);
      this.map.set(spec.key, rec);
    } else {
      rec.caps = mergeCapabilities(rec.caps, spec.caps);
      if (spec.profile) rec.profile = true;
    }
    fillFields(rec, fields);
    mergeEvidence(rec.ev, ev);
    return rec;
  }

  records() {
    return [...this.map.values()];
  }
}

/** Evidence fields of a DiscoveredModel. */
function evidenceOf(m, result, extra = {}) {
  return {
    listed: m.listed === true,
    loaded: m.loaded === true,
    installed: m.installed === true,
    ready: m.ready != null ? m.ready : result?.ready ?? null,
    hasProfile: m.hasProfile === true,
    processRunning: m.processRunning ?? null,
    operation: m.operation ?? null,
    lastOperationFailed: m.lastOperationFailed === true,
    lastFailureAt: m.lastFailureAt ?? null,
    ...extra,
  };
}

/**
 * Discover one runtime (an engine on a port).
 * @returns {Promise<{ runtime: FleetRuntime, result: import("./adapters/base.js").DiscoveryResult|null, caps: AdapterCapabilities }>}
 */
async function discoverRuntime({ unit, engine, port, baseUrl, deps, entry }) {
  const adapter = getAdapter(engine);
  const runtime = {
    engine: engine || "unknown",
    port,
    endpoint: null,
    reachable: null,
    capabilities: NO_CAPABILITIES,
    error: null,
    requestsRunning: typeof entry?.requestsRunning === "number" ? entry.requestsRunning : null,
    note: null,
  };
  let ctx;
  try {
    ctx = await buildAdapterContext({ unit, port, baseUrl, deps });
    runtime.endpoint = ctx.baseUrl ?? null;
  } catch (err) {
    runtime.reachable = null;
    runtime.error = errorMessage(err);
    return { runtime, result: { reachable: null, ready: null, models: [], errors: [runtime.error] }, caps: NO_CAPABILITIES };
  }
  if (!adapter) {
    // An engine with no adapter: the monitor's own probe is the only evidence; no control.
    runtime.capabilities = makeCapabilities({ discover: true });
    runtime.reachable = entry ? entry.available === true : null;
    const ids = servedModelIds(entry);
    return {
      runtime,
      result: {
        reachable: runtime.reachable,
        ready: entry?.available === true,
        models: ids.map((id) => ({
          modelId: id,
          listed: true,
          loaded: true,
          contextLength: id === entry?.modelId ? entry?.contextLength ?? null : null,
          sources: ["api"],
        })),
        errors: [],
      },
      caps: runtime.capabilities,
    };
  }
  const caps = capabilitiesFor(adapter, ctx);
  runtime.capabilities = caps;
  if (typeof adapter.unsupportedReason === "function") runtime.note = adapter.unsupportedReason(ctx) ?? null;
  let result;
  try {
    result = await adapter.discover(ctx);
  } catch (err) {
    result = { reachable: false, ready: null, models: [], errors: [errorMessage(err)] };
  }
  if (!result || typeof result !== "object") result = { reachable: false, ready: null, models: [], errors: ["adapter returned nothing"] };
  result.models = Array.isArray(result.models) ? result.models : [];
  result.errors = Array.isArray(result.errors) ? result.errors.map(String) : [];
  runtime.reachable = result.reachable ?? null;
  runtime.error = result.errors.length ? result.errors.join("; ") : null;
  // The monitor's context length fills a gap for the model it reports.
  if (entry?.modelId && entry.contextLength) {
    for (const m of result.models) if (m.modelId === entry.modelId && m.contextLength == null) m.contextLength = entry.contextLength;
  }
  return { runtime, result, caps };
}

/** Add a runtime's discovered models to the table. */
function addRuntimeModels(table, { engine, port, result, caps, entry, endpoint = null }) {
  const failed = result.errors.length > 0;
  const unreachable = result.reachable === false;
  const known = new Set();
  for (const m of result.models) {
    if (!m || typeof m.modelId !== "string" || !m.modelId) continue;
    let key;
    try {
      key = makeModelKey(engine, port, m.modelId);
    } catch {
      continue;
    }
    known.add(m.modelId);
    // A multi-model engine whose loaded list could not be read: "installed" would be a guess.
    const loadedUnknown = result.loadedKnown === false && m.loaded !== true;
    const ev = evidenceOf(m, result, {
      discoveryFailed: failed,
      ...(loadedUnknown ? { installed: false } : {}),
    });
    table.upsert({ key, modelId: m.modelId, label: m.label, engine, port, caps }, { ...m, endpoint }, ev);
  }
  // Models the monitor saw on this port that the adapter could not confirm: never "serving".
  // Not for multi-model engines, whose /v1/models is the installed catalog, not what is served.
  if ((unreachable || failed) && !caps.multiModel) {
    for (const id of servedModelIds(entry ? { ...entry, available: true } : null)) {
      if (known.has(id)) continue;
      let key;
      try {
        key = makeModelKey(engine, port, id);
      } catch {
        continue;
      }
      table.upsert(
        { key, modelId: id, label: id, engine, port, caps },
        { sources: ["api"], lastError: result.errors[0] ?? null, endpoint },
        { reachable: unreachable ? false : null, discoveryFailed: true }
      );
    }
  }
}

/** Add profile (launcher / mac) models to the table. */
function addProfileModels(table, { kind, result, caps, unitPortFallback = null }) {
  for (const m of result.models) {
    if (!m || typeof m.modelId !== "string" || !m.modelId) continue;
    const engine = kind === "launcher" ? "launch-profile" : "mac-profile";
    let key;
    try {
      key = kind === "launcher" ? launcherModelKey(m.launcherId) : makeModelKey(engine, MAC_PROFILE_SLOT(m.macRuntime), m.modelId);
    } catch {
      continue;
    }
    let modelCaps = caps;
    if (kind === "mac") modelCaps = makeCapabilities({ ...caps, start: caps.start && m.startable !== false, stop: caps.stop && m.stoppable !== false });
    const rec = table.upsert(
      { key, modelId: m.modelId, label: m.label, engine, port: m.port ?? unitPortFallback, caps: modelCaps, profile: true },
      m,
      evidenceOf(m, result, { discoveryFailed: result.errors.length > 0 && m.processRunning == null })
    );
    if (rec.port == null) rec.port = m.port ?? unitPortFallback;
  }
}

/**
 * Model key of a launch profile: keyed on the launcher id only, so it survives a rename and
 * start / stop ("launch-profile|launcher:<id>|<id>").
 * @param {string} launcherId
 */
export function launcherModelKey(launcherId) {
  return makeModelKey("launch-profile", LAUNCHER_SLOT(launcherId), launcherId);
}

/**
 * A profile's process serves on its port: fold the API's model row into the profile row so the
 * model appears once. The profile row keeps its stable key; on absorption:
 *   - `modelId` becomes the id the API reports (launchers; a mac profile must already match),
 *   - `engine` becomes the serving runtime's engine (e.g. "vllm" instead of "launch-profile"),
 *     so control still goes through `launcherId` / `macRuntime`, never through `engine`,
 *   - `sources` are unioned and capabilities merged.
 * Only a profile whose process is known RUNNING can claim the API row, and only when it is the
 * sole running profile on that port; a stopped profile never does, and an ambiguous port (no or
 * several running profiles) leaves the API row on its own.
 */
function absorbApiModels(table) {
  const records = table.records();
  const profiles = records.filter((r) => r.profile && r.port != null);
  const absorbed = new Set();
  for (const p of profiles) {
    if (p.ev.processRunning !== true) continue;
    const running = profiles.filter((o) => o.port === p.port && o.ev.processRunning === true);
    if (running.length !== 1) continue;
    const candidates = records.filter((r) => !r.profile && !absorbed.has(r.key) && r.port === p.port && r.ev.listed === true);
    let pick = null;
    if (p.launcherId) {
      pick = candidates.find((c) => c.modelId === p.modelId) ?? (candidates.length === 1 ? candidates[0] : null);
    } else {
      pick = candidates.find((c) => c.modelId === p.modelId) ?? null;
    }
    if (!pick) continue;
    absorbed.add(pick.key);
    if (p.launcherId) p.modelId = pick.modelId;
    p.engine = pick.engine;
    p.caps = mergeCapabilities(p.caps, pick.caps);
    fillFields(p, { ...pick, sources: [...pick.sources] });
    const ev = { ...pick.ev };
    delete ev.reachable; // a closed port must not hide a stopped / configured profile
    mergeEvidence(p.ev, ev);
    table.map.delete(pick.key);
  }
}

function actionsFor(state, caps, usable) {
  const start = usable && canStartModels(caps);
  const stop = usable && canStopModels(caps);
  const startable = ["installed", "configured", "stopped", "failed"].includes(state);
  return {
    start: start && startable,
    stop: stop && ["serving", "loaded", "starting", "failed"].includes(state),
    reload: start && stop && ["serving", "loaded", "failed"].includes(state),
    switchTo: start && startable,
  };
}

const NO_ACTIONS = Object.freeze({ start: false, stop: false, reload: false, switchTo: false });

function finalizeModels(table, { targetId, deps, usable, now }) {
  const served = deps.servedKeys ?? sessionServed;
  const ops = deps.operations ?? {};
  const out = [];
  for (const r of table.records()) {
    const ev = { ...r.ev, observedAt: now };
    const inFlight = safeCall(() => ops.inFlight?.(targetId, r.key));
    if (inFlight) ev.operation = inFlight;
    const failure = safeCall(() => ops.lastFailure?.(targetId, r.key));
    if (failure) {
      ev.lastOperationFailed = true;
      ev.lastFailureAt = Number.isFinite(failure.at) ? failure.at : null;
      // A failure the runner reports has no newer evidence unless something was observed after it.
      if (!Number.isFinite(failure.at)) ev.observedAt = null;
      r.lastError = failure.error ?? r.lastError;
    }
    ev.servedThisSession = served.has(`${targetId}#${r.key}`);
    const state = deriveModelState(ev);
    if (state === "serving") served.add(`${targetId}#${r.key}`);
    /** @type {FleetModel} */
    const model = {
      modelKey: r.key,
      modelId: r.modelId,
      label: r.label || r.modelId,
      engine: r.engine,
      port: r.port ?? null,
      state,
      sources: [...r.sources],
      quantization: r.quantization ?? null,
      contextLength: r.contextLength ?? null,
      sizeBytes: r.sizeBytes ?? null,
      estMemoryBytes: r.estMemoryBytes ?? null,
      launcherId: r.launcherId ?? null,
      macRuntime: r.macRuntime ?? null,
      endpoint: r.endpoint ?? null,
      servedBy: null,
      actions: actionsFor(state, r.caps, usable),
      lastError: r.lastError ?? null,
    };
    if (r.lastSeen) model.lastSeen = r.lastSeen;
    out.push(model);
  }
  return sortModels(out);
}

function sortModels(models) {
  return models.sort(
    (a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || a.label.localeCompare(b.label)
  );
}

function safeCall(fn) {
  try {
    return fn() ?? null;
  } catch {
    return null;
  }
}

/** Carry the previous inventory's models over as unreachable, keeping their last state as lastSeen. */
function carryPrevious(table, previous, filter = () => true) {
  if (!previous || !Array.isArray(previous.models)) return;
  for (const m of previous.models) {
    if (!m?.modelKey || !filter(m)) continue;
    const rec = table.upsert(
      {
        key: m.modelKey,
        modelId: m.modelId,
        label: m.label,
        engine: m.engine,
        port: m.port ?? null,
        caps: NO_CAPABILITIES,
        profile: Boolean(m.launcherId || m.macRuntime),
      },
      { ...m, sources: m.sources ?? [] },
      { reachable: false }
    );
    const lastState = m.state === "unreachable" ? m.lastSeen?.state : m.state;
    if (lastState && !rec.lastSeen) rec.lastSeen = { state: lastState, at: m.lastSeen?.at ?? previous.collectedAt ?? 0 };
  }
}

function emptyInventory(targetId, now, extra = {}) {
  return { targetId, collectedAt: now, reachable: null, runtimes: [], models: [], clusterModels: [], errors: [], stale: false, ...extra };
}

function unitsById(deps) {
  const list = Array.isArray(deps.units) ? deps.units : [];
  return new Map(list.filter((u) => u && typeof u.id === "string").map((u) => [u.id, u]));
}

function snapOf(deps, id) {
  const s = deps.snapshots;
  return s instanceof Map ? s.get(id) : s?.[id];
}

function fullUnit(deps, unit) {
  const full = safeCall(() => deps.getSpark?.(unit.id));
  return full && typeof full === "object" ? full : unit;
}

// ─── node inventory ──────────────────────────────────────────────────────────

/**
 * Models served on a distributed cluster's endpoint, shown read-only on a member node.
 * Prefers the cluster's cached inventory; falls back to the head's monitor snapshot.
 */
function clusterModelsFor(unit, deps, clusters, now) {
  const out = [];
  for (const c of clusters) {
    if (c.kind !== "distributed" || !c.memberIds.includes(unit.id)) continue;
    const servedBy = clusterTargetId(c.id);
    const cached = safeCall(() => deps.getCachedInventory?.(servedBy));
    if (cached && Array.isArray(cached.models)) {
      const at = Number.isFinite(cached.collectedAt) ? cached.collectedAt : null;
      const maxAge = deps.clusterCacheMaxAgeMs ?? DEFAULT_CLUSTER_CACHE_MAX_AGE_MS;
      // An old or stale cluster reading is not current: its rows become unknown with lastSeen.
      const stale = cached.stale === true || cached.reachable === false || at == null || now - at > maxAge;
      for (const m of cached.models) {
        const row = { ...m, servedBy, actions: { ...NO_ACTIONS }, collectedAt: at, stale };
        if (stale && m.state !== "unknown" && m.state !== "unreachable") {
          row.state = "unknown";
          row.lastSeen = { state: m.state, at };
        }
        out.push(row);
      }
      continue;
    }
    const units = unitsById(deps);
    const head = units.get(c.headId);
    const headSnap = snapOf(deps, c.headId);
    if (!head || headSnap?.online !== true || !Array.isArray(headSnap?.metrics?.llm)) continue;
    const entry = headSnap.metrics.llm.find((e) => isClusterEndpoint(c, head, e?.port));
    if (!entry) continue;
    const engine = c.engine || entry.backend || "unknown";
    // A multi-model engine's /v1/models is its installed catalog: not evidence of serving.
    if (getAdapter(engine)?.capabilities?.multiModel) continue;
    for (const id of servedModelIds(entry)) {
      let key;
      try {
        key = makeModelKey(engine, entry.port, id);
      } catch {
        continue;
      }
      out.push({
        modelKey: key,
        modelId: id,
        label: id,
        engine,
        port: entry.port ?? null,
        state: deriveModelState({ listed: true, ready: entry.available === true }),
        sources: ["api"],
        quantization: null,
        contextLength: id === entry.modelId ? entry.contextLength ?? null : null,
        sizeBytes: null,
        estMemoryBytes: null,
        launcherId: null,
        macRuntime: null,
        endpoint: null,
        servedBy,
        actions: { ...NO_ACTIONS },
        lastError: null,
        collectedAt: now,
        stale: false,
      });
    }
  }
  return out;
}

async function collectNodeInventory(target, deps, now) {
  const targetId = target.targetId ?? `node:${target.id}`;
  const units = unitsById(deps);
  const pub = units.get(target.id);
  if (!pub) return emptyInventory(targetId, now, { errors: [`unit ${target.id} is not in the registry`] });
  const unit = fullUnit(deps, pub);
  const snap = snapOf(deps, pub.id);
  const clusters = Array.isArray(deps.clusters) ? deps.clusters : [];
  const owning = clusters.filter((c) => c.kind === "distributed" && c.memberIds.includes(pub.id));
  const llm = Array.isArray(snap?.metrics?.llm) ? snap.metrics.llm : [];
  const ownEntries = llm.filter((e) => !owning.some((c) => isClusterEndpoint(c, pub, e?.port)));
  const launcherOwnedByCluster = (l) =>
    owning.some(
      (c) =>
        c.headId === pub.id &&
        (c.launcherId === l.id || (l.port != null && isClusterEndpoint(c, pub, l.port)))
    );
  const clusterModels = clusterModelsFor(pub, deps, clusters, now);
  const table = new ModelTable();
  const errors = [];

  const backoff = deps.backoff ?? null;
  const offline = snap?.online === false;
  // The monitor says the unit is up: that is fresher than any backoff window.
  const inBackoff = !offline && snap?.online !== true && backoff && !deps.force && !backoff.canAttempt(targetId);
  if (offline || inBackoff) {
    const reason = offline
      ? `${pub.name || pub.id} is offline${snap?.offlineReason ? `: ${snap.offlineReason}` : ""}`
      : `${pub.name || pub.id} was unreachable; next attempt in ${Math.ceil(backoff.retryInMs(targetId) / 1000)} s`;
    errors.push(reason);
    const runtimes = ownEntries.map((e) => ({
      engine: e?.backend || "unknown",
      port: Number.isInteger(e?.port) ? e.port : null,
      endpoint: null,
      reachable: false,
      capabilities: capabilitiesFor(getAdapter(e?.backend), {}),
      error: reason,
      requestsRunning: null,
      note: null,
    }));
    // Configured launch profiles are local facts; their state is unreachable, not guessed.
    try {
      const list = deps.launchers?.list?.(pub.id) ?? [];
      for (const l of list.filter((x) => !launcherOwnedByCluster(x))) {
        table.upsert(
          {
            key: launcherModelKey(l.id),
            modelId: l.name,
            label: l.name,
            engine: "launch-profile",
            port: Number.isInteger(l.port) ? l.port : null,
            profile: true,
          },
          { launcherId: l.id, sources: ["launcher"] },
          { reachable: false, hasProfile: true }
        );
      }
    } catch {
      /* the store is local; ignore */
    }
    carryPrevious(table, deps.previous);
    if (offline && backoff && !inBackoff) backoff.recordFailure(targetId);
    return {
      targetId,
      collectedAt: now,
      reachable: false,
      runtimes,
      models: finalizeModels(table, { targetId, deps, usable: false, now }),
      clusterModels,
      errors,
      stale: false,
    };
  }

  const runtimes = [];
  let anyFailed = false;
  let anyReached = false;

  // 1. Engines on ports, as the monitor detected them.
  const runtimeJobs = ownEntries
    .filter((e) => Number.isInteger(e?.port))
    .map(async (entry) => {
      if (!entry.backend) {
        // Nothing identified on this port: no engine to ask, nothing to report as a failure.
        runtimes.push({
          engine: "unknown",
          port: entry.port,
          endpoint: null,
          reachable: entry.available === true ? true : false,
          capabilities: NO_CAPABILITIES,
          error: entry.measurementError ?? (entry.available === true ? null : `no engine answered on port ${entry.port}`),
          requestsRunning: null,
          note: null,
        });
        return;
      }
      const { runtime, result, caps } = await discoverRuntime({ unit, engine: entry.backend, port: entry.port, deps, entry });
      runtimes.push(runtime);
      if (result.reachable === true) anyReached = true;
      if (result.reachable === false) anyFailed = true;
      errors.push(...result.errors);
      addRuntimeModels(table, { engine: runtime.engine, port: entry.port, result, caps, entry, endpoint: runtime.endpoint });
    });

  // 2. Launch profiles (configured models).
  const launcherJob = (async () => {
    if (!deps.launchers || typeof deps.launchers.list !== "function") return;
    const adapter = getAdapter("launch-profile");
    if (!adapter) return;
    const ctx = await buildAdapterContext({ unit, deps });
    ctx.launcherFilter = (l) => !launcherOwnedByCluster(l);
    let result;
    try {
      result = await adapter.discover(ctx);
    } catch (err) {
      result = { reachable: null, ready: null, models: [], errors: [errorMessage(err)] };
    }
    if (!result.models.length && !result.errors.length) return;
    const caps = capabilitiesFor(adapter, ctx);
    runtimes.push({
      engine: "launch-profile",
      port: null,
      endpoint: null,
      reachable: result.reachable ?? null,
      capabilities: caps,
      error: result.errors.length ? result.errors.join("; ") : null,
      requestsRunning: null,
      note: unit.platform === "windows" ? "Launch profiles are not supported on Windows units" : null,
    });
    if (result.reachable === true) anyReached = true;
    if (result.reachable === false) anyFailed = true;
    errors.push(...result.errors);
    addProfileModels(table, { kind: "launcher", result, caps });
  })();

  // 3. Mac runtime profiles.
  const macJob = (async () => {
    if (pub.kind !== "mac") return;
    const ctx = await buildAdapterContext({ unit, deps });
    if (!ctx.mac) return;
    const adapter = getAdapter("mac-profile");
    if (!adapter) return;
    let result;
    try {
      result = await adapter.discover(ctx);
    } catch (err) {
      result = { reachable: false, ready: null, models: [], errors: [errorMessage(err)] };
    }
    const caps = capabilitiesFor(adapter, ctx);
    runtimes.push({
      engine: "mac-profile",
      port: null,
      endpoint: null,
      reachable: result.reachable ?? null,
      capabilities: caps,
      error: result.errors.length ? result.errors.join("; ") : null,
      requestsRunning: null,
      note: null,
    });
    if (result.reachable === true) anyReached = true;
    if (result.reachable === false) anyFailed = true;
    errors.push(...result.errors);
    addProfileModels(table, { kind: "mac", result, caps });
  })();

  await Promise.all([...runtimeJobs, launcherJob, macJob].map((p) => p.catch((err) => errors.push(errorMessage(err)))));
  absorbApiModels(table);

  let reachable;
  if (snap?.online === true) reachable = true;
  else if (anyReached) reachable = true;
  else if (anyFailed) reachable = false;
  else reachable = null;
  if (backoff) {
    if (reachable === false) backoff.recordFailure(targetId);
    else if (reachable === true) backoff.recordSuccess(targetId);
  }
  if (reachable === false) {
    // Every source failed: nothing here may read as current.
    for (const r of table.records()) r.ev.reachable = false;
    carryPrevious(table, deps.previous);
  } else {
    // A runtime that stopped answering: its last known models stay visible, as unreachable.
    const downPorts = new Set(runtimes.filter((r) => r.reachable === false && r.port != null).map((r) => r.port));
    carryPrevious(
      table,
      deps.previous,
      (m) => downPorts.has(m.port) && !m.launcherId && !m.macRuntime && !table.map.has(m.modelKey)
    );
  }
  runtimes.sort((a, b) => (a.port ?? 1e6) - (b.port ?? 1e6) || a.engine.localeCompare(b.engine));
  return {
    targetId,
    collectedAt: now,
    reachable,
    runtimes,
    models: finalizeModels(table, { targetId, deps, usable: reachable !== false, now }),
    clusterModels,
    errors,
    stale: false,
  };
}

// ─── cluster inventory ───────────────────────────────────────────────────────

async function collectClusterInventory(target, deps, now) {
  const targetId = target.targetId ?? clusterTargetId(target.id);
  const clusters = Array.isArray(deps.clusters) ? deps.clusters : [];
  const cluster = clusters.find((c) => c.id === target.id);
  if (!cluster) return emptyInventory(targetId, now, { errors: [`cluster ${target.id} does not exist`] });
  const units = unitsById(deps);
  const online = cluster.memberIds.map((id) => {
    const s = snapOf(deps, id);
    return s && typeof s.online === "boolean" ? s.online : null;
  });
  if (cluster.kind === "group") {
    // A visual group has no inference instance: no runtimes, no models of its own.
    const reachable = online.every((o) => o === true) ? true : online.every((o) => o === false) ? false : null;
    return emptyInventory(targetId, now, { reachable });
  }

  const headPub = units.get(cluster.headId);
  if (!headPub) return emptyInventory(targetId, now, { errors: [`head unit ${cluster.headId} is not in the registry`] });
  const head = fullUnit(deps, headPub);
  const headSnap = snapOf(deps, headPub.id);
  const port = cluster.endpoint?.port ?? null;
  const table = new ModelTable();
  const errors = [];
  const backoff = deps.backoff ?? null;
  const offline = headSnap?.online === false;
  const inBackoff = !offline && backoff && !deps.force && !backoff.canAttempt(targetId);
  const entry = Array.isArray(headSnap?.metrics?.llm)
    ? headSnap.metrics.llm.find((e) => isClusterEndpoint(cluster, headPub, e?.port))
    : undefined;
  const engine = cluster.engine || entry?.backend || null;

  if (offline || inBackoff || port == null) {
    const reason =
      port == null
        ? `cluster ${cluster.id} has no endpoint`
        : offline
          ? `head ${headPub.name || headPub.id} is offline${headSnap?.offlineReason ? `: ${headSnap.offlineReason}` : ""}`
          : `cluster was unreachable; next attempt in ${Math.ceil(backoff.retryInMs(targetId) / 1000)} s`;
    errors.push(reason);
    carryPrevious(table, deps.previous);
    if (offline && backoff && !inBackoff) backoff.recordFailure(targetId);
    return {
      targetId,
      collectedAt: now,
      reachable: port == null ? null : false,
      runtimes: [],
      models: finalizeModels(table, { targetId, deps, usable: false, now }),
      clusterModels: [],
      errors,
      stale: false,
    };
  }

  const runtimes = [];
  let anyReached = false;
  let anyFailed = false;
  const baseUrlPromise = cluster.endpoint.host
    ? Promise.resolve(baseUrlFor(cluster.endpoint.host, port))
    : Promise.resolve(null);
  const baseUrl = await baseUrlPromise.catch(() => null);

  if (engine) {
    const { runtime, result, caps } = await discoverRuntime({ unit: head, engine, port, baseUrl, deps, entry });
    runtimes.push(runtime);
    if (result.reachable === true) anyReached = true;
    if (result.reachable === false) anyFailed = true;
    errors.push(...result.errors);
    addRuntimeModels(table, { engine: runtime.engine, port, result, caps, entry, endpoint: runtime.endpoint });
  } else {
    errors.push(`cluster ${cluster.id}: engine unknown (set the cluster engine, or wait for the monitor to detect it on port ${port})`);
  }

  if (cluster.launcherId && deps.launchers && typeof deps.launchers.list === "function") {
    const adapter = getAdapter("launch-profile");
    const ctx = await buildAdapterContext({ unit: head, deps });
    ctx.launcherFilter = (l) => l.id === cluster.launcherId;
    let result;
    try {
      result = await adapter.discover(ctx);
    } catch (err) {
      result = { reachable: null, ready: null, models: [], errors: [errorMessage(err)] };
    }
    if (!result.models.length) errors.push(`launch profile ${cluster.launcherId} was not found on ${headPub.id}`);
    // The cluster's launcher serves on the cluster endpoint even when its own port is unset.
    for (const m of result.models) if (m.port == null) m.port = port;
    const caps = capabilitiesFor(adapter, ctx);
    runtimes.push({
      engine: "launch-profile",
      port: null,
      endpoint: null,
      reachable: result.reachable ?? null,
      capabilities: caps,
      error: result.errors.length ? result.errors.join("; ") : null,
      requestsRunning: null,
      note: null,
    });
    if (result.reachable === true) anyReached = true;
    if (result.reachable === false) anyFailed = true;
    errors.push(...result.errors);
    addProfileModels(table, { kind: "launcher", result, caps });
  }
  absorbApiModels(table);

  const reachable = anyReached ? true : anyFailed ? false : null;
  if (backoff) {
    if (reachable === false) backoff.recordFailure(targetId);
    else if (reachable === true) backoff.recordSuccess(targetId);
  }
  if (reachable === false) {
    for (const r of table.records()) r.ev.reachable = false;
    carryPrevious(table, deps.previous);
  }
  return {
    targetId,
    collectedAt: now,
    reachable,
    runtimes,
    models: finalizeModels(table, { targetId, deps, usable: reachable !== false, now }),
    clusterModels: [],
    errors,
    stale: false,
  };
}

/**
 * Collect one target's inventory. Never throws: failures land in `errors`.
 * @param {{ targetId?: string, kind: "node"|"cluster", id: string }} target
 * @param {InventoryDeps} deps
 * @returns {Promise<FleetInventory>}
 */
export async function collectInventory(target, deps = /** @type {InventoryDeps} */ ({ units: [] })) {
  const now = (deps.now ?? Date.now)();
  const targetId = target?.targetId ?? `${target?.kind}:${target?.id}`;
  try {
    if (target?.kind === "node") return await collectNodeInventory(target, deps, now);
    if (target?.kind === "cluster") return await collectClusterInventory(target, deps, now);
    return emptyInventory(targetId, now, { errors: ["unknown target kind"] });
  } catch (err) {
    return emptyInventory(targetId, now, { errors: [errorMessage(err)] });
  }
}

/** Fleet total of serving models (normalized endpoint + model id); see targets.js. */
export { countServing } from "./targets.js";
