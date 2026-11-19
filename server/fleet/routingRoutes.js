// Optional smart routing routes (PRD P1, plan §4).
//
// - While settings.fleetModelsEnabled === false every route here answers 404.
// - While settings.smartRoutingEnabled is not true (the default), GET /api/fleet/routing still
//   answers { enabled: false, policy, table: [] } so the UI can show the state; every other route
//   answers 404 { code: "routing_disabled" }.
// - Routing never starts, stops, loads or switches a model: it only forwards to a target whose
//   fresh inventory shows the model serving.
// - The proxy forwards only the JSON body. The dashboard's own Authorization header (and every
//   other client header) is never sent to an engine; the engine key comes from getApiKey().
import { Readable } from "node:stream";
import { buildRouteTable, createRoundRobinState, normalizePolicy, rankTargets, DEFAULT_MAX_INVENTORY_AGE_MS } from "./routing.js";

export const UPSTREAM_HEADERS_TIMEOUT_MS = 30_000;
/**
 * A proxied response whose engine sends no bytes for this long after its headers is cut: the
 * upstream request is aborted and the client connection closed, so a stalled engine cannot hold
 * a request (and its least-loaded slot) open forever. Generous: long prefills stream nothing.
 */
export const UPSTREAM_STREAM_IDLE_TIMEOUT_MS = 120_000;
const PROXY_PATHS = ["chat/completions", "completions", "embeddings"];
/** Connection errors where the engine never received the request: safe to try the next target. */
const RETRYABLE_CONNECT_CODES = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const MAX_MODEL_NAME = 256;

/**
 * Header-safe form of a target id. encodeURI keeps ASCII ids readable ("node:a")
 * and percent-encodes the rest; lone surrogates are replaced first so encodeURI
 * cannot throw after the engine has already done the work. Exported for tests.
 * @param {unknown} targetId
 */
export function targetHeaderValue(targetId) {
  try {
    return encodeURI(String(targetId ?? "").toWellFormed());
  } catch {
    return "invalid-target-id";
  }
}

function errorCode(err) {
  return err?.cause?.code ?? err?.code ?? null;
}

function errorText(err) {
  const cause = err?.cause?.message;
  return cause ? `${err.message}: ${cause}` : String(err?.message ?? err);
}

/**
 * @param {import("express").Express} app
 * @param {{
 *   getSettings: () => object,
 *   getInventories: () => Promise<import("./inventory.js").FleetInventory[]>,
 *   getTargets: () => import("./targets.js").FleetTarget[],
 *   fetchImpl?: typeof fetch,
 *   allowProxy?: (req: import("express").Request) => boolean,
 *   rejectLimited?: (res: import("express").Response, message: string) => unknown,
 *   getApiKey?: (targetId: string, port: number|null) => string|null|undefined,
 *   headersTimeoutMs?: number,
 *   streamIdleTimeoutMs?: number,
 *   maxInventoryAgeMs?: number,
 *   now?: () => number,
 *   onProxySettled?: (info: { targetId: string|null, clientGone: boolean }) => void,
 * }} deps
 *   onProxySettled: observer called once when a proxied request has fully finished (tests, metrics).
 */
