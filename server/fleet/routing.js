/**
 * Optional smart routing (PRD P1, plan §1 / §4). Pure: no I/O, no clock unless injected.
 *
 * Routing only CHOOSES among targets that already serve the requested model. It never starts,
 * stops, loads or switches anything. A model is routable on a target only when that target's
 * inventory lists it in state "serving", the inventory is fresh and not stale, and both the target
 * and the runtime that serves it are reachable.
 *
 * @typedef {import("./inventory.js").FleetInventory} FleetInventory
 * @typedef {import("./inventory.js").FleetModel} FleetModel
 * @typedef {import("./inventory.js").FleetRuntime} FleetRuntime
 * @typedef {import("./targets.js").FleetTarget} FleetTarget
 *
 * @typedef {{ targetId: string, endpoint: string, load: number|null, port?: number|null }} RouteTarget
 * @typedef {{ model: string, targets: RouteTarget[] }} RouteEntry
 * @typedef {"least-loaded"|"first-available"|"round-robin"} RoutingPolicy
 */
import { normalizeEndpoint } from "./targets.js";

export const ROUTING_POLICIES = Object.freeze(["least-loaded", "first-available", "round-robin"]);
export const DEFAULT_ROUTING_POLICY = "least-loaded";
/** Inventories older than this are not trusted for routing. */
export const DEFAULT_MAX_INVENTORY_AGE_MS = 60_000;

/**
 * @param {unknown} policy
 * @returns {RoutingPolicy}
 */
export function normalizePolicy(policy) {
  return typeof policy === "string" && ROUTING_POLICIES.includes(policy)
    ? /** @type {RoutingPolicy} */ (policy)
    : DEFAULT_ROUTING_POLICY;
}

const byTargetId = (a, b) =>
  a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : a.endpoint < b.endpoint ? -1 : a.endpoint > b.endpoint ? 1 : 0;

