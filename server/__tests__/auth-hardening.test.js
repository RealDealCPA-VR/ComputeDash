/**
 * Access-control hardening (server/auth.js):
 * - without a token, only direct-local requests may change anything;
 * - with a token, every read that is not direct local needs it;
 * - Origin must be this dashboard (host and port), and cross-site / same-site
 *   fetches cannot mutate;
 * - ?token= is accepted on the WebSocket upgrade only;
 * - repeated wrong tokens are rate-limited per client.
 */
import { test } from "node:test";
import os from "node:os";
import assert from "node:assert/strict";
import {
  authorizeUpgrade,
  createAuthFailureLimiter,
  createAuthMiddleware,
  createAuthStatusHandler,
  extractBearer,
  isDirectLocalRequest,
  resetAuthFailures,
} from "../auth.js";

const ENV_KEYS = [
  "SPARKDASH_TOKEN",
  "DASHBOARD_TOKEN",
  "BIND_HOST",
  "PORT",
  "SPARKDASH_ALLOW_OPEN_REMOTE",
  "SPARKDASH_ALLOWED_HOSTS",
  "SPARKDASH_ALLOWED_ORIGINS",
];

function withEnv(env, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const k of ENV_KEYS) {
      if (env[k] == null) delete process.env[k];
      else process.env[k] = env[k];
    }
    resetAuthFailures();
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] == null) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetAuthFailures();
  }
}

function request({ method = "GET", path = "/api/sparks", peer = "127.0.0.1", headers = {}, url } = {}) {
  return { method, path, url: url || path, headers: { host: "127.0.0.1:5555", ...headers }, socket: { remoteAddress: peer } };
}

/** Run the real middleware; report { passed, status, body, headers }. */
function run(req, middleware = createAuthMiddleware()) {
  const out = { passed: false, status: null, body: null, headers: {} };
  const res = {
    status(code) {
      out.status = code;
      return this;
    },
    json(body) {
      out.body = body;
      return this;
    },
    type() {
      return this;
    },
    send(body) {
      out.body = body;
      return this;
    },
    set(name, value) {
      out.headers[name.toLowerCase()] = value;
      return this;
    },
  };
  middleware(req, res, () => {
    out.passed = true;
  });
  return out;
}

const PROXY_HEADERS = {
  "x-forwarded-for": "100.64.0.7",
  "x-forwarded-host": "spark.tail1234.ts.net",
  "x-forwarded-proto": "https",
  forwarded: "for=100.64.0.7",
  "x-real-ip": "100.64.0.7",
  "tailscale-user-login": "someone@example.com",
};

test("isDirectLocalRequest: loopback peer, no proxy headers, local Host and Origin", () => {
  assert.equal(isDirectLocalRequest(request()), true);
  assert.equal(isDirectLocalRequest(request({ peer: "::1", headers: { host: "[::1]:5555" } })), true);
  assert.equal(isDirectLocalRequest(request({ peer: "::ffff:127.0.0.1" })), true);
  assert.equal(isDirectLocalRequest(request({ peer: "127.0.1.1", headers: { host: "localhost:5555" } })), true);
  assert.equal(isDirectLocalRequest({ headers: {}, socket: { remoteAddress: "127.0.0.1" } }), true, "a CLI request without Host");
  assert.equal(isDirectLocalRequest(request({ peer: "192.168.1.20" })), false);
  assert.equal(isDirectLocalRequest(request({ peer: "::ffff:10.0.0.5" })), false);
  assert.equal(isDirectLocalRequest({ headers: {} }), false, "no socket is not local");
  for (const [name, value] of Object.entries(PROXY_HEADERS)) {
    assert.equal(isDirectLocalRequest(request({ headers: { [name]: value } })), false, name);
  }
  // A proxy that rewrites nothing still gives itself away by its public name.
  assert.equal(isDirectLocalRequest(request({ headers: { host: "dash.example.com" } })), false);
  assert.equal(isDirectLocalRequest(request({ headers: { origin: "https://dash.example.com" } })), false);
  assert.equal(isDirectLocalRequest(request({ headers: { host: "192.168.1.50:5173" } })), false);
});

test("this machine's hostname is not direct local: a header-less TCP forward (tailscale serve --tcp) arrives that way", () => {
  const self = os.hostname().toLowerCase().replace(/\.local$/, "");
  assert.equal(isDirectLocalRequest(request({ headers: { host: `${self}:5555` } })), false);
  assert.equal(isDirectLocalRequest(request({ headers: { origin: `http://${self}:5555` } })), false);
  assert.equal(isDirectLocalRequest(request({ headers: { host: "localhost:5555", origin: "http://localhost:5555" } })), true);
  assert.equal(isDirectLocalRequest(request({ headers: { host: "app.localhost:5555" } })), true);
});

