import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getInventory, isBusyError, startOperation } from "../../api/fleetClient";
import type { FleetInventory, FleetModel, FleetOperationRequest, FleetTarget } from "../../api/fleetTypes";
import { Tag } from "../ui/Tag";
import { LogsDialog } from "./LogsDialog";
import { ModelsDialog } from "./ModelsDialog";
import { isOperationRunning, OperationPanel, type TrackedOperation } from "./OperationPanel";
import { SwitchModelDialog, type SwitchRequest } from "./SwitchModelDialog";
import { actionLabel, formatContext, formatMemory, formatRelativeTime, modelStateClass, modelStateLabel, modelStateTone } from "./modelStateTone";

type ModelAction = "start" | "stop" | "reload";

interface TargetModelsProps {
  target: FleetTarget;
  /** Every target, to name clusters and member nodes. */
  targets: FleetTarget[];
  /** The latest known operation on this target, kept by the page across target switches. */
  operation: TrackedOperation | null;
  onOperation: (operation: TrackedOperation | null) => void;
  /** An operation started or finished: the target list (busy, serving counts) needs a refresh. */
  onTargetsChanged: () => void;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One target's runtimes and models, with manual lifecycle controls. */
export function TargetModels({ target, targets, operation, onOperation, onTargetsChanged }: TargetModelsProps) {
  const { t, i18n } = useTranslation("models");
  const [inventory, setInventory] = useState<FleetInventory | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirm, setConfirm] = useState<{ action: ModelAction; model: FleetModel } | null>(null);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [logsFor, setLogsFor] = useState<{ modelKey: string | null; label: string | null } | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // The last refresh failed while an older inventory is on screen: that inventory is stale.
  const [refreshFailed, setRefreshFailed] = useState(false);
  const seq = useRef(0);
  const targetId = target.targetId;
  const unknown = t("unknown");

