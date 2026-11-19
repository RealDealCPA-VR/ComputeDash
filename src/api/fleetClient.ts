/**
 * API client for the Fleet Model Manager (/api/fleet/*, plan §4).
 * Mirrors apiKeysClient.ts: a small local apiFetch so importing this never pulls in client.ts.
 */
import { authHeaders, reportAuthRequired } from "./authToken";
import type {
  FleetCancelResult,
  FleetCluster,
  FleetClusterInput,
  FleetClustersResponse,
  FleetInventory,
  FleetLogs,
  FleetOperation,
  FleetOperationRead,
  FleetOperationsList,
  FleetOperationRequest,
  FleetStatus,
  FleetTargetsResponse,
  RouteResolution,
  RoutedModelsList,
  RoutingView,
} from "./fleetTypes";

/** A failed fleet API call. `message` is the server's text; `code` is its machine-readable reason, when given. */
export class FleetApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "FleetApiError";
    this.status = status;
    this.code = code;
  }
}

/** 409: another operation is already running on the target (or a member node). */
export function isBusyError(err: unknown): boolean {
  return err instanceof FleetApiError && err.status === 409;
}

/** 403 with code "token_required": control is refused until the dashboard has an access token. */
export function isTokenRequiredError(err: unknown): boolean {
  return err instanceof FleetApiError && err.status === 403 && err.code === "token_required";
}

const enc = encodeURIComponent;

export function getFleetStatus(): Promise<FleetStatus> {
  return apiFetch("/api/fleet/status");
}

export function getTargets(): Promise<FleetTargetsResponse> {
  return apiFetch("/api/fleet/targets");
}

/** `refresh` asks the server for fresh discovery instead of its cached inventory. */
export function getInventory(targetId: string, refresh = false): Promise<FleetInventory> {
  return apiFetch(`/api/fleet/targets/${enc(targetId)}/inventory${refresh ? "?refresh=1" : ""}`);
}

export function startOperation(targetId: string, body: FleetOperationRequest): Promise<{ operation: FleetOperation }> {
  return apiFetch(`/api/fleet/targets/${enc(targetId)}/operations`, { method: "POST", body: JSON.stringify(body) });
}

/** Log lines with seq ≥ `since` (all lines when omitted). */
export function readOperation(opId: string, since?: number): Promise<FleetOperationRead> {
  const query = since != null && Number.isFinite(since) ? `?since=${enc(String(since))}` : "";
  return apiFetch(`/api/fleet/operations/${enc(opId)}${query}`);
}

/** Operations still running (and, unless activeOnly, those finished in the last few minutes), newest first. */
export function listOperations(activeOnly = true): Promise<FleetOperationsList> {
  return apiFetch(`/api/fleet/operations${activeOnly ? "?active=1" : ""}`);
}

export function cancelOperation(opId: string): Promise<FleetCancelResult> {
  return apiFetch(`/api/fleet/operations/${enc(opId)}`, { method: "DELETE" });
}

export function getLogs(targetId: string, modelKey?: string | null): Promise<FleetLogs> {
  const query = modelKey ? `?modelKey=${enc(modelKey)}` : "";
  return apiFetch(`/api/fleet/targets/${enc(targetId)}/logs${query}`);
}

export function listClusters(): Promise<FleetClustersResponse> {
  return apiFetch("/api/fleet/clusters");
}

export function createCluster(input: FleetClusterInput): Promise<{ cluster: FleetCluster }> {
  return apiFetch("/api/fleet/clusters", { method: "POST", body: JSON.stringify(input) });
}

export function updateCluster(id: string, patch: Partial<FleetClusterInput>): Promise<{ cluster: FleetCluster }> {
  return apiFetch(`/api/fleet/clusters/${enc(id)}`, { method: "PUT", body: JSON.stringify(patch) });
}

export function deleteCluster(id: string): Promise<{ removed: true }> {
  return apiFetch(`/api/fleet/clusters/${enc(id)}`, { method: "DELETE" });
}

// ─── Smart routing (P1): read-only views; routing never starts, stops or switches a model ───

/** 404 with code "routing_disabled": smart routing is switched off in Settings. */
export function isRoutingDisabledError(err: unknown): boolean {
  return err instanceof FleetApiError && err.status === 404 && err.code === "routing_disabled";
}

export function getRouting(): Promise<RoutingView> {
  return apiFetch("/api/fleet/routing");
}

/** Which target a request for `model` would go to right now (dry run). */
export function resolveRoute(model: string): Promise<RouteResolution> {
  return apiFetch("/api/fleet/routing/resolve", { method: "POST", body: JSON.stringify({ model }) });
}

/** The models the routing proxy can serve, in OpenAI list format. */
export function listRoutedModels(): Promise<RoutedModelsList> {
  return apiFetch("/api/fleet/v1/models");
}

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts?.body) headers["Content-Type"] = "application/json";
  const res = await fetch(path, { ...opts, headers: { ...headers, ...authHeaders() } });
  if (!res.ok) {
    if (res.status === 401) reportAuthRequired();
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new FleetApiError(
      typeof body?.error === "string" && body.error ? body.error : `HTTP ${res.status}`,
      res.status,
      typeof body?.code === "string" ? body.code : undefined
    );
  }
  return res.json();
}
