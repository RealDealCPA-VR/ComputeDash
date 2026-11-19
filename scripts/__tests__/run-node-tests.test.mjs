import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { expandPattern, expandPatterns, parseArgs } from "../run-node-tests-lib.mjs";

const runner = fileURLToPath(new URL("../run-node-tests.mjs", import.meta.url));
const isWindows = path.sep === "\\";

function tempDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-node-tests-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, relative, content = "") {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function fixture(t) {
  const root = tempDir(t);
  write(root, "server/__tests__/b.test.js");
  write(root, "server/__tests__/a.test.js");
  write(root, "server/__tests__/C.test.js");
  write(root, "server/__tests__/helper.js");
  write(root, "server/__tests__/.hidden.test.js");
  write(root, "server/__tests__/notes.test.js.bak");
  write(root, "scripts/__tests__/x.test.mjs");
  fs.mkdirSync(path.join(root, "server/__tests__/dir.test.js"));
  fs.mkdirSync(path.join(root, "server/empty/__tests__"), { recursive: true });
  return root;
}

test("expands a final-segment wildcard to sorted files only", (t) => {
  const cwd = fixture(t);
  assert.deepEqual(expandPattern("server/__tests__/*.test.js", { cwd }), [
    "server/__tests__/C.test.js",
    "server/__tests__/a.test.js",
    "server/__tests__/b.test.js",
  ]);
  assert.deepEqual(expandPattern("scripts/__tests__/*.test.mjs", { cwd }), ["scripts/__tests__/x.test.mjs"]);
});

test("keeps an absolute directory, leading separator included", (t) => {
  const cwd = fixture(t);
  const abs = path.join(cwd, "scripts", "__tests__");
  const [file] = expandPattern(`${abs}${path.sep}*.test.mjs`, { cwd: os.tmpdir() });
  assert.equal(path.resolve(file), path.join(abs, "x.test.mjs"));
  assert.ok(path.isAbsolute(file));
});

test("Windows: backslash separators work and come back as forward slashes", { skip: !isWindows }, (t) => {
  const cwd = fixture(t);
  assert.deepEqual(expandPattern("server\\__tests__\\*.test.js", { cwd }), expandPattern("server/__tests__/*.test.js", { cwd }));
  assert.deepEqual(expandPattern("scripts\\__tests__\\x.test.mjs", { cwd }), ["scripts/__tests__/x.test.mjs"]);
  // A UNC-style prefix (here the \\?\ long-path form) keeps both leading separators.
  const unc = `\\\\?\\${path.join(cwd, "scripts", "__tests__")}\\*.test.mjs`;
  assert.deepEqual(expandPattern(unc, { cwd: os.tmpdir() }), [`//?/${path.join(cwd, "scripts", "__tests__").replaceAll("\\", "/")}/x.test.mjs`]);
});

test("POSIX: a backslash is part of the file name, not a separator", { skip: isWindows }, (t) => {
  const cwd = tempDir(t);
  write(cwd, "odd\\name.test.js");
  assert.deepEqual(expandPattern("odd\\*.test.js", { cwd }), ["odd\\name.test.js"]);
});

test("passes an explicit file through and rejects a missing one", (t) => {
  const cwd = fixture(t);
  assert.deepEqual(expandPattern("server/__tests__/helper.js", { cwd }), ["server/__tests__/helper.js"]);
  assert.throws(() => expandPattern("server/__tests__/nope.test.js", { cwd }), /nope\.test\.js: file not found/);
});

test("errors when a wildcard matches nothing or its directory is missing", (t) => {
  const cwd = fixture(t);
  assert.throws(() => expandPattern("server/empty/__tests__/*.test.js", { cwd }), /no files match/);
  assert.throws(() => expandPattern("server/__tests__/*.test.ts", { cwd }), /no files match/);
  assert.throws(() => expandPattern("server/missing/__tests__/*.test.js", { cwd }), /directory server\/missing\/__tests__ not found/);
});

test("rejects wildcards outside the final segment", (t) => {
  const cwd = fixture(t);
  assert.throws(() => expandPattern("server/*/*.test.js", { cwd }), /final path segment/);
});

test("expandPatterns keeps pattern order, drops duplicates and needs a pattern", (t) => {
  const cwd = fixture(t);
  assert.deepEqual(expandPatterns(["scripts/__tests__/*.test.mjs", "server/__tests__/a.test.js", "server/__tests__/*.test.js"], { cwd }), [
    "scripts/__tests__/x.test.mjs",
    "server/__tests__/a.test.js",
    "server/__tests__/C.test.js",
    "server/__tests__/b.test.js",
  ]);
  assert.throws(() => expandPatterns([], { cwd }), /no test patterns/);
});

test("parseArgs splits node flags from patterns at --", () => {
  assert.deepEqual(parseArgs(["a/*.test.js"]), { nodeFlags: [], patterns: ["a/*.test.js"] });
  assert.deepEqual(parseArgs(["--test-concurrency=1", "--", "a/*.test.js"]), {
    nodeFlags: ["--test-concurrency=1"],
    patterns: ["a/*.test.js"],
  });
});

// End to end: run the CLI as npm would, against a temporary suite.

const passing = 'import test from "node:test";\ntest("passes", () => {});\n';
const failing = 'import test from "node:test";\nimport assert from "node:assert";\ntest("fails", () => assert.fail("boom"));\n';

function runCli(cwd, args, script = runner) {
  const env = { ...process.env };
  // Inside `node --test` this is set; a nested runner must not inherit it.
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: "utf8" });
}

function suite(t) {
  const cwd = tempDir(t);
  write(cwd, "ok/one.test.mjs", passing);
  write(cwd, "ok/two.test.mjs", passing);
  write(cwd, "bad/one.test.mjs", passing);
  write(cwd, "bad/two.test.mjs", failing);
  return cwd;
}

test("CLI exits 0 when every expanded test passes", (t) => {
  const result = runCli(suite(t), ["ok/*.test.mjs"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /# pass 2/);
});

test("CLI exits non-zero when a test fails", (t) => {
  const result = runCli(suite(t), ["bad/*.test.mjs"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /# fail 1/);
});

test("CLI exits 2 without running node --test when a pattern matches nothing", (t) => {
  const result = runCli(suite(t), ["ok/*.test.mjs", "typo/*.test.mjs"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /run-node-tests: test pattern typo\/\*\.test\.mjs: directory typo not found/);
  assert.doesNotMatch(result.stdout, /# pass/);
});

test("CLI still runs the tests when invoked through a symlinked directory", (t) => {
  const cwd = suite(t);
  const link = path.join(tempDir(t), "linked-scripts");
  try {
    fs.symlinkSync(path.dirname(runner), link, isWindows ? "junction" : "dir");
  } catch (error) {
    t.skip(`cannot create a directory link here: ${error.code}`);
    return;
  }
  const result = runCli(cwd, ["bad/*.test.mjs"], path.join(link, path.basename(runner)));
  assert.notEqual(result.status, 0, "a failing suite must not pass silently through a link");
  assert.match(result.stdout, /# fail 1/);
});
