import crypto from "node:crypto";
import fs from "node:fs";

/**
 * Browser hardening headers for every response.
 *
 * The CSP matches what the built app actually loads: its own hashed bundles,
 * self-hosted fonts, inline style attributes (React `style` props), data:/blob:
 * images (the favicon, share-card previews and exports), the same-origin
 * WebSocket and the service worker. index.html carries one small inline script
 * (the theme is applied before first paint); it is allowed by its SHA-256 hash,
 * read from the served index.html so a rebuilt frontend never needs a server edit.
 */

/** `'none'` unless SPARKDASH_FRAME_ANCESTORS lists who may embed the dashboard (such as a Home Assistant origin). */
export function frameAncestors(env = process.env) {
  const raw = String(env.SPARKDASH_FRAME_ANCESTORS || "").trim();
  if (!raw) return "'none'";
  // One directive's source list only: a ";" or "," would start another directive or policy.
  if (/[;,\r\n]/.test(raw)) {
    warnOnce(`[sparkDash] ignoring SPARKDASH_FRAME_ANCESTORS=${JSON.stringify(raw)}: list space-separated sources such as "https://ha.example.com:8123"; using 'none'.`);
    return "'none'";
  }
  return raw;
}

let warned = "";
function warnOnce(message) {
  if (warned === message) return;
  warned = message;
  console.warn(message);
}

/** SHA-256 (base64) of each inline <script> body, as a CSP hash source expects. */
export function inlineScriptHashes(html) {
  const hashes = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (const match of String(html).matchAll(re)) {
    if (/\bsrc\s*=/i.test(match[1])) continue;
    if (!match[2]) continue;
    // Browsers hash the parsed text, after HTML input preprocessing turns CRLF / CR into LF;
    // an index.html checked out with CRLF (Windows autocrlf) must hash the same way.
    const text = match[2].replace(/\r\n?/g, "\n");
    hashes.push(crypto.createHash("sha256").update(text, "utf8").digest("base64"));
  }
  return hashes;
}

/** A Host header safe to echo into a CSP source (host, IPv4, [IPv6], optional port), else null. */
export function cspHost(host) {
  const value = String(host ?? "").trim().toLowerCase();
  return /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*\.?|\[[0-9a-f:.]+\])(?::\d{1,5})?$/.test(value) && value.length <= 255 ? value : null;
}

export function buildContentSecurityPolicy({ scriptHashes = [], ancestors = "'none'", host = null } = {}) {
  const scriptSrc = ["'self'", ...scriptHashes.map((h) => `'sha256-${h}'`)].join(" ");
  // The snapshot WebSocket is same-origin. 'self' covers ws/wss in current browsers; the
  // explicit sources for this request's own host keep older Safari working without
  // allowing sockets to any other host.
  const safeHost = cspHost(host);
  const connectSrc = ["'self'", ...(safeHost ? [`ws://${safeHost}`, `wss://${safeHost}`] : [])].join(" ");
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
    `frame-ancestors ${ancestors}`,
  ].join("; ");
}

/**
 * @param {{ indexHtmlPath?: () => string | null }} [options] where the served index.html lives (null: no frontend)
 */
export function createSecurityHeadersMiddleware({ indexHtmlPath = () => null } = {}) {
  let cached = { file: null, stamp: "", hashes: [] };
  function scriptHashes() {
    let file = null;
    try {
      file = indexHtmlPath();
      if (!file) return [];
      const stat = fs.statSync(file);
      const stamp = `${stat.mtimeMs}:${stat.size}`;
      if (cached.file !== file || cached.stamp !== stamp) {
        cached = { file, stamp, hashes: inlineScriptHashes(fs.readFileSync(file, "utf8")) };
      }
      return cached.hashes;
    } catch {
      return [];
    }
  }
  return function securityHeaders(req, res, next) {
    const ancestors = frameAncestors();
    res.setHeader(
      "Content-Security-Policy",
      buildContentSecurityPolicy({ scriptHashes: scriptHashes(), ancestors, host: req.headers?.host })
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (ancestors === "'none'") res.setHeader("X-Frame-Options", "DENY");
    next();
  };
}
