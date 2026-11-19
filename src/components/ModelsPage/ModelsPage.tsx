import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getFleetStatus, getTargets } from "../../api/fleetClient";
import type { FleetStatus, FleetTarget } from "../../api/fleetTypes";
import { Tag } from "../ui/Tag";
import { ClusterDialog } from "./ClusterDialog";
import { TargetList } from "./TargetList";
import { TargetModels } from "./TargetModels";
import type { TrackedOperation } from "./OperationPanel";
import "../../styles/tokens.css";
import "../../styles/models.css";

/** While any target is busy, the list is re-read this often so members unlock when a cluster operation ends. */
export const TARGETS_BUSY_POLL_MS = 5000;

/** Nodes first, then clusters; the server's order is kept inside each group. */
export function orderTargets(targets: FleetTarget[]): FleetTarget[] {
  return [...targets.filter((x) => x.kind === "node"), ...targets.filter((x) => x.kind === "cluster")];
}

/** Fleet Model Manager: every node and cluster, its models, and manual lifecycle control. */
export function ModelsPage() {
  const { t } = useTranslation("models");
  const [status, setStatus] = useState<FleetStatus | null>(null);
  const [targets, setTargets] = useState<FleetTarget[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [operations, setOperations] = useState<Record<string, TrackedOperation>>({});
  const [clustersOpen, setClustersOpen] = useState(false);
  const seq = useRef(0);

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
    setLoading(false);
  }, [loadTargets]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep a valid selection: the first target by default, and never one that has disappeared.
  useEffect(() => {
    if (!targets) return;
    if (!selectedId || !targets.some((x) => x.targetId === selectedId)) setSelectedId(targets[0]?.targetId ?? null);
  }, [targets, selectedId]);

  const anyBusy = targets?.some((x) => x.busy) ?? false;
  useEffect(() => {
    if (!anyBusy) return;
    const id = setInterval(() => void loadTargets(), TARGETS_BUSY_POLL_MS);
    return () => clearInterval(id);
  }, [anyBusy, loadTargets]);

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
          <button type="button" className="btn btn--sm" onClick={() => void load()} disabled={loading}>
            {loading ? t("refreshing") : t("refresh")}
          </button>
        </div>
      </header>

      {status && !status.enabled ? (
        <div className="panel tk-note" role="status">
          {t("disabled")}
        </div>
      ) : null}

      {error ? (
        <div className="panel tk-note tk-note--err" role="alert">
          {t("errors.targets", { error })}
        </div>
      ) : null}

      {targets ? (
        targets.length === 0 ? (
          <div className="panel tk-note">{t("targets.empty")}</div>
        ) : (
          <div className="mm-layout">
            <TargetList targets={targets} selectedId={selectedId} onSelect={setSelectedId} />
            {selected ? (
              <TargetModels
                key={selected.targetId}
                target={selected}
                targets={targets}
                operation={operations[selected.targetId] ?? null}
                onOperation={(op) => setOperation(selected.targetId, op)}
                onTargetsChanged={onTargetsChanged}
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
      />
    </div>
  );
}
