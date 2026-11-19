import { listAdapters } from "./adapters/index.js";
import { isValidModelId, parseModelKey } from "./modelStates.js";
import { OPERATION_ACTIONS, OPERATION_ID_RE } from "./operations.js";
import { CLUSTER_ID_RE } from "./clusterStore.js";
import { configuredToken } from "../auth.js";

export const TOKEN_REQUIRED_ERROR = "Fleet model control requires a dashboard access token. Set SPARKDASH_TOKEN and restart.";
let warnedNoToken = false;

/**
 * Fleet Model Manager HTTP API (plan §4), except the P1 routing routes.
 *
 * - Auth is the dashboard's global middleware (bearer token on every mutating request and on
 *   remote reads); nothing here adds a parallel scheme. On top of it, fleet CONTROL routes
 *   (operations, cancel, cluster changes) refuse with 403 token_required while no dashboard
 *   token is configured (PRD §2: node control is authenticated, even inside the tailnet; behind
 *   Tailscale Serve every device arrives via loopback). SPARKDASH_FLEET_ALLOW_NO_TOKEN=1 opts
 *   out, for a single-user loopback-only box.
 * - While settings.fleetModelsEnabled is false every /api/fleet/* route answers 404, except
 *   GET /api/fleet/status.
 * - Mutating routes are rate limited through `allowChange` (cancel through `allowCancel`), reads
 *   through `allowRead`. Validation runs first, so a 400 never spends a token.
 * - Reading and cancelling an existing operation stay available while the feature is off, so an
 *   operation that is still running remains observable and cancellable.
 * - Every id and body is validated before it reaches the manager; a model key only reaches an
 *   adapter after the operation finds it in the target's fresh catalog.
 */

const TARGET_ID_RE = /^(node|cluster):[A-Za-z0-9._-]{1,64}$/;
const ENGINE_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const SLOT_RE = /^(?:\d{1,5}|launcher:[a-z0-9][a-z0-9-]{0,47}|mac:[^|]{1,64})?$/; // the mac agent allows any runtime name up to 64 characters
const OPERATION_KEYS = new Set(["action", "modelKey", "force", "rollback"]);
const CLUSTER_KEYS = new Set(["id", "name", "kind", "memberIds", "headId", "endpoint", "engine", "launcherId", "notes"]);

/**
 * Strict model key check: "<engine>|<port|launcher:<id>|mac:<runtime>>|<modelId>" with a model id
 * that passes MODEL_ID_RE.
 * @param {unknown} key
 */
export function isValidModelKey(key) {
  if (typeof key !== "string" || key.length > 300 || /[\u0000-\u001f\u007f]/.test(key)) return false;
  const p = parseModelKey(key);
  if (!p || !ENGINE_RE.test(p.engine) || !SLOT_RE.test(p.slot)) return false;
  if (/^\d+$/.test(p.slot) && p.port == null) return false;
  return isValidModelId(p.modelId);
}

/** @param {unknown} v */
const isPlainObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);

/**
 * @param {import("express").Express} app
 * @param {object} deps
 * @param {import("./FleetModelManager.js").FleetModelManager} deps.manager
 * @param {() => object} deps.getSettings
 * @param {(req: object) => boolean} [deps.allowRead]
 * @param {(req: object) => boolean} [deps.allowChange]
 * @param {(req: object) => boolean} [deps.allowCancel]  defaults to allowChange
 * @param {() => boolean} [deps.hasToken]     a dashboard token is configured (default: configuredToken())
 * @param {boolean} [deps.requireToken]       control needs a token (default: SPARKDASH_FLEET_ALLOW_NO_TOKEN !== "1")
 * @param {(res: object, message: string) => unknown} [deps.rejectLimited]
 */
