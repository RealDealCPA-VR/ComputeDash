import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { authStatus, authorizeUpgrade, createAuthMiddleware, resetAuthFailures, setTailscaleName } from "../../auth.js";

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

const LOCAL = { remoteAddress: "127.0.0.1" };
const LAN = { remoteAddress: "192.168.1.77" };

/** A non-browser client. `socket` defaults to a remote peer; pass LOCAL for one on this machine. */
function req({ bearer, query, method = "GET", path = "/api/sparks", socket = LAN, headers = {} } = {}) {
  return {
    method,
    path,
    url: query ? `${path}?token=${encodeURIComponent(query)}` : path,
    headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...headers },
    query: query ? { token: query } : {},
    socket,
  };
}

/** Run the real middleware and report whether it let the request through. */
function passesMiddleware(request) {
  let passed = false;
  const res = { status: () => ({ json: () => {}, type: () => ({ send: () => {} }) }), set: () => {} };
  createAuthMiddleware()(request, res, () => {
    passed = true;
  });
  return passed;
}

test("no token configured: nothing to ask for, on loopback or an opened remote bind", () => {
  for (const BIND_HOST of ["127.0.0.1", "0.0.0.0"]) {
    withEnv({ BIND_HOST, SPARKDASH_ALLOW_OPEN_REMOTE: "1" }, () => {
      const status = authStatus(req());
      assert.equal(status.tokenRequired, false);
      assert.equal(status.authenticated, true);
    });
  }
});

test("token configured: required, and only the right bearer header authenticates", () => {
  withEnv({ SPARKDASH_TOKEN: "s3cret", BIND_HOST: "0.0.0.0" }, () => {
    assert.deepEqual(authStatus(req()), { tokenRequired: true, authenticated: false, canMutate: false });
    assert.deepEqual(authStatus(req({ bearer: "wrong" })), { tokenRequired: true, authenticated: false, canMutate: false });
    assert.deepEqual(authStatus(req({ bearer: "s3cret" })), { tokenRequired: true, authenticated: true, canMutate: true });
    // ?token= is a WebSocket-only fallback; an HTTP route never reads it.
    assert.equal(authStatus(req({ query: "s3cret" })).authenticated, false);
  });
});

test("tokened remote bind: the frontend shell and assets load without a token; api and ws stay gated", () => {
  withEnv({ SPARKDASH_TOKEN: "s3cret", BIND_HOST: "0.0.0.0" }, () => {
    // The SPA cannot ask for the token until its shell and bundles are served.
    for (const path of ["/", "/assets/index-0FP2dord.js", "/tokens", "/favicon.ico"]) {
      assert.equal(passesMiddleware(req({ path })), true, `${path} should pass without a token`);
    }
    for (const path of ["/api/sparks", "/api/settings", "/ws", "/metrics"]) {
      assert.equal(passesMiddleware(req({ path })), false, `${path} should be gated`);
      assert.equal(passesMiddleware(req({ path, bearer: "wrong" })), false, `${path} should reject a wrong token`);
      assert.equal(passesMiddleware(req({ path, bearer: "s3cret" })), true, `${path} should pass with the token`);
      assert.equal(passesMiddleware(req({ path, query: "s3cret" })), false, `${path} should ignore ?token=`);
    }
  });
});

test("DASHBOARD_TOKEN counts as a configured token", () => {
  withEnv({ DASHBOARD_TOKEN: "legacy" }, () => {
    assert.equal(authStatus(req()).tokenRequired, true);
    assert.equal(authStatus(req({ bearer: "legacy" })).authenticated, true);
  });
});

test("the response never echoes the configured or provided token", () => {
  withEnv({ SPARKDASH_TOKEN: "s3cret-value" }, () => {
    const body = JSON.stringify(authStatus(req({ bearer: "s3cret-value" })));
    assert.doesNotMatch(body, /s3cret-value/);
    assert.deepEqual(Object.keys(authStatus(req())).sort(), ["authenticated", "canMutate", "tokenRequired"]);
  });
});

