import { test } from "node:test";
import assert from "node:assert/strict";
import { registerAdapter } from "../adapters/index.js";
import { OperationRunner, currentModelsFor } from "../operations.js";

/**
 * Hermetic runner tests: a simulated fleet whose inventory is derived from a mutable world.
 * Multi-model control goes through a registered test adapter; single-model control goes
 * through the real launch-profile adapter with a fake LauncherManager.
 */

const GB = 1024 ** 3;
const calls = [];
const world = { models: new Map(), reachable: true, requestsRunning: 0, loadBehavior: "serve" };

registerAdapter(
  {
    engine: "test-mm",
    label: "Test multi-model",
    capabilities: { discover: true, load: true, unload: true, multiModel: true },
    discover: async () => ({ reachable: true, ready: true, models: [], errors: [] }),
    load: async (ctx, id) => {
      if (!ctx.catalog?.includes(id)) return { ok: false, error: "not in catalog" };
      calls.push(`load:${id}`);
      const m = world.models.get(`test-mm|11434|${id}`);
      if (world.loadBehavior === "serve" || (world.loadBehavior === "fail-b" && id !== "phi3:mini")) m.state = "serving";
      else if (world.loadBehavior === "fail" || world.loadBehavior === "fail-b") return { ok: false, error: "out of memory" };
      else m.state = "loaded";
      return { ok: true };
    },
    unload: async (ctx, id) => {
      if (!ctx.catalog?.includes(id)) return { ok: false, error: "not in catalog" };
      calls.push(`unload:${id}`);
      world.models.get(`test-mm|11434|${id}`).state = "installed";
      return { ok: true };
    },
  },
  { replace: true }
);

const MM_CAPS = { discover: true, start: false, stop: false, load: true, unload: true, logs: false, multiModel: true };
const LP_CAPS = { discover: true, start: true, stop: true, load: false, unload: false, logs: true, multiModel: false };

function actionsFor(state) {
  const startable = ["installed", "configured", "stopped", "failed"].includes(state);
  return {
    start: startable,
    stop: ["serving", "loaded", "starting", "failed"].includes(state),
    reload: ["serving", "loaded", "failed"].includes(state),
    switchTo: startable,
  };
}

function mm(id, state, extra = {}) {
  const key = `test-mm|11434|${id}`;
  world.models.set(key, { modelKey: key, modelId: id, label: id, engine: "test-mm", port: 11434, state, estMemoryBytes: null, launcherId: null, macRuntime: null, ...extra });
  return key;
}

function lp(id, state, extra = {}) {
  const key = `launch-profile|launcher:${id}|${id}`;
  world.models.set(key, { modelKey: key, modelId: id, label: id, engine: "launch-profile", port: 8000, state, estMemoryBytes: null, launcherId: id, macRuntime: null, ...extra });
  return key;
}

function inventory(targetId) {
  const models = [...world.models.values()].map((m) => ({ ...m, actions: actionsFor(m.state), sources: [], lastError: null }));
  return {
    targetId,
    collectedAt: Date.now(),
    reachable: world.reachable,
    runtimes: [
      { engine: "test-mm", port: 11434, endpoint: null, reachable: world.reachable, capabilities: MM_CAPS, error: null, requestsRunning: world.requestsRunning },
      { engine: "launch-profile", port: null, endpoint: null, reachable: true, capabilities: LP_CAPS, error: null, requestsRunning: null },
      { engine: "vllm", port: 8000, endpoint: null, reachable: true, capabilities: { ...LP_CAPS, start: false, stop: false }, error: null, requestsRunning: world.requestsRunning },
    ],
    models,
    clusterModels: [],
    errors: world.reachable ? [] : ["connect ECONNREFUSED"],
    stale: false,
  };
}

