import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetInventory, FleetModel, FleetOperation, FleetTarget } from "../../api/fleetTypes";
import { flush, render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";

vi.mock("../../api/fleetClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/fleetClient")>();
  return {
    ...actual,
    getFleetStatus: vi.fn(),
    getTargets: vi.fn(),
    getInventory: vi.fn(),
    startOperation: vi.fn(),
    listOperations: vi.fn(),
    getLogs: vi.fn(),
  };
});

import { FleetApiError, getFleetStatus, getInventory, getTargets, listOperations, startOperation } from "../../api/fleetClient";
import { FleetBoard, BOARD_POLL_MS } from "./FleetBoard";
import { resetActiveOperationsCache } from "./useActiveOperations";

const status = vi.mocked(getFleetStatus);
const targets = vi.mocked(getTargets);
const inventory = vi.mocked(getInventory);
const start = vi.mocked(startOperation);
const operations = vi.mocked(listOperations);

function target(over: Partial<FleetTarget> & Pick<FleetTarget, "targetId" | "name">): FleetTarget {
  const kind = over.targetId.startsWith("cluster:") ? "cluster" : "node";
  return {
    kind,
    id: over.targetId.split(":")[1],
    platform: kind === "node" ? "linux" : null,
    hardware: { label: "NVIDIA GB10", memoryTotalBytes: 128 * 1024 ** 3, memoryKind: "unified" },
    online: true,
    health: "ready",
    memberIds: [],
    headId: null,
    clusterIds: [],
    clusterKind: null,
    capabilities: { distributedControl: false, lifecycle: true },
    servingCount: 1,
    busy: false,
    servingModels: ["qwen3-32b"],
    activeOperationId: null,
    ...over,
  };
}

function model(modelId: string, over: Partial<FleetModel> = {}): FleetModel {
  return {
    modelKey: `vllm|8000|${modelId}`,
    modelId,
    label: modelId,
    engine: "vllm",
    port: 8000,
    state: "installed",
    sources: ["api"],
    quantization: null,
    contextLength: null,
    sizeBytes: null,
    estMemoryBytes: null,
    launcherId: null,
    macRuntime: null,
    servedBy: null,
    actions: { start: true, stop: false, reload: false, switchTo: true },
    lastError: null,
    ...over,
  };
}

function inv(targetId: string, models: FleetModel[]): FleetInventory {
  return { targetId, collectedAt: Date.now(), reachable: true, runtimes: [], models, clusterModels: [], errors: [], stale: false };
}

const A = target({ targetId: "node:a", name: "Spark A" });
const B = target({ targetId: "node:b", name: "Spark B", servingModels: null });
const WIN = target({ targetId: "node:win", name: "Workstation", platform: "windows", online: false, health: "unreachable", servingModels: null, hardware: { label: "RTX 6000 Ada", memoryTotalBytes: 48 * 1024 ** 3, memoryKind: "vram" } });
const MAC = target({ targetId: "node:mac", name: "Mac Studio", platform: "darwin", servingModels: [] });
const DUO = target({
  targetId: "cluster:duo",
  name: "Spark Duo",
  clusterKind: "distributed",
  memberIds: ["a", "b"],
  headId: "a",
  capabilities: { distributedControl: true, lifecycle: true },
  servingModels: ["llama-70b", "embed-small"],
});

