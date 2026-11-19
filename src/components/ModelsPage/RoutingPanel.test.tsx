import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";
import * as client from "../../api/fleetClient";
import { FleetApiError } from "../../api/fleetClient";
import type { RoutingView } from "../../api/fleetTypes";
import { setLocale } from "../../i18n";
import { RoutingPanel, routingBaseUrl } from "./RoutingPanel";
import { DUO, SPARK1 } from "./fixtures";

vi.mock("../../api/fleetClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/fleetClient")>();
  return {
    FleetApiError: actual.FleetApiError,
    isRoutingDisabledError: actual.isRoutingDisabledError,
    getRouting: vi.fn(),
    resolveRoute: vi.fn(),
  };
});

const ON: RoutingView = {
  enabled: true,
  policy: "round-robin",
  table: [
    {
      model: "Qwen/Qwen3-8B",
      targets: [
        { targetId: "node:spark1", endpoint: "http://10.0.0.1:8000", load: 2 },
        { targetId: "cluster:duo", endpoint: "http://10.0.0.2:8000", load: null },
      ],
    },
  ],
};

const buttons = () => Array.from(document.body.querySelectorAll("button"));
function button(text: string): HTMLButtonElement {
  const found = buttons().find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no button "${text}" in: ${buttons().map((b) => b.textContent).join(" | ")}`);
  return found;
}
const toggle = () => document.body.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
async function click(el: HTMLElement) {
  await act(async () => el.click());
  await flush();
}
function setValue(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
const modelInput = () => {
  const label = Array.from(document.body.querySelectorAll("label")).find((l) => l.textContent === "Model")!;
  return document.body.querySelector<HTMLInputElement>(`#${CSS.escape(label.htmlFor)}`)!;
};
async function resolveModel(name: string) {
  act(() => setValue(modelInput(), name));
  await click(button("Resolve"));
}

async function renderOpen() {
  render(<RoutingPanel targets={[SPARK1, DUO]} defaultOpen />);
  await flush();
}

beforeEach(async () => {
  await setLocale("en");
  vi.mocked(client.getRouting).mockResolvedValue(ON);
});

afterEach(async () => {
  vi.clearAllMocks();
  await act(() => setLocale("en"));
});

