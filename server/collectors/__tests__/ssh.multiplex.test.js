import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  controlDirBase,
  createControlDir,
  ensureMultiplexReady,
  invalidateMultiplex,
  multiplexEnabled,
  sshMultiplexConfig,
} from "../ssh.js";

test("builds a private, isolated control socket config", () => {
  delete process.env.SSH_CONTROL_PERSIST_SECONDS;
  const config = sshMultiplexConfig({ id: "spark-2" }, "10.0.0.2", "sparky", "key", null);
  assert.equal(config.persistSeconds, 60);
  assert.ok(config.args.includes("ControlMaster=auto"));
  assert.ok(config.args.includes("ControlPersist=60"));
  const pathArg = config.args.find((arg) => arg.startsWith("ControlPath="));
  const socketDir = pathArg.slice("ControlPath=".length).replace(/\/[^/]+$/, "");
  assert.ok(fs.statSync(socketDir).isDirectory());
  // Windows has no POSIX directory modes.
  if (process.platform !== "win32") assert.equal(fs.statSync(socketDir).mode & 0o777, 0o700);
});

test("multiplexing: SSH_MULTIPLEX=0 wins, another value opts in, unset is off only on Windows", () => {
  assert.equal(multiplexEnabled({ platform: "linux", env: {} }), true);
  assert.equal(multiplexEnabled({ platform: "darwin", env: { SSH_MULTIPLEX: "" } }), true);
  assert.equal(multiplexEnabled({ platform: "win32", env: {} }), false);
  assert.equal(multiplexEnabled({ platform: "win32", env: { SSH_MULTIPLEX: "" } }), false);
  assert.equal(multiplexEnabled({ platform: "win32", env: { SSH_MULTIPLEX: "1" } }), true);
  assert.equal(multiplexEnabled({ platform: "linux", env: { SSH_MULTIPLEX: "0" } }), false);
  assert.equal(multiplexEnabled({ platform: "win32", env: { SSH_MULTIPLEX: "0" } }), false);
});

test("control-socket directory: /tmp on POSIX, the system temp directory on Windows", () => {
  const tmpdir = () => "C:\\Users\\me\\AppData\\Local\\Temp";
  assert.equal(controlDirBase({ platform: "linux", tmpdir }), "/tmp");
  assert.equal(controlDirBase({ platform: "darwin", tmpdir: () => "/var/folders/very/long/T" }), "/tmp");
  assert.equal(controlDirBase({ platform: "win32", tmpdir }), tmpdir());
});

test("on Windows the control directory is created under os.tmpdir(), never /tmp", () => {
  const made = [];
  const fsImpl = {
    mkdtempSync: (prefix) => { made.push(prefix); return `${prefix}abc123`; },
    chmodSync: () => {},
  };
  const base = path.join(os.tmpdir(), "fake-win-temp");
  const dir = createControlDir({ platform: "win32", tmpdir: () => base, fsImpl, warn: assert.fail });
  assert.deepEqual(made, [path.join(base, "sparkdash-ssh-")]);
  assert.equal(dir, `${path.join(base, "sparkdash-ssh-")}abc123`);
  assert.ok(!made.some((prefix) => prefix.startsWith("/tmp")));
});

test("a control directory that cannot be created disables reuse with one warning instead of throwing", () => {
  const warnings = [];
  const fsImpl = {
    mkdtempSync: () => { throw Object.assign(new Error("ENOENT: no such file or directory, mkdtemp 'C:\\tmp\\sparkdash-ssh-'"), { code: "ENOENT" }); },
    chmodSync: assert.fail,
  };
  const dir = createControlDir({ platform: "linux", fsImpl, warn: (message) => warnings.push(message) });
  assert.equal(dir, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /connection reuse is off/);
});

