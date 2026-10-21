import { createContext, useEffect, useId, useRef, useState, type ReactNode } from "react";

/** The title bar's top-right corner, for the open session to put its usage in; set once the header has rendered. */
export const HeaderCorner = createContext<HTMLElement | null>(null);

interface Props {
  /** What the button is called, for screen readers and its tooltip. */
  label: string;
  title?: string;
  /** What the button shows: kept small enough to sit in the title bar. */
  summary: ReactNode;
  /** The details it opens into; the build commit always comes last. */
  children?: ReactNode;
}

/** A compact summary in the title bar's corner that opens a box of details below it on click. */
export function Corner({ label, title, summary, children }: Props) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  // A click anywhere else or Escape closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="corner" ref={box}>
      <button
        ref={button}
        type="button"
        className={`corner-button${open ? " is-open" : ""}`}
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={open ? undefined : (title ?? label)}
        onClick={() => setOpen((o) => !o)}
      >
        {summary}
      </button>
      {open && (
        <div className="corner-details" id={id} role="dialog" aria-label={label}>
          {children}
          <dl className="corner-list corner-build">
            <dt>Build</dt>
            <dd className="mono">{__COMMIT_SHA__}</dd>
          </dl>
        </div>
      )}
    </div>
  );
}
