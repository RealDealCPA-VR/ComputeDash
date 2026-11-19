import { useCallback, useEffect, useState } from "react";
import { onTokenChange } from "../../api/authToken";
import { FleetApiError, listOperations } from "../../api/fleetClient";
import type { FleetOperation } from "../../api/fleetTypes";
import { useVisiblePolling } from "../../hooks/useVisiblePolling";

/**
 * Results younger than this are shared, so the shell chip and the fleet board cost one request.
 * Both poll every 5 s on independent timers; a window just under that interval makes them share
 * whatever their phase offset (a 2 s window only did when the timers happened to line up).
 */
const SHARE_MS = 4_000;
let shared: { at: number; promise: Promise<FleetOperation[]> } | null = null;

/** Running fleet operations, de-duplicated across callers within a short window. */
export function fetchActiveOperations(now: number = Date.now()): Promise<FleetOperation[]> {
  if (shared && now - shared.at < SHARE_MS) return shared.promise;
  const promise = listOperations(true).then((res) =>
    (Array.isArray(res?.operations) ? res.operations : []).filter((op) => op?.status === "running")
  );
  shared = { at: now, promise };
  promise.catch(() => {
    if (shared?.promise === promise) shared = null;
  });
  return promise;
}

/** Test hook: forget the shared result. */
export function resetActiveOperationsCache(): void {
  shared = null;
}

export type ActiveOperationsState = {
  /** null until the first answer, or while the endpoint is unavailable. */
  operations: FleetOperation[] | null;
  /** The server has no such endpoint (404, older server or feature off) or refused it (401/403). */
  unavailable: boolean;
};

/**
 * Polls the running fleet operations while `enabled` (visibility-aware). A 404 stops polling for
 * this mount (older server). 401/403 stop it too, quietly, until a new access token is saved.
 * Network errors stay quiet, keep the last answer and retry on the next tick.
 */
export function useActiveOperations(enabled: boolean, intervalMs = 5_000): ActiveOperationsState {
  const [operations, setOperations] = useState<FleetOperation[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [refused, setRefused] = useState(false);

  const poll = useCallback(async () => {
    try {
      const ops = await fetchActiveOperations();
      setOperations(ops);
      setRefused(false);
    } catch (err) {
      if (err instanceof FleetApiError) {
        if (err.status === 404) {
          setMissing(true);
          setOperations(null);
        } else if (err.status === 401 || err.status === 403) {
          setRefused(true);
          setOperations(null);
        }
      }
      // Network errors: keep the last known list; the next tick retries.
    }
  }, []);

  // A refused request will be refused again until the token changes: wait for that, then retry.
  useEffect(() => onTokenChange(() => setRefused(false)), []);

  useVisiblePolling(poll, intervalMs, { enabled: enabled && !missing && !refused });
  const unavailable = missing || refused;
  return { operations: enabled && !unavailable ? operations : null, unavailable };
}
