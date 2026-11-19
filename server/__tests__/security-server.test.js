/**
 * The hardened access rules wired into the real server (server/index.js):
 * - bodies are parsed only after authentication (item 6);
 * - without a token, proxied changes are refused while direct-local ones work (item 1);
 * - with a token, proxied reads need it and ?token= is not accepted over HTTP (items 2, 8);
 * - security headers on every response, no X-Powered-By (item 7);
 * - a tokenless non-loopback bind refuses to start and says what to set (item 4).
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { isolatedConfigEnv } from "./isolatedEnv.js";

const ROOT = path.resolve(import.meta.dirname, "../..");

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** process.env without anything that would change the server's access rules. */
function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^SPARKDASH_|^DASHBOARD_TOKEN$|^BIND_HOST$|^PORT$/.test(key)) delete env[key];
  }
  return env;
}

async function startServer(t, extraEnv) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-security-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const env = isolatedConfigEnv(tmp);
  await writeFile(env.SPARKS_JSON_PATH, '{"sparks":[]}\n');
  const port = await freePort();
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: { ...cleanEnv(), ...env, BIND_HOST: "127.0.0.1", PORT: String(port), ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  let timer;
  await Promise.race([
    new Promise((resolve) => {
      const check = () => (output.includes("server listening") ? resolve() : setTimeout(check, 10));
      check();
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 8_000);
    }),
  ]).finally(() => clearTimeout(timer));
  return port;
}

/** Raw HTTP so the test controls every header (fetch adds Sec-Fetch-* and forbids some). */
function call(port, method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path: urlPath, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

test("tokened server: bodies are parsed only after auth; proxied reads need the token; headers are set", async (t) => {
  const port = await startServer(t, { SPARKDASH_TOKEN: "s3cret" });
  const malformed = { headers: { "content-type": "application/json" }, body: "{not json" };

  // Unauthenticated: rejected by auth before the JSON parser runs.
  const anonymous = await call(port, "POST", "/api/sparks", malformed);
  assert.equal(anonymous.status, 401);
  // Authenticated: now the parser sees the body and rejects it.
  const authed = await call(port, "POST", "/api/sparks", {
    ...malformed,
    headers: { ...malformed.headers, authorization: "Bearer s3cret" },
  });
  assert.equal(authed.status, 400);

  // Direct-local read: open. Proxied read: token required, and not via ?token=.
  assert.equal((await call(port, "GET", "/api/sparks")).status, 200);
  const xff = { "x-forwarded-for": "100.64.0.7" };
  assert.equal((await call(port, "GET", "/api/sparks", { headers: xff })).status, 401);
  assert.equal((await call(port, "GET", "/api/sparks?token=s3cret", { headers: xff })).status, 401);
  assert.equal((await call(port, "GET", "/api/sparks", { headers: { ...xff, authorization: "Bearer s3cret" } })).status, 200);

  // The status endpoint still answers a client without a token.
  const status = await call(port, "GET", "/api/auth/status", { headers: xff });
  assert.equal(status.status, 200);
  assert.deepEqual(status.json, { tokenRequired: true, authenticated: false, canMutate: false });

  const health = await call(port, "GET", "/api/health");
  assert.equal(health.headers["x-powered-by"], undefined);
  assert.equal(health.headers["x-content-type-options"], "nosniff");
  assert.equal(health.headers["referrer-policy"], "no-referrer");
  assert.equal(health.headers["x-frame-options"], "DENY");
  assert.match(health.headers["content-security-policy"], /default-src 'self'.*frame-ancestors 'none'/);
  // Refusals carry them too.
  assert.equal(anonymous.headers["x-content-type-options"], "nosniff");

  // A chunk from an older build is a 404, not the SPA shell (which would poison the SW cache).
  const missing = await call(port, "GET", "/assets/index-doesnotexist.js");
  assert.equal(missing.status, 404);
  assert.doesNotMatch(String(missing.headers["content-type"] || ""), /text\/html/);
});

test("tokenless server: direct-local changes work, proxied and cross-port ones are refused", async (t) => {
  const port = await startServer(t, {});
  const ok = await call(port, "DELETE", "/api/events");
  assert.equal(ok.status, 200);

  const proxied = await call(port, "DELETE", "/api/events", { headers: { "x-forwarded-for": "100.64.0.7" } });
  assert.equal(proxied.status, 403);
  assert.equal(proxied.json.code, "token_required");
  assert.match(proxied.json.error, /SPARKDASH_TOKEN/);

  const tailscale = await call(port, "DELETE", "/api/events", { headers: { "tailscale-user-login": "someone@example.com" } });
  assert.equal(tailscale.status, 403);

  const otherPort = await call(port, "DELETE", "/api/events", { headers: { origin: "http://127.0.0.1:8188" } });
  assert.equal(otherPort.status, 403);

  const sameSite = await call(port, "DELETE", "/api/events", { headers: { "sec-fetch-site": "same-site" } });
  assert.equal(sameSite.status, 403);
  assert.equal(sameSite.json.code, "cross_site");

  // Reads stay open for monitoring through a proxy.
  assert.equal((await call(port, "GET", "/api/sparks", { headers: { "x-forwarded-for": "100.64.0.7" } })).status, 200);
});

test("a tokenless non-loopback bind refuses to start and names the settings", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-security-bind-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const env = isolatedConfigEnv(tmp);
  await writeFile(env.SPARKS_JSON_PATH, '{"sparks":[]}\n');
  const port = await freePort();
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: { ...cleanEnv(), ...env, BIND_HOST: "0.0.0.0", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  let timer;
  await Promise.race([
    new Promise((resolve) => {
      const check = () => (output.includes("refusing to start") ? resolve() : setTimeout(check, 10));
      check();
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no refusal logged:\n${output}`)), 8_000);
    }),
  ]).finally(() => clearTimeout(timer));
  assert.doesNotMatch(output, /server listening/);
  assert.match(output, /SPARKDASH_TOKEN/);
  assert.match(output, /npm run setup/);
  assert.match(output, /SPARKDASH_ALLOW_OPEN_REMOTE=1/);
});
