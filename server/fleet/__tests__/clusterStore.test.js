import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClusterStore, clusterCapabilities, normalizeEndpointHost } from "../clusterStore.js";

function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-clusters-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "config", "fleet-clusters.json");
}

const units = ["spark1", "spark2", "dell", "mac"];
const sparkCluster = {
  name: "Spark cluster",
  kind: "distributed",
  memberIds: ["spark1", "spark2"],
  headId: "spark1",
  endpoint: { host: null, port: 8000 },
  engine: "vllm",
  launcherId: null,
  notes: "",
};

test("add persists, derives a slug id, and reloads", (t) => {
  const file = tmpFile(t);
  const store = new ClusterStore({ file, getUnitIds: () => units });
  const r = store.add(sparkCluster);
  assert.equal(r.ok, true);
  assert.equal(r.cluster.id, "spark-cluster");
  const again = store.add({ ...sparkCluster, kind: "group", memberIds: ["dell", "mac"], headId: "dell" });
  assert.equal(again.ok, true);
  assert.equal(again.cluster.id, "spark-cluster-2");
  const reloaded = new ClusterStore({ file, getUnitIds: () => units });
  assert.deepEqual(reloaded.list().map((c) => c.id), ["spark-cluster", "spark-cluster-2"]);
  assert.deepEqual(reloaded.get("spark-cluster").endpoint, { host: null, port: 8000 });
});

test("validation rules", (t) => {
  const store = new ClusterStore({ file: tmpFile(t), getUnitIds: () => units });
  const bad = (patch, re) => {
    const r = store.add({ ...sparkCluster, ...patch });
    assert.equal(r.ok, false, JSON.stringify(patch));
    if (re) assert.match(r.error, re);
    return r;
  };
  bad({ id: "Bad Id" }, /id/);
  bad({ name: "" }, /Name/);
  bad({ name: "x".repeat(81) }, /too long/);
  bad({ kind: "mesh" }, /Kind/);
  bad({ memberIds: ["spark1"] }, /at least 2/);
  bad({ memberIds: ["spark1", "spark1"] }, /twice/);
  bad({ memberIds: ["spark1", "ghost"] }, /Unknown unit: ghost/);
  bad({ headId: "dell" }, /head/);
  bad({ headId: undefined }, /head/);
  bad({ endpoint: null }, /endpoint/);
  bad({ endpoint: { host: null, port: 0 } }, /port/);
  bad({ endpoint: { host: null, port: 70000 } }, /port/);
  bad({ endpoint: { host: "http://spark1", port: 8000 } }, /host/);
  bad({ endpoint: { host: "spark1/v1", port: 8000 } }, /host/);
  bad({ endpoint: { host: "spark 1", port: 8000 } }, /host/);
  bad({ endpoint: { host: "spark1:8000", port: 8000 } }, /host/);
  bad({ engine: "v llm" }, /Engine/);
  bad({ launcherId: "Bad_Id" }, /launcherId/);
  bad({ notes: "x".repeat(301) }, /Notes/);
  assert.equal(store.list().length, 0);
});

test("endpoint hosts: hostname, MagicDNS, IPv4, IPv6", () => {
  assert.equal(normalizeEndpointHost("spark1.tail1234.ts.net"), "spark1.tail1234.ts.net");
  assert.equal(normalizeEndpointHost("Spark-1"), "spark-1");
  assert.equal(normalizeEndpointHost("100.64.1.2"), "100.64.1.2");
  assert.equal(normalizeEndpointHost("fd7a:115c:a1e0::1"), "fd7a:115c:a1e0::1");
  assert.equal(normalizeEndpointHost("[fd7a:115c:a1e0::1]"), "fd7a:115c:a1e0::1");
  for (const bad of ["", "999.1.1.1", "https://x", "a/b", "a b", "a..b", "-a", "[nope]", "host:80", 7]) {
    assert.equal(normalizeEndpointHost(bad), null, String(bad));
  }
});

test("a unit belongs to at most one distributed cluster; groups may overlap", (t) => {
  const store = new ClusterStore({ file: tmpFile(t), getUnitIds: () => units });
  assert.equal(store.add(sparkCluster).ok, true);
  const dup = store.add({ ...sparkCluster, name: "Other", memberIds: ["spark2", "dell"], headId: "dell" });
  assert.equal(dup.ok, false);
  assert.equal(dup.code, "conflict");
  assert.match(dup.error, /spark2/);
  const group = store.add({ name: "All", kind: "group", memberIds: ["spark1", "spark2", "dell"] });
  assert.equal(group.ok, true);
  // A group is visual only: endpoint / engine / launcher are cleared, head defaults to the first member.
  assert.equal(group.cluster.endpoint, null);
  assert.equal(group.cluster.headId, "spark1");
  // Turning the group into a second distributed cluster over spark1 is refused.
  const upd = store.update(group.cluster.id, { kind: "distributed", endpoint: { host: null, port: 9000 } });
  assert.equal(upd.ok, false);
  assert.equal(upd.code, "conflict");
});