test("loading ssh.js on a simulated Windows host creates no directory and builds commands without a control socket", () => {
  // Runs in a child process so process.platform and fs are only patched there.
  const moduleUrl = new URL("../ssh.js", import.meta.url).href;
  const script = `
    Object.defineProperty(process, "platform", { value: "win32" });
    const fs = (await import("node:fs")).default;
    const made = [];
    const mkdtempSync = fs.mkdtempSync;
    fs.mkdtempSync = (prefix, ...rest) => { made.push(prefix); return mkdtempSync(prefix, ...rest); };
    const { sshCommandSpec } = await import(${JSON.stringify(moduleUrl)});
    const loaded = made.length;
    const spec = sshCommandSpec({ id: "w", lanIp: "192.168.1.9", ssh: { host: "192.168.1.9", user: "me", auth: "key" } });
    console.log(JSON.stringify({ loaded, made, control: spec.args.filter((arg) => /^Control/.test(arg)), multiplex: spec.multiplex }));
  `;
  const env = { ...process.env };
  delete env.SSH_MULTIPLEX;
  delete env.SSH_CONTROL_PERSIST_SECONDS;
  delete env.SSH_CONTROL_PERSIST;
  delete env.NODE_TEST_CONTEXT;
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8" }));
  assert.equal(result.loaded, 0, "nothing is created at module load");
  assert.deepEqual(result.made, [], "no mkdtemp at all while reuse is off");
  assert.deepEqual(result.control, ["ControlMaster=no", "ControlPath=none"]);
  assert.equal(result.multiplex, null);
});

test("isolates password credentials without exposing them", () => {
  const spark = { id: "test" };
  const first = sshMultiplexConfig(spark, "192.168.1.2", "user", "pass", "secret-one");
  const second = sshMultiplexConfig(spark, "192.168.1.2", "user", "pass", "secret-two");
  assert.notEqual(first.key, second.key);
  assert.equal(first.args.join(" ").includes("secret-one"), false);
});

test("isolates different SSH ports on the same host", () => {
  const spark = { id: "test" };
  const standard = sshMultiplexConfig(spark, "192.168.1.2", "user", "key", null, 22);
  const custom = sshMultiplexConfig(spark, "192.168.1.2", "user", "key", null, 2222);
  assert.notEqual(standard.key, custom.key);
});

test("supports disable and clamps excessive persistence", () => {
  process.env.SSH_CONTROL_PERSIST_SECONDS = "0";
  assert.equal(sshMultiplexConfig({ id: "s" }, "10.0.0.1", "u", "key", null), null);
  process.env.SSH_CONTROL_PERSIST_SECONDS = "99999";
  assert.equal(sshMultiplexConfig({ id: "s" }, "10.0.0.1", "u", "key", null).persistSeconds, 3600);
  delete process.env.SSH_CONTROL_PERSIST_SECONDS;
});

test("a Windows unit moves to a new socket every hour, other units keep theirs", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 30, 2, 0, 0) });
  const windows = { id: "pc", platform: "windows" };
  const linux = { id: "spark" };
  const keys = () => [
    sshMultiplexConfig(windows, "10.0.0.9", "u", "key", null).key,
    sshMultiplexConfig(linux, "10.0.0.2", "u", "key", null).key,
  ];
  const [windowsStart, linuxStart] = keys();
  t.mock.timers.tick(59 * 60 * 1000);
  const [windowsSameHour] = keys();
  t.mock.timers.tick(60 * 1000);
  const [windowsNextHour, linuxNextHour] = keys();
  assert.equal(windowsSameHour, windowsStart);
  assert.notEqual(windowsNextHour, windowsStart);
  assert.equal(linuxNextHour, linuxStart);
});

test("readiness is re-probed once it expires", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 30, 2, 0, 0) });
  const config = { key: "expiry-test", persistSeconds: 60 };
  let calls = 0;
  const establish = async () => { calls += 1; };
  await ensureMultiplexReady(config, establish);
  t.mock.timers.tick(61 * 1000);
  await ensureMultiplexReady(config, establish);
  assert.equal(calls, 2);
});

test("gates concurrent cold probes behind one connection setup", async () => {
  const config = { key: `gate-${Date.now()}`, persistSeconds: 60 };
  let releaseProbe;
  let calls = 0;
  const initial = ensureMultiplexReady(config, async () => {
    calls += 1;
    await new Promise((resolve) => { releaseProbe = resolve; });
  });
  await Promise.resolve();
  const follower = ensureMultiplexReady(config, async () => {
    calls += 1;
  });
  await Promise.resolve();
  assert.equal(calls, 1);
  releaseProbe();
  await Promise.all([initial, follower]);
  assert.equal(calls, 1);
});

test("invalidating a failed transport forces a fresh readiness probe", async () => {
  const config = { key: `invalidate-${Date.now()}`, persistSeconds: 60 };
  let calls = 0;
  const establish = async () => { calls += 1; };
  await ensureMultiplexReady(config, establish);
  invalidateMultiplex(config);
  await ensureMultiplexReady(config, establish);
  assert.equal(calls, 2);
});
