import fs from "fs";
import os from "os";
import path from "path";
import { HOST_PATHS, SPARKS_JSON_PATH } from "./config.js";
import { allowOpenRemote } from "./auth.js";

export function isLoopbackHost(host) {
  return host === "localhost" || host === "::1" || /^127\./.test(host || "");
}

/** Private key names OpenSSH tries by default, in the order the checks report them. */
export const DEFAULT_SSH_KEY_NAMES = ["id_ed25519", "id_ecdsa", "id_rsa"];

function safeHomedir(homedir) {
  try {
    return homedir() || "";
  } catch {
    return "";
  }
}

/**
 * Where this process runs, as far as the startup checks care: the OS, and
 * whether it is the Linux container the Compose files describe (host /proc and
 * /sys mounted under /host, SSH keys mounted into /root/.ssh).
 * Everything is injectable so tests do not depend on the machine running them.
 */
export function describeHostRuntime({ platform = process.platform, exists = fs.existsSync } = {}) {
  const container = platform === "linux" && (exists("/.dockerenv") || exists("/run/.containerenv"));
  return { platform, container };
}

/**
 * The SSH private keys the dashboard's `ssh` would use without extra options.
 * `SSH_IDENTITY_FILE` wins. Otherwise the user's own `.ssh` directory:
 * `%USERPROFILE%\.ssh` on Windows (HOME is usually unset there), `$HOME/.ssh`
 * elsewhere, `/root/.ssh` in a container with no HOME.
 */
export function sshIdentityCandidates({ platform = process.platform, env = process.env, homedir = os.homedir } = {}) {
  if (env.SSH_IDENTITY_FILE) return [env.SSH_IDENTITY_FILE];
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  const home =
    platform === "win32"
      ? env.USERPROFILE || safeHomedir(homedir) || env.HOME || ""
      : env.HOME || safeHomedir(homedir) || "/root";
  if (!home) return [];
  return DEFAULT_SSH_KEY_NAMES.map((name) => join(home, ".ssh", name));
}

/** What the identity checks point the operator at: the configured file, or the `.ssh` directory searched. */
export function sshIdentityHint(platform, candidates) {
  if (candidates.length === 0) return platform === "win32" ? "%USERPROFILE%\\.ssh" : "~/.ssh";
  if (candidates.length === 1) return candidates[0];
  return (platform === "win32" ? path.win32 : path.posix).dirname(candidates[0]);
}

/**
 * Whether this host can have a local unit at all, and which paths decide it.
 * Windows and macOS hosts have no /proc or /sys: the local unit is Linux-only,
 * and the host is added as a Windows PC or Mac unit over SSH instead.
 */
export function localCollectorPaths(runtime, env = process.env) {
  if (runtime.platform === "win32" || runtime.platform === "darwin") return null;
  if (runtime.container) return { proc: HOST_PATHS.PROC, sys: HOST_PATHS.SYS };
  // A bare Linux host reads its own /proc and /sys (the collectors fall back to them).
  const mapped = env.HOST_PROC_PATH || env.HOST_SYS_PATH;
  return mapped ? { proc: HOST_PATHS.PROC, sys: HOST_PATHS.SYS } : { proc: "/proc", sys: "/sys" };
}