test("the WebSocket upgrade accepts ?token= from the raw request URL", () => {
  // verifyClient receives an unparsed IncomingMessage: a url, headers, no req.query.
  const raw = (url) => ({ url, headers: {}, socket: LAN });
  withEnv({ SPARKDASH_TOKEN: "s3cret", BIND_HOST: "127.0.0.1" }, () => {
    assert.equal(authorizeUpgrade(raw("/ws?token=s3cret")), true);
    assert.equal(authorizeUpgrade(raw("/ws?token=s3cr%65t")), true);
    assert.equal(authorizeUpgrade(raw("/ws?token=wrong")), false);
    assert.equal(authorizeUpgrade(raw("/ws")), false);
    assert.equal(authorizeUpgrade({ url: "/ws", headers: { authorization: "Bearer s3cret" }, socket: LAN }), true);
  });
});

test("tokenRequired mirrors exactly when the WebSocket upgrade and mutations demand a token from a remote client", () => {
  const combos = [];
  for (const SPARKDASH_TOKEN of [undefined, "s3cret"])
    for (const BIND_HOST of ["127.0.0.1", "0.0.0.0"])
      for (const SPARKDASH_ALLOW_OPEN_REMOTE of [undefined, "1"])
        combos.push({ SPARKDASH_TOKEN, BIND_HOST, SPARKDASH_ALLOW_OPEN_REMOTE });

  for (const env of combos) {
    withEnv(env, () => {
      const { tokenRequired } = authStatus(req());
      const label = JSON.stringify(env);
      if (tokenRequired) {
        assert.equal(authorizeUpgrade(req()), false, `ws upgrade ${label}`);
        assert.equal(passesMiddleware(req({ method: "POST" })), false, `mutation ${label}`);
        // ...and the configured token is what unlocks them.
        assert.equal(authorizeUpgrade(req({ query: "s3cret" })), true, `ws upgrade with token ${label}`);
        assert.equal(passesMiddleware(req({ method: "POST", bearer: "s3cret" })), true, `mutation with token ${label}`);
      }
    });
  }
});

/** A browser's request: Host, plus Origin on an API call or WebSocket. */
function browser(host, { origin, method = "GET", bearer, accept, socket = LOCAL, headers = {} } = {}) {
  const h = { host, ...headers };
  if (origin) h.origin = origin;
  if (bearer) h.authorization = `Bearer ${bearer}`;
  if (accept) h.accept = accept;
  return { method, headers: h, query: {}, socket, path: "/api/sparks" };
}

test("a loopback bind keeps working with no setup and refuses cross-site and rebound requests", () => {
  withEnv({ BIND_HOST: "127.0.0.1" }, () => {
    for (const host of ["localhost:5555", "127.0.0.1:5555", "[::1]:5555"]) {
      const origin = `http://${host}`;
      assert.equal(passesMiddleware(browser(host)), true, `page ${host}`);
      assert.equal(passesMiddleware(browser(host, { origin, method: "POST" })), true, `API ${host}`);
      assert.equal(authorizeUpgrade(browser(host, { origin })), true, `WebSocket ${host}`);
    }
    // The stock Vite dev server (127.0.0.1:5173) proxies with the browser's Host and Origin.
    const vite = "127.0.0.1:5173";
    assert.equal(passesMiddleware(browser(vite, { origin: `http://${vite}`, method: "POST" })), true);
    assert.equal(authorizeUpgrade(browser(vite, { origin: `http://${vite}` })), true);
    // A Vite dev server opened on a LAN IP is a proxy for other machines: reads only.
    const lan = "192.168.1.50:5173";
    assert.equal(passesMiddleware(browser(lan, { origin: `http://${lan}` })), true);
    assert.equal(passesMiddleware(browser(lan, { origin: `http://${lan}`, method: "POST" })), false);
    assert.equal(authorizeUpgrade(browser(lan, { origin: `http://${lan}` })), true);

    // Cross-site POST /api/sparks/wake-all and WebSocket.
    const evil = "https://evil.example";
    assert.equal(passesMiddleware(browser("127.0.0.1:5555", { origin: evil, method: "POST" })), false);
    assert.equal(authorizeUpgrade(browser("127.0.0.1:5555", { origin: evil })), false);
    // A page served from a bare IP is another site too.
    assert.equal(passesMiddleware(browser("127.0.0.1:5555", { origin: "http://203.0.113.7", method: "POST" })), false);
    assert.equal(passesMiddleware(browser("127.0.0.1:5555", { origin: "null", method: "POST" })), false);

    // DNS rebinding: same-origin with the attacker's own name.
    const rebound = "rebound.example:5555";
    assert.equal(passesMiddleware(browser(rebound)), false);
    assert.equal(passesMiddleware(browser(rebound, { origin: `http://${rebound}`, method: "POST" })), false);
    assert.equal(authorizeUpgrade(browser(rebound, { origin: `http://${rebound}` })), false);
  });
});

