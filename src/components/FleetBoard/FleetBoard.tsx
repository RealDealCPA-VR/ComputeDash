import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  FleetApiError,
  getFleetStatus,
  getInventory,
  getTargets,
  isBusyError,
  isTokenRequiredError,
  startOperation,
} from "../../api/fleetClient";
import type { FleetInventory, FleetOperation, FleetTarget } from "../../api/fleetTypes";
import type { SparkSnapshot } from "../../api/types";
import { idToPath } from "../../constants";
import { useVisiblePolling } from "../../hooks/useVisiblePolling";
import { formatMb } from "../../shared/formatBytes";
import { formatSince } from "../../shared/formatSince";
import { AppLink } from "../ui/AppLink";
import { Tag } from "../ui/Tag";
import {
  boardOrder,
  formatCapacity,
  isTargetBusy,
  modelIdOf,
  modelsHref,
  nodeLive,
  operationFor,
  operationProgress,
  platformLabel,
  servingView,
  statusDotClass,
  unitIdOf,
  type NodeLive,
} from "./fleetBoardModel";
import { useActiveOperations } from "./useActiveOperations";
import "../../styles/fleetboard.css";

const SwitchModelDialog = lazy(() => import("./FleetBoardDialogs").then((m) => ({ default: m.SwitchModelDialog })));
const LogsDialog = lazy(() => import("./FleetBoardDialogs").then((m) => ({ default: m.LogsDialog })));

/** Targets are re-read this often; faster while an operation runs so the row unlocks promptly. */
export const BOARD_POLL_MS = 15_000;
export const BOARD_BUSY_POLL_MS = 5_000;
/** Models listed per row before "+N more". */
const MAX_MODELS = 3;

type Unit = "celsius" | "fahrenheit";

interface FleetBoardProps {
  /** Live snapshots, for the per-node tok/s, memory and temperature. */
  sparks: SparkSnapshot[];
  temperatureUnit?: Unit;
  onSelectSpark?: (id: string) => void;
  /** Open the Models page, on a target when given. */
  onOpenModels?: (targetId?: string | null) => void;
}

