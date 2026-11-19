/**
 * `npm run setup` (scripts/setup.mjs). Runs against temporary directories with
 * injected child processes and randomness: no network, no real token.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildSummary,
  checkNodeVersion,
  ensureTokenInEnv,
  generateToken,
  parseArgs,
  parseTailscaleStatus,
  psQuote,
  readEnvValue,
  runSetup,
  windowsLogonTaskSnippet,
} from "../setup-lib.mjs";

// A recognisable fake token: 32 bytes of 0xab. Never a real secret.
const FAKE_BYTES = () => Buffer.alloc(32, 0xab);
const FAKE_TOKEN = "ab".repeat(32);

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "computedash-setup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** No ssh, no tailscale: both spawn as ENOENT. */
const nothingInstalled = () => ({ error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }), status: null, stdout: "", stderr: "" });

function withTools({ ssh = true, tailscale = null } = {}) {
  return (cmd) => {
    if (cmd === "ssh" && ssh) return { status: 0, stdout: "", stderr: "OpenSSH_9.6p1, OpenSSL 3.0.13\n" };
    if (cmd === "tailscale" && tailscale) return { status: 0, stdout: JSON.stringify(tailscale), stderr: "" };
    return nothingInstalled();
  };
}

function setup(root, extra = {}) {
  return runSetup({
    root,
    env: {},
    platform: "linux",
    nodeVersion: "v22.22.2",
    nodePath: "/usr/bin/node",
    run: nothingInstalled,
    randomBytes: FAKE_BYTES,
    ...extra,
  });
}

test("Node version check accepts 22+ and explains how to upgrade", () => {
  assert.equal(checkNodeVersion("v22.0.0").ok, true);
  assert.equal(checkNodeVersion("v24.1.3").ok, true);
  const old = checkNodeVersion("v20.18.1");
  assert.equal(old.ok, false);
  assert.match(old.message, /needs Node 22/);
  assert.match(old.message, /nvm install 22/);
  assert.equal(checkNodeVersion("banana").ok, false);
});

test("Node too old is the hard failure: exit 1 and nothing written", (t) => {
  const root = tempRoot(t);
  fs.writeFileSync(path.join(root, ".env.example"), "PORT=5555\n");
  const result = setup(root, { nodeVersion: "v18.20.0" });
  assert.equal(result.exitCode, 1);
  assert.equal(fs.existsSync(path.join(root, ".env")), false);
  assert.match(result.output, /too old/);
});

test("readEnvValue follows dotenv: comments ignored, quotes stripped, last wins", () => {
  const text = "# SPARKDASH_TOKEN=commented\nA=1\nexport B='two' # note\nC=three # trailing\nA=4\n";
  assert.equal(readEnvValue(text, "SPARKDASH_TOKEN"), undefined);
  assert.equal(readEnvValue(text, "A"), "4");
  assert.equal(readEnvValue(text, "B"), "two");
  assert.equal(readEnvValue(text, "C"), "three");
});

test("ensureTokenInEnv never replaces an existing token", () => {
  const text = "PORT=5555\nSPARKDASH_TOKEN=keepme\n";
  const r = ensureTokenInEnv(text, FAKE_TOKEN);
  assert.equal(r.changed, false);
  assert.equal(r.text, text);
  const legacy = ensureTokenInEnv("DASHBOARD_TOKEN=old\n", FAKE_TOKEN);
  assert.equal(legacy.changed, false);
  assert.equal(legacy.reason, "legacy");
});

test("ensureTokenInEnv fills an empty token line in place and keeps CRLF bytes", () => {
  const text = "PORT=5555\r\n# keep this comment\r\nSPARKDASH_TOKEN=\r\nBIND_HOST=127.0.0.1";
  const r = ensureTokenInEnv(text, FAKE_TOKEN);
  assert.equal(r.reason, "filled");
  assert.equal(r.text, `PORT=5555\r\n# keep this comment\r\nSPARKDASH_TOKEN=${FAKE_TOKEN}\r\nBIND_HOST=127.0.0.1`);
});

