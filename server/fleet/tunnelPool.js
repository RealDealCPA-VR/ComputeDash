import net from "node:net";
import { errorMessage } from "./adapters/base.js";

/**
 * Shared connections to unit LLM ports for the fleet manager (inventory collections and
 * operations). Without it every collection resolved each loopback-only port from scratch: a
 * direct probe that could not succeed, then a new `ssh -N -L` process, torn down a second later.
 *
 * Per unit + port the pool remembers:
 *   - a live SSH tunnel, reference counted. Consecutive collections reuse it (after a cheap
 *     liveness check of its local end); it is closed after `idleMs` without a holder, once it is
 *     older than `modeTtlMs` (then re-resolved with a direct probe), on `invalidate` /
 *     `forgetUnit`, and on `closeAll()` (manager shutdown).
 *   - how the port was last reached ("direct" / "tunnel") for `modeTtlMs`. A remembered direct
 *     port is used without a probe; a remembered tunnel-only port is re-opened with
 *     `skipDirect: true`, so the resolver can skip the direct probe that would fail.
 *   - ports that answered neither way: exponential backoff (`backoffMinMs` doubling up to
 *     `backoffMaxMs`), reset on success. While backing off, a normal acquire fails at once.
 *
 * A `fresh` acquire (an explicit refresh, an operation) ignores the remembered mode and the
 * backoff and resolves again. It still reuses a pooled tunnel that passes the liveness check:
 * an SSH forward opens a new remote connection per request, so it survives engine restarts.
 *
 * The resolver keeps llmTunnel.resolveLlmHttpTarget's shape; extra options are hints only.
 *
 * @typedef {(unit: object, port: number, opts?: { apiKey?: string|null, skipDirect?: boolean }) =>
 *   Promise<{ host: string, port: number, via?: string, close?: () => void }>} ResolveTarget
 *
 * @typedef {object} PooledHandle
 * @property {string} host
 * @property {number} port
 * @property {"direct"|"ssh-tunnel"} via
 * @property {() => void} release   idempotent
 */

/** Longer than the 60 s view-refresh period, so a tunnel survives from one background pass to the next. */
export const TUNNEL_IDLE_MS = 90_000;
export const PORT_MODE_TTL_MS = 10 * 60_000;
export const PORT_BACKOFF_MIN_MS = 5_000;
export const PORT_BACKOFF_MAX_MS = 5 * 60_000;
const ALIVE_TIMEOUT_MS = 500;

/**
 * Does the local end of a forward still accept connections? Only loopback endpoints are checked
 * (a tunnel's local side is always 127.0.0.1); anything else is assumed alive.
 * @param {{ host: string, port: number }} target
 * @returns {Promise<boolean>}
 */
export function tcpAlive(target) {
  if (target?.host !== "127.0.0.1" && target?.host !== "localhost") return Promise.resolve(true);
  return new Promise((resolve) => {
    const sock = net.connect({ host: target.host, port: target.port });
    const done = (ok) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(ALIVE_TIMEOUT_MS, () => done(false));
  });
}

const safeClose = (fn) => {
  try {
    fn?.();
  } catch {
    /* ignore */
  }
};

export class TunnelPool {
  /**
   * @param {object} opts
   * @param {ResolveTarget} opts.resolveTarget
   * @param {() => number} [opts.now]
   * @param {number} [opts.idleMs]
   * @param {number} [opts.modeTtlMs]
   * @param {number} [opts.backoffMinMs]
   * @param {number} [opts.backoffMaxMs]
   * @param {(target: { host: string, port: number }) => Promise<boolean>} [opts.isAlive]
   */
  constructor({
    resolveTarget,
    now = Date.now,
    idleMs = TUNNEL_IDLE_MS,
    modeTtlMs = PORT_MODE_TTL_MS,
    backoffMinMs = PORT_BACKOFF_MIN_MS,
    backoffMaxMs = PORT_BACKOFF_MAX_MS,
    isAlive = tcpAlive,
  }) {
    this.resolveTarget = resolveTarget;
    this.now = now;
    this.idleMs = idleMs;
    this.modeTtlMs = modeTtlMs;
    this.backoffMinMs = backoffMinMs;
    this.backoffMaxMs = backoffMaxMs;
    this.isAlive = isAlive;
    /** @type {Map<string, object>} "<unitId>:<port>" → entry */
    this.entries = new Map();
    /** @type {WeakMap<object, object>} resolved tunnel target → its record (refs, timers) */
    this.records = new WeakMap();
    this.closed = false;
  }

