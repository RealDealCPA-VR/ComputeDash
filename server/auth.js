import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import os from "node:os";

/*
 * Access rules (createAuthMiddleware / authorizeUpgrade):
 *
 * "Direct local" means the request came straight from this machine: the socket
 * peer is loopback, no reverse-proxy header is present (Tailscale Serve, nginx,
 * Caddy, … add X-Forwarded-For and friends), and Host/Origin, when present, are
 * this machine's local names. Anything that arrives through a proxy, even one
 * that connects from 127.0.0.1, is not direct local.
 *
 * - Mutations (anything but GET/HEAD/OPTIONS):
 *     token configured → the token is required;
 *     no token         → allowed only for a direct-local request, or on a
 *                        non-loopback bind the operator explicitly opened with
 *                        SPARKDASH_ALLOW_OPEN_REMOTE=1; otherwise 403 token_required.
 * - Reads of /api, /ws and /metrics:
 *     token configured → direct-local reads are open, every other read needs the token;
 *     no token         → open (monitoring is intentionally open; a non-loopback
 *                        bind must have opted in with SPARKDASH_ALLOW_OPEN_REMOTE=1).
 * - The SPA shell and its hashed assets always load: they carry no secrets and
 *   the app has to run before it can ask for a token.
 * - Browser checks (DNS rebinding, CSRF) run first; see refusedName().
 */

export function configuredToken() {
  const token = process.env.SPARKDASH_TOKEN || process.env.DASHBOARD_TOKEN || "";
  return token.trim();
}

export function isLoopbackBind(host) {
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}

export function requireRemoteAuth(bindHost) {
  return !isLoopbackBind(bindHost);
}

function bindHost() {
  return process.env.BIND_HOST || "127.0.0.1";
}

/** The port this server listens on (PORT, default 5555). */
function serverPort() {
  const port = Number.parseInt(process.env.PORT || "5555", 10);
  return Number.isInteger(port) && port > 0 ? port : 5555;
}

/**
 * A non-loopback bind without SPARKDASH_TOKEN is refused unless the operator
 * explicitly opens it with SPARKDASH_ALLOW_OPEN_REMOTE=1. Unset, empty or any
 * other value fails closed.
 */
export function allowOpenRemote() {
  return process.env.SPARKDASH_ALLOW_OPEN_REMOTE === "1";
}

/** This machine's own name, without the `.local` macOS appends to it. */
const SELF_NAME = os.hostname().toLowerCase().replace(/\.local$/, "");
let tailscaleName = "";

