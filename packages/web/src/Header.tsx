import { useRef, useState, type AnimationEvent, type DragEvent } from "react";
import type { SessionInfo } from "@kumiko/shared";
import { Corner } from "./Corner";
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
  /** Where the open session's usage goes. */
  cornerRef(el: HTMLDivElement | null): void;
}

/** Where a dragged tab would land if dropped now. */
interface DropAt {
  target: TabId;
  after: boolean;
}

/** The window's title bar: the Projects button, a tab per session, which drag to reorder, and + to start a new one;
 * in the corner, the open session's usage. */
export function Header({ sessions, newSessions, order, active, onSelect, onClose, onMove, onNewSession, cornerRef }: Props) {
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

  // What each tab showed last, so a closed one can still be drawn while it shrinks away.
  const seen = useRef(new Map<TabId, TabLook>());
  const look = (id: TabId): TabLook | undefined => {
    if (id.startsWith("session:")) {
      const s = sessions.find((x) => `session:${x.id}` === id);
      if (!s) return undefined;
      const st = sessionState(s);
      return {
        label: sessionTitle(s),
        title: `${sessionTitle(s)} · ${st.text}`,
        dot: st.color,
        pulse: s.status === "running" || s.status === "starting",
      };
    }
    const n = newSessions.find((x) => `new-session:${x.key}` === id);
    if (!n) return undefined;
    return { label: n.project ? `${n.project} · New session` : "New session" };
  };
  const looks = new Map<TabId, TabLook>();
  for (const id of order) {
    const l = look(id);
    if (l) looks.set(id, l);
  }
  const open = [...looks.keys()];

  // A tab that goes away, however it was closed, stays where it was until its closing animation is over.
  const [closing, setClosing] = useState<TabId[]>([]);
  const [shown, setShown] = useState<TabId[]>(open);
  const [prevOpen, setPrevOpen] = useState(open);
  if (open.join() !== prevOpen.join()) {
    setPrevOpen(open);
    const gone = shown.filter((id) => !looks.has(id) && (prevOpen.includes(id) || closing.includes(id)));
    const next = [...open];
    for (const id of gone) {
      // Behind the nearest tab that was before it and is still there, or first.
      const before = shown.slice(0, shown.indexOf(id)).reverse().find((x) => next.includes(x));
      next.splice(before ? next.indexOf(before) + 1 : 0, 0, id);
    }
    setShown(next);
    setClosing(gone);
  }
  for (const [id, l] of looks) seen.current.set(id, l);
  const closed = (id: TabId) => {
    seen.current.delete(id);
    setClosing((c) => c.filter((x) => x !== id));
    setShown((s) => s.filter((x) => x !== id));
  };

  const tab = (id: TabId) => {
    const l = looks.get(id) ?? (closing.includes(id) ? seen.current.get(id) : undefined);
    if (!l) return null;
    if (!looks.has(id)) return <Tab key={id} id={id} active={active} {...l} closing onClosed={closed} />;
    return <Tab key={id} id={id} active={active} onSelect={onSelect} onClose={onClose} {...l} {...drag(id)} />;
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
          {shown.map(tab)}
        </nav>
        <button type="button" className="tab-new" aria-label="New session" title="New session" onClick={onNewSession}>
          <Plus size={14} />
        </button>
      </div>
      {/* The open session puts its usage here; elsewhere there is only the build to show. */}
      <div className="header-corner" ref={cornerRef} />
      {!active.startsWith("session:") && <Corner label="Build" summary={<span className="corner-dots" aria-hidden="true">···</span>} />}
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

/** What a tab shows. */
interface TabLook {
  label: string;
  title?: string;
  dot?: string;
  pulse?: boolean;
}

type TabProps = TabLook & { id: TabId; active: TabId } & (
  | (DragProps & { closing?: false; onSelect(tab: TabId): void; onClose(tab: TabId): void })
  /** Already closed: shrinks away, then `onClosed`, and takes no clicks or drags meanwhile. */
  | { closing: true; onClosed(tab: TabId): void }
);

function Tab(props: TabProps) {
  const { id, active, label, title, dot, pulse } = props;
  const selected = id === active && !props.closing;
  const onSelect = props.closing ? () => {} : props.onSelect;
  const onClose = props.closing ? () => {} : props.onClose;
  const handlers = props.closing
    ? {
        "aria-hidden": true,
        inert: true,
        onAnimationEnd: (e: AnimationEvent<HTMLDivElement>) => e.target === e.currentTarget && props.onClosed(id),
      }
    : {
        draggable: true,
        onDragStart: props.onDragStart,
        onDragOver: props.onDragOver,
        onDrop: props.onDrop,
        onDragEnd: props.onDragEnd,
      };
  const dragging = !props.closing && props.dragging;
  const drop = props.closing ? undefined : props.drop;
  return (
    <div
      className={`tab${selected ? " is-active" : ""}${dragging ? " is-dragging" : ""}${drop ? ` drop-${drop}` : ""}${props.closing ? " is-closing" : ""}`}
      {...handlers}
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
