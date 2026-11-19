import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelOperation,
  createCluster,
  deleteCluster,
  FleetApiError,
  getInventory,
  getLogs,
  getTargets,
  getRouting,
  isBusyError,
  isRoutingDisabledError,
  isTokenRequiredError,
  listRoutedModels,
  readOperation,
  resolveRoute,
  startOperation,
  updateCluster,
} from "./fleetClient";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

const lastCall = () => fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit | undefined];

describe("fleetClient", () => {
  it("URL-encodes target ids (they contain ':') and passes refresh / since / modelKey", async () => {
    await getInventory("node:spark 1");
    expect(lastCall()[0]).toBe("/api/fleet/targets/node%3Aspark%201/inventory");
    await getInventory("cluster:duo", true);
    expect(lastCall()[0]).toBe("/api/fleet/targets/cluster%3Aduo/inventory?refresh=1");
    await readOperation("op/1", 7);
    expect(lastCall()[0]).toBe("/api/fleet/operations/op%2F1?since=7");
    await readOperation("op1");
    expect(lastCall()[0]).toBe("/api/fleet/operations/op1");
    await getLogs("node:mac", "vllm|8000|org/model");
    expect(lastCall()[0]).toBe("/api/fleet/targets/node%3Amac/logs?modelKey=vllm%7C8000%7Corg%2Fmodel");
    await getLogs("node:mac", null);
    expect(lastCall()[0]).toBe("/api/fleet/targets/node%3Amac/logs");
    await getTargets();
    expect(lastCall()[0]).toBe("/api/fleet/targets");
  });

  it("sends JSON bodies with the right methods", async () => {
    await startOperation("node:a", { action: "switch", modelKey: "k", force: false, rollback: true });
    expect(lastCall()[0]).toBe("/api/fleet/targets/node%3Aa/operations");
    expect(lastCall()[1]?.method).toBe("POST");
    expect(JSON.parse(String(lastCall()[1]?.body))).toEqual({ action: "switch", modelKey: "k", force: false, rollback: true });
    expect((lastCall()[1]?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    await cancelOperation("op1");
    expect(lastCall()[1]?.method).toBe("DELETE");
    await createCluster({ name: "x", kind: "group", memberIds: ["a", "b"], headId: "a", endpoint: null, engine: null, launcherId: null, notes: "" });
    expect(lastCall()[1]?.method).toBe("POST");
    await updateCluster("my id", { name: "y" });
    expect(lastCall()[0]).toBe("/api/fleet/clusters/my%20id");
    expect(lastCall()[1]?.method).toBe("PUT");
    await deleteCluster("x");
    expect(lastCall()[1]?.method).toBe("DELETE");
  });

  it("raises FleetApiError with status and code; 409 is busy", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "target busy", code: "busy" }), { status: 409 }));
    const err = await startOperation("node:a", { action: "start", modelKey: "k" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FleetApiError);
    expect((err as FleetApiError).message).toBe("target busy");
    expect((err as FleetApiError).status).toBe(409);
    expect((err as FleetApiError).code).toBe("busy");
    expect(isBusyError(err)).toBe(true);
    expect(isBusyError(new FleetApiError("x", 400))).toBe(false);
    expect(isBusyError(new Error("x"))).toBe(false);
  });

  it("reads the routing view and the routed model list with GET", async () => {
    const view = { enabled: true, policy: "least-loaded", table: [{ model: "m", targets: [{ targetId: "node:a", endpoint: "http://a:8000", load: null }] }] };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(view), { status: 200 }));
    await expect(getRouting()).resolves.toEqual(view);
    expect(lastCall()[0]).toBe("/api/fleet/routing");
    expect(lastCall()[1]?.method).toBeUndefined();
    const list = { object: "list", data: [{ id: "m", object: "model", owned_by: "sparkdash-fleet" }] };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(list), { status: 200 }));
    await expect(listRoutedModels()).resolves.toEqual(list);
    expect(lastCall()[0]).toBe("/api/fleet/v1/models");
  });

  it("resolves a model with a JSON POST", async () => {
    const res = { target: { targetId: "node:a" }, targetId: "node:a", endpoint: "http://a:8000", model: "M", policy: "round-robin", load: 2, reason: "exact match" };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(res), { status: 200 }));
    await expect(resolveRoute("M")).resolves.toEqual(res);
    expect(lastCall()[0]).toBe("/api/fleet/routing/resolve");
    expect(lastCall()[1]?.method).toBe("POST");
    expect(JSON.parse(String(lastCall()[1]?.body))).toEqual({ model: "M" });
    expect((lastCall()[1]?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("recognises routing_disabled 404s", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Smart routing is disabled", code: "routing_disabled" }), { status: 404 }));
    const err = await resolveRoute("m").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FleetApiError);
    expect(isRoutingDisabledError(err)).toBe(true);
    expect(isRoutingDisabledError(new FleetApiError("x", 404, "fleet_disabled"))).toBe(false);
    expect(isRoutingDisabledError(new FleetApiError("x", 400, "routing_disabled"))).toBe(false);
    expect(isRoutingDisabledError(new Error("x"))).toBe(false);
  });

  it("recognises token_required 403s and returns a refused cancel's reason", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Model control needs an access token", code: "token_required" }), { status: 403 }));
    const err = await startOperation("node:a", { action: "start", modelKey: "k" }).catch((e: unknown) => e);
    expect(isTokenRequiredError(err)).toBe(true);
    expect((err as FleetApiError).message).toBe("Model control needs an access token");
    expect(isTokenRequiredError(new FleetApiError("x", 403, "forbidden"))).toBe(false);
    expect(isTokenRequiredError(new FleetApiError("x", 401, "token_required"))).toBe(false);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ cancelled: false, reason: "past the readiness wait" }), { status: 200 }));
    await expect(cancelOperation("op1")).resolves.toEqual({ cancelled: false, reason: "past the readiness wait" });
  });
});