interface SwitchState {
  target: FleetTarget;
  inventory: FleetInventory;
  open: boolean;
  busy: boolean;
  error: string | null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * "What is each machine doing and what model is on it right now": one row per fleet target
 * (clusters as one row listing their members), with the model control shortcuts. Self-contained:
 * a failure here shows inside the board and never blocks the rest of the Overview.
 */
export function FleetBoard({ sparks, temperatureUnit = "celsius", onSelectSpark, onOpenModels }: FleetBoardProps) {
  const { t } = useTranslation("overview");
  const headingId = useId();
  const [targets, setTargets] = useState<FleetTarget[] | null>(null);
  const [generatedAt, setGeneratedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The server reports the feature off (404 disabled): the board hides itself. */
  const [hidden, setHidden] = useState(false);
  /** Model control needs an access token on this server (from status, or a 403 token_required). */
  const [tokenLocked, setTokenLocked] = useState(false);
  const [switchLoading, setSwitchLoading] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ targetId: string; message: string } | null>(null);
  const [switchState, setSwitchState] = useState<SwitchState | null>(null);
  const [logsTarget, setLogsTarget] = useState<{ target: FleetTarget; open: boolean } | null>(null);
  const seq = useRef(0);

  const loadTargets = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const res = await getTargets();
      if (mine !== seq.current) return;
      setTargets(boardOrder(Array.isArray(res?.targets) ? res.targets : []));
      setGeneratedAt(typeof res?.generatedAt === "number" ? res.generatedAt : Date.now());
      setError(null);
    } catch (err) {
      if (mine !== seq.current) return;
      if (err instanceof FleetApiError && err.status === 404 && err.code === "disabled") {
        setHidden(true);
        return;
      }
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    getFleetStatus()
      .then((status) => {
        if (!alive) return;
        if (status.enabled === false) setHidden(true);
        if (status.controlRequiresToken === true && status.tokenConfigured !== true) setTokenLocked(true);
      })
      .catch(() => {
        /* The targets request reports the error. */
      });
    return () => {
      alive = false;
    };
  }, []);

  const anyBusy = targets?.some(isTargetBusy) ?? false;
  useVisiblePolling(loadTargets, anyBusy ? BOARD_BUSY_POLL_MS : BOARD_POLL_MS, { enabled: !hidden });
  const { operations } = useActiveOperations(anyBusy && !hidden, BOARD_BUSY_POLL_MS);

  const sparkById = useMemo(() => new Map(sparks.map((s) => [s.id, s])), [sparks]);
  const nameOfUnit = useCallback(
    (unitId: string) => targets?.find((x) => x.kind === "node" && x.id === unitId)?.name ?? sparkById.get(unitId)?.name ?? unitId,
    [targets, sparkById]
  );

  const openSwitch = async (target: FleetTarget) => {
    setSwitchLoading(target.targetId);
    setRowError(null);
    try {
      const inventory = await getInventory(target.targetId);
      setSwitchState({ target, inventory, open: true, busy: false, error: null });
    } catch (err) {
      setRowError({ targetId: target.targetId, message: t("fleetBoard.errors.inventory", { error: errorText(err) }) });
    } finally {
      setSwitchLoading(null);
    }
  };

  const closeSwitch = useCallback(() => setSwitchState((s) => (s ? { ...s, open: false, busy: false } : s)), []);

  const confirmSwitch = async (request: { modelKey: string; force: boolean; rollback: boolean }) => {
    const current = switchState;
    if (!current) return;
    setSwitchState({ ...current, busy: true, error: null });
    try {
      await startOperation(current.target.targetId, { action: "switch", modelKey: request.modelKey, force: request.force, rollback: request.rollback });
      setSwitchState({ ...current, open: false, busy: false, error: null });
      void loadTargets();
    } catch (err) {
      if (isTokenRequiredError(err)) {
        setTokenLocked(true);
        setSwitchState({ ...current, open: false, busy: false, error: null });
        return;
      }
      setSwitchState({
        ...current,
        busy: false,
        error: isBusyError(err) ? t("fleetBoard.errors.busy", { error: errorText(err) }) : t("fleetBoard.errors.switch", { error: errorText(err) }),
      });
    }
  };

  if (hidden) return null;

  const age = generatedAt != null ? formatSince(generatedAt) : null;

  return (
    <section className="panel ov-card fb" aria-labelledby={headingId}>
      <div className="ov-card__head">
        <h2 id={headingId} className="ov-card__title">
          {t("fleetBoard.title")}
        </h2>
        <div className="ov-card__tools">
          {age ? <span className="fb-updated">{t("fleetBoard.updated", { age })}</span> : null}
          <AppLink href={modelsHref()} className="btn btn--sm btn--ghost" onNavigate={() => onOpenModels?.(null)}>
            {t("fleetBoard.openModels")}
          </AppLink>
        </div>
      </div>

      {error ? (
        <p className="ov-note" role="status">
          {targets ? t("fleetBoard.errors.stale", { error }) : t("fleetBoard.errors.targets", { error })}
        </p>
      ) : null}

      {targets == null && !error ? (
        <div className="fb-skeleton" aria-busy="true" aria-label={t("fleetBoard.loading")}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="skel-row">
              <i className="skel-bar skel-bar--s" />
              <i className="skel-bar" />
              <i className="skel-bar skel-bar--s" />
            </div>
          ))}
        </div>
      ) : null}

      {targets && targets.length === 0 ? <p className="fb-empty">{t("fleetBoard.empty")}</p> : null}

      {targets && targets.length > 0 ? (
        // Explicit roles: the narrow-screen card layout sets display:block, which drops the
        // implicit table semantics in Chromium and Safari.
        <table className="fb-table" role="table">
          <caption className="sr-only">{t("fleetBoard.caption")}</caption>
          <thead role="rowgroup">
            <tr role="row">
              <th scope="col" role="columnheader">{t("fleetBoard.columns.machine")}</th>
              <th scope="col" role="columnheader">{t("fleetBoard.columns.hardware")}</th>
              <th scope="col" role="columnheader">{t("fleetBoard.columns.serving")}</th>
              <th scope="col" role="columnheader">{t("fleetBoard.columns.live")}</th>
              <th scope="col" role="columnheader">{t("fleetBoard.columns.actions")}</th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {targets.map((target) => {
              const unitId = unitIdOf(target.targetId);
              const headUnit = target.kind === "cluster" ? target.headId : unitId;
              const live = nodeLive(headUnit ? sparkById.get(headUnit) : null);
              return (
                <BoardRow
                  key={target.targetId}
                  t={t}
                  target={target}
                  live={live}
                  liveIsHead={target.kind === "cluster"}
                  temperatureUnit={temperatureUnit}
                  members={target.memberIds.map((id) => ({ id, name: nameOfUnit(id), online: sparkById.get(id)?.online ?? null }))}
                  operation={operationFor(target, operations)}
                  tokenLocked={tokenLocked}
                  switchLoading={switchLoading === target.targetId}
                  rowError={rowError?.targetId === target.targetId ? rowError.message : null}
                  onSelectSpark={onSelectSpark}
                  onOpenModels={onOpenModels}
                  onSwitch={() => void openSwitch(target)}
                  onLogs={() => setLogsTarget({ target, open: true })}
                />
              );
            })}
          </tbody>
        </table>
      ) : null}

      {switchState ? (
        <Suspense fallback={null}>
          <SwitchModelDialog
            open={switchState.open}
            target={switchState.target}
            inventory={switchState.inventory}
            busy={switchState.busy}
            error={switchState.error}
            onClose={closeSwitch}
            onConfirm={(request) => void confirmSwitch(request)}
          />
        </Suspense>
      ) : null}
      {logsTarget ? (
        <Suspense fallback={null}>
          <LogsDialog
            open={logsTarget.open}
            targetId={logsTarget.target.targetId}
            targetName={logsTarget.target.name}
            modelKey={null}
            modelLabel={null}
            onClose={() => setLogsTarget((s) => (s ? { ...s, open: false } : s))}
          />
        </Suspense>
      ) : null}
    </section>
  );
}

