import { useContext, useEffect, useRef, useState } from "react";
import { WindowContext } from "./windowContext";

/** How long a reveal that failed says why, in the button's tooltip and colour. */
const FAILED_MS = 4000;

/** Shows `path`, a path in the sandbox's VM that is a file on this Mac, in the Finder. Nothing outside a session's window. */
export function RevealButton({ path, className, children }: { path: string; className: string; children?: React.ReactNode }) {
  const ctx = useContext(WindowContext);
  const [failed, setFailed] = useState<string | undefined>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!ctx) return null;
  const reveal = () => {
    ctx.reveal(path).then(
      () => setFailed(undefined),
      (err: unknown) => {
        setFailed(err instanceof Error ? err.message : String(err));
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setFailed(undefined), FAILED_MS);
      },
    );
  };
  return (
    <button type="button" className={`${className}${failed ? " is-failed" : ""}`} onClick={reveal} title={failed ?? `Reveal ${path} in Finder`} aria-label="Reveal in Finder">
      {children ?? <FinderIcon />}
    </button>
  );
}

/** A folder with an arrow out of it: where the file is on the Mac. */
const FinderIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M1.5 4.5A1.5 1.5 0 0 1 3 3h3l1.5 1.5H13A1.5 1.5 0 0 1 14.5 6v6.5A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    <path d="M6.5 11l3.5-3.5M7.5 7.5H10V10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
