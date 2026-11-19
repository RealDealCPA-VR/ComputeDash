import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { registerFleetRoutingRoutes, targetHeaderValue } from "../routingRoutes.js";

const DASHBOARD_TOKEN = "dashboard-token-not-a-real-secret";
const ENGINE_KEY = "engine-key-not-a-real-secret";

function closer(server) {
  return () =>
    new Promise((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    });
}

/**
 * Fake engine on an ephemeral port, closed after the test. `handler(req, res, rec)` answers;
 * every request is recorded, and `closed` counts upstream responses whose connection closed.
 */
async function startUpstream(t, handler) {
  const seen = [];
  const state = { closed: 0, onClose: null };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const rec = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null };
      seen.push(rec);
      res.on("close", () => {
        state.closed += 1;
        state.onClose?.();
      });
      handler(req, res, rec);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(closer(server));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    seen,
    state,
    /** Resolves once `n` upstream responses have closed. */
    closedCount: (n) =>
      new Promise((r) => {
        const check = () => {
          if (state.closed >= n) r(state.closed);
        };
        state.onClose = check;
        check();
      }),
  };
}

/** A fetch that refuses connections to `deadBases` (as undici does) and delegates otherwise. */
function refusingFetch(deadBases) {
  return async (url, init) => {
    if (deadBases.some((b) => String(url).startsWith(b))) {
      const err = new TypeError("fetch failed");
      err.cause = Object.assign(new Error("connect ECONNREFUSED 10.9.8.7:8000"), { code: "ECONNREFUSED" });
      throw err;
    }
    return globalThis.fetch(url, init);
  };
}

/** Records onProxySettled calls; next() resolves on the next one. */
function settledWatcher() {
  const calls = [];
  let waiters = [];
  return {
    calls,
    onProxySettled: (info) => {
      calls.push(info);
      const w = waiters;
      waiters = [];
      for (const r of w) r(info);
    },
    next: () => new Promise((r) => waiters.push(r)),
  };
}

function inventory(targetId, endpoint, models, { load = 0, collectedAt = Date.now() } = {}) {
  return {
    targetId,
    collectedAt,
    reachable: true,
    runtimes: [{ engine: "vllm", port: 8000, endpoint, reachable: true, capabilities: {}, error: null, requestsRunning: load, via: "direct" }],
    models: models.map((modelId) => ({ modelKey: `vllm|8000|${modelId}`, modelId, label: modelId, engine: "vllm", port: 8000, state: "serving", sources: ["api"], servedBy: null })),
    clusterModels: [],
    errors: [],
    stale: false,
  };
}
const target = (targetId) => ({ targetId, kind: targetId.split(":")[0], id: targetId.split(":")[1], name: targetId, online: true, health: "ready" });

/** The routing routes alone on an ephemeral port, closed after the test. */
async function startApp(t, settings, { inventories = [], targets, ...opts } = {}) {
  const app = express();
  app.use(express.json());
  registerFleetRoutingRoutes(app, {
    getSettings: () => settings,
    getInventories: async () => inventories,
    getTargets: () => targets ?? inventories.map((i) => target(i.targetId)),
    ...opts,
  });
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  t.after(closer(server));
  return { base: `http://127.0.0.1:${server.address().port}`, port: server.address().port };
}

const ON = { fleetModelsEnabled: true, smartRoutingEnabled: true };
const post = (url, body, headers = {}) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([promise, new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`timed out waiting for ${what}`)), ms)))]).finally(() =>
    clearTimeout(timer)
  );
}

