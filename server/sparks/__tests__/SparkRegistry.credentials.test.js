/**
 * Stored credentials belong to the target they were entered for (item 5):
 * moving a unit to another SSH host, user or port drops its stored SSH password
 * unless the same update supplies one, and moving its LLM endpoint drops the
 * per-port LLM API keys (they would otherwise be sent to the new host).
 * patchSpark reports what it dropped as credentialsCleared.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Env must be set before the first import of config.js; each test file runs in its own process.
const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-registry-creds-"));
process.env.SPARKS_JSON_PATH = path.join(TMPDIR, "sparks.json");
process.env.SPARKS_SECRETS_PATH = path.join(TMPDIR, "sparks-secrets.json");
process.env.SECRETS_KEY_PATH = path.join(TMPDIR, ".secrets-key");

const { SparkRegistry } = await import("../SparkRegistry.js");

test.after(() => fs.rmSync(TMPDIR, { recursive: true, force: true }));

/** Synthetic test secrets only. */
const PASSWORD = "test-password";
const LLM_KEY = "sk-test-0000";

function freshRegistry() {
  fs.rmSync(process.env.SPARKS_JSON_PATH, { force: true });
  fs.rmSync(process.env.SPARKS_SECRETS_PATH, { force: true });
  const registry = new SparkRegistry();
  registry.addSpark({
    id: "u",
    name: "U",
    lanIp: "192.168.1.20",
    llmPorts: [8888],
    ssh: { host: "192.168.1.20", user: "spark", auth: "pass", port: 22, password: PASSWORD },
  });
  registry.setLlmApiKey("u", 8888, LLM_KEY);
  return registry;
}

for (const [label, ssh] of [
  ["host", { host: "203.0.113.66" }],
  ["user", { user: "root" }],
  ["port", { port: 2222 }],
]) {
  test(`changing ssh.${label} without a password drops the stored SSH password`, () => {
    const registry = freshRegistry();
    const { spark, credentialsCleared } = registry.patchSpark("u", { ssh });
    assert.equal(registry.hasPassword("u"), false);
    assert.equal(spark.ssh.password, undefined);
    assert.ok(credentialsCleared.includes("sshPassword"));
    // Survives a restart: the secrets file no longer holds it.
    assert.equal(new SparkRegistry().hasPassword("u"), false);
  });
}

test("re-supplying the password with the new host keeps it and reports nothing cleared for SSH", () => {
  const registry = freshRegistry();
  const { credentialsCleared } = registry.patchSpark("u", { ssh: { host: "192.168.1.30", password: "new-test-password" } });
  assert.equal(registry.getSpark("u").ssh.password, "new-test-password");
  assert.equal(credentialsCleared.includes("sshPassword"), false);
});

test("an edit that keeps the SSH target keeps the password and reports nothing", () => {
  const registry = freshRegistry();
  const { credentialsCleared } = registry.patchSpark("u", { name: "Renamed", ssh: { host: "192.168.1.20", user: "spark", port: 22 } });
  assert.equal(registry.getSpark("u").ssh.password, PASSWORD);
  assert.equal(registry.getLlmApiKey("u", 8888), LLM_KEY);
  assert.deepEqual(credentialsCleared, []);
});

test("changing llmHost drops the per-port LLM API keys so they are not sent to the new host", () => {
  const registry = freshRegistry();
  const { spark, credentialsCleared } = registry.patchSpark("u", { llmHost: "203.0.113.66" });
  assert.equal(registry.getLlmApiKey("u", 8888), null);
  assert.equal(spark.llmApiKeys, undefined);
  assert.deepEqual(registry.toPublic(spark).llmApiKeyPorts, []);
  assert.deepEqual(credentialsCleared, ["llmApiKeys"]);
  // The SSH target did not move, so the password stays.
  assert.equal(registry.hasPassword("u"), true);
});

test("changing the LAN IP of a unit without llmHost moves both targets and drops both secrets", () => {
  const registry = freshRegistry();
  const { credentialsCleared } = registry.patchSpark("u", { lanIp: "203.0.113.66", ssh: { host: "203.0.113.66" } });
  assert.deepEqual([...credentialsCleared].sort(), ["llmApiKeys", "sshPassword"]);
  assert.equal(registry.hasPassword("u"), false);
  assert.equal(registry.getLlmApiKey("u", 8888), null);
});

test("nothing to clear is not reported as cleared", () => {
  const registry = freshRegistry();
  registry.setPassword("u", "");
  registry.clearLlmApiKey("u", 8888);
  const { credentialsCleared } = registry.patchSpark("u", { ssh: { host: "203.0.113.66" }, llmHost: "203.0.113.66" });
  assert.deepEqual(credentialsCleared, []);
});

test("PATCH /api/sparks/:id returns credentialsCleared", () => {
  const source = fs.readFileSync(new URL("../../index.js", import.meta.url), "utf8");
  assert.match(source, /const \{ spark, credentialsCleared \} = registry\.patchSpark\(req\.params\.id, body\);/);
  assert.match(source, /hasPassword: registry\.hasPassword\(req\.params\.id\),\s*credentialsCleared,/);
});
