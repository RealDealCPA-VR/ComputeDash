/**
 * WebSocket liveness: ping every client on an interval and terminate the ones
 * that did not answer the previous ping with a pong. A phone that walked out of
 * Wi-Fi range or a laptop that went to sleep never sends a close frame, so
 * without this its socket (and its share of every broadcast) lingers until the
 * kernel gives up on TCP, which can take hours.
 *
 * @param {import("ws").WebSocketServer} wss
 * @param {{ intervalMs?: number }} [options]
 * @returns {() => void} stops the heartbeat (clears the interval)
 */
export function startWsHeartbeat(wss, { intervalMs = 30_000 } = {}) {
  /** @type {WeakMap<object, boolean>} client -> answered since the last ping */
  const alive = new WeakMap();
  const onConnection = (ws) => {
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
  };
  wss.on("connection", onConnection);
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        try {
          ws.terminate();
        } catch {
          /* already gone */
        }
        continue;
      }
      alive.set(ws, false);
      try {
        ws.ping();
      } catch {
        /* a failed ping leaves it unanswered; the next round terminates it */
      }
    }
  }, intervalMs);
  timer.unref?.();
  return function stopWsHeartbeat() {
    clearInterval(timer);
    wss.off("connection", onConnection);
  };
}