test("no token: direct-local changes work, proxied ones get 403 token_required (item 1)", () => {
  withEnv({ BIND_HOST: "127.0.0.1" }, () => {
    for (const path of ["/api/sparks/shutdown-all", "/api/sparks/wake-all", "/api/settings", "/api/restart"]) {
      assert.equal(run(request({ method: "POST", path })).passed, true, `${path} direct local`);
    }
    for (const [name, value] of Object.entries(PROXY_HEADERS)) {
      const out = run(request({ method: "POST", path: "/api/sparks/shutdown-all", headers: { [name]: value } }));
      assert.equal(out.passed, false, name);
      assert.equal(out.status, 403, name);
      assert.equal(out.body.code, "token_required", name);
      assert.match(out.body.error, /SPARKDASH_TOKEN/);
      assert.match(out.body.error, /npm run setup/);
    }
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      assert.equal(run(request({ method, headers: { "x-forwarded-for": "1.2.3.4" } })).status, 403, method);
    }
    // Reads stay open: monitoring through Tailscale Serve needs no setup.
    assert.equal(run(request({ headers: PROXY_HEADERS })).passed, true);
    assert.equal(authorizeUpgrade(request({ path: "/ws", headers: PROXY_HEADERS })), true);
  });
});

test("no token on a non-loopback bind: refused unless SPARKDASH_ALLOW_OPEN_REMOTE=1 opens it (item 4)", () => {
  withEnv({ BIND_HOST: "0.0.0.0" }, () => {
    const lan = request({ peer: "192.168.1.20", headers: { host: "192.168.1.10:5555" } });
    assert.equal(run(lan).status, 403);
    assert.equal(run({ ...lan, method: "POST" }).status, 403);
    assert.equal(authorizeUpgrade({ ...lan, path: "/ws" }), false);
    // The machine itself still works.
    assert.equal(run(request({ method: "POST" })).passed, true);
  });
  withEnv({ BIND_HOST: "0.0.0.0", SPARKDASH_ALLOW_OPEN_REMOTE: "1" }, () => {
    const lan = request({ peer: "192.168.1.20", headers: { host: "192.168.1.10:5555" } });
    assert.equal(run(lan).passed, true);
    assert.equal(run({ ...lan, method: "POST" }).passed, true, "the operator opened it explicitly");
    assert.equal(authorizeUpgrade({ ...lan, path: "/ws" }), true);
  });
});

test("token configured: direct-local reads are open, every other read needs the token (item 2)", () => {
  for (const BIND_HOST of ["127.0.0.1", "0.0.0.0"]) {
    withEnv({ BIND_HOST, SPARKDASH_TOKEN: "s3cret" }, () => {
      for (const path of ["/api/sparks", "/ws", "/metrics"]) {
        assert.equal(run(request({ path })).passed, true, `${BIND_HOST} ${path} direct local`);
        assert.equal(run(request({ method: "HEAD", path })).passed, true, `${BIND_HOST} HEAD ${path}`);
        const proxied = run(request({ path, headers: { "x-forwarded-for": "100.64.0.7" } }));
        assert.equal(proxied.status, 401, `${BIND_HOST} ${path} proxied`);
        assert.equal(
          run(request({ path, headers: { "x-forwarded-for": "100.64.0.7", authorization: "Bearer s3cret" } })).passed,
          true,
          `${BIND_HOST} ${path} proxied with token`
        );
      }
      // The SPA shell still loads for a proxied browser.
      assert.equal(run(request({ path: "/", headers: { "x-forwarded-for": "100.64.0.7" } })).passed, true);
      // Mutations need the token even from the machine itself.
      assert.equal(run(request({ method: "POST" })).status, 401);
      assert.equal(run(request({ method: "POST", headers: { authorization: "Bearer s3cret" } })).passed, true);
      // The WebSocket follows the same rule.
      assert.equal(authorizeUpgrade(request({ path: "/ws" })), true);
      assert.equal(authorizeUpgrade(request({ path: "/ws", headers: { "x-forwarded-for": "100.64.0.7" } })), false);
      assert.equal(
        authorizeUpgrade(request({ path: "/ws", url: "/ws?token=s3cret", headers: { "x-forwarded-for": "100.64.0.7" } })),
        true
      );
    });
  }
});

