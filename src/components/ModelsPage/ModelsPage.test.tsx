import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";
import * as client from "../../api/fleetClient";
import { clearToken, onAuthRequired, setToken } from "../../api/authToken";
import { ModelsPage, orderTargets, TARGETS_BUSY_POLL_MS, TARGETS_POLL_MS } from "./ModelsPage";
import { INVENTORY_POLL_MS } from "./TargetModels";
import { TOKEN_ENV_LINE, TOKEN_GENERATE_COMMAND } from "./TokenBanner";
import { BIG, CAPS, DESK, DUO, MAC, SERVING, SMALL, SPARK1, SPARK2, makeInventory, makeModel, makeOperation, makeTarget } from "./fixtures";

vi.mock("../../api/fleetClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/fleetClient")>();
  return {
    FleetApiError: actual.FleetApiError,
    isBusyError: actual.isBusyError,
    isTokenRequiredError: actual.isTokenRequiredError,
    isRoutingDisabledError: actual.isRoutingDisabledError,
    getRouting: vi.fn(),
    resolveRoute: vi.fn(),
    listRoutedModels: vi.fn(),
    getFleetStatus: vi.fn(),
    getTargets: vi.fn(),
    getInventory: vi.fn(),
    startOperation: vi.fn(),
    readOperation: vi.fn(),
    listOperations: vi.fn(),
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
  vi.mocked(client.listOperations).mockResolvedValue({ operations: [] });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  clearToken();
  window.history.replaceState(null, "", "/");
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

async function renderPage(props: { onAddUnit?: () => void } = {}) {
  const view = render(<ModelsPage {...props} />);
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

  it("keeps the routing panel in step with the chip after Refresh", async () => {
    vi.mocked(client.getRouting).mockResolvedValueOnce({ enabled: false, policy: "least-loaded", table: [] });
    const { container } = await renderPage();
    const toggle = container.querySelector<HTMLButtonElement>(".mm-routing__toggle")!;
    expect(client.getRouting).not.toHaveBeenCalled();
    await click(toggle);
    expect(client.getRouting).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".mm-routing")?.textContent).toContain("Smart routing is off.");

    // Routing switched on in Settings; the page's Refresh reloads the open panel too.
    vi.mocked(client.getFleetStatus).mockResolvedValueOnce({ enabled: true, smartRoutingEnabled: true, adapters: [] });
    vi.mocked(client.getRouting).mockResolvedValueOnce({ enabled: true, policy: "round-robin", table: [] });
    const refresh = Array.from(container.querySelectorAll<HTMLButtonElement>(".page-head__tools button")).find((b) => b.textContent === "Refresh")!;
    await click(refresh);
    await flush();
    expect(container.querySelector(".mm-routing-chip")?.textContent).toBe("Smart routing: on");
    expect(client.getRouting).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".mm-routing")?.textContent).not.toContain("Smart routing is off.");
    expect(container.querySelector("[data-testid=routing-policy]")?.textContent).toBe("Round robin");
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

  it("shows only the actions model.actions allows, and says why a row has none", async () => {
    const { container } = await renderPage();
    const labels = (key: string) => Array.from(row(container, key).querySelectorAll("button")).map((b) => b.textContent);
    expect(labels(SERVING.modelKey)).toEqual(["Stop", "Reload", "Logs"]);
    expect(button("Stop", row(container, SERVING.modelKey)).disabled).toBe(false);
    expect(labels(BIG.modelKey)).toEqual(["Start", "Logs"]);
    expect(row(container, SERVING.modelKey).querySelector(".mm-row-reason")).toBeNull();
    // No lifecycle action: only Logs, plus a short visible reason.
    expect(labels("vllm|8000|m-loaded")).toEqual(["Logs"]);
    expect(row(container, "vllm|8000|m-loaded").querySelector(".mm-row-reason")?.textContent).toBe("No action applies in this state");
  });

  it("sorts rows serving, then loaded/starting, then configured/installed, then the rest, by name", async () => {
    const { container } = await renderPage();
    const keys = Array.from(container.querySelectorAll(".mm-table--models tbody tr")).map((r) => r.getAttribute("data-model-key")!.split("|")[2]);
    expect(keys).toEqual([
      "qwen3-32b",
      "m-loaded",
      "m-starting",
      "m-stopping",
      "gemma-4b",
      "llama-405b",
      "m-failed",
      "m-stopped",
      "m-unknown",
      "m-unreachable",
    ]);
  });

  it("explains read-only rows: no launch profile, an engine without load/unload, and Windows", async () => {
    const WIN = makeTarget({ targetId: "node:win", name: "Gaming PC", platform: "windows", capabilities: { distributedControl: false, lifecycle: false } });
    const none = { ...CAPS, start: false, stop: false, load: false, unload: false };
    vi.mocked(client.getTargets).mockResolvedValue({ targets: [SPARK1, WIN], generatedAt: 1 });
    vi.mocked(client.getInventory).mockImplementation(async (targetId) =>
      targetId === "node:win"
        ? makeInventory({
            targetId,
            runtimes: [{ engine: "lmstudio", port: 1234, endpoint: null, reachable: true, capabilities: none, error: null }],
            models: [makeModel("phi-4", "loaded", { modelKey: "lmstudio|1234|phi-4", engine: "lmstudio", port: 1234 })],
            clusterModels: [],
          })
        : makeInventory({
            runtimes: [
              { engine: "sglang", port: 30000, endpoint: null, reachable: true, capabilities: none, error: null, note: "no lifecycle" },
              { engine: "vllm", port: 8000, endpoint: null, reachable: true, capabilities: { ...CAPS, load: false, unload: false }, error: null },
            ],
            models: [
              makeModel("sg-model", "serving", { modelKey: "sglang|30000|sg-model", engine: "sglang", port: 30000 }),
              makeModel("adhoc", "serving", { modelKey: "vllm|8000|adhoc" }),
            ],
            clusterModels: [],
          })
    );
    const { container } = await renderPage();
    expect(row(container, "sglang|30000|sg-model").querySelector(".mm-row-reason")?.textContent).toBe("Engine doesn't support load/unload");
    expect(row(container, "vllm|8000|adhoc").querySelector(".mm-row-reason")?.textContent).toBe("Read-only: no launch profile registered");
    expect(container.textContent).not.toContain("only Ollama models can be started");

    await click(container.querySelector<HTMLElement>('[data-target-id="node:win"]')!);
    expect(row(container, "lmstudio|1234|phi-4").querySelector(".mm-row-reason")?.textContent).toBe("Windows host: only Ollama models can be controlled");
    const notes = Array.from(container.querySelectorAll(".mm-note--platform")).map((n) => n.textContent);
    expect(notes).toEqual(["Windows host: only Ollama models can be started, stopped or switched from here today. Other engines on this machine are shown read-only."]);
  });

  it("says why Switch model is disabled when no model can be switched to", async () => {
    vi.mocked(client.getInventory).mockResolvedValue(makeInventory({ models: [SERVING] }));
    const { container } = await renderPage();
    const sw = button("Switch model");
    expect(sw.disabled).toBe(true);
    const reason = document.getElementById(sw.getAttribute("aria-describedby")!);
    expect(reason?.textContent).toBe("No model on this target can be switched to.");
    expect(container.contains(reason)).toBe(true);
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

  it("locks model control with an actionable banner while the server needs a token it does not have", async () => {
    vi.mocked(client.getFleetStatus).mockResolvedValue({ enabled: true, smartRoutingEnabled: false, adapters: [], controlRequiresToken: true, tokenConfigured: false });
    const { container } = await renderPage();
    const banner = container.querySelector<HTMLElement>("[data-testid=token-banner]")!;
    expect(banner.textContent).toContain("needs an access token on the dashboard host");
    const commands = Array.from(banner.querySelectorAll(".mm-cmd__text")).map((c) => c.textContent);
    expect(commands).toEqual([TOKEN_GENERATE_COMMAND, TOKEN_ENV_LINE]);
    expect(TOKEN_GENERATE_COMMAND).toBe(`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`);
    expect(TOKEN_ENV_LINE).toBe("SPARKDASH_TOKEN=<value>");
    expect(banner.textContent).toContain("Restart the dashboard");
    expect(banner.textContent).toContain("npm run setup does all of this for you.");
    expect(banner.querySelector("a")?.getAttribute("href")).toContain("docs/FLEET-MODELS.md");
    // This is the server's missing token, not this browser's: no "Enter token" offer.
    expect(container.querySelector("[data-testid=token-banner-browser]")).toBeNull();
    const serving = row(container, SERVING.modelKey);
    for (const label of ["Stop", "Reload"]) {
      const b = button(label, serving);
      expect(b.disabled).toBe(true);
      expect(b.hasAttribute("aria-description")).toBe(false);
      // The reason is visible text the button points at.
      const reason = document.getElementById(b.getAttribute("aria-describedby")!);
      expect(reason?.textContent).toContain("needs a dashboard access token");
      expect(container.contains(reason)).toBe(true);
    }
    expect(button("Switch model").disabled).toBe(true);
    expect(document.getElementById(button("Switch model").getAttribute("aria-describedby")!)?.textContent).toContain("needs a dashboard access token");
    // Logs stay available.
    expect(button("View logs").disabled).toBe(false);
    // Cluster edits are locked too.
    await click(button("Clusters"));
    expect(button("New cluster", dialog()!).disabled).toBe(true);
    expect(dialog()!.textContent).toContain("Model control is disabled until the dashboard has an access token");
  });

  it("does not lock control when a token is configured or not required", async () => {
    vi.mocked(client.getFleetStatus).mockResolvedValue({ enabled: true, smartRoutingEnabled: false, adapters: [], controlRequiresToken: true, tokenConfigured: true });
    const { container } = await renderPage();
    expect(container.querySelector("[data-testid=token-banner]")).toBeNull();
    expect(button("Stop", row(container, SERVING.modelKey)).disabled).toBe(false);
    expect(button("Stop", row(container, SERVING.modelKey)).hasAttribute("aria-describedby")).toBe(false);
  });

  it("offers Enter token when the server has a token this browser has not entered", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ tokenRequired: true, authenticated: false }) }));
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(client.getFleetStatus).mockResolvedValue({ enabled: true, smartRoutingEnabled: false, adapters: [], controlRequiresToken: true, tokenConfigured: true });
    const prompts: string[] = [];
    const off = onAuthRequired((reason) => prompts.push(reason));
    try {
      const { container } = await renderPage();
      await flush();
      expect(fetchMock).toHaveBeenCalledWith("/api/auth/status", expect.anything());
      const banner = container.querySelector<HTMLElement>("[data-testid=token-banner-browser]")!;
      expect(banner.textContent).toContain("this browser has not entered it yet");
      expect(container.querySelector("[data-testid=token-banner]")).toBeNull();
      // Control is not locked: the server would accept the token once entered.
      expect(button("Stop", row(container, SERVING.modelKey)).disabled).toBe(false);
      await click(button("Enter token", banner));
      expect(prompts).toEqual(["manual"]);
      // Once a working token is stored, the banner goes away.
      fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({ tokenRequired: true, authenticated: true }) }));
      await act(async () => setToken("secret"));
      await flush();
      expect(container.querySelector("[data-testid=token-banner-browser]")).toBeNull();
    } finally {
      off();
    }
  });

  it("retries the action that hit 401 once the token prompt saves a token", async () => {
    vi.mocked(client.startOperation)
      .mockRejectedValueOnce(new client.FleetApiError("Unauthorized", 401))
      .mockResolvedValueOnce({ operation: makeOperation() });
    const { container } = await renderPage();
    await click(button("Start", row(container, BIG.modelKey)));
    await click(button("Start", dialog()!));
    expect(client.startOperation).toHaveBeenCalledTimes(1);
    expect(dialog()!.querySelector("[role=alert]")?.textContent).toContain("runs again automatically");
    await act(async () => setToken("fresh-token"));
    await flush();
    expect(client.startOperation).toHaveBeenCalledTimes(2);
    expect(client.startOperation).toHaveBeenLastCalledWith("node:spark1", { action: "start", modelKey: BIG.modelKey });
    expect(container.querySelector(".mm-op")).not.toBeNull();
  });

  it("does not retry after the confirmation was cancelled", async () => {
    vi.mocked(client.startOperation).mockRejectedValueOnce(new client.FleetApiError("Unauthorized", 401));
    const { container } = await renderPage();
    await click(button("Start", row(container, BIG.modelKey)));
    await click(button("Start", dialog()!));
    await click(button("Cancel", dialog()!));
    await act(async () => setToken("fresh-token"));
    await flush();
    expect(client.startOperation).toHaveBeenCalledTimes(1);
  });

  it("a 403 token_required answer shows the token message and locks control", async () => {
    vi.mocked(client.startOperation).mockRejectedValue(new client.FleetApiError("Model control requires SPARKDASH_TOKEN", 403, "token_required"));
    const { container } = await renderPage();
    expect(container.querySelector("[data-testid=token-banner]")).toBeNull();
    await click(button("Start", row(container, BIG.modelKey)));
    await click(button("Start", dialog()!));
    expect(dialog()!.querySelector("[role=alert]")?.textContent).toContain("Model control is disabled until the dashboard has an access token");
    expect(container.querySelector("[data-testid=token-banner]")).not.toBeNull();
    expect(button("Stop", row(container, SERVING.modelKey)).disabled).toBe(true);
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
    expect(names).toEqual(["Stop qwen3-32b", "Reload qwen3-32b", "Logs for qwen3-32b"]);
    expect(Array.from(row(container, BIG.modelKey).querySelectorAll("button")).map((b) => b.getAttribute("aria-label"))).toEqual(["Start llama-405b", "Logs for llama-405b"]);
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
    inv.runtimes[1] = { ...inv.runtimes[1], requestsRunning: null, via: "ssh-tunnel" };
    inv.models = inv.models.map((m) =>
      m.modelId === "m-unreachable" ? { ...m, lastSeen: { state: "serving" as const, at: Date.now() - 5 * 60_000 } } : m.modelId === "m-stopped" ? { ...m, lastSeen: { state: "serving" as const, at: 0 } } : m
    );
    vi.mocked(client.getInventory).mockResolvedValue(inv);
    const { container } = await renderPage();
    const runtimes = container.querySelectorAll(".mm-runtime");
    expect(runtimes[0].textContent).toContain("2 requests running");
    expect(runtimes[0].querySelector(".mm-runtime__note")?.textContent).toBe("load/unload needs the lms CLI <raw>");
    expect(runtimes[1].textContent).not.toContain("request");
    expect(runtimes[1].querySelector(".mm-runtime__via")?.textContent).toBe("via SSH tunnel");
    expect(runtimes[0].querySelector(".mm-runtime__via")).toBeNull();
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

  it("re-reads targets every 5 s while any target is busy, then every 15 s once none is", async () => {
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
        await vi.advanceTimersByTimeAsync(TARGETS_BUSY_POLL_MS * 2);
      });
      expect(client.getTargets).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TARGETS_POLL_MS);
      });
      expect(client.getTargets).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-reads the target list every 15 s and the selected inventory every 20 s from the cache", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(client.getTargets).mockResolvedValue({ targets: [SPARK1, MAC], generatedAt: 1 });
      await renderPage();
      expect(client.getTargets).toHaveBeenCalledTimes(1);
      expect(client.getInventory).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TARGETS_BUSY_POLL_MS * 2);
      });
      expect(client.getTargets).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TARGETS_POLL_MS - TARGETS_BUSY_POLL_MS * 2);
      });
      expect(client.getTargets).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(INVENTORY_POLL_MS - TARGETS_POLL_MS);
      });
      expect(client.getInventory).toHaveBeenCalledTimes(2);
      // The timer never forces discovery: the server keeps its own cache.
      expect(client.getInventory).toHaveBeenLastCalledWith("node:spark1", false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the page Refresh also rediscovers the selected target's inventory", async () => {
    await renderPage();
    expect(client.getInventory).toHaveBeenCalledTimes(1);
    const refresh = Array.from(document.querySelectorAll<HTMLButtonElement>(".page-head__tools button")).find((b) => b.textContent === "Refresh")!;
    await click(refresh);
    await flush();
    expect(client.getInventory).toHaveBeenCalledTimes(2);
    expect(client.getInventory).toHaveBeenLastCalledWith("node:spark1", true);
  });

  it("flags an inventory collected more than a minute ago as stale", async () => {
    vi.mocked(client.getInventory).mockResolvedValue(makeInventory({ collectedAt: Date.now() - 5 * 60_000 }));
    const first = await renderPage();
    expect(first.container.querySelector(".mm-age-badge")?.textContent).toBe("stale");
    vi.mocked(client.getInventory).mockResolvedValue(makeInventory({ collectedAt: Date.now() }));
    await click(button("Refresh inventory"));
    expect(first.container.querySelector(".mm-age-badge")).toBeNull();
  });

  it("reattaches an operation still running on the server, so its progress survives navigation", async () => {
    vi.mocked(client.listOperations).mockResolvedValue({ operations: [makeOperation({ id: "op-9", targetId: "node:spark1" })] });
    const { container } = await renderPage();
    expect(client.listOperations).toHaveBeenCalledWith(true);
    expect(container.querySelector(".mm-op")?.textContent).toContain("Start llama-405b");
    expect(client.readOperation).toHaveBeenCalledWith("op-9", undefined);
    expect(button("Switch model").disabled).toBe(true);
  });

  it("asks again for operations when a target reports one it is not tracking", async () => {
    vi.mocked(client.getTargets).mockResolvedValue({ targets: [{ ...SPARK1, busy: true, activeOperationId: "op-7" }, MAC], generatedAt: 1 });
    vi.mocked(client.listOperations)
      .mockResolvedValueOnce({ operations: [] })
      .mockResolvedValue({ operations: [makeOperation({ id: "op-7" })] });
    const { container } = await renderPage();
    await flush();
    expect(vi.mocked(client.listOperations).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector(".mm-op")).not.toBeNull();
  });

  it("degrades silently when the server has no operations list", async () => {
    vi.mocked(client.listOperations).mockRejectedValue(new client.FleetApiError("Not found", 404));
    const { container } = await renderPage();
    expect(container.querySelector(".mm-op")).toBeNull();
    expect(container.querySelector("[role=alert]")).toBeNull();
    expect(container.querySelector(".mm-table--models")).not.toBeNull();
  });

  it("selects the target named by ?target= and keeps the URL in step with the selection", async () => {
    window.history.replaceState(null, "", "/models?target=node%3Amac");
    const { container } = await renderPage();
    expect(container.querySelector('[data-target-id="node:mac"]')?.getAttribute("aria-current")).toBe("true");
    expect(client.getInventory).toHaveBeenCalledWith("node:mac", false);
    await click(container.querySelector<HTMLElement>('[data-target-id="node:spark2"]')!);
    expect(new URLSearchParams(window.location.search).get("target")).toBe("node:spark2");
    expect(window.location.pathname).toBe("/models");
  });

  it("falls back to the first target for an unknown ?target=", async () => {
    window.history.replaceState(null, "", "/models?target=node:gone");
    const { container } = await renderPage();
    expect(container.querySelector('[data-target-id="node:spark1"]')?.getAttribute("aria-current")).toBe("true");
    expect(new URLSearchParams(window.location.search).get("target")).toBe("node:spark1");
  });

  it("scrolls the details into view after a selection in the stacked layout", async () => {
    const scroll = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("max-width"), media: query }));
    try {
      const { container } = await renderPage();
      expect(scroll).not.toHaveBeenCalled();
      await click(container.querySelector<HTMLElement>('[data-target-id="node:mac"]')!);
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(scroll.mock.contexts[0]).toHaveProperty("classList");
      expect((scroll.mock.contexts[0] as HTMLElement).classList.contains("mm-detail")).toBe(true);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("shows which model each target serves, and a running operation", async () => {
    vi.mocked(client.getTargets).mockResolvedValue({
      targets: [
        { ...SPARK1, servingModels: ["qwen3-32b"] },
        { ...SPARK2, busy: false, servingModels: ["llama-405b", "gemma-4b", "phi-4"], activeOperationId: "op-3" },
        { ...MAC, servingModels: null },
        { ...DUO, servingModels: [] },
        DESK,
      ],
      generatedAt: 1,
    });
    const { container } = await renderPage();
    const serving = (id: string) => container.querySelector(`[data-target-id="${id}"] .mm-target__serving`)!;
    expect(serving("node:spark1").textContent).toBe("Serving qwen3-32b");
    expect(serving("node:spark2").textContent).toBe("Serving llama-405b +2");
    expect(serving("node:spark2").getAttribute("title")).toBe("Serving: llama-405b, gemma-4b, phi-4");
    expect(serving("node:mac").textContent).toBe("serving: unknown");
    expect(serving("node:mac").className).toContain("mm-unknown");
    expect(serving("cluster:duo").textContent).toBe("nothing serving");
    // Older servers: the count is still shown.
    expect(serving("cluster:desk").textContent).toBe("0 models serving");
    expect(container.querySelector('[data-target-id="node:spark2"]')?.textContent).toContain("Operation running");
    expect(container.querySelector('[data-target-id="node:spark1"]')?.textContent).not.toContain("Operation running");
  });

  it("empty fleet: offers Add a machine when the shell passes onAddUnit, and only then", async () => {
    vi.mocked(client.getTargets).mockResolvedValue({ targets: [], generatedAt: 1 });
    const onAddUnit = vi.fn();
    const withAdd = await renderPage({ onAddUnit });
    const add = button("Add a machine", withAdd.container);
    expect(add.className).toContain("btn--primary");
    await click(add);
    expect(onAddUnit).toHaveBeenCalledTimes(1);
    const without = await renderPage();
    expect(without.container.textContent).toContain("No machines yet");
    expect(buttons(without.container).some((b) => b.textContent === "Add a machine")).toBe(false);
  });

  it("shows a target load error instead of an empty list", async () => {
    vi.mocked(client.getTargets).mockRejectedValue(new Error("fleet <raw> offline"));
    const { container } = await renderPage();
    expect(container.querySelector("[role=alert]")?.textContent).toContain("fleet <raw> offline");
    expect(container.querySelector("[data-target-id]")).toBeNull();
  });
});
