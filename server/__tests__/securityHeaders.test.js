/**
 * Security headers (item 7): a CSP that matches the built app, nosniff,
 * no-referrer and a framing rule that SPARKDASH_FRAME_ANCESTORS can relax.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildContentSecurityPolicy,
  createSecurityHeadersMiddleware,
  cspHost,
  frameAncestors,
  inlineScriptHashes,
} from "../securityHeaders.js";

function headersFor(middleware) {
  const headers = {};
  let nextCalled = false;
  middleware({}, { setHeader: (k, v) => (headers[k.toLowerCase()] = v) }, () => (nextCalled = true));
  assert.equal(nextCalled, true);
  return headers;
}

function withFrameAncestors(value, fn) {
  const saved = process.env.SPARKDASH_FRAME_ANCESTORS;
  try {
    if (value == null) delete process.env.SPARKDASH_FRAME_ANCESTORS;
    else process.env.SPARKDASH_FRAME_ANCESTORS = value;
    return fn();
  } finally {
    if (saved == null) delete process.env.SPARKDASH_FRAME_ANCESTORS;
    else process.env.SPARKDASH_FRAME_ANCESTORS = saved;
  }
}

const sha = (text) => crypto.createHash("sha256").update(text, "utf8").digest("base64");

test("inline scripts are hashed exactly as the browser hashes them; external scripts are not", () => {
  const body = '\n    try { document.documentElement.dataset.x = "1"; } catch (e) {}\n  ';
  const html = `<head><script>${body}</script><script type="module" crossorigin src="/assets/index.js"></script></head>`;
  assert.deepEqual(inlineScriptHashes(html), [sha(body)]);
});

test("an index.html with CRLF line endings hashes like the browser's LF-normalized text", () => {
  const lf = '\n    var t = 1;\n  ';
  const html = `<head><script>${lf.replace(/\n/g, "\r\n")}</script></head>`;
  assert.deepEqual(inlineScriptHashes(html), [sha(lf)]);
});

test("connect-src allows WebSockets only to the request's own host, never any host", () => {
  const csp = buildContentSecurityPolicy({ host: "dell.tail1234.ts.net" });
  assert.ok(csp.split("; ").includes("connect-src 'self' ws://dell.tail1234.ts.net wss://dell.tail1234.ts.net"));
  assert.doesNotMatch(csp, /connect-src[^;]*\bws: /);
  assert.ok(buildContentSecurityPolicy({ host: "127.0.0.1:5555" }).includes("ws://127.0.0.1:5555 wss://127.0.0.1:5555"));
  assert.ok(buildContentSecurityPolicy({ host: "[::1]:5555" }).includes("wss://[::1]:5555"));
  // A Host that could smuggle another source or directive is not echoed.
  for (const bad of ["evil.com; script-src *", "a b", "x'y", "*", "", null, "a".repeat(300)]) {
    assert.equal(cspHost(bad), null, String(bad).slice(0, 20));
    assert.ok(buildContentSecurityPolicy({ host: bad }).split("; ").includes("connect-src 'self'"));
  }
});

test("the CSP lists exactly the sources the app uses", () => {
  const csp = buildContentSecurityPolicy({ scriptHashes: ["abc="], ancestors: "'none'" });
  for (const directive of [
    "default-src 'self'",
    "script-src 'self' 'sha256-abc='",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ]) {
    assert.ok(csp.split("; ").includes(directive), directive);
  }
  assert.doesNotMatch(csp, /unsafe-eval/);
});

test("default: framing denied, nosniff and no-referrer; the served index.html's inline script is allowed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-csp-"));
  try {
    const index = path.join(dir, "index.html");
    fs.writeFileSync(index, "<script>window.a=1</script>");
    const middleware = createSecurityHeadersMiddleware({ indexHtmlPath: () => index });
    withFrameAncestors(undefined, () => {
      const h = headersFor(middleware);
      assert.equal(h["x-content-type-options"], "nosniff");
      assert.equal(h["referrer-policy"], "no-referrer");
      assert.equal(h["x-frame-options"], "DENY");
      assert.match(h["content-security-policy"], /frame-ancestors 'none'/);
      assert.ok(h["content-security-policy"].includes(`'sha256-${sha("window.a=1")}'`));
    });
    // A rebuilt frontend is picked up without a restart.
    fs.writeFileSync(index, "<script>window.b=2; // longer</script>");
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(index, later, later);
    const h = headersFor(middleware);
    assert.ok(h["content-security-policy"].includes(`'sha256-${sha("window.b=2; // longer")}'`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SPARKDASH_FRAME_ANCESTORS lets a Home Assistant origin embed the dashboard", () => {
  withFrameAncestors("'self' https://ha.example.com:8123", () => {
    const h = headersFor(createSecurityHeadersMiddleware());
    assert.match(h["content-security-policy"], /frame-ancestors 'self' https:\/\/ha\.example\.com:8123$/);
    assert.equal(h["x-frame-options"], undefined, "X-Frame-Options DENY would override the allowance");
  });
  // A value that would inject another directive, or a comma list, is ignored.
  withFrameAncestors("https://ha.example.com; script-src *", () => {
    assert.equal(frameAncestors(), "'none'");
  });
  withFrameAncestors("https://a.example, https://b.example", () => {
    assert.equal(frameAncestors(), "'none'");
  });
});

test("a missing frontend still gets the headers", () => {
  const h = headersFor(createSecurityHeadersMiddleware({ indexHtmlPath: () => path.join(os.tmpdir(), "no-such-dir", "index.html") }));
  assert.match(h["content-security-policy"], /script-src 'self';/);
});
