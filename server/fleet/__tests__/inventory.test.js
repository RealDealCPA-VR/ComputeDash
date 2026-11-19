import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeFetch } from "./fakeFetch.js";
import { TargetBackoff, collectInventory, countServing } from "../inventory.js";
import { buildTargets } from "../targets.js";

const units = [
  { id: "spark1", name: "Spark 1", kind: "spark", platform: "linux", role: "head", llmPorts: [8000, 8001, 11434], lanIp: "10.0.0.1" },
  { id: "spark2", name: "Spark 2", kind: "spark", platform: "linux", role: "worker", workerHeadId: "spark1", llmPorts: [8000], lanIp: "10.0.0.2" },
  { id: "dell", name: "Dell", kind: "host", platform: "windows", llmPorts: [1234], lanIp: "10.0.0.3" },
  { id: "mac", name: "Mac", kind: "mac", platform: "darwin", llmPorts: [8080], lanIp: "10.0.0.4", agent: { port: 9100 } },
];
const entry = (port, backend, models, extra = {}) => ({ port, backend, models, modelId: models[0] ?? null, available: true, contextLength: null, requestsRunning: 0, ...extra });
const cluster = {
  id: "sparks",
  name: "Spark cluster",
  kind: "distributed",
  memberIds: ["spark1", "spark2"],
  headId: "spark1",
  endpoint: { host: null, port: 8000 },
  engine: "vllm",
  launcherId: "ray-aaa111",
  notes: "",
};

function snapshots(overrides = {}) {
  return new Map(
    Object.entries({
      spark1: {
        online: true,
        metrics: {
          llm: [
            entry(8000, "vllm", ["Qwen/Qwen3-235B"], { contextLength: 65536, requestsRunning: 2 }),
            entry(8001, "llama.cpp", ["gemma-3-27b"]),
            // The monitor's /v1/models on Ollama is the INSTALLED catalog, not what is loaded.
            entry(11434, "ollama", ["llama3.1:8b", "phi3:mini"]),
          ],
        },
      },
      spark2: { online: true, metrics: { llm: [] } },
      dell: { online: true, metrics: { llm: [entry(1234, "lmstudio", ["qwen2.5-7b-instruct"])] } },
      mac: { online: true, metrics: { llm: [] } },
      ...overrides,
    })
  );
}

const S1 = "http://10.0.0.1";
function sparkRoutes(extra = {}) {
  return {
    [`GET ${S1}:8000/v1/models`]: { body: { data: [{ id: "Qwen/Qwen3-235B", max_model_len: 131072 }] } },
    [`GET ${S1}:8000/health`]: { text: "" },
    [`GET ${S1}:8001/v1/models`]: { body: { data: [{ id: "gemma-3-27b" }] } },
    [`GET ${S1}:8001/health`]: { body: { status: "ok" } },
    [`GET ${S1}:11434/api/tags`]: { body: { models: [{ name: "llama3.1:8b", size: 5e9 }, { name: "phi3:mini", size: 2e9 }] } },
    [`GET ${S1}:11434/api/ps`]: { body: { models: [{ name: "llama3.1:8b", size: 6e9, size_vram: 6e9 }] } },
    ...extra,
  };
}

function launcherApi(byUnit, statuses = {}) {
  return {
    list: (id) => byUnit[id] ?? [],
    statuses: async (spark, launchers) => Object.fromEntries(launchers.map((l) => [l.id, statuses[l.id] ?? "stopped"])),
    latestJob: () => null,
    startJob: () => ({ ok: true, job: {} }),
  };
}

function deps(extra = {}) {
  return {
    units,
    clusters: [],
    snapshots: snapshots(),
    fetchImpl: fakeFetch(sparkRoutes()),
    exec: null,
    mac: null,
    launchers: null,
    servedKeys: new Set(),
    timeoutMs: 200,
    now: () => 1000,
    ...extra,
  };
}