test("update merges, keeps the id; remove; not found", (t) => {
  const store = new ClusterStore({ file: tmpFile(t), getUnitIds: () => units });
  const { cluster } = /** @type {any} */ (store.add({ ...sparkCluster, id: "sparks" }));
  const r = store.update("sparks", { id: "renamed", name: "Sparks", launcherId: "vllm-ray-a1b2c3", endpoint: { host: "spark1.tail.ts.net", port: "8001" } });
  assert.equal(r.ok, true);
  assert.equal(r.cluster.id, "sparks");
  assert.equal(r.cluster.name, "Sparks");
  assert.deepEqual(r.cluster.endpoint, { host: "spark1.tail.ts.net", port: 8001 });
  assert.deepEqual(clusterCapabilities(r.cluster), { distributedControl: true, lifecycle: true });
  assert.deepEqual(clusterCapabilities(cluster), { distributedControl: false, lifecycle: false });
  assert.equal(store.update("nope", {}).code, "not_found");
  assert.equal(store.add({ ...sparkCluster, id: "sparks" }).code, "conflict");
  assert.equal(store.remove("sparks"), true);
  assert.equal(store.remove("sparks"), false);
});

test("pruneUnit drops members; removes clusters left with <2 members or a distributed cluster without its head", (t) => {
  const file = tmpFile(t);
  const store = new ClusterStore({ file, getUnitIds: () => units });
  store.add({ ...sparkCluster, id: "sparks" });
  store.add({ id: "three", name: "Three", kind: "group", memberIds: ["dell", "mac", "spark2"], headId: "mac" });
  store.add({ id: "pair", name: "Pair", kind: "group", memberIds: ["dell", "mac"], headId: "mac" });
  const r = store.pruneUnit("dell");
  assert.deepEqual(r, { updated: ["three"], removed: ["pair"] });
  assert.deepEqual(store.get("three").memberIds, ["mac", "spark2"]);
  assert.equal(store.get("three").headId, "mac");
  store.add({ id: "headless", name: "Headless", kind: "group", memberIds: ["mac", "spark1", "spark2"], headId: "mac" });
  // A group that loses its head keeps going with the first remaining member as head.
  assert.deepEqual(store.pruneUnit("mac"), { updated: ["headless"], removed: ["three"] });
  assert.equal(store.get("headless").headId, "spark1");
  assert.deepEqual(store.get("headless").memberIds, ["spark1", "spark2"]);
  assert.equal(new ClusterStore({ file, getUnitIds: () => units }).get("headless").headId, "spark1", "persisted");
  const r2 = store.pruneUnit("spark1");
  assert.deepEqual(r2.removed, ["sparks", "headless"], "distributed head removed → removed; group left with 1 → removed");
  const reloaded = new ClusterStore({ file, getUnitIds: () => units });
  assert.deepEqual(reloaded.list().map((c) => c.id), []);
  assert.deepEqual(store.pruneUnit("ghost"), { updated: [], removed: [] });
});

test("pruneMissingUnits reconciles with the registry", (t) => {
  let ids = units;
  const store = new ClusterStore({ file: tmpFile(t), getUnitIds: () => ids });
  store.add({ ...sparkCluster, id: "sparks" });
  store.add({ id: "trio", name: "Trio", kind: "group", memberIds: ["dell", "mac", "spark2"], headId: "mac" });
  ids = ["spark1", "mac", "dell"];
  const r = store.pruneMissingUnits();
  assert.deepEqual(r.removed, ["sparks"]);
  assert.deepEqual(r.updated, ["trio"]);
  ids = [];
  assert.deepEqual(store.pruneMissingUnits(), { updated: [], removed: [] }, "an empty registry prunes nothing");
});

test("corrupt file → starts empty without throwing, and keeps the bad file aside", (t) => {
  const file = tmpFile(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ not json");
  const origError = console.error;
  console.error = () => {};
  let store;
  try {
    store = new ClusterStore({ file, getUnitIds: () => units });
  } finally {
    console.error = origError;
  }
  assert.deepEqual(store.list(), []);
  assert.ok(fs.readdirSync(path.dirname(file)).some((f) => f.includes(".corrupt-")));
  // Invalid records inside a valid file are skipped individually.
  fs.writeFileSync(file, JSON.stringify({ clusters: [{ id: "x" }, { ...sparkCluster, id: "ok" }, "junk"] }));
  assert.deepEqual(new ClusterStore({ file, getUnitIds: () => units }).list().map((c) => c.id), ["ok"]);
  // A missing file is simply empty.
  fs.rmSync(file);
  assert.deepEqual(new ClusterStore({ file, getUnitIds: () => units }).list(), []);
});
