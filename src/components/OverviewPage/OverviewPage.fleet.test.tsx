import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n";
import { makeSpark } from "../../testing/fixtures";
import { render } from "../../testing/render";

// The board has its own tests; here it only has to appear (or not).
vi.mock("../FleetBoard/FleetBoard", () => ({ FleetBoard: () => <section data-testid="fleet-board" /> }));
vi.mock("./FleetEnergyCard", () => ({ FleetEnergyCard: () => null }));
vi.mock("./FleetTokenTotals", () => ({ FleetTokenTotals: () => null }));
vi.mock("./ActivityFeed", () => ({ ActivityFeed: () => null }));

import { OverviewPage } from "./OverviewPage";

afterEach(async () => {
  await act(async () => setLocale("en"));
});

describe("Overview first load and empty fleet", () => {
  it("shows skeletons, not the empty state, before the fleet list arrives", () => {
    const { container } = render(<OverviewPage sparks={[]} loading onAddUnit={() => {}} />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.querySelectorAll(".skel-card").length).toBeGreaterThan(0);
    expect(container.textContent).toContain("Loading the fleet");
    expect(container.textContent).not.toContain("No machines yet");
    expect(container.textContent).not.toContain("…");
  });

  it("offers a primary Add action in the empty state, with copy that names no missing + tab", async () => {
    const onAddUnit = vi.fn();
    const { container } = render(<OverviewPage sparks={[]} onAddUnit={onAddUnit} />);
    expect(container.textContent).toContain("No machines yet");
    expect(container.textContent).not.toMatch(/\+ tab/);
    const add = container.querySelector<HTMLButtonElement>("button.btn--primary")!;
    expect(add.textContent).toBe("Add your first machine");
    act(() => add.click());
    expect(onAddUnit).toHaveBeenCalledOnce();

    await act(async () => setLocale("zh-CN"));
    expect(container.textContent).toContain("还没有机器");
    expect(add.textContent).toBe("添加第一台机器");
  });
});

describe("Overview with the fleet model manager", () => {
  it("shows the fleet board and a Models link on every card only while the feature is on", () => {
    const onOpenModels = vi.fn();
    const sparks = [makeSpark("a"), makeSpark("b", false)];
    const off = render(<OverviewPage sparks={sparks} onOpenModels={onOpenModels} />);
    expect(off.container.querySelector('[data-testid="fleet-board"]')).toBeNull();
    expect(off.container.querySelector(".ov-sc__models")).toBeNull();

    const on = render(<OverviewPage sparks={sparks} showFleetBoard onOpenModels={onOpenModels} />);
    expect(on.container.querySelector('[data-testid="fleet-board"]')).not.toBeNull();
    const links = [...on.container.querySelectorAll<HTMLAnchorElement>("a.ov-sc__models")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/models?target=node%3Aa", "/models?target=node%3Ab"]);
    act(() => links[1].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
    expect(onOpenModels).toHaveBeenCalledWith("node:b");
  });
});
