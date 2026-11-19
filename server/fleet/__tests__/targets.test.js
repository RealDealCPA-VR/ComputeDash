import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTargets, countServing, parseTargetId, suggestClusters } from "../targets.js";

const served = (targetId, rows, extra = {}) => ({
  targetId,
  reachable: true,
  stale: false,
  runtimes: [],
  models: rows.map(([modelId, port, state = "serving", endpoint = null]) => ({ modelId, port, state, endpoint })),
  clusterModels: [],
  errors: [],
  ...extra,
});

const GB = 1024 ** 3;
const units = [
  { id: "spark1", name: "Spark 1", kind: "spark", platform: "linux", role: "head", llmPorts: [8000], lanIp: "10.0.0.1" },
  { id: "spark2", name: "Spark 2", kind: "spark", platform: "linux", role: "worker", workerHeadId: "spark1", llmPorts: [8000], lanIp: "10.0.0.2" },
  { id: "dell", name: "Dell", kind: "host", platform: "windows", role: "standalone", llmPorts: [11434], isLocal: true },
  { id: "mac", name: "Mac Studio", kind: "mac", platform: "darwin", role: "standalone", llmPorts: [8080] },
];

const llm = (port, backend, models, available = true) => ({ port, backend, models, modelId: models[0] ?? null, available });
const snapshots = new Map([
  [
    "spark1",
    {
      online: true,
      hardware: { device: "NVIDIA DGX Spark", gpuChip: "GB10", totalMemoryGB: 128 },
      metrics: { unifiedMemory: { total: 124000 }, llm: [llm(8000, "vllm", ["Qwen/Qwen3-235B"]), llm(8001, "llama.cpp", ["small"])] },
    },
  ],
  ["spark2", { online: true, hardware: { device: "NVIDIA DGX Spark", gpuChip: "GB10", totalMemoryGB: 128 }, metrics: { unifiedMemory: { total: 0 }, llm: [] } }],
  // Windows host before GPU detection: memory unknown.
  ["dell", { online: true, hardware: { device: "Windows GPU host", gpuChip: null, totalMemoryGB: null }, metrics: { gpu: null, llm: [llm(11434, "ollama", ["llama3:8b", "phi3"])] } }],
  ["mac", { online: false, hardware: { device: "Apple Silicon Mac", totalMemoryGB: null }, metrics: { unifiedMemory: null, llm: [] } }],
]);
const clusters = [
  { id: "sparks", name: "Spark cluster", kind: "distributed", memberIds: ["spark1", "spark2"], headId: "spark1", endpoint: { host: null, port: 8000 }, engine: "vllm", launcherId: "ray-abc123", notes: "" },
  { id: "desk", name: "Desk", kind: "group", memberIds: ["dell", "mac"], headId: "dell", endpoint: null, engine: null, launcherId: null, notes: "" },
];

test("nodes first in registry order, then clusters", () => {
  const t = buildTargets({ units, clusters, snapshots, busyTargetIds: new Set(["node:dell", "cluster:sparks"]) });
  assert.deepEqual(t.map((x) => x.targetId), ["node:spark1", "node:spark2", "node:dell", "node:mac", "cluster:sparks", "cluster:desk"]);
  assert.equal(t.find((x) => x.id === "dell").busy, true);
  assert.equal(t.find((x) => x.id === "spark1").busy, false);
  assert.equal(t.find((x) => x.targetId === "cluster:sparks").busy, true);
});

test("unknown memory stays null, never 0", () => {
  const t = buildTargets({ units, clusters, snapshots });
  const dell = t.find((x) => x.id === "dell");
  assert.equal(dell.hardware.memoryTotalBytes, null);
  assert.equal(dell.hardware.memoryKind, null);
  const mac = t.find((x) => x.id === "mac");
  assert.equal(mac.hardware.memoryTotalBytes, null);
  // unifiedMemory.total 0 is "not read yet": fall back to the hardware summary.
  const spark2 = t.find((x) => x.id === "spark2");
  assert.equal(spark2.hardware.memoryTotalBytes, 128 * GB);
  assert.equal(spark2.hardware.memoryKind, "unified");
  const spark1 = t.find((x) => x.id === "spark1");
  assert.equal(spark1.hardware.memoryTotalBytes, 124000 * 1024 * 1024);
  assert.equal(spark1.hardware.label, "NVIDIA DGX Spark (GB10)");
  // A unit with no snapshot at all.
  const [lone] = buildTargets({ units: [{ id: "x", name: "X", kind: "host", platform: "linux" }] });
  assert.equal(lone.online, null);
  assert.equal(lone.health, "unknown");
  assert.equal(lone.hardware.memoryTotalBytes, null);
  assert.equal(lone.servingCount, null);
});