describe("RoutingPanel", () => {
  it("starts collapsed and loads only when expanded", async () => {
    render(<RoutingPanel targets={[]} />);
    await flush();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(client.getRouting).not.toHaveBeenCalled();
    await click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(client.getRouting).toHaveBeenCalledTimes(1);
    // Collapsing and expanding again keeps the loaded view; Refresh re-reads it.
    await click(toggle());
    await click(toggle());
    expect(client.getRouting).toHaveBeenCalledTimes(1);
    await click(button("Refresh"));
    expect(client.getRouting).toHaveBeenCalledTimes(2);
  });

  it("explains the off state and links to Settings", async () => {
    vi.mocked(client.getRouting).mockResolvedValue({ enabled: false, policy: "least-loaded", table: [] });
    await renderOpen();
    expect(document.body.textContent).toContain("Smart routing is off.");
    expect(document.body.textContent).toContain("never starts, stops or switches a model");
    const link = document.body.querySelector<HTMLAnchorElement>("a.settings-link")!;
    expect(link.getAttribute("href")).toBe("#settings/routing");
    expect(link.textContent).toBe("Turn it on in Settings");
    expect(document.body.querySelector("table")).toBeNull();
    expect(document.body.querySelector("form")).toBeNull();
  });

  it("treats a routing_disabled 404 as off", async () => {
    vi.mocked(client.getRouting).mockRejectedValue(new FleetApiError("Smart routing is disabled", 404, "routing_disabled"));
    await renderOpen();
    expect(document.body.textContent).toContain("Smart routing is off.");
    expect(document.body.querySelector("[role=alert]")).toBeNull();
  });

  it("shows other load errors", async () => {
    vi.mocked(client.getRouting).mockRejectedValue(new FleetApiError("boom", 500));
    await renderOpen();
    expect(document.body.querySelector("[role=alert]")?.textContent).toBe("Could not load smart routing: boom");
  });

  it("shows the policy, base URL, token note and route table with names and unknown load", async () => {
    await renderOpen();
    expect(document.body.querySelector("[data-testid=routing-policy]")?.textContent).toBe("Round robin");
    expect(document.body.querySelector("[data-testid=routing-base-url]")?.textContent).toBe(`${window.location.origin}/api/fleet/v1`);
    expect(routingBaseUrl("http://x:3000")).toBe("http://x:3000/api/fleet/v1");
    expect(document.body.textContent).toContain("The proxy requires the dashboard's access token (SPARKDASH_TOKEN on the server), sent as Authorization: Bearer <token>.");
    expect(document.body.querySelector("[data-testid=routing-token-warning]")).toBeNull();
    const rows = Array.from(document.body.querySelectorAll<HTMLTableRowElement>("tbody tr"));
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector("th")?.textContent).toBe("Qwen/Qwen3-8B");
    expect(rows[0].querySelector("th")?.getAttribute("rowspan")).toBe("2");
    expect(Array.from(rows[0].querySelectorAll("td")).map((c) => c.textContent)).toEqual(["Spark 1", "http://10.0.0.1:8000", "2"]);
    expect(Array.from(rows[1].querySelectorAll("td")).map((c) => c.textContent)).toEqual(["Spark Duo", "http://10.0.0.2:8000", "unknown"]);
  });

  it("says when nothing is routable", async () => {
    vi.mocked(client.getRouting).mockResolvedValue({ enabled: true, policy: "least-loaded", table: [] });
    await renderOpen();
    expect(document.body.textContent).toContain("No reachable node or cluster is serving a model right now.");
    expect(document.body.querySelector("[data-testid=routing-policy]")?.textContent).toBe("Least loaded");
  });

  it("resolves a model and shows the chosen target and reason", async () => {
    vi.mocked(client.resolveRoute).mockResolvedValue({
      target: SPARK1,
      targetId: "node:spark1",
      endpoint: "http://10.0.0.1:8000",
      model: "Qwen/Qwen3-8B",
      policy: "round-robin",
      load: 2,
      reason: 'case-insensitive match for "Qwen/Qwen3-8B"',
    });
    await renderOpen();
    expect(button("Resolve").disabled).toBe(true);
    await resolveModel("  qwen/qwen3-8b ");
    expect(client.resolveRoute).toHaveBeenCalledWith("qwen/qwen3-8b");
    const result = document.body.querySelector("[data-testid=routing-result]")!;
    expect(result.textContent).toContain("A request would go to Spark 1 at http://10.0.0.1:8000.");
    expect(result.textContent).toContain("Served model: Qwen/Qwen3-8B · Running requests: 2 · Policy: Round robin");
    expect(result.textContent).toContain('Reason: case-insensitive match for "Qwen/Qwen3-8B"');
  });

  it("shows a no-route result and request errors clearly", async () => {
    vi.mocked(client.resolveRoute).mockResolvedValueOnce({
      target: null,
      targetId: null,
      endpoint: null,
      model: null,
      policy: "round-robin",
      load: null,
      reason: 'No target is serving "nope"',
    });
    await renderOpen();
    await resolveModel("nope");
    expect(document.body.querySelector("[data-testid=routing-result]")?.textContent).toBe('No route: No target is serving "nope"');

    vi.mocked(client.resolveRoute).mockRejectedValueOnce(new FleetApiError("model must be a non-empty string", 400, "invalid_model"));
    await resolveModel("x");
    expect(document.body.querySelector("[role=alert]")?.textContent).toBe("Could not resolve the model: model must be a non-empty string");
    expect(document.body.querySelector("[data-testid=routing-result]")).toBeNull();
  });

  it("switches to the off state when a resolve says routing was turned off", async () => {
    vi.mocked(client.resolveRoute).mockRejectedValue(new FleetApiError("Smart routing is disabled", 404, "routing_disabled"));
    await renderOpen();
    await resolveModel("Qwen/Qwen3-8B");
    expect(document.body.textContent).toContain("Smart routing is off.");
    expect(document.body.querySelector("[role=alert]")).toBeNull();
  });

  it("reloads while open when the page refreshes or the routing switch changes, and drops an old resolve", async () => {
    vi.mocked(client.getRouting).mockResolvedValueOnce({ enabled: false, policy: "least-loaded", table: [] });
    const view = render(<RoutingPanel targets={[SPARK1, DUO]} defaultOpen smartRoutingEnabled={false} refreshKey={1} />);
    await flush();
    expect(client.getRouting).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("Smart routing is off.");

    // Routing turned on in Settings, then the page refreshed: the panel follows the chip.
    act(() => view.root.render(<RoutingPanel targets={[SPARK1, DUO]} defaultOpen smartRoutingEnabled refreshKey={2} />));
    await flush();
    expect(client.getRouting).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain("Smart routing is off.");
    expect(document.body.querySelector("[data-testid=routing-policy]")?.textContent).toBe("Round robin");

    vi.mocked(client.resolveRoute).mockResolvedValue({ target: SPARK1, targetId: "node:spark1", endpoint: "http://10.0.0.1:8000", model: "Qwen/Qwen3-8B", policy: "round-robin", load: 2, reason: "exact match" });
    await resolveModel("Qwen/Qwen3-8B");
    expect(document.body.querySelector("[data-testid=routing-result]")).not.toBeNull();

    // A page refresh alone reloads too, and the old answer goes away.
    act(() => view.root.render(<RoutingPanel targets={[SPARK1, DUO]} defaultOpen smartRoutingEnabled refreshKey={3} />));
    await flush();
    expect(client.getRouting).toHaveBeenCalledTimes(3);
    expect(document.body.querySelector("[data-testid=routing-result]")).toBeNull();

    // Same props: no extra request.
    act(() => view.root.render(<RoutingPanel targets={[SPARK1, DUO]} defaultOpen smartRoutingEnabled refreshKey={3} />));
    await flush();
    expect(client.getRouting).toHaveBeenCalledTimes(3);
  });

  it("does not fetch while collapsed; the next open catches up once", async () => {
    const view = render(<RoutingPanel targets={[]} smartRoutingEnabled={false} refreshKey={1} />);
    await flush();
    act(() => view.root.render(<RoutingPanel targets={[]} smartRoutingEnabled refreshKey={2} />));
    await flush();
    expect(client.getRouting).not.toHaveBeenCalled();
    await click(toggle());
    expect(client.getRouting).toHaveBeenCalledTimes(1);
  });

  it("warns that proxy clients get 403 while the server has no token, but the tester still resolves", async () => {
    vi.mocked(client.resolveRoute).mockResolvedValue({ target: SPARK1, targetId: "node:spark1", endpoint: "http://10.0.0.1:8000", model: "Qwen/Qwen3-8B", policy: "round-robin", load: 0, reason: "exact match" });
    render(<RoutingPanel targets={[SPARK1, DUO]} defaultOpen controlRequiresToken tokenConfigured={false} />);
    await flush();
    expect(document.body.querySelector("[data-testid=routing-token-warning]")?.textContent).toContain("clients calling this URL get 403 until SPARKDASH_TOKEN is set");
    await resolveModel("Qwen/Qwen3-8B");
    expect(document.body.querySelector("[data-testid=routing-result]")?.textContent).toContain("A request would go to Spark 1");
  });

  it("does not warn once a token is configured", async () => {
    render(<RoutingPanel targets={[]} defaultOpen controlRequiresToken tokenConfigured />);
    await flush();
    expect(document.body.querySelector("[data-testid=routing-token-warning]")).toBeNull();
  });

  it("caps the resolve input at 256 characters", async () => {
    await renderOpen();
    expect(modelInput().maxLength).toBe(256);
  });

  it("is translated in Simplified Chinese", async () => {
    await act(() => setLocale("zh-CN"));
    await renderOpen();
    expect(toggle().textContent).toContain("智能路由");
    expect(document.body.querySelector("[data-testid=routing-policy]")?.textContent).toBe("轮询");
    expect(document.body.textContent).toContain("路由表");
    expect(document.body.textContent).toContain("未知");
    expect(document.body.textContent).not.toContain("Route table");
  });
});
