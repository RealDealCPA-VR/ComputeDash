import { isValidModelId } from "../modelStates.js";

/**
 * Engine adapter contract (plan §3). An adapter only calls fixed URL paths and fixed CLI
 * templates; every network or exec call goes through `ctx`, so tests inject fakes.
 *
 * @typedef {object} AdapterCapabilities
 * @property {boolean} discover
 * @property {boolean} start
 * @property {boolean} stop
 * @property {boolean} load
 * @property {boolean} unload
 * @property {boolean} logs
 * @property {boolean} multiModel
 *
 * @typedef {object} AdapterContext
 * @property {object} [unit]        registry unit (full config when exec / profiles need it)
 * @property {string} [baseUrl]     e.g. "http://10.0.0.5:8000" (no trailing slash)
 * @property {number|null} [port]
 * @property {typeof fetch} [fetchImpl]
 * @property {number} [timeoutMs]        discovery request timeout
 * @property {number} [actionTimeoutMs]  load / unload / CLI timeout
 * @property {string|null} [apiKey]
 * @property {((cmd: string) => Promise<string>)|null} [exec]  fixed-template exec on the unit (SSH)
 * @property {string[]} [catalog]   model ids discovered on this runtime (validation for load/unload)
 *
 * @typedef {object} DiscoveredModel
 * @property {string} modelId
 * @property {string} [label]
 * @property {boolean} [installed]   on disk / in the engine catalog
 * @property {boolean} [loaded]      in memory
 * @property {boolean} [listed]      listed by the serving API
 * @property {boolean|null} [ready]  per-model readiness; falls back to the result's `ready`
 * @property {boolean} [hasProfile]
 * @property {boolean|null} [processRunning]
 * @property {"start"|"stop"|null} [operation]  profile job in flight
 * @property {boolean} [lastOperationFailed]
 * @property {number|null} [lastFailureAt]
 * @property {string|null} [lastError]
 * @property {string|null} [quantization]
 * @property {number|null} [contextLength]
 * @property {number|null} [sizeBytes]
 * @property {number|null} [estMemoryBytes]
 * @property {number|null} [port]
 * @property {string|null} [launcherId]
 * @property {string|null} [macRuntime]
 * @property {string|null} [type]
 * @property {string[]} sources       "api" | "ps" | "catalog" | "launcher" | "mac-profile" | "disk"
 *
 * @typedef {object} DiscoveryResult
 * @property {boolean|null} reachable  true: at least one source answered; false: none did
 * @property {boolean|null} ready      runtime readiness / health check
 * @property {DiscoveredModel[]} models
 * @property {string[]} errors         verbatim per-source failures
 * @property {boolean} [loadedKnown]   multi-model engines: false when the loaded list could not be read
 *
 * @typedef {{ ok: true, detail?: string|null, job?: object, operation?: object } | { ok: false, error: string, unsupported?: boolean }} ActionResult
 *
 * @typedef {object} FleetAdapter
 * @property {string} engine
 * @property {string} label
 * @property {AdapterCapabilities} capabilities         static capabilities
 * @property {(ctx: AdapterContext) => AdapterCapabilities} [capabilitiesFor]  per-unit capabilities
 * @property {(ctx: AdapterContext) => Promise<DiscoveryResult>} discover
 * @property {(ctx: AdapterContext, modelId: string) => Promise<ActionResult>} [load]
 * @property {(ctx: AdapterContext, modelId: string) => Promise<ActionResult>} [unload]
 * @property {(ctx: AdapterContext, model: object) => Promise<ActionResult>} [start]
 * @property {(ctx: AdapterContext, model: object) => Promise<ActionResult>} [stop]
 * @property {(ctx: AdapterContext, model: object, since?: number) => Promise<object>} [logs]
 */

export const CAPABILITY_KEYS = Object.freeze(["discover", "start", "stop", "load", "unload", "logs", "multiModel"]);

/**
 * Complete capability object; anything not given is false.
 * @param {Partial<AdapterCapabilities>} [partial]
 * @returns {AdapterCapabilities}
 */
export function makeCapabilities(partial = {}) {
  /** @type {any} */
  const out = {};
  for (const k of CAPABILITY_KEYS) out[k] = partial?.[k] === true;
  return out;
}

export const NO_CAPABILITIES = Object.freeze(makeCapabilities());

/** Union of capability objects. */
export function mergeCapabilities(...caps) {
  /** @type {any} */
  const out = {};
  for (const k of CAPABILITY_KEYS) out[k] = caps.some((c) => c?.[k] === true);
  return out;
}

/** Can this runtime bring a model up / take it down at all? */
export const canStartModels = (c) => Boolean(c?.start || c?.load);
export const canStopModels = (c) => Boolean(c?.stop || c?.unload);

/** Capabilities an adapter has for this context (per-unit override, else static). */
export function capabilitiesFor(adapter, ctx = {}) {
  if (!adapter) return NO_CAPABILITIES;
  try {
    if (typeof adapter.capabilitiesFor === "function") return makeCapabilities(adapter.capabilitiesFor(ctx));
  } catch {
    /* fall through to static */
  }
  return makeCapabilities(adapter.capabilities);
}

/**
 * Base URL for host:port, bracketing IPv6 literals.
 * @param {string} host
 * @param {number} port
 * @param {"http"|"https"} [scheme]
 */