const node = (id) => ({ targetId: `node:${id}`, kind: "node", id });
const byId = (inv) => Object.fromEntries(inv.models.map((m) => [m.modelId, m]));

test("node inventory: engines per port from the snapshot, adapters discover, states derived", async () => {
  const inv = await collectInventory(node("spark1"), deps());
  assert.equal(inv.reachable, true);
  assert.deepEqual(inv.errors, []);
  assert.equal(inv.stale, false);
  assert.deepEqual(inv.runtimes.map((r) => [r.engine, r.port, r.reachable]), [["vllm", 8000, true], ["llama.cpp", 8001, true], ["ollama", 11434, true]]);
  assert.equal(inv.runtimes[0].requestsRunning, 2);
  const m = byId(inv);
  assert.equal(m["Qwen/Qwen3-235B"].state, "serving");
  assert.equal(m["Qwen/Qwen3-235B"].contextLength, 131072, "adapter's max_model_len wins over the snapshot");
  assert.equal(m["Qwen/Qwen3-235B"].modelKey, "vllm|8000|Qwen/Qwen3-235B");
  assert.deepEqual(m["Qwen/Qwen3-235B"].actions, { start: false, stop: false, reload: false, switchTo: false }, "no lifecycle without a launch profile");
  assert.equal(m["gemma-3-27b"].state, "serving");
  assert.equal(m["llama3.1:8b"].state, "serving");
  assert.deepEqual(m["llama3.1:8b"].sources, ["catalog", "ps"]);
  assert.equal(m["llama3.1:8b"].actions.stop, true, "ollama unload");
  assert.equal(m["phi3:mini"].state, "installed");
  assert.equal(m["phi3:mini"].actions.start, true, "ollama load");
  assert.equal(m["phi3:mini"].actions.switchTo, true);
  for (const x of inv.models) {
    for (const k of ["modelKey", "modelId", "label", "engine", "port", "state", "sources", "quantization", "contextLength", "sizeBytes", "estMemoryBytes", "launcherId", "macRuntime", "servedBy", "actions", "lastError"]) {
      assert.ok(k in x, `${x.modelId} has ${k}`);
    }
  }
});

test("a launch profile on a port merges with the API's model: one row, sources unioned, stable profile key", async () => {
  const launchers = launcherApi(
    { spark1: [{ id: "gemma-abc123", name: "Gemma launcher", port: 8001 }, { id: "big-def456", name: "Big", port: 9000 }] },
    { "gemma-abc123": "running", "big-def456": "stopped" }
  );
  const served = new Set();
  const inv = await collectInventory(node("spark1"), deps({ launchers, servedKeys: served }));
  const rows = inv.models.filter((x) => x.port === 8001);
  assert.equal(rows.length, 1, "counted once");
  const g = rows[0];
  assert.equal(g.modelId, "gemma-3-27b", "modelId comes from the serving API");
  assert.equal(g.label, "Gemma launcher");
  assert.equal(g.launcherId, "gemma-abc123");
  assert.equal(g.engine, "llama.cpp");
  assert.equal(g.modelKey, "launch-profile|launcher:gemma-abc123|gemma-abc123", "keyed on the launcher id");
  assert.deepEqual(g.sources.sort(), ["api", "launcher"]);
  assert.equal(g.state, "serving");
  assert.deepEqual(g.actions, { start: false, stop: true, reload: true, switchTo: false });
  const big = inv.models.find((x) => x.launcherId === "big-def456");
  assert.equal(big.state, "configured");
  assert.equal(big.actions.start, true);
  assert.ok(inv.runtimes.some((r) => r.engine === "launch-profile"));

  // The launcher stops: same key, now "stopped" because it served earlier this session.
  const stoppedDeps = deps({
    // Renamed and stopped: the key survives both.
    launchers: launcherApi({ spark1: [{ id: "gemma-abc123", name: "Gemma renamed", port: 8001 }] }, { "gemma-abc123": "stopped" }),
    servedKeys: served,
    snapshots: snapshots({ spark1: { online: true, metrics: { llm: [entry(8001, null, [], { available: false })] } } }),
  });
  const inv2 = await collectInventory(node("spark1"), stoppedDeps);
  const g2 = inv2.models.find((x) => x.launcherId === "gemma-abc123");
  assert.equal(g2.modelKey, g.modelKey);
  assert.equal(g2.state, "stopped");
  assert.deepEqual(inv2.errors, [], "a closed port with nothing identified is not a discovery failure");
});

