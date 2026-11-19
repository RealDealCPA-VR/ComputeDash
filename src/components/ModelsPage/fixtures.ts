/** Test fixtures for the Models page (contract shapes from plan §4). Imported only by tests. */
import type { AdapterCapabilities, FleetInventory, FleetModel, FleetOperation, FleetTarget, ModelState } from "../../api/fleetTypes";

export const CAPS: AdapterCapabilities = { discover: true, start: true, stop: true, load: true, unload: true, logs: true, multiModel: false };

export function makeTarget(over: Partial<FleetTarget> & Pick<FleetTarget, "targetId" | "name">): FleetTarget {
  const kind = over.kind ?? (over.targetId.startsWith("cluster:") ? "cluster" : "node");
  return {
    kind,
    id: over.targetId.split(":")[1],
    platform: kind === "node" ? "linux" : null,
    hardware: { label: null, memoryTotalBytes: 128 * 1024 ** 3, memoryKind: "unified" },
    online: true,
    health: "ready",
    memberIds: [],
    headId: null,
    clusterIds: [],
    clusterKind: null,
    capabilities: { distributedControl: false, lifecycle: true },
    servingCount: 1,
    busy: false,
    ...over,
  };
}

export function makeModel(modelId: string, state: ModelState, over: Partial<FleetModel> = {}): FleetModel {
  return {
    modelKey: `vllm|8000|${modelId}`,
    modelId,
    label: modelId,
    engine: "vllm",
    port: 8000,
    state,
    sources: ["api"],
    quantization: null,
    contextLength: null,
    sizeBytes: null,
    estMemoryBytes: null,
    launcherId: null,
    macRuntime: null,
    servedBy: null,
    actions: { start: false, stop: false, reload: false, switchTo: false },
    lastError: null,
    ...over,
  };
}

export const SPARK1 = makeTarget({ targetId: "node:spark1", name: "Spark 1", clusterIds: ["duo"], hardware: { label: "GB10", memoryTotalBytes: 128 * 1024 ** 3, memoryKind: "unified" } });
export const SPARK2 = makeTarget({ targetId: "node:spark2", name: "Spark 2", health: "degraded", busy: true, clusterIds: ["duo"], servingCount: null });
export const MAC = makeTarget({ targetId: "node:mac", name: "Mac Studio", platform: "darwin", health: "unknown", hardware: { label: null, memoryTotalBytes: null, memoryKind: null } });
export const DUO = makeTarget({
  targetId: "cluster:duo",
  name: "Spark Duo",
  kind: "cluster",
  clusterKind: "distributed",
  memberIds: ["spark1", "spark2"],
  headId: "spark1",
  capabilities: { distributedControl: true, lifecycle: true },
});
export const DESK = makeTarget({ targetId: "cluster:desk", name: "Desk group", kind: "cluster", clusterKind: "group", memberIds: ["spark1", "mac"], headId: "spark1", servingCount: 0 });

export const SERVING = makeModel("qwen3-32b", "serving", {
  quantization: "fp8",
  contextLength: 131072,
  estMemoryBytes: 40 * 1024 ** 3,
  actions: { start: false, stop: true, reload: true, switchTo: false },
});
export const BIG = makeModel("llama-405b", "installed", {
  estMemoryBytes: 200 * 1024 ** 3,
  actions: { start: true, stop: false, reload: false, switchTo: true },
});
export const SMALL = makeModel("gemma-4b", "configured", {
  estMemoryBytes: null,
  actions: { start: true, stop: false, reload: false, switchTo: true },
});

export function makeInventory(over: Partial<FleetInventory> = {}): FleetInventory {
  return {
    targetId: "node:spark1",
    collectedAt: Date.UTC(2026, 10, 18, 12, 0, 0),
    reachable: true,
    runtimes: [
      { engine: "vllm", port: 8000, endpoint: "http://spark1:8000", reachable: true, capabilities: CAPS, error: null },
      { engine: "ollama", port: 11434, endpoint: null, reachable: null, capabilities: { ...CAPS, multiModel: true }, error: "probe timed out" },
    ],
    models: [
      SERVING,
      BIG,
      SMALL,
      makeModel("m-loaded", "loaded"),
      makeModel("m-starting", "starting"),
      makeModel("m-stopping", "stopping"),
      makeModel("m-stopped", "stopped"),
      makeModel("m-failed", "failed", { lastError: "CUDA out of memory <raw>" }),
      makeModel("m-unknown", "unknown"),
      makeModel("m-unreachable", "unreachable"),
    ],
    clusterModels: [makeModel("deepseek-v3", "serving", { modelKey: "vllm|9000|deepseek-v3", port: 9000, servedBy: "cluster:duo" })],
    errors: [],
    stale: false,
    ...over,
  };
}

export function makeOperation(over: Partial<FleetOperation> = {}): FleetOperation {
  return {
    id: "op-1",
    targetId: "node:spark1",
    action: "start",
    modelKey: BIG.modelKey,
    fromModelKey: null,
    status: "running",
    step: "start",
    steps: [
      { id: "reach", label: "Confirm target reachable", status: "done", detail: null },
      { id: "start", label: "Start model", status: "running", detail: null },
    ],
    startedAt: Date.UTC(2026, 10, 18, 12, 0, 0),
    finishedAt: null,
    error: null,
    ...over,
  };
}
