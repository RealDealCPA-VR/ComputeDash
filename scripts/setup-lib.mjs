/**
 * Pure and injectable parts of `npm run setup` (scripts/setup.mjs).
 *
 * Everything that touches the machine (files, child processes, randomness,
 * output) is passed in, so scripts/__tests__/setup.test.mjs runs it against a
 * temporary directory with no network and no real token.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

export const MIN_NODE_MAJOR = 22;
export const TOKEN_KEY = "SPARKDASH_TOKEN";
export const DEFAULT_PORT = 5555;

// ─── Node version ─────────────────────────────────────────

export function parseNodeVersion(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version || "").trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function checkNodeVersion(version, minMajor = MIN_NODE_MAJOR) {
  const parsed = parseNodeVersion(version);
  if (!parsed) {
    return { ok: false, message: `Could not read the Node.js version (${version}). ComputeDash needs Node ${minMajor} or newer.` };
  }
  if (parsed.major < minMajor) {
    return {
      ok: false,
      message:
        `Node ${String(version).replace(/^v/, "")} is too old: ComputeDash needs Node ${minMajor} or newer. ` +
        `Install Node ${minMajor} LTS from https://nodejs.org/ (Windows: nvm-windows, "nvm install ${minMajor}" then "nvm use ${minMajor}"; ` +
        `macOS/Linux: nvm, "nvm install ${minMajor}"), then run npm ci and npm run setup again.`,
    };
  }
  return { ok: true, message: `Node ${String(version).replace(/^v/, "")}` };
}

// ─── .env parsing and the token line ──────────────────────

// A leading UTF-8 BOM (Windows editors, PowerShell 5.1) is whitespace to dotenv, so it is skipped here too.
const ASSIGNMENT = /^﻿?[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(.*)$/;

/** Split text into lines, keeping each line's own terminator so a rewrite is byte-exact. */
function splitLines(text) {
  return text.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+$/g) || [];
}

function stripTerminator(line) {
  return line.replace(/(?:\r\n|\n|\r)$/, "");
}