function knownLoad(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * The runtime that serves a model: same port with a usable endpoint, preferring the same engine.
 * @param {FleetRuntime[]} runtimes
 * @param {FleetModel} model
 */
function runtimeFor(runtimes, model) {
  if (model.port == null) return null;
  const onPort = runtimes.filter((r) => r && r.port === model.port && typeof r.endpoint === "string" && r.endpoint);
  return onPort.find((r) => r.engine === model.engine) ?? onPort[0] ?? null;
}

/**
 * Build the route table from cached inventories.
 *
 * - Only `models` count; a member node's `clusterModels` are never routes of their own, the
 *   cluster target carries them.
 * - Excluded: non-serving models, stale or too-old inventories, unreachable targets / runtimes,
 *   inventories whose target is not in `targets` (when `targets` is given), and runtimes with no
 *   endpoint.
 * - The same (endpoint, model) pair is listed once; a cluster target wins over a node target.
 *
 * @param {FleetInventory[]} inventories
 * @param {FleetTarget[]} [targets]
 * @param {{ now?: number, maxAgeMs?: number }} [opts]
 * @returns {RouteEntry[]}
 */
export function buildRouteTable(inventories, targets, opts = {}) {
  const now = typeof opts.now === "number" ? opts.now : Date.now();
  const maxAgeMs = typeof opts.maxAgeMs === "number" && opts.maxAgeMs > 0 ? opts.maxAgeMs : DEFAULT_MAX_INVENTORY_AGE_MS;
  const targetMap = Array.isArray(targets) ? new Map(targets.filter(Boolean).map((t) => [t.targetId, t])) : null;

  /** @type {Map<string, RouteTarget & { kind: string, model: string }>} key: endpoint|modelId */
  const byEndpoint = new Map();
  for (const inv of Array.isArray(inventories) ? inventories : []) {
    if (!inv || typeof inv.targetId !== "string") continue;
    if (inv.stale === true || inv.reachable === false) continue;
    if (typeof inv.collectedAt !== "number" || now - inv.collectedAt > maxAgeMs) continue;
    const target = targetMap ? targetMap.get(inv.targetId) : null;
    if (targetMap && !target) continue;
    if (target && (target.online === false || target.health === "unreachable")) continue;
    const kind = target?.kind ?? (inv.targetId.startsWith("cluster:") ? "cluster" : "node");
    const runtimes = Array.isArray(inv.runtimes) ? inv.runtimes : [];
    for (const m of Array.isArray(inv.models) ? inv.models : []) {
      if (!m || m.state !== "serving" || typeof m.modelId !== "string" || !m.modelId) continue;
      if (m.servedBy) continue; // a cluster's model shown on a member node
      const rt = runtimeFor(runtimes, m);
      if (!rt || rt.reachable === false) continue;
      // Same normalization as targets.js countServing, so case-only differences dedupe.
      const endpoint = normalizeEndpoint(rt.endpoint);
      if (!endpoint) continue;
      const load = knownLoad(/** @type {any} */ (m).requestsRunning) ?? knownLoad(rt.requestsRunning);
      const key = `${endpoint}|${m.modelId}`;
      const prev = byEndpoint.get(key);
      if (prev && !(prev.kind !== "cluster" && kind === "cluster") && !(prev.kind === kind && inv.targetId < prev.targetId)) continue;
      byEndpoint.set(key, { targetId: inv.targetId, endpoint, load, port: m.port, kind, model: m.modelId });
    }
  }

  /** @type {Map<string, RouteTarget[]>} */
  const byModel = new Map();
  for (const r of byEndpoint.values()) {
    const list = byModel.get(r.model) ?? [];
    list.push({ targetId: r.targetId, endpoint: r.endpoint, load: r.load, port: r.port ?? null });
    byModel.set(r.model, list);
  }
  return [...byModel.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([model, list]) => ({ model, targets: list.sort(byTargetId) }));
}

/**
 * Find the route entry for a requested model name: exact id first, then a unique
 * case-insensitive match. Never a fuzzy / prefix / different model.
 * @param {string} model
 * @param {RouteEntry[]} table
 * @returns {{ entry: RouteEntry|null, reason: string }}
 */
export function matchModel(model, table) {
  if (typeof model !== "string" || !model.trim()) return { entry: null, reason: "No model was requested" };
  const entries = Array.isArray(table) ? table : [];
  const exact = entries.find((e) => e.model === model);
  if (exact) return { entry: exact, reason: "exact match" };
  const lower = model.toLowerCase();
  const ci = entries.filter((e) => e.model.toLowerCase() === lower);
  if (ci.length === 1) return { entry: ci[0], reason: `case-insensitive match for "${ci[0].model}"` };
  if (ci.length > 1) {
    return { entry: null, reason: `"${model}" matches several served models by case only (${ci.map((e) => e.model).join(", ")}); use the exact id` };
  }
  return { entry: null, reason: `No target is serving "${model}"` };
}

/** Small stable string hash (FNV-1a) for sticky keys. */
function hashKey(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Round-robin counters, keyed by model id. Inject one per process. */
export function createRoundRobinState() {
  return new Map();
}

/**
 * Order the candidate targets for a model by policy: the first is the pick, the rest are the
 * fallbacks the proxy may try when a connection cannot be opened at all.
 *
 * @param {string} model
 * @param {RouteEntry[]} table
 * @param {{ policy?: string, stickyKey?: string, rrState?: Map<string, number>, inflight?: Map<string, number> }} [opts]
 *   stickyKey: when given, the same key goes to the same target while the candidate set is
 *   unchanged (overrides the policy order for the first pick).
 *   inflight: requests the proxy itself has open per targetId. least-loaded ranks a known
 *   inventory load as (load + inflight). An unknown load stays unknown and still ranks after
 *   every known load; among unknown-load candidates the one with fewer in-flight requests goes
 *   first. (The engine's requestsRunning may already include some of these requests until the
 *   next inventory refresh; the brief over-count only biases toward spreading load.)
 * @returns {{ model: string|null, policy: RoutingPolicy, ranked: RouteTarget[], reason: string }}
 */
export function rankTargets(model, table, opts = {}) {
  const policy = normalizePolicy(opts.policy);
  const { entry, reason: matchReason } = matchModel(model, table);
  if (!entry) return { model: null, policy, ranked: [], reason: matchReason };
  const base = [...entry.targets].sort(byTargetId);
  if (!base.length) return { model: entry.model, policy, ranked: [], reason: `No target is serving "${entry.model}"` };

  let ranked;
  let why;
  if (typeof opts.stickyKey === "string" && opts.stickyKey) {
    const i = hashKey(opts.stickyKey) % base.length;
    ranked = [...base.slice(i), ...base.slice(0, i)];
    why = "sticky key";
  } else if (policy === "first-available") {
    ranked = base;
    why = "first available (by target id)";
  } else if (policy === "round-robin") {
    const state = opts.rrState instanceof Map ? opts.rrState : null;
    const n = state ? state.get(entry.model) ?? 0 : 0;
    const i = n % base.length;
    if (state) state.set(entry.model, (n + 1) % 1_000_000_000);
    ranked = [...base.slice(i), ...base.slice(0, i)];
    why = `round-robin (${i + 1} of ${base.length})`;
  } else {
    const inflight = opts.inflight instanceof Map ? opts.inflight : null;
    const own = (t) => {
      const n = inflight?.get(t.targetId);
      return typeof n === "number" && n > 0 ? n : 0;
    };
    const eff = (t) => (t.load == null ? null : t.load + own(t));
    ranked = [...base].sort((a, b) => {
      const la = eff(a);
      const lb = eff(b);
      if (la == null && lb == null) return own(a) - own(b) || byTargetId(a, b);
      if (la == null) return 1;
      if (lb == null) return -1;
      return la - lb || byTargetId(a, b);
    });
    const first = ranked[0];
    const l = eff(first);
    why = l == null ? "least loaded (load unknown on every candidate)" : `least loaded (${l} running)`;
  }
  const n = base.length;
  const reason = `${ranked[0].targetId} serves "${entry.model}" (${matchReason}); ${why}; ${n} candidate${n === 1 ? "" : "s"}`;
  return { model: entry.model, policy, ranked, reason };
}

/**
 * Pick one target for a model.
 * @param {string} model
 * @param {RouteEntry[]} table
 * @param {{ policy?: string, stickyKey?: string, rrState?: Map<string, number>, inflight?: Map<string, number> }} [opts]
 * @returns {{ target: RouteTarget|null, endpoint: string|null, model: string|null, policy: RoutingPolicy, reason: string }}
 */
export function pickTarget(model, table, opts = {}) {
  const r = rankTargets(model, table, opts);
  const target = r.ranked[0] ?? null;
  return { target, endpoint: target?.endpoint ?? null, model: r.model, policy: r.policy, reason: r.reason };
}
