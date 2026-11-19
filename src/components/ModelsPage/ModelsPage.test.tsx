import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";
import * as client from "../../api/fleetClient";
import { ModelsPage, orderTargets, TARGETS_BUSY_POLL_MS } from "./ModelsPage";
import { BIG, DESK, DUO, MAC, SERVING, SMALL, SPARK1, SPARK2, makeInventory, makeModel, makeOperation } from "./fixtures";

vi.mock("../../api/fleetClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/fleetClient")>();
  return {
    FleetApiError: actual.FleetApiError,
    isBusyError: actual.isBusyError,
    getFleetStatus: vi.fn(),
    getTargets: vi.fn(),
    getInventory: vi.fn(),
    startOperation: vi.fn(),
    readOperation: vi.fn(),
    cancelOperation: vi.fn(),
    getLogs: vi.fn(),
    listClusters: vi.fn(),
    createCluster: vi.fn(),
    updateCluster: vi.fn(),
    deleteCluster: vi.fn(),
  };
});

beforeEach(() => {
  vi.mocked(client.getFleetStatus).mockResolvedValue({ enabled: true, smartRoutingEnabled: false, adapters: [] });
  // Server order mixes kinds; the page lists nodes first.
  vi.mocked(client.getTargets).mockResolvedValue({ targets: [DUO, SPARK1, DESK, SPARK2, MAC], generatedAt: 1 });
  vi.mocked(client.getInventory).mockResolvedValue(makeInventory());
  vi.mocked(client.readOperation).mockImplementation(() => new Promise(() => {}));
  vi.mocked(client.getLogs).mockResolvedValue({ source: "launcher", lines: [{ seq: 1, text: "engine ready" }] });
  vi.mocked(client.listClusters).mockResolvedValue({ clusters: [], suggestions: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

const buttons = (root: ParentNode = document.body) => Array.from(root.querySelectorAll("button"));
function button(text: string, root: ParentNode = document.body): HTMLButtonElement {
  const found = buttons(root).find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no button "${text}" in: ${buttons(root).map((b) => b.textContent).join(" | ")}`);
  return found;
}
const row = (container: HTMLElement, modelKey: string) => container.querySelector<HTMLTableRowElement>(`tr[data-model-key="${modelKey}"]`)!;
const dialog = () => document.body.querySelector<HTMLElement>("[role=dialog]");
async function click(el: HTMLElement) {
  await act(async () => el.click());
  await flush();
}

async function renderPage() {
  const view = render(<ModelsPage />);
  await flush();
  await flush();
  return view;
}

describe("ModelsPage", () => {
  it("orders nodes before clusters", () => {
    expect(orderTargets([DUO, SPARK1, DESK, SPARK2]).map((x) => x.targetId)).toEqual(["node:spark1", "node:spark2", "cluster:duo", "cluster:desk"]);
  });

  it("lists nodes then clusters with health, busy and cluster kind, and shows the routing chip", async () => {
    const { container } = await renderPage();
    const ids = Array.from(container.querySelectorAll("[data-target-id]")).map((n) => n.getAttribute("data-target-id"));
    expect(ids).toEqual(["node:spark1", "node:spark2", "node:mac", "cluster:duo", "cluster:desk"]);
    const item = (id: string) => container.querySelector(`[data-target-id="${id}"]`)!;
    expect(item("node:spark1").textContent).toContain("ready");
    expect(item("node:spark2").textContent).toContain("degraded");
    expect(item("node:spark2").textContent).toContain("Operation running");
    expect(item("node:spark2").textContent).toContain("serving: unknown");
    expect(item("node:spark1").textContent).toContain("1 model serving");
    expect(item("node:mac").textContent).toContain("Memory unknown");
    expect(item("node:mac").textContent).not.toMatch(/\b0 (GB|MB)\b/);
    expect(item("cluster:duo").textContent).toContain("Distributed cluster");
    expect(item("cluster:desk").textContent).toContain("Visual group");
    expect(container.querySelector(".mm-routing-chip")?.textContent).toBe("Smart routing: off");
    // First target is selected and its inventory loaded from the cache.
    expect(item("node:spark1").getAttribute("aria-current")).toBe("true");
    expect(client.getInventory).toHaveBeenCalledWith("node:spark1", false);
  });

  it("shows an unknown routing state when status cannot be read, and 'on' when enabled", async () => {
    vi.mocked(client.getFleetStatus).mockRejectedValueOnce(new Error("down"));
    const first = await renderPage();
    expect(first.container.querySelector(".mm-routing-chip")?.textContent).toBe("Smart routing: unknown");
    vi.mocked(client.getFleetStatus).mockResolvedValueOnce({ enabled: true, smartRoutingEnabled: true, adapters: [] });
    const second = await renderPage();
    expect(second.container.querySelector(".mm-routing-chip")?.textContent).toBe("Smart routing: on");
  });

  it("renders all ten states, runtimes, null-safe values and cluster models read-only", async () => {
    const { container } = await renderPage();
    const stateText = (key: string) => row(container, key).querySelector(".mm-state")?.textContent;
    expect(stateText(SERVING.modelKey)).toBe("serving");
    expect(stateText(BIG.modelKey)).toBe("installed");
    expect(stateText(SMALL.modelKey)).toBe("configured");
    for (const s of ["loaded", "starting", "stopping", "stopped", "failed", "unknown", "unreachable"]) {
      expect(stateText(`vllm|8000|m-${s}`)).toBe(s);
    }
    const unknownTag = row(container, "vllm|8000|m-unknown").querySelector(".mm-state")!;
    const stoppedTag = row(container, "vllm|8000|m-stopped").querySelector(".mm-state")!;
    const unreachableTag = row(container, "vllm|8000|m-unreachable").querySelector(".mm-state")!;
    expect(unknownTag.className).not.toBe(stoppedTag.className);
    expect(unreachableTag.className).not.toBe(stoppedTag.className);
    expect(unknownTag.className).toContain("mm-state--uncertain");
    // Unknown memory/context are not zero.
    const small = row(container, SMALL.modelKey);
    expect(small.textContent).toContain("unknown");
    expect(small.textContent).not.toMatch(/\b0 (GB|MB)\b/);
    expect(row(container, SERVING.modelKey).textContent).toContain("128K");
    expect(row(container, SERVING.modelKey).textContent).toContain("40.0 GB");
    expect(row(container, "vllm|8000|m-failed").textContent).toContain("CUDA out of memory <raw>");
    // Runtimes strip
    const runtimes = container.querySelectorAll(".mm-runtime");
    expect(runtimes).toHaveLength(2);
    expect(runtimes[0].textContent).toContain("vllm:8000");
    expect(runtimes[0].textContent).toContain("reachable");
    expect(runtimes[1].textContent).toContain("reach unknown");
    expect(runtimes[1].textContent).toContain("probe timed out");
    // Cluster models: once, read-only, named by cluster.
    const clusterRow = row(container, "vllm|9000|deepseek-v3");
    expect(clusterRow.textContent).toContain("Served by Spark Duo");
    expect(clusterRow.querySelector("button")).toBeNull();
  });

  it("enables per-model actions from model.actions only", async () => {
    const { container } = await renderPage();
    const serving = row(container, SERVING.modelKey);
    expect(button("Start", serving).disabled).toBe(true);
    expect(button("Stop", serving).disabled).toBe(false);
    expect(button("Reload", serving).disabled).toBe(false);
    const big = row(container, BIG.modelKey);
    expect(button("Start", big).disabled).toBe(false);
    expect(button("Stop", big).disabled).toBe(true);
  });

  it("warns about stale inventory, unreachable targets and lists discovery errors verbatim", async () => {
    vi.mocked(client.getInventory).mockResolvedValue(
      makeInventory({ stale: true, reachable: false, errors: ["ollama: connect ECONNREFUSED 10.0.0.2:11434", "lmstudio: <raw> 500"] })
    );
    const { container } = await renderPage();
    expect(container.textContent).toContain("This inventory is from the cache");
    expect(container.textContent).toContain("The target is unreachable");
    const errs = Array.from(container.querySelectorAll(".mm-errors li")).map((li) => li.textContent);
    expect(errs).toEqual(["ollama: connect ECONNREFUSED 10.0.0.2:11434", "lmstudio: <raw> 500"]);
    expect(container.textContent).toContain("2 discovery sources failed");
  });

  it("Refresh inventory asks for fresh discovery", async () => {
    await renderPage();
    await click(button("Refresh inventory"));
    expect(client.getInventory).toHaveBeenLastCalledWith("node:spark1", true);
  });

  it("selecting another target loads its inventory, and the target id is passed through unchanged", async () => {
    const { container } = await renderPage();
    await click(container.querySelector<HTMLElement>('[data-target-id="cluster:duo"]')!);
    expect(client.getInventory).toHaveBeenLastCalledWith("cluster:duo", false);
    expect(container.querySelector("#mm-detail-title")?.textContent).toBe("Spark Duo");
    expect(container.textContent).toContain("Members: Spark 1, Spark 2 · head: Spark 1");
  });

  it("labels a visual group as having no inference endpoint", async () => {
    const { container } = await renderPage();
    await click(container.querySelector<HTMLElement>('[data-target-id="cluster:desk"]')!);
    expect(container.textContent).toContain("This is a visual group");
  });

  it("asks for confirmation before stopping, then starts the operation and shows its panel", async () => {
    vi.mocked(client.startOperation).mockResolvedValue({ operation: makeOperation({ action: "stop", modelKey: SERVING.modelKey }) });
    const { container } = await renderPage();
    await click(button("Stop", row(container, SERVING.modelKey)));
    expect(client.startOperation).not.toHaveBeenCalled();
    expect(dialog()?.textContent).toContain("Stop qwen3-32b?");
    await click(button("Stop", dialog()!));
    expect(client.startOperation).toHaveBeenCalledWith("node:spark1", { action: "stop", modelKey: SERVING.modelKey });
    await flush();
    expect(container.querySelector(".mm-op")?.textContent).toContain("Stop qwen3-32b");
    expect(container.querySelector(".mm-op")?.textContent).toContain("Confirm target reachable");
    // Controls lock while it runs.
    expect(button("Start", row(container, BIG.modelKey)).disabled).toBe(true);
    expect(button("Switch model").disabled).toBe(true);
  });

  it("refreshes the inventory (fresh discovery) and the target list once the operation finishes", async () => {
    vi.mocked(client.startOperation).mockResolvedValue({ operation: makeOperation() });
    vi.mocked(client.readOperation).mockResolvedValue({ operation: makeOperation({ status: "succeeded", finishedAt: 2 }), lines: [], nextSeq: 0 });
    const { container } = await renderPage();
    const targetCalls = vi.mocked(client.getTargets).mock.calls.length;
    await click(button("Start", row(container, BIG.modelKey)));
    await click(button("Start", dialog()!));
    await flush();
    expect(client.readOperation).toHaveBeenCalledWith("op-1", undefined);
    expect(client.getInventory).toHaveBeenLastCalledWith("node:spark1", true);
    expect(vi.mocked(client.getTargets).mock.calls.length).toBeGreaterThan(targetCalls);
    expect(container.querySelector(".mm-op__status")?.textContent).toBe("succeeded");
  });

  it("cancelling the confirmation does nothing", async () => {
    const { container } = await renderPage();
    await click(button("Reload", row(container, SERVING.modelKey)));
    await click(button("Cancel", dialog()!));
    expect(client.startOperation).not.toHaveBeenCalled();
  });

  it("explains a 409 busy answer", async () => {
    vi.mocked(client.startOperation).mockRejectedValue(new client.FleetApiError("target busy: switch running", 409, "busy"));
    const { container } = await renderPage();
    await click(button("Start", row(container, BIG.modelKey)));
    await click(button("Start", dialog()!));
    const alert = dialog()!.querySelector("[role=alert]")!;
    expect(alert.textContent).toContain("Another operation is already running on this target");
    expect(alert.textContent).toContain("target busy: switch running");
  });

  it("switch dialog: candidates, current model, capacity, force and rollback, then a confirmation step", async () => {
    vi.mocked(client.startOperation).mockResolvedValue({ operation: makeOperation({ action: "switch", modelKey: BIG.modelKey, fromModelKey: SERVING.modelKey }) });
    await renderPage();
    await click(button("Switch model"));
    const d = dialog()!;
    expect(d.textContent).toContain("Currently serving:");
    expect(d.textContent).toContain("qwen3-32b");
    const radios = Array.from(d.querySelectorAll<HTMLInputElement>("input[type=radio]"));
    expect(radios.map((r) => r.value)).toEqual([BIG.modelKey, SMALL.modelKey]);
    const [force, rollback] = Array.from(d.querySelectorAll<HTMLInputElement>("input[type=checkbox]"));
    expect(force.checked).toBe(false);
    expect(rollback.checked).toBe(true);
    expect(button("Review switch", d).disabled).toBe(true);

    // 200 GB on a 128 GB target needs Force.
    await click(radios[0]);
    expect(d.textContent).toContain("Estimated memory 200 GB of 128 GB");
    expect(d.textContent).toContain("exceeds");
    expect(button("Review switch", d).disabled).toBe(true);
    await click(force);
    expect(button("Review switch", d).disabled).toBe(false);

    // Unknown estimate stays unknown and does not block.
    await click(radios[1]);
    expect(d.textContent).toContain("Estimated memory unknown of 128 GB");
    expect(d.textContent).toContain("The fit is unknown.");

    await click(radios[0]);
    await click(button("Review switch", d));
    expect(client.startOperation).not.toHaveBeenCalled();
    expect(d.textContent).toContain("stop qwen3-32b and start llama-405b");
    await click(button("Confirm switch", d));
    expect(client.startOperation).toHaveBeenCalledWith("node:spark1", { action: "switch", modelKey: BIG.modelKey, force: true, rollback: true });
  });

  it("View logs fetches the target's logs, and a row's Logs fetches that model's", async () => {
    const { container } = await renderPage();
    await click(button("View logs"));
    expect(client.getLogs).toHaveBeenLastCalledWith("node:spark1", null);
    expect(dialog()?.textContent).toContain("Logs: Spark 1");
    expect(dialog()?.textContent).toContain("launch profile");
    expect(dialog()?.textContent).toContain("engine ready");
    await click(button("Close", dialog()!));
    await click(button("Logs", row(container, SERVING.modelKey)));
    expect(client.getLogs).toHaveBeenLastCalledWith("node:spark1", SERVING.modelKey);
  });

  it("a lost operation (404 after a server restart) unlocks the controls and refreshes the inventory", async () => {
    vi.mocked(client.startOperation).mockResolvedValue({ operation: makeOperation() });
    vi.mocked(client.readOperation).mockRejectedValue(new client.FleetApiError("operation not found", 404));
    const { container } = await renderPage();
    await click(button("Start", row(container, BIG.modelKey)));
    await click(button("Start", dialog()!));
    await flush();
    expect(container.querySelector(".mm-op__status")?.textContent).toBe("status unknown");
    expect(client.getInventory).toHaveBeenLastCalledWith("node:spark1", true);
    expect(button("Start", row(container, BIG.modelKey)).disabled).toBe(false);
    expect(button("Switch model").disabled).toBe(false);
    await click(button("Dismiss"));
    expect(container.querySelector(".mm-op")).toBeNull();
  });

  it("marks the shown inventory stale when a manual refresh fails", async () => {
    const { container } = await renderPage();
    expect(container.querySelector(".mm-stale")).toBeNull();
    vi.mocked(client.getInventory).mockRejectedValueOnce(new Error("ssh timeout"));
    await click(button("Refresh inventory"));
    expect(container.textContent).toContain("The last refresh failed. This inventory may be out of date.");
    expect(container.querySelector("[role=alert]")?.textContent).toContain("ssh timeout");
    expect(container.querySelector("tbody.mm-stale")).not.toBeNull();
    // Old rows are still visible, but dimmed.
    expect(row(container, SERVING.modelKey)).not.toBeNull();
    await click(button("Refresh inventory"));
    expect(container.querySelector(".mm-stale")).toBeNull();
    expect(container.textContent).not.toContain("The last refresh failed");
  });

  it("gives each row action an accessible name with the model", async () => {
    const { container } = await renderPage();
    const names = Array.from(row(container, SERVING.modelKey).querySelectorAll("button")).map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["Start qwen3-32b", "Stop qwen3-32b", "Reload qwen3-32b", "Logs for qwen3-32b"]);
  });

  it("renders unknown quant and context as the same 'unknown' as memory", async () => {
    const { container } = await renderPage();
    const cells = Array.from(row(container, SMALL.modelKey).querySelectorAll("td")).slice(3, 6);
    expect(cells.map((c) => c.textContent)).toEqual(["unknown", "unknown", "unknown"]);
    expect(cells.every((c) => c.className.includes("mm-unknown"))).toBe(true);
  });

  it("shows optional runtime requests/notes and a model's last seen state", async () => {
    const inv = makeInventory();
    inv.runtimes[0] = { ...inv.runtimes[0], requestsRunning: 2, note: "load/unload needs the lms CLI <raw>" };
    inv.runtimes[1] = { ...inv.runtimes[1], requestsRunning: null };
    inv.models = inv.models.map((m) =>
      m.modelId === "m-unreachable" ? { ...m, lastSeen: { state: "serving" as const, at: Date.now() - 5 * 60_000 } } : m.modelId === "m-stopped" ? { ...m, lastSeen: { state: "serving" as const, at: 0 } } : m
    );
    vi.mocked(client.getInventory).mockResolvedValue(inv);
    const { container } = await renderPage();
    const runtimes = container.querySelectorAll(".mm-runtime");
    expect(runtimes[0].textContent).toContain("2 requests running");
    expect(runtimes[0].querySelector(".mm-runtime__note")?.textContent).toBe("load/unload needs the lms CLI <raw>");
    expect(runtimes[1].textContent).not.toContain("request");
    expect(row(container, "vllm|8000|m-unreachable").querySelector(".mm-last-seen")?.textContent).toBe("last seen serving 5 minutes ago");
    // Only shown while the current state is uncertain.
    expect(row(container, "vllm|8000|m-stopped").querySelector(".mm-last-seen")).toBeNull();
  });

  it("last seen without a time, dimmed stale cluster rows, and opaque launcher model keys", async () => {
    const LAUNCHER_KEY = "launch-profile|launcher:qwen-vllm|qwen-vllm";
    const inv = makeInventory();
    inv.models = [
      ...inv.models.map((m) => (m.modelId === "m-unknown" ? { ...m, lastSeen: { state: "loaded" as const, at: null } } : m)),
      makeModel("qwen-vllm", "configured", {
        modelKey: LAUNCHER_KEY,
        engine: "launch-profile",
        port: null,
        endpoint: null,
        launcherId: "qwen-vllm",
        actions: { start: true, stop: false, reload: false, switchTo: true },
      }),
    ];
    inv.clusterModels = [{ ...inv.clusterModels[0], stale: true, collectedAt: null, endpoint: "http://spark1:9000" }];
    vi.mocked(client.getInventory).mockResolvedValue(inv);
    vi.mocked(client.startOperation).mockResolvedValue({ operation: makeOperation({ modelKey: LAUNCHER_KEY }) });
    const { container } = await renderPage();
    expect(row(container, "vllm|8000|m-unknown").querySelector(".mm-last-seen")?.textContent).toBe("last seen loaded");
    const clusterRow = row(container, "vllm|9000|deepseek-v3");
    expect(clusterRow.className).toContain("mm-stale");
    expect(clusterRow.getAttribute("title")).toBe("The cluster's inventory is out of date.");
    // The key is passed through unchanged, never parsed.
    const launcher = row(container, LAUNCHER_KEY);
    await click(button("Start", launcher));
    await click(button("Start", dialog()!));
    expect(client.startOperation).toHaveBeenCalledWith("node:spark1", { action: "start", modelKey: LAUNCHER_KEY });
    await click(button("Logs", row(container, LAUNCHER_KEY)));
    expect(client.getLogs).toHaveBeenLastCalledWith("node:spark1", LAUNCHER_KEY);
  });

  it("re-reads targets every 5 s while any target is busy, and stops when none is", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(client.getTargets)
        .mockResolvedValueOnce({ targets: [SPARK1, SPARK2], generatedAt: 1 })
        .mockResolvedValue({ targets: [SPARK1, { ...SPARK2, busy: false }], generatedAt: 2 });
      const { container } = await renderPage();
      expect(client.getTargets).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TARGETS_BUSY_POLL_MS);
      });
      expect(client.getTargets).toHaveBeenCalledTimes(2);
      expect(container.querySelector('[data-target-id="node:spark2"]')?.textContent).not.toContain("Operation running");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TARGETS_BUSY_POLL_MS * 3);
      });
      expect(client.getTargets).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not poll targets when none is busy", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(client.getTargets).mockResolvedValue({ targets: [SPARK1, MAC], generatedAt: 1 });
      await renderPage();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TARGETS_BUSY_POLL_MS * 3);
      });
      expect(client.getTargets).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a target load error instead of an empty list", async () => {
    vi.mocked(client.getTargets).mockRejectedValue(new Error("fleet <raw> offline"));
    const { container } = await renderPage();
    expect(container.querySelector("[role=alert]")?.textContent).toContain("fleet <raw> offline");
    expect(container.querySelector("[data-target-id]")).toBeNull();
  });
});
