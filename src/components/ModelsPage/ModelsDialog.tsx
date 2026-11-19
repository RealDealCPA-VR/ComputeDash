import { useEffect, useId, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useModalPresence } from "../../hooks/useModalPresence";
import { useOverlayClose } from "../../hooks/useOverlayClose";
import "../../styles/dialogs.css";

interface ModelsDialogProps {
  open: boolean;
  /** Closing is blocked while a request runs. */
  busy?: boolean;
  onClose: () => void;
  title: string;
  /** Optional line under the title. */
  subtitle?: ReactNode;
  tone?: "danger" | "neutral";
  wide?: boolean;
  children: ReactNode;
  footer: ReactNode;
}

/** Modal shell shared by the Models page dialogs (same structure as the Storage Manager's StorageDialog). */
export function ModelsDialog({ open, busy = false, onClose, title, subtitle, tone = "neutral", wide = false, children, footer }: ModelsDialogProps) {
  const titleId = useId();
  const { mounted, visible } = useModalPresence(open);
  const trapRef = useFocusTrap(mounted);
  const overlayClose = useOverlayClose(onClose, !busy);

  useEffect(() => {
    if (!open || busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  if (!mounted) return null;
  return createPortal(
    <div className={`modal-overlay${visible ? " is-open" : ""}`} {...overlayClose}>
      <div
        ref={trapRef}
        className={`modal-sheet mm-dialog${wide ? " modal-sheet--wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className={`modal-sheet__header${tone === "danger" ? " modal-sheet__header--danger" : ""}`}>
          <div className="modal-sheet__heading">
            <h2 className="modal-sheet__title" id={titleId}>
              {title}
            </h2>
            {subtitle ? <p className="modal-sheet__sub">{subtitle}</p> : null}
          </div>
        </div>
        <div className="modal-sheet__body modal-sheet__stack">{children}</div>
        <div className="modal-sheet__footer">
          <div className="modal-sheet__footer-actions">{footer}</div>
        </div>
      </div>
    </div>,
    document.body
  );
}