test("host VRAM is reported as vram", () => {
  const snaps = new Map([["dell", { online: true, hardware: { device: "Windows GPU host", gpuChip: "RTX 6000 Ada" }, metrics: { gpu: { vram: { total: 49140 } }, llm: [] } }]]);
  const [dell] = buildTargets({ units: [units[2]], snapshots: snaps });
  assert.equal(dell.hardware.memoryKind, "vram");
  assert.equal(dell.hardware.memoryTotalBytes, 49140 * 1024 * 1024);
});

test("servingCount comes only from inventories, never from the monitor's /v1/models list", () => {
  // Without inventories every count is unknown, even though the monitor lists Ollama's catalog.
  for (const x of buildTargets({ units, clusters, snapshots })) assert.equal(x.servingCount, null, x.targetId);
  const inventories = new Map([
    ["node:dell", served("node:dell", [["llama3:8b", 11434], ["phi3", 11434, "installed"]])],
    ["node:spark1", served("node:spark1", [["small", 8001]])],
    ["cluster:sparks", served("cluster:sparks", [["Qwen/Qwen3-235B", 8000]])],
    ["node:mac", served("node:mac", [["x", 8080]])],
    ["node:spark2", served("node:spark2", [["y", 8000]], { stale: true })],
  ]);
  const by = Object.fromEntries(buildTargets({ units, clusters, snapshots, inventories }).map((x) => [x.targetId, x]));
  assert.equal(by["node:dell"].servingCount, 1, "installed-only models are not serving");
  assert.equal(by["node:spark1"].servingCount, 1);
  assert.equal(by["cluster:sparks"].servingCount, 1);
  assert.equal(by["node:mac"].servingCount, null, "offline → unknown");
  assert.equal(by["node:spark2"].servingCount, null, "stale inventory → unknown");
  assert.equal(by["cluster:desk"].servingCount, null, "a group has no instance of its own");
});

test("countServing de-duplicates on normalized runtime endpoint + model id", () => {
  const a = served("cluster:sparks", [["Q", 8000, "serving", "http://Spark1.tail.ts.net:8000/"]]);
  const b = served("node:other", [["Q", 8000, "serving", "http://spark1.tail.ts.net:8000"], ["R", 9000, "loaded", "http://x:9000"]]);
  assert.equal(countServing([a, b]), 1);
  // Without an endpoint, the runtime on that port supplies it.
  const c = { ...served("node:z", [["Q", 8000]]), runtimes: [{ port: 8000, endpoint: "http://spark1.tail.ts.net:8000" }] };
  assert.equal(countServing([a, c]), 1);
  assert.equal(countServing([served("node:p", [["Q", 8000]]), served("node:q", [["Q", 8000]])]), 2, "different targets, unknown endpoints");
});

test("the head's endpoint port belongs to the cluster whatever spelling the endpoint host uses", () => {
  const u = [
    { ...units[0], llmHost: "100.64.0.1" },
    units[1],
  ];
  const c = [{ ...clusters[0], endpoint: { host: "spark1.tail.ts.net", port: 8000 } }];
  const [head] = buildTargets({ units: u, clusters: c, snapshots });
  assert.equal(head.clusterKind, "distributed");
});

