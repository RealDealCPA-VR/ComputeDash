import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSettings, updateSettings } from "../api/client";
import type { Settings } from "../api/types";
import { setLocale } from "../i18n";
import { flush, render } from "../testing/render";
import { SettingsDialog } from "./SettingsDialog";

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  fetchSettings: vi.fn(),
  updateSettings: vi.fn(),
}));
vi.mock("../shared/reloadPage", () => ({ reloadPage: vi.fn() }));

const base = { allowPlainSudoPassword: false, timeZone: "" } as unknown as Settings;
const MODELS = "Models page / fleet model manager";
const ROUTING = "Smart routing";
const byLabel = (label: string) => document.body.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement;
const save = (label = "Save") => [...document.body.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;
const policySelect = () => document.body.querySelector<HTMLSelectElement>("#settings-smart-routing-policy");

function setSelect(el: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

async function open(initial: Partial<Settings>) {
  vi.mocked(fetchSettings).mockResolvedValue({ ...base, ...initial });
  vi.mocked(updateSettings).mockImplementation(async (s) => s as Settings);
  render(<SettingsDialog open onClose={() => {}} onSaved={() => {}} />);
  await flush();
}

async function saveNow() {
  await act(async () => save().click());
  await flush();
}

describe("SettingsDialog: Models page and smart routing", () => {
  beforeEach(async () => {
    await setLocale("en");
    vi.mocked(updateSettings).mockClear();
  });

  afterEach(async () => {
    await act(() => setLocale("en"));
  });

  it("defaults: Models page on, smart routing off, no policy picker", async () => {
    await open({});
    expect(byLabel(MODELS).getAttribute("aria-checked")).toBe("true");
    expect(byLabel(ROUTING).getAttribute("aria-checked")).toBe("false");
    expect(byLabel(ROUTING).disabled).toBe(false);
    expect(policySelect()).toBeNull();
    const text = document.body.textContent ?? "";
    expect(text).toContain("Routing only sends requests to models that are already serving; it never starts, stops or switches a model.");
    expect(text).toContain("Manual control on the Models page is unaffected.");
    expect(text).toContain("The proxy requires the dashboard access token (SPARKDASH_TOKEN on the server), sent as Authorization: Bearer <token>.");
    // Settings links ("#settings/routing") land on the smart routing row.
    expect(document.getElementById("settings-section-routing")?.textContent).toContain(ROUTING);
  });

  it("turning the Models page off sends fleetModelsEnabled: false and locks smart routing", async () => {
    await open({ fleetModelsEnabled: true });
    act(() => byLabel(MODELS).click());
    expect(byLabel(MODELS).getAttribute("aria-checked")).toBe("false");
    expect(byLabel(ROUTING).disabled).toBe(true);
    await saveNow();
    expect(updateSettings).toHaveBeenCalledWith({ ...base, fleetModelsEnabled: false });
  });

  it("with the Models page off, smart routing shows off and keeps its stored value", async () => {
    await open({ fleetModelsEnabled: true, smartRoutingEnabled: true, smartRoutingPolicy: "round-robin" });
    expect(byLabel(ROUTING).getAttribute("aria-checked")).toBe("true");
    expect(policySelect()).not.toBeNull();
    act(() => byLabel(MODELS).click());
    expect(byLabel(ROUTING).getAttribute("aria-checked")).toBe("false");
    expect(byLabel(ROUTING).disabled).toBe(true);
    expect(policySelect()).toBeNull();
    await saveNow();
    expect(updateSettings).toHaveBeenCalledWith({ ...base, fleetModelsEnabled: false, smartRoutingEnabled: true, smartRoutingPolicy: "round-robin" });
  });

  it("opened with the Models page off, a stored smart routing choice shows off and comes back with it", async () => {
    await open({ fleetModelsEnabled: false, smartRoutingEnabled: true });
    expect(byLabel(ROUTING).getAttribute("aria-checked")).toBe("false");
    expect(policySelect()).toBeNull();
    act(() => byLabel(MODELS).click());
    expect(byLabel(ROUTING).getAttribute("aria-checked")).toBe("true");
    expect(policySelect()?.value).toBe("least-loaded");
  });

  it("turning smart routing on sends smartRoutingEnabled: true and shows the policy (default least loaded)", async () => {
    await open({ smartRoutingEnabled: false });
    act(() => byLabel(ROUTING).click());
    expect(byLabel(ROUTING).getAttribute("aria-checked")).toBe("true");
    expect(policySelect()?.value).toBe("least-loaded");
    expect(Array.from(policySelect()!.options).map((o) => [o.value, o.textContent])).toEqual([
      ["least-loaded", "Least loaded"],
      ["first-available", "First available"],
      ["round-robin", "Round robin"],
    ]);
    await saveNow();
    expect(updateSettings).toHaveBeenCalledWith({ ...base, smartRoutingEnabled: true });
  });

  it("choosing a policy sends smartRoutingPolicy", async () => {
    await open({ smartRoutingEnabled: true, smartRoutingPolicy: "first-available" });
    expect(policySelect()?.value).toBe("first-available");
    act(() => setSelect(policySelect()!, "round-robin"));
    await saveNow();
    expect(updateSettings).toHaveBeenCalledWith({ ...base, smartRoutingEnabled: true, smartRoutingPolicy: "round-robin" });
  });

  it("turning smart routing off hides the policy and sends smartRoutingEnabled: false", async () => {
    await open({ smartRoutingEnabled: true, smartRoutingPolicy: "round-robin" });
    act(() => byLabel(ROUTING).click());
    expect(policySelect()).toBeNull();
    await saveNow();
    expect(updateSettings).toHaveBeenCalledWith({ ...base, smartRoutingEnabled: false, smartRoutingPolicy: "round-robin" });
  });

  it("is translated in Simplified Chinese", async () => {
    await open({ smartRoutingEnabled: true });
    await act(() => setLocale("zh-CN"));
    expect(byLabel("模型页面 / 集群模型管理器").getAttribute("aria-checked")).toBe("true");
    expect(byLabel("智能路由").getAttribute("aria-checked")).toBe("true");
    expect(document.body.textContent).toContain("它从不启动、停止或切换模型");
    expect(Array.from(policySelect()!.options).map((o) => o.textContent)).toEqual(["负载最低", "首个可用", "轮询"]);
  });
});