/** Fake LauncherManager: start makes the model serve unless `startBehavior` says otherwise. */
const jobs = new Map();
let jobSeq = 0;
const launchers = {
  startBehavior: "serve",
  list: () => [...world.models.values()].filter((m) => m.launcherId).map((m) => ({ id: m.launcherId, name: m.launcherId, port: 8000 })),
  startJob: (spark, launcher, action) => {
    calls.push(`${action}:${launcher.id}`);
    const job = { id: `job${++jobSeq}`, launcherId: launcher.id, action, status: "running", exitCode: null, error: null, lines: [{ seq: 1, text: `${action}.sh for ${launcher.id}` }] };
    jobs.set(job.id, job);
    const m = world.models.get(`launch-profile|launcher:${launcher.id}|${launcher.id}`);
    if (action === "stop" && launchers.stopBehavior === "fail") {
      job.status = "failed";
      job.exitCode = 1;
      job.error = "stop.sh exited 1";
    } else if (action === "stop" && launchers.stopBehavior === "slow") {
      setTimeout(() => {
        m.state = "configured";
        job.status = "completed";
        job.exitCode = 0;
      }, 60);
    } else if (action === "stop") {
      m.state = "configured";
      job.status = "completed";
      job.exitCode = 0;
    } else if (launchers.startBehavior === "exit1") {
      m.state = "starting";
      setTimeout(() => {
        m.state = "configured";
        job.status = "failed";
        job.exitCode = 1;
      }, 10);
    } else if (m.port == null) {
      m.state = "starting"; // a port-less profile can only ever show its process running
    } else if (launchers.startBehavior === "serve" || (launchers.startBehavior === "hang-b" && launcher.id !== "gemma-b")) {
      m.state = "serving";
    } else {
      m.state = "starting";
    }
    return { ok: true, job: { ...job } };
  },
  readJob: (unitId, jobId, since) => {
    const job = jobs.get(jobId);
    if (!job) return null;
    return { job: { ...job }, lines: job.lines.filter((l) => l.seq > since), nextSeq: job.lines.length };
  },
};

const targets = {
  "node:spark1": { targetId: "node:spark1", kind: "node", name: "Spark 1", memberIds: [], unitId: "spark1", memoryTotalBytes: 128 * GB },
  "node:spark2": { targetId: "node:spark2", kind: "node", name: "Spark 2", memberIds: [], unitId: "spark2", memoryTotalBytes: 128 * GB },
  "cluster:sparks": { targetId: "cluster:sparks", kind: "cluster", name: "Sparks", memberIds: ["spark1", "spark2"], unitId: "spark1", memoryTotalBytes: 256 * GB },
};

function setup(opts = {}) {
  calls.length = 0;
  world.models.clear();
  world.reachable = true;
  world.requestsRunning = 0;
  world.loadBehavior = "serve";
  launchers.startBehavior = "serve";
  launchers.stopBehavior = "ok";
  const events = [];
  let scopesClosed = 0;
  const { host: hostOverrides = {}, ...rest } = opts;
  const runner = new OperationRunner({
    host: {
      getTarget: (id) => targets[id] ?? null,
      openScope: () => ({ close: () => (scopesClosed += 1) }),
      collect: async (id) => inventory(id),
      refresh: async (id) => inventory(id),
      contextFor: async () => ({ unit: { id: "spark1", platform: "linux" }, launchers }),
      launchers,
      ...hostOverrides,
    },
    recordEvent: (e) => events.push(e),
    readinessTimeoutMs: { node: 200, cluster: 300 },
    stopTimeoutMs: 200,
    pollMs: { initial: 5, max: 20, job: 5 },
    startSettleMs: 40,
    ...rest,
  });
  return { runner, events, scopesClosed: () => scopesClosed };
}