test("the derived allowlist: IP literals, *.localhost, this machine's name and its Tailscale name", () => {
  const self = os.hostname().toLowerCase().replace(/\.local$/, "");
  withEnv({ BIND_HOST: "127.0.0.1" }, () => {
    // Loopback names: the browser is on this machine, so it may also make changes.
    assert.equal(passesMiddleware(browser("dash.localhost:5555", { origin: "http://dash.localhost:5555", method: "POST" })), true);
    // This machine's own name is an allowed Host (reads), but not proof of a local browser:
    // a header-less TCP forward (tailscale serve --tcp) arrives from loopback with that name.
    for (const host of [`${self.toUpperCase()}:5555`, `${self}.local`]) {
      assert.equal(passesMiddleware(browser(host, { origin: `http://${host}` })), true, host);
      assert.equal(passesMiddleware(browser(host, { origin: `http://${host}`, method: "POST" })), false, host);
    }
    // IP literals are allowed Hosts (reads), but a non-loopback one means a proxy.
    for (const host of ["10.0.0.5:5555", "[fe80::1]:5555"]) {
      assert.equal(passesMiddleware(browser(host, { origin: `http://${host}` })), true, host);
      assert.equal(passesMiddleware(browser(host, { origin: `http://${host}`, method: "POST" })), false, host);
    }
    // Look-alikes are the attacker's names.
    for (const host of ["127.evil.example", "localhost.evil.example", `${self}.evil.example`]) {
      assert.equal(passesMiddleware(browser(host)), false, host);
    }

    const serve = "spark-1.tail1234.ts.net";
    const served = (extra = {}) => browser(serve, { headers: { "x-forwarded-for": "100.64.0.9" }, ...extra });
    assert.equal(passesMiddleware(served({ origin: `https://${serve}` })), false);
    try {
      setTailscaleName(`${serve}.`);
      assert.equal(passesMiddleware(served()), true);
      assert.equal(authorizeUpgrade(served({ origin: `https://${serve}` })), true);
      // Tailscale Serve is a proxy: without a token it cannot make changes.
      assert.equal(passesMiddleware(served({ origin: `https://${serve}`, method: "POST" })), false);
    } finally {
      setTailscaleName("");
    }
  });
});

test("SPARKDASH_ALLOWED_HOSTS admits a custom proxy domain, also as the Origin when the proxy rewrites Host", () => {
  const proxied = (origin, extra = {}) =>
    browser("127.0.0.1:5555", { origin, method: "POST", headers: { "x-forwarded-for": "203.0.113.5" }, ...extra });
  const viaProxy = (host) => browser(host, { headers: { "x-forwarded-for": "203.0.113.5" } });
  withEnv({ BIND_HOST: "127.0.0.1" }, () => {
    assert.equal(passesMiddleware(viaProxy("dash.example.com")), false);
  });
  withEnv({ BIND_HOST: "127.0.0.1", SPARKDASH_ALLOWED_HOSTS: " Dash.Example.com:443, other.example" }, () => {
    // The Host check admits the proxy's name; without a token, reads are open.
    assert.equal(passesMiddleware(viaProxy("dash.example.com")), true);
    assert.equal(passesMiddleware(proxied("https://dash.example.com")), false, "no token: a proxied change is refused");
  });
  withEnv({ BIND_HOST: "127.0.0.1", SPARKDASH_TOKEN: "s3cret", SPARKDASH_ALLOWED_HOSTS: " Dash.Example.com:443, other.example" }, () => {
    assert.equal(passesMiddleware(viaProxy("dash.example.com")), false, "tokened: a proxied read needs the token");
    assert.equal(passesMiddleware(proxied("https://dash.example.com")), false, "proxied mutation still needs the token");
    assert.equal(passesMiddleware(proxied("https://dash.example.com", { bearer: "s3cret" })), true);
    assert.equal(
      authorizeUpgrade({ ...browser("127.0.0.1:5555", { origin: "https://dash.example.com" }), url: "/ws?token=s3cret" }),
      true
    );
    // The entry names port 443, so the same name on another port is not this dashboard.
    assert.equal(passesMiddleware(proxied("https://dash.example.com:8443")), false);
    assert.equal(passesMiddleware(proxied("https://evil.example")), false);
  });
});

