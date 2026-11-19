import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeFetch } from "./fakeFetch.js";
import { fetchJson, baseUrlFor, makeCapabilities } from "../adapters/base.js";
import { MAC_BUSY_ERROR } from "../adapters/macProfile.js";
import { getAdapter, listAdapters, registerAdapter, unregisterAdapter } from "../adapters/index.js";
import { createOpenAiCompatAdapter } from "../adapters/openaiCompat.js";
import { lmsCommand, LMS_UNSUPPORTED_REASON } from "../adapters/lmstudio.js";

const B = "http://10.0.0.5:11434";

test("fetchJson: JSON, HTTP errors, invalid JSON, empty bodies, oversize, timeouts, transport errors", async () => {
  const f = fakeFetch({
    "GET http://h:1/ok": { body: { a: 1 } },
    "GET http://h:1/404": { status: 404, text: "not found" },
    "GET http://h:1/bad": { text: "<html>" },
    "GET http://h:1/empty": { text: "" },
    "GET http://h:1/big": { text: JSON.stringify({ x: "y".repeat(3 * 1024 * 1024) }) },
    "GET http://h:1/hang": "hang",
  });
  assert.deepEqual(await fetchJson("http://h:1/ok", { fetchImpl: f }), { a: 1 });
  await assert.rejects(fetchJson("http://h:1/404", { fetchImpl: f }), (e) => e.status === 404 && /HTTP 404 not found/.test(e.message));
  await assert.rejects(fetchJson("http://h:1/bad", { fetchImpl: f }), /invalid JSON/);
  await assert.rejects(fetchJson("http://h:1/empty", { fetchImpl: f }), /empty response/);
  assert.equal(await fetchJson("http://h:1/empty", { fetchImpl: f, allowEmpty: true }), null);
  await assert.rejects(fetchJson("http://h:1/big", { fetchImpl: f }), /larger than/);
  const t0 = Date.now();
  await assert.rejects(fetchJson("http://h:1/hang", { fetchImpl: f, timeoutMs: 50 }), /timed out after 50 ms/);
  assert.ok(Date.now() - t0 < 2000);
  await assert.rejects(fetchJson("http://h:1/none", { fetchImpl: f }), /GET http:\/\/h:1\/none: fetch failed \(ECONNREFUSED\)/);
  // A fetch that ignores the abort signal still ends on time.
  const deaf = () => new Promise(() => {});
  await assert.rejects(fetchJson("http://h:1/deaf", { fetchImpl: deaf, timeoutMs: 30 }), /timed out/);
  // Bearer key and JSON body.
  await fetchJson("http://h:1/ok", { fetchImpl: f, apiKey: "k", method: "POST", body: { z: 1 } }).catch(() => {});
  const last = f.calls.at(-1);
  assert.equal(last.redirect, "error", "redirects are refused");
  assert.equal(last.headers.authorization, "Bearer k");
  assert.deepEqual(last.body, { z: 1 });
});

test("baseUrlFor brackets IPv6 and refuses an empty host", () => {
  assert.equal(baseUrlFor("fd7a::1", 8000), "http://[fd7a::1]:8000");
  assert.equal(baseUrlFor("spark1.ts.net", 8000), "http://spark1.ts.net:8000");
  assert.throws(() => baseUrlFor("", 8000), /no LLM host/);
});

test("registry: built-ins, AdapterInfo shape, SGLang-style registration needs no core change", async () => {
  const engines = listAdapters().map((a) => a.engine);
  for (const e of ["ollama", "lmstudio", "vllm", "llama.cpp", "sglang", "mac-profile", "launch-profile"]) assert.ok(engines.includes(e), e);
  for (const a of listAdapters()) {
    assert.equal(typeof a.label, "string");
    assert.deepEqual(Object.keys(a.capabilities).sort(), ["discover", "load", "logs", "multiModel", "start", "stop", "unload"]);
  }
  assert.equal(getAdapter("nope"), null);
  assert.equal(getAdapter(undefined), null);
  assert.throws(() => registerAdapter({ engine: "vllm", discover: async () => ({}) }), /already registered/);
  assert.throws(() => registerAdapter({ engine: "Bad Engine", discover: async () => ({}) }), /engine/);
  assert.throws(() => registerAdapter({ engine: "x" }), /discover/);
  registerAdapter(createOpenAiCompatAdapter({ engine: "tgi", label: "TGI", healthPaths: ["/health"] }));
  try {
    assert.equal(getAdapter("tgi").label, "TGI");
    assert.ok(listAdapters().some((a) => a.engine === "tgi"));
  } finally {
    unregisterAdapter("tgi");
  }
  assert.equal(getAdapter("tgi"), null);
});

