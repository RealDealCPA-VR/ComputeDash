import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { FleetOperation } from "../../api/fleetTypes";
import { AppLink } from "../ui/AppLink";
import { modelIdOf, modelsHref, operationProgress } from "../FleetBoard/fleetBoardModel";
import { useActiveOperations } from "../FleetBoard/useActiveOperations";

export const OPERATION_CHIP_POLL_MS = 5_000;

interface OperationChipProps {
  /** Poll only while the fleet model manager is on. */
  enabled: boolean;
  /** Display name for a targetId (falls back to the id). */
  nameOf: (targetId: string) => string;
  /** Open the Models page on that target. */
  onOpen: (targetId: string) => void;
}

/** What the live region last said, and the running operations (id → targetId) it was based on. */
interface Announced {
  operations: FleetOperation[] | null;
  /** null until the first answer (or while unavailable): operations already running then are not "starting". */
  running: Map<string, string> | null;
  text: string;
}

/**
 * Shell-level "a model operation is running" chip, beside the connection banner. Quiet when nothing
 * runs, when the server has no operations endpoint (404) or refuses it (401/403).
 *
 * The visible chip updates on every step; screen readers hear only a separate, visually hidden status
 * that changes when an operation starts or finishes.
 */
export function OperationChip({ enabled, nameOf, onOpen }: OperationChipProps) {
  const { t } = useTranslation("shell");
  const { operations } = useActiveOperations(enabled, OPERATION_CHIP_POLL_MS);
  const [announced, setAnnounced] = useState<Announced>({ operations: null, running: null, text: "" });
  if (operations !== announced.operations) {
    // Derived during render (React's "adjust state when a prop changes" pattern), not in an effect.
    let text = announced.text;
    const running = operations ? new Map(operations.map((o) => [o.id, o.targetId])) : null;
    if (running && announced.running) {
      const previous = announced.running;
      const started = operations!.find((o) => !previous.has(o.id));
      const finishedTarget = [...previous].find(([id]) => !running.has(id))?.[1];
      if (started) {
        text = actionText(t, started, modelIdOf(started.modelKey) || t("operations.unknownModel"), nameOf(started.targetId));
      } else if (finishedTarget !== undefined) {
        text = t("operations.finished", { target: nameOf(finishedTarget) });
      }
    }
    setAnnounced({ operations, running, text });
  }
  if (!enabled) return null;
  const status = (
    <span className="sr-only" role="status">
      {announced.text}
    </span>
  );
  if (!operations?.length) return status;
  const op = operations[0];
  const target = nameOf(op.targetId);
  const model = modelIdOf(op.modelKey) || t("operations.unknownModel");
  const progress = operationProgress(op);
  const text = actionText(t, op, model, target);
  return (
    <>
      {status}
      <div className="op-chip-row">
        <AppLink
          href={modelsHref(op.targetId)}
          className="op-chip"
          onNavigate={() => onOpen(op.targetId)}
          title={t("operations.open", { target })}
        >
          <i className="op-chip__dot" aria-hidden />
          <span className="op-chip__text">
            {text}
            {progress ? ` — ${t("operations.step", { step: progress.step, total: progress.total })}` : ""}
          </span>
          {operations.length > 1 ? <span className="op-chip__more">{t("operations.more", { count: operations.length - 1 })}</span> : null}
        </AppLink>
      </div>
    </>
  );
}

function actionText(t: TFunction, op: FleetOperation, model: string, target: string): string {
  switch (op.action) {
    case "switch": return t("operations.switch", { model, target });
    case "start": return t("operations.start", { model, target });
    case "stop": return t("operations.stop", { model, target });
    case "reload": return t("operations.reload", { model, target });
    default: return t("operations.other", { target });
  }
}
