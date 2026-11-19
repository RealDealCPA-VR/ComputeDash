import { clusterCapabilities, clusterSlug } from "./clusterStore.js";
import { getAdapter } from "./adapters/index.js";
import { capabilitiesFor } from "./adapters/base.js";

/**
 * Fleet targets (plan §3.2): every registry unit is a node, every ClusterStore record a cluster.
 * Pure: everything comes in through the arguments.
 *
 * @typedef {import("./clusterStore.js").FleetCluster} FleetCluster
 * @typedef {"ready"|"degraded"|"unreachable"|"unknown"} TargetHealth
 *
 * @typedef {object} FleetTarget
 * @property {string} targetId
 * @property {"node"|"cluster"} kind
 * @property {string} id
 * @property {string} name
 * @property {"linux"|"darwin"|"windows"|null} platform
 * @property {{ label: string|null, memoryTotalBytes: number|null, memoryKind: "unified"|"vram"|null }} hardware
 * @property {boolean|null} online
 * @property {TargetHealth} health
 * @property {string[]} memberIds
 * @property {string|null} headId
 * @property {string[]} clusterIds
 * @property {"distributed"|"group"|null} clusterKind
 * @property {{ distributedControl: boolean, lifecycle: boolean }} capabilities
 * @property {number|null} servingCount
 * @property {string[]|null} servingModels  modelIds of the de-duplicated serving models (the ones
 *   servingCount counts), alphabetical; null exactly when servingCount is null
 * @property {boolean} busy   an operation holds this target (a node: also a cluster operation on a
 *   cluster it belongs to; a cluster: also an operation on a member node)
 * @property {string|null} activeOperationId  id of that operation, or null
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;
const PLATFORMS = new Set(["linux", "darwin", "windows"]);

/**
 * Can this backend bring models up / down over HTTP alone (no shell on the unit)? Read from the
 * adapter registry with no exec, so a new engine needs no change here.
 */
function httpLifecycle(backend) {
  const adapter = getAdapter(backend);
  if (!adapter) return false;
  const caps = capabilitiesFor(adapter, { exec: null });
  return Boolean(caps.load || caps.start);
}

export const nodeTargetId = (unitId) => `node:${unitId}`;
export const clusterTargetId = (clusterId) => `cluster:${clusterId}`;

/**
 * @param {unknown} targetId
 * @returns {{ kind: "node"|"cluster", id: string } | null}
 */
export function parseTargetId(targetId) {
  if (typeof targetId !== "string") return null;
  const m = /^(node|cluster):(.{1,64})$/.exec(targetId);
  return m ? { kind: /** @type {"node"|"cluster"} */ (m[1]), id: m[2] } : null;
}

const positive = (n) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null);

/**
 * Hardware summary of a unit. Memory that is not known is null, never 0.
 * @param {object} unit
 * @param {object|undefined} snap  SparkMonitor snapshot
 */
export function unitHardware(unit, snap) {
  const hw = snap?.hardware ?? null;
  const device = hw?.device || null;
  const chip = hw?.gpuChip || null;
  const count = Number.isInteger(hw?.gpuCount) && hw.gpuCount > 1 ? hw.gpuCount : null;
  let label = device;
  if (chip && chip !== device) label = device ? `${device} (${count ? `${count}× ` : ""}${chip})` : chip;
  const kind = unit?.kind || snap?.kind || "spark";
  let memoryTotalBytes = null;
  let memoryKind = null;
  if (kind === "host") {
    const vramMb = positive(snap?.metrics?.gpu?.vram?.total);
    if (vramMb != null) {
      memoryTotalBytes = Math.round(vramMb * MB);
      memoryKind = "vram";
    }
  } else {
    const unifiedMb = positive(snap?.metrics?.unifiedMemory?.total);
    const totalGb = positive(hw?.totalMemoryGB);
    if (unifiedMb != null) memoryTotalBytes = Math.round(unifiedMb * MB);
    else if (totalGb != null) memoryTotalBytes = Math.round(totalGb * GB);
    if (memoryTotalBytes != null) memoryKind = "unified";
  }
  return { label: label || null, memoryTotalBytes, memoryKind };
}

