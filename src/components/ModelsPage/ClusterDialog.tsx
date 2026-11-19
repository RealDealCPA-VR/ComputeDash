import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { createCluster, deleteCluster, isBusyError, isTokenRequiredError, listClusters, updateCluster } from "../../api/fleetClient";
import type { FleetCluster, FleetClusterInput, FleetClustersResponse, FleetTarget } from "../../api/fleetTypes";
import { Tag } from "../ui/Tag";
import { ModelsDialog } from "./ModelsDialog";

/** Form state: text fields stay strings until they are validated. */
export interface ClusterDraft {
  id: string;
  name: string;
  kind: "distributed" | "group";
  memberIds: string[];
  headId: string;
  host: string;
  port: string;
  engine: string;
  launcherId: string;
  notes: string;
}

export type ClusterDraftError = "name" | "members" | "duplicateMembers" | "head" | "port";

export const EMPTY_DRAFT: ClusterDraft = {
  id: "",
  name: "",
  kind: "distributed",
  memberIds: [],
  headId: "",
  host: "",
  port: "",
  engine: "",
  launcherId: "",
  notes: "",
};

export function draftFromCluster(cluster: FleetCluster): ClusterDraft {
  return {
    id: cluster.id,
    name: cluster.name,
    kind: cluster.kind,
    memberIds: [...cluster.memberIds],
    headId: cluster.headId,
    host: cluster.endpoint?.host ?? "",
    port: cluster.endpoint ? String(cluster.endpoint.port) : "",
    engine: cluster.engine ?? "",
    launcherId: cluster.launcherId ?? "",
    notes: cluster.notes ?? "",
  };
}

/** Plan §3.2: ≥ 2 unique members, the head among them, and a port 1–65535 for a distributed cluster. */
export function validateClusterDraft(draft: ClusterDraft): ClusterDraftError[] {
  const errors: ClusterDraftError[] = [];
  if (!draft.name.trim()) errors.push("name");
  if (new Set(draft.memberIds).size !== draft.memberIds.length) errors.push("duplicateMembers");
  if (new Set(draft.memberIds).size < 2) errors.push("members");
  if (!draft.headId || !draft.memberIds.includes(draft.headId)) errors.push("head");
  if (draft.kind === "distributed") {
    const raw = draft.port.trim();
    const port = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port < 1 || port > 65535) errors.push("port");
  }
  return errors;
}

/** Request body for a valid draft. A visual group carries no endpoint, engine or launcher. */
export function clusterInputFromDraft(draft: ClusterDraft, includeId: boolean): FleetClusterInput {
  const distributed = draft.kind === "distributed";
  const input: FleetClusterInput = {
    name: draft.name.trim(),
    kind: draft.kind,
    memberIds: [...draft.memberIds],
    headId: draft.headId,
    endpoint: distributed ? { host: draft.host.trim() || null, port: Number(draft.port.trim()) } : null,
    engine: distributed ? draft.engine.trim() || null : null,
    launcherId: distributed ? draft.launcherId.trim() || null : null,
    notes: draft.notes,
  };
  if (includeId && draft.id.trim()) input.id = draft.id.trim();
  return input;
}

type View =
  | { mode: "list" }
  | { mode: "edit"; originalId: string | null; draft: ClusterDraft; touched: boolean }
  | { mode: "delete"; cluster: FleetCluster };

