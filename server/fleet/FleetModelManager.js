import { TargetBackoff, buildAdapterContext, collectInventory } from "./inventory.js";
import { buildTargets, clusterTargetId, nodeTargetId, parseTargetId, suggestClusters } from "./targets.js";
import { listAdapters } from "./adapters/index.js";
import { baseUrlFor, errorMessage } from "./adapters/base.js";
import { parseModelKey } from "./modelStates.js";
import { OperationRunner } from "./operations.js";
import { LAUNCHER_SLOT } from "./adapters/launchProfile.js";
import { TunnelPool } from "./tunnelPool.js";

/**
 * Façade over the fleet core for the HTTP routes (plan §3): targets, a short-lived inventory
 * cache, lifecycle operations, logs and clusters. Every network path goes through injected
 * dependencies. SSH tunnels to loopback-only engines come from a shared TunnelPool: collections
 * and operations hold them while they run, and the pool closes a tunnel after a minute idle and
 * on shutdown().
 *
 * Inventory cache consistency: every target has a generation. An invalidation (an operation
 * starting / changing phase / ending, a cluster change) and an explicit refresh bump it; a
 * collection's result is cached only if the generation it started under is still current. At
 * most one collection per target runs at a time: a caller that needs data newer than the running
 * collection waits for it to settle (bounded by its timeout) and then starts its own, and
 * concurrent refreshes coalesce onto that next collection.
 *
 * @typedef {import("./inventory.js").FleetInventory} FleetInventory
 * @typedef {import("./clusterStore.js").FleetCluster} FleetCluster
 * @typedef {import("./clusterStore.js").ClusterStore} ClusterStore
 *
 * @typedef {(unit: object, port: number, opts?: { apiKey?: string|null, skipDirect?: boolean }) =>
 *   Promise<{ host: string, port: number, via?: string, close?: () => void }>} ResolveTarget
 */

export const INVENTORY_TTL_MS = 10_000;
/** Background refresh period while smart routing is on (routing needs inventories < 60 s old). */
export const BACKGROUND_REFRESH_MS = 30_000;
/** Background refresh period while nobody routes but someone reads the fleet API. */
export const VIEW_REFRESH_MS = 60_000;
/** The fleet API counts as being read for this long after its last read. */
export const READ_ACTIVE_MS = 120_000;
/**
 * servingCount / servingModels use cached inventories younger than this (covers the 60 s view
 * cadence with slack). Routing keeps its own, stricter rule (routing.js maxAgeMs on collectedAt).
 */
export const SERVING_FRESH_MS = 90_000;
export const COLLECT_TIMEOUT_MS = 60_000;
/** A collection still unsettled this many timeouts after it started is abandoned (a new one may start). */
const COLLECT_ABANDON_FACTOR = 5;
/** Finished operations listed by GET /api/fleet/operations for this long. */
export const RECENT_OPERATIONS_MS = 10 * 60_000;
const LAUNCHER_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

/**
 * Connections held for one collection or one operation; resolved once per unit:port and taken
 * from the shared TunnelPool, so consecutive collections reuse one SSH tunnel per port.
 * `close()` releases this scope's hold; the pool closes an idle tunnel later.
 */
class TunnelScope {
  /**
   * @param {TunnelPool|null} pool
   * @param {{ fresh?: boolean }} [opts]  fresh: ignore the pool's remembered mode and backoff
   */
  constructor(pool, { fresh = false } = {}) {
    this.pool = pool;
    this.fresh = fresh;
    /** @type {Map<string, Promise<string>>} */
    this.urls = new Map();
    /** @type {Array<() => void>} */
    this.releases = [];
    /** @type {Map<string, "direct"|"ssh-tunnel">} base URL → how it was reached */
    this.via = new Map();
    /** @type {Map<string, { unitId: string, port: number }>} base URL → pool key */
    this.origin = new Map();
    this.closed = false;
  }