/** Distinct model ids an LLM snapshot entry says are served (available entries only). */
export function servedModelIds(entry) {
  if (!entry || entry.available !== true) return [];
  const ids = Array.isArray(entry.models) && entry.models.length ? entry.models : entry.modelId ? [entry.modelId] : [];
  return [...new Set(ids.filter((x) => typeof x === "string" && x))];
}

/** Hosts a unit's LLM endpoints answer on (lowercased). */
export function unitHosts(unit) {
  const out = new Set();
  for (const h of [unit?.llmHost, unit?.lanIp, unit?.ssh?.host, unit?.isLocal ? "127.0.0.1" : null]) {
    if (typeof h === "string" && h.trim()) out.add(h.trim().toLowerCase());
  }
  return out;
}

/**
 * Is (unit, port) the endpoint of this distributed cluster? On the HEAD a port match is the
 * endpoint whatever spelling the endpoint host uses (an IP, MagicDNS, llmHost...), since a
 * distributed runtime is served by its head. A null endpoint host means the head's LLM host, so
 * only the head can own it then; another member owns it only when its own host matches.
 * @param {FleetCluster} cluster
 * @param {object} unit
 * @param {number|null|undefined} port
 */
export function isClusterEndpoint(cluster, unit, port) {
  if (!cluster || cluster.kind !== "distributed" || !cluster.endpoint || port == null) return false;
  if (cluster.endpoint.port !== port) return false;
  if (unit?.id === cluster.headId) return true;
  if (cluster.endpoint.host == null) return false;
  return unitHosts(unit).has(cluster.endpoint.host.toLowerCase());
}

function nodeHealth(snap, online) {
  if (online === false) return "unreachable";
  if (online !== true) return "unknown";
  const llm = Array.isArray(snap?.metrics?.llm) ? snap.metrics.llm : [];
  const critical = Array.isArray(snap?.health) && snap.health.some((f) => f?.severity === "critical");
  if (critical || llm.some((e) => e && e.available === false && e.backend)) return "degraded";
  return "ready";
}

/**
 * @param {object} args
 * @param {object[]} args.units  registry public units, in registry order
 * @param {FleetCluster[]} [args.clusters]
 * @param {Map<string, object>} [args.snapshots]  unitId → SparkMonitor snapshot
 * @param {Set<string>|string[]} [args.busyTargetIds]  locked target ids (a cluster operation also
 *   locks its member nodes)
 * @param {Map<string, string>} [args.activeOperations]  lock id → running operation id
 * @param {Map<string, object>|Record<string, object>} [args.inventories]  targetId → FleetInventory.
 *   servingCount comes only from these; without one it is null. The monitor's /v1/models list is
 *   never used: on multi-model engines (Ollama, LM Studio) it is the installed catalog.
 * @returns {FleetTarget[]}
 */
