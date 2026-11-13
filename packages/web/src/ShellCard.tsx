import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ShellChunk } from "@kumiko/shared";
import { api, errorMessage } from "./api";
import { COLORS } from "./status";
import { shellElapsed, shellNote, shellOutputParts, shellState, shellStatusText, type UserShells } from "./userShell";

/** The commands of the session on screen, for their cards in the chat. */
export interface UserShellsView {
  shells: UserShells;
  session: string;
  live: boolean;
}
export const UserShellsContext = createContext<UserShellsView>({ shells: {}, session: "", live: false });

/** How far from the bottom of the output it may be scrolled and still follow what comes in. */
const FOLLOW_PX = 24;

function Chunks({ chunks }: { chunks: ShellChunk[] }) {
  return chunks.map((c, i) => (c.stream === "err" ? <span key={i} className="shell-err">{c.text}</span> : <span key={i}>{c.text}</span>));
}

/**
 * A command the user ran (a message starting with "!"): its line, with Stop while it runs and how it ended once it
 * has, and what it printed. `prompted` when it went to Claude, which replies to it below. `actions` are its message
 * buttons, as a prompt's, which go on its line, as it takes the chat's width.
 */
export function ShellCard({ id, prompted, actions }: { id: string; prompted: boolean; actions?: ReactNode }) {
  const { shells, session, live } = useContext(UserShellsContext);
  const shell = shells[id];
  const out = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  const [, tick] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string>();
  const running = shell !== undefined && !shell.end;
  // The time it has run, as it runs.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);
  // Follows the output as it comes in, unless scrolled up to read it.
  useLayoutEffect(() => {
    const el = out.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [shell?.output]);
  if (!shell) return null;

  const state = shellState(shell);
  const status = shellStatusText(shell);
  const note = error ?? shellNote(shell, prompted);
  const parts = shellOutputParts(shell);
  const stop = async () => {
    setStopping(true);
    try {
      await api.stopShell(session, id);
    } catch (err) {
      setError(errorMessage(err));
      setStopping(false);
    }
  };

  return (
    <div className="shell-row">
      <div className={`shell shell-${state}`}>
        <div className="shell-head">
          <span className="shell-cmd" title={shell.command}>
            <b aria-hidden="true">!</b>
            {shell.command}
          </span>
          {actions}
          <span className="shell-state">
            {state === "running" ? <span className="spinner" aria-label="Running" /> : state === "ok" ? <Done /> : null}
            {status && <span className={`shell-status-${state}`}>{status}</span>}
            <span className="shell-time">{shellElapsed(shell)}</span>
            {running && live && (
              <button type="button" className="tool-show shell-stop" disabled={stopping} onClick={() => void stop()}>
                {stopping ? "Stopping…" : "Stop"}
              </button>
            )}
          </span>
        </div>
        {shell.output.length > 0 && (
          <pre
            ref={out}
            className="shell-out"
            onScroll={(e) => {
              const el = e.currentTarget;
              follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_PX;
            }}
          >
            <Chunks chunks={parts.head} />
            {parts.cut > 0 && <span className="shell-gap">{parts.cut.toLocaleString("en-US")} characters not kept here</span>}
            <Chunks chunks={parts.tail} />
          </pre>
        )}
        {note && <div className="shell-foot">{note}</div>}
      </div>
    </div>
  );
}

function Done() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-label="Done">
      <path d="M3 7.4l2.6 2.6L11 4.5" fill="none" stroke={COLORS.running} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