test("a running profile process the API does not list yet is starting, not serving", async () => {
  const launchers = launcherApi({ spark1: [{ id: "new-aaa000", name: "New", port: 9000 }] }, { "new-aaa000": "running" });
  const inv = await collectInventory(node("spark1"), deps({ launchers }));
  assert.equal(inv.models.find((x) => x.launcherId === "new-aaa000").state, "starting");
});

test("operations in flight and failures from the runner drive starting / stopping / failed", async () => {
  const operations = {
    inFlight: (targetId, key) => (key === "ollama|11434|phi3:mini" ? "start" : key === "ollama|11434|llama3.1:8b" ? "stop" : null),
    lastFailure: (targetId, key) => (key === "llama.cpp|8001|gemma-3-27b" ? { at: 500, error: "readiness timed out" } : null),
  };
  const m = byId(await collectInventory(node("spark1"), deps({ operations })));
  assert.equal(m["phi3:mini"].state, "starting");
  assert.equal(m["llama3.1:8b"].state, "stopping");
  // Failed at 500, seen serving at 1000: the newer evidence wins.
  assert.equal(m["gemma-3-27b"].state, "serving");
  assert.equal(m["gemma-3-27b"].lastError, "readiness timed out");
  const late = { lastFailure: (t, key) => (key === "llama.cpp|8001|gemma-3-27b" ? { at: 5000, error: "x" } : null) };
  assert.equal(byId(await collectInventory(node("spark1"), deps({ operations: late })))["gemma-3-27b"].state, "failed");
});

test("cluster dedupe: the endpoint model is owned by the cluster and counted once", async () => {
  const launchers = launcherApi(
    { spark1: [{ id: "ray-aaa111", name: "Ray vLLM", port: null }, { id: "solo-bbb222", name: "Solo", port: 9000 }] },
    { "ray-aaa111": "running" }
  );
  const d = deps({ clusters: [cluster], launchers });
  const head = await collectInventory(node("spark1"), d);
  assert.equal(head.models.some((x) => x.modelId === "Qwen/Qwen3-235B"), false, "not a head model");
  assert.equal(head.models.some((x) => x.launcherId === "ray-aaa111"), false, "the cluster's launcher is the cluster's");
  assert.ok(head.models.some((x) => x.launcherId === "solo-bbb222"));
  assert.equal(head.runtimes.some((r) => r.port === 8000), false);
  assert.deepEqual(head.clusterModels.map((x) => [x.modelId, x.servedBy, x.state]), [["Qwen/Qwen3-235B", "cluster:sparks", "serving"]]);
  assert.deepEqual(head.clusterModels[0].actions, { start: false, stop: false, reload: false, switchTo: false });

  const worker = await collectInventory(node("spark2"), d);
  assert.deepEqual(worker.models, []);
  assert.deepEqual(worker.clusterModels.map((x) => x.servedBy), ["cluster:sparks"]);

  const cl = await collectInventory({ targetId: "cluster:sparks", kind: "cluster", id: "sparks" }, d);
  assert.equal(cl.reachable, true);
  assert.deepEqual(cl.clusterModels, []);
  assert.equal(cl.models.length, 1);
  const q = cl.models[0];
  assert.equal(q.modelId, "Qwen/Qwen3-235B");
  assert.equal(q.launcherId, "ray-aaa111");
  assert.equal(q.state, "serving");
  assert.equal(q.actions.stop, true);
  assert.equal(q.servedBy, null);

  const total = countServing([head, worker, cl]);
  // head: gemma + llama3.1 (+ solo is configured) ; cluster: Qwen once.
  assert.equal(total, 3);
  assert.equal(countServing([head, worker, cl, worker]), 3);

  // The cluster's cached inventory is preferred for member rows when available.
  const cached = await collectInventory(node("spark2"), { ...d, getCachedInventory: (id) => (id === "cluster:sparks" ? cl : null) });
  assert.equal(cached.clusterModels[0].launcherId, "ray-aaa111");
  assert.equal(cached.clusterModels[0].servedBy, "cluster:sparks");

  // A stale or old cluster reading never shows as current on a member.
  const old = await collectInventory(node("spark2"), { ...d, now: () => 1000 + 120000, getCachedInventory: () => cl });
  assert.equal(old.clusterModels[0].state, "unknown");
  assert.deepEqual(old.clusterModels[0].lastSeen, { state: "serving", at: 1000 });
  assert.equal(old.clusterModels[0].stale, true);
  const staleInv = await collectInventory(node("spark2"), { ...d, getCachedInventory: () => ({ ...cl, stale: true }) });
  assert.equal(staleInv.clusterModels[0].state, "unknown");
  assert.equal(cached.clusterModels[0].stale, false);
  assert.equal(cached.clusterModels[0].collectedAt, 1000);

  // Targets agree: servingCount comes from the inventories, the endpoint counted under the cluster.
  const inventories = new Map([[head.targetId, head], [cl.targetId, cl], [worker.targetId, worker]]);
  const t = buildTargets({ units, clusters: [cluster], snapshots: d.snapshots, inventories });
  assert.equal(t.find((x) => x.id === "spark1").servingCount, 2);
  assert.equal(t.find((x) => x.targetId === "cluster:sparks").servingCount, 1);
});

