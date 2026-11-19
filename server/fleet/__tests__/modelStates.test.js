import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_STATES,
  deriveModelState,
  isValidModelId,
  makeModelKey,
  parseModelKey,
} from "../modelStates.js";

test("all ten PRD states are listed", () => {
  assert.deepEqual(
    [...MODEL_STATES].sort(),
    ["configured", "failed", "installed", "loaded", "serving", "starting", "stopped", "stopping", "unknown", "unreachable"]
  );
});

test("rule 1: unreachable wins over everything, including serving evidence", () => {
  assert.equal(
    deriveModelState({ reachable: false, listed: true, ready: true, loaded: true, operation: "start", installed: true }),
    "unreachable"
  );
});

test("rule 2: an operation in flight → starting / stopping", () => {
  assert.equal(deriveModelState({ operation: "start", listed: true, ready: true }), "starting");
  assert.equal(deriveModelState({ operation: "load" }), "starting");
  assert.equal(deriveModelState({ operation: "stop", listed: true, ready: true }), "stopping");
  assert.equal(deriveModelState({ operation: "unload" }), "stopping");
});

test("rule 3: failed unless newer positive evidence is known", () => {
  assert.equal(deriveModelState({ lastOperationFailed: true, installed: true }), "failed");
  assert.equal(deriveModelState({ lastOperationFailed: true, listed: true, ready: true }), "failed");
  assert.equal(
    deriveModelState({ lastOperationFailed: true, lastFailureAt: 100, observedAt: 50, listed: true, ready: true }),
    "failed"
  );
  assert.equal(
    deriveModelState({ lastOperationFailed: true, lastFailureAt: 100, observedAt: 200, listed: true, ready: true }),
    "serving"
  );
  // Newer evidence that is only negative does not clear the failure.
  assert.equal(
    deriveModelState({ lastOperationFailed: true, lastFailureAt: 100, observedAt: 200, hasProfile: true, processRunning: false }),
    "failed"
  );
});

test("rule 4: listed AND ready → serving", () => {
  assert.equal(deriveModelState({ listed: true, ready: true }), "serving");
});

test("rule 5: loaded, or listed without readiness → loaded", () => {
  assert.equal(deriveModelState({ loaded: true }), "loaded");
  assert.equal(deriveModelState({ loaded: true, ready: true }), "loaded");
  assert.equal(deriveModelState({ listed: true, ready: false }), "loaded");
  assert.equal(deriveModelState({ listed: true, ready: null }), "loaded");
});

test("rule 6: a running profile process is not proof of serving → starting", () => {
  assert.equal(deriveModelState({ hasProfile: true, processRunning: true }), "starting");
});

test("rule 7: profile stopped → stopped after serving this session, otherwise configured", () => {
  assert.equal(deriveModelState({ hasProfile: true, processRunning: false }), "configured");
  assert.equal(deriveModelState({ hasProfile: true, processRunning: false, servedThisSession: true }), "stopped");
  assert.equal(deriveModelState({ hasProfile: true, processRunning: null }), "configured");
  // Process status source failed: not configured (that would be a guess).
  assert.equal(deriveModelState({ hasProfile: true, processRunning: null, discoveryFailed: true }), "unknown");
});

test("rule 8: catalog only → installed", () => {
  assert.equal(deriveModelState({ installed: true }), "installed");
  assert.equal(deriveModelState({ installed: true, discoveryFailed: true }), "installed");
});

test("rule 9: failed discovery or no evidence → unknown, never a guess", () => {
  assert.equal(deriveModelState({ discoveryFailed: true }), "unknown");
  assert.equal(deriveModelState({}), "unknown");
  assert.equal(deriveModelState(), "unknown");
  assert.equal(deriveModelState(/** @type {any} */ (null)), "unknown");
  assert.equal(deriveModelState({ reachable: null }), "unknown");
});

test("model ids: regex, no .., no quotes or shell characters", () => {
  for (const ok of ["llama3.1:8b", "Qwen/Qwen3-30B-A3B", "mlx-community/gemma@4bit", "a", "x+y_z-1"]) {
    assert.equal(isValidModelId(ok), true, ok);
  }
  for (const bad of ["", "-x", "../etc", "a..b", "a b", "a'b", 'a"b', "a;rm", "a$b", "a`b", "a|b", "x".repeat(201), 5, null]) {
    assert.equal(isValidModelId(bad), false, String(bad));
  }
});

test("model keys round-trip, including ids with colons and slashes", () => {
  const k = makeModelKey("ollama", 11434, "llama3.1:8b");
  assert.equal(k, "ollama|11434|llama3.1:8b");
  assert.deepEqual(parseModelKey(k), { engine: "ollama", slot: "11434", port: 11434, profile: null, modelId: "llama3.1:8b" });
  const p = parseModelKey(makeModelKey("launch-profile", "launcher:qwen-abc123", "My Qwen"));
  assert.deepEqual(p, { engine: "launch-profile", slot: "launcher:qwen-abc123", port: null, profile: "launcher:qwen-abc123", modelId: "My Qwen" });
  assert.equal(parseModelKey("nope"), null);
  assert.equal(parseModelKey("a|b|"), null);
  assert.equal(parseModelKey(42), null);
  assert.throws(() => makeModelKey("", 1, "x"));
  assert.throws(() => makeModelKey("a|b", 1, "x"));
  assert.throws(() => makeModelKey("vllm", 1, ""));
});
