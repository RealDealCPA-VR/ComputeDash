import { useEffect, useRef } from "react";

/**
 * Calls `fn` now and then every `intervalMs` while the browser tab is visible.
 *
 * Polling pauses while the tab is hidden and runs once as soon as it becomes
 * visible again, so a background tab costs the server nothing and a returning
 * user never looks at data older than one interval. The latest `fn` is always
 * used without restarting the timer. Pass `enabled: false` (or an interval
 * ≤ 0) to stop polling. Changing `intervalMs` or `enabled` restarts it.
 *
 * Calls never overlap: a tick that fires while the previous call's promise is
 * still pending is skipped.
 */
export function useVisiblePolling(
  fn: () => void | Promise<unknown>,
  intervalMs: number,
  { enabled = true, immediate = true }: { enabled?: boolean; immediate?: boolean } = {}
): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled || !(intervalMs > 0)) return;
    let cancelled = false;
    let running = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

    const tick = () => {
      if (cancelled || running || hidden()) return;
      let result: void | Promise<unknown>;
      try {
        result = fnRef.current();
      } catch {
        return;
      }
      if (result && typeof (result as Promise<unknown>).then === "function") {
        running = true;
        (result as Promise<unknown>).then(
          () => { running = false; },
          () => { running = false; }
        );
      }
    };

    const start = () => {
      if (timer == null) timer = setInterval(tick, intervalMs);
    };
    const stop = () => {
      if (timer != null) clearInterval(timer);
      timer = null;
    };

    const onVisibility = () => {
      if (hidden()) {
        stop();
      } else {
        tick();
        start();
      }
    };

    if (immediate) tick();
    if (!hidden()) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs, enabled, immediate]);
}