export function registerFleetRoutingRoutes(app, deps) {
  const {
    getSettings,
    getInventories,
    getTargets,
    fetchImpl = globalThis.fetch,
    allowProxy = () => true,
    rejectLimited = (res, message) => res.status(429).json({ error: message }),
    getApiKey = null,
    headersTimeoutMs = UPSTREAM_HEADERS_TIMEOUT_MS,
    streamIdleTimeoutMs = UPSTREAM_STREAM_IDLE_TIMEOUT_MS,
    maxInventoryAgeMs = DEFAULT_MAX_INVENTORY_AGE_MS,
    now = Date.now,
    onProxySettled = null,
  } = deps;
  const rrState = createRoundRobinState();
  /** Requests this proxy has open per targetId (least-loaded adds them to inventory load). */
  const inflight = new Map();
  function track(targetId) {
    inflight.set(targetId, (inflight.get(targetId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (inflight.get(targetId) ?? 1) - 1;
      if (n > 0) inflight.set(targetId, n);
      else inflight.delete(targetId);
    };
  }

  function settings() {
    try {
      return getSettings() ?? {};
    } catch {
      return {};
    }
  }
  const fleetOn = () => settings().fleetModelsEnabled !== false;
  const routingOn = () => settings().smartRoutingEnabled === true;
  const policy = () => normalizePolicy(settings().smartRoutingPolicy);

  const fleetOff = (res) => res.status(404).json({ error: "Fleet model management is disabled", code: "fleet_disabled" });
  const routingOff = (res) => res.status(404).json({ error: "Smart routing is disabled", code: "routing_disabled" });

  /** Gate: fleet on and routing on; otherwise answers and returns false. */
  function gate(res) {
    if (!fleetOn()) {
      fleetOff(res);
      return false;
    }
    if (!routingOn()) {
      routingOff(res);
      return false;
    }
    return true;
  }

  async function table() {
    const [inventories, targets] = await Promise.all([getInventories(), Promise.resolve(getTargets())]);
    return { table: buildRouteTable(inventories, targets, { now: now(), maxAgeMs: maxInventoryAgeMs }), targets };
  }

  /** The trimmed model name, or null when it is missing, blank, too long or has control characters. */
  function cleanModelName(model) {
    if (typeof model !== "string") return null;
    const m = model.trim();
    // eslint-disable-next-line no-control-regex
    return m.length > 0 && m.length <= MAX_MODEL_NAME && !/[\u0000-\u001f\u007f]/.test(m) ? m : null;
  }

  app.get("/api/fleet/routing", async (_req, res) => {
    if (!fleetOn()) return fleetOff(res);
    if (!routingOn()) return res.json({ enabled: false, policy: policy(), table: [] });
    try {
      const t = await table();
      res.json({ enabled: true, policy: policy(), table: t.table });
    } catch (err) {
      res.status(500).json({ error: `Could not build the route table: ${errorText(err)}` });
    }
  });

  app.post("/api/fleet/routing/resolve", async (req, res) => {
    if (!gate(res)) return;
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ error: "Body must be a JSON object", code: "invalid_body" });
    }
    const requested = cleanModelName(body.model);
    if (!requested) return res.status(400).json({ error: "model must be a non-empty string", code: "invalid_model" });
    try {
      const t = await table();
      // A resolve is a dry run: it must not advance the round-robin counters.
      const r = rankTargets(requested, t.table, { policy: policy(), rrState: new Map(rrState), inflight });
      const pick = r.ranked[0] ?? null;
      const target = pick ? t.targets.find((x) => x?.targetId === pick.targetId) ?? { targetId: pick.targetId } : null;
      res.json({
        target,
        targetId: pick?.targetId ?? null,
        endpoint: pick?.endpoint ?? null,
        model: r.model,
        policy: r.policy,
        load: pick ? pick.load : null,
        reason: r.reason,
      });
    } catch (err) {
      res.status(500).json({ error: `Could not resolve the model: ${errorText(err)}` });
    }
  });

  app.get("/api/fleet/v1/models", async (_req, res) => {
    if (!gate(res)) return;
    try {
      const t = await table();
      res.json({ object: "list", data: t.table.map((e) => ({ id: e.model, object: "model", owned_by: "sparkdash-fleet" })) });
    } catch (err) {
      res.status(500).json({ error: `Could not build the route table: ${errorText(err)}` });
    }
  });

  for (const sub of PROXY_PATHS) {
    app.post(`/api/fleet/v1/${sub}`, (req, res) => proxy(sub, req, res));
  }

  async function proxy(sub, req, res) {
    // Listen for the client going away BEFORE any await: a disconnect while the route table is
    // being built must stop the request from ever reaching the engine.
    const controller = new AbortController();
    let clientGone = false;
    const onClose = () => {
      if (!res.writableFinished) {
        clientGone = true;
        controller.abort();
      }
    };
    res.on("close", onClose);
    const gone = () => {
      // Not req.destroyed: a fully read request body auto-destroys the request stream.
      if (!clientGone && (res.destroyed || req.socket?.destroyed === true)) {
        clientGone = true;
        controller.abort();
      }
      return clientGone;
    };

    let chosen = null;
    let release = () => {};
    try {
      if (!gate(res)) return;
      if (!allowProxy(req)) return rejectLimited(res, "Too many routed requests; try again shortly");
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return res.status(400).json({ error: "Body must be a JSON object", code: "invalid_body" });
      }
      const requested = cleanModelName(body.model);
      if (!requested) return res.status(400).json({ error: "model must be a non-empty string", code: "invalid_model" });

      let ranked;
      let resolvedModel;
      try {
        const t = await table();
        const r = rankTargets(requested, t.table, { policy: policy(), rrState, inflight });
        ranked = r.ranked;
        resolvedModel = r.model;
        if (gone()) return;
        if (!ranked.length) return res.status(404).json({ error: r.reason, code: "model_not_served" });
      } catch (err) {
        if (gone()) return;
        return res.status(500).json({ error: `Could not build the route table: ${errorText(err)}` });
      }

      // Forward the exact id the engine serves (a case-insensitive request is normalised).
      const payload = JSON.stringify(resolvedModel && resolvedModel !== body.model ? { ...body, model: resolvedModel } : body);
      let upstream = null;
      let lastError = null;
      let timedOut = false;
      for (const cand of ranked) {
        if (gone()) return;
        const headers = { "Content-Type": "application/json", Accept: body.stream === true ? "text/event-stream" : "application/json" };
        let key = null;
        try {
          key = getApiKey ? getApiKey(cand.targetId, cand.port ?? null) : null;
        } catch {
          key = null;
        }
        if (typeof key === "string" && key) headers.Authorization = `Bearer ${key}`;
        release = track(cand.targetId);
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, headersTimeoutMs);
        try {
          upstream = await fetchImpl(`${cand.endpoint}/v1/${sub}`, { method: "POST", headers, body: payload, signal: controller.signal });
          chosen = cand;
          break;
        } catch (err) {
          release();
          lastError = err;
          if (gone() || timedOut) break;
          // Only a refused / unroutable connection is retried: the engine never saw the request.
          if (!RETRYABLE_CONNECT_CODES.has(errorCode(err))) break;
        } finally {
          clearTimeout(timer);
        }
      }

      if (gone()) return;
      if (!upstream) {
        if (timedOut) {
          return res.status(504).json({ error: `The serving engine did not answer within ${Math.round(headersTimeoutMs / 1000)} s`, code: "upstream_timeout" });
        }
        console.warn(`[fleet routing] upstream request failed: ${errorText(lastError)}`);
        return res.status(502).json({ error: "Could not reach the serving engine", code: "upstream_unreachable" });
      }

      // Only the status and content type come back: engine cookies and other headers are dropped.
      res.status(upstream.status);
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
      res.setHeader("X-Sparkdash-Target", targetHeaderValue(chosen.targetId));
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      if (!upstream.body) return void res.end();
      const source = typeof upstream.body.getReader === "function" ? Readable.fromWeb(upstream.body) : Readable.from(upstream.body);
      // Idle watchdog on the engine side only: paused while waiting for a slow client to drain.
      let idleTimer = null;
      let stalled = false;
      const disarm = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = null;
      };
      const arm = () => {
        disarm();
        if (!(streamIdleTimeoutMs > 0)) return;
        idleTimer = setTimeout(() => {
          stalled = true;
          controller.abort();
          source.destroy(new Error("upstream stalled"));
        }, streamIdleTimeoutMs);
        idleTimer.unref?.();
      };
      try {
        arm();
        for await (const chunk of source) {
          disarm();
          if (gone()) break;
          if (!res.write(chunk)) await drained(res);
          arm();
        }
        disarm();
        if (!gone()) res.end();
      } catch {
        // Bytes were already sent: no retry and no JSON error; cut the response so the client sees it.
        disarm();
        if (stalled) console.warn(`[fleet routing] upstream sent nothing for ${Math.round(streamIdleTimeoutMs / 1000)} s; response cut`);
        controller.abort();
        if (!res.destroyed) res.destroy();
      } finally {
        disarm();
        source.destroy();
      }
    } catch (err) {
      // Anything unexpected: never leave the engine request or the client response open.
      controller.abort();
      console.warn(`[fleet routing] proxy failed: ${errorText(err)}`);
      if (!res.headersSent && !gone()) res.status(500).json({ error: "Routed request failed", code: "proxy_error" });
      else if (!res.destroyed) res.destroy();
    } finally {
      release();
      res.off("close", onClose);
      if (onProxySettled) {
        try {
          onProxySettled({ targetId: chosen?.targetId ?? null, clientGone });
        } catch {
          /* observer only */
        }
      }
    }
  }
}

/** Resolve when the response can take more data, or immediately once it is gone. */
function drained(res) {
  if (res.destroyed || res.writableEnded) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      res.off("error", done);
      resolve();
    };
    res.on("drain", done);
    res.on("close", done);
    res.on("error", done);
  });
}