  /** Base URL for (unit, port): direct or through a tunnel. */
  resolveBaseUrl = (unit, port) => {
    const key = `${unit?.id}:${port}`;
    let p = this.urls.get(key);
    if (!p) {
      p = (async () => {
        const apiKey = unit?.llmApiKeys?.[port] ?? unit?.llmApiKeys?.[String(port)] ?? null;
        const h = await this.pool.acquire(unit, port, { apiKey, fresh: this.fresh });
        if (this.closed) h.release();
        else this.releases.push(h.release);
        const url = baseUrlFor(h.host, h.port);
        this.via.set(url, h.via === "ssh-tunnel" ? "ssh-tunnel" : "direct");
        this.origin.set(url, { unitId: unit?.id, port });
        return url;
      })();
      // A failed resolve is not cached: the next caller tries again.
      p.catch(() => this.urls.delete(key));
      this.urls.set(key, p);
    }
    return p;
  };

  close() {
    this.closed = true;
    for (const r of this.releases.splice(0)) {
      try {
        r();
      } catch {
        /* ignore */
      }
    }
    this.urls.clear();
  }
}

/**
 * Mark how each runtime's endpoint was reached. An "ssh-tunnel" endpoint is a temporary local
 * forward that is closed after the collection, so nothing (e.g. the routing proxy) may send
 * requests to it later. null = no endpoint, or an endpoint this scope did not resolve (unknown:
 * never assumed direct; routing treats an unknown loopback endpoint as unroutable).
 */
function tagVia(inv, scope) {
  if (!inv || !Array.isArray(inv.runtimes)) return inv;
  for (const rt of inv.runtimes) {
    if (!rt || typeof rt !== "object") continue;
    rt.via = rt.endpoint ? scope?.via.get(rt.endpoint) ?? null : null;
  }
  return inv;
}

function collectTimeoutError(targetId) {
  const err = new Error(`inventory of ${targetId} timed out`);
  err.code = "collect_timeout";
  return err;
}