export function baseUrlFor(host, port, scheme = "http") {
  const h = String(host ?? "").trim();
  if (!h) throw new Error("no LLM host configured for this unit");
  const bracketed = h.includes(":") && !h.startsWith("[") ? `[${h}]` : h;
  return `${scheme}://${bracketed}:${port}`;
}

export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 5000;

/** HTTP / transport error from fetchJson; `status` is the HTTP status when there was one. */
export class FetchJsonError extends Error {
  /** @param {string} message @param {{ status?: number|null, code?: string }} [info] */
  constructor(message, { status = null, code = "error" } = {}) {
    super(message);
    this.name = "FetchJsonError";
    this.status = status;
    this.code = code;
  }
}

async function readBodyBounded(res, maxBytes, label) {
  const len = Number(res.headers?.get?.("content-length"));
  if (Number.isFinite(len) && len > maxBytes) {
    throw new FetchJsonError(`${label}: response is larger than ${maxBytes} bytes`, { status: res.status, code: "too_large" });
  }
  const reader = res.body && typeof res.body.getReader === "function" ? res.body.getReader() : null;
  if (reader) {
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        throw new FetchJsonError(`${label}: response is larger than ${maxBytes} bytes`, { status: res.status, code: "too_large" });
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
  }
  if (typeof res.text === "function") {
    const text = String(await res.text());
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new FetchJsonError(`${label}: response is larger than ${maxBytes} bytes`, { status: res.status, code: "too_large" });
    }
    return text;
  }
  return "";
}

/**
 * Bounded JSON fetch: timeout via AbortController (covering the body read), size cap, and
 * every failure (transport, HTTP status, oversize, invalid JSON) surfaced as a FetchJsonError
 * whose message names the method and URL.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {"GET"|"POST"} [opts.method]
 * @param {unknown} [opts.body]          JSON-serialized when given
 * @param {string|null} [opts.apiKey]    sent as a bearer token
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.maxBytes]
 * @param {boolean} [opts.allowEmpty]    an empty 2xx body resolves to null instead of failing
 * @returns {Promise<any>}
 */
export async function fetchJson(url, opts = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    method = "GET",
    body,
    apiKey = null,
    fetchImpl = globalThis.fetch,
    maxBytes = MAX_RESPONSE_BYTES,
    allowEmpty = false,
  } = opts;
  const label = `${method} ${url}`;
  if (typeof fetchImpl !== "function") throw new FetchJsonError(`${label}: no fetch implementation`);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, timeoutMs));
  /** @type {Record<string,string>} */
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  // Rejects on timeout, so a fetch / body read that ignores the signal still ends on time.
  const aborted = new Promise((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  aborted.catch(() => {});
  try {
    let res;
    try {
      res = await Promise.race([
        fetchImpl(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
          // Adapters call fixed URLs only; a redirect could point anywhere.
          redirect: "error",
        }),
        aborted,
      ]);
    } catch (err) {
      if (timedOut) throw new FetchJsonError(`${label}: timed out after ${timeoutMs} ms`, { code: "timeout" });
      const cause = err?.cause?.code || err?.cause?.message;
      throw new FetchJsonError(`${label}: ${err?.message || "request failed"}${cause ? ` (${cause})` : ""}`, {
        code: "network",
      });
    }
    let text;
    try {
      const reading = readBodyBounded(res, maxBytes, label);
      reading.catch(() => {});
      text = await Promise.race([reading, aborted]);
    } catch (err) {
      if (err instanceof FetchJsonError) throw err;
      if (timedOut) throw new FetchJsonError(`${label}: timed out after ${timeoutMs} ms`, { code: "timeout" });
      throw new FetchJsonError(`${label}: ${err?.message || "could not read response"}`, { status: res?.status ?? null });
    }
    const status = Number(res?.status) || 0;
    if (!res?.ok) {
      const snippet = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
      throw new FetchJsonError(`${label}: HTTP ${status}${snippet ? ` ${snippet}` : ""}`, { status, code: "http" });
    }
    if (!String(text ?? "").trim()) {
      if (allowEmpty) return null;
      throw new FetchJsonError(`${label}: empty response`, { status, code: "parse" });
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new FetchJsonError(`${label}: invalid JSON (${err.message})`, { status, code: "parse" });
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Short message for a caught error (verbatim message, never a stack). */
export function errorMessage(err) {
  return err?.message ? String(err.message) : String(err ?? "unknown error");
}

/**
 * Validate a model id before it reaches an HTTP body or CLI argument (plan §3.4): it must
 * pass MODEL_ID_RE and be in the runtime's discovered catalog.
 * @param {unknown} modelId
 * @param {string[]|null|undefined} catalog
 * @returns {string|null} error, or null when acceptable
 */
export function checkModelId(modelId, catalog) {
  if (!isValidModelId(modelId)) return "invalid model id";
  if (!Array.isArray(catalog)) return "model catalog is unknown; refresh the inventory first";
  if (!catalog.includes(/** @type {string} */ (modelId))) return `model ${modelId} is not in this runtime's catalog`;
  return null;
}

/** Finite non-negative number or null. */
export function num(v) {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

/** Positive integer or null. */
export function posInt(v) {
  const n = num(v);
  return n != null && Number.isInteger(n) && n > 0 ? n : null;
}

/** Non-empty trimmed string or null. */
export function str(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** @param {unknown} p @returns {p is number} */
export function isValidPortNumber(p) {
  return typeof p === "number" && Number.isInteger(p) && p >= 1 && p <= 65535;
}