test("an unreachable target never yields serving; last known state is kept as lastSeen", async () => {
  const first = await collectInventory(node("spark1"), deps());
  const f = fakeFetch(sparkRoutes());
  const offline = snapshots({ spark1: { online: false, offlineReason: "SSH timed out", metrics: { llm: [entry(8000, "vllm", ["Qwen/Qwen3-235B"])] } } });
  const launchers = launcherApi({ spark1: [{ id: "a-000001", name: "A", port: 9000 }] });
  const inv = await collectInventory(node("spark1"), deps({ snapshots: offline, fetchImpl: f, previous: first, launchers }));
  assert.equal(inv.reachable, false);
  assert.equal(f.calls.length, 0, "no network to an offline unit");
  assert.deepEqual(inv.errors, ["Spark 1 is offline: SSH timed out"]);
  assert.ok(inv.models.length >= 4);
  for (const m of inv.models) {
    assert.equal(m.state, "unreachable", m.modelId);
    assert.deepEqual(m.actions, { start: false, stop: false, reload: false, switchTo: false });
  }
  assert.deepEqual(byId(inv)["Qwen/Qwen3-235B"].lastSeen, { state: "serving", at: 1000 });
  assert.equal(inv.runtimes.every((r) => r.reachable === false), true);
});

test("a runtime that stops answering: its models are unreachable with the error verbatim, never serving", async () => {
  const f = fakeFetch(sparkRoutes({ [`GET ${S1}:8000/v1/models`]: "hang", [`GET ${S1}:8000/health`]: "hang" }));
  const inv = await collectInventory(node("spark1"), deps({ fetchImpl: f, timeoutMs: 40 }));
  assert.equal(inv.reachable, true, "the unit itself is online");
  const q = byId(inv)["Qwen/Qwen3-235B"];
  assert.equal(q.state, "unreachable");
  assert.ok(inv.errors.some((e) => /GET http:\/\/10\.0\.0\.1:8000\/v1\/models: timed out after 40 ms/.test(e)));
  assert.equal(inv.runtimes.find((r) => r.port === 8000).reachable, false);
});