test("health, online, cluster membership and serving counts", () => {
  const inventories = new Map([
    ["node:dell", served("node:dell", [["llama3:8b", 11434], ["phi3", 11434]])],
    ["node:spark1", served("node:spark1", [["small", 8001]])],
    ["cluster:sparks", served("cluster:sparks", [["Qwen/Qwen3-235B", 8000]])],
  ]);
  const t = buildTargets({ units, clusters, snapshots, inventories });
  const by = Object.fromEntries(t.map((x) => [x.targetId, x]));
  assert.equal(by["node:mac"].online, false);
  assert.equal(by["node:mac"].health, "unreachable");
  assert.equal(by["node:mac"].servingCount, null);
  assert.equal(by["node:dell"].health, "ready");
  assert.equal(by["node:dell"].servingCount, 2);
  assert.equal(by["node:dell"].platform, "windows");
  assert.equal(by["node:dell"].capabilities.lifecycle, true, "Ollama loads over HTTP even from Windows (from the adapter registry)");
  const lms = buildTargets({ units: [units[2]], snapshots: new Map([["dell", { online: true, metrics: { llm: [llm(1234, "lmstudio", ["a"])] } }]]) });
  assert.equal(lms[0].capabilities.lifecycle, false, "LM Studio needs a shell, which a Windows unit lacks");
  assert.equal(by["node:spark1"].servingCount, 1);
  assert.deepEqual(by["node:spark1"].clusterIds, ["sparks"]);
  assert.equal(by["node:spark1"].clusterKind, "distributed");
  assert.equal(by["node:dell"].clusterKind, "group");
  const sc = by["cluster:sparks"];
  assert.equal(sc.servingCount, 1);
  assert.deepEqual(sc.memberIds, ["spark1", "spark2"]);
  assert.equal(sc.headId, "spark1");
  assert.equal(sc.health, "ready");
  assert.equal(sc.online, true);
  assert.deepEqual(sc.capabilities, { distributedControl: true, lifecycle: true });
  assert.equal(sc.hardware.memoryTotalBytes, 124000 * 1024 * 1024 + 128 * GB);
  assert.equal(sc.hardware.memoryKind, "unified");
  const desk = by["cluster:desk"];
  assert.equal(desk.health, "degraded");
  assert.equal(desk.online, null);
  assert.equal(desk.hardware.memoryTotalBytes, null, "a group is not pooled capacity");
  assert.deepEqual(desk.capabilities, { distributedControl: false, lifecycle: false });
  assert.equal(desk.servingCount, null);
  // Every target carries the full FleetTarget shape.
  for (const x of t) {
    for (const k of ["targetId", "kind", "id", "name", "platform", "hardware", "online", "health", "memberIds", "headId", "clusterIds", "clusterKind", "capabilities", "servingCount", "busy"]) {
      assert.ok(k in x, `${x.targetId} has ${k}`);
    }
  }
});

test("a distributed cluster with an offline worker is degraded; with the head offline, unreachable", () => {
  const s = new Map(snapshots);
  s.set("spark2", { ...snapshots.get("spark2"), online: false });
  let sc = buildTargets({ units, clusters, snapshots: s }).find((x) => x.targetId === "cluster:sparks");
  assert.equal(sc.health, "degraded");
  assert.equal(sc.online, false);
  s.set("spark1", { ...snapshots.get("spark1"), online: false });
  sc = buildTargets({ units, clusters, snapshots: s }).find((x) => x.targetId === "cluster:sparks");
  assert.equal(sc.health, "unreachable");
  assert.equal(sc.servingCount, null);
});

test("target ids parse", () => {
  assert.deepEqual(parseTargetId("node:spark1"), { kind: "node", id: "spark1" });
  assert.deepEqual(parseTargetId("cluster:sparks"), { kind: "cluster", id: "sparks" });
  assert.equal(parseTargetId("spark1"), null);
  assert.equal(parseTargetId(null), null);
});

test("suggestClusters offers head + workers, skipping heads already clustered", () => {
  const s = suggestClusters(units);
  assert.equal(s.length, 1);
  assert.deepEqual(s[0].memberIds, ["spark1", "spark2"]);
  assert.equal(s[0].headId, "spark1");
  assert.equal(s[0].kind, "distributed");
  assert.deepEqual(s[0].endpoint, { host: null, port: 8000 });
  assert.equal(s[0].id, "spark1-cluster");
  assert.deepEqual(suggestClusters(units, clusters), []);
  // A head with no workers pointing at it is not a cluster.
  assert.deepEqual(suggestClusters([{ id: "h", role: "head", llmPorts: [8000] }]), []);
});

test("servingCount is null when any identified runtime failed (a partial count is only a lower bound)", () => {
  const inv = (runtimes) => ({ ...served("node:dell", [["llama3:8b", 11434]]), runtimes });
  const count = (runtimes) =>
    buildTargets({ units: [units[2]], snapshots, inventories: new Map([["node:dell", inv(runtimes)]]) })[0].servingCount;
  assert.equal(count([{ engine: "ollama", port: 11434, reachable: true, error: null }]), 1);
  assert.equal(count([{ engine: "ollama", port: 11434, reachable: true, error: null }, { engine: "vllm", port: 8000, reachable: false, error: "timed out" }]), null);
  assert.equal(count([{ engine: "ollama", port: 11434, reachable: true, error: "GET /api/ps: HTTP 500" }]), null);
  assert.equal(count([{ engine: "launch-profile", port: null, reachable: null, error: "status unknown" }]), null);
  // A configured port where nothing was identified is not a failed source.
  assert.equal(count([{ engine: "unknown", port: 9000, reachable: false, error: "no engine answered on port 9000" }]), 1);
});