function rowOf(container: HTMLElement, name: string): HTMLTableRowElement {
  const row = [...container.querySelectorAll<HTMLTableRowElement>("tbody tr")].find((r) => r.querySelector("th")?.textContent?.includes(name));
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

function button(root: ParentNode, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no button ${text}`);
  return found;
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await flush();
}

/** The dialogs are loaded on demand: wait for the lazy chunk and the render. */
async function findDialog(): Promise<HTMLElement> {
  // Generous: under a loaded full-suite run the first import of the chunk can take seconds.
  for (let i = 0; i < 300; i += 1) {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    if (dialog) return dialog;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }
  throw new Error("dialog did not open");
}

beforeEach(() => {
  resetActiveOperationsCache();
  status.mockResolvedValue({ enabled: true, smartRoutingEnabled: false, adapters: [], controlRequiresToken: true, tokenConfigured: true });
  targets.mockResolvedValue({ targets: [DUO, A, B, WIN, MAC], generatedAt: Date.now() });
  operations.mockResolvedValue({ operations: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("FleetBoard", () => {
  it("shows one row per target with what it serves, nodes first and the cluster listing its members", async () => {
    const sparkA = makeSpark("a");
    sparkA.metrics.llm = [{ ...(sparkA.metrics.llm?.[0] ?? {}), available: true, generationTps: 42.5, measurementValid: true } as never];
    const { container } = render(<FleetBoard sparks={[sparkA, makeSpark("b")]} />);
    await settle();

    const names = [...container.querySelectorAll("tbody th .fb-machine__name")].map((n) => n.textContent);
    expect(names).toEqual(["Spark A", "Spark B", "Workstation", "Mac Studio", "Spark Duo"]);
    expect(container.querySelector("table caption")?.textContent).toContain("What each machine is doing");
    expect([...container.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual(["Machine", "Hardware", "Now serving", "Live", "Actions"]);

    expect(rowOf(container, "Spark A").textContent).toContain("qwen3-32b");
    expect(rowOf(container, "Spark A").textContent).toContain("42.5");
    expect(rowOf(container, "Spark A").textContent).toContain("tok/s");
    const duo = rowOf(container, "Spark Duo");
    expect(duo.textContent).toContain("llama-70b");
    expect(duo.textContent).toContain("embed-small");
    expect([...duo.querySelectorAll(".fb-members li")].map((li) => li.textContent)).toEqual(["Spark A (head)", "Spark B"]);
    expect(rowOf(container, "Mac Studio").textContent).toContain("Nothing serving");
  });

  it("keeps explicit table roles, so the narrow card layout (display: block) stays a table to screen readers", async () => {
    const { container } = render(<FleetBoard sparks={[]} />);
    await settle();
    const table = container.querySelector("table.fb-table")!;
    expect(table.getAttribute("role")).toBe("table");
    expect([...table.querySelectorAll(":scope > thead, :scope > tbody")].map((g) => g.getAttribute("role"))).toEqual(["rowgroup", "rowgroup"]);
    expect([...table.querySelectorAll("thead th")].every((th) => th.getAttribute("role") === "columnheader")).toBe(true);
    const rows = [...table.querySelectorAll("tr")];
    expect(rows.length).toBe(6);
    expect(rows.every((tr) => tr.getAttribute("role") === "row")).toBe(true);
    const row = rowOf(container, "Spark A");
    expect(row.querySelector(":scope > th")?.getAttribute("role")).toBe("rowheader");
    expect([...row.querySelectorAll(":scope > td")].map((td) => td.getAttribute("role"))).toEqual(["cell", "cell", "cell", "cell"]);
  });

  it("never fabricates: an unknown inventory says why, an unreachable machine shows no model list", async () => {
    const { container } = render(<FleetBoard sparks={[]} />);
    await settle();
    const b = rowOf(container, "Spark B");
    expect(b.textContent).toContain("Unknown");
    expect(b.textContent).toContain("No recent model inventory");
    const win = rowOf(container, "Workstation");
    expect(win.textContent).toContain("Unreachable");
    expect(win.textContent).toContain("RTX 6000 Ada");
    expect(win.textContent).toContain("Windows");
    // Offline: no Switch, but Manage stays.
    expect(() => button(win, "Switch…")).toThrow();
    expect(win.querySelector('a[href="/models?target=node%3Awin"]')).not.toBeNull();
  });

  it("falls back to the serving count from an older server without servingModels", async () => {
    const old = { ...A, servingModels: undefined, servingCount: 2 };
    targets.mockResolvedValue({ targets: [old], generatedAt: Date.now() });
    const { container } = render(<FleetBoard sparks={[]} />);
    await settle();
    expect(rowOf(container, "Spark A").textContent).toContain("2 models serving");
  });

  it("shows a compact progress state instead of the actions while an operation runs", async () => {
    const op: FleetOperation = {
      id: "op1",
      targetId: "node:a",
      action: "switch",
      modelKey: "vllm|8000|gemma-4b",
      fromModelKey: null,
      status: "running",
      step: "wait",
      steps: [
        { id: "stop", label: "Stop current model", status: "done", detail: null },
        { id: "start", label: "Start gemma-4b", status: "done", detail: null },
        { id: "wait", label: "Wait for readiness", status: "running", detail: null },
      ],
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
    };
    targets.mockResolvedValue({ targets: [{ ...A, busy: true, activeOperationId: "op1" }], generatedAt: Date.now() });
    operations.mockResolvedValue({ operations: [op] });
    const { container } = render(<FleetBoard sparks={[]} />);
    await settle();
    const row = rowOf(container, "Spark A");
    expect(row.querySelector('[role="status"]')?.textContent).toContain("Switching to gemma-4b");
    expect(row.textContent).toContain("Step 3/3");
    expect(row.textContent).toContain("Wait for readiness");
    expect(() => button(row, "Switch…")).toThrow();
    expect(row.querySelector('a[href="/models?target=node%3Aa"]')?.textContent).toBe("View");
  });

  it("switches through the Models page's dialog and refreshes the targets", async () => {
    inventory.mockResolvedValue(inv("node:a", [model("qwen3-32b", { state: "serving", actions: { start: false, stop: true, reload: true, switchTo: false } }), model("gemma-4b")]));
    start.mockResolvedValue({ operation: { id: "op2" } as FleetOperation });
    const { container } = render(<FleetBoard sparks={[]} />);
    await settle();
    await act(async () => button(rowOf(container, "Spark A"), "Switch…").click());
    await settle();
    expect(inventory).toHaveBeenCalledWith("node:a");
    const dialog = await findDialog();
    expect(dialog.textContent).toContain("Switch model on Spark A");
    const radio = dialog.querySelector<HTMLInputElement>('input[type="radio"][value="vllm|8000|gemma-4b"]')!;
    await act(async () => radio.click());
    await act(async () => button(dialog, "Review switch").click());
    const callsBefore = targets.mock.calls.length;
    await act(async () => button(dialog, "Confirm switch").click());
    await settle();
    expect(start).toHaveBeenCalledWith("node:a", { action: "switch", modelKey: "vllm|8000|gemma-4b", force: false, rollback: true });
    expect(targets.mock.calls.length).toBeGreaterThan(callsBefore);
  }, 30_000);

  it("replaces Switch with a token hint linking to the Models page after a 403 token_required", async () => {
    inventory.mockResolvedValue(inv("node:a", [model("gemma-4b")]));
    start.mockRejectedValue(new FleetApiError("Set SPARKDASH_TOKEN", 403, "token_required"));
    const onOpenModels = vi.fn();
    const { container } = render(<FleetBoard sparks={[]} onOpenModels={onOpenModels} />);
    await settle();
    await act(async () => button(rowOf(container, "Spark A"), "Switch…").click());
    await settle();
    const dialog = await findDialog();
    await act(async () => dialog.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
    await act(async () => button(dialog, "Review switch").click());
    await act(async () => button(dialog, "Confirm switch").click());
    await settle();
    const hint = rowOf(container, "Spark A").querySelector<HTMLAnchorElement>("a.fb-token")!;
    expect(hint.textContent).toBe("Needs an access token");
    expect(hint.getAttribute("href")).toBe("/models?target=node%3Aa");
    act(() => hint.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
    expect(onOpenModels).toHaveBeenCalledWith("node:a");
  }, 30_000);

  it("shows the token hint up front when the server says control needs a token", async () => {
    status.mockResolvedValue({ enabled: true, smartRoutingEnabled: false, adapters: [], controlRequiresToken: true, tokenConfigured: false });
    const { container } = render(<FleetBoard sparks={[]} />);
    await settle();
    expect(rowOf(container, "Spark A").querySelector("a.fb-token")).not.toBeNull();
    expect(() => button(rowOf(container, "Spark A"), "Switch…")).toThrow();
    // Read-only actions stay.
    expect(button(rowOf(container, "Spark A"), "Logs")).toBeTruthy();
  });

  it("hides itself when the server reports fleet models off, and shows other errors without blocking", async () => {
    targets.mockRejectedValue(new FleetApiError("Fleet model management is turned off", 404, "disabled"));
    const off = render(<FleetBoard sparks={[]} />);
    await settle();
    expect(off.container.textContent).toBe("");

    targets.mockRejectedValue(new FleetApiError("HTTP 500", 500, "internal"));
    const failing = render(<FleetBoard sparks={[]} />);
    await settle();
    expect(failing.container.querySelector('[role="status"]')?.textContent).toContain("Couldn't load the fleet board: HTTP 500");
  });

  it("re-reads the targets every 15 s while visible", async () => {
    vi.useFakeTimers();
    render(<FleetBoard sparks={[]} />);
    await settle();
    expect(targets).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(BOARD_POLL_MS));
    expect(targets).toHaveBeenCalledTimes(2);
  });

  it("links every row to its model controls on the Models page", async () => {
    const onOpenModels = vi.fn();
    const { container } = render(<FleetBoard sparks={[]} onOpenModels={onOpenModels} />);
    await settle();
    const manage = [...rowOf(container, "Spark Duo").querySelectorAll<HTMLAnchorElement>("a")].find((a) => a.textContent === "Manage")!;
    expect(manage.getAttribute("href")).toBe("/models?target=cluster%3Aduo");
    act(() => manage.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
    expect(onOpenModels).toHaveBeenCalledWith("cluster:duo");
  });
});