test("ollama process list unreadable: installed models are unknown, not 'installed'", async () => {
  const f = fakeFetch(sparkRoutes({ [`GET ${S1}:11434/api/ps`]: { status: 500, text: "boom" } }));
  const m = byId(await collectInventory(node("spark1"), deps({ fetchImpl: f })));
  assert.equal(m["phi3:mini"].state, "unknown");
  assert.equal(m["llama3.1:8b"].state, "unknown");
});

test("Windows unit with LM Studio: discovery works, load/unload are off with a reason", async () => {
  const D = "http://10.0.0.3:1234";
  const f = fakeFetch({
    [`GET ${D}/api/v0/models`]: {
      body: { data: [{ id: "qwen2.5-7b-instruct", state: "loaded", type: "llm" }, { id: "phi-4", state: "not-loaded", type: "llm" }] },
    },
  });
  const inv = await collectInventory(node("dell"), deps({ fetchImpl: f, exec: async () => "should not run" }));
  const rt = inv.runtimes.find((r) => r.engine === "lmstudio");
  assert.equal(rt.capabilities.load, false);
  assert.match(rt.note, /SSH/);
  const m = byId(inv);
  assert.equal(m["qwen2.5-7b-instruct"].state, "serving");
  assert.equal(m["phi-4"].state, "installed");
  assert.deepEqual(m["phi-4"].actions, { start: false, stop: false, reload: false, switchTo: false });
  // On Linux with exec, the same runtime is controllable.
  const linux = units.map((u) => (u.id === "dell" ? { ...u, platform: "linux" } : u));
  const inv2 = await collectInventory(node("dell"), deps({ units: linux, fetchImpl: f, exec: async () => "" }));
  assert.equal(byId(inv2)["phi-4"].actions.start, true);
});

test("mac node: profile models from the agent view, merged with the serving port", async () => {
  const view = {
    state: "ready",
    serving: [{ name: "omlx", state: "serving", port: 8080, model: "mlx/Qwen3", health: { ok: true } }],
    targets: [{ name: "omlx", label: "oMLX", models: [{ id: "mlx/Qwen3", label: "Qwen3" }, { id: "mlx/Gemma", label: "Gemma" }], startable: true, stoppable: true }],
  };
  const snaps = snapshots({ mac: { online: true, metrics: { llm: [entry(8080, "splash", ["mlx/Qwen3"])] } } });
  const inv = await collectInventory(node("mac"), deps({ snapshots: snaps, mac: { readRuntimeControl: async () => view, beginRuntimeControl: async () => view } }));
  const rows = inv.models.filter((x) => x.modelId === "mlx/Qwen3");
  assert.equal(rows.length, 1, "agent profile and monitor probe merged");
  assert.equal(rows[0].macRuntime, "omlx");
  assert.equal(rows[0].state, "serving");
  assert.equal(rows[0].engine, "splash");
  assert.equal(rows[0].actions.stop, true);
  const gemma = inv.models.find((x) => x.modelId === "mlx/Gemma");
  assert.equal(gemma.state, "configured");
  assert.equal(gemma.actions.switchTo, true);
});

test("group clusters have no inference instance; unknown targets report an error", async () => {
  const group = { id: "desk", name: "Desk", kind: "group", memberIds: ["dell", "mac"], headId: "dell", endpoint: null, engine: null, launcherId: null, notes: "" };
  const inv = await collectInventory({ targetId: "cluster:desk", kind: "cluster", id: "desk" }, deps({ clusters: [group] }));
  assert.deepEqual([inv.models, inv.runtimes, inv.errors, inv.reachable], [[], [], [], true]);
  const missing = await collectInventory(node("ghost"), deps());
  assert.match(missing.errors[0], /not in the registry/);
  const bad = await collectInventory({ targetId: "cluster:nope", kind: "cluster", id: "nope" }, deps());
  assert.match(bad.errors[0], /does not exist/);
});

