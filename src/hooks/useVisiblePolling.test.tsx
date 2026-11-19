import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVisiblePolling } from "./useVisiblePolling";
import { cleanupRenders, render } from "../testing/render";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

function Probe({ fn, ms = 1000, enabled = true }: { fn: () => void | Promise<unknown>; ms?: number; enabled?: boolean }) {
  useVisiblePolling(fn, ms, { enabled });
  return null;
}

describe("useVisiblePolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility("visible");
  });
  afterEach(() => {
    cleanupRenders();
    vi.useRealTimers();
    setVisibility("visible");
  });

  it("calls immediately and then on every interval", () => {
    const fn = vi.fn();
    render(<Probe fn={fn} />);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("pauses while the tab is hidden and catches up once when it is shown", () => {
    const fn = vi.fn();
    render(<Probe fn={fn} />);
    setVisibility("hidden");
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    expect(fn).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("never overlaps a call that is still pending", async () => {
    let resolve: () => void = () => {};
    const fn = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    render(<Probe fn={fn} />);
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve();
      await Promise.resolve();
    });
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does nothing when disabled and stops on unmount", () => {
    const fn = vi.fn();
    const { root } = render(<Probe fn={fn} enabled={false} />);
    vi.advanceTimersByTime(3000);
    expect(fn).not.toHaveBeenCalled();
    act(() => root.render(<Probe fn={fn} enabled />));
    expect(fn).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("uses the latest callback without restarting the timer", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { root } = render(<Probe fn={first} />);
    act(() => root.render(<Probe fn={second} />));
    vi.advanceTimersByTime(1000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