/** This machine's Tailscale MagicDNS name (`Self.DNSName`), so Tailscale Serve needs no setup. */
export function setTailscaleName(dnsName) {
  tailscaleName = String(dnsName || "").toLowerCase().replace(/\.$/, "");
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** localhost, *.localhost, 127.0.0.0/8 and [::1]: names that only ever reach this machine. */
function isLoopbackName(name) {
  if (name === "localhost" || name.endsWith(".localhost") || name === "[::1]" || name === "::1") return true;
  return isIP(name) === 4 && name.startsWith("127.");
}

/** Loopback names plus this machine's own hostname: what a user on this machine types. */
function isLocalName(name) {
  return isLoopbackName(name) || name === SELF_NAME || name === `${SELF_NAME}.local`;
}

function allowedHostEntries() {
  return (process.env.SPARKDASH_ALLOWED_HOSTS || "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean)
    .map((h) => {
      const url = parseUrl(`http://${h}`);
      if (!url) return null;
      // URL drops ":80" for http, so read an explicit port from the entry itself.
      const port = /:(\d+)$/.exec(h)?.[1];
      return { hostname: url.hostname, port: port ? Number(port) : null };
    })
    .filter(Boolean);
}

/** Names that only reach this machine: neither a DNS-rebinding page nor another site can use them. */
function isOwnName(name) {
  if (isLocalName(name)) return true;
  if (tailscaleName && name === tailscaleName) return true;
  return allowedHostEntries().some((entry) => entry.hostname === name);
}

/** A rebinding page has to use the attacker's own name, so any IP literal is a safe Host too. */
function isAllowedHost(name) {
  return isOwnName(name) || isIP(name.replace(/^\[(.*)\]$/, "$1")) !== 0;
}

function effectivePort(url) {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" || url.protocol === "wss:" ? 443 : 80;
}

/**
 * Explicit extra origins (SPARKDASH_ALLOWED_ORIGINS, comma-separated full origins
 * such as "http://localhost:5173"). Not needed for the stock Vite dev server: its
 * proxy keeps the browser's Host (no changeOrigin), so Origin matches Host there.
 */
function explicitlyAllowedOrigin(originUrl) {
  const raw = process.env.SPARKDASH_ALLOWED_ORIGINS || "";
  if (!raw.trim()) return false;
  return raw
    .split(",")
    .map((o) => parseUrl(o.trim())?.origin)
    .some((o) => o && o !== "null" && o === originUrl.origin);
}

/**
 * Whether a browser Origin belongs to this dashboard:
 * (a) it is the request's own Host (host and port), or
 * (b) it is one of our non-loopback names: this machine's hostname, its Tailscale
 *     name or a SPARKDASH_ALLOWED_HOSTS entry (proxy front-ends, any port unless
 *     the entry names one), or
 * (c) it is a loopback name on the port this server listens on. Another local
 *     service (ComfyUI on :8188, a dev server on :5173 called directly) is a
 *     different origin and must not be able to drive the dashboard.
 */
function originAllowed(origin, hostUrl) {
  const originUrl = parseUrl(origin);
  if (!originUrl || originUrl.origin === "null") return false;
  if (hostUrl && originUrl.host === hostUrl.host) return true;
  if (explicitlyAllowedOrigin(originUrl)) return true;
  const name = originUrl.hostname;
  if (isLoopbackName(name)) return effectivePort(originUrl) === serverPort();
  if (name === SELF_NAME || name === `${SELF_NAME}.local` || (tailscaleName && name === tailscaleName)) return true;
  return allowedHostEntries().some(
    (entry) => entry.hostname === name && (entry.port == null || entry.port === effectivePort(originUrl))
  );
}

const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "x-real-ip"];

function hasProxyHeaders(headers) {
  for (const name of Object.keys(headers || {})) {
    const lower = name.toLowerCase();
    if (PROXY_HEADERS.includes(lower) || lower.startsWith("tailscale-user-")) return true;
  }
  return false;
}

function isLoopbackAddress(address) {
  const addr = String(address || "").replace(/^::ffff:/i, "");
  if (addr === "::1") return true;
  return isIP(addr) === 4 && addr.startsWith("127.");
}

function remoteAddress(req) {
  return req?.socket?.remoteAddress || req?.connection?.remoteAddress || "";
}

/**
 * True when the request came straight from this machine: loopback peer, no
 * proxy headers, and a loopback Host/Origin (localhost, *.localhost, 127.x,
 * [::1]). A proxy that forwards to loopback (Tailscale Serve, nginx, an
 * SSH-tunnelled reverse proxy) is not direct local. The machine's own hostname
 * is deliberately not enough: a TCP forwarder that adds no headers
 * (`tailscale serve --tcp`, socat) arrives from loopback with the MagicDNS
 * short name, which usually equals the hostname.
 */
export function isDirectLocalRequest(req) {
  if (!isLoopbackAddress(remoteAddress(req))) return false;
  const headers = req.headers || {};
  if (hasProxyHeaders(headers)) return false;
  if (headers.host) {
    const hostUrl = parseUrl(`http://${headers.host}`);
    if (!hostUrl || !isLoopbackName(hostUrl.hostname)) return false;
  }
  if (headers.origin) {
    const originUrl = parseUrl(headers.origin);
    if (!originUrl || originUrl.origin === "null" || !isLoopbackName(originUrl.hostname)) return false;
  }
  return true;
}

/**
 * The name a browser request is refused for, or "" to let it through.
 * - Loopback bind: Host must be one of our names or an IP literal (DNS rebinding).
 * - Origin (when sent) must belong to this dashboard (originAllowed). On a
 *   loopback bind every request is checked; on a non-loopback bind, mutations
 *   and WebSocket upgrades are. A request without Host or Origin is not a browser's.
 * A valid token skips these checks: neither a rebinding page nor another site can know it.
 */
function refusedName(req, { mutating = false, upgrade = false } = {}) {
  // checkToken, not authenticate: a wrong token sent with a foreign Host/Origin is
  // refused here, before the auth middleware's own check, so it must count toward
  // (and be blocked by) the failure limiter too, or this becomes an unlimited oracle.
  if (configuredToken() && extractBearer(req, { allowQuery: upgrade }) && checkToken(req, { allowQuery: upgrade }).ok) return null;
  const loopbackBind = !requireRemoteAuth(bindHost());
  const { host, origin } = req.headers || {};
  const hostUrl = host ? parseUrl(`http://${host}`) : null;
  if (loopbackBind && host && !(hostUrl && isAllowedHost(hostUrl.hostname))) {
    return { name: hostUrl?.hostname || String(host).slice(0, 100), origin: false };
  }
  if (!origin) return null;
  if (!loopbackBind && !mutating && !upgrade) return null;
  if (originAllowed(origin, hostUrl)) return null;
  const originUrl = parseUrl(origin);
  const shown = originUrl && originUrl.origin !== "null" ? originUrl.host : String(origin).slice(0, 100);
  return { name: shown, origin: true };
}

/** Fetch metadata: a cross-site or same-site (another port, a sibling subdomain) page sent this. */
function crossSiteFetch(req) {
  const site = String(req.headers?.["sec-fetch-site"] || "").toLowerCase();
  return site === "cross-site" || site === "same-site";
}

const refusedLoggedAt = new Map();

/** Name the refused host at most once an hour, so the operator sees exactly what to allow. */
function logRefused({ name, origin }) {
  const now = Date.now();
  const key = `${origin ? "origin" : "host"} ${name}`;
  if (now - (refusedLoggedAt.get(key) ?? -Infinity) < 60 * 60 * 1000) return;
  if (refusedLoggedAt.size >= 100) refusedLoggedAt.clear();
  refusedLoggedAt.set(key, now);
  console.warn(
    origin
      ? `[sparkDash] refused a request sent by a page at ${JSON.stringify(name)}. If that page is this dashboard (a reverse proxy or custom domain), add its host to SPARKDASH_ALLOWED_HOSTS, or its full origin to SPARKDASH_ALLOWED_ORIGINS.`
      : `[sparkDash] refused a request for ${JSON.stringify(name)}. If that is how you reach this dashboard, add it to SPARKDASH_ALLOWED_HOSTS.`
  );
}

function refuse(req, res, refusal) {
  logRefused(refusal);
  const { name } = refusal;
  if (refusal.origin) {
    return res.status(403).json({
      error: `sparkDash does not accept requests from pages at ${name} (add its host to SPARKDASH_ALLOWED_HOSTS or its origin to SPARKDASH_ALLOWED_ORIGINS if that is this dashboard)`,
      code: "origin_not_allowed",
    });
  }
  if (req.method === "GET" && /text\/html/.test(req.headers?.accept || "")) {
    const shown = name.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    return res
      .status(403)
      .type("html")
      .send(
        `<!doctype html><title>sparkDash: host not allowed</title><p>sparkDash does not answer to <b>${shown}</b>.</p>` +
          `<p>If that is how you reach this dashboard, such as a reverse proxy or a custom domain, add it to <code>SPARKDASH_ALLOWED_HOSTS</code> (comma-separated) and restart sparkDash.</p>`
      );
  }
  return res.status(403).json({ error: `sparkDash does not answer to ${name} (add it to SPARKDASH_ALLOWED_HOSTS if that is this dashboard's address)` });
}

export const TOKEN_REQUIRED_MESSAGE =
  "Changes from this address need a dashboard access token. Set SPARKDASH_TOKEN (`npm run setup` can generate one), restart sparkDash and enter the token in the dashboard. Without a token, only a browser on the dashboard machine itself, opened at its loopback address, can make changes.";

function tokenRequired(res) {
  return res.status(403).json({ error: TOKEN_REQUIRED_MESSAGE, code: "token_required" });
}

function tokensEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The bearer token from the Authorization header. `?token=` is read only when
 * `allowQuery` is set, which only the WebSocket upgrade does: a browser socket
 * cannot set headers, while a token in any other URL leaks into logs, history
 * and Referer.
 */
export function extractBearer(req, { allowQuery = false } = {}) {
  const header = req.headers?.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match) return match[1].trim();
  if (!allowQuery) return "";
  const query = typeof req.query?.token === "string" ? req.query.token : queryTokenFromUrl(req.url);
  return typeof query === "string" ? query.trim() : "";
}