interface BoardRowProps {
  t: TFunction;
  target: FleetTarget;
  live: NodeLive | null;
  /** Cluster rows show their head's live readings. */
  liveIsHead: boolean;
  temperatureUnit: Unit;
  members: { id: string; name: string; online: boolean | null }[];
  operation: FleetOperation | null;
  tokenLocked: boolean;
  switchLoading: boolean;
  rowError: string | null;
  onSelectSpark?: (id: string) => void;
  onOpenModels?: (targetId?: string | null) => void;
  onSwitch: () => void;
  onLogs: () => void;
}

function healthLabel(t: TFunction, target: FleetTarget): string {
  switch (target.health) {
    case "ready": return t("fleetBoard.health.ready");
    case "degraded": return t("fleetBoard.health.degraded");
    case "unreachable": return t("fleetBoard.health.unreachable");
    default: return t("fleetBoard.health.unknown");
  }
}

function unknownReason(t: TFunction, reason: "unreachable" | "group" | "noInventory" | "notReported"): string {
  switch (reason) {
    case "unreachable": return t("fleetBoard.serving.reasonUnreachable");
    case "group": return t("fleetBoard.serving.reasonGroup");
    case "noInventory": return t("fleetBoard.serving.reasonNoInventory");
    default: return t("fleetBoard.serving.reasonNotReported");
  }
}

function operationText(t: TFunction, op: FleetOperation): string {
  const model = modelIdOf(op.modelKey) || t("fleetBoard.operation.unknownModel");
  switch (op.action) {
    case "switch": return t("fleetBoard.operation.switch", { model });
    case "start": return t("fleetBoard.operation.start", { model });
    case "stop": return t("fleetBoard.operation.stop", { model });
    case "reload": return t("fleetBoard.operation.reload", { model });
    default: return t("fleetBoard.busy");
  }
}

function toUnit(c: number, unit: Unit): string {
  return unit === "fahrenheit" ? `${Math.round((c * 9) / 5 + 32)}°F` : `${Math.round(c)}°C`;
}