/** Reject after `ms` (the work itself keeps running; callers only stop waiting). */
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class FleetModelManager {
  /**
   * @param {object} opts
   * @param {{ publicSparks: object[], getSpark: (id: string) => object|null, sparkIds?: string[] }} opts.registry
   * @param {Map<string, { snapshot: () => object }>} [opts.monitors]  unitId → SparkMonitor
   * @param {ClusterStore} opts.clusterStore
   * @param {{ list: (id: string) => object[], get?: (id: string, lid: string) => object|null }|null} [opts.launcherStore]
   * @param {object|null} [opts.launcherManager]  LauncherManager (startJob / readJob / latestJob / statuses)
   * @param {(spark: object, launchers: object[]) => Promise<Record<string, string>>} [opts.launcherStatuses]
   *   status reader (e.g. index.js's cached one); defaults to launcherManager.statuses
   * @param {(event: object) => void} [opts.recordEvent]
   * @param {() => object} [opts.getSettings]
   * @param {ResolveTarget|null} [opts.resolveTarget]  SSH-tunnel aware resolution; null → direct llmProbeHost
   * @param {() => number} [opts.now]
   * @param {typeof fetch} [opts.fetchImpl]
   * @param {Function|null} [opts.exec]   undefined → LauncherManager.defaultExec
   * @param {object|null} [opts.mac]      undefined → MacRuntimeControl
   * @param {Set<string>} [opts.servedKeys]
   * @param {number} [opts.cacheTtlMs]
   * @param {number} [opts.timeoutMs]
   * @param {object} [opts.runner]        OperationRunner options (readinessTimeoutMs, pollMs, …)
   * @param {number} [opts.backgroundRefreshMs]  background tick: refresh cached inventories this
   *   often while smartRoutingEnabled is true (0 disables; default 30 s)
   * @param {number} [opts.viewRefreshMs]   background cadence while routing is off but the fleet API
   *   was read in the last `readActiveMs` (default 60 s)
   * @param {number} [opts.readActiveMs]    default 120 s
   * @param {number} [opts.servingFreshMs]  max cache age feeding servingCount / servingModels (90 s)
   * @param {number} [opts.collectTimeoutMs]  callers stop waiting for a collection after this (60 s)
   * @param {TunnelPool|object} [opts.tunnelPool]  a TunnelPool, or TunnelPool options (tests)
   */
  constructor({
    registry,
    monitors = new Map(),
    clusterStore,
    launcherStore = null,
    launcherManager = null,
    launcherStatuses,
    recordEvent = () => {},
    getSettings = () => ({}),
    resolveTarget = null,
    now = Date.now,
    fetchImpl,
    exec,
    mac,
    servedKeys,
    cacheTtlMs = INVENTORY_TTL_MS,
    timeoutMs,
    runner = {},
    backgroundRefreshMs = BACKGROUND_REFRESH_MS,
    viewRefreshMs = VIEW_REFRESH_MS,
    readActiveMs = READ_ACTIVE_MS,
    servingFreshMs = SERVING_FRESH_MS,
    collectTimeoutMs = COLLECT_TIMEOUT_MS,
    tunnelPool,
  }) {
    this.registry = registry;
    this.monitors = monitors;
    this.clusterStore = clusterStore;
    this.launcherStore = launcherStore;
    this.launcherManager = launcherManager;
    this.launcherStatuses = launcherStatuses;
    this.recordEvent = recordEvent;
    this.getSettings = getSettings;
    this.resolveTarget = typeof resolveTarget === "function" ? resolveTarget : null;
    this.now = now;
    this.fetchImpl = fetchImpl;
    this.exec = exec;
    this.mac = mac;
    /** Models seen serving this session (rule 7: stopped vs configured); one store per manager. */
    this.servedKeys = servedKeys instanceof Set ? servedKeys : new Set();
    this.cacheTtlMs = cacheTtlMs;
    this.timeoutMs = timeoutMs;
    /** @type {Map<string, { inv: FleetInventory, at: number }>} */
    this.cache = new Map();
    /**
     * At most one collection per target. The entry stays until the collection settles, even
     * after callers stopped waiting (timeout), so a hung unit never accumulates collections.
     * @type {Map<string, { promise: Promise<FleetInventory>, gen: number, force: boolean, startedAt: number, deadline: number, settled: boolean, abandoned: boolean }>}
     */
    this.pending = new Map();
    /** @type {Map<string, number>} targetId → cache generation */
    this.generations = new Map();
    this.collectTimeoutMs = collectTimeoutMs;
    this.servingFreshMs = servingFreshMs;
    this.viewRefreshMs = viewRefreshMs;
    this.readActiveMs = readActiveMs;
    this.lastReadAt = null;
    this.lastPassAt = null;
    this.backgroundTickMs = backgroundRefreshMs;
    /** @type {TunnelPool|null} */
    this.tunnelPool = null;
    if (this.resolveTarget) {
      this.tunnelPool =
        tunnelPool instanceof TunnelPool ? tunnelPool : new TunnelPool({ resolveTarget: this.resolveTarget, now, ...(tunnelPool ?? {}) });
    }
    this.backoff = new TargetBackoff({ now });
    this.runner = new OperationRunner({
      now,
      recordEvent: (e) => this._event(e),
      ...runner,
      host: {
        getTarget: (id) => this._runnerTarget(id),
        // Operations always check reachability afresh (no remembered mode, no port backoff).
        openScope: () => new TunnelScope(this.tunnelPool, { fresh: true }),
        collect: (id, scope) => this._collect(id, { scope, raw: true, force: true }),
        refresh: (id) => this.inventory(id, { refresh: true }),
        contextFor: (id, model, scope) => this._contextFor(id, model, scope),
        launchers: this._launchersApi(),
        onChange: (lockIds) => {
          for (const l of lockIds) this.invalidate(l);
        },
      },
    });
    this.backgroundTimer = null;
    this.backgroundRunning = false;
    if (backgroundRefreshMs > 0) {
      this.backgroundTimer = setInterval(() => void this.backgroundRefresh(), backgroundRefreshMs);
      this.backgroundTimer.unref?.();
    }
  }

  /**
   * One background pass, using the normal cached path (so the per-target and per-port backoff
   * for unreachable targets still applies). Runs on every tick while smart routing is on (routing
   * needs inventories < 60 s old); otherwise every `viewRefreshMs` while the fleet API was read in
   * the last `readActiveMs`, so the target list's serving counts stay known while someone looks.
   * @returns {Promise<boolean>} whether a pass ran
   */
  async backgroundRefresh() {
    const s = this._settings();
    if (s.fleetModelsEnabled === false || this.backgroundRunning) return false;
    const now = this.now();
    if (s.smartRoutingEnabled !== true) {
      const viewing = this.lastReadAt != null && now - this.lastReadAt < this.readActiveMs;
      if (!viewing) return false;
      // Half a tick of slack, so timer jitter does not push a 60 s cadence to 90 s.
      const slack = Math.max(0, Math.floor((this.backgroundTickMs || 0) / 2));
      if (this.lastPassAt != null && now - this.lastPassAt < this.viewRefreshMs - slack) return false;
    }
    this.backgroundRunning = true;
    this.lastPassAt = now;
    try {
      for (const t of this._targetList()) {
        if (t.kind === "cluster" && t.clusterKind !== "distributed") continue;
        try {
          await this.inventory(t.targetId);
        } catch {
          /* inventory() never throws; keep going */
        }
      }
    } finally {
      this.backgroundRunning = false;
    }
    return true;
  }

  /** The fleet API was read (routes call this; cheap). Keeps background refresh going a while. */
  noteRead() {
    this.lastReadAt = this.now();
  }

  /** Drop a target's cached inventory and make any collection in flight uncacheable. */
  invalidate(targetId) {
    this.cache.delete(targetId);
    this._bump(targetId);
  }

  _gen(targetId) {
    return this.generations.get(targetId) ?? 0;
  }

  _bump(targetId) {
    this.generations.set(targetId, this._gen(targetId) + 1);
  }

  /** Every cached inventory (cheap; for smart routing). @returns {FleetInventory[]} */
  cachedInventories() {
    return [...this.cache.values()].map((e) => ({ ...e.inv }));
  }

  /**
   * The registry's stored LLM API key for a target's unit (a cluster: its head) and port, or null.
   * Never sent to the browser.
   * @param {string} targetId
   * @param {number} port
   * @returns {string|null}
   */
  apiKeyFor(targetId, port) {
    const r = this._resolve(targetId);
    if (!r || !Number.isInteger(port)) return null;
    const unitId = r.cluster ? r.cluster.headId : r.id;
    try {
      if (typeof this.registry.getLlmApiKey === "function") return this.registry.getLlmApiKey(unitId, port) ?? null;
      const unit = this._fullUnit(unitId);
      return unit?.llmApiKeys?.[port] ?? unit?.llmApiKeys?.[String(port)] ?? null;
    } catch {
      return null;
    }
  }

  // ─── sources ───────────────────────────────────────────────────────────────

  _event(event) {
    try {
      this.recordEvent(event);
    } catch {
      /* ignore */
    }
  }

  _units() {
    try {
      const list = this.registry.publicSparks;
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  _fullUnit(id) {
    try {
      return this.registry.getSpark(id) ?? null;
    } catch {
      return null;
    }
  }

  _clusters() {
    try {
      return this.clusterStore?.list() ?? [];
    } catch {
      return [];
    }
  }

  _snapshots() {
    const out = new Map();
    for (const [id, mon] of this.monitors ?? []) {
      try {
        const s = mon?.snapshot?.();
        if (s) out.set(id, s);
      } catch {
        /* a monitor that cannot answer has no snapshot */
      }
    }
    return out;
  }

  /**
   * @param {{ fresh?: boolean }} [opts]  fresh: bypass the shared status cache (operations wait on
   *   real process state; a 10 s old "running" must not end a stop wait)
   */
  _launchersApi({ fresh = false } = {}) {
    const store = this.launcherStore;
    const mgr = this.launcherManager;
    if (!store || typeof store.list !== "function") return null;
    return {
      list: (id) => store.list(id),
      statuses: async (spark, launchers) => {
        if (!fresh && typeof this.launcherStatuses === "function") return this.launcherStatuses(spark, launchers);
        if (typeof mgr?.statuses === "function") return mgr.statuses(spark, launchers);
        return Object.fromEntries(launchers.map((l) => [l.id, "unknown"]));
      },
      startJob: (spark, launcher, action) =>
        mgr?.startJob ? mgr.startJob(spark, launcher, action) : { ok: false, reason: "launch profiles are not available" },
      latestJob: (id) => (mgr?.latestJob ? mgr.latestJob(id) : null),
      readJob: (id, jobId, since) => (mgr?.readJob ? mgr.readJob(id, jobId, since) : null),
    };
  }

  _deps({ scope = null, raw = false, force = false, previous = null } = {}) {
    return {
      units: this._units(),
      getSpark: (id) => this._fullUnit(id),
      snapshots: this._snapshots(),
      clusters: this._clusters(),
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      exec: this.exec,
      mac: this.mac,
      resolveBaseUrl: scope && this.resolveTarget ? scope.resolveBaseUrl : undefined,
      launchers: this._launchersApi({ fresh: raw }),
      // Operations read raw evidence: their own in-flight phase must not mask what they wait for.
      operations: raw ? {} : { inFlight: (t, k) => this.runner.inFlight(t, k), lastFailure: (t, k) => this.runner.lastFailure(t, k) },
      servedKeys: this.servedKeys,
      backoff: this.backoff,
      force,
      previous,
      getCachedInventory: (id) => this.cache.get(id)?.inv ?? null,
      now: this.now,
    };
  }

  /** @returns {{ targetId: string, kind: "node"|"cluster", id: string, cluster?: FleetCluster }|null} */
  _resolve(targetId) {
    const parsed = parseTargetId(targetId);
    if (!parsed) return null;
    if (parsed.kind === "node") {
      return this._units().some((u) => u.id === parsed.id) ? { targetId, ...parsed } : null;
    }
    const cluster = this._clusters().find((c) => c.id === parsed.id);
    return cluster ? { targetId, ...parsed, cluster } : null;
  }

  /** Is this a known target? */
  hasTarget(targetId) {
    return this._resolve(targetId) != null;
  }

  _runnerTarget(targetId) {
    const r = this._resolve(targetId);
    if (!r) return null;
    const t = this._targetList().find((x) => x.targetId === targetId);
    return {
      targetId,
      kind: r.kind,
      name: t?.name ?? r.id,
      memberIds: r.cluster ? [...r.cluster.memberIds] : [],
      unitId: r.cluster ? r.cluster.headId : r.id,
      memoryTotalBytes: t?.hardware?.memoryTotalBytes ?? null,
    };
  }

  /**
   * One collection. `raw` collections (operations) are never cached. `timeoutMs` > 0 rejects
   * after that long (operations); the cached path (inventory) bounds its waiting itself.
   * @returns {Promise<FleetInventory>}
   */
  async _collect(targetId, { scope = null, raw = false, force = false, timeoutMs = this.collectTimeoutMs } = {}) {
    const r = this._resolve(targetId);
    if (!r) throw new Error(`target ${targetId} does not exist`);
    const own = scope == null;
    const s = scope ?? (this.tunnelPool ? new TunnelScope(this.tunnelPool, { fresh: force }) : null);
    try {
      const previous = this.cache.get(targetId)?.inv ?? null;
      const work = collectInventory({ targetId, kind: r.kind, id: r.id }, this._deps({ scope: s, raw, force, previous }));
      const inv = timeoutMs > 0 ? await withTimeout(work, timeoutMs, `inventory of ${targetId} timed out`) : await work;
      if (own && s) this._forgetFailedDirect(inv, s);
      return tagVia(inv, s);
    } finally {
      if (own) s?.close();
    }
  }

  /**
   * A port remembered as directly reachable that did not answer: forget that, so the next
   * collection probes again (and may fall back to a tunnel). Tunnels are not retired here: an
   * engine that is down behind a live tunnel would otherwise cost a new SSH process per pass.
   */
  _forgetFailedDirect(inv, scope) {
    if (!this.tunnelPool || !Array.isArray(inv?.runtimes)) return;
    for (const rt of inv.runtimes) {
      if (rt?.reachable !== false || !rt.endpoint || scope.via.get(rt.endpoint) !== "direct") continue;
      const o = scope.origin.get(rt.endpoint);
      if (o) this.tunnelPool.invalidate(o.unitId, o.port);
    }
  }

  async _contextFor(targetId, model, scope) {
    const r = this._resolve(targetId);
    if (!r) throw new Error(`target ${targetId} does not exist`);
    const unitId = r.cluster ? r.cluster.headId : r.id;
    const unit = this._fullUnit(unitId);
    if (!unit) throw new Error(`unit ${unitId} is not in the registry`);
    const profile = Boolean(model.launcherId || model.macRuntime);
    const port = profile ? null : model.port ?? null;
    let baseUrl = null;
    const ep = r.cluster?.endpoint;
    if (!profile && ep?.host && port === ep.port) baseUrl = baseUrlFor(ep.host, port);
    return buildAdapterContext({ unit, port, baseUrl, deps: this._deps({ scope, raw: true }) });
  }

  // ─── API used by the routes ────────────────────────────────────────────────

  status() {
    const s = this._settings();
    return { enabled: s.fleetModelsEnabled !== false, smartRoutingEnabled: s.smartRoutingEnabled === true, adapters: listAdapters() };
  }

  _settings() {
    try {
      return this.getSettings() ?? {};
    } catch {
      return {};
    }
  }

  _targetList() {
    // Only recent inventories feed servingCount / servingModels; an older one counts as absent
    // (null). The window matches the background cadence (60 s while the API is read).
    const now = this.now();
    const inventories = new Map(
      [...this.cache].filter(([, e]) => now - e.at < this.servingFreshMs).map(([id, e]) => [id, e.inv])
    );
    return buildTargets({
      units: this._units(),
      clusters: this._clusters(),
      snapshots: this._snapshots(),
      busyTargetIds: this.runner.busyTargetIds(),
      activeOperations: this.runner.activeLocks(),
      inventories,
    });
  }

  /** @returns {{ targets: object[], generatedAt: number }} */
  targets() {
    return { targets: this._targetList(), generatedAt: this.now() };
  }

  /**
   * Cached inventory (TTL), or a fresh one with `refresh`. A refresh (or a collection) that fails
   * outright serves the cached inventory with `stale: true`. Concurrent callers share one
   * collection; a refresh never joins a collection that started before it (see the class doc).
   * @returns {Promise<FleetInventory|null>} null for an unknown target
   */
  async inventory(targetId, { refresh = false } = {}) {
    if (!this._resolve(targetId)) return null;
    if (!refresh) {
      const hit = this.cache.get(targetId);
      if (hit && this.now() - hit.at < this.cacheTtlMs) return { ...hit.inv, stale: false };
    } else {
      // Whatever is in flight now started before this request: its result must not be cached.
      this._bump(targetId);
    }
    try {
      const inv = await this._awaitCollection(targetId, refresh);
      return { ...inv, stale: false };
    } catch (err) {
      const cached = this.cache.get(targetId);
      if (cached) {
        return { ...cached.inv, stale: true, errors: [...(cached.inv.errors ?? []), errorMessage(err)] };
      }
      return {
        targetId,
        collectedAt: this.now(),
        reachable: null,
        runtimes: [],
        models: [],
        clusterModels: [],
        errors: [errorMessage(err)],
        stale: false,
      };
    }
  }

  /**
   * Join the target's current-generation collection, or start one. A collection of an older
   * generation (or a non-forced one when `force` is needed) is waited for, never stacked on:
   * once it settles a new one starts; if it is still running at its deadline, this caller gets
   * the timeout and nothing new starts.
   */
  async _awaitCollection(targetId, force) {
    for (let attempt = 0; ; attempt += 1) {
      const gen = this._gen(targetId);
      let e = this.pending.get(targetId);
      if (e && (e.settled || this.now() - e.startedAt > COLLECT_ABANDON_FACTOR * this.collectTimeoutMs)) {
        // Settled (cleanup pending) or hung far past its deadline: no longer blocks a new collection.
        if (!e.settled) {
          console.warn(`[fleet] inventory of ${targetId} never settled; starting a new collection`);
          // Its eventual result is older than the replacement's: it must never overwrite the cache.
          e.abandoned = true;
        }
        this.pending.delete(targetId);
        e = undefined;
      }
      if (!e) e = this._startCollection(targetId, gen, force);
      if ((e.gen === gen && (e.force || !force)) || attempt >= 3) return this._waitFor(targetId, e);
      try {
        await this._waitFor(targetId, e);
      } catch (err) {
        if (err?.code === "collect_timeout") throw err;
        /* it failed: ours may do better */
      }
    }
  }

  _startCollection(targetId, gen, force) {
    const startedAt = this.now();
    const entry = { gen, force, startedAt, deadline: startedAt + this.collectTimeoutMs, settled: false, abandoned: false, promise: null };
    entry.promise = Promise.resolve().then(() => this._collect(targetId, { force, timeoutMs: 0 }));
    const done = () => {
      entry.settled = true;
      if (this.pending.get(targetId) === entry) this.pending.delete(targetId);
    };
    entry.promise.then(
      (inv) => {
        done();
        // Cached only if nothing invalidated the target (or refreshed it) since this started.
        if (!entry.abandoned && this._gen(targetId) === gen && this._resolve(targetId)) this.cache.set(targetId, { inv, at: this.now() });
      },
      done
    );
    this.pending.set(targetId, entry);
    return entry;
  }

  /** Wait for a collection until its deadline. */
  _waitFor(targetId, entry) {
    const remaining = entry.deadline - this.now();
    if (entry.settled || remaining > 0) {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(collectTimeoutError(targetId)), Math.max(0, remaining));
      });
      return Promise.race([entry.promise, timeout]).finally(() => clearTimeout(timer));
    }
    return Promise.reject(collectTimeoutError(targetId));
  }

  /**
   * @param {string} targetId
   * @param {{ action: string, modelKey: string, force?: boolean, rollback?: boolean }} body  validated by the route
   * @returns {{ ok: true, operation: object } | { ok: false, status: number, code: string, error: string }}
   */
  startOperation(targetId, body) {
    if (!this._resolve(targetId)) return { ok: false, status: 404, code: "unknown_target", error: `target ${targetId} does not exist` };
    // A model the cached inventory does not know: 404 now; with no cache, step 2 decides.
    const cached = this.cache.get(targetId)?.inv;
    if (cached && Array.isArray(cached.models) && cached.reachable !== false && !cached.models.some((m) => m.modelKey === body.modelKey)) {
      return { ok: false, status: 404, code: "unknown_model", error: `model ${body.modelKey} is not on ${targetId}; refresh the inventory` };
    }
    const res = this.runner.start(targetId, body);
    if (res.ok) return res;
    const status = res.code === "busy" ? 409 : res.code === "unknown_target" ? 404 : res.code === "shutting_down" ? 503 : 400;
    return { ok: false, status, code: res.code, error: res.error };
  }

  /**
   * Operations for GET /api/fleet/operations, newest first: running ones, plus (unless
   * `activeOnly`) those finished in the last RECENT_OPERATIONS_MS.
   * @returns {{ operations: object[] }}
   */
  listOperations({ activeOnly = false } = {}) {
    return { operations: this.runner.list({ activeOnly, recentMs: RECENT_OPERATIONS_MS }) };
  }

  readOperation(id, since = 0) {
    return this.runner.read(id, since);
  }

  cancelOperation(id) {
    return this.runner.cancel(id);
  }

  /** Is this target (or, for a cluster, any member) locked by an operation? */
  isBusy(targetId) {
    const r = this._resolve(targetId);
    if (!r) return this.runner.isBusy(targetId);
    const ids = [targetId, ...(r.cluster ? r.cluster.memberIds.map(nodeTargetId) : [])];
    return ids.some((id) => this.runner.isBusy(id));
  }

  /** A unit is locked by a fleet operation (as a node or a cluster member). */
  isUnitBusy(unitId) {
    return this.runner.isBusy(nodeTargetId(unitId));
  }

  /**
   * Logs for a model: the launcher job output, the mac agent's last operation, or none.
   * @returns {Promise<{ source: "launcher"|"mac-agent"|"none", lines: {seq:number,text:string}[], note?: string }|null>}
   */
  async logs(targetId, modelKey = null) {
    const r = this._resolve(targetId);
    if (!r) return null;
    const unitId = r.cluster ? r.cluster.headId : r.id;
    const parsed = modelKey ? parseModelKey(modelKey) : null;
    const launcherId = parsed?.slot?.startsWith("launcher:") ? parsed.slot.slice("launcher:".length) : r.cluster?.launcherId ?? null;
    const macRuntime = parsed?.slot?.startsWith("mac:") ? parsed.slot.slice("mac:".length) : null;
    const mgr = this.launcherManager;
    if (launcherId && (!parsed || parsed.slot === LAUNCHER_SLOT(launcherId))) {
      const job = mgr?.latestJob?.(unitId) ?? null;
      if (!job || job.launcherId !== launcherId || typeof mgr?.readJob !== "function") {
        return { source: "launcher", lines: [], note: "No launcher output for this model yet (output is kept for the latest start or stop on the unit)." };
      }
      const read = mgr.readJob(unitId, job.id, 0);
      const lines = (read?.lines ?? []).map((l) => ({ seq: l.seq, text: l.text }));
      return read?.truncated ? { source: "launcher", lines, note: "Older lines were dropped." } : { source: "launcher", lines };
    }
    if (macRuntime) {
      const unit = this._fullUnit(unitId);
      if (unit?.kind !== "mac") return { source: "none", lines: [], note: "This unit is not a Mac." };
      try {
        const read = this.mac?.readRuntimeControl
          ? this.mac.readRuntimeControl
          : (await import("../collectors/MacRuntimeControl.js")).readRuntimeControl;
        const view = await read(unit);
        const text = view?.operation?.output ?? view?.output ?? "";
        const lines = typeof text === "string" && text ? text.split("\n").map((t, i) => ({ seq: i + 1, text: t })) : [];
        return lines.length
          ? { source: "mac-agent", lines }
          : { source: "mac-agent", lines: [], note: "The Mac agent has no output for a recent operation." };
      } catch (err) {
        return { source: "mac-agent", lines: [], note: errorMessage(err) };
      }
    }
    return { source: "none", lines: [], note: "This engine does not expose its logs to the dashboard. Check the engine on the unit itself." };
  }

  // ─── clusters ──────────────────────────────────────────────────────────────

  listClusters() {
    const clusters = this._clusters();
    return { clusters, suggestions: suggestClusters(this._units(), clusters) };
  }

  getCluster(id) {
    return this.clusterStore.get(id);
  }

  /** Does launch profile `launcherId` exist on unit `unitId`? */
  launcherExists(unitId, launcherId) {
    if (typeof launcherId !== "string" || !LAUNCHER_ID_RE.test(launcherId)) return false;
    try {
      return (this.launcherStore?.list(unitId) ?? []).some((l) => l.id === launcherId);
    } catch {
      return false;
    }
  }

  createCluster(input) {
    const res = this.clusterStore.add(input);
    if (res.ok) this._event({ type: "fleet.cluster.created", severity: "info", sparkId: res.cluster.headId, sparkName: res.cluster.name, message: `Cluster ${res.cluster.name} was created` });
    return res;
  }

  updateCluster(id, patch) {
    const res = this.clusterStore.update(id, patch);
    if (res.ok) {
      this.invalidate(clusterTargetId(id));
      this._event({ type: "fleet.cluster.updated", severity: "info", sparkId: res.cluster.headId, sparkName: res.cluster.name, message: `Cluster ${res.cluster.name} was changed` });
    }
    return res;
  }

  removeCluster(id) {
    const existing = this.clusterStore.get(id);
    const removed = this.clusterStore.remove(id);
    if (removed) {
      this.invalidate(clusterTargetId(id));
      this._event({ type: "fleet.cluster.removed", severity: "info", sparkId: existing?.headId ?? null, sparkName: existing?.name ?? id, message: `Cluster ${existing?.name ?? id} was removed` });
    }
    return removed;
  }

  /** Registry listener: a removed unit leaves its clusters and its caches. */
  onRegistryChange(action, spark) {
    if (!spark?.id) return;
    // A changed or removed unit may have a new address: forget how its ports were reached.
    if (action !== "add") this.tunnelPool?.forgetUnit(spark.id);
    if (action !== "remove") return;
    try {
      const { updated, removed } = this.clusterStore.pruneUnit(spark.id);
      for (const id of [...updated, ...removed]) this.invalidate(clusterTargetId(id));
    } catch (err) {
      console.error("[fleet] could not prune clusters:", errorMessage(err));
    }
    this.invalidate(nodeTargetId(spark.id));
    this.backoff.recordSuccess(nodeTargetId(spark.id));
  }

  shutdown() {
    if (this.backgroundTimer) clearInterval(this.backgroundTimer);
    this.backgroundTimer = null;
    this.runner.shutdown();
    this.tunnelPool?.closeAll();
  }
}
