import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cancelOperation, FleetApiError, readOperation } from "../../api/fleetClient";
import type { FleetLogLine, FleetOperation } from "../../api/fleetTypes";
import { LiveTerminal } from "../ui/LiveTerminal";
import { Tag } from "../ui/Tag";
import { actionLabel, operationStatusLabel, operationStatusTone, stepStatusLabel, stepStatusTone } from "./modelStateTone";

export const OPERATION_POLL_MS = 1000;

/**
 * The page's record of an operation. `lost` is client-side: the server no longer knows the id
 * (e.g. it restarted), so the outcome is unknown. It is never shown as succeeded or failed.
 */
export interface TrackedOperation {
  operation: FleetOperation;
  lost: boolean;
}

/** True while an operation is known to be in flight (a lost one no longer locks the target). */
export function isOperationRunning(tracked: TrackedOperation | null | undefined): boolean {
  return tracked != null && !tracked.lost && tracked.operation.status === "running";
}

interface OperationPanelProps {
  tracked: TrackedOperation;
  /** Human label for a modelKey (falls back to the key). */
  modelLabel: (modelKey: string) => string;
  /** Called with every newer operation snapshot (so the page can keep it across target switches). */
  onUpdate: (operation: FleetOperation) => void;
  /** Called once when the operation leaves `running`. */
  onFinished: (operation: FleetOperation) => void;
  /** Called once when the server answers 404 for the operation: its outcome is unknown. */
  onLost: (operation: FleetOperation) => void;
  onDismiss: () => void;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type PollState = "polling" | "retrying" | "auth" | "done";

/**
 * Live view of one fleet operation: polls every second with `since` until the status is no longer
 * `running`, showing each step and the log lines. A network failure keeps the last known state and
 * retries; 401 pauses until Retry; 404 marks the operation lost.
 */
export function OperationPanel({ tracked, modelLabel, onUpdate, onFinished, onLost, onDismiss }: OperationPanelProps) {
  const { t } = useTranslation("models");
  const initial = tracked.operation;
  const [op, setOp] = useState<FleetOperation>(initial);
  const [lost, setLost] = useState(tracked.lost);
  const [lines, setLines] = useState<FleetLogLine[]>([]);
  const [pollState, setPollState] = useState<PollState>(tracked.lost ? "done" : "polling");
  const [pollError, setPollError] = useState<string | null>(null);
  const [resume, setResume] = useState(0);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelState, setCancelState] = useState<"idle" | "pending" | "refused" | "error">("idle");
  const [cancelError, setCancelError] = useState<string | null>(null);
  const callbacks = useRef({ onUpdate, onFinished, onLost });
  callbacks.current = { onUpdate, onFinished, onLost };
  const opId = initial.id;
  // A panel re-opened on an operation that had already finished only fetches its log.
  const wasRunning = useRef(initial.status === "running");
  const since = useRef<number | undefined>(undefined);
  const lastSeq = useRef(-Infinity);
  const lostRef = useRef(tracked.lost);
  const latest = useRef<FleetOperation>(initial);