/** dotenv-style value: quotes removed; in an unquoted value `#` starts a comment, as in dotenv. */
export function unquoteEnvValue(raw) {
  const value = String(raw).trim();
  const quote = value[0];
  if ((quote === '"' || quote === "'" || quote === "`") && value.length >= 2) {
    const end = value.indexOf(quote, 1);
    if (end > 0) return value.slice(1, end);
  }
  return value.replace(/#.*$/, "").trim();
}

/** Every active (uncommented) assignment, in file order. */
export function parseEnvAssignments(text) {
  const out = [];
  splitLines(String(text || "")).forEach((line, index) => {
    const m = ASSIGNMENT.exec(stripTerminator(line));
    if (m) out.push({ key: m[1], value: unquoteEnvValue(m[2]), index });
  });
  return out;
}

/** The value dotenv would load for `key` (the last assignment wins), or undefined. */
export function readEnvValue(text, key) {
  let value;
  for (const a of parseEnvAssignments(text)) if (a.key === key) value = a.value;
  return value;
}

/**
 * Make sure `.env` text carries a non-empty SPARKDASH_TOKEN.
 * - An existing non-empty token (or the legacy DASHBOARD_TOKEN) is never replaced.
 * - An empty `SPARKDASH_TOKEN=` line is filled in place.
 * - Otherwise one line is appended.
 * Every other byte of the file is kept, including its line endings.
 */
export function ensureTokenInEnv(text, token) {
  const source = String(text || "");
  const assignments = parseEnvAssignments(source);
  const last = (key) => assignments.filter((a) => a.key === key).pop();
  const current = last(TOKEN_KEY);
  if (current && current.value) return { text: source, changed: false, reason: "existing" };
  const legacy = last("DASHBOARD_TOKEN");
  // The server reads SPARKDASH_TOKEN || DASHBOARD_TOKEN, so filling an empty SPARKDASH_TOKEN would replace it.
  if (legacy && legacy.value) return { text: source, changed: false, reason: "legacy" };

  const eol = /\r\n/.test(source) ? "\r\n" : "\n";
  if (current) {
    const lines = splitLines(source);
    const original = lines[current.index];
    const terminator = original.slice(stripTerminator(original).length);
    const prefix = /^﻿?[ \t]*(?:export[ \t]+)?/.exec(original)[0];
    lines[current.index] = `${prefix}${TOKEN_KEY}=${token}${terminator}`;
    return { text: lines.join(""), changed: true, reason: "filled" };
  }
  const separator = source === "" || /(?:\r\n|\n|\r)$/.test(source) ? "" : eol;
  const block = `# Dashboard access token, created by npm run setup. Keep it private.${eol}${TOKEN_KEY}=${token}${eol}`;
  return { text: source + separator + block, changed: true, reason: "appended" };
}

export function generateToken(randomBytes = crypto.randomBytes) {
  return Buffer.from(randomBytes(32)).toString("hex");
}

// ─── Tailscale ────────────────────────────────────────────

/** This machine's MagicDNS name from `tailscale status --json`, without the trailing dot. */
export function parseTailscaleStatus(json) {
  try {
    const status = typeof json === "string" ? JSON.parse(json) : json;
    const name = String(status?.Self?.DNSName || "").replace(/\.$/, "");
    return name ? { dnsName: name, backendState: status.BackendState || "" } : null;
  } catch {
    return null;
  }
}

// ─── Output ───────────────────────────────────────────────

/** PowerShell single-quoted literal. */
export function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** A PowerShell snippet that starts the dashboard at logon. Printed, never run. */
export function windowsLogonTaskSnippet({ nodePath, root, taskName = "ComputeDash" }) {
  return [
    `$action   = New-ScheduledTaskAction -Execute ${psQuote(nodePath)} -Argument 'server\\index.js' -WorkingDirectory ${psQuote(root)}`,
    `$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME`,
    `$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)`,
    `Register-ScheduledTask -TaskName ${psQuote(taskName)} -Action $action -Trigger $trigger -Settings $settings -Description 'Start ComputeDash at logon'`,
  ].join("\n");
}

const MARK = { ok: "[ok]", warn: "[!!]", info: "[--]", fail: "[XX]" };

/**
 * The text `npm run setup` prints. `state` is what runSetup found or did.
 * The token itself appears only when `state.printedToken` is set (--print-token).
 */
export function buildSummary(state) {
  const lines = [];
  const say = (kind, text) => lines.push(`  ${MARK[kind]} ${text}`);
  lines.push(state.checkOnly ? "ComputeDash setup (check only, nothing written)" : "ComputeDash setup");
  lines.push("");
  for (const item of state.items) say(item.kind, item.text);

  const port = state.port || DEFAULT_PORT;
  const url = `http://127.0.0.1:${port}`;
  lines.push("");
  lines.push("Next steps");
  let n = 1;
  if (!state.distBuilt) lines.push(`  ${n++}. npm run build`);
  lines.push(`  ${n++}. npm start`);
  lines.push(`  ${n++}. Open ${url} in a browser on this machine and add your machines (the + next to Sparks).`);
  const serveCmd = `tailscale serve --bg ${port}`;
  const remote = state.tailscaleName ? `https://${state.tailscaleName}` : "https://<this-machine>.<your-tailnet>.ts.net";
  lines.push(`  ${n++}. Phones and other machines: run "${serveCmd}" here${state.platform === "win32" ? "" : " (with sudo if it says access denied)"}, then open ${remote}`);
  lines.push("");
  lines.push("Access token");
  if (state.tokenLocation) {
    lines.push(`  ${TOKEN_KEY} is in ${state.tokenLocation}. Changes made through Tailscale Serve or a proxy need it;`);
    lines.push("  the browser asks for it once and remembers it (Settings -> Access token to change it).");
    lines.push("  Model control on the Models page always needs it.");
    if (state.printedToken) lines.push(`  Token: ${state.printedToken}`);
    else lines.push("  Show it with: npm run setup -- --print-token");
    lines.push("  Restart the dashboard after changing .env.");
  } else {
    lines.push(`  No ${TOKEN_KEY} yet. Run npm run setup (without --check) to create one.`);
  }
  if (state.platform === "win32" && state.nodePath) {
    lines.push("");
    lines.push("Start at logon (optional, Windows). Paste into PowerShell; nothing was registered:");
    for (const line of windowsLogonTaskSnippet({ nodePath: state.nodePath, root: state.root }).split("\n")) lines.push(`  ${line}`);
    lines.push("  If PowerShell reports access denied, run it from an administrator PowerShell.");
    lines.push("  Remove it later with: Unregister-ScheduledTask -TaskName 'ComputeDash'");
  }
  return lines.join("\n") + "\n";
}

// ─── The run ──────────────────────────────────────────────

export function parseArgs(argv) {
  const flags = { check: false, printToken: false, help: false, unknown: [] };
  for (const arg of argv) {
    if (arg === "--check") flags.check = true;
    else if (arg === "--print-token") flags.printToken = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else flags.unknown.push(arg);
  }
  return flags;
}

export const USAGE = `Usage: npm run setup [-- --check] [-- --print-token]

  --check        Report only; write nothing.
  --print-token  Print the access token (by default only its location is shown).
`;

function defaultRun(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 10000, windowsHide: true });
  return { error: r.error, status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

/** Write a file atomically with mode 0600 where the platform supports it. */
function writePrivate(fsImpl, file, text) {
  // A rename would replace a read-only .env on POSIX; refuse like a direct write would.
  if (fsImpl.existsSync(file)) fsImpl.accessSync(file, fs.constants.W_OK);
  const tmp = `${file}.setup-${process.pid}.tmp`;
  fsImpl.writeFileSync(tmp, text, { mode: 0o600 });
  try {
    fsImpl.renameSync(tmp, file);
  } catch (err) {
    try { fsImpl.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    throw err;
  }
  try { fsImpl.chmodSync(file, 0o600); } catch { /* best-effort (Windows) */ }
}

/**
 * Run every check and the idempotent writes. Returns { exitCode, output, state }.
 * Hard failure (exit 1) is only an unsupported Node version.
 */
export function runSetup({
  root,
  argv = [],
  env = process.env,
  platform = process.platform,
  nodeVersion = process.version,
  nodePath = process.execPath,
  run = defaultRun,
  randomBytes = crypto.randomBytes,
  fsImpl = fs,
} = {}) {
  const flags = parseArgs(argv);
  if (flags.help) return { exitCode: 0, output: USAGE, state: null };
  const items = [];
  const state = { root, platform, nodePath, checkOnly: flags.check, items, port: DEFAULT_PORT, distBuilt: false };
  for (const arg of flags.unknown) items.push({ kind: "warn", text: `Ignored unknown option ${arg}` });

  const node = checkNodeVersion(nodeVersion);
  items.push({ kind: node.ok ? "ok" : "fail", text: node.message });
  if (!node.ok) return { exitCode: 1, output: buildSummary(state), state };

  // ssh: every remote unit is reached with the system OpenSSH client.
  const ssh = run("ssh", ["-V"]);
  if (ssh.error && ssh.error.code !== "ENOENT") {
    // Found but slow or failing (antivirus on first launch, a timeout): not the same as missing.
    items.push({ kind: "warn", text: `ssh did not answer "ssh -V" (${ssh.error.code || ssh.error.message}); check it with: ssh -V` });
  } else if (ssh.error) {
    items.push({
      kind: "warn",
      text:
        platform === "win32"
          ? "ssh was not found on PATH. Install the OpenSSH Client (Settings -> System -> Optional features -> OpenSSH Client), then open a new terminal."
          : "ssh was not found on PATH. Install the OpenSSH client (for example: sudo apt install openssh-client).",
    });
  } else {
    const version = `${ssh.stderr}${ssh.stdout}`.trim().split(/\r?\n/)[0];
    items.push({ kind: "ok", text: `ssh: ${version || "found"}` });
  }

  // Tailscale is optional: report this machine's name when the CLI answers.
  const ts = run("tailscale", ["status", "--json"]);
  const tsStatus = !ts.error && ts.status === 0 ? parseTailscaleStatus(ts.stdout) : null;
  if (tsStatus) {
    state.tailscaleName = tsStatus.dnsName;
    items.push({ kind: "ok", text: `Tailscale: this machine is ${tsStatus.dnsName}` });
  } else {
    items.push({ kind: "info", text: "Tailscale CLI not found or not signed in (optional; needed for phones and other machines)." });
  }

  // .env and the access token.
  const envPath = path.join(root, ".env");
  const examplePath = path.join(root, ".env.example");
  let envText = null;
  let created = false;
  if (fsImpl.existsSync(envPath)) {
    envText = fsImpl.readFileSync(envPath, "utf8");
  } else if (fsImpl.existsSync(examplePath)) {
    envText = fsImpl.readFileSync(examplePath, "utf8");
    created = true;
  } else {
    envText = "";
    created = true;
  }
  const token = generateToken(randomBytes);
  const ensured = ensureTokenInEnv(envText, token);
  if (flags.check) {
    if (created) items.push({ kind: "warn", text: ".env does not exist yet (npm run setup creates it from .env.example)." });
    if (ensured.changed) items.push({ kind: "warn", text: `${TOKEN_KEY} is not set in .env.` });
  } else if (created || ensured.changed) {
    writePrivate(fsImpl, envPath, ensured.text);
    if (created) items.push({ kind: "ok", text: `Created .env${fsImpl.existsSync(examplePath) ? " from .env.example" : ""}` });
  }
  const finalText = flags.check ? envText : ensured.text;
  const tokenValue = readEnvValue(finalText, TOKEN_KEY) || readEnvValue(finalText, "DASHBOARD_TOKEN") || "";
  if (tokenValue) {
    state.tokenLocation = envPath;
    if (!flags.check && ensured.changed) items.push({ kind: "ok", text: `Created a new access token (${TOKEN_KEY}) in ${envPath}` });
    else if (ensured.reason === "legacy") items.push({ kind: "ok", text: `Access token found (DASHBOARD_TOKEN) in ${envPath}` });
    else items.push({ kind: "ok", text: `Access token already set in ${envPath} (left unchanged)` });
    if (flags.printToken) state.printedToken = tokenValue;
  }
  if (env[TOKEN_KEY] && env[TOKEN_KEY].trim() && env[TOKEN_KEY].trim() !== tokenValue) {
    items.push({ kind: "warn", text: `${TOKEN_KEY} is also set in this shell's environment, and that value wins over .env.` });
  }
  if (readEnvValue(finalText, "SPARKDASH_ALLOW_OPEN_REMOTE") === "1") {
    items.push({ kind: "warn", text: "SPARKDASH_ALLOW_OPEN_REMOTE=1 is set in .env. Remove it unless you really want a tokenless non-loopback bind." });
  }
  const portValue = Number(env.PORT || readEnvValue(finalText, "PORT"));
  if (Number.isInteger(portValue) && portValue > 0 && portValue < 65536) state.port = portValue;

  // config/ holds the unit registry and encrypted secrets.
  const configDir = path.join(root, "config");
  if (!fsImpl.existsSync(configDir)) {
    if (flags.check) items.push({ kind: "warn", text: "config/ does not exist yet (npm run setup or the first start creates it)." });
    else {
      fsImpl.mkdirSync(configDir, { recursive: true });
      items.push({ kind: "ok", text: "Created config/" });
    }
  } else {
    try {
      fsImpl.accessSync(configDir, fs.constants.W_OK);
      items.push({ kind: "ok", text: "config/ is writable" });
    } catch {
      items.push({ kind: "warn", text: `config/ is not writable by this user; fix its ownership (${configDir}).` });
    }
  }

  // dist/ is the built frontend npm start serves.
  state.distBuilt = fsImpl.existsSync(path.join(root, "dist", "index.html"));
  items.push(
    state.distBuilt
      ? { kind: "ok", text: "Frontend is built (dist/)" }
      : { kind: "warn", text: "Frontend is not built yet: run npm run build" }
  );

  return { exitCode: 0, output: buildSummary(state), state };
}
