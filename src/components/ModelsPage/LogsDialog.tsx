import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getLogs } from "../../api/fleetClient";
import type { FleetLogs } from "../../api/fleetTypes";
import { LiveTerminal } from "../ui/LiveTerminal";
import { ModelsDialog } from "./ModelsDialog";

interface LogsDialogProps {
  open: boolean;
  targetId: string;
  targetName: string;
  /** null = the target's runtime logs rather than one model's. */
  modelKey: string | null;
  modelLabel: string | null;
  onClose: () => void;
}

/** Read-only log viewer (launcher or Mac agent output) using the shared terminal view. */
export function LogsDialog({ open, targetId, targetName, modelKey, modelLabel, onClose }: LogsDialogProps) {
  const { t } = useTranslation("models");
  const [logs, setLogs] = useState<FleetLogs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await getLogs(targetId, modelKey);
      if (mine === seq.current) setLogs(res);
    } catch (err) {
      if (mine === seq.current) {
        setLogs(null);
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [targetId, modelKey]);

  useEffect(() => {
    if (!open) return;
    setLogs(null);
    void load();
  }, [open, load]);

  const sourceLabel = (source: FleetLogs["source"]) => {
    switch (source) {
      case "launcher": return t("logs.sourceLauncher");
      case "mac-agent": return t("logs.sourceMacAgent");
      default: return t("logs.sourceNone");
    }
  };

  return (
    <ModelsDialog
      open={open}
      onClose={onClose}
      wide
      title={modelLabel ? t("logs.titleModel", { model: modelLabel, target: targetName }) : t("logs.titleTarget", { target: targetName })}
      subtitle={logs ? t("logs.source", { source: sourceLabel(logs.source) }) : null}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={() => void load()} disabled={loading}>
            {loading ? t("refreshing") : t("refresh")}
          </button>
          <button type="button" className="btn btn--primary" onClick={onClose}>
            {t("dialog.close")}
          </button>
        </>
      }
    >
      {error ? (
        <p className="modal-sheet__error" role="alert">
          {t("errors.logs", { error })}
        </p>
      ) : null}
      {logs?.note ? <p className="mm-logs__note">{logs.note}</p> : null}
      {logs && logs.source === "none" && !logs.note ? <p className="mm-faint">{t("logs.none")}</p> : null}
      <LiveTerminal lines={logs?.lines ?? []} running={loading} maxVisible={5000} className="live-term--tall mm-logs__term" emptyText={t("logs.loading")} />
    </ModelsDialog>
  );
}