  const loadInventory = useCallback(
    async (refresh: boolean) => {
      const mine = ++seq.current;
      setLoading(true);
      setLoadError(null);
      try {
        const inv = await getInventory(targetId, refresh);
        if (mine === seq.current) {
          setInventory(inv);
          setRefreshFailed(false);
        }
      } catch (err) {
        if (mine === seq.current) {
          setLoadError(errorText(err));
          setRefreshFailed(true);
        }
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [targetId]
  );

  useEffect(() => {
    setInventory(null);
    setRefreshFailed(false);
    setActionError(null);
    void loadInventory(false);
  }, [loadInventory]);

  const allModels = [...(inventory?.models ?? []), ...(inventory?.clusterModels ?? [])];
  const modelLabel = (modelKey: string) => allModels.find((m) => m.modelKey === modelKey)?.label ?? modelKey;
  const targetName = (id: string | null) => (id ? targets.find((x) => x.targetId === id)?.name ?? id : unknown);
  const nodeName = (unitId: string) => targets.find((x) => x.kind === "node" && x.id === unitId)?.name ?? unitId;

  const opRunning = isOperationRunning(operation);
  const locked = opRunning || target.busy || actionBusy;
  const switchCandidates = (inventory?.models ?? []).filter((m) => m.actions.switchTo);

  const run = async (body: FleetOperationRequest) => {
    setActionBusy(true);
    setActionError(null);
    try {
      const { operation: started } = await startOperation(targetId, body);
      onOperation({ operation: started, lost: false });
      setConfirm(null);
      setSwitchOpen(false);
      onTargetsChanged();
    } catch (err) {
      setActionError(isBusyError(err) ? t("errors.busy", { error: errorText(err) }) : t("errors.action", { error: errorText(err) }));
    } finally {
      setActionBusy(false);
    }
  };

  const onFinished = useCallback(() => {
    void loadInventory(true);
    onTargetsChanged();
  }, [loadInventory, onTargetsChanged]);

  const onLost = useCallback(
    (op: TrackedOperation["operation"]) => {
      onOperation({ operation: op, lost: true });
      void loadInventory(true);
      onTargetsChanged();
    },
    [onOperation, loadInventory, onTargetsChanged]
  );

  /** "last seen serving 5 min ago" for a model whose current state is unknown or unreachable. */
  const lastSeenText = (m: FleetModel): string | null => {
    if (!m.lastSeen || (m.state !== "unknown" && m.state !== "unreachable")) return null;
    const state = modelStateLabel(t, m.lastSeen.state);
    if (m.lastSeen.at == null) return t("models.lastSeenNoTime", { state });
    return t("models.lastSeen", { state, time: formatRelativeTime(m.lastSeen.at, Date.now(), i18n.language) });
  };

  const confirmTitle = (action: ModelAction, model: FleetModel) => {
    switch (action) {
      case "start": return t("confirm.startTitle", { model: model.label });
      case "stop": return t("confirm.stopTitle", { model: model.label });
      case "reload": return t("confirm.reloadTitle", { model: model.label });
    }
  };
  const confirmBody = (action: ModelAction, model: FleetModel) => {
    switch (action) {
      case "start": return t("confirm.startBody", { model: model.label, target: target.name });
      case "stop": return t("confirm.stopBody", { model: model.label, target: target.name });
      case "reload": return t("confirm.reloadBody", { model: model.label, target: target.name });
    }
  };

  const runtimeReachLabel = (reachable: boolean | null) => {
    if (reachable === true) return t("runtimes.reachable");
    if (reachable === false) return t("runtimes.unreachable");
    return t("runtimes.reachUnknown");
  };

  const clusterKindNote = () => {
    if (target.kind !== "cluster") return null;
    if (target.clusterKind === "group") return t("detail.groupNote");
    if (target.clusterKind === "distributed" && !target.capabilities.distributedControl) return t("detail.noDistributedControl");
    return null;
  };

  const memoryKind = () => {
    switch (target.hardware.memoryKind) {
      case "unified": return t("detail.memoryUnified");
      case "vram": return t("detail.memoryVram");
      default: return null;
    }
  };

  const modelRow = (m: FleetModel) => (
    <tr key={m.modelKey} data-model-key={m.modelKey}>
      <td>
        <span className="mm-model__label">{m.label}</span>
        {m.label !== m.modelId ? <span className="mm-sub">{m.modelId}</span> : null}
      </td>
      <td>
        <Tag tone={modelStateTone(m.state)} className={modelStateClass(m.state)}>
          {modelStateLabel(t, m.state)}
        </Tag>
        {lastSeenText(m) ? <span className="mm-sub mm-last-seen">{lastSeenText(m)}</span> : null}
        {m.lastError ? <span className="mm-sub mm-sub--err">{m.lastError}</span> : null}
      </td>
      <td>
        {m.engine}
        {m.port != null ? <span className="mm-faint">:{m.port}</span> : null}
      </td>
      <td className={m.quantization == null ? "mm-unknown" : undefined}>{m.quantization ?? unknown}</td>
      <td className={`mm-num${m.contextLength == null ? " mm-unknown" : ""}`}>{formatContext(m.contextLength, unknown)}</td>
      <td className={`mm-num${m.estMemoryBytes == null ? " mm-unknown" : ""}`}>{formatMemory(m.estMemoryBytes, unknown)}</td>
      <td>
        <div className="mm-row-actions">
          <button type="button" className="btn btn--sm" aria-label={t("actions.startModel", { model: m.label })} disabled={!m.actions.start || locked} onClick={() => setConfirm({ action: "start", model: m })}>
            {t("actions.start")}
          </button>
          <button type="button" className="btn btn--sm" aria-label={t("actions.stopModel", { model: m.label })} disabled={!m.actions.stop || locked} onClick={() => setConfirm({ action: "stop", model: m })}>
            {t("actions.stop")}
          </button>
          <button type="button" className="btn btn--sm" aria-label={t("actions.reloadModel", { model: m.label })} disabled={!m.actions.reload || locked} onClick={() => setConfirm({ action: "reload", model: m })}>
            {t("actions.reload")}
          </button>
          <button type="button" className="btn btn--sm btn--ghost" aria-label={t("actions.logsModel", { model: m.label })} onClick={() => setLogsFor({ modelKey: m.modelKey, label: m.label })}>
            {t("actions.logs")}
          </button>
        </div>
      </td>
    </tr>
  );

  const stale = refreshFailed || inventory?.stale === true;

  const note = clusterKindNote();
  const kind = memoryKind();

  return (
    <section className="mm-detail" aria-labelledby="mm-detail-title">
      <div className="panel tk-card">
        <div className="tk-card__head">
          <div>
            <h2 id="mm-detail-title" className="tk-card__title">
              {target.name}
            </h2>
            <p className="tk-card__sub">
              {target.hardware.label ? `${target.hardware.label} · ` : ""}
              {kind
                ? t("detail.memoryKind", { memory: formatMemory(target.hardware.memoryTotalBytes, unknown), kind })
                : t("detail.memory", { memory: formatMemory(target.hardware.memoryTotalBytes, unknown) })}
            </p>
            {target.kind === "cluster" ? (
              <p className="tk-card__sub">
                {t("detail.members", { members: target.memberIds.map(nodeName).join(", "), head: target.headId ? nodeName(target.headId) : unknown })}
              </p>
            ) : null}
            {target.kind === "node" && target.clusterIds.length ? (
              <p className="tk-card__sub">{t("detail.memberOf", { clusters: target.clusterIds.map((id) => targetName(`cluster:${id}`)).join(", ") })}</p>
            ) : null}
          </div>
          <div className="tk-card__tools mm-detail__tools">
            <button type="button" className="btn btn--sm" onClick={() => void loadInventory(true)} disabled={loading}>
              {loading ? t("refreshing") : t("detail.refreshInventory")}
            </button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setLogsFor({ modelKey: null, label: null })}>
              {t("actions.viewLogs")}
            </button>
            <button
              type="button"
              className="btn btn--sm btn--primary"
              disabled={locked || !inventory || switchCandidates.length === 0}
              onClick={() => {
                setActionError(null);
                setSwitchOpen(true);
              }}
            >
              {t("actions.switchModel")}
            </button>
          </div>
        </div>

        {note ? <p className="mm-note">{note}</p> : null}
        {target.busy && !opRunning ? <p className="mm-note">{t("detail.busyElsewhere")}</p> : null}

        {loadError ? (
          <div className="tk-note tk-note--err mm-alert" role="alert">
            {t("errors.inventory", { error: loadError })}
          </div>
        ) : null}
        {actionError && !confirm && !switchOpen ? (
          <div className="tk-note tk-note--err mm-alert" role="alert">
            {actionError}
          </div>
        ) : null}

        {inventory ? (
          <>
            {inventory.reachable === false ? <p className="mm-warn mm-warn--bad">{t("inventory.unreachable")}</p> : null}
            {inventory.stale ? <p className="mm-warn" role="status">{t("inventory.stale")}</p> : null}
            {refreshFailed && !inventory.stale ? (
              <p className="mm-warn" role="status">
                {t("inventory.refreshFailed")}
              </p>
            ) : null}
            {inventory.errors.length ? (
              <div className="mm-errors">
                <p className="mm-errors__title">{t("inventory.errorsTitle", { count: inventory.errors.length })}</p>
                <ul>
                  {inventory.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <p className="mm-faint mm-collected">{t("inventory.collectedAt", { time: new Date(inventory.collectedAt).toLocaleString() })}</p>

            <div className="mm-runtimes" aria-label={t("runtimes.title")} role="list">
              {inventory.runtimes.length === 0 ? <span className="mm-faint">{t("runtimes.none")}</span> : null}
              {inventory.runtimes.map((r, i) => (
                <div key={`${r.port ?? "none"}:${i}`} className="mm-runtime" role="listitem">
                  <span className="mm-runtime__engine">
                    {r.engine}
                    {r.port != null ? `:${r.port}` : ""}
                  </span>
                  <Tag tone={r.reachable === true ? "good" : r.reachable === false ? "bad" : "warn"} className={r.reachable == null ? "mm-state mm-state--uncertain" : "mm-state"}>
                    {runtimeReachLabel(r.reachable)}
                  </Tag>
                  {r.endpoint ? <span className="mm-runtime__endpoint">{r.endpoint}</span> : null}
                  {r.requestsRunning != null ? <span className="mm-runtime__requests">{t("runtimes.requests", { count: r.requestsRunning })}</span> : null}
                  {r.error ? <span className="mm-runtime__error">{r.error}</span> : null}
                  {r.note ? <span className="mm-runtime__note">{r.note}</span> : null}
                </div>
              ))}
            </div>
          </>
        ) : !loadError ? (
          <p className="mm-faint">{t("loading")}</p>
        ) : null}
      </div>

      {operation ? (
        <OperationPanel
          key={operation.operation.id}
          tracked={operation}
          modelLabel={modelLabel}
          onUpdate={(op) => onOperation({ operation: op, lost: false })}
          onFinished={onFinished}
          onLost={onLost}
          onDismiss={() => onOperation(null)}
        />
      ) : null}

      {inventory ? (
        <section className="panel tk-card" aria-labelledby="mm-models-title">
          <div className="tk-card__head">
            <h2 id="mm-models-title" className="tk-card__title">
              {t("models.title", { count: inventory.models.length })}
            </h2>
          </div>
          {inventory.models.length === 0 ? (
            <p className="tk-card__sub">{t("models.empty")}</p>
          ) : (
            <div className="tk-scroll">
              <table className="tk-table mm-table">
                <thead>
                  <tr>
                    <th scope="col">{t("table.model")}</th>
                    <th scope="col">{t("table.state")}</th>
                    <th scope="col">{t("table.engine")}</th>
                    <th scope="col">{t("table.quant")}</th>
                    <th scope="col" className="mm-num">{t("table.context")}</th>
                    <th scope="col" className="mm-num">{t("table.memory")}</th>
                    <th scope="col">{t("table.actions")}</th>
                  </tr>
                </thead>
                <tbody className={stale ? "mm-stale" : undefined}>{inventory.models.map(modelRow)}</tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {inventory && inventory.clusterModels.length ? (
        <section className="panel tk-card mm-cluster-models" aria-labelledby="mm-cluster-models-title">
          <div className="tk-card__head">
            <div>
              <h2 id="mm-cluster-models-title" className="tk-card__title">
                {t("models.clusterTitle")}
              </h2>
              <p className="tk-card__sub">{t("models.clusterSub")}</p>
            </div>
          </div>
          <div className="tk-scroll">
            <table className="tk-table mm-table">
              <thead>
                <tr>
                  <th scope="col">{t("table.model")}</th>
                  <th scope="col">{t("table.state")}</th>
                  <th scope="col">{t("table.engine")}</th>
                  <th scope="col">{t("table.servedBy")}</th>
                </tr>
              </thead>
              <tbody>
                {inventory.clusterModels.map((m) => (
                  <tr key={m.modelKey} data-model-key={m.modelKey} className={m.stale ? "mm-stale" : undefined} title={m.stale ? t("models.clusterRowStale") : undefined}>
                    <td>
                      <span className="mm-model__label">{m.label}</span>
                    </td>
                    <td>
                      <Tag tone={modelStateTone(m.state)} className={modelStateClass(m.state)}>
                        {modelStateLabel(t, m.state)}
                      </Tag>
                    </td>
                    <td>
                      {m.engine}
                      {m.port != null ? <span className="mm-faint">:{m.port}</span> : null}
                    </td>
                    <td className="mm-served-by">{t("models.servedBy", { cluster: targetName(m.servedBy) })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <ModelsDialog
        open={confirm != null}
        busy={actionBusy}
        onClose={() => {
          setConfirm(null);
          setActionError(null);
        }}
        tone={confirm?.action === "stop" ? "danger" : "neutral"}
        title={confirm ? confirmTitle(confirm.action, confirm.model) : ""}
        footer={
          <>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={actionBusy}
              onClick={() => {
                setConfirm(null);
                setActionError(null);
              }}
            >
              {t("dialog.cancel")}
            </button>
            <button
              type="button"
              className={`btn ${confirm?.action === "stop" ? "btn--danger" : "btn--primary"}`}
              disabled={actionBusy || !confirm}
              onClick={() => confirm && void run({ action: confirm.action, modelKey: confirm.model.modelKey })}
            >
              {actionBusy ? t("dialog.working") : confirm ? actionLabel(t, confirm.action) : ""}
            </button>
          </>
        }
      >
        {confirm ? <p>{confirmBody(confirm.action, confirm.model)}</p> : null}
        {actionError ? (
          <p className="modal-sheet__error" role="alert">
            {actionError}
          </p>
        ) : null}
      </ModelsDialog>

      <SwitchModelDialog
        open={switchOpen}
        target={target}
        inventory={inventory}
        busy={actionBusy}
        error={switchOpen ? actionError : null}
        onClose={() => {
          setSwitchOpen(false);
          setActionError(null);
        }}
        onConfirm={(req: SwitchRequest) => void run({ action: "switch", modelKey: req.modelKey, force: req.force, rollback: req.rollback })}
      />

      <LogsDialog
        open={logsFor != null}
        targetId={targetId}
        targetName={target.name}
        modelKey={logsFor?.modelKey ?? null}
        modelLabel={logsFor?.label ?? null}
        onClose={() => setLogsFor(null)}
      />
    </section>
  );
}