test("ollama: installed from /api/tags, loaded from /api/ps", async () => {
  const f = fakeFetch({
    [`GET ${B}/api/tags`]: {
      body: {
        models: [
          { name: "llama3.1:8b", size: 4920753328, details: { quantization_level: "Q4_K_M", parameter_size: "8.0B" } },
          { name: "phi3:mini", size: 2176178913, details: {} },
          { size: 1 },
          "junk",
        ],
      },
    },
    [`GET ${B}/api/ps`]: { body: { models: [{ name: "llama3.1:8b", size: 6000000000, size_vram: 5800000000, expires_at: "2026-11-18T12:00:00Z", context_length: 8192 }] } },
  });
  const r = await getAdapter("ollama").discover({ baseUrl: B, fetchImpl: f, timeoutMs: 1000 });
  assert.equal(r.reachable, true);
  assert.equal(r.ready, true);
  assert.deepEqual(r.errors, []);
  assert.equal(r.models.length, 2);
  const llama = r.models.find((m) => m.modelId === "llama3.1:8b");
  assert.equal(llama.loaded, true);
  assert.equal(llama.listed, true);
  assert.equal(llama.installed, true);
  assert.equal(llama.quantization, "Q4_K_M");
  assert.equal(llama.sizeBytes, 4920753328);
  assert.equal(llama.estMemoryBytes, 6000000000);
  assert.equal(llama.contextLength, 8192);
  assert.deepEqual(llama.sources, ["catalog", "ps"]);
  const phi = r.models.find((m) => m.modelId === "phi3:mini");
  assert.equal(phi.loaded, undefined);
  assert.equal(phi.installed, true);
  assert.equal(phi.quantization, null);
});

test("ollama: partial and malformed responses are reported, not guessed", async () => {
  const f = fakeFetch({ [`GET ${B}/api/tags`]: { body: { models: [{ name: "a" }] } }, [`GET ${B}/api/ps`]: { status: 500, text: "boom" } });
  const r = await getAdapter("ollama").discover({ baseUrl: B, fetchImpl: f });
  assert.equal(r.reachable, true);
  assert.equal(r.ready, false);
  assert.equal(r.loadedKnown, false);
  assert.match(r.errors[0], /api\/ps: HTTP 500 boom/);
  const g = fakeFetch({ [`GET ${B}/api/tags`]: { body: { nope: 1 } }, [`GET ${B}/api/ps`]: { text: "{" } });
  const r2 = await getAdapter("ollama").discover({ baseUrl: B, fetchImpl: g });
  assert.equal(r2.models.length, 0);
  assert.equal(r2.errors.length, 2);
  assert.match(r2.errors.join("\n"), /no models array/);
  assert.match(r2.errors.join("\n"), /invalid JSON/);
  const h = fakeFetch({ [`GET ${B}/api/tags`]: "hang", [`GET ${B}/api/ps`]: "hang" });
  const r3 = await getAdapter("ollama").discover({ baseUrl: B, fetchImpl: h, timeoutMs: 30 });
  assert.equal(r3.reachable, false);
  assert.equal(r3.errors.length, 2);
  assert.match(r3.errors[0], /timed out/);
});