export function buildTargets({
  units,
  clusters = [],
  snapshots = new Map(),
  busyTargetIds = [],
  activeOperations = new Map(),
  inventories = new Map(),
}) {
  const unitList = Array.isArray(units) ? units.filter((u) => u && typeof u.id === "string") : [];
  const clusterList = Array.isArray(clusters) ? clusters : [];
  const busy = busyTargetIds instanceof Set ? busyTargetIds : new Set(Array.isArray(busyTargetIds) ? busyTargetIds : []);
  const ops = activeOperations instanceof Map ? activeOperations : new Map();
  /** First lock id (in order) held by an operation: [busy, operation id or null]. */
  const lockOf = (ids) => {
    for (const id of ids) {
      if (busy.has(id) || ops.has(id)) return { busy: true, opId: ops.get(id) ?? null };
    }
    return { busy: false, opId: null };
  };
  const snapOf = (id) => (snapshots instanceof Map ? snapshots.get(id) : snapshots?.[id]);
  const unitById = new Map(unitList.map((u) => [u.id, u]));
  const invOf = (targetId) => (inventories instanceof Map ? inventories.get(targetId) : inventories?.[targetId]);

  /** @type {FleetTarget[]} */
  const out = [];
  for (const unit of unitList) {
    const snap = snapOf(unit.id);
    const online = snap ? (typeof snap.online === "boolean" ? snap.online : null) : null;
    const mine = clusterList.filter((c) => c.memberIds.includes(unit.id));
    const distributed = mine.filter((c) => c.kind === "distributed");
    const platform = PLATFORMS.has(unit.platform) ? unit.platform : PLATFORMS.has(snap?.platform) ? snap.platform : null;
    const llm = Array.isArray(snap?.metrics?.llm) ? snap.metrics.llm : null;
    const serving = online === false ? null : inventoryServing(invOf(nodeTargetId(unit.id)));
    // A cluster operation also locks every member node, so the node's own lock covers it.
    const lock = lockOf([nodeTargetId(unit.id)]);
    const lifecycle = platform !== "windows" || (llm ?? []).some((e) => httpLifecycle(e?.backend));
    out.push({
      targetId: nodeTargetId(unit.id),
      kind: "node",
      id: unit.id,
      name: unit.name || unit.id,
      platform,
      hardware: unitHardware(unit, snap),
      online,
      health: nodeHealth(snap, online),
      memberIds: [],
      headId: null,
      clusterIds: mine.map((c) => c.id),
      clusterKind: distributed.length ? "distributed" : mine.length ? "group" : null,
      capabilities: { distributedControl: false, lifecycle },
      servingCount: serving ? serving.count : null,
      servingModels: serving ? serving.models : null,
      busy: lock.busy,
      activeOperationId: lock.opId,
    });
  }

  for (const c of clusterList) {
    const members = c.memberIds.map((id) => unitById.get(id)).filter(Boolean);
    const onl = c.memberIds.map((id) => {
      const s = snapOf(id);
      return s && typeof s.online === "boolean" ? s.online : null;
    });
    const head = unitById.get(c.headId);
    const headSnap = snapOf(c.headId);
    const headOnline = headSnap && typeof headSnap.online === "boolean" ? headSnap.online : null;
    let online;
    let health;
    if (c.kind === "distributed") {
      // The inference instance needs every member; the endpoint lives on the head.
      online = onl.includes(false) ? false : onl.every((o) => o === true) && members.length === c.memberIds.length ? true : null;
      if (headOnline === false) health = "unreachable";
      else if (onl.includes(false)) health = "degraded";
      else if (online === true) health = "ready";
      else health = "unknown";
    } else {
      online = onl.every((o) => o === true) ? true : onl.every((o) => o === false) ? false : null;
      if (onl.every((o) => o === false)) health = "unreachable";
      else if (onl.includes(false)) health = "degraded";
      else if (onl.every((o) => o === true)) health = "ready";
      else health = "unknown";
    }
    const memberHw = members.map((u) => unitHardware(u, snapOf(u.id)));
    const kinds = new Set(memberHw.map((h) => h.memoryKind));
    const memoryKind = kinds.size === 1 ? [...kinds][0] : null;
    // A group has no inference instance: its capacity is not a pooled number, so it stays null.
    const memoryTotalBytes =
      c.kind === "distributed" &&
      memberHw.length === c.memberIds.length &&
      memberHw.every((h) => h.memoryTotalBytes != null) &&
      memoryKind != null
        ? memberHw.reduce((sum, h) => sum + /** @type {number} */ (h.memoryTotalBytes), 0)
        : null;
    const headHw = head ? unitHardware(head, headSnap) : null;
    const label = headHw?.label ? `${c.memberIds.length}× ${headHw.label}` : null;
    const platforms = new Set(members.map((u) => (PLATFORMS.has(u.platform) ? u.platform : null)));
    // A group has no inference instance of its own: null, so nothing is counted twice.
    const serving = c.kind === "distributed" && headOnline !== false ? inventoryServing(invOf(clusterTargetId(c.id))) : null;
    // The cluster's own operation first, then one on a member node (which blocks the cluster too).
    const lock = lockOf([clusterTargetId(c.id), ...c.memberIds.map(nodeTargetId)]);
    out.push({
      targetId: clusterTargetId(c.id),
      kind: "cluster",
      id: c.id,
      name: c.name,
      platform: platforms.size === 1 ? [...platforms][0] : null,
      hardware: { label, memoryTotalBytes, memoryKind: c.kind === "distributed" ? memoryKind : null },
      online,
      health,
      memberIds: [...c.memberIds],
      headId: c.headId,
      clusterIds: [],
      clusterKind: c.kind,
      capabilities: clusterCapabilities(c),
      servingCount: serving ? serving.count : null,
      servingModels: serving ? serving.models : null,
      busy: lock.busy,
      activeOperationId: lock.opId,
    });
  }
  return out;
}