test("ensureTokenInEnv appends after the untouched original bytes", () => {
  const original = "PORT=5555\n# SPARKDASH_TOKEN=\nBIND_HOST=127.0.0.1"; // no final newline
  const r = ensureTokenInEnv(original, FAKE_TOKEN);
  assert.equal(r.reason, "appended");
  assert.ok(r.text.startsWith(original + "\n"), "original bytes must be a prefix");
  assert.equal(readEnvValue(r.text, "SPARKDASH_TOKEN"), FAKE_TOKEN);
  const crlf = ensureTokenInEnv("A=1\r\n", FAKE_TOKEN);
  assert.ok(crlf.text.startsWith("A=1\r\n#"));
  assert.ok(crlf.text.endsWith(`SPARKDASH_TOKEN=${FAKE_TOKEN}\r\n`));
});

test("generateToken is 64 hex characters from 32 random bytes", () => {
  assert.equal(generateToken(FAKE_BYTES), FAKE_TOKEN);
  assert.match(generateToken(), /^[0-9a-f]{64}$/);
});

test("parseTailscaleStatus reads Self.DNSName and tolerates junk", () => {
  assert.deepEqual(parseTailscaleStatus({ BackendState: "Running", Self: { DNSName: "box.tail1234.ts.net." } }), {
    dnsName: "box.tail1234.ts.net",
    backendState: "Running",
  });
  assert.equal(parseTailscaleStatus("not json"), null);
  assert.equal(parseTailscaleStatus({ Self: {} }), null);
});

test("first run creates .env from .env.example with a token, without printing it", (t) => {
  const root = tempRoot(t);
  const example = "PORT=5555\n# SPARKDASH_TOKEN=\nBIND_HOST=127.0.0.1\n";
  fs.writeFileSync(path.join(root, ".env.example"), example);
  const result = setup(root);
  assert.equal(result.exitCode, 0);
  const env = fs.readFileSync(path.join(root, ".env"), "utf8");
  assert.ok(env.startsWith(example), ".env.example content is kept byte for byte");
  assert.equal(readEnvValue(env, "SPARKDASH_TOKEN"), FAKE_TOKEN);
  assert.ok(!result.output.includes(FAKE_TOKEN), "the token is not printed without --print-token");
  assert.match(result.output, /Created \.env from \.env\.example/);
  assert.match(result.output, /--print-token/);
  assert.ok(fs.existsSync(path.join(root, "config")), "config/ is created");
  assert.match(result.output, /run npm run build/);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(root, ".env")).mode & 0o777, 0o600);
  }
  assert.deepEqual(fs.readdirSync(root).filter((f) => f.endsWith(".tmp")), [], "no temp file left behind");
});

test("second run is idempotent: same bytes, token kept", (t) => {
  const root = tempRoot(t);
  const existing = "# my settings\r\nPORT=6000\r\nSPARKDASH_TOKEN=already-here\r\n";
  fs.writeFileSync(path.join(root, ".env"), existing);
  const first = setup(root, { randomBytes: () => Buffer.alloc(32, 0x01) });
  assert.equal(fs.readFileSync(path.join(root, ".env"), "utf8"), existing);
  assert.match(first.output, /left unchanged/);
  assert.match(first.output, /http:\/\/127\.0\.0\.1:6000/, "PORT from .env is used in the URL");
  assert.match(first.output, /tailscale serve --bg 6000/);
});

test("--print-token prints the token; --check writes nothing", (t) => {
  const root = tempRoot(t);
  fs.writeFileSync(path.join(root, ".env.example"), "PORT=5555\n");
  const check = setup(root, { argv: ["--check"] });
  assert.equal(check.exitCode, 0);
  assert.equal(fs.existsSync(path.join(root, ".env")), false);
  assert.equal(fs.existsSync(path.join(root, "config")), false);
  assert.match(check.output, /check only/);
  assert.match(check.output, /SPARKDASH_TOKEN is not set/);

  const printed = setup(root, { argv: ["--print-token"] });
  assert.ok(printed.output.includes(`Token: ${FAKE_TOKEN}`));
});