  _entry(key) {
    let e = this.entries.get(key);
    if (!e) {
      e = { mode: null, modeAt: 0, direct: null, tunnel: null, failures: 0, retryAt: 0, lastError: null, inflight: null };
      this.entries.set(key, e);
    }
    return e;
  }

  /**
   * @param {object} unit
   * @param {number} port
   * @param {{ apiKey?: string|null, fresh?: boolean }} [opts]
   * @returns {Promise<PooledHandle>}
   */
  async acquire(unit, port, { apiKey = null, fresh = false } = {}) {
    const key = `${unit?.id}:${port}`;
    const e = this._entry(key);
    // 1. A pooled tunnel that still accepts connections.
    const pooled = await this._liveTunnel(e);
    if (pooled) return this._hold(e, pooled);
    if (!fresh) {
      // 2. Backoff: the port answered neither directly nor through a tunnel.
      if (e.retryAt > this.now()) {
        const secs = Math.ceil((e.retryAt - this.now()) / 1000);
        throw new Error(`${e.lastError ?? `port ${port} is not reachable`} (next attempt in ${secs} s)`);
      }
      // 3. A port recently reached directly needs no probe.
      if (e.mode === "direct" && e.direct && this.now() - e.modeAt < this.modeTtlMs) {
        return { host: e.direct.host, port: e.direct.port, via: "direct", release: () => {} };
      }
    }
    // 4. Resolve. Concurrent acquires of one port share a single resolve (one tunnel).
    let mine = false;
    if (!e.inflight) {
      mine = true;
      const skipDirect = !fresh && e.mode === "tunnel" && this.now() - e.modeAt < this.modeTtlMs;
      e.inflight = this._resolve(e, unit, port, { apiKey, skipDirect }, key).finally(() => {
        e.inflight = null;
      });
    }
    const t = await e.inflight;
    if (t.via === "ssh-tunnel") {
      // Every sharer holds the tunnel record (pooled or not), so it closes after the last release.
      const rec = this.records.get(t);
      if (rec && !rec.closed) return this._hold(e, rec);
      // Invalidated / shut down before anyone held it (it is closed): resolve again.
      return this.acquire(unit, port, { apiKey, fresh });
    }
    return { host: t.host, port: t.port, via: "direct", release: mine ? onceRelease(t.close) : () => {} };
  }

  async _resolve(e, unit, port, { apiKey, skipDirect }, key) {
    let t;
    try {
      t = await this.resolveTarget(unit, port, skipDirect ? { apiKey, skipDirect: true } : { apiKey });
      if (!t || typeof t.host !== "string" || !Number.isInteger(t.port)) throw new Error("the resolver returned no endpoint");
    } catch (err) {
      e.failures += 1;
      e.retryAt = this.now() + Math.min(this.backoffMaxMs, this.backoffMinMs * 2 ** Math.min(e.failures - 1, 20));
      e.lastError = errorMessage(err);
      e.mode = null;
      e.direct = null;
      throw err;
    }
    e.failures = 0;
    e.retryAt = 0;
    e.lastError = null;
    e.modeAt = this.now();
    if (t.via === "ssh-tunnel") {
      e.mode = "tunnel";
      e.direct = null;
      const rec = { target: t, refs: 0, idleTimer: null, retired: false, closed: false, openedAt: this.now() };
      this.records.set(t, rec);
      // No pooling after shutdown, or for an entry forgotten while this resolve ran (unit changed or
      // removed): the record is born retired, so it closes when its last holder releases it.
      if (this.closed || this.entries.get(key) !== e) {
        rec.retired = true;
        return t;
      }
      this._retire(e);
      e.tunnel = rec;
    } else {
      e.mode = "direct";
      e.direct = { host: t.host, port: t.port };
    }
    return t;
  }