interface ClusterDialogProps {
  open: boolean;
  /** Registry nodes: cluster members are their unit ids. */
  nodes: FleetTarget[];
  onClose: () => void;
  /** A cluster was created, changed or deleted: the target list needs a refresh. */
  onChanged: () => void;
  /** Cluster changes are refused until the dashboard has an access token: edits stay disabled. */
  controlLocked?: boolean;
  /** A change was refused with 403 token_required. */
  onTokenRequired?: () => void;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Create, edit and delete logical clusters, or adopt a suggested one. Nothing is created without a save. */
export function ClusterDialog({ open, nodes, onClose, onChanged, controlLocked = false, onTokenRequired }: ClusterDialogProps) {
  const { t } = useTranslation("models");
  const formId = useId();
  const [data, setData] = useState<FleetClustersResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ mode: "list" });
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setData(await listClusters());
    } catch (err) {
      setData(null);
      setLoadError(errorText(err));
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setView({ mode: "list" });
    setSaveError(null);
    void load();
  }, [open, load]);

  const nodeName = (unitId: string) => nodes.find((n) => n.id === unitId)?.name ?? unitId;

  const kindLabel = (kind: string) => {
    switch (kind) {
      case "distributed": return t("targets.kindDistributed");
      case "group": return t("targets.kindGroup");
      default: return kind;
    }
  };

  const draftErrorLabel = (code: ClusterDraftError) => {
    switch (code) {
      case "name": return t("clusters.validation.name");
      case "members": return t("clusters.validation.members");
      case "duplicateMembers": return t("clusters.validation.duplicateMembers");
      case "head": return t("clusters.validation.head");
      case "port": return t("clusters.validation.port");
      default: return code;
    }
  };

  // Disabled controls point at the dialog's visible token note.
  const tokenNoteId = useId();
  const tokenHint = controlLocked ? { "aria-describedby": tokenNoteId } : {};

  const failureText = (err: unknown) =>
    isTokenRequiredError(err) ? t("token.banner") : isBusyError(err) ? t("errors.busy", { error: errorText(err) }) : t("errors.cluster", { error: errorText(err) });
  const deleteFailureText = (err: unknown) =>
    isTokenRequiredError(err) ? t("token.banner") : isBusyError(err) ? t("errors.busy", { error: errorText(err) }) : t("errors.clusterDelete", { error: errorText(err) });

  const edit = (originalId: string | null, draft: ClusterDraft) => {
    setSaveError(null);
    setView({ mode: "edit", originalId, draft, touched: false });
  };

  const setDraft = (patch: Partial<ClusterDraft>) => {
    setView((v) => (v.mode === "edit" ? { ...v, draft: { ...v.draft, ...patch } } : v));
  };

  const toggleMember = (unitId: string, checked: boolean) => {
    setView((v) => {
      if (v.mode !== "edit") return v;
      const memberIds = checked ? [...v.draft.memberIds.filter((id) => id !== unitId), unitId] : v.draft.memberIds.filter((id) => id !== unitId);
      const headId = memberIds.includes(v.draft.headId) ? v.draft.headId : memberIds[0] ?? "";
      return { ...v, draft: { ...v.draft, memberIds, headId } };
    });
  };

  const save = async () => {
    if (view.mode !== "edit") return;
    const errors = validateClusterDraft(view.draft);
    if (errors.length) {
      setView({ ...view, touched: true });
      return;
    }
    setBusy(true);
    setSaveError(null);
    try {
      if (view.originalId) {
        await updateCluster(view.originalId, clusterInputFromDraft(view.draft, false));
      } else {
        await createCluster(clusterInputFromDraft(view.draft, true));
      }
      onChanged();
      setView({ mode: "list" });
      await load();
    } catch (err) {
      if (isTokenRequiredError(err)) onTokenRequired?.();
      setSaveError(failureText(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (view.mode !== "delete") return;
    setBusy(true);
    setSaveError(null);
    try {
      await deleteCluster(view.cluster.id);
      onChanged();
      setView({ mode: "list" });
      await load();
    } catch (err) {
      if (isTokenRequiredError(err)) onTokenRequired?.();
      setSaveError(deleteFailureText(err));
    } finally {
      setBusy(false);
    }
  };

  const endpointText = (cluster: FleetCluster) => {
    if (!cluster.endpoint) return t("clusters.noEndpoint");
    return `${cluster.endpoint.host ?? t("clusters.headHost")}:${cluster.endpoint.port}`;
  };

  const clusterRow = (cluster: FleetCluster, suggestion: boolean) => (
    <li key={`${suggestion ? "s" : "c"}:${cluster.id}`} className="mm-cluster">
      <div className="mm-cluster__head">
        <span className="mm-cluster__name">{cluster.name}</span>
        <span className={`mm-kind mm-kind--${cluster.kind}`}>{kindLabel(cluster.kind)}</span>
        {suggestion ? <Tag tone="info">{t("clusters.suggested")}</Tag> : null}
      </div>
      <p className="mm-cluster__meta">
        {t("clusters.membersLine", { members: cluster.memberIds.map(nodeName).join(", "), head: nodeName(cluster.headId) })}
      </p>
      {cluster.kind === "distributed" ? <p className="mm-cluster__meta">{t("clusters.endpointLine", { endpoint: endpointText(cluster) })}</p> : null}
      <div className="mm-cluster__tools">
        {suggestion ? (
          <button type="button" className="btn btn--sm btn--primary" disabled={controlLocked} {...tokenHint} onClick={() => edit(null, draftFromCluster(cluster))}>
            {t("clusters.useSuggestion")}
          </button>
        ) : (
          <>
            <button type="button" className="btn btn--sm" disabled={controlLocked} {...tokenHint} onClick={() => edit(cluster.id, draftFromCluster(cluster))}>
              {t("clusters.edit")}
            </button>
            <button
              type="button"
              className="btn btn--sm btn--danger"
              disabled={controlLocked}
              {...tokenHint}
              onClick={() => {
                setSaveError(null);
                setView({ mode: "delete", cluster });
              }}
            >
              {t("clusters.delete")}
            </button>
          </>
        )}
      </div>
    </li>
  );

  let title = t("clusters.title");
  let body: ReactNode;
  let footer: ReactNode;

  if (view.mode === "edit") {
    const { draft } = view;
    const errors = view.touched ? validateClusterDraft(draft) : [];
    const candidateIds = [...nodes.map((n) => n.id), ...draft.memberIds.filter((id) => !nodes.some((n) => n.id === id))];
    title = view.originalId ? t("clusters.editTitle", { name: draft.name || view.originalId }) : t("clusters.createTitle");
    body = (
      <form
        id={formId}
        className="mm-cluster-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="field-row">
          <div className="field">
            <label htmlFor={`${formId}-name`}>{t("clusters.field.name")}</label>
            <input id={`${formId}-name`} type="text" value={draft.name} onChange={(e) => setDraft({ name: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor={`${formId}-id`}>{t("clusters.field.id")}</label>
            <input
              id={`${formId}-id`}
              type="text"
              className="field-input--mono"
              value={draft.id}
              disabled={view.originalId != null}
              onChange={(e) => setDraft({ id: e.target.value })}
            />
            <p className="field-hint">{view.originalId ? t("clusters.field.idFixed") : t("clusters.field.idHint")}</p>
          </div>
        </div>
        <div className="field">
          <label htmlFor={`${formId}-kind`}>{t("clusters.field.kind")}</label>
          <select id={`${formId}-kind`} value={draft.kind} onChange={(e) => setDraft({ kind: e.target.value === "group" ? "group" : "distributed" })}>
            <option value="distributed">{t("targets.kindDistributed")}</option>
            <option value="group">{t("targets.kindGroup")}</option>
          </select>
          <p className="field-hint">{draft.kind === "distributed" ? t("clusters.field.kindDistributedHint") : t("clusters.field.kindGroupHint")}</p>
        </div>
        <fieldset className="field mm-cluster-form__members">
          <legend className="field-label">{t("clusters.field.members")}</legend>
          {candidateIds.length === 0 ? <p className="mm-faint">{t("clusters.field.noNodes")}</p> : null}
          {candidateIds.map((unitId) => (
            <label key={unitId} className="check-row">
              <input type="checkbox" value={unitId} checked={draft.memberIds.includes(unitId)} onChange={(e) => toggleMember(unitId, e.target.checked)} />
              <span>
                {nodeName(unitId)} <span className="mm-faint">{unitId}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="field">
          <label htmlFor={`${formId}-head`}>{t("clusters.field.head")}</label>
          <select id={`${formId}-head`} value={draft.headId} onChange={(e) => setDraft({ headId: e.target.value })}>
            <option value="">{t("clusters.field.headNone")}</option>
            {draft.memberIds.map((unitId) => (
              <option key={unitId} value={unitId}>
                {nodeName(unitId)}
              </option>
            ))}
          </select>
        </div>
        {draft.kind === "distributed" ? (
          <>
            <div className="field-row">
              <div className="field">
                <label htmlFor={`${formId}-host`}>{t("clusters.field.host")}</label>
                <input id={`${formId}-host`} type="text" className="field-input--mono" value={draft.host} onChange={(e) => setDraft({ host: e.target.value })} />
                <p className="field-hint">{t("clusters.field.hostHint")}</p>
              </div>
              <div className="field field--port">
                <label htmlFor={`${formId}-port`}>{t("clusters.field.port")}</label>
                <input
                  id={`${formId}-port`}
                  type="number"
                  min={1}
                  max={65535}
                  className="field-input--port"
                  value={draft.port}
                  onChange={(e) => setDraft({ port: e.target.value })}
                />
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label htmlFor={`${formId}-engine`}>{t("clusters.field.engine")}</label>
                <input id={`${formId}-engine`} type="text" value={draft.engine} onChange={(e) => setDraft({ engine: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor={`${formId}-launcher`}>{t("clusters.field.launcher")}</label>
                <input id={`${formId}-launcher`} type="text" className="field-input--mono" value={draft.launcherId} onChange={(e) => setDraft({ launcherId: e.target.value })} />
                <p className="field-hint">{t("clusters.field.launcherHint")}</p>
              </div>
            </div>
          </>
        ) : null}
        <div className="field">
          <label htmlFor={`${formId}-notes`}>{t("clusters.field.notes")}</label>
          <textarea id={`${formId}-notes`} className="mm-textarea" rows={2} value={draft.notes} onChange={(e) => setDraft({ notes: e.target.value })} />
        </div>
        {errors.length ? (
          <ul className="modal-sheet__error mm-validation" role="alert">
            {errors.map((code) => (
              <li key={code}>{draftErrorLabel(code)}</li>
            ))}
          </ul>
        ) : null}
      </form>
    );
    footer = (
      <>
        <button type="button" className="btn btn--ghost" onClick={() => setView({ mode: "list" })} disabled={busy}>
          {t("dialog.back")}
        </button>
        <button type="submit" form={formId} className="btn btn--primary" disabled={busy || controlLocked} {...tokenHint}>
          {busy ? t("dialog.working") : t("clusters.save")}
        </button>
      </>
    );
  } else if (view.mode === "delete") {
    title = t("clusters.deleteTitle", { name: view.cluster.name });
    body = <p>{t("clusters.deleteBody", { name: view.cluster.name })}</p>;
    footer = (
      <>
        <button type="button" className="btn btn--ghost" onClick={() => setView({ mode: "list" })} disabled={busy}>
          {t("dialog.back")}
        </button>
        <button type="button" className="btn btn--danger" onClick={() => void remove()} disabled={busy || controlLocked} {...tokenHint}>
          {busy ? t("dialog.working") : t("clusters.confirmDelete")}
        </button>
      </>
    );
  } else {
    body = (
      <>
        {loadError ? (
          <p className="modal-sheet__error" role="alert">
            {t("errors.clusters", { error: loadError })}
          </p>
        ) : null}
        {data ? (
          <>
            {data.clusters.length ? <ul className="mm-cluster-list">{data.clusters.map((c) => clusterRow(c, false))}</ul> : <p className="mm-faint">{t("clusters.empty")}</p>}
            {data.suggestions.length ? (
              <>
                <h3 className="mm-subhead">{t("clusters.suggestions")}</h3>
                <ul className="mm-cluster-list">{data.suggestions.map((c) => clusterRow(c, true))}</ul>
              </>
            ) : null}
          </>
        ) : !loadError ? (
          <p className="mm-faint">{t("loading")}</p>
        ) : null}
      </>
    );
    footer = (
      <>
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          {t("dialog.close")}
        </button>
        <button type="button" className="btn btn--primary" disabled={controlLocked} {...tokenHint} onClick={() => edit(null, { ...EMPTY_DRAFT })}>
          {t("clusters.create")}
        </button>
      </>
    );
  }

  return (
    <ModelsDialog open={open} busy={busy} onClose={onClose} title={title} tone={view.mode === "delete" ? "danger" : "neutral"} wide footer={footer}>
      {controlLocked ? (
        <p id={tokenNoteId} className="mm-token-note" role="status">
          {t("token.banner")}
        </p>
      ) : null}
      {body}
      {saveError ? (
        <p className="modal-sheet__error" role="alert">
          {saveError}
        </p>
      ) : null}
    </ModelsDialog>
  );
}