function BoardRow({
  t,
  target,
  live,
  liveIsHead,
  temperatureUnit,
  members,
  operation,
  tokenLocked,
  switchLoading,
  rowError,
  onSelectSpark,
  onOpenModels,
  onSwitch,
  onLogs,
}: BoardRowProps) {
  const serving = servingView(target);
  const busy = isTargetBusy(target);
  const isGroup = target.kind === "cluster" && target.clusterKind === "group";
  const canSwitch = !isGroup && target.online !== false && (target.capabilities?.lifecycle === true || target.capabilities?.distributedControl === true);
  const hardware = target.hardware?.label ?? null;
  const capacity = formatCapacity(target.hardware?.memoryTotalBytes);
  const platform = platformLabel(target.platform);
  const hwSub = [platform, capacity ? (target.hardware?.memoryKind === "unified" ? t("fleetBoard.unifiedMemory", { size: capacity }) : capacity) : null]
    .filter(Boolean)
    .join(" · ");
  const manage = (
    <AppLink href={modelsHref(target.targetId)} className="btn btn--sm btn--ghost" onNavigate={() => onOpenModels?.(target.targetId)}>
      {t("fleetBoard.manage")}
    </AppLink>
  );
  const progress = operation ? operationProgress(operation) : null;

  return (
    <tr className={`fb-row${busy ? " is-busy" : ""}`} role="row">
      <th scope="row" role="rowheader" className="fb-cell fb-machine">
        <div className="fb-machine__line">
          <i className={statusDotClass(target)} role="img" aria-label={healthLabel(t, target)} title={healthLabel(t, target)} />
          {target.kind === "node" && onSelectSpark ? (
            <AppLink href={idToPath(target.id)} className="fb-machine__name" onNavigate={() => onSelectSpark(target.id)}>
              {target.name}
            </AppLink>
          ) : (
            <span className="fb-machine__name">{target.name}</span>
          )}
          {target.kind === "cluster" ? (
            <Tag tone="acc" className="fb-kind">
              {target.clusterKind === "group" ? t("fleetBoard.group") : t("fleetBoard.cluster")}
            </Tag>
          ) : null}
        </div>
        {target.kind === "cluster" && members.length ? (
          <ul className="fb-members" aria-label={t("fleetBoard.membersLabel")}>
            {members.map((m) => (
              <li key={m.id}>
                <i className={m.online === true ? "sdot" : m.online === false ? "sdot sdot--off" : "sdot sdot--warn"} aria-hidden />
                {m.name}
                {m.id === target.headId ? <span className="fb-faint"> {t("fleetBoard.head")}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </th>
      <td role="cell" className="fb-cell" data-label={t("fleetBoard.columns.hardware")}>
        <div className="fb-hw">{hardware ?? <span className="fb-faint">{t("fleetBoard.unknown")}</span>}</div>
        {hwSub ? <div className="fb-sub">{hwSub}</div> : null}
      </td>
      <td role="cell" className="fb-cell" data-label={t("fleetBoard.columns.serving")}>
        {serving.kind === "models" ? (
          <ul className="fb-models">
            {serving.models.slice(0, MAX_MODELS).map((m) => (
              <li key={m}>
                <code title={m}>{m}</code>
              </li>
            ))}
            {serving.models.length > MAX_MODELS ? (
              <li className="fb-faint" title={serving.models.slice(MAX_MODELS).join(", ")}>
                {t("fleetBoard.serving.more", { count: serving.models.length - MAX_MODELS })}
              </li>
            ) : null}
          </ul>
        ) : serving.kind === "none" ? (
          <span className="fb-faint">{t("fleetBoard.serving.none")}</span>
        ) : serving.kind === "count" ? (
          <span>{t("fleetBoard.serving.count", { count: serving.count })}</span>
        ) : (
          <span className={`fb-unknown${serving.reason === "unreachable" ? " fb-unknown--off" : ""}`}>
            {serving.reason === "unreachable" ? t("fleetBoard.serving.unreachable") : t("fleetBoard.serving.unknown")}
            <span className="fb-sub">{unknownReason(t, serving.reason)}</span>
          </span>
        )}
      </td>
      <td role="cell" className="fb-cell" data-label={t("fleetBoard.columns.live")}>
        <LiveCell t={t} live={live} isHead={liveIsHead} temperatureUnit={temperatureUnit} />
      </td>
      <td role="cell" className="fb-cell fb-actions" data-label={t("fleetBoard.columns.actions")}>
        {busy ? (
          <div className="fb-progress">
            <span className="fb-progress__text" role="status">
              <i className="op-chip__dot" aria-hidden />
              {operation ? operationText(t, operation) : t("fleetBoard.busy")}
              {progress ? (
                <span className="fb-sub">
                  {t("fleetBoard.operation.step", { step: progress.step, total: progress.total })}
                  {progress.label ? ` · ${progress.label}` : ""}
                </span>
              ) : null}
            </span>
            <AppLink href={modelsHref(target.targetId)} className="btn btn--sm btn--ghost" onNavigate={() => onOpenModels?.(target.targetId)}>
              {t("fleetBoard.viewOperation")}
            </AppLink>
          </div>
        ) : (
          <div className="fb-buttons">
            {canSwitch ? (
              tokenLocked ? (
                <AppLink
                  href={modelsHref(target.targetId)}
                  className="fb-token"
                  onNavigate={() => onOpenModels?.(target.targetId)}
                  title={t("fleetBoard.tokenHintTitle")}
                >
                  {t("fleetBoard.tokenHint")}
                </AppLink>
              ) : (
                // aria-disabled, not disabled: the button keeps focus while the inventory loads, so the
                // dialog returns focus to it on close.
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={switchLoading ? undefined : onSwitch}
                  aria-disabled={switchLoading || undefined}
                  aria-busy={switchLoading || undefined}
                  aria-label={t("fleetBoard.switchLabel", { name: target.name })}
                >
                  {switchLoading ? t("fleetBoard.loadingModels") : t("fleetBoard.switch")}
                </button>
              )
            ) : null}
            {isGroup ? null : (
              <button type="button" className="btn btn--sm btn--ghost" onClick={onLogs} aria-label={t("fleetBoard.logsLabel", { name: target.name })}>
                {t("fleetBoard.logs")}
              </button>
            )}
            {manage}
          </div>
        )}
        {rowError ? (
          <p className="fb-error" role="alert">
            {rowError}
          </p>
        ) : null}
      </td>
    </tr>
  );
}

function LiveCell({ t, live, isHead, temperatureUnit }: { t: TFunction; live: NodeLive | null; isHead: boolean; temperatureUnit: Unit }) {
  if (!live) return <span className="fb-faint">{t("fleetBoard.live.none")}</span>;
  if (!live.online) return <span className="fb-faint">{isHead ? t("fleetBoard.live.headOffline") : t("fleetBoard.live.offline")}</span>;
  return (
    <div className="fb-live">
      <div className="fb-live__tps">
        {live.tps != null ? (
          <>
            <b className="mono">{live.tps.toFixed(1)}</b> <span className="fb-faint">{t("fleetBoard.live.tps")}</span>
          </>
        ) : live.tpsUnmeasured ? (
          <span className="fb-faint" title={t("fleetBoard.live.unmeasuredTitle")}>
            {"— "}
            {t("fleetBoard.live.tps")}
          </span>
        ) : (
          <span className="fb-faint">{t("fleetBoard.live.idle")}</span>
        )}
        {isHead ? <span className="fb-faint"> {t("fleetBoard.live.headSuffix")}</span> : null}
      </div>
      {live.memory ? (
        <div className="fb-mem" title={t("fleetBoard.live.memoryTitle", { used: formatMb(live.memory.usedMb), total: formatMb(live.memory.totalMb) })}>
          <span className="fb-faint">{live.memory.unified ? t("fleetBoard.live.unified") : t("fleetBoard.live.vram")}</span>
          <span className="ov-bar fb-mem__bar" role="progressbar" aria-label={live.memory.unified ? t("fleetBoard.live.unified") : t("fleetBoard.live.vram")} aria-valuenow={Math.round(live.memory.pct)} aria-valuemin={0} aria-valuemax={100}>
            <i className={live.memory.pct >= 90 ? "is-bad" : live.memory.pct >= 85 ? "is-warn" : undefined} style={{ width: `${Math.max(0, Math.min(100, Math.round(live.memory.pct)))}%` }} />
          </span>
          <b className="mono">{Math.round(live.memory.pct)}%</b>
        </div>
      ) : null}
      {live.gpuTempC != null ? (
        <div className="fb-faint">
          {t("fleetBoard.live.gpuTemp")} <b className="mono fb-strong">{toUnit(live.gpuTempC, temperatureUnit)}</b>
        </div>
      ) : null}
    </div>
  );
}