/**
 * The WebSocket upgrade hands verifyClient a raw IncomingMessage — Express has
 * not parsed it, so there is no req.query. Read `?token=` from the URL itself,
 * or the browser's socket (which cannot set headers) is always refused.
 */
function queryTokenFromUrl(url) {
  if (typeof url !== "string" || !url.includes("?")) return "";
  try {
    return new URL(url, "http://localhost").searchParams.get("token") || "";
  } catch {
    return "";
  }
}

export function authenticate(req, { allowQuery = false } = {}) {
  const expected = configuredToken();
  if (!expected) return { ok: true, mode: "open-loopback" };
  const provided = extractBearer(req, { allowQuery });
  if (!provided || !tokensEqual(provided, expected)) {
    return { ok: false, status: 401, error: "Authentication required", provided: Boolean(provided) };
  }
  return { ok: true, mode: "bearer" };
}

// ─── Failed-authentication limiter ─────────────────────────────────────────

const AUTH_FAILURE_LIMIT = 20;
const AUTH_FAILURE_WINDOW_MS = 5 * 60 * 1000;
const AUTH_FAILURE_MAX_CLIENTS = 1024;

/**
 * Per-client count of distinct wrong tokens in a sliding window. Distinct, so
 * a tab still polling with one stale token does not lock its user out once
 * they enter the right one; a guesser has to try a new token every time.
 * Bounded: at most AUTH_FAILURE_MAX_CLIENTS clients × AUTH_FAILURE_LIMIT entries.
 */
