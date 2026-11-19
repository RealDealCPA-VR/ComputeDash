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

test("servingCount only comes from recent inventories", async () => {
  let t = 1_000_000;
  const { manager } = makeManager({ now: () => t });
  await manager.inventory("node:spark1");
  assert.equal(manager.targets().targets[0].servingCount, 1);
  t += 2 * 10_000 + 1;
  assert.equal(manager.targets().targets[0].servingCount, null, "an inventory older than 2x the TTL counts as absent");
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
