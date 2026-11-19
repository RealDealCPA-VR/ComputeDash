/**
 * Startup preflight and /api/health on hosts that are not the Linux container:
 * a native Windows or macOS host must not be told to mount /root/.ssh keys or
 * verify /proc and /sys host mounts. The platform and filesystem are injected,
 * so these run the same on every OS.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  describeHostRuntime,
  evaluateStartupPreflight,
  inspectStartupPreflight,
  inspectSshIdentity,
  sshIdentityCandidates,
} from "../startupPreflight.js";
import { evaluateHealth, inspectHealth } from "../health.js";

const noFiles = () => false;
const missingStat = () => {
  throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
};
const statOnly = (present, mode = 0o100600) => (file) => {
  if (file === present) return { mode };
  return missingStat();
};
const all = (preflight) => [...preflight.warnings, ...preflight.errors].join("\n");

test("runtime detection: only Linux with a container marker is the container", () => {
  const docker = (file) => file === "/.dockerenv";
  assert.deepEqual(describeHostRuntime({ platform: "linux", exists: docker }), { platform: "linux", container: true });
  assert.deepEqual(describeHostRuntime({ platform: "linux", exists: noFiles }), { platform: "linux", container: false });
  assert.deepEqual(describeHostRuntime({ platform: "win32", exists: () => true }), { platform: "win32", container: false });
  assert.deepEqual(describeHostRuntime({ platform: "darwin", exists: () => true }), { platform: "darwin", container: false });
});

test("Windows looks for keys in %USERPROFILE%\\.ssh, not /root", () => {
  const candidates = sshIdentityCandidates({
    platform: "win32",
    env: { USERPROFILE: "C:\\Users\\op" },
    homedir: () => "C:\\Users\\ignored",
  });
  assert.equal(candidates[0], "C:\\Users\\op\\.ssh\\id_ed25519");
  assert.ok(candidates.every((c) => c.startsWith("C:\\Users\\op\\.ssh\\")));
  assert.ok(!candidates.some((c) => c.includes("/root")));

  // No USERPROFILE: os.homedir() is the fallback, never /root.
  const fallback = sshIdentityCandidates({ platform: "win32", env: {}, homedir: () => "C:\\Users\\home" });
  assert.equal(fallback[0], "C:\\Users\\home\\.ssh\\id_ed25519");
});

test("Linux and macOS use HOME, then os.homedir(); SSH_IDENTITY_FILE always wins", () => {
  assert.equal(sshIdentityCandidates({ platform: "darwin", env: { HOME: "/Users/op" } })[0], "/Users/op/.ssh/id_ed25519");
  assert.equal(sshIdentityCandidates({ platform: "linux", env: {}, homedir: () => "/home/op" })[0], "/home/op/.ssh/id_ed25519");
  assert.equal(sshIdentityCandidates({ platform: "linux", env: {}, homedir: () => "" })[0], "/root/.ssh/id_ed25519");
  assert.deepEqual(
    sshIdentityCandidates({ platform: "win32", env: { SSH_IDENTITY_FILE: "D:\\keys\\fleet", USERPROFILE: "C:\\Users\\op" } }),
    ["D:\\keys\\fleet"]
  );
});

test("an id_rsa key counts as configured; Windows file modes are not judged", () => {
  const win = { platform: "win32", container: false };
  const found = inspectSshIdentity(win, {
    env: { USERPROFILE: "C:\\Users\\op" },
    stat: statOnly("C:\\Users\\op\\.ssh\\id_rsa", 0o100666),
  });
  assert.equal(found.configured, true);
  assert.equal(found.path, "C:\\Users\\op\\.ssh\\id_rsa");
  assert.equal(found.safePermissions, null);

  const linux = { platform: "linux", container: false };
  const open = inspectSshIdentity(linux, { env: { HOME: "/home/op" }, stat: statOnly("/home/op/.ssh/id_ed25519", 0o100644) });
  assert.equal(open.safePermissions, false);
});

test("native Windows host: no /proc, /sys or Docker-mount warnings", () => {
  const preflight = inspectStartupPreflight("127.0.0.1", {
    platform: "win32",
    env: { USERPROFILE: "C:\\Users\\op", SPARKDASH_SECRETS_KEY: "x" },
    exists: noFiles,
    stat: statOnly("C:\\Users\\op\\.ssh\\id_ed25519", 0o100666),
  });
  const text = all(preflight);
  assert.doesNotMatch(text, /\/proc|\/sys|host mounts/);
  assert.doesNotMatch(text, /mounted|\/root/);
  assert.doesNotMatch(text, /mode 600/, "Windows synthetic modes must not trigger the permission warning");
  assert.equal(preflight.fatal, false);
});

test("native Windows host without a key points at %USERPROFILE%\\.ssh", () => {
  const preflight = inspectStartupPreflight("127.0.0.1", {
    platform: "win32",
    env: { USERPROFILE: "C:\\Users\\op", SPARKDASH_SECRETS_KEY: "x" },
    exists: noFiles,
    stat: missingStat,
  });
  const ssh = preflight.warnings.find((w) => /SSH/.test(w));
  assert.ok(ssh, "expected an SSH key warning");
  assert.match(ssh, /C:\\Users\\op\\\.ssh/);
  assert.doesNotMatch(ssh, /mount|\/root/);
});

test("macOS host skips /proc and /sys", () => {
  const preflight = inspectStartupPreflight("127.0.0.1", {
    platform: "darwin",
    env: { HOME: "/Users/op", SPARKDASH_SECRETS_KEY: "x" },
    exists: noFiles,
    stat: statOnly("/Users/op/.ssh/id_ed25519"),
  });
  assert.doesNotMatch(all(preflight), /\/proc|\/sys|host mounts|mounted/);
});

test("the Linux container still warns about missing host mounts and an unmounted key", () => {
  const preflight = inspectStartupPreflight("127.0.0.1", {
    platform: "linux",
    env: { HOME: "/root", SPARKDASH_SECRETS_KEY: "x" },
    exists: (file) => file === "/.dockerenv",
    stat: missingStat,
  });
  const text = all(preflight);
  assert.match(text, /verify \/proc and \/sys host mounts/);
  assert.match(text, /No SSH identity is mounted/);
});

test("a bare Linux host reads its own /proc and /sys", () => {
  const preflight = inspectStartupPreflight("127.0.0.1", {
    platform: "linux",
    env: { HOME: "/home/op", SPARKDASH_SECRETS_KEY: "x" },
    exists: (file) => file === "/proc/meminfo" || file === "/sys",
    stat: statOnly("/home/op/.ssh/id_ed25519"),
  });
  assert.doesNotMatch(all(preflight), /\/proc|\/sys|host mounts/);
});

test("evaluateStartupPreflight keeps the container wording when no runtime is given", () => {
  const preflight = evaluateStartupPreflight({
    bindHost: "127.0.0.1",
    configWritable: true,
    secretsKey: { present: true },
    sshIdentity: { configured: false },
    localCollectors: { available: false },
  });
  assert.match(all(preflight), /host mounts/);
});

test("health: a Windows host without a key is not told the identity is 'not mounted'", () => {
  const health = evaluateHealth({
    bindHost: "127.0.0.1",
    configWritable: true,
    secretsKeyPresent: true,
    sshIdentityPresent: false,
    runtime: { platform: "win32", container: false },
  });
  assert.deepEqual(health.warnings, ["No default SSH key found"]);

  const container = evaluateHealth({
    bindHost: "127.0.0.1",
    configWritable: true,
    secretsKeyPresent: true,
    sshIdentityPresent: false,
    runtime: { platform: "linux", container: true },
  });
  assert.deepEqual(container.warnings, ["SSH identity is not mounted"]);
});

test("health on Windows finds the key under USERPROFILE even with HOME unset", () => {
  const health = inspectHealth("127.0.0.1", {
    platform: "win32",
    env: { USERPROFILE: "C:\\Users\\op", SPARKDASH_SECRETS_KEY: "x" },
    exists: noFiles,
    stat: statOnly("C:\\Users\\op\\.ssh\\id_ed25519"),
  });
  assert.deepEqual(health.warnings, []);
});