test("backoff: 2 s doubling to 60 s; collection is skipped while backing off unless forced", async () => {
  let t = 0;
  const b = new TargetBackoff({ now: () => t });
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(() => b.recordFailure("x")), [2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  assert.equal(b.canAttempt("x"), false);
  t = 60000;
  assert.equal(b.canAttempt("x"), true);
  b.recordSuccess("x");
  assert.equal(b.retryInMs("x"), 0);

  // Every source on a unit with no snapshot fails → unreachable → backoff engaged.
  t = 0;
  const backoff = new TargetBackoff({ now: () => t });
  const f = fakeFetch({});
  const noSnap = new Map();
  const launchers = launcherApi({ spark2: [{ id: "w-000001", name: "W", port: 8000 }] });
  const blind = { ...launchers, statuses: async () => ({}) };
  const d = deps({ snapshots: noSnap, fetchImpl: f, backoff, launchers: blind, now: () => t });
  const first = await collectInventory(node("spark2"), d);
  assert.equal(first.reachable, null, "no source answered or failed definitively");
  // An offline snapshot is a definite failure.
  const off = deps({ snapshots: snapshots({ spark2: { online: false, metrics: { llm: [] } } }), backoff, fetchImpl: f, now: () => t });
  await collectInventory(node("spark2"), off);
  assert.equal(backoff.canAttempt("node:spark2"), false);
  // Back online but still inside the backoff window: skipped, reported, no network.
  const on = deps({ backoff, fetchImpl: f, now: () => t });
  const skipped = await collectInventory(node("spark1"), on);
  assert.equal(skipped.reachable, true, "other targets are unaffected");
  // Online state still unknown and inside the backoff window: skipped, reported, no exec.
  let statusCalls = 0;
  const counting = { ...launchers, statuses: async (s, ls) => (statusCalls++, launchers.statuses(s, ls)) };
  const held = await collectInventory(node("spark2"), deps({ snapshots: noSnap, backoff, fetchImpl: f, now: () => t, launchers: counting }));
  assert.equal(held.reachable, false);
  assert.match(held.errors[0], /next attempt in 2 s/);
  assert.equal(statusCalls, 0);
  // Forced refresh ignores the window; success resets it.
  const forced = await collectInventory(node("spark2"), deps({ snapshots: noSnap, backoff, fetchImpl: f, now: () => t, force: true, launchers: counting }));
  assert.equal(statusCalls, 1);
  assert.equal(forced.reachable, true);
  assert.equal(backoff.canAttempt("node:spark2"), true, "success resets the backoff");
  // The monitor saying online === true bypasses the backoff window.
  await collectInventory(node("spark2"), off);
  assert.equal(backoff.canAttempt("node:spark2"), false);
  const online = await collectInventory(node("spark2"), deps({ backoff, fetchImpl: f, now: () => t }));
  assert.equal(online.reachable, true);
  assert.equal(online.errors.length, 0);
  assert.equal(backoff.canAttempt("node:spark2"), true);
});

test("collectInventory never throws, even when a dependency does", async () => {
  const inv = await collectInventory(node("spark1"), deps({ getSpark: () => { throw new Error("registry exploded"); }, launchers: { list: () => { throw new Error("store broken"); }, statuses: async () => ({}) } }));
  assert.equal(inv.targetId, "node:spark1");
  assert.ok(Array.isArray(inv.errors));
});

test("cluster endpoint written with another host spelling is still owned by the cluster, counted once", async () => {
  const spelled = units.map((u) => (u.id === "spark1" ? { ...u, llmHost: "100.64.0.1" } : u));
  const c = { ...cluster, endpoint: { host: "spark1.tail.ts.net", port: 8000 }, launcherId: null };
  const H = "http://100.64.0.1";
  const routes = {};
  for (const [k, v] of Object.entries(sparkRoutes())) routes[k.replace(S1, H)] = v;
  routes["GET http://spark1.tail.ts.net:8000/v1/models"] = { body: { data: [{ id: "Qwen/Qwen3-235B" }] } };
  routes["GET http://spark1.tail.ts.net:8000/health"] = { text: "" };
  const d = deps({ units: spelled, clusters: [c], fetchImpl: fakeFetch(routes) });
  const head = await collectInventory(node("spark1"), d);
  assert.equal(head.models.some((x) => x.modelId === "Qwen/Qwen3-235B"), false);
  assert.equal(head.runtimes.some((r) => r.port === 8000), false);
  assert.deepEqual(head.clusterModels.map((x) => x.servedBy), ["cluster:sparks"]);
  const cl = await collectInventory({ targetId: "cluster:sparks", kind: "cluster", id: "sparks" }, d);
  assert.equal(cl.models[0].state, "serving");
  assert.equal(cl.models[0].endpoint, "http://spark1.tail.ts.net:8000");
  assert.equal(countServing([head, cl]), 3);
});

test("two launch profiles on one port: only the sole running profile claims the API model", async () => {
  const two = (a, b) =>
    launcherApi(
      { spark1: [{ id: "first-aaa000", name: "First", port: 8001 }, { id: "second-bbb000", name: "Second", port: 8001 }] },
      { "first-aaa000": a, "second-bbb000": b }
    );
  // First is stopped, second runs: the second gets it, the stopped one stays configured.
  let inv = await collectInventory(node("spark1"), deps({ launchers: two("stopped", "running") }));
  let rows = inv.models.filter((x) => x.port === 8001);
  assert.equal(rows.find((x) => x.launcherId === "second-bbb000").state, "serving");
  assert.equal(rows.find((x) => x.launcherId === "second-bbb000").modelId, "gemma-3-27b");
  assert.equal(rows.find((x) => x.launcherId === "first-aaa000").state, "configured");
  assert.equal(rows.length, 2);
  // Both stopped (something else serves the port): the API row stays on its own.
  inv = await collectInventory(node("spark1"), deps({ launchers: two("stopped", "stopped") }));
  rows = inv.models.filter((x) => x.port === 8001);
  assert.deepEqual(rows.map((x) => [x.launcherId, x.state]).sort(), [["first-aaa000", "configured"], ["second-bbb000", "configured"], [null, "serving"]].sort());
  // Both running: ambiguous, the API row stays on its own; both profiles are starting.
  inv = await collectInventory(node("spark1"), deps({ launchers: two("running", "running") }));
  rows = inv.models.filter((x) => x.port === 8001);
  assert.equal(rows.find((x) => x.launcherId === null).state, "serving");
  assert.deepEqual(rows.filter((x) => x.launcherId).map((x) => x.state), ["starting", "starting"]);
});

test("a multi-model engine that stops answering: its monitor catalog is not turned into rows", async () => {
  const f = fakeFetch(sparkRoutes({ [`GET ${S1}:11434/api/tags`]: new Error("socket hang up"), [`GET ${S1}:11434/api/ps`]: new Error("socket hang up") }));
  const inv = await collectInventory(node("spark1"), deps({ fetchImpl: f }));
  assert.equal(inv.models.some((x) => x.port === 11434), false);
  assert.equal(inv.runtimes.find((r) => r.port === 11434).reachable, false);
  assert.ok(inv.errors.some((e) => /api\/tags: socket hang up/.test(e)));
});

test("a cached cluster inventory without collectedAt is stale: rows unknown, lastSeen.at null", async () => {
  const d = deps({ clusters: [cluster] });
  const cached = {
    targetId: "cluster:sparks",
    reachable: true,
    stale: false,
    runtimes: [],
    models: [{ modelKey: "vllm|8000|Q", modelId: "Q", label: "Q", engine: "vllm", port: 8000, state: "serving", sources: ["api"] }],
    clusterModels: [],
    errors: [],
  };
  const inv = await collectInventory(node("spark2"), { ...d, getCachedInventory: () => cached });
  const row = inv.clusterModels[0];
  assert.equal(row.state, "unknown");
  assert.equal(row.stale, true);
  assert.equal(row.collectedAt, null);
  assert.deepEqual(row.lastSeen, { state: "serving", at: null });
});
