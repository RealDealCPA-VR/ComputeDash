import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

type ConnectionBannerProps = {
  connected: boolean;
  lastValidSnapshotAt: number | null;
  snapshotError: string | null;
  stale: boolean;
  /**
   * Fixed clock for the age text (tests). Omitted, the banner keeps its own one-second clock,
   * and only while it is showing, so a ticking age never re-renders the rest of the app.
   */
  now?: number;
};

type AgeTranslate = (key: "connection.ageSeconds" | "connection.ageMinutes", options: { seconds: number; minutes?: number }) => string;

function formatAge(ms: number, t: AgeTranslate) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return t("connection.ageSeconds", { seconds });
  const minutes = Math.floor(seconds / 60);
  return t("connection.ageMinutes", { minutes, seconds: seconds % 60 });
}

/** Current time, refreshed every `intervalMs` while `enabled`. */
function useClock(enabled: boolean, intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [enabled, intervalMs]);
  return now;
}

/**
 * True once `lastValidSnapshotAt` is older than `staleAfterMs`. One timeout per snapshot (at
 * lastValidSnapshotAt + staleAfterMs) instead of a per-second clock, so the caller re-renders
 * only when the answer flips.
 */
export function useTelemetryStale(lastValidSnapshotAt: number | null, staleAfterMs: number): boolean {
  const [expired, setExpired] = useState<number | null>(null);
  useEffect(() => {
    if (lastValidSnapshotAt == null) return;
    const delay = lastValidSnapshotAt + staleAfterMs - Date.now();
    if (delay <= 0) {
      setExpired(lastValidSnapshotAt);
      return;
    }
    const timer = window.setTimeout(() => setExpired(lastValidSnapshotAt), delay);
    return () => window.clearTimeout(timer);
  }, [lastValidSnapshotAt, staleAfterMs]);
  return lastValidSnapshotAt != null && expired === lastValidSnapshotAt;
}

export function ConnectionBanner({ connected, lastValidSnapshotAt, snapshotError, now, stale }: ConnectionBannerProps) {
  if (connected && !snapshotError && !stale) return null;
  return (
    <VisibleBanner connected={connected} lastValidSnapshotAt={lastValidSnapshotAt} snapshotError={snapshotError} fixedNow={now} />
  );
}

function VisibleBanner({
  connected,
  lastValidSnapshotAt,
  snapshotError,
  fixedNow,
}: {
  connected: boolean;
  lastValidSnapshotAt: number | null;
  snapshotError: string | null;
  fixedNow: number | undefined;
}) {
  const { t } = useTranslation("shell");
  // The age only ticks while it is on screen.
  const clock = useClock(fixedNow == null && !snapshotError && lastValidSnapshotAt != null);
  const now = fixedNow ?? clock;

  let message = t("connection.connecting");
  if (snapshotError) message = snapshotError;
  else if (lastValidSnapshotAt != null) {
    const age = formatAge(now - lastValidSnapshotAt, t);
    message = connected
      ? t("connection.staleWithAge", { age })
      : t("connection.disconnectedWithAge", { age });
  } else if (!connected) {
    message = t("connection.waitingForFirstUpdate");
  }

  const announced = snapshotError
    ? t("connection.dataError")
    : connected
      ? t("connection.stale")
      : t("connection.disconnected");

  return (
    <div className="connection-banner">
      <span className="connection-banner-dot" aria-hidden="true" />
      <span className="sr-only" role="status" aria-live="polite">
        {announced}
      </span>
      <span aria-hidden="true">{message}</span>
    </div>
  );
}