test("Origin must be this dashboard's host and port; same-site pages on other ports are refused (item 3)", () => {
  const post = (origin, extra = {}) => run(request({ method: "POST", headers: { origin, ...extra } }));
  withEnv({ BIND_HOST: "127.0.0.1" }, () => {
    assert.equal(post("http://127.0.0.1:5555").passed, true, "same origin");
    assert.equal(post("http://localhost:5555").passed, true, "loopback name on our port");
    assert.equal(post("http://127.0.0.1:8188").status, 403, "ComfyUI on the same machine");
    assert.equal(post("http://localhost:5173").status, 403, "another local dev server");
    assert.equal(post("http://localhost").status, 403, "port 80");
    assert.equal(authorizeUpgrade(request({ path: "/ws", headers: { origin: "http://127.0.0.1:8188" } })), false);
  });
  withEnv({ BIND_HOST: "127.0.0.1", PORT: "6100" }, () => {
    const at = (origin) => run(request({ method: "POST", headers: { host: "127.0.0.1:6100", origin } }));
    assert.equal(at("http://localhost:6100").passed, true);
    assert.equal(at("http://localhost:5555").status, 403);
  });
  withEnv({ BIND_HOST: "127.0.0.1", SPARKDASH_ALLOWED_ORIGINS: "http://localhost:5173, https://ops.example.com" }, () => {
    assert.equal(post("http://localhost:5173").passed, true, "explicitly allowed origin");
    assert.equal(post("http://localhost:5174").status, 403);
  });
});

test("cross-site and same-site fetches cannot mutate, with or without a token (item 3)", () => {
  for (const env of [{ BIND_HOST: "127.0.0.1" }, { BIND_HOST: "127.0.0.1", SPARKDASH_TOKEN: "s3cret" }, { BIND_HOST: "0.0.0.0", SPARKDASH_TOKEN: "s3cret" }]) {
    withEnv(env, () => {
      for (const site of ["cross-site", "same-site", "Cross-Site"]) {
        const out = run(request({ method: "POST", headers: { "sec-fetch-site": site, authorization: "Bearer s3cret" } }));
        assert.equal(out.status, 403, `${JSON.stringify(env)} ${site}`);
        assert.equal(out.body.code, "cross_site");
      }
      for (const site of ["same-origin", "none"]) {
        const out = run(request({ method: "POST", headers: { "sec-fetch-site": site, authorization: "Bearer s3cret" } }));
        assert.equal(out.passed, true, `${JSON.stringify(env)} ${site}`);
      }
      // Reads are not affected (a cross-site read cannot see the response anyway).
      assert.equal(run(request({ headers: { "sec-fetch-site": "cross-site", authorization: "Bearer s3cret" } })).passed, true);
    });
  }
});

test("Origin is checked on mutations on a non-loopback bind too (item 3)", () => {
  withEnv({ BIND_HOST: "0.0.0.0", SPARKDASH_TOKEN: "s3cret" }, () => {
    const direct = (origin) => run(request({ method: "POST", headers: { origin, authorization: "Bearer wrong" } }));
    assert.equal(direct("https://evil.example").status, 403);
    const lan = (origin) =>
      run(request({ method: "POST", peer: "192.168.1.20", headers: { host: "192.168.1.10:5555", origin } }));
    assert.equal(lan("http://192.168.1.10:5555").status, 401, "same origin reaches the token check");
    assert.equal(lan("http://192.168.1.10:8080").status, 403, "another port is another origin");
  });
});

test("?token= is accepted only on the WebSocket upgrade (item 8)", () => {
  assert.equal(extractBearer({ headers: {}, url: "/api/x?token=abc", query: { token: "abc" } }), "");
  assert.equal(extractBearer({ headers: {}, url: "/ws?token=abc" }, { allowQuery: true }), "abc");
  withEnv({ BIND_HOST: "0.0.0.0", SPARKDASH_TOKEN: "s3cret" }, () => {
    const remote = (path, url) => ({ ...request({ path, url, peer: "192.168.1.20", headers: { host: "192.168.1.10:5555" } }), query: { token: "s3cret" } });
    assert.equal(run(remote("/api/sparks", "/api/sparks?token=s3cret")).status, 401);
    assert.equal(run(remote("/metrics", "/metrics?token=s3cret")).status, 401);
    assert.equal(run({ ...remote("/api/sparks/wake-all", "/api/sparks/wake-all?token=s3cret"), method: "POST" }).status, 401);
    assert.equal(authorizeUpgrade({ ...remote("/ws", "/ws?token=s3cret"), query: undefined }), true);
  });
});

