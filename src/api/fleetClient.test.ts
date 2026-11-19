import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelOperation,
  createCluster,
  deleteCluster,
  FleetApiError,
  getInventory,
  getLogs,
  getTargets,
  isBusyError,
  readOperation,
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
});
