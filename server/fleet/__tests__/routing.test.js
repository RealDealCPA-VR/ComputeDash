import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRouteTable,
  createRoundRobinState,
  matchModel,
  normalizePolicy,
  pickTarget,
  rankTargets,
  DEFAULT_ROUTING_POLICY,
  isLoopbackEndpoint,
} from "../routing.js";

const NOW = 1_000_000;

const rt = (port, endpoint, extra = {}) => ({
  engine: "vllm",
  port,
  endpoint,
  reachable: true,
  capabilities: {},
  error: null,
  requestsRunning: null,
  ...extra,
});
const model = (modelId, port, state = "serving", extra = {}) => ({
  modelKey: `vllm|${port}|${modelId}`,
  modelId,
  label: modelId,
  engine: "vllm",
  port,
  state,
  sources: ["api"],
  servedBy: null,
  ...extra,
});
const inv = (targetId, runtimes, models, extra = {}) => ({
  targetId,
  collectedAt: NOW - 1000,
  reachable: true,
  runtimes,
  models,
  clusterModels: [],
  errors: [],
  stale: false,
  ...extra,
});
const target = (targetId, extra = {}) => ({
  targetId,
  kind: targetId.startsWith("cluster:") ? "cluster" : "node",
  id: targetId.split(":")[1],
  name: targetId,
  online: true,
  health: "ready",
  ...extra,
});

test("builds one entry per model with endpoint and load from the serving runtime", () => {
  const inventories = [
    inv("node:a", [rt(8000, "http://10.0.0.1:8000", { requestsRunning: 3 })], [model("llama", 8000)]),
    inv("node:b", [rt(8000, "http://10.0.0.2:8000/")], [model("llama", 8000), model("qwen", 8000)]),
  ];
  const table = buildRouteTable(inventories, [target("node:a"), target("node:b")], { now: NOW });
  assert.deepEqual(
    table.map((e) => e.model),
    ["llama", "qwen"]
  );
  assert.deepEqual(table[0].targets, [
    { targetId: "node:a", endpoint: "http://10.0.0.1:8000", load: 3, port: 8000 },
    { targetId: "node:b", endpoint: "http://10.0.0.2:8000", load: null, port: 8000 },
  ]);
});

test("cluster models are routed once, under the cluster, never under member nodes", () => {
  const clusterModel = model("big", 8000);
  const inventories = [
    inv("cluster:sparks", [rt(8000, "http://10.0.0.1:8000", { requestsRunning: 1 })], [clusterModel]),
    // Member nodes list the cluster's model under clusterModels only.
    inv("node:spark1", [rt(8001, "http://10.0.0.1:8001")], [model("small", 8001)], {
      clusterModels: [{ ...clusterModel, servedBy: "cluster:sparks" }],
    }),
    inv("node:spark2", [], [], { clusterModels: [{ ...clusterModel, servedBy: "cluster:sparks" }] }),
  ];
  const targets = [target("cluster:sparks"), target("node:spark1"), target("node:spark2")];
  const table = buildRouteTable(inventories, targets, { now: NOW });
  const big = table.find((e) => e.model === "big");
  assert.deepEqual(big.targets.map((t) => t.targetId), ["cluster:sparks"]);
  assert.deepEqual(table.find((e) => e.model === "small").targets.map((t) => t.targetId), ["node:spark1"]);
});

test("the same endpoint and model reported by a node and its cluster is listed once, under the cluster", () => {
  const inventories = [
    inv("node:spark1", [rt(8000, "http://10.0.0.1:8000")], [model("big", 8000)]),
    inv("cluster:sparks", [rt(8000, "http://10.0.0.1:8000")], [model("big", 8000)]),
  ];
  const table = buildRouteTable(inventories, [target("node:spark1"), target("cluster:sparks")], { now: NOW });
  assert.deepEqual(table[0].targets.map((t) => t.targetId), ["cluster:sparks"]);
  // A model shown with servedBy is never a route of its own.
  const t2 = buildRouteTable([inv("node:x", [rt(8000, "http://h:8000")], [model("big", 8000, "serving", { servedBy: "cluster:sparks" })])], [target("node:x")], { now: NOW });
  assert.deepEqual(t2, []);
});