test("20 distinct wrong tokens from one client → 429 with Retry-After, even for the right token (item 9)", () => {
  withEnv({ BIND_HOST: "0.0.0.0", SPARKDASH_TOKEN: "s3cret" }, () => {
    const from = (peer, token, extra = {}) =>
      request({ peer, headers: { host: "192.168.1.10:5555", authorization: `Bearer ${token}`, ...extra } });
    for (let i = 0; i < 20; i++) assert.equal(run(from("192.168.1.20", `guess-${i}`)).status, 401, `guess ${i}`);
    const blocked = run(from("192.168.1.20", "guess-20"));
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.code, "auth_rate_limited");
    assert.ok(Number(blocked.headers["retry-after"]) > 0 && Number(blocked.headers["retry-after"]) <= 300);
    assert.equal(run(from("192.168.1.20", "s3cret")).status, 429, "a guesser cannot confirm a hit while blocked");
    assert.equal(authorizeUpgrade({ ...from("192.168.1.20", "s3cret"), path: "/ws" }), false);
    // Another client is unaffected.
    assert.equal(run(from("192.168.1.21", "s3cret")).passed, true);
    // The status endpoint shares the limiter.
    const status = run(from("192.168.1.20", "s3cret"), createAuthStatusHandler());
    assert.equal(status.status, 429);
  });
});

test("a stale token repeated by one tab never locks the user out; proxy clients are told apart (item 9)", () => {
  withEnv({ BIND_HOST: "127.0.0.1", SPARKDASH_TOKEN: "s3cret" }, () => {
    const viaProxy = (client, token) =>
      request({ headers: { "x-forwarded-for": `spoofed, ${client}`, authorization: `Bearer ${token}` } });
    for (let i = 0; i < 50; i++) assert.equal(run(viaProxy("100.64.0.7", "old-token")).status, 401);
    assert.equal(run(viaProxy("100.64.0.7", "s3cret")).passed, true);
    for (let i = 0; i < 20; i++) run(viaProxy("100.64.0.8", `guess-${i}`));
    assert.equal(run(viaProxy("100.64.0.8", "s3cret")).status, 429);
    assert.equal(run(viaProxy("100.64.0.7", "s3cret")).passed, true, "another tailnet client behind the same proxy");
    // A request without any token is a missing credential, not a guess.
    for (let i = 0; i < 30; i++) run(request({ headers: { "x-forwarded-for": "100.64.0.9" } }));
    assert.equal(run(viaProxy("100.64.0.9", "s3cret")).passed, true);
  });
});

test("the failure limiter's memory is bounded and its window slides", () => {
  let now = 0;
  const limiter = createAuthFailureLimiter({ limit: 3, windowMs: 1000, maxClients: 5, now: () => now });
  for (let c = 0; c < 50; c++) for (let i = 0; i < 10; i++) limiter.recordFailure(`client-${c}`, `t${i}`);
  assert.ok(limiter.size <= 5);
  limiter.reset();
  for (let i = 0; i < 3; i++) limiter.recordFailure("a", `t${i}`);
  assert.equal(limiter.retryAfter("a"), 1);
  now = 999;
  assert.ok(limiter.retryAfter("a") > 0);
  now = 1000;
  assert.equal(limiter.retryAfter("a"), 0);
  assert.equal(limiter.size, 0);
});

test("wrong tokens refused for a foreign Origin/Host still count toward the limiter (no unlimited oracle)", () => {
  withEnv({ BIND_HOST: "127.0.0.1", SPARKDASH_TOKEN: "s3cret" }, () => {
    const guess = (token, extra = {}) =>
      request({ method: "POST", headers: { "x-forwarded-for": "100.64.0.7", authorization: `Bearer ${token}`, ...extra } });
    for (let i = 0; i < 20; i++) assert.equal(run(guess(`guess-${i}`, { origin: "https://evil.example" })).status, 403);
    assert.equal(run(guess("s3cret", { origin: "https://evil.example" })).status, 403, "a hit is not confirmed while blocked");
    assert.equal(run(guess("s3cret")).status, 429);
  });
});

test("a mounted auth middleware gates reads by the full path (baseUrl + path)", () => {
  withEnv({ BIND_HOST: "127.0.0.1", SPARKDASH_TOKEN: "s3cret" }, () => {
    const mounted = { ...request({ path: "/models", headers: { "x-forwarded-for": "100.64.0.7" } }), baseUrl: "/api/fleet/v1" };
    assert.equal(run(mounted).status, 401);
  });
});