export function evaluateStartupPreflight(input) {
  const loopback = isLoopbackHost(input.bindHost);
  const runtime = input.runtime || { platform: "linux", container: true };
  const errors = [];
  const warnings = [];
  if (!loopback && !input.tokenConfigured) {
    if (input.allowOpenRemote) {
      warnings.push(
        `Remote bind ${input.bindHost} is open: anyone who can reach it can change settings and power units off, because SPARKDASH_TOKEN is not set and SPARKDASH_ALLOW_OPEN_REMOTE=1. Set SPARKDASH_TOKEN (npm run setup creates one) for authenticated remote access, or remove SPARKDASH_ALLOW_OPEN_REMOTE to refuse to start without one.`
      );
    } else {
      errors.push(
        `Remote bind ${input.bindHost} requires SPARKDASH_TOKEN. Keep BIND_HOST=127.0.0.1, or set SPARKDASH_TOKEN (npm run setup creates one) and use an SSH tunnel, authenticated TLS reverse proxy, or Tailscale Serve.`
      );
    }
  }
  if (!input.configWritable) errors.push("Config directory is not writable; fix the config volume ownership/permissions.");
  if (!input.secretsKey?.present) warnings.push("No secrets key exists yet; one will be created when the secrets store is first used. Back it up with the config directory.");
  if (!input.sshIdentity?.configured) {
    warnings.push(
      runtime.container
        ? "No SSH identity is mounted; remote key-auth units will be unavailable. Mount a private key at /root/.ssh/id_ed25519 or set SSH_IDENTITY_FILE."
        : `No default SSH key found in ${input.sshIdentity?.path || "~/.ssh"}; key-auth units need one (ssh-keygen -t ed25519), an ssh-agent key, or SSH_IDENTITY_FILE.`
    );
  }
  if (input.sshIdentity?.configured && input.sshIdentity.safePermissions === false) {
    warnings.push("SSH identity permissions are too open; set the private key to mode 600.");
  }
  if (input.localCollectors?.applicable !== false && !input.localCollectors?.available) {
    warnings.push(
      runtime.container
        ? "Local host metrics are unavailable; verify /proc and /sys host mounts."
        : "Local host metrics are unavailable; /proc/meminfo or /sys could not be read."
    );
  }
  return {
    fatal: errors.length > 0,
    authMode: loopback
      ? "loopback-only"
      : input.tokenConfigured
        ? "bearer"
        : input.allowOpenRemote
          ? "open-remote"
          : "required-missing",
    errors,
    warnings,
  };
}

function pathWritable(target) {
  try {
    fs.accessSync(target, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first default SSH key that exists, and its POSIX mode where the platform
 * has one. Windows reports synthetic modes (0o666), so permissions are not judged there.
 */
export function inspectSshIdentity(runtime, { env = process.env, homedir = os.homedir, stat = fs.statSync } = {}) {
  const candidates = sshIdentityCandidates({ platform: runtime.platform, env, homedir });
  for (const candidate of candidates) {
    let mode = null;
    try {
      mode = stat(candidate).mode & 0o777;
    } catch {
      continue;
    }
    return {
      configured: true,
      path: candidate,
      safePermissions: runtime.platform === "win32" ? null : (mode & 0o077) === 0,
    };
  }
  return { configured: false, path: sshIdentityHint(runtime.platform, candidates), safePermissions: null };
}

export function inspectStartupPreflight(bindHost, options = {}) {
  const env = options.env || process.env;
  const exists = options.exists || fs.existsSync;
  const runtime = options.runtime || describeHostRuntime({ platform: options.platform, exists });
  const configDir = path.dirname(SPARKS_JSON_PATH);
  const keyFile = path.join(configDir, ".secrets-key");
  const collectorPaths = localCollectorPaths(runtime, env);
  return evaluateStartupPreflight({
    bindHost,
    runtime,
    tokenConfigured: Boolean(env.SPARKDASH_TOKEN || env.DASHBOARD_TOKEN),
    allowOpenRemote: allowOpenRemote(),
    configWritable: pathWritable(configDir),
    secretsKey: {
      present: Boolean(env.SPARKDASH_SECRETS_KEY) || exists(keyFile),
      source: env.SPARKDASH_SECRETS_KEY ? "environment" : "file",
    },
    sshIdentity: inspectSshIdentity(runtime, { env, homedir: options.homedir, stat: options.stat }),
    localCollectors: collectorPaths
      ? {
          applicable: true,
          // Linux-only paths: joined POSIX-style so the check is the same on any test host.
          available: exists(path.posix.join(collectorPaths.proc, "meminfo")) && exists(collectorPaths.sys),
        }
      : { applicable: false, available: false },
  });
}

export function logStartupPreflight(preflight, bindHost, port) {
  console.log(`[sparkDash] preflight: bind=${bindHost}:${port} auth=${preflight.authMode}`);
  for (const warning of preflight.warnings) console.warn(`[sparkDash] preflight warning: ${warning}`);
  for (const error of preflight.errors) console.error(`[sparkDash] preflight error: ${error}`);
}
