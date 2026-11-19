/**
 * Fleet model states (plan §3.1) and model identity helpers.
 *
 * Everything here is pure: no I/O, no clocks unless the caller passes times in.
 */

/** @typedef {"installed"|"configured"|"starting"|"loaded"|"serving"|"stopping"|"stopped"|"failed"|"unknown"|"unreachable"} ModelState */

/** @type {readonly ModelState[]} */
export const MODEL_STATES = Object.freeze([
  "installed",
  "configured",
  "starting",
  "loaded",
  "serving",
  "stopping",
  "stopped",
  "failed",
  "unknown",
  "unreachable",
]);

/** @param {unknown} s @returns {s is ModelState} */
export function isModelState(s) {
  return typeof s === "string" && MODEL_STATES.includes(/** @type {ModelState} */ (s));
}

/**
 * Model ids that may reach an HTTP body or a CLI argument (plan §3.4). No quotes, spaces,
 * `$`, backticks, `|` or shell metacharacters; `..` is refused separately.
 */
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

/** @param {unknown} id @returns {id is string} */
export function isValidModelId(id) {
  return typeof id === "string" && MODEL_ID_RE.test(id) && !id.includes("..");
}

/**
 * Evidence about one model on one runtime, gathered by the inventory from adapters,
 * launch profiles, mac profiles, the monitor snapshot and the operation runner.
 * Every field is optional; a missing field means "no evidence", never "false".
 *
 * @typedef {object} ModelEvidence
 * @property {boolean|null} [reachable]  The target or the runtime answering for this model is
 *   reachable. `false` → `unreachable` (rule 1). `null`/absent = not known.
 * @property {"start"|"stop"|"load"|"unload"|null} [operation]  An operation is in flight for
 *   this model (rule 2): start/load → `starting`, stop/unload → `stopping`.
 * @property {boolean} [lastOperationFailed]  The model's last operation failed (rule 3).
 * @property {number|null} [lastFailureAt]  When it failed (ms). Together with `observedAt`, lets
 *   newer positive evidence (listed / loaded / process running) supersede the failure.
 * @property {number|null} [observedAt]  When the positive evidence below was collected (ms).
 * @property {boolean} [listed]  The serving API lists the model (e.g. /v1/models, /api/ps).
 * @property {boolean|null} [ready]  The runtime's readiness / health check passed.
 * @property {boolean} [loaded]  Loaded in memory (Ollama /api/ps, LM Studio state "loaded").
 * @property {boolean} [hasProfile]  A launch profile or mac profile exists for this model.
 * @property {boolean|null} [processRunning]  The profile's process: true running, false known
 *   stopped, null unknown.
 * @property {boolean} [servedThisSession]  It was seen serving earlier in this dashboard session.
 * @property {boolean} [installed]  Present on disk / in the engine catalog.
 * @property {boolean} [discoveryFailed]  A discovery source this model depends on failed.
 */

/**
 * Derive one model's state from its evidence, in the exact precedence of plan §3.1.
 * Never guesses: with no usable evidence the answer is `unknown`.
 *
 * @param {ModelEvidence} [evidence]
 * @returns {ModelState}
 */
export function deriveModelState(evidence = {}) {
  const ev = evidence && typeof evidence === "object" ? evidence : {};
  // 1. Target / runtime unreachable.
  if (ev.reachable === false) return "unreachable";
  // 2. Operation in flight.
  if (ev.operation === "start" || ev.operation === "load") return "starting";
  if (ev.operation === "stop" || ev.operation === "unload") return "stopping";
  // 3. Last operation failed and nothing newer is known.
  if (ev.lastOperationFailed === true) {
    const positive = ev.listed === true || ev.loaded === true || ev.processRunning === true;
    const newer =
      positive &&
      Number.isFinite(ev.observedAt) &&
      Number.isFinite(ev.lastFailureAt) &&
      /** @type {number} */ (ev.observedAt) > /** @type {number} */ (ev.lastFailureAt);
    if (!newer) return "failed";
  }
  // 4. Listed by the serving API and ready.
  if (ev.listed === true && ev.ready === true) return "serving";
  // 5. In memory (or listed) without confirmed readiness.
  if (ev.loaded === true || ev.listed === true) return "loaded";
  // 6. A profile's process runs but the API does not list the model yet.
  if (ev.hasProfile === true && ev.processRunning === true) return "starting";
  // 7. A profile exists and its process is known stopped (or there is no process source and no
  //    failure): `stopped` after serving earlier this session, otherwise `configured`.
  if (ev.hasProfile === true && ev.processRunning === false) {
    return ev.servedThisSession === true ? "stopped" : "configured";
  }
  if (ev.hasProfile === true && ev.processRunning == null && ev.discoveryFailed !== true) return "configured";
  // 8. On disk / in the catalog only.
  if (ev.installed === true) return "installed";
  // 9. Discovery failed, or nothing is known.
  return "unknown";
}

/**
 * Stable model key: "<engine>|<port|profile>|<modelId>". The slot is a port number for a
 * runtime, or a profile slot such as "launcher:<id>" / "mac:<runtime>".
 *
 * @param {string} engine
 * @param {number|string|null} portOrProfile
 * @param {string} modelId
 * @returns {string}
 */
export function makeModelKey(engine, portOrProfile, modelId) {
  const e = String(engine ?? "").trim();
  const slot = portOrProfile == null ? "" : String(portOrProfile).trim();
  if (!e || e.includes("|")) throw new Error("model key: engine is required and must not contain |");
  if (slot.includes("|")) throw new Error("model key: port/profile must not contain |");
  if (typeof modelId !== "string" || !modelId) throw new Error("model key: modelId is required");
  return `${e}|${slot}|${modelId}`;
}

/**
 * Inverse of makeModelKey. The model id is everything after the second `|`.
 *
 * @param {unknown} key
 * @returns {{ engine: string, slot: string, port: number|null, profile: string|null, modelId: string } | null}
 */
export function parseModelKey(key) {
  if (typeof key !== "string" || key.length > 600) return null;
  const a = key.indexOf("|");
  if (a <= 0) return null;
  const b = key.indexOf("|", a + 1);
  if (b < 0) return null;
  const engine = key.slice(0, a);
  const slot = key.slice(a + 1, b);
  const modelId = key.slice(b + 1);
  if (!modelId) return null;
  const n = /^\d{1,5}$/.test(slot) ? Number(slot) : NaN;
  const port = Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
  return { engine, slot, port, profile: port == null && slot ? slot : null, modelId };
}