test("servingModels lists the de-duplicated serving modelIds alphabetically, null exactly when servingCount is", () => {
  const inventories = new Map([
    [
      "node:dell",
      served("node:dell", [
        ["phi3", 11434, "serving", "http://10.0.0.9:11434"],
        ["Llama3:8b", 11434, "serving", "http://10.0.0.9:11434/"],
        ["llama3:8b", 11434, "serving", "HTTP://10.0.0.9:11434"], // same endpoint after normalizing; model ids are case-sensitive
        ["phi3", 11434, "serving", "http://10.0.0.9:11434/"], // duplicate of the first row
        ["gemma", 11434, "installed", "http://10.0.0.9:11434"],
      ]),
    ],
    ["node:spark1", served("node:spark1", [["small", 8001, "loaded"]])],
    ["node:spark2", served("node:spark2", [["y", 8000]], { stale: true })],
    ["cluster:sparks", served("cluster:sparks", [["Qwen/Qwen3-235B", 8000]])],
  ]);
  const by = Object.fromEntries(buildTargets({ units, clusters, snapshots, inventories }).map((x) => [x.targetId, x]));
  assert.deepEqual(by["node:dell"].servingModels, ["Llama3:8b", "llama3:8b", "phi3"].sort((a, b) => a.localeCompare(b)));
  assert.equal(by["node:dell"].servingCount, by["node:dell"].servingModels.length, "same source, same de-duplication");
  assert.deepEqual(by["node:spark1"].servingModels, [], "known, nothing serving");
  assert.equal(by["node:spark1"].servingCount, 0);
  assert.equal(by["node:spark2"].servingModels, null, "stale → unknown");
  assert.equal(by["node:mac"].servingModels, null, "offline / no inventory → unknown");
  assert.deepEqual(by["cluster:sparks"].servingModels, ["Qwen/Qwen3-235B"]);
  assert.equal(by["cluster:desk"].servingModels, null, "a group has no instance of its own");
  for (const x of Object.values(by)) assert.equal(x.servingModels === null, x.servingCount === null, x.targetId);
  // A failed runtime makes both unknown.
  const failed = new Map([
    ["node:dell", served("node:dell", [["phi3", 11434]], { runtimes: [{ engine: "ollama", port: 11434, reachable: false, error: "down" }] })],
  ]);
  const dell = buildTargets({ units, clusters, snapshots, inventories: failed }).find((x) => x.id === "dell");
  assert.equal(dell.servingCount, null);
  assert.equal(dell.servingModels, null);
});

test("activeOperationId: a node shows its own or its cluster's operation; a cluster also a member's", () => {
  const locks = (entries) => ({ busyTargetIds: new Set(entries.map(([k]) => k)), activeOperations: new Map(entries) });
  // A cluster operation locks the cluster and its members.
  let t = buildTargets({ units, clusters, snapshots, ...locks([["cluster:sparks", "op-c"], ["node:spark1", "op-c"], ["node:spark2", "op-c"]]) });
  let by = Object.fromEntries(t.map((x) => [x.targetId, x]));
  assert.equal(by["cluster:sparks"].activeOperationId, "op-c");
  assert.equal(by["node:spark1"].activeOperationId, "op-c");
  assert.equal(by["node:spark2"].activeOperationId, "op-c");
  assert.equal(by["node:dell"].activeOperationId, null);
  assert.equal(by["cluster:desk"].activeOperationId, null);
  // A node operation shows on every cluster containing the node, which it blocks.
  t = buildTargets({ units, clusters, snapshots, ...locks([["node:mac", "op-n"]]) });
  by = Object.fromEntries(t.map((x) => [x.targetId, x]));
  assert.equal(by["node:mac"].activeOperationId, "op-n");
  assert.equal(by["cluster:desk"].activeOperationId, "op-n");
  assert.equal(by["cluster:desk"].busy, true);
  assert.equal(by["cluster:sparks"].activeOperationId, null);
  assert.equal(by["cluster:sparks"].busy, false);
  for (const x of t) assert.equal(x.busy, x.activeOperationId !== null, x.targetId);
  // Without operations every id is null.
  for (const x of buildTargets({ units, clusters, snapshots })) assert.equal(x.activeOperationId, null);
});
