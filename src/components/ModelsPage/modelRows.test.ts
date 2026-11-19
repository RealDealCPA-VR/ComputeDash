import { describe, expect, it } from "vitest";
import type { FleetRuntime } from "../../api/fleetTypes";
import { CAPS, makeModel, makeTarget } from "./fixtures";
import { modelStateRank, noActionReason, sortModelsForDisplay, windowsWithoutControl } from "./modelRows";

const NONE = { ...CAPS, start: false, stop: false, load: false, unload: false };
const runtime = (engine: string, port: number | null, capabilities = CAPS): FleetRuntime => ({ engine, port, endpoint: null, reachable: true, capabilities, error: null });

describe("model rows", () => {
  it("ranks serving, then loaded/starting/stopping, then configured/installed, then the rest", () => {
    expect(["serving", "loaded", "starting", "stopping", "configured", "installed", "stopped", "failed", "unknown", "unreachable"].map(modelStateRank)).toEqual([
      0, 1, 1, 1, 2, 2, 3, 3, 3, 3,
    ]);
  });

  it("sorts by rank then case-insensitive name, without mutating the input", () => {
    const input = [makeModel("b", "stopped"), makeModel("Zeta", "serving"), makeModel("alpha", "serving"), makeModel("c", "installed")];
    const sorted = sortModelsForDisplay(input).map((m) => m.modelId);
    expect(sorted).toEqual(["alpha", "Zeta", "c", "b"]);
    expect(input.map((m) => m.modelId)).toEqual(["b", "Zeta", "alpha", "c"]);
  });

  it("gives no reason when any lifecycle action is allowed", () => {
    const m = makeModel("x", "serving", { actions: { start: false, stop: true, reload: false, switchTo: false } });
    expect(noActionReason(m, makeTarget({ targetId: "node:a", name: "a" }), [runtime("vllm", 8000)])).toBeNull();
  });

  it("derives the reason from platform, engine capabilities and launch source", () => {
    const linux = makeTarget({ targetId: "node:a", name: "a" });
    const windows = makeTarget({ targetId: "node:w", name: "w", platform: "windows" });
    const lm = makeModel("phi", "loaded", { engine: "lmstudio", port: 1234 });
    expect(noActionReason(lm, windows, [runtime("lmstudio", 1234, NONE)])).toBe("windowsOllamaOnly");
    // Ollama on Windows is controllable; with no action in this state it says so instead.
    expect(noActionReason(makeModel("llama3", "loaded", { engine: "ollama", port: 11434 }), windows, [runtime("ollama", 11434)])).toBe("notInThisState");
    expect(noActionReason(lm, linux, [runtime("lmstudio", 1234, NONE)])).toBe("engineNoLifecycle");
    expect(noActionReason(makeModel("v", "serving"), linux, [runtime("vllm", 8000, { ...CAPS, load: false, unload: false })])).toBe("noLaunchProfile");
    expect(noActionReason(makeModel("v", "serving", { launcherId: "qwen" }), linux, [runtime("vllm", 8000, { ...CAPS, load: false, unload: false })])).toBe("notInThisState");
    // A runtime on another port is not this model's runtime.
    expect(noActionReason(lm, linux, [runtime("lmstudio", 9999, NONE)])).toBe("noLaunchProfile");
  });

  it("flags Windows nodes without a lifecycle-capable runtime only", () => {
    const win = makeTarget({ targetId: "node:w", name: "w", platform: "windows", capabilities: { distributedControl: false, lifecycle: false } });
    expect(windowsWithoutControl(win, [runtime("lmstudio", 1234, NONE)])).toBe(true);
    expect(windowsWithoutControl(win, [runtime("ollama", 11434)])).toBe(false);
    expect(windowsWithoutControl(win, null)).toBe(true);
    expect(windowsWithoutControl(makeTarget({ targetId: "node:a", name: "a" }), [])).toBe(false);
  });
});
