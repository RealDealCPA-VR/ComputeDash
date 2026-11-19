import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeFetch } from "./fakeFetch.js";
import { ClusterStore } from "../clusterStore.js";
import { FleetModelManager } from "../FleetModelManager.js";

const GB = 1024 ** 3;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-fleet-manager-"));

const UNITS = [
  { id: "spark1", name: "Spark 1", kind: "spark", platform: "linux", role: "head", lanIp: "10.0.0.1", llmPorts: [11434], llmApiKeys: { 11434: "secret-key" } },
  { id: "spark2", name: "Spark 2", kind: "spark", platform: "linux", role: "worker", workerHeadId: "spark1", lanIp: "10.0.0.2", llmPorts: [8000] },
];

function fakeRegistry(units = UNITS) {
  const list = units.map((u) => ({ ...u }));
  return {
    list,
    get publicSparks() {
      return list.map(({ llmApiKeys: _k, ...rest }) => ({ ...rest }));
    },
    get sparkIds() {
      return list.map((u) => u.id);
    },
    getSpark: (id) => list.find((u) => u.id === id) ?? null,
  };
}

function monitorsFor() {
  const snap = (id, llm) => ({
    snapshot: () => ({ online: true, hardware: { totalMemoryGB: 128 }, metrics: { llm } }),
    id,
  });
  return new Map([
    ["spark1", snap("spark1", [{ port: 11434, backend: "ollama", models: ["llama3.1:8b"], modelId: "llama3.1:8b", available: true, requestsRunning: 0 }])],
    ["spark2", snap("spark2", [])],
  ]);
}

/** A tiny Ollama: /api/tags, /api/ps and keep_alive load / unload. */
function ollamaWorld() {
  const loaded = new Set(["llama3.1:8b"]);
  const base = "http://10.0.0.1:11434";
  const fetchImpl = fakeFetch({
    [`GET ${base}/api/tags`]: { body: { models: [{ name: "llama3.1:8b", size: 5 * GB }, { name: "phi3:mini", size: 2 * GB }] } },
    [`GET ${base}/api/ps`]: () => ({ body: { models: [...loaded].map((name) => ({ name, size: 6 * GB })) } }),
    [`POST ${base}/api/generate`]: (init) => {
      const body = JSON.parse(init.body);
      if (body.keep_alive === 0) loaded.delete(body.model);
      else loaded.add(body.model);
      return { body: { done_reason: body.keep_alive === 0 ? "unload" : "load" } };
    },
  });
  return { loaded, fetchImpl };
}

function makeManager(extra = {}) {
  const registry = extra.registry ?? fakeRegistry();
  const file = path.join(fs.mkdtempSync(path.join(dir, "c-")), "fleet-clusters.json");
  const clusterStore = new ClusterStore({ file, getUnitIds: () => registry.sparkIds });
  const tunnels = { opened: 0, closed: 0, apiKeys: [] };
  const events = [];
  const ollama = ollamaWorld();
  const jobs = { latest: { id: "j1", launcherId: "qwen", action: "start", status: "running" } };
  const manager = new FleetModelManager({
    registry,
    monitors: monitorsFor(),
    clusterStore,
    launcherStore: { list: (id) => (id === "spark1" ? [{ id: "qwen", name: "Qwen", port: 8000 }] : []) },
    launcherManager: {
      statuses: async (spark, ls) => Object.fromEntries(ls.map((l) => [l.id, "stopped"])),
      latestJob: () => jobs.latest,
      readJob: (id, jobId, since) => (jobId === "j1" ? { job: jobs.latest, lines: [{ seq: 1, text: "vllm serve" }, { seq: 2, text: "ready" }].filter((l) => l.seq > since), nextSeq: 2 } : null),
      startJob: () => ({ ok: false, reason: "not in this test" }),
    },
    recordEvent: (e) => events.push(e),
    getSettings: () => ({ fleetModelsEnabled: true, smartRoutingEnabled: false }),
    resolveTarget: async (unit, port, opts) => {
      tunnels.opened += 1;
      tunnels.apiKeys.push(opts?.apiKey ?? null);
      return { host: unit.lanIp, port, via: "direct", close: () => (tunnels.closed += 1) };
    },
    fetchImpl: ollama.fetchImpl,
    exec: null,
    mac: null,
    servedKeys: new Set(),
    timeoutMs: 500,
    backgroundRefreshMs: 0,
    runner: { readinessTimeoutMs: { node: 1000, cluster: 1000 }, stopTimeoutMs: 1000, pollMs: { initial: 5, max: 10, job: 5 } },
    ...extra,
  });
  return { manager, clusterStore, tunnels, events, ollama, registry };
}

