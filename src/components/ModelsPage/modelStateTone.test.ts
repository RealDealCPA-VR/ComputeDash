import { afterEach, describe, expect, it } from "vitest";
import { i18n, setLocale } from "../../i18n";
import type { ModelState } from "../../api/fleetTypes";
import {
  actionLabel,
  formatContext,
  formatMemory,
  formatRelativeTime,
  modelStateClass,
  modelStateLabel,
  modelStateTone,
  operationStatusLabel,
  stepStatusLabel,
  targetHealthLabel,
  targetHealthTone,
} from "./modelStateTone";

const STATES: ModelState[] = ["installed", "configured", "starting", "loaded", "serving", "stopping", "stopped", "failed", "unknown", "unreachable"];

const tModels = (key: string, options?: Record<string, unknown>) => i18n.getFixedT(null, "models")(key, options) as string;

afterEach(async () => {
  await setLocale("en");
});

describe("modelStateTone", () => {
  it("maps every state to a tone; uncertain states never look like stopped", () => {
    expect(modelStateTone("serving")).toBe("good");
    expect(modelStateTone("loaded")).toBe("info");
    expect(modelStateTone("failed")).toBe("bad");
    expect(modelStateTone("stopped")).toBe("neutral");
    expect(modelStateTone("unknown")).not.toBe(modelStateTone("stopped"));
    expect(modelStateTone("unreachable")).not.toBe(modelStateTone("stopped"));
    expect(modelStateTone("unknown")).not.toBe(modelStateTone("unreachable"));
    expect(modelStateClass("unknown")).toContain("mm-state--uncertain");
    expect(modelStateClass("unreachable")).toContain("mm-state--uncertain");
    expect(modelStateClass("stopped")).not.toContain("uncertain");
    // An unexpected value from a newer server is flagged, not shown as healthy.
    expect(modelStateTone("weird")).toBe("warn");
  });

  it("has a translated label for all ten states in both locales", async () => {
    for (const locale of ["en", "zh-CN"] as const) {
      await setLocale(locale);
      const labels = STATES.map((s) => modelStateLabel(tModels, s));
      for (const [i, label] of labels.entries()) {
        expect(label).not.toBe(`state.${STATES[i]}`);
        expect(label.length).toBeGreaterThan(0);
      }
      expect(new Set(labels).size).toBe(STATES.length);
      expect(modelStateLabel(tModels, "unknown")).not.toBe(modelStateLabel(tModels, "stopped"));
      expect(modelStateLabel(tModels, "unreachable")).not.toBe(modelStateLabel(tModels, "stopped"));
    }
  });

  it("labels health, operation and step statuses and actions from the catalog", async () => {
    for (const locale of ["en", "zh-CN"] as const) {
      await setLocale(locale);
      for (const h of ["ready", "degraded", "unreachable", "unknown"]) expect(targetHealthLabel(tModels, h)).not.toContain("health.");
      for (const s of ["running", "succeeded", "failed", "cancelled"]) expect(operationStatusLabel(tModels, s)).not.toContain("operation.");
      for (const s of ["pending", "running", "done", "failed", "skipped"]) expect(stepStatusLabel(tModels, s)).not.toContain("operation.");
      for (const a of ["start", "stop", "reload", "switch"]) expect(actionLabel(tModels, a)).not.toContain("actions.");
    }
    expect(targetHealthTone("ready")).toBe("good");
    expect(targetHealthTone("unreachable")).toBe("bad");
    expect(targetHealthTone("unknown")).toBe(modelStateTone("unknown"));
  });
});

describe("formatters", () => {
  it("keeps unknown memory unknown, never 0", () => {
    expect(formatMemory(null, "unknown")).toBe("unknown");
    expect(formatMemory(undefined, "unknown")).toBe("unknown");
    expect(formatMemory(128 * 1024 ** 3, "unknown")).toBe("128 GB");
    expect(formatMemory(48 * 1024 ** 3, "unknown")).toBe("48.0 GB");
    expect(formatMemory(512 * 1024 ** 3, "unknown")).toBe("512 GB");
    expect(formatContext(null, "unknown")).toBe("unknown");
    expect(formatContext(131072, "unknown")).toBe("128K");
    expect(formatContext(4000, "unknown")).toBe("4K");
    expect(formatRelativeTime(0, 5 * 60_000, "en")).toBe("5 minutes ago");
  });
});
