import { describe, expect, it } from "vitest";
import type { FleetOperation, FleetTarget } from "../../api/fleetTypes";
import { makeSpark } from "../../testing/fixtures";
import { boardOrder, isTargetBusy, modelIdOf, modelsHref, nodeLive, operationFor, operationProgress, servingView, statusDotClass } from "./fleetBoardModel";

function target(over: Partial<FleetTarget> = {}): FleetTarget {
  return {
    targetId: "node:a",
    kind: "node",
    id: "a",
    name: "A",
    platform: "linux",
    hardware: { label: null, memoryTotalBytes: null, memoryKind: null },
    online: true,
    health: "ready",
    memberIds: [],
    headId: null,
    clusterIds: [],
    clusterKind: null,
    capabilities: { distributedControl: false, lifecycle: true },
    servingCount: null,
    busy: false,
    ...over,
  };
}

function op(over: Partial<FleetOperation> = {}): FleetOperation {
  return {
    id: "op1",
    targetId: "node:a",
    action: "switch",
    modelKey: "vllm|8000|org/model:tag",
    fromModelKey: null,
    status: "running",
    step: "b",
    steps: [
      { id: "a", label: "First", status: "done", detail: null },
      { id: "b", label: "Second", status: "running", detail: null },
      { id: "c", label: "Third", status: "pending", detail: null },
    ],
    startedAt: 0,
    finishedAt: null,
    error: null,
    ...over,
  };
}

describe("servingView", () => {
  it("reports the server's list, an explicit none, and an older server's count", () => {
    expect(servingView(target({ servingModels: ["m1", "m2"] }))).toEqual({ kind: "models", models: ["m1", "m2"] });
    expect(servingView(target({ servingModels: [] }))).toEqual({ kind: "none" });
    expect(servingView(target({ servingCount: 3 }))).toEqual({ kind: "count", count: 3 });
    expect(servingView(target({ servingCount: 0 }))).toEqual({ kind: "none" });
  });

  it("keeps unknown unknown, with the reason", () => {
    expect(servingView(target({ servingModels: null }))).toEqual({ kind: "unknown", reason: "noInventory" });
    expect(servingView(target())).toEqual({ kind: "unknown", reason: "notReported" });
    expect(servingView(target({ online: false, servingModels: ["stale"] }))).toEqual({ kind: "unknown", reason: "unreachable" });
    expect(servingView(target({ health: "unreachable", servingModels: ["stale"] }))).toEqual({ kind: "unknown", reason: "unreachable" });
    expect(servingView(target({ kind: "cluster", clusterKind: "group", servingModels: null }))).toEqual({ kind: "unknown", reason: "group" });
  });
});

describe("row helpers", () => {
  it("never shows an unknown health as healthy", () => {
    expect(statusDotClass(target())).toBe("sdot");
    expect(statusDotClass(target({ health: "unknown" }))).toBe("sdot sdot--warn");
    expect(statusDotClass(target({ health: "unknown", online: false }))).toBe("sdot sdot--off");
    expect(statusDotClass(target({ health: "unreachable" }))).toBe("sdot sdot--off");
  });

  it("orders nodes before clusters and builds encoded Models links", () => {
    const c = target({ targetId: "cluster:c", kind: "cluster" });
    const n = target();
    expect(boardOrder([c, n]).map((x) => x.targetId)).toEqual(["node:a", "cluster:c"]);
    expect(modelsHref("node:a b")).toBe("/models?target=node%3Aa%20b");
    expect(modelsHref(null)).toBe("/models");
  });

  it("finds the running operation and its step", () => {
    expect(isTargetBusy(target({ activeOperationId: "op1" }))).toBe(true);
    expect(isTargetBusy(target({ busy: true }))).toBe(true);
    expect(isTargetBusy(target())).toBe(false);
    // A cluster locked by a member's operation finds it by id.
    expect(operationFor(target({ targetId: "cluster:c", activeOperationId: "op1" }), [op()])?.id).toBe("op1");
    expect(operationFor(target(), [op({ status: "succeeded" })])).toBeNull();
    expect(operationProgress(op())).toEqual({ step: 2, total: 3, label: "Second" });
    expect(operationProgress(op({ steps: [] }))).toBeNull();
    expect(modelIdOf("vllm|8000|org/model:tag")).toBe("org/model:tag");
    expect(modelIdOf("plain")).toBe("plain");
  });
});

describe("nodeLive", () => {
  it("reads tok/s, memory and temperature from the snapshot", () => {
    const spark = makeSpark("a");
    spark.metrics.llm = [{ ...(spark.metrics.llm?.[0] ?? {}), available: true, generationTps: 12.34, measurementValid: true } as never];
    const live = nodeLive(spark)!;
    expect(live.online).toBe(true);
    expect(live.tps).toBeCloseTo(12.34);
  });

  it("keeps unavailable readings null, never 0", () => {
    const spark = makeSpark("a");
    spark.metrics.llm = [{ ...(spark.metrics.llm?.[0] ?? {}), available: true, generationTps: 0, measurementValid: false } as never];
    spark.metrics.gpu = { ...spark.metrics.gpu!, temperature: 0, metricAvailability: { temperature: false } } as never;
    const live = nodeLive(spark)!;
    expect(live.tps).toBeNull();
    expect(live.tpsUnmeasured).toBe(true);
    expect(live.gpuTempC).toBeNull();
    expect(nodeLive(makeSpark("off", false))).toEqual({ online: false, tps: null, tpsUnmeasured: false, memory: null, gpuTempC: null });
    expect(nodeLive(null)).toBeNull();
  });
});
