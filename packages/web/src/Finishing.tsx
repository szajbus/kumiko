import { useState } from "react";
import type { SessionInfo } from "@kumiko/shared";
import { api, errorMessage } from "./api";
import { sessionTitle } from "./format";
import { finishingState } from "./status";

/** Sessions whose tab was closed while Claude worked, which it finishes out of sight. */
export const finishing = (sessions: readonly SessionInfo[]) => sessions.filter((s) => s.closing);

/** A session Claude is finishing after its tab closed: to open again, Claude still working, or to stop now. */
export function FinishingItem({ s, onOpened }: { s: SessionInfo; onOpened(id: string): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const act = async (what: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await what();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const state = finishingState(s);
  const until = s.closing ? new Date(s.closing.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  return (
    <li className="item item-finishing">
      <span className="item-main" title={s.prompt}>
        <span className="item-title">{sessionTitle(s)}</span>
        <span className="item-sub dim">
          {s.closing?.delete ? "Deleted" : "Closes"} once Claude is done, or stopped at {until}
          {error && <span className="item-error"> · {error}</span>}
        </span>
      </span>
      <span className="row-status item-state" style={{ color: state.color }}>
        <span className={`dot dot-small${state.pulse ? " dot-pulse" : ""}`} style={{ background: state.color }} aria-hidden="true" />
        {state.text}
      </span>
      <span className="item-actions">
        <button type="button" className="btn-small" disabled={busy} onClick={() => void act(async () => onOpened((await api.resumeSession(s.id)).id))}>
          Open
        </button>
        <button type="button" className="btn-small" disabled={busy} onClick={() => void act(() => api.closeSession(s.id, { stop: true }))}>
          Stop now
        </button>
      </span>
    </li>
  );
}

/** Every session Claude is finishing after its tab closed, for the Projects tab; nothing if there are none. */
export function FinishingCard({ sessions, onOpened }: { sessions: readonly SessionInfo[]; onOpened(id: string): void }) {
  const list = finishing(sessions);
  if (!list.length) return null;
  return (
    <section className="card section" aria-labelledby="finishing">
      <div className="card-head">
        <h2 id="finishing">Finishing in the background</h2>
      </div>
      <ul className="item-list">
        {list.map((s) => (
          <FinishingItem key={s.id} s={s} onOpened={onOpened} />
        ))}
      </ul>
    </section>
  );
}
