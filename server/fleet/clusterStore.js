import fs from "fs";
import net from "net";
import { atomicWrite, quarantineCorrupt } from "../util/atomicWrite.js";

/**
 * Logical clusters (plan §3.2), persisted to config/fleet-clusters.json.
 * A cluster references registry unit ids only; it holds no secrets, so the file is 0644.
 *
 * @typedef {object} FleetClusterEndpoint
 * @property {string|null} host  null → the head's LLM host
 * @property {number} port
 *
 * @typedef {object} FleetCluster
 * @property {string} id
 * @property {string} name
 * @property {"distributed"|"group"} kind
 * @property {string[]} memberIds
 * @property {string} headId
 * @property {FleetClusterEndpoint|null} endpoint
 * @property {string|null} engine
 * @property {string|null} launcherId
 * @property {string} notes
 *
 * @typedef {{ ok: true, cluster: FleetCluster } | { ok: false, error: string, code: "validation"|"not_found"|"conflict" }} ClusterResult
 */

export const CLUSTER_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const LAUNCHER_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const ENGINE_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const HOST_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
export const MAX_CLUSTER_NAME = 80;
export const MAX_CLUSTER_NOTES = 300;
export const MAX_CLUSTERS = 64;

/** @param {unknown} id */
export function isValidClusterId(id) {
  return typeof id === "string" && CLUSTER_ID_RE.test(id);
}

/** URL-safe slug from a display name (same rules as launcher ids). */
export function clusterSlug(name) {
  const s = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s || "cluster";
}

/**
 * Hostname, MagicDNS name, IPv4 or IPv6 (optionally in brackets). No scheme, path, port or spaces.
 * @param {unknown} host
 * @returns {string|null} the normalized host, or null when invalid
 */
export function normalizeEndpointHost(host) {
  if (typeof host !== "string") return null;
  let h = host.trim();
  if (!h || h.length > 253) return null;
  if (h.startsWith("[") && h.endsWith("]")) {
    const inner = h.slice(1, -1);
    return net.isIPv6(inner) ? inner : null;
  }
  if (net.isIPv4(h) || net.isIPv6(h)) return h;
  if (h.endsWith(".")) h = h.slice(0, -1);
  const labels = h.split(".");
  if (labels.some((l) => !HOST_LABEL_RE.test(l))) return null;
  // All-numeric dotted names that are not valid IPv4 (e.g. 999.1.1.1) are refused.
  if (labels.every((l) => /^\d+$/.test(l))) return null;
  return h.toLowerCase();
}

/**
 * Computed capabilities of a cluster.
 * @param {FleetCluster|null|undefined} cluster
 * @returns {{ distributedControl: boolean, lifecycle: boolean }}
 */
export function clusterCapabilities(cluster) {
  const distributedControl = Boolean(cluster && cluster.kind === "distributed" && cluster.launcherId != null);
  return { distributedControl, lifecycle: distributedControl };
}

/**
 * Structural validation and normalization of one cluster record (no registry checks).
 * @param {object} input
 * @returns {{ ok: true, value: FleetCluster } | { ok: false, error: string }}
 */
