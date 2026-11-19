import { makeCapabilities } from "./base.js";
import { ollamaAdapter } from "./ollama.js";
import { lmstudioAdapter } from "./lmstudio.js";
import { vllmAdapter, llamaCppAdapter, sglangAdapter } from "./openaiCompat.js";
import { macProfileAdapter } from "./macProfile.js";
import { launchProfileAdapter } from "./launchProfile.js";

/**
 * Adapter registry. The core (inventory, operations) looks adapters up by engine name, so a
 * new engine is one registerAdapter() call, never a core change.
 *
 * @typedef {import("./base.js").FleetAdapter} FleetAdapter
 * @typedef {{ engine: string, label: string, capabilities: import("./base.js").AdapterCapabilities }} AdapterInfo
 */

/** @type {Map<string, FleetAdapter>} */
const adapters = new Map();

const ENGINE_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

/**
 * @param {FleetAdapter} adapter
 * @param {{ replace?: boolean }} [opts]
 * @returns {FleetAdapter}
 */
export function registerAdapter(adapter, { replace = false } = {}) {
  if (!adapter || typeof adapter !== "object") throw new Error("adapter must be an object");
  if (typeof adapter.engine !== "string" || !ENGINE_RE.test(adapter.engine)) {
    throw new Error("adapter.engine must be a short lowercase engine name");
  }
  if (typeof adapter.discover !== "function") throw new Error(`adapter ${adapter.engine} has no discover()`);
  if (adapters.has(adapter.engine) && !replace) throw new Error(`adapter ${adapter.engine} is already registered`);
  const entry = {
    ...adapter,
    label: typeof adapter.label === "string" && adapter.label ? adapter.label : adapter.engine,
    capabilities: makeCapabilities(adapter.capabilities),
  };
  adapters.set(adapter.engine, entry);
  return entry;
}

/** @returns {boolean} */
export function unregisterAdapter(engine) {
  return adapters.delete(engine);
}

/**
 * @param {unknown} engine  engine name or a SparkMonitor `backend`
 * @returns {FleetAdapter|null}
 */
export function getAdapter(engine) {
  if (typeof engine !== "string") return null;
  return adapters.get(engine) ?? adapters.get(engine.toLowerCase()) ?? null;
}

/** @returns {AdapterInfo[]} */
export function listAdapters() {
  return [...adapters.values()].map((a) => ({ engine: a.engine, label: a.label, capabilities: { ...a.capabilities } }));
}

for (const a of [ollamaAdapter, lmstudioAdapter, vllmAdapter, llamaCppAdapter, sglangAdapter, macProfileAdapter, launchProfileAdapter]) {
  registerAdapter(a);
}