async function settle(manager, id) {
  for (let i = 0; i < 400; i += 1) {
    const read = manager.readOperation(id);
    if (read.operation.status !== "running") return read;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("operation did not finish");
}

test("targets lists every node and cluster with busy and hardware", () => {
  const { manager } = makeManager();
  const created = manager.createCluster({ name: "Pair", kind: "group", memberIds: ["spark1", "spark2"] });
  assert.equal(created.ok, true);
  const { targets, generatedAt } = manager.targets();
  assert.equal(typeof generatedAt, "number");
  assert.deepEqual(targets.map((t) => t.targetId), ["node:spark1", "node:spark2", "cluster:pair"]);
  assert.equal(targets[0].hardware.memoryTotalBytes, 128 * GB);
  assert.ok(targets.every((t) => t.busy === false));
});

test("inventory is cached, refresh bypasses the cache, and every tunnel is closed", async () => {
  const { manager, tunnels, ollama } = makeManager();
  const a = await manager.inventory("node:spark1");
  assert.equal(a.reachable, true);
  assert.equal(a.stale, false);
  const serving = a.models.find((m) => m.modelId === "llama3.1:8b");
  assert.equal(serving.state, "serving");
  assert.equal(serving.modelKey, "ollama|11434|llama3.1:8b");
  const fetches = ollama.fetchImpl.calls.length;
  await manager.inventory("node:spark1");
  assert.equal(ollama.fetchImpl.calls.length, fetches, "second read comes from the cache");
  await manager.inventory("node:spark1", { refresh: true });
  assert.ok(ollama.fetchImpl.calls.length > fetches);
  assert.ok(tunnels.opened >= 2);
  assert.equal(tunnels.closed, tunnels.opened);
  assert.equal(tunnels.apiKeys[0], "secret-key", "the port's API key is used for the reachability probe");
  assert.equal(JSON.stringify(a).includes("secret-key"), false, "the inventory never carries a secret");
  assert.equal(await manager.inventory("node:nope"), null);
});

test("a refresh that fails outright serves the cache as stale", async () => {
  const { manager } = makeManager();
  const first = await manager.inventory("node:spark1");
  manager._collect = async () => {
    throw new Error("collector exploded");
  };
  const again = await manager.inventory("node:spark1", { refresh: true });
  assert.equal(again.stale, true);
  assert.equal(again.models.length, first.models.length);
  assert.ok(again.errors.includes("collector exploded"));
});

test("switch through the manager unloads, loads, waits for readiness and closes its tunnels", async () => {
  const { manager, tunnels, events, ollama } = makeManager();
  await manager.inventory("node:spark1");
  const res = manager.startOperation("node:spark1", { action: "switch", modelKey: "ollama|11434|phi3:mini", force: false, rollback: true });
  assert.equal(res.ok, true, res.error);
  assert.equal(manager.targets().targets[0].busy, true);
  assert.equal(manager.isUnitBusy("spark1"), true);
  const busy = manager.startOperation("node:spark1", { action: "start", modelKey: "ollama|11434|phi3:mini" });
  assert.equal(busy.status, 409);
  const read = await settle(manager, res.operation.id);
  assert.equal(read.operation.status, "succeeded", read.operation.error);
  assert.equal(read.operation.fromModelKey, "ollama|11434|llama3.1:8b");
  const posts = ollama.fetchImpl.calls.filter((c) => c.method === "POST").map((c) => [c.body.model, c.body.keep_alive]);
  assert.deepEqual(posts, [["llama3.1:8b", 0], ["phi3:mini", -1]]);
  assert.deepEqual([...ollama.loaded], ["phi3:mini"]);
  assert.equal(tunnels.closed, tunnels.opened, "operation and inventory tunnels are all closed");
  assert.deepEqual(events.map((e) => e.type), ["fleet.switch.started", "fleet.switch.succeeded"]);
  const inv = await manager.inventory("node:spark1");
  assert.equal(inv.models.find((m) => m.modelId === "phi3:mini").state, "serving");
  assert.equal(manager.isUnitBusy("spark1"), false);
});

test("startOperation: unknown target and model are 404", async () => {
  const { manager } = makeManager();
  assert.equal(manager.startOperation("node:nope", { action: "start", modelKey: "ollama|11434|x" }).status, 404);
  await manager.inventory("node:spark1");
  const r = manager.startOperation("node:spark1", { action: "start", modelKey: "ollama|11434|not-there" });
  assert.equal(r.status, 404);
  assert.equal(r.code, "unknown_model");
});

test("logs: launcher output, and none for an engine without logs", async () => {
  const { manager } = makeManager();
  const l = await manager.logs("node:spark1", "launch-profile|launcher:qwen|qwen");
  assert.equal(l.source, "launcher");
  assert.deepEqual(l.lines.map((x) => x.text), ["vllm serve", "ready"]);
  const other = await manager.logs("node:spark1", "launch-profile|launcher:other|other");
  assert.equal(other.source, "launcher");
  assert.deepEqual(other.lines, []);
  assert.ok(other.note);
  const none = await manager.logs("node:spark1", "ollama|11434|llama3.1:8b");
  assert.equal(none.source, "none");
  assert.ok(none.note);
  const notMac = await manager.logs("node:spark1", "mac-profile|mac:mlx|some-model");
  assert.equal(notMac.source, "none");
  assert.equal(await manager.logs("node:nope", null), null);
});

test("clusters: suggestions, launcher existence, and pruning on unit removal", () => {
  const { manager, registry } = makeManager();
  const { suggestions } = manager.listClusters();
  assert.equal(suggestions.length, 1);
  assert.deepEqual(suggestions[0].memberIds, ["spark1", "spark2"]);
  assert.equal(manager.launcherExists("spark1", "qwen"), true);
  assert.equal(manager.launcherExists("spark2", "qwen"), false);
  assert.equal(manager.launcherExists("spark1", "../x"), false);
  const created = manager.createCluster({
    name: "Sparks",
    kind: "distributed",
    memberIds: ["spark1", "spark2"],
    headId: "spark1",
    endpoint: { host: null, port: 8000 },
    engine: "vllm",
    launcherId: "qwen",
  });
  assert.equal(created.ok, true, created.error);
  assert.equal(manager.listClusters().suggestions.length, 0);
  registry.list.splice(1, 1);
  manager.onRegistryChange("remove", { id: "spark2" });
  assert.deepEqual(manager.listClusters().clusters, [], "a cluster left with one member is removed");
});

test("status reflects the settings flags and lists adapters", () => {
  const { manager } = makeManager({ getSettings: () => ({ fleetModelsEnabled: false, smartRoutingEnabled: "yes" }) });
  const s = manager.status();
  assert.equal(s.enabled, false);
  assert.equal(s.smartRoutingEnabled, false);
  assert.ok(s.adapters.some((a) => a.engine === "ollama"));
});

test("shutdown stops waiting on running operations", async () => {
  const { manager, ollama } = makeManager();
  ollama.loaded.clear();
  // phi3 never appears in /api/ps: the load "succeeds" but readiness never comes.
  manager.fetchImpl = fakeFetch({
    "GET http://10.0.0.1:11434/api/tags": { body: { models: [{ name: "phi3:mini" }] } },
    "GET http://10.0.0.1:11434/api/ps": { body: { models: [] } },
    "POST http://10.0.0.1:11434/api/generate": { body: {} },
  });
  const res = manager.startOperation("node:spark1", { action: "start", modelKey: "ollama|11434|phi3:mini" });
  assert.equal(res.ok, true);
  await new Promise((r) => setTimeout(r, 30));
  manager.shutdown();
  const read = await settle(manager, res.operation.id);
  assert.equal(read.operation.status, "cancelled");
});

test("smart-routing helpers: cached inventories, background refresh only while routing is on, apiKeyFor", async () => {
  let routing = false;
  const { manager, ollama } = makeManager({ getSettings: () => ({ fleetModelsEnabled: true, smartRoutingEnabled: routing }) });
  assert.deepEqual(manager.cachedInventories(), []);
  assert.equal(await manager.backgroundRefresh(), false);
  assert.equal(ollama.fetchImpl.calls.length, 0, "no discovery while smart routing is off");
  routing = true;
  assert.equal(await manager.backgroundRefresh(), true);
  assert.deepEqual(manager.cachedInventories().map((i) => i.targetId).sort(), ["node:spark1", "node:spark2"]);
  assert.equal(manager.apiKeyFor("node:spark1", 11434), "secret-key");
  assert.equal(manager.apiKeyFor("node:spark2", 8000), null);
  assert.equal(manager.apiKeyFor("node:nope", 1), null);
  manager.shutdown();
});

test("servingCount and servingModels only come from recent inventories (90 s window)", async () => {
  let t = 1_000_000;
  const { manager } = makeManager({ now: () => t });
  assert.equal(manager.targets().targets[0].servingModels, null, "no inventory: unknown");
  await manager.inventory("node:spark1");
  assert.equal(manager.targets().targets[0].servingCount, 1);
  assert.deepEqual(manager.targets().targets[0].servingModels, ["llama3.1:8b"]);
  t += 89_999;
  assert.equal(manager.targets().targets[0].servingCount, 1, "still within the background cadence window");
  t += 1;
  assert.equal(manager.targets().targets[0].servingCount, null, "an inventory 90 s old counts as absent");
  assert.equal(manager.targets().targets[0].servingModels, null);
});

test("runtimes carry how their endpoint was reached", async () => {
  const { manager } = makeManager({
    resolveTarget: async (unit, port) => ({ host: unit.lanIp, port, via: "ssh-tunnel", close: () => {} }),
  });
  const inv = await manager.inventory("node:spark1");
  const rt = inv.runtimes.find((r) => r.port === 11434);
  assert.equal(rt.via, "ssh-tunnel");
  assert.equal(manager.cachedInventories()[0].runtimes.find((r) => r.port === 11434).via, "ssh-tunnel");
  const { manager: direct } = makeManager();
  const inv2 = await direct.inventory("node:spark1");
  assert.equal(inv2.runtimes.find((r) => r.port === 11434).via, "direct");
});

test("operations read fresh launcher statuses; inventory reads may use the shared cache", async () => {
  const cachedCalls = [];
  const { manager } = makeManager({ launcherStatuses: async (spark, ls) => (cachedCalls.push(spark.id), Object.fromEntries(ls.map((l) => [l.id, "running"]))) });
  const fresh = await manager._launchersApi({ fresh: true }).statuses({ id: "spark1" }, [{ id: "qwen" }]);
  assert.deepEqual(fresh, { qwen: "stopped" }, "fresh reads go to the LauncherManager");
  assert.equal(cachedCalls.length, 0);
  const cached = await manager._launchersApi().statuses({ id: "spark1" }, [{ id: "qwen" }]);
  assert.deepEqual(cached, { qwen: "running" });
  assert.equal(cachedCalls.length, 1);
});

// ─── reliability: cache generations, single collection per target, tunnels, background ────

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Replace the manager's collector with controllable collections. */
function controlledCollect(manager) {
  const collects = [];
  manager._collect = (targetId, opts) => {
    const d = deferred();
    collects.push({ targetId, opts, ...d });
    return d.promise;
  };
  return collects;
}

const fakeInv = (tag, extra = {}) => ({
  targetId: "node:spark1",
  collectedAt: 1,
  reachable: true,
  runtimes: [],
  models: [{ modelKey: `ollama|11434|${tag}`, modelId: tag, label: tag, engine: "ollama", port: 11434, state: "serving", sources: ["api"], endpoint: "http://10.0.0.1:11434" }],
  clusterModels: [],
  errors: [],
  stale: false,
  tag,
  ...extra,
});

const tick = () => new Promise((r) => setImmediate(r));

test("a refresh never joins a collection that started before it, and that older result is not cached", async () => {
  const { manager } = makeManager();
  const collects = controlledCollect(manager);
  const plain = manager.inventory("node:spark1");
  await tick();
  assert.equal(collects.length, 1);
  assert.equal(collects[0].opts.force, false);
  const refreshA = manager.inventory("node:spark1", { refresh: true });
  const refreshB = manager.inventory("node:spark1", { refresh: true });
  await tick();
  assert.equal(collects.length, 1, "the refresh waits instead of stacking a second collection");
  collects[0].resolve(fakeInv("old"));
  assert.equal((await plain).tag, "old", "the plain read gets the collection it joined");
  await tick();
  assert.equal(collects.length, 2, "then one collection for both refreshes");
  assert.equal(collects[1].opts.force, true);
  assert.equal(manager.cache.has("node:spark1"), false, "a result that started before the refresh is not cached");
  collects[1].resolve(fakeInv("new"));
  assert.equal((await refreshA).tag, "new");
  assert.equal((await refreshB).tag, "new");
  assert.equal(manager.cache.get("node:spark1").inv.tag, "new");
  assert.equal((await manager.inventory("node:spark1")).tag, "new", "served from the cache");
  assert.equal(collects.length, 2);
});

test("an invalidation during a pending collection keeps its result out of the cache", async () => {
  const { manager } = makeManager();
  const collects = controlledCollect(manager);
  const first = manager.inventory("node:spark1");
  await tick();
  // An operation changes phase on the target (the runner's onChange hook).
  manager.runner.host.onChange(["node:spark1"]);
  collects[0].resolve(fakeInv("before-change"));
  assert.equal((await first).tag, "before-change");
  assert.equal(manager.cache.has("node:spark1"), false, "the pre-change result is not cached");
  assert.equal(manager.targets().targets[0].servingCount, null, "and never feeds the target list");
  const second = manager.inventory("node:spark1");
  await tick();
  assert.equal(collects.length, 2, "the next read collects again");
  collects[1].resolve(fakeInv("after-change"));
  assert.equal((await second).tag, "after-change");
  assert.equal(manager.cache.get("node:spark1").inv.tag, "after-change");
});

test("a hung collection times out for callers but stays pending: no second collection stacks on it", async () => {
  const { manager } = makeManager({ collectTimeoutMs: 40 });
  const collects = controlledCollect(manager);
  const a = await manager.inventory("node:spark1");
  assert.equal(a.reachable, null);
  assert.match(a.errors[0], /timed out/);
  assert.equal(collects.length, 1);
  const b = await manager.inventory("node:spark1");
  assert.match(b.errors[0], /timed out/, "answered at once with the timeout");
  const c = await manager.inventory("node:spark1", { refresh: true });
  assert.match(c.errors[0], /timed out/, "a refresh does not stack on a hung unit either");
  assert.equal(collects.length, 1, "still one collection in flight");
  collects[0].resolve(fakeInv("late"));
  await tick();
  assert.equal(manager.pending.has("node:spark1"), false, "the entry goes once the collection settles");
  assert.equal(manager.cache.has("node:spark1"), false, "the refresh bumped the generation: the late result is not cached");
  const d = manager.inventory("node:spark1");
  await tick();
  assert.equal(collects.length, 2, "a new collection starts once the hung one settled");
  collects[1].resolve(fakeInv("next"));
  assert.equal((await d).tag, "next");
});

test("a late result of a timed-out collection is cached when nothing invalidated it", async () => {
  const { manager } = makeManager({ collectTimeoutMs: 40 });
  const collects = controlledCollect(manager);
  const a = await manager.inventory("node:spark1");
  assert.match(a.errors[0], /timed out/);
  collects[0].resolve(fakeInv("late"));
  await tick();
  assert.equal((await manager.inventory("node:spark1")).tag, "late");
  assert.equal(collects.length, 1);
});

test("a hung refresh with a cached inventory serves the cache as stale", async () => {
  const { manager } = makeManager({ collectTimeoutMs: 40 });
  const collects = controlledCollect(manager);
  const p = manager.inventory("node:spark1");
  await tick();
  collects[0].resolve(fakeInv("cached"));
  await p;
  const out = await manager.inventory("node:spark1", { refresh: true });
  assert.equal(out.stale, true);
  assert.equal(out.tag, "cached");
  assert.ok(out.errors.some((e) => /timed out/.test(e)));
});

test("consecutive collections reuse one pooled SSH tunnel; the idle TTL and shutdown close it", async () => {
  let t = 1_000_000;
  const tunnels = { opened: 0, closed: 0, opts: [] };
  const { manager } = makeManager({
    now: () => t,
    resolveTarget: async (unit, port, opts) => {
      tunnels.opened += 1;
      tunnels.opts.push(opts);
      return { host: unit.lanIp, port, via: "ssh-tunnel", close: () => (tunnels.closed += 1) };
    },
    tunnelPool: { idleMs: 60, isAlive: async () => true },
  });
  const a = await manager.inventory("node:spark1");
  assert.equal(a.runtimes.find((r) => r.port === 11434).via, "ssh-tunnel");
  t += 10_001; // past the inventory TTL
  await manager.inventory("node:spark1");
  t += 10_001;
  await manager.inventory("node:spark1");
  assert.equal(tunnels.opened, 1, "three collections, one SSH process");
  assert.equal(tunnels.closed, 0);
  assert.equal(tunnels.opts[0].apiKey, "secret-key");
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(tunnels.closed, 1, "closed after the idle TTL");
  t += 10_001;
  await manager.inventory("node:spark1");
  assert.equal(tunnels.opened, 2);
  assert.equal(tunnels.opts[1].skipDirect, true, "a known tunnel-only port is reopened without the direct probe");
  manager.shutdown();
  assert.equal(tunnels.closed, 2, "shutdown closes the pooled tunnel");
});

test("a port that answers neither way backs off; an operation's fresh check still tries", async () => {
  let t = 1_000_000;
  let calls = 0;
  const { manager, registry } = makeManager({
    now: () => t,
    resolveTarget: async () => {
      calls += 1;
      throw new Error("not reachable over the LAN, and SSH tunnel failed");
    },
    tunnelPool: { backoffMinMs: 30_000 },
  });
  const a = await manager.inventory("node:spark1");
  assert.ok(a.errors.some((e) => /SSH tunnel failed/.test(e)));
  assert.equal(calls, 1);
  t += 10_001;
  const b = await manager.inventory("node:spark1");
  assert.ok(b.errors.some((e) => /next attempt in/.test(e)), "backing off: no new probe or tunnel");
  assert.equal(calls, 1);
  // An operation's scope is fresh: it ignores the backoff.
  const scope = manager.runner.host.openScope();
  await assert.rejects(scope.resolveBaseUrl(registry.getSpark("spark1"), 11434));
  scope.close();
  assert.equal(calls, 2);
});

/** Advance mocked timers and let a background pass (fake fetches) finish. */
async function advance(t, manager, ms) {
  t.mock.timers.tick(ms);
  for (let i = 0; i < 100 && manager.backgroundRunning; i += 1) await tick();
  await tick();
}

test("background refresh runs at the view cadence while the fleet API is read, even with routing off", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 5_000_000 });
  const { manager, ollama } = makeManager({ now: () => Date.now(), backgroundRefreshMs: 30_000 });
  t.after(() => manager.shutdown());
  const passes = () => ollama.fetchImpl.calls.filter((c) => c.url.endsWith("/api/ps")).length;
  await advance(t, manager, 30_000);
  assert.equal(passes(), 0, "nobody reads the API and routing is off: no background work");
  manager.noteRead();
  await advance(t, manager, 30_000);
  assert.equal(passes(), 1, "a pass runs while the API is being read");
  assert.equal(manager.targets().targets[0].servingCount, 1, "so the target list knows what is serving");
  await advance(t, manager, 30_000);
  assert.equal(passes(), 1, "30 s later: not yet (60 s cadence without routing)");
  await advance(t, manager, 30_000);
  assert.equal(passes(), 2);
  assert.deepEqual(manager.targets().targets[0].servingModels, ["llama3.1:8b"]);
  // Reads stopped at the first noteRead: passes stop 2 minutes after it.
  await advance(t, manager, 60_000);
  assert.equal(passes(), 2, "the last read was 150 s ago");
  await advance(t, manager, 60_000);
  assert.equal(passes(), 2);
  assert.equal(manager.targets().targets[0].servingCount, null, "and the counts go back to unknown");
});