/** Raw client request that can be destroyed at any point. */
function rawPost(port, path, body) {
  const req = http.request({ host: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json" } });
  req.on("error", () => {});
  req.end(JSON.stringify(body));
  return req;
}

test("routing off (the default): GET /routing reports the state, everything else is 404 and the engine is never called", async (t) => {
  const up = await startUpstream(t, (_req, res) => res.end("{}"));
  const a = await startApp(t, { fleetModelsEnabled: true }, { inventories: [inventory("node:a", up.base, ["m"])] });
  const r = await fetch(`${a.base}/api/fleet/routing`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { enabled: false, policy: "least-loaded", table: [] });
  for (const [method, path] of [
    ["POST", "/api/fleet/routing/resolve"],
    ["GET", "/api/fleet/v1/models"],
    ["POST", "/api/fleet/v1/chat/completions"],
    ["POST", "/api/fleet/v1/completions"],
    ["POST", "/api/fleet/v1/embeddings"],
  ]) {
    const res = method === "GET" ? await fetch(a.base + path) : await post(a.base + path, { model: "m" });
    assert.equal(res.status, 404, path);
    assert.deepEqual(await res.json(), { error: "Smart routing is disabled", code: "routing_disabled" });
  }
  assert.equal(up.seen.length, 0);
});

test("fleetModelsEnabled false: every route is 404, including GET /routing", async (t) => {
  const a = await startApp(t, { fleetModelsEnabled: false, smartRoutingEnabled: true }, { inventories: [inventory("node:a", "http://x:1", ["m"])] });
  for (const [method, path] of [
    ["GET", "/api/fleet/routing"],
    ["POST", "/api/fleet/routing/resolve"],
    ["GET", "/api/fleet/v1/models"],
    ["POST", "/api/fleet/v1/chat/completions"],
  ]) {
    const res = method === "GET" ? await fetch(a.base + path) : await post(a.base + path, { model: "m" });
    assert.equal(res.status, 404, path);
    assert.equal((await res.json()).code, "fleet_disabled");
  }
});

test("GET /routing returns the table and the validated policy", async (t) => {
  const a = await startApp(t, { ...ON, smartRoutingPolicy: "round-robin" }, { inventories: [inventory("node:a", "http://10.0.0.1:8000", ["m"], { load: 2 })] });
  const body = await (await fetch(`${a.base}/api/fleet/routing`)).json();
  assert.deepEqual(body, { enabled: true, policy: "round-robin", table: [{ model: "m", targets: [{ targetId: "node:a", endpoint: "http://10.0.0.1:8000", load: 2, port: 8000 }] }] });
  const b = await startApp(t, { ...ON, smartRoutingPolicy: "nonsense" }, { inventories: [] });
  assert.equal((await (await fetch(`${b.base}/api/fleet/routing`)).json()).policy, "least-loaded");
});

test("resolve picks the least-loaded serving target and explains why", async (t) => {
  const a = await startApp(t, ON, {
    inventories: [inventory("node:a", "http://10.0.0.1:8000", ["m"], { load: 4 }), inventory("node:b", "http://10.0.0.2:8000", ["m"], { load: 1 })],
  });
  const r = await post(`${a.base}/api/fleet/routing/resolve`, { model: "m" });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.target.targetId, "node:b");
  assert.equal(body.target.name, "node:b");
  assert.equal(body.endpoint, "http://10.0.0.2:8000");
  assert.match(body.reason, /least loaded/);
  // Surrounding whitespace is trimmed before matching.
  assert.equal((await (await post(`${a.base}/api/fleet/routing/resolve`, { model: "  m " })).json()).target.targetId, "node:b");
  const miss = await (await post(`${a.base}/api/fleet/routing/resolve`, { model: "other" })).json();
  assert.equal(miss.target, null);
  assert.equal(miss.endpoint, null);
  assert.match(miss.reason, /No target is serving "other"/);
  for (const bad of [{ model: "" }, { model: "   " }, { model: 7 }, [1]]) {
    const res = await post(`${a.base}/api/fleet/routing/resolve`, bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
});

test("resolve does not advance round-robin; the proxy does", async (t) => {
  const up1 = await startUpstream(t, (_req, res) => res.end("{}"));
  const up2 = await startUpstream(t, (_req, res) => res.end("{}"));
  const a = await startApp(t, { ...ON, smartRoutingPolicy: "round-robin" }, { inventories: [inventory("node:a", up1.base, ["m"]), inventory("node:b", up2.base, ["m"])] });
  for (let i = 0; i < 3; i++) assert.equal((await (await post(`${a.base}/api/fleet/routing/resolve`, { model: "m" })).json()).target.targetId, "node:a");
  const hits = [];
  for (let i = 0; i < 3; i++) {
    const r = await post(`${a.base}/api/fleet/v1/chat/completions`, { model: "m" });
    await r.text();
    hits.push(r.headers.get("x-sparkdash-target"));
  }
  assert.deepEqual(hits, ["node:a", "node:b", "node:a"]);
});

test("GET /v1/models lists routable models in OpenAI shape; stale and non-serving models are absent", async (t) => {
  const stale = inventory("node:b", "http://10.0.0.2:8000", ["old-model"], { collectedAt: Date.now() - 120_000 });
  const loaded = inventory("node:c", "http://10.0.0.3:8000", ["loaded-model"]);
  loaded.models[0].state = "loaded";
  const a = await startApp(t, ON, { inventories: [inventory("node:a", "http://10.0.0.1:8000", ["b-model", "a-model"]), stale, loaded] });
  const body = await (await fetch(`${a.base}/api/fleet/v1/models`)).json();
  assert.deepEqual(body, {
    object: "list",
    data: [
      { id: "a-model", object: "model", owned_by: "sparkdash-fleet" },
      { id: "b-model", object: "model", owned_by: "sparkdash-fleet" },
    ],
  });
});

test("non-streaming proxy forwards only the JSON body; client headers stay behind and engine cookies are dropped", async (t) => {
  const up = await startUpstream(t, (req, res, rec) => {
    res.writeHead(201, { "Content-Type": "application/json; charset=utf-8", "Set-Cookie": "engine=1", "X-Engine-Internal": "x" });
    res.end(JSON.stringify({ id: "x", echo: rec.body, path: req.url }));
  });
  const keys = [];
  const a = await startApp(t, ON, {
    inventories: [inventory("node:a", up.base, ["Llama-3"])],
    getApiKey: (targetId, port) => {
      keys.push([targetId, port]);
      return ENGINE_KEY;
    },
  });
  const res = await post(
    `${a.base}/api/fleet/v1/chat/completions`,
    { model: "llama-3", messages: [{ role: "user", content: "hi" }] },
    { Authorization: `Bearer ${DASHBOARD_TOKEN}`, Cookie: "s=1", "X-Forwarded-For": "1.2.3.4", "X-Forwarded-Host": "dash.example", "X-Forwarded-Proto": "https" }
  );
  assert.equal(res.status, 201);
  assert.match(res.headers.get("content-type"), /application\/json/);
  assert.equal(res.headers.get("x-sparkdash-target"), "node:a");
  assert.equal(res.headers.get("set-cookie"), null);
  assert.equal(res.headers.get("x-engine-internal"), null);
  const body = await res.json();
  assert.equal(body.path, "/v1/chat/completions");
  // Case-insensitive request is forwarded with the exact served id.
  assert.deepEqual(body.echo, { model: "Llama-3", messages: [{ role: "user", content: "hi" }] });
  const h = up.seen[0].headers;
  assert.equal(h.authorization, `Bearer ${ENGINE_KEY}`);
  assert.equal(h.cookie, undefined);
  assert.equal(h.host, new URL(up.base).host); // the engine's own host, not the dashboard's
  for (const name of Object.keys(h)) assert.ok(!name.startsWith("x-forwarded"), name);
  assert.deepEqual(keys, [["node:a", 8000]]);

  for (const sub of ["completions", "embeddings"]) {
    const r = await post(`${a.base}/api/fleet/v1/${sub}`, { model: "Llama-3", input: "x" });
    assert.equal((await r.json()).path, `/v1/${sub}`);
  }
});

test("the dashboard Authorization header is never forwarded when there is no engine key", async (t) => {
  const up = await startUpstream(t, (_req, res) => res.end("{}"));
  const a = await startApp(t, ON, { inventories: [inventory("node:a", up.base, ["m"])], getApiKey: () => null });
  const r = await post(`${a.base}/api/fleet/v1/chat/completions`, { model: "m" }, { Authorization: `Bearer ${DASHBOARD_TOKEN}` });
  await r.text();
  assert.equal(up.seen.length, 1);
  assert.equal(up.seen[0].headers.authorization, undefined);
});

test("upstream error statuses pass through unchanged", async (t) => {
  const up = await startUpstream(t, (_req, res) => {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "bad" } }));
  });
  const a = await startApp(t, ON, { inventories: [inventory("node:a", up.base, ["m"])] });
  const r = await post(`${a.base}/api/fleet/v1/chat/completions`, { model: "m" });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: { message: "bad" } });
});

