/**
 * Fleet Model Manager API contract (docs/FLEET-MODEL-MANAGER-PLAN.md §4).
 * These shapes mirror the server's JSON exactly; null always means "not known", never zero.
 */

export type ModelState =
  | "installed"
  | "configured"
  | "starting"
  | "loaded"
  | "serving"
  | "stopping"
  | "stopped"
  | "failed"
  | "unknown"
  | "unreachable";
export type TargetKind = "node" | "cluster";
export type TargetHealth = "ready" | "degraded" | "unreachable" | "unknown";

export interface AdapterCapabilities {
  discover: boolean;
  start: boolean;
  stop: boolean;
  load: boolean;
  unload: boolean;
  logs: boolean;
  multiModel: boolean;
}

export interface AdapterInfo {
  engine: string;
  label: string;
  capabilities: AdapterCapabilities;
}

export interface FleetTarget {
  /** "node:<unitId>" | "cluster:<clusterId>" */
  targetId: string;
  kind: TargetKind;
  /** Unit id or cluster id. */
  id: string;
  name: string;
  platform: "linux" | "darwin" | "windows" | null;
  hardware: { label: string | null; memoryTotalBytes: number | null; memoryKind: "unified" | "vram" | null };
  /** null = not yet known */
  online: boolean | null;
  health: TargetHealth;
  /** Clusters only ([] for nodes). */
  memberIds: string[];
  headId: string | null;
  /** Nodes: clusters this unit belongs to. */
  clusterIds: string[];
  clusterKind: "distributed" | "group" | null;
  capabilities: { distributedControl: boolean; lifecycle: boolean };
  /** De-duplicated; null = unknown. */
  servingCount: number | null;
  /** An operation is in flight. */
  busy: boolean;
}

export interface FleetRuntime {
  engine: string;
  port: number | null;
  endpoint: string | null;
  reachable: boolean | null;
  capabilities: AdapterCapabilities;
  error: string | null;
  /** Optional (beyond §4): requests in flight on this runtime; null = unknown. */
  requestsRunning?: number | null;
  /** Optional (beyond §4): raw server hint, e.g. why load/unload is unavailable. Not translated. */
  note?: string | null;
}

export interface FleetModel {
  /** Stable: "<engine>|<port|profile>|<modelId>" */
  modelKey: string;
  modelId: string;
  label: string;
  engine: string;
  port: number | null;
  state: ModelState;
  /** Evidence: "api", "ps", "catalog", "launcher", "mac-profile", "disk" */
  sources: string[];
  quantization: string | null;
  contextLength: number | null;
  sizeBytes: number | null;
  estMemoryBytes: number | null;
  launcherId: string | null;
  macRuntime: string | null;
  /** Cluster targetId when a member node shows a cluster model. */
  servedBy: string | null;
  actions: { start: boolean; stop: boolean; reload: boolean; switchTo: boolean };
  lastError: string | null;
  /** Optional (beyond §4): last confirmed state, shown only while the current state is unknown/unreachable. `at` null = time unknown. */
  lastSeen?: { state: ModelState; at: number | null } | null;
  /** Optional (beyond §4): the endpoint serving this model. */
  endpoint?: string | null;
  /** Optional (beyond §4), cluster rows on a member node: when the cluster's evidence was collected. */
  collectedAt?: number | null;
  /** Optional (beyond §4), cluster rows on a member node: the cluster's evidence is out of date. */
  stale?: boolean;
}

export interface FleetInventory {
  targetId: string;
  collectedAt: number;
  reachable: boolean | null;
  runtimes: FleetRuntime[];
  /** Owned by this target. */
  models: FleetModel[];
  /** Nodes only: served by a cluster this node belongs to (never counted twice). */
  clusterModels: FleetModel[];
  /** Per-source discovery failures, verbatim. */
  errors: string[];
  /** True when served from cache after a failed refresh. */
  stale: boolean;
}

export type FleetOperationAction = "start" | "stop" | "reload" | "switch";
export type FleetOperationStatus = "running" | "succeeded" | "failed" | "cancelled";
export type FleetOperationStepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface FleetOperationStep {
  id: string;
  label: string;
  status: FleetOperationStepStatus;
  detail: string | null;
}

export interface FleetOperation {
  id: string;
  targetId: string;
  action: FleetOperationAction;
  modelKey: string;
  fromModelKey: string | null;
  status: FleetOperationStatus;
  /** Current step id. */
  step: string;
  steps: FleetOperationStep[];
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}

export interface FleetCluster {
  /** Slug, persistent. */
  id: string;
  name: string;
  /** group = visual grouping only: no inference instance. */
  kind: "distributed" | "group";
  /** Registry unit ids, ≥ 2, unique. */
  memberIds: string[];
  /** ∈ memberIds; coordinator. */
  headId: string;
  /** Required for distributed; host null → head's llm host. */
  endpoint: { host: string | null; port: number } | null;
  engine: string | null;
  launcherId: string | null;
  notes: string;
}

export interface RouteEntry {
  model: string;
  targets: { targetId: string; endpoint: string; load: number | null }[];
}

// ─── Request / response envelopes ─────────────────────────

export interface FleetStatus {
  enabled: boolean;
  smartRoutingEnabled: boolean;
  adapters: AdapterInfo[];
}

export interface FleetTargetsResponse {
  targets: FleetTarget[];
  generatedAt: number;
}

export interface FleetOperationRequest {
  action: FleetOperationAction;
  modelKey: string;
  force?: boolean;
  rollback?: boolean;
}

export interface FleetLogLine {
  seq: number;
  text: string;
}

export interface FleetOperationRead {
  operation: FleetOperation;
  lines: FleetLogLine[];
  nextSeq: number;
}

export interface FleetLogs {
  source: "launcher" | "mac-agent" | "none";
  lines: FleetLogLine[];
  note?: string;
}

export interface FleetClustersResponse {
  clusters: FleetCluster[];
  suggestions: FleetCluster[];
}

/** POST body: a cluster without its id (the server derives a slug when it is omitted). */
export type FleetClusterInput = Omit<FleetCluster, "id"> & { id?: string };