  useEffect(() => {
    // A lost operation is not polled again: the server has already said it does not know it.
    if (lostRef.current) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setPollState("polling");
    const tick = async () => {
      try {
        const res = await readOperation(opId, since.current);
        if (stopped) return;
        const fresh = res.lines.filter((line) => line.seq > lastSeq.current);
        if (fresh.length) {
          lastSeq.current = fresh[fresh.length - 1].seq;
          setLines((prev) => [...prev, ...fresh]);
        }
        since.current = res.nextSeq;
        latest.current = res.operation;
        setOp(res.operation);
        setPollError(null);
        setPollState("polling");
        callbacks.current.onUpdate(res.operation);
        if (res.operation.status !== "running") {
          setPollState("done");
          if (wasRunning.current) callbacks.current.onFinished(res.operation);
          return;
        }
        wasRunning.current = true;
      } catch (err) {
        if (stopped) return;
        setPollError(errorText(err));
        if (err instanceof FleetApiError && err.status === 404) {
          setPollState("done");
          // An operation already known to have finished keeps its final status; only a running one is lost.
          if (latest.current.status !== "running") return;
          // The server no longer knows this operation (restart): its outcome is unknown.
          lostRef.current = true;
          setLost(true);
          setPollState("done");
          callbacks.current.onLost(latest.current);
          return;
        }
        if (err instanceof FleetApiError && err.status === 401) {
          // Credentials were rejected (the token dialog opens once); wait for Retry instead of re-asking every second.
          setPollState("auth");
          return;
        }
        setPollState("retrying");
      }
      timer = setTimeout(() => void tick(), OPERATION_POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
    // Polling restarts on a new id or an explicit Retry (after a 401).
  }, [opId, resume]);

  const running = op.status === "running" && !lost;

  const cancel = async () => {
    setConfirmCancel(false);
    setCancelState("pending");
    setCancelError(null);
    try {
      const res = await cancelOperation(op.id);
      setCancelState(res.cancelled ? "idle" : "refused");
    } catch (err) {
      setCancelState("error");
      setCancelError(errorText(err));
    }
  };

  const fromLabel = op.fromModelKey ? modelLabel(op.fromModelKey) : null;

  return (
    <section className="panel mm-op" aria-labelledby={`mm-op-${op.id}`} data-status={lost ? "lost" : op.status}>
      <div className="mm-op__head">
        <div>
          <h3 id={`mm-op-${op.id}`} className="mm-op__title">
            {t("operation.title", { action: actionLabel(t, op.action), model: modelLabel(op.modelKey) })}
          </h3>
          {fromLabel ? <p className="mm-op__sub">{t("operation.from", { model: fromLabel })}</p> : null}
        </div>
        <div className="mm-op__tools">
          {lost ? (
            <Tag tone="warn" className="mm-op__status mm-state mm-state--uncertain">
              {t("operation.status.lost")}
            </Tag>
          ) : (
            <Tag tone={operationStatusTone(op.status)} className="mm-op__status">
              {operationStatusLabel(t, op.status)}
            </Tag>
          )}
          {pollState === "auth" ? (
            <button type="button" className="btn btn--sm" onClick={() => setResume((n) => n + 1)}>
              {t("operation.retry")}
            </button>
          ) : null}
          {running ? (
            confirmCancel ? null : (
              <button type="button" className="btn btn--sm btn--danger" onClick={() => setConfirmCancel(true)} disabled={cancelState === "pending"}>
                {cancelState === "pending" ? t("operation.cancelling") : t("operation.cancel")}
              </button>
            )
          ) : (
            <button type="button" className="btn btn--sm btn--ghost" onClick={onDismiss}>
              {t("operation.dismiss")}
            </button>
          )}
        </div>
      </div>

      {running && confirmCancel ? (
        <div className="mm-op__confirm" role="group" aria-label={t("operation.cancelConfirmTitle")}>
          <p>{t("operation.cancelConfirmBody")}</p>
          <div className="mm-op__confirm-actions">
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirmCancel(false)}>
              {t("operation.keepRunning")}
            </button>
            <button type="button" className="btn btn--sm btn--danger" onClick={() => void cancel()}>
              {t("operation.confirmCancel")}
            </button>
          </div>
        </div>
      ) : null}

      {lost ? <p className="mm-op__note" role="status">{t("operation.lost")}</p> : null}

      {op.steps.length ? (
        <ol className="mm-steps">
          {op.steps.map((step) => (
            <li key={step.id} className={`mm-step mm-step--${step.status}`} aria-current={step.id === op.step && running ? "step" : undefined}>
              <Tag tone={stepStatusTone(step.status)} className="mm-step__status">
                {stepStatusLabel(t, step.status)}
              </Tag>
              <span className="mm-step__label">{step.label}</span>
              {step.detail ? <span className="mm-step__detail">{step.detail}</span> : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="mm-faint">{t("operation.noSteps")}</p>
      )}

      {op.error ? (
        <p className="mm-op__error" role="alert">
          {t("operation.error", { error: op.error })}
        </p>
      ) : null}
      {cancelState === "refused" ? <p className="mm-op__note">{t("operation.cancelRefused")}</p> : null}
      {cancelState === "error" && cancelError ? (
        <p className="mm-op__error" role="alert">
          {t("operation.cancelFailed", { error: cancelError })}
        </p>
      ) : null}
      {pollState === "retrying" && pollError ? <p className="mm-op__note">{t("operation.pollError", { error: pollError })}</p> : null}
      {pollState === "auth" ? <p className="mm-op__note">{t("operation.authPaused")}</p> : null}

      <LiveTerminal lines={lines} running={running} className="mm-op__log" />
    </section>
  );
}
