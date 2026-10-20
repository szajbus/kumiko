import { useState, type DragEvent } from "react";
import type { SessionInfo } from "@kumiko/shared";
import { Logo, Plus } from "./icons";
import { sessionTitle } from "./format";
import { sessionState } from "./status";

export type TabId = "projects" | `new-session:${string}` | `session:${string}`;

/** A New session tab: `key` tells it apart from the others, `project` is the one picked in it, if any. */
export interface NewSessionTab {
  key: string;
  project?: string;
}

interface Props {
  sessions: SessionInfo[];
  newSessions: NewSessionTab[];
  /** The session and New session tabs, in the order to show them. */
  order: TabId[];
  active: TabId;
  onSelect(tab: TabId): void;
  onClose(tab: TabId): void;
  /** `tab` was dragged to just before `target`, or just after it with `after`. */
  onMove(tab: TabId, target: TabId, after: boolean): void;
  onNewSession(): void;
}

/** Where a dragged tab would land if dropped now. */
interface DropAt {
  target: TabId;
  after: boolean;
}

/** The window's title bar: the Projects button, a tab per session, which drag to reorder, and + to start a new one. */
export function Header({ sessions, newSessions, order, active, onSelect, onClose, onMove, onNewSession }: Props) {
  const [dragging, setDragging] = useState<TabId | undefined>();
  const [dropAt, setDropAt] = useState<DropAt | undefined>();

  const drag = (id: TabId): DragProps => ({
    dragging: dragging === id,
    drop: dropAt?.target === id && dragging !== id ? (dropAt.after ? "after" : "before") : undefined,
    onDragStart(e) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", id);
      setDragging(id);
    },
    onDragOver(e) {
      if (!dragging) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const box = e.currentTarget.getBoundingClientRect();
      const after = e.clientX > box.left + box.width / 2;
      if (dropAt?.target !== id || dropAt.after !== after) setDropAt({ target: id, after });
    },
    onDrop(e) {
      e.preventDefault();
      if (dragging && dropAt) onMove(dragging, dropAt.target, dropAt.after);
      setDragging(undefined);
      setDropAt(undefined);
    },
    onDragEnd() {
      setDragging(undefined);
      setDropAt(undefined);
    },
  });

  const tab = (id: TabId) => {
    if (id.startsWith("session:")) {
      const s = sessions.find((x) => `session:${x.id}` === id);
      if (!s) return null;
      const st = sessionState(s);
      return (
        <Tab
          key={id}
          id={id}
          active={active}
          onSelect={onSelect}
          onClose={onClose}
          label={sessionTitle(s)}
          title={`${sessionTitle(s)} · ${st.text}`}
          dot={st.color}
          pulse={s.status === "running" || s.status === "starting"}
          {...drag(id)}
        />
      );
    }
    const n = newSessions.find((x) => `new-session:${x.key}` === id);
    if (!n) return null;
    return (
      <Tab
        key={id}
        id={id}
        active={active}
        onSelect={onSelect}
        onClose={onClose}
        label={n.project ? `${n.project} · New session` : "New session"}
        {...drag(id)}
      />
    );
  };

  return (
    <header className="app-header">
      <div className="tabbar">
        <HomeButton active={active === "projects"} onSelect={() => onSelect("projects")} />
        <nav
          className="tabs"
          role="tablist"
          aria-label="Sessions"
          // Leaving the tabs, not just one tab for the next, takes the drop marker with it.
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(undefined);
          }}
        >
          {order.map(tab)}
        </nav>
        <button type="button" className="tab-new" aria-label="New session" title="New session" onClick={onNewSession}>
          <Plus size={14} />
        </button>
      </div>
      <span className="build-sha" title="Build commit">{__COMMIT_SHA__}</span>
    </header>
  );
}

/** The way to the Projects pages: always first, never closes or moves. Icon only, so its name lives in aria-label and title. */
function HomeButton({ active, onSelect }: { active: boolean; onSelect(): void }) {
  return (
    <button type="button" className={`home-button${active ? " is-active" : ""}`} aria-current={active ? "page" : undefined} aria-label="Projects" title="Projects" onClick={onSelect}>
      <Logo size={16} />
    </button>
  );
}

/** What makes a tab draggable, and shows where a dragged one would land. */
interface DragProps {
  dragging: boolean;
  drop?: "before" | "after";
  onDragStart(e: DragEvent<HTMLDivElement>): void;
  onDragOver(e: DragEvent<HTMLDivElement>): void;
  onDrop(e: DragEvent<HTMLDivElement>): void;
  onDragEnd(): void;
}

interface TabProps extends DragProps {
  id: TabId;
  active: TabId;
  label: string;
  title?: string;
  dot?: string;
  pulse?: boolean;
  onSelect(tab: TabId): void;
  onClose(tab: TabId): void;
}

function Tab({ id, active, label, title, dot, pulse, onSelect, onClose, dragging, drop, ...dragHandlers }: TabProps) {
  const selected = id === active;
  return (
    <div
      className={`tab${selected ? " is-active" : ""}${dragging ? " is-dragging" : ""}${drop ? ` drop-${drop}` : ""}`}
      draggable
      {...dragHandlers}
    >
      <button type="button" role="tab" aria-selected={selected} className="tab-main" title={title ?? label} onClick={() => onSelect(id)}>
        {dot && <span className={`dot dot-small${pulse ? " dot-pulse" : ""}`} style={{ background: dot }} aria-hidden="true" />}
        <span className="tab-label">{label}</span>
      </button>
      <button type="button" className="tab-close" aria-label={`Close ${label}`} title="Close" onClick={() => onClose(id)}>
        <svg width="10" height="10" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