test("background refresh keeps its 30 s cadence while smart routing is on", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 5_000_000 });
  const { manager, ollama } = makeManager({
    now: () => Date.now(),
    backgroundRefreshMs: 30_000,
    getSettings: () => ({ fleetModelsEnabled: true, smartRoutingEnabled: true }),
  });
  t.after(() => manager.shutdown());
  const passes = () => ollama.fetchImpl.calls.filter((c) => c.url.endsWith("/api/ps")).length;
  for (let i = 1; i <= 3; i += 1) {
    await advance(t, manager, 30_000);
    assert.equal(passes(), i);
  }
});

test("operations list: running and recent ones newest first; activeOperationId on the target and its cluster", async () => {
  let t = 1_000_000;
  const { manager, ollama } = makeManager({ now: () => t });
  const created = manager.createCluster({ id: "duo", name: "Duo", kind: "distributed", memberIds: ["spark1", "spark2"], headId: "spark1", endpoint: { host: null, port: 11434 }, engine: "ollama" });
  assert.equal(created.ok, true, created.error);
  ollama.loaded.clear();
  // phi3 never becomes ready: the operation keeps running while we look.
  manager.fetchImpl = fakeFetch({
    "GET http://10.0.0.1:11434/api/tags": { body: { models: [{ name: "phi3:mini" }] } },
    "GET http://10.0.0.1:11434/api/ps": { body: { models: [] } },
    "POST http://10.0.0.1:11434/api/generate": { body: {} },
  });
  const res = manager.startOperation("node:spark1", { action: "start", modelKey: "ollama|11434|phi3:mini" });
  assert.equal(res.ok, true, res.error);
  const id = res.operation.id;
  const byId = Object.fromEntries(manager.targets().targets.map((x) => [x.targetId, x]));
  assert.equal(byId["node:spark1"].activeOperationId, id);
  assert.equal(byId["node:spark1"].busy, true);
  assert.equal(byId["cluster:duo"].activeOperationId, id, "a member node's operation shows on its cluster");
  assert.equal(byId["cluster:duo"].busy, true, "and blocks it, as isBusy() says");
  assert.equal(manager.isBusy("cluster:duo"), true);
  assert.equal(byId["node:spark2"].activeOperationId, null);
  assert.equal(byId["node:spark2"].busy, false);
  assert.deepEqual(manager.listOperations({ activeOnly: true }).operations.map((o) => o.id), [id]);
  assert.deepEqual(manager.listOperations().operations[0], manager.readOperation(id).operation, "same shape as GET by id");
  manager.shutdown();
  const read = await settle(manager, id);
  assert.notEqual(read.operation.status, "running");
  assert.equal(manager.targets().targets[0].activeOperationId, null);
  assert.deepEqual(manager.listOperations({ activeOnly: true }).operations, []);
  assert.deepEqual(manager.listOperations().operations.map((o) => o.id), [id], "finished recently");
  t += 10 * 60_000 + 1;
  assert.deepEqual(manager.listOperations().operations, [], "older than 10 minutes");
});

test("each manager keeps its own memory of served models", async () => {
  const a = makeManager({ servedKeys: undefined }).manager;
  const b = makeManager({ servedKeys: undefined }).manager;
  await a.inventory("node:spark1");
  assert.ok(a.servedKeys.size > 0);
  assert.equal(b.servedKeys.size, 0, "nothing leaks into another manager");
  assert.notEqual(a.servedKeys, b.servedKeys);
});

test("an abandoned collection that settles after its replacement never overwrites the cache", async () => {
  let t = 1_000_000;
  const { manager } = makeManager({ now: () => t, collectTimeoutMs: 40 });
  const collects = controlledCollect(manager);
  const a = await manager.inventory("node:spark1");
  assert.match(a.errors[0], /timed out/);
  t += 5 * 40 + 1; // past the abandon horizon
  const b = manager.inventory("node:spark1");
  await tick();
  assert.equal(collects.length, 2, "a replacement starts");
  collects[1].resolve(fakeInv("new"));
  assert.equal((await b).tag, "new");
  collects[0].resolve(fakeInv("old"));
  await tick();
  assert.equal(manager.cache.get("node:spark1").inv.tag, "new", "the abandoned result is dropped");
});
