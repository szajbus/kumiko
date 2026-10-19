import type { ReactNode } from "react";
import type { SessionInfo } from "@bentomo/shared";
import { Logo, Plus } from "./icons";
import { sessionStatus } from "./status";

export type TabId = "sandboxes" | "new-session" | `session:${string}`;

interface Props {
  sessions: SessionInfo[];
  newSessionOpen: boolean;
  active: TabId;
  onSelect(tab: TabId): void;
  onClose(tab: TabId): void;
  onNewSession(): void;
}

/** A session's tab title: its sandbox and the first words of the opening prompt. */
export function sessionTitle(s: SessionInfo): string {
  const words = s.prompt.split(/\s+/).filter(Boolean);
  let text = "";
  for (const w of words) {
    if ((text + " " + w).trim().length > 28) return `${s.sandbox} · ${text || w.slice(0, 28)}…`;
    text = (text + " " + w).trim();
  }
  return `${s.sandbox} · ${text}`;
}

/** The window's title bar: the Sandboxes tab, a tab per session, and + to start a new one. */
export function Header({ sessions, newSessionOpen, active, onSelect, onClose, onNewSession }: Props) {
  return (
    <header className="app-header">
      <div className="tabbar">
        <nav className="tabs" role="tablist" aria-label="Tabs">
          <Tab id="sandboxes" active={active} onSelect={onSelect} label="Sandboxes" icon={<Logo size={14} />} home />
          {sessions.map((s) => {
            const st = sessionStatus(s.status);
            return (
              <Tab
                key={s.id}
                id={`session:${s.id}`}
                active={active}
                onSelect={onSelect}
                onClose={onClose}
                label={sessionTitle(s)}
                title={`${sessionTitle(s)} · ${st.text}`}
                dot={st.color}
                pulse={s.status === "running" || s.status === "starting"}
              />
            );
          })}
          {newSessionOpen && <Tab id="new-session" active={active} onSelect={onSelect} onClose={onClose} label="New session" />}
        </nav>
        <button type="button" className="tab-new" aria-label="New session" title="New session" onClick={onNewSession}>
          <Plus size={14} />
        </button>
      </div>
      <span className="build-sha" title="Build commit">{__COMMIT_SHA__}</span>
    </header>
  );
}

interface TabProps {
  id: TabId;
  active: TabId;
  label: string;
  title?: string;
  dot?: string;
  pulse?: boolean;
  icon?: ReactNode;
  /** The Sandboxes tab: styled apart from sessions. */
  home?: boolean;
  onSelect(tab: TabId): void;
  onClose?(tab: TabId): void;
}

function Tab({ id, active, label, title, dot, pulse, icon, home, onSelect, onClose }: TabProps) {
  const selected = id === active;
  return (
    <div className={`tab${home ? " tab-home" : ""}${selected ? " is-active" : ""}`}>
      <button type="button" role="tab" aria-selected={selected} className="tab-main" title={title ?? label} onClick={() => onSelect(id)}>
        {icon}
        {dot && <span className={`dot dot-small${pulse ? " dot-pulse" : ""}`} style={{ background: dot }} aria-hidden="true" />}
        <span className="tab-label">{label}</span>
      </button>
      {onClose && (
        <button type="button" className="tab-close" aria-label={`Close ${label}`} title="Close" onClick={() => onClose(id)}>
          <svg width="10" height="10" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}