test("only fresh, reachable, serving models are routable", () => {
  const ok = rt(8000, "http://h:8000");
  const targets = ["ok", "stale", "old", "unreach", "rtdown", "offline", "health", "noep", "gone"].map((n) => target(`node:${n}`));
  targets.find((t) => t.targetId === "node:offline").online = false;
  targets.find((t) => t.targetId === "node:health").health = "unreachable";
  const inventories = [
    inv("node:ok", [ok], [
      model("serving-model", 8000),
      model("loaded-model", 8000, "loaded"),
      model("starting-model", 8000, "starting"),
      model("unknown-model", 8000, "unknown"),
      model("unreachable-model", 8000, "unreachable"),
    ]),
    inv("node:stale", [ok], [model("m", 8000)], { stale: true }),
    inv("node:old", [ok], [model("m", 8000)], { collectedAt: NOW - 61_000 }),
    inv("node:unreach", [ok], [model("m", 8000)], { reachable: false }),
    inv("node:rtdown", [rt(8000, "http://h:8000", { reachable: false })], [model("m", 8000)]),
    inv("node:offline", [ok], [model("m", 8000)]),
    inv("node:health", [ok], [model("m", 8000)]),
    inv("node:noep", [rt(8000, null)], [model("m", 8000)]),
    inv("node:unregistered", [ok], [model("m", 8000)]),
  ];
  const table = buildRouteTable(inventories, targets, { now: NOW });
  assert.deepEqual(table.map((e) => e.model), ["serving-model"]);
  // The freshness bound is configurable.
  const loose = buildRouteTable([inventories[2]], targets, { now: NOW, maxAgeMs: 120_000 });
  assert.deepEqual(loose.map((e) => e.targets[0].targetId), ["node:old"]);
});

test("least-loaded is the default; unknown load ranks after known loads; ties break by targetId", () => {
  const table = [
    {
      model: "m",
      targets: [
        { targetId: "node:c", endpoint: "http://c", load: null },
        { targetId: "node:b", endpoint: "http://b", load: 2 },
        { targetId: "node:a", endpoint: "http://a", load: 2 },
        { targetId: "node:d", endpoint: "http://d", load: 5 },
      ],
    },
  ];
  assert.equal(DEFAULT_ROUTING_POLICY, "least-loaded");
  const r = rankTargets("m", table, {});
  assert.deepEqual(r.ranked.map((t) => t.targetId), ["node:a", "node:b", "node:d", "node:c"]);
  const p = pickTarget("m", table);
  assert.equal(p.target.targetId, "node:a");
  assert.equal(p.endpoint, "http://a");
  assert.equal(p.policy, "least-loaded");
  assert.match(p.reason, /least loaded/);
  // All loads unknown → deterministic by targetId.
  const allNull = [{ model: "m", targets: [{ targetId: "node:z", endpoint: "z", load: null }, { targetId: "node:y", endpoint: "y", load: null }] }];
  assert.equal(pickTarget("m", allNull).target.targetId, "node:y");
  // Zero beats null.
  const zero = [{ model: "m", targets: [{ targetId: "node:a", endpoint: "a", load: null }, { targetId: "node:b", endpoint: "b", load: 0 }] }];
  assert.equal(pickTarget("m", zero).target.targetId, "node:b");
});

test("first-available picks the lowest targetId regardless of load", () => {
  const table = [{ model: "m", targets: [{ targetId: "node:b", endpoint: "b", load: 0 }, { targetId: "node:a", endpoint: "a", load: 99 }] }];
  assert.equal(pickTarget("m", table, { policy: "first-available" }).target.targetId, "node:a");
});

test("round-robin rotates through candidates with injected state, per model", () => {
  const table = [
    { model: "m", targets: [{ targetId: "node:a", endpoint: "a", load: 0 }, { targetId: "node:b", endpoint: "b", load: 0 }, { targetId: "node:c", endpoint: "c", load: 0 }] },
    { model: "n", targets: [{ targetId: "node:a", endpoint: "a", load: 0 }, { targetId: "node:b", endpoint: "b", load: 0 }] },
  ];
  const rrState = createRoundRobinState();
  const picks = [1, 2, 3, 4].map(() => pickTarget("m", table, { policy: "round-robin", rrState }).target.targetId);
  assert.deepEqual(picks, ["node:a", "node:b", "node:c", "node:a"]);
  assert.equal(pickTarget("n", table, { policy: "round-robin", rrState }).target.targetId, "node:a");
  // Without state it is deterministic (always the first).
  assert.equal(pickTarget("m", table, { policy: "round-robin" }).target.targetId, "node:a");
});

test("a sticky key maps to the same target every time", () => {
  const table = [{ model: "m", targets: ["a", "b", "c", "d"].map((x) => ({ targetId: `node:${x}`, endpoint: x, load: 0 })) }];
  const first = pickTarget("m", table, { stickyKey: "session-42" }).target.targetId;
  for (let i = 0; i < 5; i++) assert.equal(pickTarget("m", table, { stickyKey: "session-42", policy: "round-robin", rrState: new Map() }).target.targetId, first);
});

test("unknown policies fall back to least-loaded", () => {
  assert.equal(normalizePolicy("random"), "least-loaded");
  assert.equal(normalizePolicy(undefined), "least-loaded");
  assert.equal(normalizePolicy("round-robin"), "round-robin");
  const table = [{ model: "m", targets: [{ targetId: "node:a", endpoint: "a", load: 5 }, { targetId: "node:b", endpoint: "b", load: 1 }] }];
  assert.equal(pickTarget("m", table, { policy: "bogus" }).target.targetId, "node:b");
});

