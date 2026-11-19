import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchAuthStatus, onTokenChange } from "../../api/authToken";
import { getFleetStatus, getTargets, listOperations } from "../../api/fleetClient";
import type { FleetOperation, FleetStatus, FleetTarget } from "../../api/fleetTypes";
import { useVisiblePolling } from "../../hooks/useVisiblePolling";
import { Tag } from "../ui/Tag";
import { ClusterDialog } from "./ClusterDialog";
import { RoutingPanel } from "./RoutingPanel";
import { TargetList } from "./TargetList";
import { TargetModels } from "./TargetModels";
import { TokenBanner } from "./TokenBanner";
import { isOperationRunning, type TrackedOperation } from "./OperationPanel";
import "../../styles/tokens.css";
import "../../styles/models.css";

/** While any target is busy, the list is re-read this often so members unlock when a cluster operation ends. */
export const TARGETS_BUSY_POLL_MS = 5000;
/** Otherwise the list (health, serving models, busy) is re-read this often while the tab is visible. */
export const TARGETS_POLL_MS = 15_000;
/** Below this width the layout stacks: selecting a target scrolls its details into view. */
const STACKED_LAYOUT_QUERY = "(max-width: 900px)";

/** The `?target=<targetId>` deep link (e.g. from the Overview), or null. */
export function targetFromUrl(): string | null {
  try {
    return new URLSearchParams(window.location.search).get("target") || null;
  } catch {
    return null;
  }
}

/** Keep `?target=` in step with the selection, on the Models path only, without adding history entries. */
function writeTargetToUrl(targetId: string) {
  try {
    const { pathname, search, hash } = window.location;
    if (!/^\/models\/?$/.test(pathname)) return;
    const params = new URLSearchParams(search);
    if (params.get("target") === targetId) return;
    params.set("target", targetId);
    window.history.replaceState(window.history.state, "", `${pathname}?${params.toString()}${hash}`);
  } catch {
    /* history unavailable: the selection still works */
  }
}

function scrollDetailIntoView(root: HTMLElement | null) {
  try {
    if (typeof window.matchMedia !== "function" || !window.matchMedia(STACKED_LAYOUT_QUERY).matches) return;
    const detail = root?.querySelector<HTMLElement>(".mm-detail");
    if (!detail || typeof detail.scrollIntoView !== "function") return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    detail.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
  } catch {
    /* scrolling is a convenience */
  }
}

interface ModelsPageProps {
  /** Opens the Add-unit dialog; the empty state offers it when given. */
  onAddUnit?: () => void;
}

/** Nodes first, then clusters; the server's order is kept inside each group. */
export function orderTargets(targets: FleetTarget[]): FleetTarget[] {
  return [...targets.filter((x) => x.kind === "node"), ...targets.filter((x) => x.kind === "cluster")];
}

