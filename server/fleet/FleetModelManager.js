import { TargetBackoff, buildAdapterContext, collectInventory } from "./inventory.js";
import { buildTargets, clusterTargetId, nodeTargetId, parseTargetId, suggestClusters } from "./targets.js";
import { listAdapters } from "./adapters/index.js";
import { baseUrlFor, errorMessage } from "./adapters/base.js";
import { parseModelKey } from "./modelStates.js";
import { OperationRunner } from "./operations.js";
import { LAUNCHER_SLOT } from "./adapters/launchProfile.js";

/**
 * Façade over the fleet core for the HTTP routes (plan §3): targets, a short-lived inventory
 * cache, lifecycle operations, logs and clusters. Every network path goes through injected
 * dependencies; SSH tunnels opened to reach a loopback-only engine are closed after each
 * inventory collection, or at the end of the operation that opened them.
 *
 * @typedef {import("./inventory.js").FleetInventory} FleetInventory
 * @typedef {import("./clusterStore.js").FleetCluster} FleetCluster
 * @typedef {import("./clusterStore.js").ClusterStore} ClusterStore
 *
 * @typedef {(unit: object, port: number, opts?: { apiKey?: string|null }) =>
 *   Promise<{ host: string, port: number, via?: string, close?: () => void }>} ResolveTarget
 */

export const INVENTORY_TTL_MS = 10_000;
/** Background refresh period while smart routing is on (routing needs inventories < 60 s old). */
export const BACKGROUND_REFRESH_MS = 30_000;
const COLLECT_TIMEOUT_MS = 60_000;
const LAUNCHER_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** Connections (SSH tunnels) held for one collection or one operation; reused per unit:port. */
class TunnelScope {
  /** @param {ResolveTarget|null} resolveTarget */
  constructor(resolveTarget) {
    this.resolveTarget = resolveTarget;
    /** @type {Map<string, Promise<string>>} */
    this.urls = new Map();
    /** @type {Array<() => void>} */
    this.closers = [];
    /** @type {Map<string, "direct"|"ssh-tunnel">} base URL → how it was reached */
    this.via = new Map();
    this.closed = false;
  }