test("a target id outside Latin-1 is percent-encoded in X-Sparkdash-Target", async (t) => {
  const up = await startUpstream(t, (_req, res) => res.end('{"ok":true}'));
  const w = settledWatcher();
  const a = await startApp(t, ON, { inventories: [inventory("node:spärk-☃", up.base, ["m"])], onProxySettled: w.onProxySettled });
  const r = await post(`${a.base}/api/fleet/v1/chat/completions`, { model: "m" });
  assert.equal(r.status, 200);
  assert.equal(decodeURIComponent(r.headers.get("x-sparkdash-target")), "node:spärk-☃");
  assert.deepEqual(await r.json(), { ok: true });
  assert.equal(w.calls.length, 1);
});

test("streaming SSE is passed through chunk by chunk without buffering", async (t) => {
  let release;
  const released = new Promise((r) => (release = r));
  const up = await startUpstream(t, async (_req, res, rec) => {
    assert.equal(rec.body.stream, true);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"n":1}\n\n');
    await released;
    res.write('data: {"n":2}\n\n');
    res.end("data: [DONE]\n\n");
  });
  const a = await startApp(t, ON, { inventories: [inventory("node:a", up.base, ["m"])] });
  const res = await post(`${a.base}/api/fleet/v1/chat/completions`, { model: "m", stream: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  assert.equal(res.headers.get("x-sparkdash-target"), "node:a");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  // The first event arrives while the engine is still holding the second one back.
  const first = await withTimeout(reader.read(), 3000, "the first SSE chunk");
  assert.equal(dec.decode(first.value), 'data: {"n":1}\n\n');
  release();
  let rest = "";
  for (;;) {
    const { value, done } = await withTimeout(reader.read(), 3000, "the rest of the stream");
    if (done) break;
    rest += dec.decode(value, { stream: true });
  }
  assert.equal(rest, 'data: {"n":2}\n\ndata: [DONE]\n\n');
});

test("a client disconnect while the route table is built never reaches the engine and settles the handler", async (t) => {
  const up = await startUpstream(t, (_req, res) => res.end("{}"));
  let entered;
  const enteredP = new Promise((r) => (entered = r));
  let releaseInv;
  const invGate = new Promise((r) => (releaseInv = r));
  const w = settledWatcher();
  const inv = [inventory("node:a", up.base, ["m"])];
  const a = await startApp(t, ON, {
    inventories: inv,
    getInventories: async () => {
      entered();
      await invGate;
      return inv;
    },
    onProxySettled: w.onProxySettled,
  });
  const settled = w.next();
  const req = rawPost(a.port, "/api/fleet/v1/chat/completions", { model: "m", stream: true });
  await withTimeout(enteredP, 3000, "getInventories");
  req.destroy();
  await new Promise((r) => setTimeout(r, 150)); // let the server see the close
  releaseInv();
  const info = await withTimeout(settled, 3000, "the handler to settle");
  assert.equal(info.clientGone, true);
  assert.equal(info.targetId, null);
  assert.equal(up.seen.length, 0);
});

test("a client disconnect before the engine sends headers aborts the upstream request", async (t) => {
  let received;
  const receivedP = new Promise((r) => (received = r));
  const up = await startUpstream(t, () => received()); // holds the response
  const w = settledWatcher();
  const a = await startApp(t, ON, { inventories: [inventory("node:a", up.base, ["m"])], onProxySettled: w.onProxySettled });
  const settled = w.next();
  const req = rawPost(a.port, "/api/fleet/v1/chat/completions", { model: "m" });
  await withTimeout(receivedP, 3000, "the engine to receive the request");
  req.destroy();
  await withTimeout(up.closedCount(1), 3000, "the upstream connection to close");
  const info = await withTimeout(settled, 3000, "the handler to settle");
  assert.equal(info.clientGone, true);
});

test("a client disconnect mid-stream aborts the upstream request and settles the handler", async (t) => {
  const up = await startUpstream(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    // A busy stream that never finishes on its own (exercises backpressure too).
    const iv = setInterval(() => res.write(`data: ${"x".repeat(1000)}\n\n`), 2);
    res.on("close", () => clearInterval(iv));
  });
  const w = settledWatcher();
  const a = await startApp(t, ON, { inventories: [inventory("node:a", up.base, ["m"])], onProxySettled: w.onProxySettled });
  const settled = w.next();
  const ctrl = new AbortController();
  const res = await fetch(`${a.base}/api/fleet/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "m", stream: true }),
    signal: ctrl.signal,
  });
  const reader = res.body.getReader();
  await withTimeout(reader.read(), 3000, "the first chunk");
  ctrl.abort();
  await withTimeout(up.closedCount(1), 3000, "the upstream connection to close");
  const info = await withTimeout(settled, 3000, "the handler to settle");
  assert.equal(info.clientGone, true);
  assert.equal(info.targetId, "node:a");
});

test("upstream down: 502 upstream_unreachable without internal details; a refused connection falls back to the next target", async (t) => {
  const dead = "http://10.9.8.7:8000";
  const warn = t.mock.method(console, "warn", () => {});
  const a = await startApp(t, ON, { inventories: [inventory("node:a", dead, ["m"])], fetchImpl: refusingFetch([dead]) });
  const r = await post(`${a.base}/api/fleet/v1/chat/completions`, { model: "m" });
  assert.equal(r.status, 502);
  const body = await r.json();
  assert.equal(body.code, "upstream_unreachable");
  assert.ok(!/10\.9\.8\.7|ECONNREFUSED/.test(body.error), body.error);
  assert.match(String(warn.mock.calls[0]?.arguments[0]), /ECONNREFUSED/); // logged server-side instead

  const up = await startUpstream(t, (_req, res) => res.end('{"ok":true}'));
  // The dead target is the least-loaded pick; the request is retried on the live one.
  const b = await startApp(t, ON, {
    inventories: [inventory("node:a", dead, ["m"], { load: 0 }), inventory("node:b", up.base, ["m"], { load: 5 })],
    fetchImpl: refusingFetch([dead]),
  });
  const r2 = await post(`${b.base}/api/fleet/v1/chat/completions`, { model: "m" });
  assert.equal(r2.status, 200);
  assert.equal(r2.headers.get("x-sparkdash-target"), "node:b");
  assert.deepEqual(await r2.json(), { ok: true });
});

test("an engine that never sends headers times out with 504 and is not retried", async (t) => {
  const up = await startUpstream(t, () => {
    /* never answers */
  });
  const up2 = await startUpstream(t, (_req, res) => res.end("{}"));
  const a = await startApp(t, ON, {
    inventories: [inventory("node:a", up.base, ["m"], { load: 0 }), inventory("node:b", up2.base, ["m"], { load: 9 })],
    headersTimeoutMs: 200,
  });
  const r = await post(`${a.base}/api/fleet/v1/chat/completions`, { model: "m" });
  assert.equal(r.status, 504);
  assert.equal((await r.json()).code, "upstream_timeout");
  assert.equal(up2.seen.length, 0);
  await withTimeout(up.closedCount(1), 3000, "the timed-out upstream request to be aborted");
});

test("least-loaded counts the proxy's own in-flight requests and releases them when done", async (t) => {
  let releaseA;
  const holdA = new Promise((r) => (releaseA = r));
  const upA = await startUpstream(t, async (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: 1\n\n");
    await holdA;
    res.end("data: [DONE]\n\n");
  });
  const upB = await startUpstream(t, (_req, res) => res.end("{}"));
  const w = settledWatcher();
  const a = await startApp(t, ON, {
    inventories: [inventory("node:a", upA.base, ["m"], { load: 0 }), inventory("node:b", upB.base, ["m"], { load: 0 })],
    onProxySettled: w.onProxySettled,
  });
  const first = await post(`${a.base}/api/fleet/v1/chat/completions`, { model: "m", stream: true });
  assert.equal(first.headers.get("x-sparkdash-target"), "node:a");
  const reader = first.body.getReader();
  await withTimeout(reader.read(), 3000, "the first stream to start");
  // node:a has one routed request open, so an equal inventory load now favours node:b.
  const second = await post(`${a.base}/api/fleet/v1/chat/completions`, { model: "m" });
  await second.text();
  assert.equal(second.headers.get("x-sparkdash-target"), "node:b");
  assert.match((await (await post(`${a.base}/api/fleet/routing/resolve`, { model: "m" })).json()).reason, /node:b/);
  const done = w.next();
  releaseA();
  while (!(await reader.read()).done);
  await withTimeout(done, 3000, "the first request to settle");
  const third = await post(`${a.base}/api/fleet/v1/chat/completions`, { model: "m" });
  await third.text();
  assert.equal(third.headers.get("x-sparkdash-target"), "node:a");
});

test("proxy validation: unknown model 404, bad bodies 400, rate limit 429", async (t) => {
  const up = await startUpstream(t, (_req, res) => res.end("{}"));
  let allow = true;
  const a = await startApp(t, ON, { inventories: [inventory("node:a", up.base, ["m"])], allowProxy: () => allow });
  const miss = await post(`${a.base}/api/fleet/v1/chat/completions`, { model: "m2" });
  assert.equal(miss.status, 404);
  assert.equal((await miss.json()).code, "model_not_served");
  assert.equal((await post(`${a.base}/api/fleet/v1/chat/completions`, [{ model: "m" }])).status, 400);
  assert.equal((await post(`${a.base}/api/fleet/v1/chat/completions`, { messages: [] })).status, 400);
  const blank = await post(`${a.base}/api/fleet/v1/chat/completions`, { model: " \t " });
  assert.equal(blank.status, 400);
  assert.equal((await blank.json()).code, "invalid_model");
  const notJson = await fetch(`${a.base}/api/fleet/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "model=m" });
  assert.equal(notJson.status, 400);
  allow = false;
  assert.equal((await post(`${a.base}/api/fleet/v1/chat/completions`, { model: "m" })).status, 429);
  assert.equal(up.seen.length, 0);
});

test("targetHeaderValue never throws, even for a lone surrogate", () => {
  assert.equal(targetHeaderValue("node:a"), "node:a");
  assert.equal(decodeURIComponent(targetHeaderValue("node:spärk-☃")), "node:spärk-☃");
  const lone = targetHeaderValue("node:a\ud800");
  assert.equal(typeof lone, "string");
  assert.equal(decodeURIComponent(lone), "node:a�");
  assert.equal(targetHeaderValue(undefined), "");
});