async function settle(runner, id) {
  for (let i = 0; i < 400; i += 1) {
    const op = runner.get(id);
    if (op.status !== "running") return op;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("operation did not finish");
}

const stepStatus = (op) => Object.fromEntries(op.steps.map((s) => [s.id, s.status]));

test("switch on a multi-model runtime: unload the current model, then load the requested one", async () => {
  const { runner, events, scopesClosed } = setup();
  const a = mm("llama3.1:8b", "serving");
  const b = mm("phi3:mini", "installed");
  const res = runner.start("node:spark1", { action: "switch", modelKey: b });
  assert.equal(res.ok, true);
  assert.equal(res.operation.status, "running");
  const op = await settle(runner, res.operation.id);
  assert.equal(op.status, "succeeded", op.error);
  assert.deepEqual(calls, ["unload:llama3.1:8b", "load:phi3:mini"]);
  assert.equal(op.fromModelKey, a);
  assert.deepEqual(stepStatus(op), {
    reachable: "done",
    available: "done",
    capacity: "done",
    guard: "done",
    "stop-current": "done",
    start: "done",
    ready: "done",
    refresh: "done",
  });
  assert.deepEqual(events.map((e) => e.type), ["fleet.switch.started", "fleet.switch.succeeded"]);
  assert.equal(events[1].severity, "success");
  assert.equal(runner.isBusy("node:spark1"), false);
  assert.equal(scopesClosed(), 1);
  const read = runner.read(op.id, 0);
  assert.ok(read.lines.length > 5);
  assert.ok(read.lines.every((l) => /^\d{4}-\d\d-\d\dT/.test(l.text)), "every line is timestamped");
  const tail = runner.read(op.id, read.nextSeq - 2);
  assert.equal(tail.lines.length, 2);
  assert.equal(tail.nextSeq, read.nextSeq);
});

test("switch with an unreachable target changes nothing", async () => {
  const { runner, events } = setup();
  mm("llama3.1:8b", "serving");
  const b = mm("phi3:mini", "installed");
  world.reachable = false;
  const op = await settle(runner, runner.start("node:spark1", { action: "switch", modelKey: b }).operation.id);
  assert.equal(op.status, "failed");
  assert.match(op.error, /not reachable/);
  assert.deepEqual(calls, []);
  assert.equal(stepStatus(op).reachable, "failed");
  assert.equal(stepStatus(op).start, "skipped");
  // Nothing was touched: the model does not turn "failed".
  assert.equal(runner.lastFailure("node:spark1", b), null);
  assert.equal(events.at(-1).type, "fleet.switch.failed");
  assert.equal(events.at(-1).severity, "error");
});

test("an estimate over capacity needs force", async () => {
  const { runner } = setup();
  mm("llama3.1:8b", "serving");
  const big = mm("llama3.1:405b", "installed", { estMemoryBytes: 230 * GB });
  let op = await settle(runner, runner.start("node:spark1", { action: "switch", modelKey: big }).operation.id);
  assert.equal(op.status, "failed");
  assert.match(op.error, /exceeds.*force/);
  assert.equal(stepStatus(op).capacity, "failed");
  assert.deepEqual(calls, []);

  op = await settle(runner, runner.start("node:spark1", { action: "switch", modelKey: big, force: true }).operation.id);
  assert.equal(op.status, "succeeded", op.error);
  assert.match(op.steps.find((s) => s.id === "capacity").detail, /force/);
});

test("unknown capacity is reported as unknown, not as a fit", async () => {
  const { runner } = setup();
  const b = mm("phi3:mini", "installed");
  const op = await settle(runner, runner.start("node:spark1", { action: "start", modelKey: b }).operation.id);
  assert.equal(op.status, "succeeded", op.error);
  assert.match(op.steps.find((s) => s.id === "capacity").detail, /^unknown/);
});

test("in-flight requests on the current model need force", async () => {
  const { runner } = setup();
  mm("llama3.1:8b", "serving");
  const b = mm("phi3:mini", "installed");
  world.requestsRunning = 2;
  let op = await settle(runner, runner.start("node:spark1", { action: "switch", modelKey: b }).operation.id);
  assert.equal(op.status, "failed");
  assert.match(op.error, /2 requests are in flight/);
  assert.equal(stepStatus(op).guard, "failed");
  assert.deepEqual(calls, []);

  op = await settle(runner, runner.start("node:spark1", { action: "switch", modelKey: b, force: true }).operation.id);
  assert.equal(op.status, "succeeded", op.error);
  assert.deepEqual(calls, ["unload:llama3.1:8b", "load:phi3:mini"]);
});

test("readiness timeout fails the switch and rolls back to the previous model", async () => {
  const { runner, events } = setup();
  const a = lp("qwen-a", "serving");
  const b = lp("gemma-b", "configured");
  launchers.startBehavior = "hang-b"; // gemma-b's start script runs but it never serves
  const op = await settle(runner, runner.start("node:spark1", { action: "switch", modelKey: b }).operation.id);
  assert.equal(op.status, "failed");
  assert.match(op.error, /not ready after/);
  assert.equal(op.fromModelKey, a);
  const st = stepStatus(op);
  assert.equal(st.ready, "failed");
  assert.equal(st["rollback-stop"], "done");
  assert.equal(st["rollback-start"], "done");
  assert.equal(st["rollback-ready"], "done");
  assert.deepEqual(calls, ["stop:qwen-a", "start:gemma-b", "stop:gemma-b", "start:qwen-a"]);
  assert.equal(world.models.get(a).state, "serving");
  assert.ok(runner.lastFailure("node:spark1", b)?.error.includes("not ready"));
  const text = runner.read(op.id).lines.map((l) => l.text).join("\n");
  assert.match(text, /│ stop\.sh for qwen-a/, "launcher output is mirrored into the operation log");
  assert.match(text, /rollback succeeded/);
  assert.equal(events.at(-1).type, "fleet.switch.failed");
});

test("rollback: false leaves the previous model stopped", async () => {
  const { runner } = setup();
  const a = lp("qwen-a", "serving");
  const b = lp("gemma-b", "configured");
  launchers.startBehavior = "hang";
  const op = await settle(runner, runner.start("node:spark1", { action: "switch", modelKey: b, rollback: false }).operation.id);
  assert.equal(op.status, "failed");
  assert.deepEqual(calls, ["stop:qwen-a", "start:gemma-b"]);
  assert.equal(world.models.get(a).state, "configured");
  assert.equal(op.steps.some((s) => s.id.startsWith("rollback")), false);
});

test("a failed load rolls a multi-model switch back with load of the previous model", async () => {
  const { runner } = setup();
  mm("llama3.1:8b", "serving");
  const b = mm("phi3:mini", "installed");
  world.loadBehavior = "fail";
  const op = await settle(runner, runner.start("node:spark1", { action: "switch", modelKey: b }).operation.id);
  assert.equal(op.status, "failed");
  assert.match(op.error, /out of memory/);
  assert.deepEqual(calls.slice(0, 1), ["unload:llama3.1:8b"]);
  assert.equal(stepStatus(op)["rollback-start"], "failed"); // the fake fails every load
});

test("cancel stops the waiting and never stops what already started", async () => {
  const { runner, events } = setup();
  const b = lp("gemma-b", "configured");
  launchers.startBehavior = "hang";
  const res = runner.start("node:spark1", { action: "start", modelKey: b });
  for (let i = 0; i < 100 && runner.inFlight("node:spark1", b) !== "start"; i += 1) await new Promise((r) => setTimeout(r, 2));
  assert.equal(runner.inFlight("node:spark1", b), "start");
  assert.deepEqual(runner.cancel(res.operation.id), { cancelled: true });
  const op = await settle(runner, res.operation.id);
  assert.equal(op.status, "cancelled");
  assert.deepEqual(calls, ["start:gemma-b"]);
  assert.equal(world.models.get(b).state, "starting");
  assert.equal(runner.isBusy("node:spark1"), false);
  assert.equal(runner.inFlight("node:spark1", b), null);
  assert.equal(runner.cancel(res.operation.id).cancelled, false);
  assert.equal(runner.cancel("op-000000000000"), null);
  assert.equal(events.at(-1).type, "fleet.start.cancelled");
});

test("one operation per target: busy until it finishes", async () => {
  const { runner } = setup();
  const b = lp("gemma-b", "configured");
  launchers.startBehavior = "hang";
  const first = runner.start("node:spark1", { action: "start", modelKey: b });
  const second = runner.start("node:spark1", { action: "start", modelKey: b });
  assert.equal(second.ok, false);
  assert.equal(second.code, "busy");
  await settle(runner, first.operation.id);
  assert.equal(runner.start("node:spark1", { action: "start", modelKey: b }).ok, true);
});

test("a cluster operation locks every member node, and a node operation blocks its clusters", async () => {
  const { runner } = setup();
  const b = lp("gemma-b", "configured");
  launchers.startBehavior = "hang";
  const cl = runner.start("cluster:sparks", { action: "start", modelKey: b });
  assert.equal(cl.ok, true);
  assert.deepEqual([...runner.busyTargetIds()].sort(), ["cluster:sparks", "node:spark1", "node:spark2"]);
  const node = runner.start("node:spark2", { action: "start", modelKey: b });
  assert.equal(node.code, "busy");
  assert.match(node.error, /cluster:sparks/);
  runner.cancel(cl.operation.id);
  await settle(runner, cl.operation.id);
  assert.equal(runner.busyTargetIds().size, 0);

  const n = runner.start("node:spark1", { action: "start", modelKey: b });
  assert.equal(n.ok, true);
  assert.equal(runner.start("cluster:sparks", { action: "start", modelKey: b }).code, "busy");
  assert.equal(runner.start("node:spark2", { action: "start", modelKey: b }).ok, true, "other nodes are free");
  runner.shutdown();
});

test("stop waits for the launcher job and the model to leave the runtime", async () => {
  const { runner } = setup();
  const a = lp("qwen-a", "serving");
  const op = await settle(runner, runner.start("node:spark1", { action: "stop", modelKey: a }).operation.id);
  assert.equal(op.status, "succeeded", op.error);
  assert.deepEqual(calls, ["stop:qwen-a"]);
  assert.deepEqual(op.steps.map((s) => s.id), ["reachable", "available", "guard", "stop", "refresh"]);
});

test("reload stops and starts the same model", async () => {
  const { runner } = setup();
  const a = mm("llama3.1:8b", "serving");
  const op = await settle(runner, runner.start("node:spark1", { action: "reload", modelKey: a }).operation.id);
  assert.equal(op.status, "succeeded", op.error);
  assert.deepEqual(calls, ["unload:llama3.1:8b", "load:llama3.1:8b"]);
});

test("start refuses a model that is already serving, and an unknown model", async () => {
  const { runner } = setup();
  const a = mm("llama3.1:8b", "serving");
  let op = await settle(runner, runner.start("node:spark1", { action: "start", modelKey: a }).operation.id);
  assert.equal(op.status, "failed");
  assert.match(op.error, /already serving/);
  op = await settle(runner, runner.start("node:spark1", { action: "start", modelKey: "test-mm|11434|nope" }).operation.id);
  assert.equal(op.status, "failed");
  assert.match(op.error, /is not on Spark 1/);
  assert.deepEqual(calls, []);
});

test("start validates its request and target synchronously", () => {
  const { runner } = setup();
  assert.equal(runner.start("node:spark1", { action: "explode", modelKey: "x" }).code, "validation");
  assert.equal(runner.start("node:nope", { action: "start", modelKey: "a|1|b" }).code, "unknown_target");
});

test("currentModelsFor picks the runtime's active models only", () => {
  setup();
  mm("a", "serving");
  mm("b", "installed");
  const target = mm("c", "installed");
  lp("x", "serving");
  const inv = inventory("node:spark1");
  const model = inv.models.find((m) => m.modelKey === target);
  assert.deepEqual(currentModelsFor(inv, model, "multi").map((m) => m.modelId), ["a"]);
  const lpModel = { ...inv.models.find((m) => m.modelId === "x"), modelKey: "other", launcherId: "y" };
  assert.deepEqual(currentModelsFor(inv, lpModel, "launcher").map((m) => m.modelId).sort(), ["x"]);
});

test("finished operations are retained up to the bound", async () => {
  const { runner } = setup({ maxRecords: 2 });
  const b = mm("phi3:mini", "installed");
  const ids = [];
  for (let i = 0; i < 4; i += 1) {
    const r = runner.start("node:spark1", { action: "start", modelKey: b });
    ids.push(r.operation.id);
    await settle(runner, r.operation.id);
    world.models.get(b).state = "installed";
  }
  assert.equal(runner.get(ids[0]), null);
  assert.equal(runner.get(ids[1]), null);
  assert.ok(runner.get(ids[3]));
});

test("cancel is refused outside the readiness wait and the operation carries on", async () => {
  const { runner } = setup();
  const a = lp("qwen-a", "serving");
  launchers.stopBehavior = "slow";
  const res = runner.start("node:spark1", { action: "stop", modelKey: a });
  for (let i = 0; i < 100 && runner.inFlight("node:spark1", a) !== "stop"; i += 1) await new Promise((r) => setTimeout(r, 2));
  assert.deepEqual(runner.cancel(res.operation.id), { cancelled: false, reason: "Cancel is only possible while waiting for readiness" });
  const op = await settle(runner, res.operation.id);
  assert.equal(op.status, "succeeded", op.error);
  assert.equal(world.models.get(a).state, "configured");
});

test("a port-less launch profile: start watches the script and never claims serving", async () => {
  const { runner } = setup();
  const p = lp("batch", "configured", { port: null });
  const op = await settle(runner, runner.start("node:spark1", { action: "start", modelKey: p }).operation.id);
  assert.equal(op.status, "succeeded", op.error);
  const ready = op.steps.find((s) => s.id === "ready");
  assert.equal(ready.status, "done");
  assert.equal(ready.detail, "process running; serving not verified (no port)");
  assert.equal(world.models.get(p).state, "starting");
});

test("a port-less launch profile whose start script exits 1 fails the start", async () => {
  const { runner } = setup();
  const p = lp("batch", "configured", { port: null });
  launchers.startBehavior = "exit1";
  const op = await settle(runner, runner.start("node:spark1", { action: "start", modelKey: p }).operation.id);
  assert.equal(op.status, "failed");
  assert.match(op.error, /start script for batch failed.*exit 1/);
  assert.ok(runner.lastFailure("node:spark1", p));
});

test("switch and reload to a port-less launch profile are refused before anything changes", async () => {
  const { runner } = setup();
  const a = lp("qwen-a", "serving", { port: null });
  const b = lp("batch", "configured", { port: null });
  let op = await settle(runner, runner.start("node:spark1", { action: "switch", modelKey: b }).operation.id);
  assert.equal(op.status, "failed");
  assert.equal(op.error, "Set a port on this launch profile so readiness can be verified before switching");
  assert.equal(op.steps.find((s) => s.id === "available").status, "failed");
  op = await settle(runner, runner.start("node:spark1", { action: "reload", modelKey: a }).operation.id);
  assert.equal(op.status, "failed");
  assert.match(op.error, /Set a port/);
  assert.deepEqual(calls, []);
  assert.equal(runner.lastFailure("node:spark1", b), null);
});

test("switch stops only the same runtime: a launch profile on another port keeps running", async () => {
  const { runner } = setup();
  const other = lp("b9000", "serving", { port: 9000 });
  const same = lp("c8000", "serving");
  const a = lp("a8000", "configured");
  const op = await settle(runner, runner.start("node:spark1", { action: "switch", modelKey: a }).operation.id);
  assert.equal(op.status, "succeeded", op.error);
  assert.deepEqual(calls, ["stop:c8000", "start:a8000"]);
  assert.deepEqual(op.fromModelKeys, [same]);
  assert.equal(op.fromModelKey, same);
  assert.equal(world.models.get(other).state, "serving");
});

test("several models on the runtime: all are listed, stopped, and restored by rollback", async () => {
  const { runner } = setup();
  const a1 = mm("a1", "serving");
  const a2 = mm("a2", "loaded");
  const b = mm("phi3:mini", "installed");
  world.loadBehavior = "fail-b";
  const op = await settle(runner, runner.start("node:spark1", { action: "switch", modelKey: b }).operation.id);
  assert.equal(op.status, "failed");
  assert.deepEqual([...op.fromModelKeys].sort(), [a1, a2].sort());
  assert.match(op.steps.find((s) => s.id === "available").detail, /a1.*a2|a2.*a1/);
  assert.deepEqual(calls, ["unload:a1", "unload:a2", "load:phi3:mini", "load:a1", "load:a2"]);
  assert.equal(op.steps.find((s) => s.id === "rollback-ready").status, "done");
  assert.equal(world.models.get(a1).state, "serving");
  assert.equal(world.models.get(a2).state, "serving");
});

test("errors before any dispatch never mark a model failed", async () => {
  // P3: the fresh inventory itself fails (e.g. a collection timeout).
  const timesOut = async () => {
    throw new Error("inventory of node:spark1 timed out");
  };
  let { runner } = setup({ host: { collect: timesOut } });
  const a = mm("llama3.1:8b", "serving");
  const b = mm("phi3:mini", "installed");
  let op = await settle(runner, runner.start("node:spark1", { action: "switch", modelKey: b }).operation.id);
  assert.equal(op.status, "failed");
  assert.match(op.error, /timed out/);
  assert.equal(runner.lastFailure("node:spark1", b), null);

  // P5: building the adapter context throws before the stop is sent.
  const noContext = async () => {
    throw new Error("no SSH identity");
  };
  ({ runner } = setup({ host: { contextFor: noContext } }));
  mm("llama3.1:8b", "serving");
  mm("phi3:mini", "installed");
  op = await settle(runner, runner.start("node:spark1", { action: "switch", modelKey: b }).operation.id);
  assert.equal(op.status, "failed");
  assert.match(op.error, /no SSH identity/);
  assert.deepEqual(calls, []);
  assert.equal(runner.lastFailure("node:spark1", a), null);
  assert.equal(runner.lastFailure("node:spark1", b), null);
});

test("a failed stop is recorded against the model being stopped, not the requested one", async () => {
  const { runner } = setup();
  const a = lp("qwen-a", "serving");
  const b = lp("gemma-b", "configured");
  launchers.stopBehavior = "fail";
  const op = await settle(runner, runner.start("node:spark1", { action: "switch", modelKey: b }).operation.id);
  assert.equal(op.status, "failed");
  assert.match(op.error, /stop script for qwen-a failed/);
  assert.deepEqual(calls, ["stop:qwen-a"]);
  assert.ok(runner.lastFailure("node:spark1", a));
  assert.equal(runner.lastFailure("node:spark1", b), null);
});

test("unknown in-flight requests are reported as not checked", async () => {
  const { runner } = setup();
  const a = lp("qwen-a", "serving", { port: 7777 });
  const op = await settle(runner, runner.start("node:spark1", { action: "stop", modelKey: a }).operation.id);
  assert.equal(op.status, "succeeded", op.error);
  assert.match(op.steps.find((s) => s.id === "guard").detail, /in-flight requests unknown — not checked/);
});