test("a valid token skips the Host check; a wrong one does not", () => {
  withEnv({ BIND_HOST: "127.0.0.1", SPARKDASH_TOKEN: "s3cret" }, () => {
    const rebound = "rebound.example:5555";
    assert.equal(passesMiddleware(browser(rebound, { bearer: "s3cret" })), true);
    assert.equal(authorizeUpgrade({ url: "/ws?token=s3cret", headers: { host: rebound, origin: `http://${rebound}` }, socket: LOCAL }), true);
    assert.equal(passesMiddleware(browser(rebound, { bearer: "wrong" })), false);
    assert.equal(authorizeUpgrade({ url: "/ws?token=wrong", headers: { host: rebound }, socket: LOCAL }), false);
  });
});

test("a refused browser navigation gets a page naming the host; an API call gets JSON", () => {
  const refusal = (request) => {
    const sent = {};
    const res = {
      status(code) {
        sent.status = code;
        return this;
      },
      type(type) {
        sent.type = type;
        return this;
      },
      send(body) {
        sent.body = body;
      },
      json(body) {
        sent.json = body;
      },
    };
    createAuthMiddleware()(request, res, () => {});
    return sent;
  };
  withEnv({ BIND_HOST: "127.0.0.1" }, () => {
    const page = refusal(browser("rebound.example:5555", { accept: "text/html,application/xhtml+xml,*/*;q=0.8" }));
    assert.equal(page.status, 403);
    assert.equal(page.type, "html");
    assert.match(page.body, /<b>rebound\.example<\/b>/);
    assert.match(page.body, /SPARKDASH_ALLOWED_HOSTS/);

    const api = refusal(browser("rebound.example:5555", { accept: "application/json" }));
    assert.equal(api.status, 403);
    assert.match(api.json.error, /rebound\.example.*SPARKDASH_ALLOWED_HOSTS/);

    const cross = refusal(browser("127.0.0.1:5555", { origin: "http://127.0.0.1:8188", method: "POST" }));
    assert.equal(cross.status, 403);
    assert.equal(cross.json.code, "origin_not_allowed");
    assert.match(cross.json.error, /127\.0\.0\.1:8188.*SPARKDASH_ALLOWED_ORIGINS/);
  });
});

test("a non-loopback bind skips the Host check but checks Origin on mutations and WebSockets", () => {
  withEnv({ BIND_HOST: "0.0.0.0", SPARKDASH_ALLOW_OPEN_REMOTE: "1" }, () => {
    assert.equal(passesMiddleware(browser("rebound.example:5555", { socket: LAN })), true);
    assert.equal(passesMiddleware(browser("10.0.0.5:5555", { origin: "https://evil.example", socket: LAN })), true, "a read");
    assert.equal(passesMiddleware(browser("10.0.0.5:5555", { origin: "https://evil.example", method: "POST", socket: LAN })), false);
    assert.equal(authorizeUpgrade(browser("10.0.0.5:5555", { origin: "https://evil.example", socket: LAN })), false);
    assert.equal(passesMiddleware(browser("10.0.0.5:5555", { origin: "http://10.0.0.5:5555", method: "POST", socket: LAN })), true);
  });
});

test("tokened remote bind: the API gate ignores path case, as Express routing does", () => {
  withEnv({ SPARKDASH_TOKEN: "s3cret", BIND_HOST: "0.0.0.0" }, () => {
    for (const path of ["/API/sparks", "/Api/Sparks", "/METRICS", "/Ws"]) {
      assert.equal(passesMiddleware(req({ path })), false, `${path} without a token`);
      assert.equal(passesMiddleware(req({ path, bearer: "s3cret" })), true, `${path} with the token`);
    }
    // A state-changing request was already gated; it must stay that way.
    assert.equal(passesMiddleware(req({ path: "/API/sparks/shutdown-all", method: "POST" })), false);
    // The SPA shell and its hashed assets still load before the app has a token.
    assert.equal(passesMiddleware(req({ path: "/" })), true);
    assert.equal(passesMiddleware(req({ path: "/assets/index-abc123.js" })), true);
  });
});