export function createAuthFailureLimiter({ limit = AUTH_FAILURE_LIMIT, windowMs = AUTH_FAILURE_WINDOW_MS, maxClients = AUTH_FAILURE_MAX_CLIENTS, now = Date.now } = {}) {
  /** @type {Map<string, Map<string, number>>} client -> token digest -> last failure */
  const clients = new Map();
  function live(key, t) {
    const entries = clients.get(key);
    if (!entries) return null;
    for (const [digest, at] of entries) if (t - at >= windowMs) entries.delete(digest);
    if (entries.size === 0) {
      clients.delete(key);
      return null;
    }
    return entries;
  }
  return {
    /** Seconds until this client may try again, or 0. */
    retryAfter(key) {
      const t = now();
      const entries = live(key, t);
      if (!entries || entries.size < limit) return 0;
      const oldest = Math.min(...entries.values());
      return Math.max(1, Math.ceil((oldest + windowMs - t) / 1000));
    },
    recordFailure(key, provided) {
      const t = now();
      let entries = live(key, t);
      if (!entries) {
        if (clients.size >= maxClients) {
          for (const k of clients.keys()) if (!live(k, t)) break;
          if (clients.size >= maxClients) clients.delete(clients.keys().next().value);
        }
        entries = new Map();
        clients.set(key, entries);
      }
      const digest = createHash("sha256").update(String(provided)).digest("base64").slice(0, 16);
      entries.delete(digest);
      entries.set(digest, t);
      while (entries.size > limit) entries.delete(entries.keys().next().value);
    },
    get size() {
      return clients.size;
    },
    reset() {
      clients.clear();
    },
  };
}

const authFailures = createAuthFailureLimiter();

/** Test hook: forget recorded failures. */
export function resetAuthFailures() {
  authFailures.reset();
}

/**
 * Who failed: the socket peer, plus the nearest proxy's view of the client
 * (the last X-Forwarded-For hop, which the proxy appended itself) when the
 * peer is a loopback proxy such as Tailscale Serve, so one remote guesser does
 * not lock out everyone behind the same proxy.
 */
function failureKey(req) {
  const peer = remoteAddress(req) || "unknown";
  if (!isLoopbackAddress(peer)) return peer;
  const xff = String(req.headers?.["x-forwarded-for"] || "");
  const last = xff.split(",").map((s) => s.trim()).filter(Boolean).pop();
  return last ? `${peer}|${last.slice(0, 64)}` : peer;
}

/**
 * Token check with the failure limiter: { ok } or { ok:false, status, body, retryAfter? }.
 */
function checkToken(req, { allowQuery = false } = {}) {
  // One verdict per request: refusedName() and the middleware (twice under the
  // /api/fleet/v1 mount) may all ask, but a guess must be counted once.
  const memo = req && typeof req === "object" ? tokenChecks.get(req) : undefined;
  if (memo && memo.allowQuery === allowQuery) return memo.result;
  const result = checkTokenOnce(req, { allowQuery });
  if (req && typeof req === "object") tokenChecks.set(req, { allowQuery, result });
  return result;
}

const tokenChecks = new WeakMap();

