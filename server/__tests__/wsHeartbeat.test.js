/**
 * WebSocket heartbeat (item 10): clients that stop answering pings are
 * terminated; responsive clients stay; stopping clears the interval.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import { WebSocket, WebSocketServer } from "ws";
import { startWsHeartbeat } from "../wsHeartbeat.js";

test("a client that never pongs is terminated; a responsive one stays connected", async (t) => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(wss, "listening");
  const stop = startWsHeartbeat(wss, { intervalMs: 100 });
  t.after(() => {
    stop();
    wss.close();
  });
  const url = `ws://127.0.0.1:${wss.address().port}`;
  const healthy = new WebSocket(url);
  const silent = new WebSocket(url, { autoPong: false });
  t.after(() => {
    healthy.terminate();
    silent.terminate();
  });
  await Promise.all([once(healthy, "open"), once(silent, "open")]);
  let timer;
  const [code] = await Promise.race([
    once(silent, "close"),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("silent client was not terminated")), 2000);
    }),
  ]).finally(() => clearTimeout(timer));
  assert.equal(code, 1006, "terminated, not closed politely");
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(healthy.readyState, WebSocket.OPEN);
});

test("stopping the heartbeat clears its interval and connection listener", () => {
  const listeners = new Map();
  const fake = {
    clients: new Set(),
    on: (event, fn) => listeners.set(event, fn),
    off: (event, fn) => {
      if (listeners.get(event) === fn) listeners.delete(event);
    },
  };
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  let cleared = null;
  let created = null;
  globalThis.setInterval = (fn, ms) => (created = realSet(fn, ms));
  globalThis.clearInterval = (id) => {
    cleared = id;
    realClear(id);
  };
  try {
    const stop = startWsHeartbeat(fake, { intervalMs: 30_000 });
    assert.ok(listeners.has("connection"));
    stop();
    assert.equal(cleared, created);
    assert.equal(listeners.has("connection"), false);
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }
});

test("the server pings every 30 seconds and stops the heartbeat on shutdown", () => {
  const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(source, /startWsHeartbeat\(wss, \{ intervalMs: 30_000 \}\)/);
  const shutdownAt = source.indexOf("async function shutdown");
  assert.ok(source.indexOf("stopWsHeartbeat();", shutdownAt) > shutdownAt);
});
