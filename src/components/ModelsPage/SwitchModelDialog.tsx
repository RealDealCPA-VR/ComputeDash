import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FleetInventory, FleetModel, FleetTarget } from "../../api/fleetTypes";
import { Tag } from "../ui/Tag";
import { ModelsDialog } from "./ModelsDialog";
import { formatMemory, modelStateClass, modelStateLabel, modelStateTone } from "./modelStateTone";

export interface SwitchRequest {
  modelKey: string;
  force: boolean;
  rollback: boolean;
}

interface SwitchModelDialogProps {
  open: boolean;
  target: FleetTarget;
  inventory: FleetInventory | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (request: SwitchRequest) => void;
}

/** Capacity verdict for an estimate against the target's total memory. Unknown stays unknown. */
export function capacityCheck(estimate: number | null, capacity: number | null): "fits" | "exceeds" | "unknown" {
  if (estimate == null || capacity == null || !Number.isFinite(estimate) || !Number.isFinite(capacity) || capacity <= 0) return "unknown";
  return estimate > capacity ? "exceeds" : "fits";
}

/** Choose a model from the target's catalog and switch to it, after a confirmation step. */
export function SwitchModelDialog({ open, target, inventory, busy, error, onClose, onConfirm }: SwitchModelDialogProps) {
  const { t } = useTranslation("models");
  const groupId = useId();
  const candidates = useMemo(() => (inventory?.models ?? []).filter((m) => m.actions.switchTo), [inventory]);
  const current = useMemo(() => (inventory?.models ?? []).filter((m) => m.state === "serving"), [inventory]);
  const [modelKey, setModelKey] = useState<string | null>(null);
  const [force, setForce] = useState(false);
  const [rollback, setRollback] = useState(true);
  const [reviewing, setReviewing] = useState(false);

  // Each opening starts from a clean form; rollback is on by default.
  useEffect(() => {
    if (!open) return;
    setModelKey(null);
    setForce(false);
    setRollback(true);
    setReviewing(false);
  }, [open]);

  const selected: FleetModel | null = candidates.find((m) => m.modelKey === modelKey) ?? null;
  const capacity = target.hardware.memoryTotalBytes;
  const verdict = capacityCheck(selected?.estMemoryBytes ?? null, capacity);
  const unknown = t("unknown");
  const needsForce = verdict === "exceeds" && !force;
  const canContinue = selected != null && !needsForce && !busy;
  const currentLabel = current.length ? current.map((m) => m.label).join(", ") : t("switch.noneServing");

  const footer = reviewing ? (
    <>
      <button type="button" className="btn btn--ghost" onClick={() => setReviewing(false)} disabled={busy}>
        {t("dialog.back")}
      </button>
      <button type="button" className="btn btn--primary" onClick={() => selected && onConfirm({ modelKey: selected.modelKey, force, rollback })} disabled={!canContinue}>
        {busy ? t("dialog.working") : t("switch.confirm")}
      </button>
    </>
  ) : (
    <>
      <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
        {t("dialog.cancel")}
      </button>
      <button type="button" className="btn btn--primary" onClick={() => setReviewing(true)} disabled={!canContinue}>
        {t("switch.review")}
      </button>
    </>
  );

  return (
    <ModelsDialog open={open} busy={busy} onClose={onClose} title={t("switch.title", { target: target.name })} wide footer={footer}>
      <p className="mm-switch__current">
        <span className="mm-switch__k">{t("switch.current")}</span> <span>{currentLabel}</span>
      </p>

      {reviewing && selected ? (
        <div className="mm-switch__review" role="group" aria-label={t("switch.reviewTitle")}>
          <p>{t("switch.reviewBody", { target: target.name, from: currentLabel, to: selected.label })}</p>
          <ul className="mm-switch__summary">
            <li>{t("switch.memoryLine", { estimate: formatMemory(selected.estMemoryBytes, unknown), capacity: formatMemory(capacity, unknown) })}</li>
            <li>{force ? t("switch.forceOn") : t("switch.forceOff")}</li>
            <li>{rollback ? t("switch.rollbackOn") : t("switch.rollbackOff")}</li>
          </ul>
        </div>
      ) : (
        <>
          {candidates.length === 0 ? (
            <p className="mm-faint">{t("switch.noCandidates")}</p>
          ) : (
            <fieldset className="mm-switch__list" aria-labelledby={`${groupId}-label`}>
              <legend id={`${groupId}-label`} className="field-label">
                {t("switch.choose")}
              </legend>
              {candidates.map((m) => (
                <label key={m.modelKey} className={`mm-switch__option${modelKey === m.modelKey ? " is-selected" : ""}`}>
                  <input type="radio" name={`${groupId}-model`} value={m.modelKey} checked={modelKey === m.modelKey} onChange={() => setModelKey(m.modelKey)} />
                  <span className="mm-switch__name">{m.label}</span>
                  <span className="mm-switch__meta">
                    {m.engine}
                    {m.port != null ? `:${m.port}` : ""}
                  </span>
                  <Tag tone={modelStateTone(m.state)} className={modelStateClass(m.state)}>
                    {modelStateLabel(t, m.state)}
                  </Tag>
                  <span className="mm-switch__meta">{formatMemory(m.estMemoryBytes, unknown)}</span>
                </label>
              ))}
            </fieldset>
          )}

          {selected ? (
            <div className={`mm-switch__capacity mm-switch__capacity--${verdict}`} role="status">
              <span>{t("switch.memoryLine", { estimate: formatMemory(selected.estMemoryBytes, unknown), capacity: formatMemory(capacity, unknown) })}</span>
              {verdict === "exceeds" ? <span>{t("switch.exceeds")}</span> : null}
              {verdict === "unknown" ? <span>{t("switch.capacityUnknown")}</span> : null}
            </div>
          ) : null}

          <label className="check-row">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            <span>
              {t("switch.force")}
              <span className="field-hint">{t("switch.forceHint")}</span>
            </span>
          </label>
          <label className="check-row">
            <input type="checkbox" checked={rollback} onChange={(e) => setRollback(e.target.checked)} />
            <span>
              {t("switch.rollback")}
              <span className="field-hint">{t("switch.rollbackHint")}</span>
            </span>
          </label>
          {needsForce && selected ? <p className="field-hint is-warn">{t("switch.needsForce")}</p> : null}
        </>
      )}

      {error ? (
        <p className="modal-sheet__error" role="alert">
          {error}
        </p>
      ) : null}
    </ModelsDialog>
  );
}