  async _liveTunnel(e) {
    const tun = e.tunnel;
    if (!tun || tun.retired) return null;
    // A long-lived tunnel is retired after the mode TTL, so a port that became reachable
    // directly (or an engine that moved) is noticed: the next resolve probes direct again.
    if (this.now() - tun.openedAt >= this.modeTtlMs) {
      this._retire(e);
      return null;
    }
    // The SSH process exited (network drop, remote sshd restart): its local port is free and may
    // already belong to another forward, so a TCP check alone could reach the wrong unit.
    if (typeof tun.target.isOpen === "function" && tun.target.isOpen() === false) {
      this._retire(e);
      return null;
    }
    let ok = false;
    try {
      ok = (await this.isAlive(tun.target)) === true;
    } catch {
      ok = false;
    }
    if (ok && e.tunnel === tun && !tun.retired) return tun;
    if (e.tunnel === tun) this._retire(e);
    return null;
  }

  _hold(e, tun) {
    tun.refs += 1;
    if (tun.idleTimer) {
      clearTimeout(tun.idleTimer);
      tun.idleTimer = null;
    }
    let released = false;
    return {
      host: tun.target.host,
      port: tun.target.port,
      via: "ssh-tunnel",
      release: () => {
        if (released) return;
        released = true;
        tun.refs -= 1;
        if (tun.refs > 0) return;
        if (tun.retired || this.closed) {
          this._closeTunnel(e, tun);
          return;
        }
        tun.idleTimer = setTimeout(() => this._closeTunnel(e, tun), this.idleMs);
        tun.idleTimer.unref?.();
      },
    };
  }

  _closeTunnel(e, tun) {
    if (tun.idleTimer) clearTimeout(tun.idleTimer);
    tun.idleTimer = null;
    tun.retired = true;
    if (e.tunnel === tun) e.tunnel = null;
    if (!tun.closed) {
      tun.closed = true;
      safeClose(tun.target.close);
    }
  }

  /** Stop handing out the current tunnel; it closes now, or when its last holder releases it. */
  _retire(e) {
    const tun = e.tunnel;
    if (!tun) return;
    tun.retired = true;
    e.tunnel = null;
    if (tun.refs <= 0) this._closeTunnel(e, tun);
  }

  /**
   * A collection found this endpoint not answering: forget how the port was reached and retire
   * its tunnel, so the next acquire resolves again (no backoff is recorded: the engine may be down).
   * @param {string} unitId
   * @param {number} port
   */
  invalidate(unitId, port) {
    const e = this.entries.get(`${unitId}:${port}`);
    if (!e) return;
    e.mode = null;
    e.direct = null;
    this._retire(e);
  }

  /** Forget everything about a unit (removed from the registry). */
  forgetUnit(unitId) {
    for (const [key, e] of this.entries) {
      if (!key.startsWith(`${unitId}:`)) continue;
      this._retire(e);
      this.entries.delete(key);
    }
  }

  /** Close every tunnel now (manager shutdown); later acquires are not pooled. */
  closeAll() {
    this.closed = true;
    for (const e of this.entries.values()) {
      const tun = e.tunnel;
      if (tun) this._closeTunnel(e, tun);
    }
  }

  /** For diagnostics and tests. */
  stats() {
    let open = 0;
    let held = 0;
    const backingOff = [];
    for (const [key, e] of this.entries) {
      if (e.tunnel) {
        open += 1;
        if (e.tunnel.refs > 0) held += 1;
      }
      if (e.retryAt > this.now()) backingOff.push(key);
    }
    return { open, held, backingOff };
  }
}

function onceRelease(close) {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    safeClose(close);
  };
}
