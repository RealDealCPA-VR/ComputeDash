import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getRouting, isRoutingDisabledError, resolveRoute } from "../../api/fleetClient";
import type { FleetTarget, RouteResolution, RoutingPolicy, RoutingView } from "../../api/fleetTypes";
import { SettingsLink } from "../ui/SettingsLink";
import { Tag } from "../ui/Tag";

/** The Settings section that holds the routing switches (SettingsDialog: "settings-section-routing"). */
export const ROUTING_SETTINGS_SECTION = "routing";

/** Where OpenAI-compatible clients send routed requests (same origin and auth as the dashboard). */
export function routingBaseUrl(origin: string = window.location.origin): string {
  return `${origin}/api/fleet/v1`;
}

interface RoutingPanelProps {
  /** Known target list, used to show names instead of ids. */
  targets: FleetTarget[];
  /** Start expanded (and load at once). */
  defaultOpen?: boolean;
  /** The page's view of the routing switch (fleet status); a change reloads the panel. */
  smartRoutingEnabled?: boolean | null;
  /** Bumped by the page's Refresh; a change reloads the panel. */
  refreshKey?: number;
  /** Fleet status: control and the /api/fleet/v1 proxy refuse requests without a dashboard access token. */
  controlRequiresToken?: boolean;
  /** Fleet status: the server has an access token (SPARKDASH_TOKEN). */
  tokenConfigured?: boolean;
}

type ResolveState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; result: RouteResolution }
  | { kind: "error"; message: string };

/**
 * Optional smart routing (P1): state, route table, a dry-run resolver and the proxy base URL.
 * Read-only: routing only sends requests to models that are already serving; the switches live
 * in Settings and every manual control on the page works with routing off.
 */