function checkTokenOnce(req, { allowQuery = false } = {}) {
  const key = failureKey(req);
  const wait = authFailures.retryAfter(key);
  if (wait > 0) {
    return {
      ok: false,
      status: 429,
      retryAfter: wait,
      body: { error: "Too many failed authentication attempts; try again later", code: "auth_rate_limited" },
    };
  }
  const result = authenticate(req, { allowQuery });
  if (result.ok) return { ok: true };
  if (result.provided) authFailures.recordFailure(key, extractBearer(req, { allowQuery }));
  return { ok: false, status: result.status, body: { error: result.error } };
}

function sendCheckFailure(res, check) {
  if (check.retryAfter) {
    if (typeof res.set === "function") res.set("Retry-After", String(check.retryAfter));
    else res.setHeader?.("Retry-After", String(check.retryAfter));
  }
  return res.status(check.status).json(check.body);
}

/**
 * Loopback Host/Origin (DNS-rebinding) check on its own, for routes that must
 * answer before token auth (such as /api/auth/status).
 */
export function createHostGuardMiddleware() {
  return function hostGuard(req, res, next) {
    const refused = refusedName(req);
    if (refused) return refuse(req, res, refused);
    next();
  };
}

const GATED_READ_PATH = /^\/(api|ws|metrics)(\/|$)/i;

export function createAuthMiddleware() {
  return function authMiddleware(req, res, next) {
    const method = (req.method || "GET").toUpperCase();
    const mutating = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
    if (mutating && crossSiteFetch(req)) {
      return res.status(403).json({ error: "Cross-site requests cannot change this dashboard", code: "cross_site" });
    }
    const refused = refusedName(req, { mutating });
    if (refused) return refuse(req, res, refused);
    const remote = requireRemoteAuth(bindHost());
    const directLocal = isDirectLocalRequest(req);

    if (!configuredToken()) {
      if (remote && !allowOpenRemote() && !directLocal) {
        return res.status(403).json({ error: "Remote access requires SPARKDASH_TOKEN", code: "token_required" });
      }
      if (!mutating) return next();
      if (directLocal || (remote && allowOpenRemote())) return next();
      return tokenRequired(res);
    }

    // The built frontend must load before the app can ask for the token: the
    // SPA shell and its hashed assets carry no secrets, so they answer without
    // auth. API routes and the WebSocket stay token-gated for everything that
    // is not direct local; the app authenticates its own calls from
    // localStorage (src/api/authToken.ts).
    // Case-insensitive, like Express routing: /API/sparks reaches the same handler as /api/sparks.
    // baseUrl + path: mounted under app.use("/api/fleet/v1", …) req.path is relative to the mount.
    if (!mutating && !GATED_READ_PATH.test(`${req.baseUrl || ""}${req.path || ""}`)) return next();
    if (!mutating && directLocal) return next();
    const check = checkToken(req);
    if (!check.ok) return sendCheckFailure(res, check);
    next();
  };
}

/**
 * /api/auth/status: what the UI needs to know before it asks for a token, and nothing more.
 * Host-guarded and failure-limited, so it cannot be used to guess the token faster.
 */
export function createAuthStatusHandler() {
  return function authStatusHandler(req, res) {
    const refused = refusedName(req);
    if (refused) return refuse(req, res, refused);
    if (configuredToken()) {
      const check = checkToken(req);
      if (!check.ok && check.status === 429) return sendCheckFailure(res, check);
    }
    res.json(authStatus(req));
  };
}

/**
 * `tokenRequired` is true exactly when a configured token gates mutations from
 * every client. `authenticated` says whether this request's bearer header would
 * pass. `canMutate` says whether this request, as sent, may change anything:
 * without a token only a direct-local request (or an explicitly opened remote
 * bind) can, so a browser behind Tailscale Serve learns it needs a token.
 * The token itself is never part of the response.
 */
export function authStatus(req) {
  const tokenRequired = Boolean(configuredToken());
  const authenticated = authenticate(req).ok;
  const remote = requireRemoteAuth(bindHost());
  const canMutate = tokenRequired ? authenticated : isDirectLocalRequest(req) || (remote && allowOpenRemote());
  return { tokenRequired, authenticated, canMutate };
}

export function authorizeUpgrade(req) {
  const refused = refusedName(req, { upgrade: true });
  if (refused) {
    logRefused(refused);
    return false;
  }
  const remote = requireRemoteAuth(bindHost());
  const directLocal = isDirectLocalRequest(req);
  if (!configuredToken()) return !remote || allowOpenRemote() || directLocal;
  if (directLocal) return true;
  return checkToken(req, { allowQuery: true }).ok;
}