  /** Base URL for (unit, port): direct or through a tunnel. */
  resolveBaseUrl = (unit, port) => {
    const key = `${unit?.id}:${port}`;
    let p = this.urls.get(key);
    if (!p) {
      p = (async () => {
        const apiKey = unit?.llmApiKeys?.[port] ?? unit?.llmApiKeys?.[String(port)] ?? null;
        const t = await this.resolveTarget(unit, port, { apiKey });
        if (typeof t?.close === "function") {
          if (this.closed) t.close();
          else this.closers.push(t.close);
        }
        const url = baseUrlFor(t.host, t.port);
        this.via.set(url, t.via === "ssh-tunnel" ? "ssh-tunnel" : "direct");
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
    for (const c of this.closers.splice(0)) {
      try {
        c();
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
    rt.via = rt.endpoint ? scope.via.get(rt.endpoint) ?? null : null;
  }
  return inv;
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
   * @param {number} [opts.backgroundRefreshMs]  refresh cached inventories this often while
   *   smartRoutingEnabled is true (0 disables; default 30 s)
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
    this.servedKeys = servedKeys;
    this.cacheTtlMs = cacheTtlMs;
    this.timeoutMs = timeoutMs;
    /** @type {Map<string, { inv: FleetInventory, at: number }>} */
    this.cache = new Map();
    /** @type {Map<string, Promise<FleetInventory>>} */
    this.pending = new Map();
    this.backoff = new TargetBackoff({ now });
    this.runner = new OperationRunner({
      now,
      recordEvent: (e) => this._event(e),
      ...runner,
      host: {
        getTarget: (id) => this._runnerTarget(id),
        openScope: () => new TunnelScope(this.resolveTarget),
        collect: (id, scope) => this._collect(id, { scope, raw: true, force: true }),
        refresh: (id) => this.inventory(id, { refresh: true }),
        contextFor: (id, model, scope) => this._contextFor(id, model, scope),
        launchers: this._launchersApi(),
        onChange: (lockIds) => {
          for (const l of lockIds) this.cache.delete(l);
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
   * One background pass: only while smart routing is on (and the feature enabled). Uses the
   * normal cached path, so the per-target backoff for unreachable targets still applies.
   * @returns {Promise<boolean>} whether a pass ran
   */
  async backgroundRefresh() {
    const s = this._settings();
    if (s.smartRoutingEnabled !== true || s.fleetModelsEnabled === false || this.backgroundRunning) return false;
    this.backgroundRunning = true;
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
   * One collection. `raw` collections (operations) are never cached.
   * @returns {Promise<FleetInventory>}
   */
  async _collect(targetId, { scope = null, raw = false, force = false } = {}) {
    const r = this._resolve(targetId);
    if (!r) throw new Error(`target ${targetId} does not exist`);
    const own = scope == null;
    const s = scope ?? new TunnelScope(this.resolveTarget);
    try {
      const previous = this.cache.get(targetId)?.inv ?? null;
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`inventory of ${targetId} timed out`)), COLLECT_TIMEOUT_MS);
        timer.unref?.();
      });
      try {
        const inv = await Promise.race([
          collectInventory({ targetId, kind: r.kind, id: r.id }, this._deps({ scope: s, raw, force, previous })),
          timeout,
        ]);
        return tagVia(inv, s);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      if (own) s.close();
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
    // Only recent inventories feed servingCount; an older one is treated as absent (count null).
    const now = this.now();
    const inventories = new Map(
      [...this.cache].filter(([, e]) => now - e.at < 2 * this.cacheTtlMs).map(([id, e]) => [id, e.inv])
    );
    return buildTargets({
      units: this._units(),
      clusters: this._clusters(),
      snapshots: this._snapshots(),
      busyTargetIds: this.runner.busyTargetIds(),
      inventories,
    });
  }

  /** @returns {{ targets: object[], generatedAt: number }} */
  targets() {
    return { targets: this._targetList(), generatedAt: this.now() };
  }

  /**
   * Cached inventory (TTL), or a fresh one with `refresh`. A refresh that fails outright serves
   * the cached inventory with `stale: true`. Concurrent callers share one collection.
   * @returns {Promise<FleetInventory|null>} null for an unknown target
   */
  async inventory(targetId, { refresh = false } = {}) {
    if (!this._resolve(targetId)) return null;
    const hit = this.cache.get(targetId);
    if (!refresh && hit && this.now() - hit.at < this.cacheTtlMs) return { ...hit.inv, stale: false };
    let p = this.pending.get(targetId);
    if (!p) {
      p = this._collect(targetId, { force: refresh }).finally(() => {
        if (this.pending.get(targetId) === p) this.pending.delete(targetId);
      });
      this.pending.set(targetId, p);
    }
    try {
      const inv = await p;
      this.cache.set(targetId, { inv, at: this.now() });
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
      this.cache.delete(clusterTargetId(id));
      this._event({ type: "fleet.cluster.updated", severity: "info", sparkId: res.cluster.headId, sparkName: res.cluster.name, message: `Cluster ${res.cluster.name} was changed` });
    }
    return res;
  }

  removeCluster(id) {
    const existing = this.clusterStore.get(id);
    const removed = this.clusterStore.remove(id);
    if (removed) {
      this.cache.delete(clusterTargetId(id));
      this._event({ type: "fleet.cluster.removed", severity: "info", sparkId: existing?.headId ?? null, sparkName: existing?.name ?? id, message: `Cluster ${existing?.name ?? id} was removed` });
    }
    return removed;
  }

  /** Registry listener: a removed unit leaves its clusters and its caches. */
  onRegistryChange(action, spark) {
    if (action !== "remove" || !spark?.id) return;
    try {
      const { updated, removed } = this.clusterStore.pruneUnit(spark.id);
      for (const id of [...updated, ...removed]) this.cache.delete(clusterTargetId(id));
    } catch (err) {
      console.error("[fleet] could not prune clusters:", errorMessage(err));
    }
    this.cache.delete(nodeTargetId(spark.id));
    this.backoff.recordSuccess(nodeTargetId(spark.id));
  }

  shutdown() {
    if (this.backgroundTimer) clearInterval(this.backgroundTimer);
    this.backgroundTimer = null;
    this.runner.shutdown();
  }
}
