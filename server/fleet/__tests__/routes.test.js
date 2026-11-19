import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { registerFleetRoutes, isValidModelKey } from "../routes.js";

/** Express app with the fleet routes only, over a fake manager. */
const settings = { fleetModelsEnabled: true, smartRoutingEnabled: false };
let limitChanges = false;
let limitCancels = false;
let tokenOn = true;
let changeTokensSpent = 0;
const calls = [];
const clusters = new Map([
  ["pair", { id: "pair", name: "Pair", kind: "group", memberIds: ["spark1", "spark2"], headId: "spark1", endpoint: null, engine: null, launcherId: null, notes: "" }],
]);
const busy = new Set();
const OP = {
  id: "op-0123456789ab",
  targetId: "node:spark1",
  action: "switch",
  modelKey: "ollama|11434|phi3:mini",
  fromModelKey: null,
  status: "running",
  step: "reachable",
  steps: [],
  startedAt: 1,
  finishedAt: null,
  error: null,
};
const LINES = [1, 2, 3].map((seq) => ({ seq, text: `line ${seq}` }));

const manager = {
  hasTarget: (id) => ["node:spark1", "node:spark2", "cluster:pair"].includes(id),
  targets: () => ({ targets: [{ targetId: "node:spark1" }], generatedAt: 5 }),
  inventory: async (id, opts) => {
    calls.push(["inventory", id, opts]);
    return { targetId: id, collectedAt: 1, reachable: true, runtimes: [], models: [], clusterModels: [], errors: [], stale: false };
  },
  startOperation: (id, body) => {
    calls.push(["start", id, body]);
    if (busy.has(id)) return { ok: false, status: 409, code: "busy", error: "another operation is running on this target" };
    if (body.modelKey.endsWith("|missing")) return { ok: false, status: 404, code: "unknown_model", error: "model not found" };
    return { ok: true, operation: { ...OP, targetId: id, action: body.action, modelKey: body.modelKey } };
  },
  readOperation: (id, since) => (id === OP.id ? { operation: OP, lines: LINES.filter((l) => l.seq >= since), nextSeq: 4 } : null),
  cancelOperation: (id) =>
    id === OP.id
      ? { cancelled: true }
      : id === "op-aaaaaaaaaaaa"
        ? { cancelled: false, reason: "Cancel is only possible while waiting for readiness" }
        : null,
  logs: async (id, mk) => ({ source: "none", lines: [], note: `no logs for ${mk}` }),
  listClusters: () => ({ clusters: [...clusters.values()], suggestions: [] }),
  getCluster: (id) => clusters.get(id) ?? null,
  isBusy: (id) => busy.has(id),
  launcherExists: (unitId, launcherId) => unitId === "spark1" && launcherId === "ray-head",
  createCluster: (body) => {
    calls.push(["createCluster", body]);
    if (body.name === "dup") return { ok: false, code: "conflict", error: "Cluster dup already exists" };
    if (!Array.isArray(body.memberIds)) return { ok: false, code: "validation", error: "memberIds must be an array of unit ids" };
    const c = { id: body.id ?? "new", notes: "", endpoint: null, engine: null, launcherId: null, ...body };
    clusters.set(c.id, c);
    return { ok: true, cluster: c };
  },
  updateCluster: (id, patch) => {
    const c = { ...clusters.get(id), ...patch, id };
    clusters.set(id, c);
    return { ok: true, cluster: c };
  },
  removeCluster: (id) => clusters.delete(id),
};

let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  registerFleetRoutes(app, {
    manager,
    getSettings: () => settings,
    allowRead: () => true,
    allowChange: () => {
      changeTokensSpent += 1;
      return !limitChanges;
    },
    allowCancel: () => !limitCancels,
    rejectLimited: (res, message) => res.status(429).json({ error: message }),
    hasToken: () => tokenOn,
    requireToken: true,
  });
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

async function call(method, p, body) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test("status is always available and reflects the flags", async () => {
  settings.fleetModelsEnabled = false;
  try {
    const r = await call("GET", "/api/fleet/status");
    assert.equal(r.status, 200);
    assert.equal(r.body.enabled, false);
    assert.equal(r.body.smartRoutingEnabled, false);
    assert.ok(r.body.adapters.some((a) => a.engine === "lmstudio" && typeof a.capabilities.multiModel === "boolean"));
  } finally {
    settings.fleetModelsEnabled = true;
  }
});