export function normalizeClusterInput(input) {
  const body = input && typeof input === "object" ? input : {};
  const id = body.id;
  if (!isValidClusterId(id)) {
    return { ok: false, error: "Cluster id must be 1-48 characters: lowercase letters, digits and -" };
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return { ok: false, error: "Name is required" };
  if (name.length > MAX_CLUSTER_NAME) return { ok: false, error: `Name is too long (${MAX_CLUSTER_NAME} characters max)` };
  const kind = body.kind;
  if (kind !== "distributed" && kind !== "group") return { ok: false, error: 'Kind must be "distributed" or "group"' };
  if (!Array.isArray(body.memberIds)) return { ok: false, error: "memberIds must be an array of unit ids" };
  const memberIds = [];
  for (const m of body.memberIds) {
    if (typeof m !== "string" || !m.trim() || m.length > 64) return { ok: false, error: "memberIds must be unit ids" };
    if (memberIds.includes(m.trim())) return { ok: false, error: `Unit ${m.trim()} is listed twice` };
    memberIds.push(m.trim());
  }
  if (memberIds.length < 2) return { ok: false, error: "A cluster needs at least 2 member units" };
  let headId = typeof body.headId === "string" && body.headId.trim() ? body.headId.trim() : null;
  if (headId == null) {
    if (kind === "distributed") return { ok: false, error: "A distributed cluster needs a head unit (headId)" };
    headId = memberIds[0];
  }
  if (!memberIds.includes(headId)) return { ok: false, error: "The head unit must be one of the members" };

  let endpoint = null;
  let engine = null;
  let launcherId = null;
  if (kind === "distributed") {
    const ep = body.endpoint;
    if (!ep || typeof ep !== "object") {
      return { ok: false, error: "A distributed cluster needs an endpoint { host, port }" };
    }
    let host = null;
    if (ep.host != null && !(typeof ep.host === "string" && ep.host.trim() === "")) {
      host = normalizeEndpointHost(ep.host);
      if (!host) {
        return {
          ok: false,
          error: "Endpoint host must be a hostname, MagicDNS name, IPv4 or IPv6 address (no scheme, port, path or spaces)",
        };
      }
    }
    const port = Number(ep.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || (typeof ep.port !== "number" && typeof ep.port !== "string")) {
      return { ok: false, error: "Endpoint port must be 1-65535" };
    }
    endpoint = { host, port };
    if (body.engine != null && body.engine !== "") {
      if (typeof body.engine !== "string" || !ENGINE_RE.test(body.engine.trim().toLowerCase())) {
        return { ok: false, error: "Engine must be a short engine name such as vllm" };
      }
      engine = body.engine.trim().toLowerCase();
    }
    if (body.launcherId != null && body.launcherId !== "") {
      if (typeof body.launcherId !== "string" || !LAUNCHER_ID_RE.test(body.launcherId)) {
        return { ok: false, error: "launcherId must be a launch profile id" };
      }
      launcherId = body.launcherId;
    }
  }
  // A group is visual only: it has no inference instance, so endpoint / engine / launcher are null.
  let notes = "";
  if (body.notes != null) {
    if (typeof body.notes !== "string") return { ok: false, error: "Notes must be text" };
    notes = body.notes.trim();
    if (notes.length > MAX_CLUSTER_NOTES) return { ok: false, error: `Notes are too long (${MAX_CLUSTER_NOTES} characters max)` };
  }
  return { ok: true, value: { id, name, kind, memberIds, headId, endpoint, engine, launcherId, notes } };
}

function copy(c) {
  return { ...c, memberIds: [...c.memberIds], endpoint: c.endpoint ? { ...c.endpoint } : null };
}

export class ClusterStore {
  /**
   * @param {object} opts
   * @param {string} opts.file  JSON file path
   * @param {() => string[]} opts.getUnitIds  current registry unit ids
   */
  constructor({ file, getUnitIds }) {
    this.file = file;
    this.getUnitIds = typeof getUnitIds === "function" ? getUnitIds : () => [];
    /** @type {FleetCluster[]} */
    this.clusters = [];
    this._load();
  }

  _load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      this.clusters = [];
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      const list = parsed && typeof parsed === "object" && Array.isArray(parsed.clusters) ? parsed.clusters : [];
      const out = [];
      for (const c of list) {
        const norm = normalizeClusterInput(c);
        if (!norm.ok || out.some((x) => x.id === norm.value.id)) continue;
        // Keep the one-distributed-cluster-per-unit rule on load too: the first record wins.
        if (norm.value.kind === "distributed" && this._distributedConflict(norm.value, out)) continue;
        out.push(norm.value);
      }
      this.clusters = out;
    } catch (err) {
      // Corrupt file: start empty and move the file aside so the next save cannot destroy it.
      this.clusters = [];
      quarantineCorrupt(this.file, "ClusterStore", err);
    }
  }

  _save() {
    atomicWrite(this.file, JSON.stringify({ version: 1, clusters: this.clusters }, null, 2) + "\n", 0o644);
  }

  /** @returns {FleetCluster[]} */
  list() {
    return this.clusters.map(copy);
  }

  /** @returns {FleetCluster|null} */
  get(id) {
    const c = this.clusters.find((x) => x.id === id);
    return c ? copy(c) : null;
  }

  /** Clusters a unit belongs to. */
  clustersForUnit(unitId) {
    return this.clusters.filter((c) => c.memberIds.includes(unitId)).map(copy);
  }

  /**
   * @param {FleetCluster} cluster
   * @param {FleetCluster[]} [among]
   * @returns {{ unitId: string, clusterId: string } | null}
   */
  _distributedConflict(cluster, among = this.clusters) {
    if (cluster.kind !== "distributed") return null;
    for (const other of among) {
      if (other.id === cluster.id || other.kind !== "distributed") continue;
      const shared = cluster.memberIds.find((m) => other.memberIds.includes(m));
      if (shared) return { unitId: shared, clusterId: other.id };
    }
    return null;
  }

  /**
   * Full validation: structure + registry + cross-cluster rules.
   * @returns {{ ok: true, value: FleetCluster } | { ok: false, error: string, code: "validation"|"conflict" }}
   */
  _validate(input) {
    const norm = normalizeClusterInput(input);
    if (!norm.ok) return { ...norm, code: "validation" };
    const known = new Set(this._unitIds());
    const missing = norm.value.memberIds.filter((m) => !known.has(m));
    if (missing.length) return { ok: false, error: `Unknown unit: ${missing.join(", ")}`, code: "validation" };
    const conflict = this._distributedConflict(norm.value);
    if (conflict) {
      return {
        ok: false,
        error: `Unit ${conflict.unitId} already belongs to distributed cluster ${conflict.clusterId}`,
        code: "conflict",
      };
    }
    return norm;
  }

  _unitIds() {
    try {
      const ids = this.getUnitIds();
      return Array.isArray(ids) ? ids : [];
    } catch {
      return [];
    }
  }

  /**
   * @param {object} input  FleetCluster minus id (+ optional id)
   * @returns {ClusterResult}
   */
  add(input) {
    const body = input && typeof input === "object" ? input : {};
    if (this.clusters.length >= MAX_CLUSTERS) {
      return { ok: false, error: `At most ${MAX_CLUSTERS} clusters`, code: "validation" };
    }
    let id = body.id;
    if (id != null && id !== "") {
      if (!isValidClusterId(id)) {
        return { ok: false, error: "Cluster id must be 1-48 characters: lowercase letters, digits and -", code: "validation" };
      }
      if (this.clusters.some((c) => c.id === id)) return { ok: false, error: `Cluster ${id} already exists`, code: "conflict" };
    } else {
      const base = clusterSlug(body.name);
      id = base;
      for (let n = 2; this.clusters.some((c) => c.id === id); n += 1) id = `${base}-${n}`;
    }
    const v = this._validate({ ...body, id });
    if (!v.ok) return v;
    this.clusters = [...this.clusters, v.value];
    this._save();
    return { ok: true, cluster: copy(v.value) };
  }

  /**
   * Partial update; the id never changes.
   * @returns {ClusterResult}
   */
  update(id, patch) {
    const idx = this.clusters.findIndex((c) => c.id === id);
    if (idx < 0) return { ok: false, error: "Cluster not found", code: "not_found" };
    const body = patch && typeof patch === "object" ? { ...patch } : {};
    delete body.id;
    const merged = { ...this.clusters[idx], ...body, id };
    const v = this._validate(merged);
    if (!v.ok) return v;
    this.clusters = this.clusters.map((c, i) => (i === idx ? v.value : c));
    this._save();
    return { ok: true, cluster: copy(v.value) };
  }

  /** @returns {boolean} */
  remove(id) {
    if (!this.clusters.some((c) => c.id === id)) return false;
    this.clusters = this.clusters.filter((c) => c.id !== id);
    this._save();
    return true;
  }

  /**
   * A unit left the registry: drop it from every cluster. A cluster left with fewer than 2
   * members is removed, and so is a distributed cluster that loses its head; a group that loses
   * its head gets the first remaining member as head.
   * @param {string} unitId
   * @returns {{ updated: string[], removed: string[] }}
   */
  pruneUnit(unitId) {
    const updated = [];
    const removed = [];
    const next = [];
    for (const c of this.clusters) {
      if (!c.memberIds.includes(unitId)) {
        next.push(c);
        continue;
      }
      const memberIds = c.memberIds.filter((m) => m !== unitId);
      // A distributed cluster without its head has no inference instance; a group keeps going
      // with its first remaining member as head while it still has 2 members.
      if (memberIds.length < 2 || (c.headId === unitId && c.kind === "distributed")) {
        removed.push(c.id);
        continue;
      }
      next.push({ ...c, memberIds, headId: c.headId === unitId ? memberIds[0] : c.headId });
      updated.push(c.id);
    }
    if (updated.length || removed.length) {
      this.clusters = next;
      this._save();
    }
    return { updated, removed };
  }

  /**
   * Prune every member that is no longer in the registry (e.g. a unit removed while the
   * dashboard was down). Does nothing when the registry reports no units at all.
   * @returns {{ updated: string[], removed: string[] }}
   */
  pruneMissingUnits() {
    const ids = this._unitIds();
    const out = { updated: [], removed: [] };
    if (ids.length === 0) return out;
    const known = new Set(ids);
    const gone = new Set(this.clusters.flatMap((c) => c.memberIds.filter((m) => !known.has(m))));
    for (const unitId of gone) {
      const r = this.pruneUnit(unitId);
      out.removed.push(...r.removed);
      out.updated.push(...r.updated.filter((x) => !out.updated.includes(x)));
    }
    out.updated = out.updated.filter((x) => !out.removed.includes(x));
    return out;
  }
}