export function registerFleetRoutes(app, {
  manager,
  getSettings,
  allowRead = () => true,
  allowChange = () => true,
  allowCancel,
  rejectLimited,
  hasToken,
  requireToken,
}) {
  const cancelAllowed = typeof allowCancel === "function" ? allowCancel : allowChange;
  const tokenConfigured = () => {
    try {
      return typeof hasToken === "function" ? hasToken() === true : Boolean(configuredToken());
    } catch {
      return false;
    }
  };
  const controlRequiresToken = typeof requireToken === "boolean" ? requireToken : process.env.SPARKDASH_FLEET_ALLOW_NO_TOKEN !== "1";
  if (!controlRequiresToken && !tokenConfigured() && !warnedNoToken) {
    warnedNoToken = true;
    console.warn("[fleet] SPARKDASH_FLEET_ALLOW_NO_TOKEN=1: fleet model control is allowed without a dashboard token. Use this only on a single-user, loopback-only host.");
  }
  const limited = typeof rejectLimited === "function" ? rejectLimited : (res, msg) => res.status(429).json({ error: msg });
  const settings = () => {
    try {
      return getSettings?.() ?? {};
    } catch {
      return {};
    }
  };
  const enabled = () => settings().fleetModelsEnabled !== false;
  const fail = (res, status, error, code) => res.status(status).json(code ? { error, code } : { error });

  // Every /api/fleet/* route but the status answers 404 while the feature is off (this also
  // covers routes other modules mount under /api/fleet later).
  app.use("/api/fleet", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (req.method === "GET" && req.path === "/status") return next();
    // An operation started before the feature was turned off can still be watched and cancelled.
    if ((req.method === "GET" || req.method === "DELETE") && /^\/operations\/[^/]+$/.test(req.path)) return next();
    if (!enabled()) return fail(res, 404, "Fleet model management is turned off", "disabled");
    next();
  });

  const read = (req, res, next) => {
    if (!allowRead(req)) return limited(res, "Too many fleet requests; try again shortly");
    next();
  };
  /** Control routes: a dashboard token must be configured (unless explicitly opted out). */
  const control = (_req, res, next) => {
    if (controlRequiresToken && !tokenConfigured()) return fail(res, 403, TOKEN_REQUIRED_ERROR, "token_required");
    next();
  };
  /** Spend a change token; call only after validation passed. @returns {boolean} */
  const spendChange = (req, res) => {
    if (allowChange(req)) return true;
    limited(res, "Too many fleet changes; try again shortly");
    return false;
  };
  const targetParam = (req, res, next) => {
    if (!TARGET_ID_RE.test(req.params.targetId)) return fail(res, 400, "Invalid target id", "validation");
    if (!manager.hasTarget(req.params.targetId)) return fail(res, 404, "Target not found", "unknown_target");
    next();
  };
  const opParam = (req, res, next) => {
    if (!OPERATION_ID_RE.test(req.params.opId)) return fail(res, 400, "Invalid operation id", "validation");
    next();
  };
  const clusterParam = (req, res, next) => {
    if (!CLUSTER_ID_RE.test(req.params.id)) return fail(res, 400, "Invalid cluster id", "validation");
    next();
  };
  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.error("[fleet] route error:", err?.message ?? err);
      if (!res.headersSent) fail(res, 500, "Fleet request failed", "internal");
    }
  };

  app.get("/api/fleet/status", (_req, res) => {
    const s = settings();
    res.set("Cache-Control", "no-store");
    res.json({
      enabled: s.fleetModelsEnabled !== false,
      smartRoutingEnabled: s.smartRoutingEnabled === true,
      adapters: listAdapters(),
      controlRequiresToken,
      tokenConfigured: tokenConfigured(),
    });
  });

  app.get("/api/fleet/targets", read, wrap(async (_req, res) => {
    res.json(manager.targets());
  }));

  app.get("/api/fleet/targets/:targetId/inventory", read, targetParam, wrap(async (req, res) => {
    const q = req.query.refresh;
    if (q !== undefined && q !== "1" && q !== "0" && q !== "true" && q !== "false") {
      return fail(res, 400, "refresh must be 1 or 0", "validation");
    }
    const inv = await manager.inventory(req.params.targetId, { refresh: q === "1" || q === "true" });
    if (!inv) return fail(res, 404, "Target not found", "unknown_target");
    res.json(inv);
  }));

  app.post("/api/fleet/targets/:targetId/operations", control, targetParam, wrap(async (req, res) => {
    const body = req.body;
    if (!isPlainObject(body)) return fail(res, 400, "Body must be a JSON object", "validation");
    const extra = Object.keys(body).filter((k) => !OPERATION_KEYS.has(k));
    if (extra.length) return fail(res, 400, `Unknown field: ${extra[0].slice(0, 40)}`, "validation");
    if (!OPERATION_ACTIONS.includes(body.action)) return fail(res, 400, "action must be start, stop, reload or switch", "validation");
    if (!isValidModelKey(body.modelKey)) return fail(res, 400, "modelKey is not a valid model key", "validation");
    for (const k of ["force", "rollback"]) {
      if (body[k] !== undefined && typeof body[k] !== "boolean") return fail(res, 400, `${k} must be true or false`, "validation");
    }
    if (!spendChange(req, res)) return;
    const result = manager.startOperation(req.params.targetId, {
      action: body.action,
      modelKey: body.modelKey,
      force: body.force === true,
      rollback: body.rollback !== false,
    });
    if (!result.ok) return fail(res, result.status, result.error, result.code);
    res.status(202).json({ operation: result.operation });
  }));

  app.get("/api/fleet/operations/:opId", read, opParam, wrap(async (req, res) => {
    let since = 0;
    if (req.query.since !== undefined) {
      const raw = req.query.since;
      if (typeof raw !== "string" || !/^\d{1,9}$/.test(raw)) return fail(res, 400, "since must be a non-negative integer", "validation");
      since = Number(raw);
    }
    const out = manager.readOperation(req.params.opId, since);
    if (!out) return fail(res, 404, "Operation not found", "unknown_operation");
    res.json(out);
  }));

  app.delete("/api/fleet/operations/:opId", control, opParam, wrap(async (req, res) => {
    if (!cancelAllowed(req)) return limited(res, "Too many cancel requests; try again shortly");
    const out = manager.cancelOperation(req.params.opId);
    if (!out) return fail(res, 404, "Operation not found", "unknown_operation");
    res.json(out.cancelled === true ? { cancelled: true } : { cancelled: false, ...(out.reason ? { reason: out.reason } : {}) });
  }));

  app.get("/api/fleet/targets/:targetId/logs", read, targetParam, wrap(async (req, res) => {
    const mk = req.query.modelKey;
    if (mk !== undefined && mk !== "" && !isValidModelKey(mk)) return fail(res, 400, "modelKey is not a valid model key", "validation");
    const out = await manager.logs(req.params.targetId, mk || null);
    if (!out) return fail(res, 404, "Target not found", "unknown_target");
    res.json(out);
  }));

  // ─── clusters ──────────────────────────────────────────────────────────────

  /** A distributed cluster's launcher must exist on its head unit. */
  const launcherProblem = (cluster) => {
    if (cluster.kind !== "distributed" || cluster.launcherId == null || cluster.launcherId === "") return null;
    if (typeof cluster.launcherId !== "string" || typeof cluster.headId !== "string") return null; // the store rejects the shape
    return manager.launcherExists(cluster.headId, cluster.launcherId)
      ? null
      : `Launch profile ${cluster.launcherId.slice(0, 48)} does not exist on ${cluster.headId.slice(0, 64)}`;
  };
  const clusterBody = (req, res) => {
    const body = req.body;
    if (!isPlainObject(body)) {
      fail(res, 400, "Body must be a JSON object", "validation");
      return null;
    }
    const extra = Object.keys(body).filter((k) => !CLUSTER_KEYS.has(k));
    if (extra.length) {
      fail(res, 400, `Unknown field: ${extra[0].slice(0, 40)}`, "validation");
      return null;
    }
    return body;
  };
  const storeStatus = (code) => (code === "not_found" ? 404 : code === "conflict" ? 409 : 400);

  app.get("/api/fleet/clusters", read, wrap(async (_req, res) => {
    res.json(manager.listClusters());
  }));

  app.post("/api/fleet/clusters", control, wrap(async (req, res) => {
    const body = clusterBody(req, res);
    if (!body) return;
    const problem = launcherProblem(body);
    if (problem) return fail(res, 400, problem, "validation");
    if (!spendChange(req, res)) return;
    const result = manager.createCluster(body);
    if (!result.ok) return fail(res, storeStatus(result.code), result.error, result.code);
    res.status(201).json({ cluster: result.cluster });
  }));

  app.put("/api/fleet/clusters/:id", control, clusterParam, wrap(async (req, res) => {
    const body = clusterBody(req, res);
    if (!body) return;
    const existing = manager.getCluster(req.params.id);
    if (!existing) return fail(res, 404, "Cluster not found", "not_found");
    if (manager.isBusy(`cluster:${req.params.id}`)) return fail(res, 409, "An operation is running on this cluster", "busy");
    const problem = launcherProblem({ ...existing, ...body });
    if (problem) return fail(res, 400, problem, "validation");
    if (!spendChange(req, res)) return;
    const result = manager.updateCluster(req.params.id, body);
    if (!result.ok) return fail(res, storeStatus(result.code), result.error, result.code);
    res.json({ cluster: result.cluster });
  }));

  app.delete("/api/fleet/clusters/:id", control, clusterParam, wrap(async (req, res) => {
    if (!manager.getCluster(req.params.id)) return fail(res, 404, "Cluster not found", "not_found");
    if (manager.isBusy(`cluster:${req.params.id}`)) return fail(res, 409, "An operation is running on this cluster", "busy");
    if (!spendChange(req, res)) return;
    if (!manager.removeCluster(req.params.id)) return fail(res, 404, "Cluster not found", "not_found");
    res.json({ removed: true });
  }));
}