test("every other route answers 404 while the feature is off", async () => {
  settings.fleetModelsEnabled = false;
  try {
    for (const [m, p] of [
      ["GET", "/api/fleet/targets"],
      ["GET", "/api/fleet/targets/node:spark1/inventory"],
      ["POST", "/api/fleet/targets/node:spark1/operations"],
      ["GET", "/api/fleet/targets/node:spark1/logs"],
      ["GET", "/api/fleet/clusters"],
      ["POST", "/api/fleet/clusters"],
      ["PUT", "/api/fleet/clusters/pair"],
      ["DELETE", "/api/fleet/clusters/pair"],
      ["GET", "/api/fleet/routing"],
    ]) {
      const r = await call(m, p, m === "POST" || m === "PUT" ? {} : undefined);
      assert.equal(r.status, 404, `${m} ${p}`);
      assert.equal(typeof r.body.error, "string");
    }
  } finally {
    settings.fleetModelsEnabled = true;
  }
});

test("targets and inventory", async () => {
  assert.deepEqual((await call("GET", "/api/fleet/targets")).body, { targets: [{ targetId: "node:spark1" }], generatedAt: 5 });
  calls.length = 0;
  const inv = await call("GET", "/api/fleet/targets/node:spark1/inventory?refresh=1");
  assert.equal(inv.status, 200);
  assert.deepEqual(calls[0], ["inventory", "node:spark1", { refresh: true }]);
  assert.equal((await call("GET", "/api/fleet/targets/node:spark1/inventory?refresh=yes")).status, 400);
  assert.equal((await call("GET", "/api/fleet/targets/node:nope/inventory")).status, 404);
  assert.equal((await call("GET", "/api/fleet/targets/bogus/inventory")).status, 400);
  assert.equal((await call("GET", `/api/fleet/targets/${encodeURIComponent("node:a b")}/inventory`)).status, 400);
});

test("POST operations: 202, validation 400, busy 409, unknown 404", async () => {
  const ok = await call("POST", "/api/fleet/targets/node:spark1/operations", { action: "switch", modelKey: "ollama|11434|phi3:mini", force: true });
  assert.equal(ok.status, 202);
  assert.equal(ok.body.operation.action, "switch");
  assert.deepEqual(calls.at(-1)[2], { action: "switch", modelKey: "ollama|11434|phi3:mini", force: true, rollback: true });

  const bad = [
    { action: "explode", modelKey: "ollama|11434|phi3:mini" },
    { action: "start" },
    { action: "start", modelKey: "ollama|11434|$(rm -rf /)" },
    { action: "start", modelKey: "ollama|11434|../../etc" },
    { action: "start", modelKey: "ollama|99999|phi3" },
    { action: "start", modelKey: "nopipes" },
    { action: "start", modelKey: "ollama|11434|phi3:mini", force: "true" },
    { action: "start", modelKey: "ollama|11434|phi3:mini", rollback: 1 },
    { action: "start", modelKey: "ollama|11434|phi3:mini", extra: 1 },
  ];
  for (const body of bad) {
    const r = await call("POST", "/api/fleet/targets/node:spark1/operations", body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.code, "validation");
  }
  assert.equal((await call("POST", "/api/fleet/targets/node:spark1/operations", "[1]")).status, 400);

  busy.add("node:spark2");
  try {
    const r = await call("POST", "/api/fleet/targets/node:spark2/operations", { action: "start", modelKey: "ollama|11434|phi3:mini" });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "busy");
  } finally {
    busy.delete("node:spark2");
  }
  assert.equal((await call("POST", "/api/fleet/targets/node:spark1/operations", { action: "start", modelKey: "ollama|11434|missing" })).status, 404);
  assert.equal((await call("POST", "/api/fleet/targets/node:nope/operations", { action: "start", modelKey: "ollama|11434|phi3:mini" })).status, 404);
});

test("mutating routes are rate limited", async () => {
  limitChanges = true;
  try {
    const r = await call("POST", "/api/fleet/targets/node:spark1/operations", { action: "start", modelKey: "ollama|11434|phi3:mini" });
    assert.equal(r.status, 429);
    assert.equal((await call("DELETE", `/api/fleet/operations/${OP.id}`)).status, 200, "cancel has its own bucket");
  } finally {
    limitChanges = false;
  }
  limitCancels = true;
  try {
    assert.equal((await call("DELETE", `/api/fleet/operations/${OP.id}`)).status, 429);
  } finally {
    limitCancels = false;
  }
});

