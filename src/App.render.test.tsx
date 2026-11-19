import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSpark } from "./testing/fixtures";
import { render, flush } from "./testing/render";

const mocks = vi.hoisted(() => ({
  snapshot: {} as Record<string, unknown>,
  overviewRenders: 0,
  overviewProps: null as Record<string, unknown> | null,
  fetchSettings: vi.fn(),
  fetchHealth: vi.fn(),
  fetchSparks: vi.fn(),
  chipOpen: null as ((id?: string | null) => void) | null,
}));
vi.mock("./hooks/useSnapshot", () => ({ useSnapshot: () => mocks.snapshot }));
vi.mock("./hooks/useRoute", () => ({ useAppRoute: () => ({ mode: "dashboard" }), useRoute: () => ({ navigate: vi.fn(), replace: vi.fn() }) }));
vi.mock("./hooks/useFleetAlerts", () => ({ useFleetAlerts: () => ({ rows: [], ready: false }) }));
vi.mock("./hooks/useBrowserAlerts", () => ({ useBrowserAlerts: () => {} }));
vi.mock("./hooks/useSmoothWheel", () => ({ useSmoothWheel: () => {} }));
vi.mock("./api/client", () => ({ fetchSettings: mocks.fetchSettings, fetchHealth: mocks.fetchHealth, fetchSparks: mocks.fetchSparks, reorderSparks: vi.fn() }));
vi.mock("./api/fleetClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api/fleetClient")>()),
  listOperations: vi.fn().mockResolvedValue({ operations: [] }),
}));
vi.mock("./components/OverviewPage/OverviewPage", () => ({
  OverviewPage: (props: Record<string, unknown>) => {
    mocks.overviewRenders += 1;
    mocks.overviewProps = props;
    return null;
  },
}));
vi.mock("./components/SparkPage/HermesUpdateDialog", () => ({ HermesUpdateDialog: () => null }));
vi.mock("./components/ModelsPage/ModelsPage", () => ({ ModelsPage: () => null }));
vi.mock("./components/shell/OperationChip", () => ({
  OperationChip: (props: { onOpen: (id?: string | null) => void }) => {
    mocks.chipOpen = props.onOpen;
    return null;
  },
}));
vi.mock("./components/AccessTokenDialog", () => ({ AccessTokenPrompt: () => null }));

import App from "./App";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 19, 12, 0, 0));
  mocks.overviewRenders = 0;
  mocks.overviewProps = null;
  mocks.snapshot = {
    sparks: [makeSpark("alpha")],
    activeId: "__overview__",
    activeSpark: null,
    connected: true,
    lastValidSnapshotAt: Date.now(),
    snapshotError: null,
    refreshInterval: 2000,
    setActiveId: vi.fn(),
    serverAlerts: [],
  };
  mocks.fetchSettings.mockResolvedValue({});
  mocks.fetchHealth.mockResolvedValue({ authMode: "token", version: "test" });
  mocks.fetchSparks.mockReset();
  mocks.fetchSparks.mockResolvedValue({ sparks: [] });
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe("App rendering cost", () => {
  it("does not re-render the page tree every second while telemetry is fresh", async () => {
    render(<App />);
    await flush();
    const settled = mocks.overviewRenders;
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(mocks.overviewRenders).toBe(settled);
  });

  it("flips the banner to stale exactly when the last snapshot is staleAfterMs old", async () => {
    const { container } = render(<App />);
    await flush();
    expect(container.querySelector(".connection-banner")).toBeNull();
    // refreshInterval 2 s → stale after max(10 s, 3 × 2 s) = 10 s.
    await act(async () => vi.advanceTimersByTime(9_900));
    expect(container.querySelector(".connection-banner")).toBeNull();
    expect(container.querySelector("main")?.className ?? "").not.toContain("telemetry-stale");
    await act(async () => vi.advanceTimersByTime(200));
    expect(container.querySelector(".connection-banner")?.textContent).toContain("Telemetry is stale. Last valid update was 10s ago.");
    expect(container.querySelector("main")?.className).toContain("telemetry-stale");
    // The age keeps ticking inside the banner only.
    const rendersWhileStale = mocks.overviewRenders;
    await act(async () => vi.advanceTimersByTime(3_000));
    expect(container.querySelector(".connection-banner")?.textContent).toContain("13s ago");
    expect(mocks.overviewRenders).toBe(rendersWhileStale);
  });

  it("hands the Overview its loading state, the Add action and the Models link", async () => {
    render(<App />);
    await flush();
    expect(mocks.overviewProps?.loading).toBe(false);
    expect(typeof mocks.overviewProps?.onAddUnit).toBe("function");
    expect(mocks.overviewProps?.showFleetBoard).toBe(true);
    expect(typeof mocks.overviewProps?.onOpenModels).toBe("function");
    const pushState = vi.spyOn(window.history, "pushState");
    act(() => (mocks.overviewProps!.onOpenModels as (id: string) => void)("node:alpha"));
    expect(pushState).toHaveBeenCalledWith(null, "", "/models?target=node%3Aalpha");
    expect(mocks.snapshot.setActiveId).toHaveBeenCalledWith("__models__");
  });

  it("leaves the first-load skeleton when the REST list answers empty and no WebSocket snapshot ever comes", async () => {
    mocks.snapshot = { ...mocks.snapshot, sparks: [], connected: false, lastValidSnapshotAt: null };
    render(<App />);
    await flush();
    expect(mocks.overviewProps?.loading).toBe(true);
    await act(async () => vi.advanceTimersByTime(3_000));
    await flush();
    expect(mocks.fetchSparks).toHaveBeenCalledTimes(1);
    expect(mocks.overviewProps?.loading).toBe(false);
    // Known now: no further probes.
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(mocks.fetchSparks).toHaveBeenCalledTimes(1);
  });

  it("does not probe the REST list while WebSocket snapshots arrive", async () => {
    render(<App />);
    await flush();
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(mocks.fetchSparks).not.toHaveBeenCalled();
  });

  it("opening Models while already on that URL adds no history entry and no popstate", async () => {
    window.history.replaceState(null, "", "/models");
    mocks.snapshot = { ...mocks.snapshot, activeId: "__models__" };
    render(<App />);
    await flush();
    const pushState = vi.spyOn(window.history, "pushState");
    const popstate = vi.fn();
    window.addEventListener("popstate", popstate);
    expect(mocks.chipOpen).toBeTypeOf("function");
    act(() => mocks.chipOpen!(null));
    window.removeEventListener("popstate", popstate);
    expect(pushState).not.toHaveBeenCalled();
    expect(popstate).not.toHaveBeenCalled();
    window.history.replaceState(null, "", "/");
  });
});