test("Windows: OpenSSH hint, Tailscale name, and a printed (not run) logon task", (t) => {
  const root = tempRoot(t);
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (cmd === "tailscale") return { status: 0, stdout: JSON.stringify({ Self: { DNSName: "dash.tailnet.ts.net." } }), stderr: "" };
    return nothingInstalled();
  };
  const result = setup(root, { platform: "win32", nodePath: "C:\\Program Files\\nodejs\\node.exe", run });
  assert.deepEqual(calls, ["ssh -V", "tailscale status --json"], "only read-only probes are run");
  assert.match(result.output, /OpenSSH Client/);
  assert.match(result.output, /https:\/\/dash\.tailnet\.ts\.net/);
  assert.match(result.output, /Register-ScheduledTask -TaskName 'ComputeDash'/);
  assert.match(result.output, /-ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
});

test("tools present on Linux: ssh version is reported, no logon task", (t) => {
  const root = tempRoot(t);
  const result = setup(root, { run: withTools({ tailscale: { Self: { DNSName: "spark.tailnet.ts.net." } } }) });
  assert.match(result.output, /ssh: OpenSSH_9\.6p1/);
  assert.match(result.output, /this machine is spark\.tailnet\.ts\.net/);
  assert.doesNotMatch(result.output, /Register-ScheduledTask/);
});

test("an old open-remote opt-in in .env is flagged", (t) => {
  const root = tempRoot(t);
  fs.writeFileSync(path.join(root, ".env"), "SPARKDASH_ALLOW_OPEN_REMOTE=1\nSPARKDASH_TOKEN=x\n");
  assert.match(setup(root).output, /SPARKDASH_ALLOW_OPEN_REMOTE=1 is set/);
});

test("psQuote and the snippet escape single quotes in paths", () => {
  assert.equal(psQuote("C:\\O'Brien\\dash"), "'C:\\O''Brien\\dash'");
  const snippet = windowsLogonTaskSnippet({ nodePath: "C:\\node.exe", root: "C:\\O'Brien\\dash" });
  assert.match(snippet, /-WorkingDirectory 'C:\\O''Brien\\dash'/);
});

test("parseArgs and summary without a token", () => {
  assert.deepEqual(parseArgs(["--check", "--print-token", "--nope"]), { check: true, printToken: true, help: false, unknown: ["--nope"] });
  const text = buildSummary({ items: [], platform: "linux", distBuilt: true, port: 5555 });
  assert.match(text, /No SPARKDASH_TOKEN yet/);
  assert.doesNotMatch(text, /npm run build/);
});

test("a BOM-prefixed .env keeps its token, and an empty SPARKDASH_TOKEN never shadows DASHBOARD_TOKEN", () => {
  const bom = "﻿SPARKDASH_TOKEN=keepme\r\nPORT=5555\r\n";
  assert.deepEqual(ensureTokenInEnv(bom, FAKE_TOKEN), { text: bom, changed: false, reason: "existing" });
  const bomEmpty = "﻿SPARKDASH_TOKEN=\r\nPORT=5555\r\n";
  assert.equal(ensureTokenInEnv(bomEmpty, FAKE_TOKEN).text, `﻿SPARKDASH_TOKEN=${FAKE_TOKEN}\r\nPORT=5555\r\n`);
  const legacy = "SPARKDASH_TOKEN=\nDASHBOARD_TOKEN=legacy\n";
  assert.deepEqual(ensureTokenInEnv(legacy, FAKE_TOKEN), { text: legacy, changed: false, reason: "legacy" });
  // dotenv ends an unquoted value at `#`, so this token is empty to the server.
  assert.equal(readEnvValue("SPARKDASH_TOKEN=#abc\n", "SPARKDASH_TOKEN"), "");
  assert.equal(readEnvValue("SPARKDASH_TOKEN=ab#c\n", "SPARKDASH_TOKEN"), "ab");
});

test("an ssh that times out is reported as not answering, not as missing", (t) => {
  const root = tempRoot(t);
  const slow = (cmd) =>
    cmd === "ssh"
      ? { error: Object.assign(new Error("spawnSync ssh ETIMEDOUT"), { code: "ETIMEDOUT" }), status: null, stdout: "", stderr: "" }
      : nothingInstalled();
  const result = setup(root, { argv: ["--check"], run: slow });
  assert.match(result.output, /ssh did not answer "ssh -V" \(ETIMEDOUT\)/);
  assert.doesNotMatch(result.output, /ssh was not found/);
});