/**
 * Suggested distributed clusters from head/worker roles (plan §3.2 seeding). Suggestions only:
 * nothing is created. Heads that already belong to a distributed cluster are skipped.
 *
 * @param {object[]} units  registry public units
 * @param {FleetCluster[]} [existing]
 * @returns {FleetCluster[]}
 */
export function suggestClusters(units, existing = []) {
  const list = Array.isArray(units) ? units.filter((u) => u && typeof u.id === "string") : [];
  const taken = new Set(
    (Array.isArray(existing) ? existing : []).filter((c) => c.kind === "distributed").flatMap((c) => c.memberIds)
  );
  const usedIds = new Set((Array.isArray(existing) ? existing : []).map((c) => c.id));
  const out = [];
  for (const head of list) {
    if (head.role !== "head" || taken.has(head.id)) continue;
    const workers = list.filter((u) => u.role === "worker" && u.workerHeadId === head.id && !taken.has(u.id));
    if (workers.length === 0) continue;
    const base = clusterSlug(`${head.id}-cluster`);
    let id = base;
    for (let n = 2; usedIds.has(id); n += 1) id = `${base}-${n}`;
    usedIds.add(id);
    const port = Array.isArray(head.llmPorts) && Number.isInteger(head.llmPorts[0]) ? head.llmPorts[0] : null;
    out.push({
      id,
      name: `${head.name || head.id} cluster`.slice(0, 80),
      kind: "distributed",
      memberIds: [head.id, ...workers.map((w) => w.id)],
      headId: head.id,
      endpoint: port != null ? { host: null, port } : null,
      engine: null,
      launcherId: null,
      notes: "Suggested from head/worker roles",
    });
  }
  return out;
}

/** Normalized endpoint ("http://host:port", lowercase, no trailing slash) or null. */
export function normalizeEndpoint(endpoint) {
  if (typeof endpoint !== "string" || !endpoint.trim()) return null;
  return endpoint.trim().toLowerCase().replace(/\/+$/, "");
}

/** Identity of a served model for de-duplication: normalized runtime endpoint + model id (plan §3.2). */
function servingIdentity(inv, m) {
  let endpoint = normalizeEndpoint(m.endpoint);
  if (!endpoint && m.port != null && Array.isArray(inv?.runtimes)) {
    endpoint = normalizeEndpoint(inv.runtimes.find((r) => r?.port === m.port && r?.endpoint)?.endpoint);
  }
  if (!endpoint) endpoint = `${inv?.targetId ?? ""}|${m.port ?? m.launcherId ?? m.macRuntime ?? ""}`;
  return `${endpoint}|${m.modelId}`;
}

/**
 * Fleet total of serving models, de-duplicated by (normalized runtime endpoint, model id).
 * Members list cluster models under clusterModels, which are never counted.
 * @param {object[]} inventories  FleetInventory[]
 * @returns {number}
 */
export function countServing(inventories) {
  return servingByIdentity(inventories).size;
}

/** identity → modelId of every serving model, de-duplicated as countServing does. */
function servingByIdentity(inventories) {
  const seen = new Map();
  for (const inv of Array.isArray(inventories) ? inventories : []) {
    for (const m of inv?.models ?? []) {
      if (m?.state !== "serving") continue;
      const id = servingIdentity(inv, m);
      if (!seen.has(id)) seen.set(id, m.modelId);
    }
  }
  return seen;
}

/**
 * A target's serving models from its inventory: the de-duplicated count and their modelIds
 * (alphabetical; one entry per counted model, so `models.length === count`). null when unknown
 * (no inventory, unreachable, stale, or a failed runtime).
 * @returns {{ count: number, models: string[] }|null}
 */
function inventoryServing(inv) {
  if (!inv || !Array.isArray(inv.models) || inv.reachable === false || inv.stale === true) return null;
  // A runtime that failed makes the count a lower bound: report unknown, not a partial number.
  // (A port where nothing was identified, engine "unknown", is not a failed source.)
  if (Array.isArray(inv.runtimes) && inv.runtimes.some((r) => r && r.engine !== "unknown" && (r.reachable === false || r.error))) return null;
  const models = [...servingByIdentity([inv]).values()].map(String).sort((a, b) => a.localeCompare(b));
  return { count: models.length, models };
}
