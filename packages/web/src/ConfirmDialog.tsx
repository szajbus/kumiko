import { useEffect, useRef, type ReactNode } from "react";

interface Props {
  title: string;
  confirmLabel: string;
  danger?: boolean;
  /** Focuses the confirm button instead of Cancel, so Enter confirms (Esc always cancels). */
  enterConfirms?: boolean;
  children?: ReactNode;
  onConfirm(): void;
  onCancel(): void;
}

export function ConfirmDialog({ title, confirmLabel, danger, enterConfirms, children, onConfirm, onCancel }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    // React's autoFocus runs while the dialog is still closed, so showModal() falls back to the first button (Cancel).
    if (enterConfirms) confirmRef.current?.focus();
  }, []);
  return (
    <dialog ref={ref} className="dialog" onCancel={(e) => (e.preventDefault(), onCancel())} aria-labelledby="confirm-title">
      <h2 id="confirm-title">{title}</h2>
      <div className="dialog-body">{children}</div>
      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel} autoFocus={!enterConfirms}>
          Cancel
        </button>
        <button type="button" className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={onConfirm} ref={confirmRef}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
