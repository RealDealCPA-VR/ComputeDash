import fs from "fs";
import path from "path";
import { SPARKS_JSON_PATH } from "./config.js";
import { allowOpenRemote, configuredToken, requireRemoteAuth } from "./auth.js";
import { describeHostRuntime, inspectSshIdentity } from "./startupPreflight.js";

export function evaluateHealth({ bindHost, configWritable, secretsKeyPresent, sshIdentityPresent, runtime }) {
  const remote = requireRemoteAuth(bindHost);
  const token = Boolean(configuredToken());
  const openRemote = remote && !token && allowOpenRemote();
  const errors = [];
  const warnings = [];
  if (remote && !token && !openRemote) {
    errors.push("Remote bind requires SPARKDASH_TOKEN");
  }
  if (!configWritable) errors.push("Config directory is not writable");
  if (!secretsKeyPresent) warnings.push("Secrets key is not present yet");
  if (!sshIdentityPresent) {
    // Only the Docker image gets its key by a bind mount; a native host (Windows,
    // macOS, bare Linux) uses the operator's own ~/.ssh or %USERPROFILE%\.ssh.
    const container = runtime ? runtime.container : true;
    warnings.push(container ? "SSH identity is not mounted" : "No default SSH key found");
  }
  return {
    ok: errors.length === 0,
    bindHost,
    // "open-remote": reachable off-host with no token — anyone on the network can
    // mutate. "required-missing": a non-loopback bind without a token that fails closed.
    authMode: token ? "bearer" : !remote ? "loopback-open" : openRemote ? "open-remote" : "required-missing",
    errors,
    warnings,
  };
}

export function inspectHealth(bindHost, options = {}) {
  const env = options.env || process.env;
  const exists = options.exists || fs.existsSync;
  const runtime = options.runtime || describeHostRuntime({ platform: options.platform, exists });
  const configDir = path.dirname(SPARKS_JSON_PATH);
  let writable = true;
  try { fs.accessSync(configDir, fs.constants.W_OK); } catch { writable = false; }
  const keyFile = path.join(configDir, ".secrets-key");
  const identity = inspectSshIdentity(runtime, { env, homedir: options.homedir, stat: options.stat });
  return evaluateHealth({
    bindHost,
    runtime,
    configWritable: writable,
    secretsKeyPresent: Boolean(env.SPARKDASH_SECRETS_KEY) || exists(keyFile),
    sshIdentityPresent: identity.configured,
  });
}