test("ollama: load/unload validate the id against regex and catalog, then use keep_alive", async () => {
  const f = fakeFetch({ [`POST ${B}/api/generate`]: { body: { model: "a", done: true, done_reason: "load" } } });
  const ollama = getAdapter("ollama");
  const ctx = { baseUrl: B, fetchImpl: f, catalog: ["llama3.1:8b"] };
  assert.equal((await ollama.load(ctx, "llama3.1:8b")).ok, true);
  assert.deepEqual(f.calls.at(-1).body, { model: "llama3.1:8b", keep_alive: -1, stream: false });
  assert.equal((await ollama.unload(ctx, "llama3.1:8b")).ok, true);
  assert.equal(f.calls.at(-1).body.keep_alive, 0);
  const n = f.calls.length;
  assert.match((await ollama.load(ctx, "other")).error, /not in this runtime's catalog/);
  assert.match((await ollama.load(ctx, "bad'id")).error, /invalid model id/);
  assert.match((await ollama.load({ baseUrl: B, fetchImpl: f }, "llama3.1:8b")).error, /catalog is unknown/);
  assert.equal(f.calls.length, n, "refused ids never reach the network");
  const g = fakeFetch({ [`POST ${B}/api/generate`]: { status: 404, body: { error: "model not found" } } });
  const r = await ollama.load({ ...ctx, fetchImpl: g }, "llama3.1:8b");
  assert.equal(r.ok, false);
  assert.match(r.error, /HTTP 404/);
});

const LMS = "http://10.0.0.6:1234";
const lmsModels = {
  data: [
    { id: "qwen2.5-7b-instruct", type: "llm", state: "loaded", quantization: "Q4_K_M", max_context_length: 32768 },
    { id: "nomic-embed-text-v1.5", type: "embeddings", state: "not-loaded", quantization: "Q8_0", max_context_length: 2048 },
    { id: "evil'; rm -rf ~; '", type: "llm", state: "not-loaded" },
    { state: "loaded" },
  ],
};

test("lmstudio: discovery parses states, types, quantization and context", async () => {
  const f = fakeFetch({ [`GET ${LMS}/api/v0/models`]: { body: lmsModels } });
  const r = await getAdapter("lmstudio").discover({ baseUrl: LMS, fetchImpl: f });
  assert.equal(r.reachable, true);
  assert.equal(r.models.length, 3);
  const q = r.models[0];
  assert.equal(q.loaded, true);
  assert.equal(q.listed, true);
  assert.equal(q.contextLength, 32768);
  assert.equal(q.quantization, "Q4_K_M");
  assert.equal(r.models[1].loaded, false);
  assert.equal(r.models[1].type, "embeddings");
  const bad = await getAdapter("lmstudio").discover({ baseUrl: LMS, fetchImpl: fakeFetch({ [`GET ${LMS}/api/v0/models`]: { body: [] } }) });
  assert.match(bad.errors[0], /no data array/);
  const down = await getAdapter("lmstudio").discover({ baseUrl: LMS, fetchImpl: fakeFetch({}) });
  assert.equal(down.reachable, false);
  assert.match(down.errors[0], /ECONNREFUSED/);
});

test("lmstudio: load/unload use a fixed CLI template; refuse ids not in the catalog or failing the regex", async () => {
  const lm = getAdapter("lmstudio");
  const cmds = [];
  const exec = async (cmd) => {
    cmds.push(cmd);
    return "Model loaded";
  };
  const catalog = ["qwen2.5-7b-instruct", "evil'; rm -rf ~; '"];
  assert.equal((await lm.load({ exec, catalog }, "qwen2.5-7b-instruct")).ok, true);
  assert.equal((await lm.unload({ exec, catalog }, "qwen2.5-7b-instruct")).ok, true);
  assert.deepEqual(cmds, [
    `PATH="$HOME/.lmstudio/bin:$PATH" lms load 'qwen2.5-7b-instruct' --yes`,
    `PATH="$HOME/.lmstudio/bin:$PATH" lms unload 'qwen2.5-7b-instruct'`,
  ]);
  assert.match((await lm.load({ exec, catalog }, "evil'; rm -rf ~; '")).error, /invalid model id/);
  assert.match((await lm.load({ exec, catalog }, "not-downloaded")).error, /not in this runtime's catalog/);
  assert.equal(cmds.length, 2, "refused ids never reach exec");
  assert.equal(lmsCommand("load", "a/b:c"), `PATH="$HOME/.lmstudio/bin:$PATH" lms load 'a/b:c' --yes`);
  assert.throws(() => lmsCommand("load", "x'; reboot; '"), /invalid model id/, "the template itself refuses unsafe ids");
  assert.throws(() => lmsCommand("unload", "../x"), /invalid model id/);
  // No exec (e.g. a Windows unit): unsupported with a reason, capabilities say so.
  const r = await lm.load({ catalog }, "qwen2.5-7b-instruct");
  assert.deepEqual(r, { ok: false, unsupported: true, error: LMS_UNSUPPORTED_REASON });
  assert.equal(lm.capabilitiesFor({}).load, false);
  assert.equal(lm.capabilitiesFor({ exec }).load, true);
  const failing = await lm.load({ exec: async () => { throw new Error("SSH to x:22 failed: denied"); }, catalog }, "qwen2.5-7b-instruct");
  assert.equal(failing.ok, false);
  assert.match(failing.error, /denied/);
});

const V = "http://10.0.0.1:8000";

test("vllm: /v1/models + /health; max_model_len → contextLength; no lifecycle of its own", async () => {
  const f = fakeFetch({
    [`GET ${V}/v1/models`]: { body: { data: [{ id: "Qwen/Qwen3-235B", max_model_len: 131072 }, { id: "lora-a" }, { nope: 1 }] } },
    [`GET ${V}/health`]: { text: "" },
  });
  const vllm = getAdapter("vllm");
  const r = await vllm.discover({ baseUrl: V, fetchImpl: f });
  assert.equal(r.ready, true);
  assert.equal(r.reachable, true);
  assert.deepEqual(r.models.map((m) => [m.modelId, m.contextLength]), [["Qwen/Qwen3-235B", 131072], ["lora-a", null]]);
  assert.deepEqual(vllm.capabilities, makeCapabilities({ discover: true }));
  assert.equal(vllm.load, undefined);
  assert.equal(vllm.start, undefined);
});

test("openaiCompat: health 503 = not ready, missing health path falls back to the listing", async () => {
  const loading = fakeFetch({
    [`GET ${V}/v1/models`]: { body: { data: [{ id: "m" }] } },
    [`GET ${V}/health`]: { status: 503, body: { error: { message: "Loading model" } } },
  });
  const r = await getAdapter("llama.cpp").discover({ baseUrl: V, fetchImpl: loading });
  assert.equal(r.ready, false);
  assert.deepEqual(r.errors, []);
  const ok = fakeFetch({ [`GET ${V}/v1/models`]: { body: { data: [{ id: "m" }] } }, [`GET ${V}/health`]: { body: { status: "ok" } } });
  assert.equal((await getAdapter("llama.cpp").discover({ baseUrl: V, fetchImpl: ok })).ready, true);
  // SGLang: /health missing (404) → /get_model_info answers.
  const sg = fakeFetch({
    [`GET ${V}/v1/models`]: { body: { data: [{ id: "deepseek" }] } },
    [`GET ${V}/health`]: { status: 404, text: "" },
    [`GET ${V}/get_model_info`]: { body: { model_path: "/m/deepseek" } },
  });
  assert.equal((await getAdapter("sglang").discover({ baseUrl: V, fetchImpl: sg })).ready, true);
  const noHealth = fakeFetch({
    [`GET ${V}/v1/models`]: { body: { data: [{ id: "deepseek" }] } },
    [`GET ${V}/health`]: { status: 404, text: "" },
    [`GET ${V}/get_model_info`]: { status: 404, text: "" },
  });
  assert.equal((await getAdapter("sglang").discover({ baseUrl: V, fetchImpl: noHealth })).ready, true);
});

test("openaiCompat: malformed, failed and timed-out responses surface verbatim", async () => {
  const vllm = getAdapter("vllm");
  const malformed = await vllm.discover({ baseUrl: V, fetchImpl: fakeFetch({ [`GET ${V}/v1/models`]: { body: { object: "list" } }, [`GET ${V}/health`]: { text: "" } }) });
  assert.equal(malformed.models.length, 0);
  assert.equal(malformed.ready, false);
  assert.match(malformed.errors[0], /no data array/);
  const down = await vllm.discover({ baseUrl: V, fetchImpl: fakeFetch({}) });
  assert.equal(down.reachable, false);
  assert.equal(down.ready, false);
  assert.equal(down.errors.length, 2);
  const slow = await vllm.discover({ baseUrl: V, timeoutMs: 30, fetchImpl: fakeFetch({ [`GET ${V}/v1/models`]: "hang", [`GET ${V}/health`]: "hang" }) });
  assert.equal(slow.reachable, false);
  assert.match(slow.errors[0], /timed out after 30 ms/);
});

test("mac-profile: configured models from targets, serving from the runtime view, start/stop via beginRuntimeControl", async () => {
  const view = {
    state: "ready",
    reason: null,
    serving: [
      { name: "omlx", state: "serving", port: 8080, model: "mlx-community/Qwen3-30B", health: { ok: true, url: "x" } },
      { name: "splash", state: "running", port: 8090, model: null },
    ],
    targets: [
      { name: "omlx", label: "oMLX", models: [{ id: "mlx-community/Qwen3-30B", label: "Qwen3 30B" }, { id: "mlx-community/gemma-3", label: "Gemma 3" }], startable: true, stoppable: true },
      { name: "splash", label: "Splash", models: [{ id: "splash-35b", label: "Splash 35B" }], startable: true, stoppable: true },
      { name: "idle", label: "Idle", models: [{ id: "idle-model", label: "Idle" }], startable: false, stoppable: false, reason: "not installed" },
    ],
  };
  const calls = [];
  const mac = {
    readRuntimeControl: async () => view,
    beginRuntimeControl: async (unit, action, req) => {
      calls.push([unit.id, action, req]);
      return { ...view, busy: true, operation: { id: "op", state: "running", runtime: req.runtime, model: req.model, action } };
    },
  };
  const adapter = getAdapter("mac-profile");
  const ctx = { unit: { id: "mac", kind: "mac" }, mac };
  const r = await adapter.discover(ctx);
  const by = Object.fromEntries(r.models.map((m) => [m.modelId, m]));
  assert.equal(by["mlx-community/Qwen3-30B"].listed, true);
  assert.equal(by["mlx-community/Qwen3-30B"].ready, true);
  assert.equal(by["mlx-community/Qwen3-30B"].port, 8080);
  assert.equal(by["mlx-community/gemma-3"].processRunning, false);
  assert.equal(by["splash-35b"].processRunning, true);
  assert.equal(by["splash-35b"].listed, false);
  assert.equal(by["idle-model"].startable, false);
  assert.equal((await adapter.start(ctx, by["mlx-community/gemma-3"])).ok, true);
  assert.equal((await adapter.stop(ctx, by["splash-35b"])).ok, true);
  assert.deepEqual(calls, [
    ["mac", "start", { runtime: "omlx", model: "mlx-community/gemma-3" }],
    ["mac", "stop", { runtime: "splash" }],
  ]);
  // The probe did not answer: serving is null, which is not "nothing serving".
  const blind = await adapter.discover({ ...ctx, mac: { readRuntimeControl: async () => ({ ...view, serving: null }) } });
  assert.equal(blind.models.every((m) => m.processRunning === null), true);
  assert.equal(blind.errors.length, 1);
  const denied = await adapter.discover({ ...ctx, mac: { readRuntimeControl: async () => ({ state: "denied", reason: "no token", serving: null, targets: [] }) } });
  assert.deepEqual(denied.errors, ["no token"]);
  const thrown = await adapter.discover({ ...ctx, mac: { readRuntimeControl: async () => { throw new Error("agent down"); } } });
  assert.equal(thrown.reachable, false);
  assert.deepEqual(thrown.errors, ["agent down"]);
  const refused = await adapter.start({ ...ctx, mac: { beginRuntimeControl: async () => ({ state: "unavailable", reason: "unknown model x", ok: false }) } }, by["mlx-community/gemma-3"]);
  assert.deepEqual(refused, { ok: false, error: "unknown model x" });
  // Busy: the view carries another job's operation (or none) — never reported as success.
  const otherJob = { ...view, busy: true, operation: { id: "old", state: "running", runtime: "splash", action: "stop" } };
  const busy = await adapter.start({ ...ctx, mac: { beginRuntimeControl: async () => otherJob } }, by["mlx-community/gemma-3"]);
  assert.deepEqual(busy, { ok: false, error: MAC_BUSY_ERROR });
  const agentBusy = await adapter.stop({ ...ctx, mac: { beginRuntimeControl: async () => ({ ...view, busy: true }) } }, by["splash-35b"]);
  assert.deepEqual(agentBusy, { ok: false, error: MAC_BUSY_ERROR });
  const otherModel = { ...view, busy: true, operation: { id: "o", state: "running", runtime: "omlx", model: "mlx-community/Qwen3-30B", action: "start" } };
  assert.equal((await adapter.start({ ...ctx, mac: { beginRuntimeControl: async () => otherModel } }, by["mlx-community/gemma-3"])).ok, false);
});

test("launch-profile: launchers are configured models; statuses map to process evidence", async () => {
  const launchers = [
    { id: "qwen-abc123", name: "Qwen vLLM", port: 8000 },
    { id: "glm-def456", name: "GLM", port: null },
    { id: "x-000000", name: "X", port: 9000 },
  ];
  const jobs = [];
  const api = {
    list: () => launchers,
    statuses: async () => ({ "qwen-abc123": "running", "glm-def456": "stopped", "x-000000": "unknown" }),
    latestJob: () => ({ id: "j1", launcherId: "glm-def456", action: "start", status: "failed", exitCode: 1, finishedAt: 5, error: null }),
    startJob: (spark, launcher, action) => {
      jobs.push([spark.id, launcher.id, action]);
      return { ok: true, job: { id: "j2" } };
    },
    readJob: () => ({ lines: [{ seq: 1, text: "hello" }], nextSeq: 1 }),
  };
  const adapter = getAdapter("launch-profile");
  const ctx = { unit: { id: "spark1", platform: "linux" }, launchers: api };
  const r = await adapter.discover(ctx);
  assert.equal(r.reachable, true);
  const by = Object.fromEntries(r.models.map((m) => [m.launcherId, m]));
  assert.equal(by["qwen-abc123"].processRunning, true);
  assert.equal(by["qwen-abc123"].modelId, "Qwen vLLM");
  assert.equal(by["qwen-abc123"].port, 8000);
  assert.equal(by["glm-def456"].processRunning, false);
  assert.equal(by["glm-def456"].lastOperationFailed, true);
  assert.match(by["glm-def456"].lastError, /exit 1/);
  assert.equal(by["x-000000"].processRunning, null);
  assert.equal((await adapter.start(ctx, by["glm-def456"])).ok, true);
  assert.equal((await adapter.stop(ctx, by["qwen-abc123"])).ok, true);
  assert.deepEqual(jobs, [["spark1", "glm-def456", "start"], ["spark1", "qwen-abc123", "stop"]]);
  assert.match((await adapter.start(ctx, { launcherId: "gone" })).error, /not found/);
  // Host unreachable: every status "unknown" → reported, not guessed.
  const blind = await adapter.discover({ ...ctx, launchers: { ...api, statuses: async () => ({}) } });
  assert.equal(blind.reachable, null);
  assert.match(blind.errors[0], /status is unknown/);
  assert.equal(adapter.capabilitiesFor({ unit: { platform: "windows" } }).start, false);
  const busy = await adapter.start({ ...ctx, launchers: { ...api, startJob: () => ({ ok: false, reason: "busy" }) } }, by["glm-def456"]);
  assert.match(busy.error, /another launch script/);
  const logs = await adapter.logs(ctx, by["glm-def456"]);
  assert.deepEqual(logs.lines, [{ seq: 1, text: "hello" }]);
});