test("operation read with since, cancel, and id validation", async () => {
  const all = await call("GET", `/api/fleet/operations/${OP.id}`);
  assert.equal(all.status, 200);
  assert.equal(all.body.lines.length, 3);
  assert.equal(all.body.nextSeq, 4);
  const tail = await call("GET", `/api/fleet/operations/${OP.id}?since=3`);
  assert.deepEqual(tail.body.lines, [{ seq: 3, text: "line 3" }]);
  assert.equal((await call("GET", `/api/fleet/operations/${OP.id}?since=-1`)).status, 400);
  assert.equal((await call("GET", `/api/fleet/operations/${OP.id}?since=abc`)).status, 400);
  assert.equal((await call("GET", "/api/fleet/operations/op-ffffffffffff")).status, 404);
  assert.equal((await call("GET", "/api/fleet/operations/not-an-id")).status, 400);
  assert.deepEqual((await call("DELETE", `/api/fleet/operations/${OP.id}`)).body, { cancelled: true });
  assert.equal((await call("DELETE", "/api/fleet/operations/op-ffffffffffff")).status, 404);
});

test("logs validate the model key", async () => {
  const ok = await call("GET", `/api/fleet/targets/node:spark1/logs?modelKey=${encodeURIComponent("launch-profile|launcher:ray-head|ray-head")}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.source, "none");
  assert.equal((await call("GET", `/api/fleet/targets/node:spark1/logs?modelKey=${encodeURIComponent("x|y|`id`")}`)).status, 400);
  assert.equal((await call("GET", "/api/fleet/targets/node:spark1/logs")).status, 200);
});

test("cluster CRUD with status codes", async () => {
  const list = await call("GET", "/api/fleet/clusters");
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body.clusters) && Array.isArray(list.body.suggestions));

  const created = await call("POST", "/api/fleet/clusters", { id: "trio", name: "Trio", kind: "group", memberIds: ["spark1", "spark2"] });
  assert.equal(created.status, 201);
  assert.equal(created.body.cluster.id, "trio");
  assert.equal((await call("POST", "/api/fleet/clusters", { name: "dup", kind: "group", memberIds: [] })).status, 409);
  assert.equal((await call("POST", "/api/fleet/clusters", { name: "x", kind: "group", memberIds: "spark1" })).status, 400);
  assert.equal((await call("POST", "/api/fleet/clusters", { name: "x", kind: "group", memberIds: [], secret: 1 })).status, 400);

  const updated = await call("PUT", "/api/fleet/clusters/trio", { name: "Trio 2" });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.cluster.name, "Trio 2");
  assert.equal((await call("PUT", "/api/fleet/clusters/nope", { name: "x" })).status, 404);
  assert.equal((await call("PUT", "/api/fleet/clusters/Bad_Id", { name: "x" })).status, 400);

  busy.add("cluster:trio");
  try {
    assert.equal((await call("DELETE", "/api/fleet/clusters/trio")).status, 409);
    assert.equal((await call("PUT", "/api/fleet/clusters/trio", { name: "x" })).status, 409);
  } finally {
    busy.delete("cluster:trio");
  }
  assert.deepEqual((await call("DELETE", "/api/fleet/clusters/trio")).body, { removed: true });
  assert.equal((await call("DELETE", "/api/fleet/clusters/trio")).status, 404);
});

test("a distributed cluster's launcherId must exist on its head unit", async () => {
  const body = {
    id: "dist",
    name: "Dist",
    kind: "distributed",
    memberIds: ["spark1", "spark2"],
    headId: "spark1",
    endpoint: { host: null, port: 8000 },
    engine: "vllm",
    launcherId: "ray-missing",
  };
  const bad = await call("POST", "/api/fleet/clusters", body);
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /ray-missing does not exist on spark1/);
  const wrongHead = await call("POST", "/api/fleet/clusters", { ...body, headId: "spark2", launcherId: "ray-head" });
  assert.equal(wrongHead.status, 400);
  const ok = await call("POST", "/api/fleet/clusters", { ...body, launcherId: "ray-head" });
  assert.equal(ok.status, 201);
  // PUT checks the merged record: moving the head away from the launcher's unit is refused.
  assert.equal((await call("PUT", "/api/fleet/clusters/dist", { headId: "spark2" })).status, 400);
  assert.equal((await call("PUT", "/api/fleet/clusters/dist", { launcherId: null })).status, 200);
});

test("isValidModelKey", () => {
  assert.equal(isValidModelKey("ollama|11434|llama3.1:8b"), true);
  assert.equal(isValidModelKey("launch-profile|launcher:qwen-a|qwen-a"), true);
  assert.equal(isValidModelKey("mac-profile|mac:mlx lm|mlx-community/Qwen3-8B-4bit"), true);
  assert.equal(isValidModelKey("ollama|0|x"), false);
  assert.equal(isValidModelKey("Ollama|11434|x"), false);
  assert.equal(isValidModelKey("ollama|11434|a b"), false);
  assert.equal(isValidModelKey("ollama|11434|x\n"), false);
  assert.equal(isValidModelKey(42), false);
});

test("a running operation stays observable and cancellable while the feature is off", async () => {
  settings.fleetModelsEnabled = false;
  try {
    assert.equal((await call("GET", `/api/fleet/operations/${OP.id}`)).status, 200);
    assert.deepEqual((await call("DELETE", `/api/fleet/operations/${OP.id}`)).body, { cancelled: true });
    const post = await call("POST", "/api/fleet/targets/node:spark1/operations", { action: "start", modelKey: "ollama|11434|phi3:mini" });
    assert.equal(post.status, 404);
  } finally {
    settings.fleetModelsEnabled = true;
  }
});

test("a refused cancel passes its reason through", async () => {
  const r = await call("DELETE", "/api/fleet/operations/op-aaaaaaaaaaaa");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { cancelled: false, reason: "Cancel is only possible while waiting for readiness" });
});

test("validation failures never spend a change token", async () => {
  const before = changeTokensSpent;
  assert.equal((await call("POST", "/api/fleet/targets/node:spark1/operations", { action: "boom", modelKey: "x" })).status, 400);
  assert.equal((await call("POST", "/api/fleet/clusters", { name: "x", kind: "group", memberIds: [], junk: true })).status, 400);
  assert.equal((await call("PUT", "/api/fleet/clusters/pair", "[]")).status, 400);
  assert.equal(changeTokensSpent, before);
  assert.equal((await call("POST", "/api/fleet/targets/node:spark1/operations", { action: "start", modelKey: "ollama|11434|phi3:mini" })).status, 202);
  assert.equal(changeTokensSpent, before + 1);
});

test("fleet control needs a dashboard token; reads do not", async () => {
  tokenOn = false;
  try {
    const status = await call("GET", "/api/fleet/status");
    assert.equal(status.body.controlRequiresToken, true);
    assert.equal(status.body.tokenConfigured, false);
    for (const [m, p, body] of [
      ["POST", "/api/fleet/targets/node:spark1/operations", { action: "start", modelKey: "ollama|11434|phi3:mini" }],
      ["DELETE", `/api/fleet/operations/${OP.id}`],
      ["POST", "/api/fleet/clusters", { name: "T", kind: "group", memberIds: ["spark1", "spark2"] }],
      ["PUT", "/api/fleet/clusters/pair", { name: "x" }],
      ["DELETE", "/api/fleet/clusters/pair"],
    ]) {
      const r = await call(m, p, body);
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.equal(r.body.code, "token_required");
      assert.match(r.body.error, /SPARKDASH_TOKEN/);
    }
    assert.equal((await call("GET", "/api/fleet/targets")).status, 200);
    assert.equal((await call("GET", "/api/fleet/clusters")).status, 200);
    assert.equal((await call("GET", `/api/fleet/operations/${OP.id}`)).status, 200);
  } finally {
    tokenOn = true;
  }
  assert.equal((await call("GET", "/api/fleet/status")).body.tokenConfigured, true);
});

test("the explicit opt-out allows control without a token", async () => {
  const app = express();
  app.use(express.json());
  const warn = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    registerFleetRoutes(app, { manager, getSettings: () => settings, hasToken: () => false, requireToken: false });
  } finally {
    console.warn = warn;
  }
  assert.ok(warnings.some((w) => /SPARKDASH_FLEET_ALLOW_NO_TOKEN/.test(w)));
  const srv = await new Promise((resolve) => {
    const x = app.listen(0, "127.0.0.1", () => resolve(x));
  });
  try {
    const url = `http://127.0.0.1:${srv.address().port}`;
    const status = await (await fetch(`${url}/api/fleet/status`)).json();
    assert.equal(status.controlRequiresToken, false);
    const res = await fetch(`${url}/api/fleet/targets/node:spark1/operations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "start", modelKey: "ollama|11434|phi3:mini" }),
    });
    assert.equal(res.status, 202);
  } finally {
    srv.close();
  }
});