export function RoutingPanel({ targets, defaultOpen = false, smartRoutingEnabled = null, refreshKey = 0, controlRequiresToken = false, tokenConfigured = false }: RoutingPanelProps) {
  const { t } = useTranslation("models");
  const [open, setOpen] = useState(defaultOpen);
  const [view, setView] = useState<RoutingView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [model, setModel] = useState("");
  const [resolve, setResolve] = useState<ResolveState>({ kind: "idle" });
  const seq = useRef(0);
  const resolveSeq = useRef(0);
  /** The page state the shown view was loaded for; null = never loaded. */
  const loadedFor = useRef<string | null>(null);
  const bodyId = useId();
  const inputId = useId();
  const listId = useId();

  const load = useCallback(async () => {
    const mine = ++seq.current;
    // A new view makes an earlier resolve answer meaningless: drop it (and any in flight).
    resolveSeq.current++;
    setResolve({ kind: "idle" });
    setLoading(true);
    try {
      const res = await getRouting();
      if (mine !== seq.current) return;
      setView(res);
      setLoadError(null);
    } catch (err) {
      if (mine !== seq.current) return;
      if (isRoutingDisabledError(err)) {
        setView((prev) => ({ enabled: false, policy: prev?.policy ?? "least-loaded", table: [] }));
        setLoadError(null);
      } else {
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  // Load when the panel is first shown, and again (while shown) whenever the page refreshes or
  // its routing switch changes. Closed, nothing is fetched; the next open catches up.
  const pageKey = `${String(smartRoutingEnabled)}|${refreshKey}`;
  useEffect(() => {
    if (!open || loadedFor.current === pageKey) return;
    loadedFor.current = pageKey;
    void load();
  }, [open, pageKey, load]);

  const policyLabel = (policy: RoutingPolicy) => {
    switch (policy) {
      case "first-available": return t("routingPanel.policyFirstAvailable");
      case "round-robin": return t("routingPanel.policyRoundRobin");
      default: return t("routingPanel.policyLeastLoaded");
    }
  };

  const targetName = (targetId: string, target?: RouteResolution["target"]) => {
    if (target && "name" in target && target.name) return target.name;
    return targets.find((x) => x.targetId === targetId)?.name ?? targetId;
  };

  const loadText = (load: number | null) => (load == null ? t("unknown") : String(load));

  const onResolve = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = model.trim();
    if (!name) return;
    const mine = ++resolveSeq.current;
    setResolve({ kind: "running" });
    try {
      const result = await resolveRoute(name);
      if (mine === resolveSeq.current) setResolve({ kind: "done", result });
    } catch (err) {
      if (mine !== resolveSeq.current) return;
      if (isRoutingDisabledError(err)) {
        // Switched off since the panel loaded: show the off state instead of a raw 404.
        setResolve({ kind: "idle" });
        setView((prev) => ({ enabled: false, policy: prev?.policy ?? "least-loaded", table: [] }));
        return;
      }
      setResolve({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const enabled = view?.enabled === true;
  // The proxy answers 403 token_required until the server has a token; the resolve tester is a read and still works.
  const proxyNeedsToken = controlRequiresToken && !tokenConfigured;

  return (
    <section className="panel tk-card mm-routing" aria-labelledby={`${bodyId}-title`}>
      <div className="tk-card__head">
        <h2 id={`${bodyId}-title`} className="tk-card__title">
          <button type="button" className="mm-routing__toggle" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={() => setOpen((v) => !v)}>
            <span className={`mm-routing__caret${open ? " is-open" : ""}`} aria-hidden="true">
              ▸
            </span>
            {t("routingPanel.title")}
          </button>
        </h2>
        {open ? (
          <div className="tk-card__tools">
            {view ? (
              <Tag tone={enabled ? "info" : "neutral"}>{enabled ? t("routingPanel.stateOn") : t("routingPanel.stateOff")}</Tag>
            ) : null}
            <button type="button" className="btn btn--sm" onClick={() => void load()} disabled={loading}>
              {loading ? t("refreshing") : t("refresh")}
            </button>
          </div>
        ) : null}
      </div>

      {open ? (
        <div id={bodyId} className="mm-routing__body">
          <p className="mm-note">{t("routingPanel.never")}</p>

          {loadError ? (
            <div className="tk-note tk-note--err mm-alert" role="alert">
              {t("routingPanel.errorLoad", { error: loadError })}
            </div>
          ) : null}

          {!view && !loadError ? <p className="mm-faint">{t("loading")}</p> : null}

          {view && !enabled ? (
            <div className="mm-routing__off" role="status">
              <p className="mm-note">{t("routingPanel.off")}</p>
              <SettingsLink section={ROUTING_SETTINGS_SECTION}>{t("routingPanel.openSettings")}</SettingsLink>
            </div>
          ) : null}

          {view && enabled ? (
            <>
              <dl className="mm-routing__facts">
                <div>
                  <dt>{t("routingPanel.policy")}</dt>
                  <dd data-testid="routing-policy">{policyLabel(view.policy)}</dd>
                </div>
                <div>
                  <dt>{t("routingPanel.baseUrl")}</dt>
                  <dd>
                    <code className="mm-routing__url" data-testid="routing-base-url">
                      {routingBaseUrl()}
                    </code>
                    <small className="mm-routing__hint">{t("routingPanel.baseUrlHelp")}</small>
                    {proxyNeedsToken ? (
                      <small className="mm-routing__warn" role="status" data-testid="routing-token-warning">
                        {t("routingPanel.noTokenWarning")}
                      </small>
                    ) : null}
                  </dd>
                </div>
              </dl>

              <h3 className="mm-routing__subhead">{t("routingPanel.tableTitle")}</h3>
              <p className="mm-faint">{t("routingPanel.tunnelNote")}</p>
              {view.table.length === 0 ? (
                <p className="mm-faint">{t("routingPanel.tableEmpty")}</p>
              ) : (
                <div className="tk-scroll">
                  <table className="tk-table mm-table mm-routing__table">
                    <thead>
                      <tr>
                        <th scope="col">{t("routingPanel.colModel")}</th>
                        <th scope="col">{t("routingPanel.colTarget")}</th>
                        <th scope="col">{t("routingPanel.colEndpoint")}</th>
                        <th scope="col" className="mm-num">{t("routingPanel.colLoad")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.table.map((entry) =>
                        entry.targets.map((rt, i) => (
                          <tr key={`${entry.model}|${rt.targetId}|${rt.endpoint}`} data-route-model={entry.model}>
                            {i === 0 ? (
                              <th scope="row" rowSpan={entry.targets.length} className="mm-routing__model">
                                {entry.model}
                              </th>
                            ) : null}
                            <td>{targetName(rt.targetId)}</td>
                            <td className="mm-routing__endpoint">{rt.endpoint}</td>
                            <td className="mm-num">{loadText(rt.load)}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              <h3 className="mm-routing__subhead">{t("routingPanel.resolveTitle")}</h3>
              <form className="mm-routing__resolve" onSubmit={(e) => void onResolve(e)}>
                <label htmlFor={inputId} className="field-label">
                  {t("routingPanel.resolveLabel")}
                </label>
                <input
                  id={inputId}
                  type="text"
                  className="mm-routing__input field-input--mono"
                  value={model}
                  list={listId}
                  maxLength={256}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={t("routingPanel.resolvePlaceholder")}
                  onChange={(e) => setModel(e.target.value)}
                />
                <datalist id={listId}>
                  {view.table.map((entry) => (
                    <option key={entry.model} value={entry.model} />
                  ))}
                </datalist>
                <button type="submit" className="btn btn--sm btn--primary" disabled={!model.trim() || resolve.kind === "running"}>
                  {resolve.kind === "running" ? t("routingPanel.resolving") : t("routingPanel.resolveButton")}
                </button>
              </form>

              {resolve.kind === "error" ? (
                <div className="tk-note tk-note--err mm-alert" role="alert">
                  {t("routingPanel.errorResolve", { error: resolve.message })}
                </div>
              ) : null}
              {resolve.kind === "done" ? (
                resolve.result.targetId ? (
                  <div className="mm-routing__result" role="status" data-testid="routing-result">
                    <p>{t("routingPanel.resolvedTo", { target: targetName(resolve.result.targetId, resolve.result.target), endpoint: resolve.result.endpoint ?? t("unknown") })}</p>
                    <p className="mm-faint">
                      {t("routingPanel.resolvedDetail", {
                        model: resolve.result.model ?? t("unknown"),
                        load: loadText(resolve.result.load),
                        policy: policyLabel(resolve.result.policy),
                      })}
                    </p>
                    <p className="mm-faint">{t("routingPanel.resolvedReason", { reason: resolve.result.reason })}</p>
                  </div>
                ) : (
                  <div className="tk-note" role="status" data-testid="routing-result">
                    {t("routingPanel.noRoute", { reason: resolve.result.reason })}
                  </div>
                )
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