test("model matching: exact first, then unique case-insensitive, never fuzzy", () => {
  const table = [
    { model: "Llama-3", targets: [{ targetId: "node:a", endpoint: "a", load: 0 }] },
    { model: "llama-3", targets: [{ targetId: "node:b", endpoint: "b", load: 0 }] },
    { model: "Qwen3-32B", targets: [{ targetId: "node:c", endpoint: "c", load: 0 }] },
  ];
  // Exact wins even when a case-variant exists.
  assert.equal(pickTarget("llama-3", table).target.targetId, "node:b");
  assert.equal(pickTarget("Llama-3", table).target.targetId, "node:a");
  // Unique case-insensitive match resolves to the served id.
  const q = pickTarget("qwen3-32b", table);
  assert.equal(q.target.targetId, "node:c");
  assert.equal(q.model, "Qwen3-32B");
  assert.match(q.reason, /case-insensitive/);
  // Ambiguous by case only → no target.
  const amb = pickTarget("LLAMA-3", table);
  assert.equal(amb.target, null);
  assert.match(amb.reason, /several served models/);
  // No prefix / substring / fuzzy matches.
  for (const name of ["Qwen3", "qwen3-32", "Qwen3-32B-AWQ", "llama", " Qwen3-32B", ""]) {
    const r = pickTarget(name, table);
    assert.equal(r.target, null, name);
    assert.equal(r.endpoint, null, name);
    assert.equal(typeof r.reason, "string");
  }
  assert.equal(matchModel("nope", table).entry, null);
  assert.match(pickTarget("nope", table).reason, /No target is serving "nope"/);
});

test("empty and malformed inputs never throw", () => {
  assert.deepEqual(buildRouteTable(null, null), []);
  assert.deepEqual(buildRouteTable([null, {}, { targetId: "node:a" }], undefined, { now: NOW }), []);
  assert.equal(pickTarget("m", null).target, null);
  assert.equal(pickTarget(undefined, []).target, null);
});

test("endpoints are normalized like targets.js: case-only differences do not create duplicate routes", () => {
  const inventories = [
    inv("node:spark1", [rt(8000, "http://Spark1.Tail.ts.net:8000/")], [model("big", 8000)]),
    inv("cluster:sparks", [rt(8000, "http://spark1.tail.ts.net:8000")], [model("big", 8000)]),
  ];
  const table = buildRouteTable(inventories, [target("node:spark1"), target("cluster:sparks")], { now: NOW });
  assert.deepEqual(table[0].targets, [{ targetId: "cluster:sparks", endpoint: "http://spark1.tail.ts.net:8000", load: null, port: 8000 }]);
});

test("least-loaded adds the proxy's in-flight requests to known loads; unknown loads still rank last", () => {
  const table = [
    {
      model: "m",
      targets: [
        { targetId: "node:a", endpoint: "a", load: 1 },
        { targetId: "node:b", endpoint: "b", load: 2 },
        { targetId: "node:c", endpoint: "c", load: null },
        { targetId: "node:d", endpoint: "d", load: null },
      ],
    },
  ];
  const inflight = new Map([["node:a", 2], ["node:c", 1]]);
  const r = rankTargets("m", table, { inflight });
  // a: 1+2=3, b: 2 → b first; unknown loads after, ordered by in-flight then id.
  assert.deepEqual(r.ranked.map((t) => t.targetId), ["node:b", "node:a", "node:d", "node:c"]);
  assert.match(r.reason, /least loaded \(2 running\)/);
});

test("models reached only through an SSH tunnel are never routable (the tunnel is temporary)", () => {
  const inventories = [
    inv("node:a", [rt(8000, "http://127.0.0.1:41234", { via: "ssh-tunnel" })], [model("llama", 8000)]),
    inv("node:b", [rt(8000, "http://10.0.0.2:8000", { via: "direct" })], [model("llama", 8000)]),
  ];
  const table = buildRouteTable(inventories, [target("node:a"), target("node:b")], { now: NOW });
  assert.equal(table.length, 1);
  assert.deepEqual(table[0].targets.map((t) => t.targetId), ["node:b"]);
});

test("a loopback endpoint of unknown origin is not routable; direct loopback and unknown LAN endpoints are", () => {
  assert.equal(isLoopbackEndpoint("http://127.0.0.1:8000"), true);
  assert.equal(isLoopbackEndpoint("http://localhost:8000"), true);
  assert.equal(isLoopbackEndpoint("http://[::1]:8000"), true);
  assert.equal(isLoopbackEndpoint("http://10.0.0.2:8000"), false);
  assert.equal(isLoopbackEndpoint("not a url"), false);
  const inventories = [
    inv("node:a", [rt(8000, "http://127.0.0.1:41234", { via: null })], [model("ghost", 8000)]),
    inv("node:b", [rt(8000, "http://127.0.0.1:8000", { via: "direct" })], [model("local", 8000)]),
    inv("node:c", [rt(8000, "http://10.0.0.3:8000", { via: null })], [model("lan", 8000)]),
  ];
  const table = buildRouteTable(inventories, [target("node:a"), target("node:b"), target("node:c")], { now: NOW });
  assert.deepEqual(table.map((e) => e.model).sort(), ["lan", "local"]);
});
