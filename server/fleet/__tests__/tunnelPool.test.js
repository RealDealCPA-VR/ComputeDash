import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { TunnelPool, tcpAlive } from "../tunnelPool.js";

const UNIT = { id: "spark1", lanIp: "10.0.0.1" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A resolver that answers like resolveLlmHttpTarget: `mode` "tunnel", "direct" or "dead". */
function fakeResolver(initial = "tunnel") {
  const state = { mode: initial, calls: [], opened: 0, closed: 0, nextPort: 40000 };
  const resolveTarget = async (unit, port, opts = {}) => {
    state.calls.push({ unitId: unit.id, port, opts: { ...opts } });
    if (state.mode === "dead") throw new Error(`LLM on ${unit.lanIp}:${port} is not reachable over the LAN, and SSH tunnel failed`);
    if (state.mode === "direct") return { host: unit.lanIp, port, via: "direct", close: () => {} };
    state.opened += 1;
    let closed = false;
    return {
      host: "127.0.0.1",
      port: state.nextPort++,
      via: "ssh-tunnel",
      close: () => {
        if (closed) return;
        closed = true;
        state.closed += 1;
      },
    };
  };
  return { state, resolveTarget };
}

test("consecutive acquires reuse one tunnel; the idle TTL closes it; a reopen skips the direct probe", async () => {
  const { state, resolveTarget } = fakeResolver("tunnel");
  const pool = new TunnelPool({ resolveTarget, idleMs: 40, isAlive: async () => true });
  const a = await pool.acquire(UNIT, 8000, { apiKey: "k" });
  assert.equal(a.via, "ssh-tunnel");
  a.release();
  const b = await pool.acquire(UNIT, 8000);
  assert.equal(b.port, a.port, "the same local forward");
  // Two holders at once share it too.
  const c = await pool.acquire(UNIT, 8000);
  assert.equal(c.port, a.port);
  assert.equal(state.opened, 1, "one SSH process for three acquires");
  b.release();
  c.release();
  c.release(); // idempotent
  assert.equal(state.closed, 0, "kept open while idle for less than the TTL");
  assert.deepEqual(pool.stats(), { open: 1, held: 0, backingOff: [] });
  await sleep(80);
  assert.equal(state.closed, 1, "closed after the idle TTL");
  assert.equal(pool.stats().open, 0);
  assert.equal(state.calls[0].opts.skipDirect, undefined, "the first resolve probes direct");
  const d = await pool.acquire(UNIT, 8000);
  assert.equal(state.opened, 2);
  assert.equal(state.calls[1].opts.skipDirect, true, "a known tunnel-only port skips the doomed direct probe");
  d.release();
  pool.closeAll();
  assert.equal(state.closed, 2);
});

test("a held tunnel is not closed by the idle timer; release starts it again", async () => {
  const { state, resolveTarget } = fakeResolver("tunnel");
  const pool = new TunnelPool({ resolveTarget, idleMs: 30, isAlive: async () => true });
  const a = await pool.acquire(UNIT, 8000);
  a.release();
  const b = await pool.acquire(UNIT, 8000); // cancels the idle timer
  await sleep(60);
  assert.equal(state.closed, 0);
  b.release();
  await sleep(60);
  assert.equal(state.closed, 1);
});

test("concurrent acquires of one port share a single resolve", async () => {
  const { state, resolveTarget } = fakeResolver("tunnel");
  const pool = new TunnelPool({ resolveTarget, isAlive: async () => true });
  const [a, b] = await Promise.all([pool.acquire(UNIT, 8000), pool.acquire(UNIT, 8000)]);
  assert.equal(state.calls.length, 1);
  assert.equal(a.port, b.port);
  a.release();
  b.release();
  pool.closeAll();
  assert.equal(state.closed, 1);
});

test("a dead port backs off exponentially (capped), fresh bypasses it, success resets it", async () => {
  let t = 1_000_000;
  const { state, resolveTarget } = fakeResolver("dead");
  const pool = new TunnelPool({ resolveTarget, now: () => t, backoffMinMs: 1000, backoffMaxMs: 4000, isAlive: async () => true });
  await assert.rejects(pool.acquire(UNIT, 8000), /not reachable/);
  assert.equal(state.calls.length, 1);
  await assert.rejects(pool.acquire(UNIT, 8000), /next attempt in 1 s/);
  assert.equal(state.calls.length, 1, "no resolve (no probe, no SSH) while backing off");
  assert.deepEqual(pool.stats().backingOff, ["spark1:8000"]);
  t += 1000;
  await assert.rejects(pool.acquire(UNIT, 8000));
  assert.equal(state.calls.length, 2);
  t += 1999;
  await assert.rejects(pool.acquire(UNIT, 8000), /next attempt in 1 s/);
  assert.equal(state.calls.length, 2, "second failure: 2 s window");
  t += 1;
  await assert.rejects(pool.acquire(UNIT, 8000));
  t += 4000;
  await assert.rejects(pool.acquire(UNIT, 8000)); // 4th failure: 8 s, capped at 4 s
  assert.equal(state.calls.length, 4);
  t += 3999;
  await assert.rejects(pool.acquire(UNIT, 8000), /next attempt/);
  t += 1;
  await assert.rejects(pool.acquire(UNIT, 8000));
  assert.equal(state.calls.length, 5, "the cap holds");
  // An operation (fresh) checks anyway.
  await assert.rejects(pool.acquire(UNIT, 8000, { fresh: true }));
  assert.equal(state.calls.length, 6);
  state.mode = "direct";
  const h = await pool.acquire(UNIT, 8000, { fresh: true });
  assert.equal(h.via, "direct");
  assert.deepEqual(pool.stats().backingOff, [], "success resets the backoff");
  // Other ports are unaffected by one port's backoff.
  await pool.acquire(UNIT, 8001);
});

test("a port reached directly is remembered (no probe) until the TTL, an invalidate or a fresh acquire", async () => {
  let t = 0;
  const { state, resolveTarget } = fakeResolver("direct");
  const pool = new TunnelPool({ resolveTarget, now: () => t, modeTtlMs: 10_000 });
  const a = await pool.acquire(UNIT, 11434);
  assert.deepEqual([a.host, a.port, a.via], ["10.0.0.1", 11434, "direct"]);
  await pool.acquire(UNIT, 11434);
  assert.equal(state.calls.length, 1);
  await pool.acquire(UNIT, 11434, { fresh: true });
  assert.equal(state.calls.length, 2, "fresh re-checks");
  pool.invalidate("spark1", 11434);
  await pool.acquire(UNIT, 11434);
  assert.equal(state.calls.length, 3, "an invalidated port is resolved again");
  t += 10_000;
  await pool.acquire(UNIT, 11434);
  assert.equal(state.calls.length, 4, "the memory expires");
});

test("a pooled tunnel whose local end no longer accepts connections is replaced", async () => {
  const { state, resolveTarget } = fakeResolver("tunnel");
  let alive = true;
  const pool = new TunnelPool({ resolveTarget, isAlive: async () => alive });
  const a = await pool.acquire(UNIT, 8000);
  a.release();
  alive = false;
  const b = await pool.acquire(UNIT, 8000);
  assert.notEqual(b.port, a.port);
  assert.equal(state.opened, 2);
  assert.equal(state.closed, 1, "the dead tunnel is closed");
  b.release();
  pool.closeAll();
});

test("closeAll closes held and idle tunnels; later acquires are not pooled", async () => {
  const { state, resolveTarget } = fakeResolver("tunnel");
  const pool = new TunnelPool({ resolveTarget, isAlive: async () => true });
  const held = await pool.acquire(UNIT, 8000);
  const idle = await pool.acquire(UNIT, 8001);
  idle.release();
  pool.closeAll();
  assert.equal(state.closed, 2);
  held.release();
  const after = await pool.acquire(UNIT, 8000);
  assert.equal(state.opened, 3);
  after.release();
  assert.equal(state.closed, 3, "closed on release once the pool is shut");
});

test("forgetUnit retires a unit's tunnels (closed once released)", async () => {
  const { state, resolveTarget } = fakeResolver("tunnel");
  const pool = new TunnelPool({ resolveTarget, isAlive: async () => true });
  const h = await pool.acquire(UNIT, 8000);
  pool.forgetUnit("spark1");
  assert.equal(state.closed, 0, "still held");
  h.release();
  assert.equal(state.closed, 1);
});

test("tcpAlive: a listening loopback port is alive, a closed one is not, a LAN host is not checked", async () => {
  const server = net.createServer((s) => s.destroy());
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  assert.equal(await tcpAlive({ host: "127.0.0.1", port }), true);
  await new Promise((r) => server.close(r));
  assert.equal(await tcpAlive({ host: "127.0.0.1", port }), false);
  assert.equal(await tcpAlive({ host: "10.0.0.1", port: 1 }), true);
});

test("a tunnel older than the mode TTL is retired and the port probed directly again", async () => {
  let t = 0;
  const { state, resolveTarget } = fakeResolver("tunnel");
  const pool = new TunnelPool({ resolveTarget, now: () => t, modeTtlMs: 10_000, isAlive: async () => true });
  const a = await pool.acquire(UNIT, 8000);
  a.release();
  t += 9_999;
  (await pool.acquire(UNIT, 8000)).release();
  assert.equal(state.opened, 1);
  t += 1;
  state.mode = "direct";
  const b = await pool.acquire(UNIT, 8000);
  assert.equal(b.via, "direct", "the engine became reachable on the LAN");
  assert.equal(state.calls[1].opts.skipDirect, undefined, "probed direct again");
  assert.equal(state.closed, 1, "the old tunnel is closed");
});

test("a pooled tunnel whose ssh process exited is not reused even if its local port answers", async () => {
  const { state, resolveTarget } = fakeResolver("tunnel");
  let open = true;
  const pool = new TunnelPool({
    resolveTarget: async (...args) => ({ ...(await resolveTarget(...args)), isOpen: () => open }),
    isAlive: async () => true, // another forward now owns the port
  });
  const a = await pool.acquire(UNIT, 8000);
  a.release();
  open = false;
  const b = await pool.acquire(UNIT, 8000);
  assert.notEqual(b.port, a.port);
  assert.equal(state.opened, 2);
  b.release();
  pool.closeAll();
});

test("sharers of an unpooled tunnel (unit forgotten mid-resolve) each hold it; the last release closes it", async () => {
  let release;
  const { state, resolveTarget } = fakeResolver("tunnel");
  const gate = new Promise((r) => (release = r));
  const pool = new TunnelPool({ resolveTarget: async (...args) => (await gate, resolveTarget(...args)), isAlive: async () => true });
  const pa = pool.acquire(UNIT, 8000);
  const pb = pool.acquire(UNIT, 8000);
  await sleep(0);
  pool.forgetUnit("spark1"); // the unit's SSH settings changed while the tunnel was opening
  release();
  const [a, b] = await Promise.all([pa, pb]);
  assert.equal(a.port, b.port);
  assert.equal(pool.stats().open, 0, "not pooled under the forgotten entry");
  a.release();
  assert.equal(state.closed, 0, "the other sharer still uses it");
  b.release();
  assert.equal(state.closed, 1);
  (await pool.acquire(UNIT, 8000)).release();
  assert.equal(state.opened, 2, "the next acquire opens a tunnel for the new settings");
  pool.closeAll();
});

test("a tunnel invalidated before any sharer held it is resolved again, not handed out closed", async () => {
  const { state, resolveTarget } = fakeResolver("tunnel");
  let pool;
  pool = new TunnelPool({
    resolveTarget: async (...args) => {
      const t = await resolveTarget(...args);
      if (state.opened === 1) queueMicrotask(() => queueMicrotask(() => pool.invalidate("spark1", 8000)));
      return t;
    },
    isAlive: async () => true,
  });
  const h = await pool.acquire(UNIT, 8000);
  assert.equal(state.opened, 2, "the first tunnel was closed before it was held: a second one is opened");
  assert.equal(state.closed, 1, "only the live one is open");
  assert.equal(h.via, "ssh-tunnel");
  h.release();
  pool.closeAll();
  assert.equal(state.closed, state.opened);
});
