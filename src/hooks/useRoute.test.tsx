import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppRoute, useRoute, type AppRoute, type RouteActions } from "./useRoute";
import { render } from "../testing/render";

describe("useRoute", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  function setup() {
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    const setActive = vi.fn();
    let actions!: RouteActions;
    function Probe() {
      actions = useRoute(setActive);
      return null;
    }
    render(<Probe />);
    return { setActive, actions: () => actions };
  }

  it("navigate pushes a history entry and sets the id", () => {
    const { setActive, actions } = setup();
    const before = window.history.length;
    act(() => actions().navigate("alpha"));
    expect(window.location.pathname).toBe("/spark/alpha");
    expect(window.history.length).toBe(before + 1);
    expect(setActive).toHaveBeenCalledWith("alpha");
  });

  it("replace rewrites the URL in place", () => {
    const { setActive, actions } = setup();
    act(() => actions().navigate("alpha"));
    const len = window.history.length;
    act(() => actions().replace(null));
    expect(window.location.pathname).toBe("/");
    expect(window.history.length).toBe(len);
    expect(setActive).toHaveBeenLastCalledWith(null);
  });

  it("popstate on the same view (only the query changed) skips the page transition", () => {
    const start = vi.fn((update: () => void) => {
      update();
      return { finished: Promise.resolve() };
    });
    const doc = document as unknown as { startViewTransition?: unknown };
    doc.startViewTransition = start;
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn(() => ({ matches: false })) as unknown as typeof window.matchMedia;
    const setActive = vi.fn();
    function Probe({ active }: { active: string | null }) {
      useRoute(setActive, active);
      return null;
    }
    try {
      render(<Probe active="__models__" />);
      window.history.replaceState(null, "", "/models?target=node%3Aa");
      act(() => {
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      expect(setActive).toHaveBeenLastCalledWith("__models__");
      expect(start).not.toHaveBeenCalled();
      // A different view still cross-fades.
      window.history.replaceState(null, "", "/energy");
      act(() => {
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      expect(start).toHaveBeenCalledTimes(1);
      expect(setActive).toHaveBeenLastCalledWith("__energy__");
    } finally {
      delete doc.startViewTransition;
      window.matchMedia = originalMatchMedia;
    }
  });

  it("popstate sets the id from the URL", () => {
    const { setActive } = setup();
    window.history.replaceState(null, "", "/energy");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(setActive).toHaveBeenCalledWith("__energy__");
  });
});

describe("useAppRoute", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  function routeAt(path: string): AppRoute {
    window.history.replaceState(null, "", path);
    let route!: AppRoute;
    function Probe() {
      route = useAppRoute();
      return null;
    }
    render(<Probe />);
    return route;
  }

  it("opens the kiosk on /kiosk, with or without a query, and the app elsewhere", () => {
    expect(routeAt("/kiosk").mode).toBe("kiosk");
    expect(routeAt("/kiosk/?fit=scroll").mode).toBe("kiosk");
    expect(routeAt("/kiosks").mode).toBe("app");
    expect(routeAt("/showcase/spark-1")).toEqual({ mode: "showcase", showcaseSparkId: "spark-1" });
  });
});