/** Fleet Model Manager: every node and cluster, its models, and manual lifecycle control. */
export function ModelsPage({ onAddUnit }: ModelsPageProps = {}) {
  const { t } = useTranslation("models");
  const [status, setStatus] = useState<FleetStatus | null>(null);
  const [targets, setTargets] = useState<FleetTarget[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // A deep link (?target=) wins over the default first target, once targets have loaded.
  const [selectedId, setSelectedId] = useState<string | null>(() => targetFromUrl());
  const [operations, setOperations] = useState<Record<string, TrackedOperation>>({});
  const [clustersOpen, setClustersOpen] = useState(false);
  /** Bumped by every full load (Refresh), so the routing panel reloads with the page. */
  const [refreshKey, setRefreshKey] = useState(0);
  /** Bumped only by the page's Refresh button, so the selected target's inventory is rediscovered too. */
  const [inventoryRefreshKey, setInventoryRefreshKey] = useState(0);
  /** A control request came back 403 token_required (cleared by the next successful status read). */
  const [tokenRefused, setTokenRefused] = useState(false);
  /** The server has a token but this browser's credentials would not pass (auth status). */
  const [browserNeedsToken, setBrowserNeedsToken] = useState(false);
  const seq = useRef(0);
  const layoutRef = useRef<HTMLDivElement>(null);
  const scrollOnSelect = useRef(false);

  const loadTargets = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const res = await getTargets();
      if (mine !== seq.current) return;
      setTargets(orderTargets(res.targets));
      setError(null);
    } catch (err) {
      if (mine !== seq.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const [st] = await Promise.allSettled([getFleetStatus(), loadTargets()]);
    setStatus(st.status === "fulfilled" ? st.value : null);
    if (st.status === "fulfilled") setTokenRefused(false);
    setRefreshKey((k) => k + 1);
    setLoading(false);
  }, [loadTargets]);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshAll = () => {
    setInventoryRefreshKey((k) => k + 1);
    void load();
  };

  // Keep a valid selection: the first target by default, and never one that has disappeared.
  useEffect(() => {
    if (!targets) return;
    if (!selectedId || !targets.some((x) => x.targetId === selectedId)) {
      const fallback = targets[0]?.targetId ?? null;
      setSelectedId(fallback);
      // A deep link to a target that no longer exists is corrected to what is shown.
      if (fallback && targetFromUrl()) writeTargetToUrl(fallback);
    }
  }, [targets, selectedId]);

  const selectTarget = useCallback((targetId: string) => {
    scrollOnSelect.current = true;
    setSelectedId(targetId);
    writeTargetToUrl(targetId);
  }, []);

  // Stacked layout: the details are below the list, so bring them into view after a selection.
  useEffect(() => {
    if (!scrollOnSelect.current) return;
    scrollOnSelect.current = false;
    scrollDetailIntoView(layoutRef.current);
  }, [selectedId]);

  // Back/forward (or a link that rewrote the URL) to another ?target= while the page is open.
  useEffect(() => {
    const onPop = () => {
      const fromUrl = targetFromUrl();
      if (fromUrl) setSelectedId(fromUrl);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Health, serving models and busy flags stay current; faster while an operation runs somewhere.
  const anyBusy = targets?.some((x) => x.busy || Boolean(x.activeOperationId)) ?? false;
  useVisiblePolling(loadTargets, anyBusy ? TARGETS_BUSY_POLL_MS : TARGETS_POLL_MS, { immediate: false, enabled: status?.enabled !== false });

  const onTargetsChanged = useCallback(() => {
    void loadTargets();
  }, [loadTargets]);

  const setOperation = useCallback((targetId: string, op: TrackedOperation | null) => {
    setOperations((prev) => {
      const next = { ...prev };
      if (op) next[targetId] = op;
      else delete next[targetId];
      return next;
    });
  }, []);

  /**
   * Reattach running operations (they live on the server): leaving the page and coming back, or an
   * operation started elsewhere, shows its progress again. Older servers without the list degrade silently.
   */
  const reattachOperations = useCallback(async () => {
    let running: FleetOperation[];
    try {
      const res = await listOperations(true);
      running = (res?.operations ?? []).filter((op) => op.status === "running");
    } catch {
      return;
    }
    if (!running.length) return;
    setOperations((prev) => {
      let next = prev;
      for (const op of running) {
        const current = prev[op.targetId];
        if (current && (current.operation.id === op.id || isOperationRunning(current))) continue;
        if (next === prev) next = { ...prev };
        next[op.targetId] = { operation: op, lost: false };
      }
      return next;
    });
  }, []);

  useEffect(() => {
    void reattachOperations();
  }, [reattachOperations]);

  // A target reports an operation this page is not tracking (started in another tab or by a cluster).
  const untrackedOperations = (targets ?? [])
    .map((x) => x.activeOperationId)
    .filter((id): id is string => Boolean(id) && !Object.values(operations).some((o) => o.operation.id === id))
    .sort()
    .join(",");
  useEffect(() => {
    if (untrackedOperations) void reattachOperations();
  }, [untrackedOperations, reattachOperations]);

  const onTokenRequired = useCallback(() => setTokenRefused(true), []);
  // Control (start / stop / reload / switch, cluster edits) needs a dashboard access token on this server.
  const controlLocked = tokenRefused || (status?.controlRequiresToken === true && status.tokenConfigured !== true);

  // The server has a token: does this browser hold it? (Re-checked whenever the stored token changes.)
  const serverHasToken = status?.tokenConfigured === true;
  useEffect(() => {
    if (!serverHasToken) {
      setBrowserNeedsToken(false);
      return;
    }
    let cancelled = false;
    const check = () => {
      fetchAuthStatus().then(
        (auth) => {
          if (!cancelled) setBrowserNeedsToken(auth.tokenRequired && !auth.authenticated);
        },
        () => {
          if (!cancelled) setBrowserNeedsToken(false);
        }
      );
    };
    check();
    const off = onTokenChange(check);
    return () => {
      cancelled = true;
      off();
    };
  }, [serverHasToken]);
  const tokenBanner = controlLocked ? "server" : browserNeedsToken ? "browser" : null;

  const selected = targets?.find((x) => x.targetId === selectedId) ?? null;
  const routing = status == null ? t("routing.unknown") : status.smartRoutingEnabled ? t("routing.on") : t("routing.off");

  return (
    <div className="tk mm">
      <header className="page-head mm-head">
        <div>
          <h1>{t("title")}</h1>
          <p className="page-head__sub">{t("subtitle")}</p>
        </div>
        <div className="page-head__tools">
          {/* Read-only: the routing toggle lives in Settings. Manual control never depends on it. */}
          <Tag tone={status?.smartRoutingEnabled ? "info" : "neutral"} className="mm-routing-chip" title={t("routing.hint")}>
            {t("routing.chip", { state: routing })}
          </Tag>
          <button type="button" className="btn btn--sm" onClick={() => setClustersOpen(true)}>
            {t("clusters.manage")}
          </button>
          <button type="button" className="btn btn--sm" onClick={refreshAll} disabled={loading}>
            {loading ? t("refreshing") : t("refresh")}
          </button>
        </div>
      </header>

      {status && !status.enabled ? (
        <div className="panel tk-note" role="status">
          {t("disabled")}
        </div>
      ) : null}

      {tokenBanner ? <TokenBanner mode={tokenBanner} /> : null}

      {error ? (
        <div className="panel tk-note tk-note--err" role="alert">
          {t("errors.targets", { error })}
        </div>
      ) : null}

      {/* Optional smart routing: collapsed by default, read-only, never needed for manual control. */}
      {status?.enabled !== false ? <RoutingPanel targets={targets ?? []} smartRoutingEnabled={status?.smartRoutingEnabled ?? null}
          refreshKey={refreshKey}
          controlRequiresToken={status?.controlRequiresToken === true}
          tokenConfigured={status?.tokenConfigured === true}
        /> : null}

      {targets ? (
        targets.length === 0 ? (
          <div className="panel tk-note mm-empty">
            <p className="mm-empty__text">{t("targets.empty")}</p>
            {onAddUnit ? (
              <button type="button" className="btn btn--primary" onClick={onAddUnit}>
                {t("targets.addMachine")}
              </button>
            ) : null}
          </div>
        ) : (
          <div className="mm-layout" ref={layoutRef}>
            <TargetList targets={targets} selectedId={selectedId} onSelect={selectTarget} />
            {selected ? (
              <TargetModels
                key={selected.targetId}
                target={selected}
                targets={targets}
                refreshKey={inventoryRefreshKey}
                operation={operations[selected.targetId] ?? null}
                onOperation={(op) => setOperation(selected.targetId, op)}
                onTargetsChanged={onTargetsChanged}
                controlLocked={controlLocked}
                onTokenRequired={onTokenRequired}
              />
            ) : null}
          </div>
        )
      ) : !error ? (
        <p className="mm-faint">{t("loading")}</p>
      ) : null}

      <ClusterDialog
        open={clustersOpen}
        nodes={(targets ?? []).filter((x) => x.kind === "node")}
        onClose={() => setClustersOpen(false)}
        onChanged={onTargetsChanged}
        controlLocked={controlLocked}
        onTokenRequired={onTokenRequired}
      />
    </div>
  );
}
