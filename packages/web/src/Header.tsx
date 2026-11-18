import { useRef, useState, type AnimationEvent, type CSSProperties, type DragEvent } from "react";
import { isBusy, type SessionInfo } from "@kumiko/shared";
import { Corner } from "./Corner";
import { Logo, Plus } from "./icons";
import { sandboxHues, sessionName, sessionTitle } from "./format";
import { cardsWaiting, sessionState } from "./status";

export type TabId = "sandboxes" | `new-session:${string}` | `session:${string}`;

/** A New session tab: `key` tells it apart from the others, `sandbox` is the one picked in it, if any. */
export interface NewSessionTab {
  key: string;
  sandbox?: string;
}

interface Props {
  sessions: SessionInfo[];
  newSessions: NewSessionTab[];
  /** The session and New session tabs, in the order to show them: each sandbox's together, then those with none. */
  order: TabId[];
  active: TabId;
  onSelect(tab: TabId): void;
  onClose(tab: TabId): void;
  /** `tab` was dragged to just before `target`, or just after it with `after`. */
  onMove(tab: TabId, target: TabId, after: boolean): void;
  /** Sandbox `moving`'s tabs were dragged to just before sandbox `target`'s, or just after them with `after`. */
  onMoveGroup(moving: string, target: string, after: boolean): void;
  /** The sandboxes whose tabs are hidden behind their label. */
  collapsed: ReadonlySet<string>;
  /** A sandbox's collapse/expand button was clicked. */
  onToggleGroup(name: string): void;
  /** A sandbox's label was clicked. */
  onOpenSandbox(name: string): void;
  onNewSession(): void;
  /** Where the open session's usage goes. */
  cornerRef(el: HTMLDivElement | null): void;
}

/** Where a dragged tab would land if dropped now. */
interface DropAt {
  target: TabId;
  after: boolean;
}

/** Where a dragged sandbox label would land if dropped now. */
interface GroupDropAt {
  target: string;
  after: boolean;
}

/**
 * The window's title bar: the Sandboxes button, a tab per session under its sandbox's label, which drag to reorder
 * within the sandbox, the labels dragging their tabs along and collapsing to hide them, and + to start a new one; in
 * the corner, the open session's usage.
 */
export function Header({ sessions, newSessions, order, active, onSelect, onClose, onMove, onMoveGroup, collapsed, onToggleGroup, onOpenSandbox, onNewSession, cornerRef }: Props) {
  const [dragging, setDragging] = useState<TabId | undefined>();
  const [dropAt, setDropAt] = useState<DropAt | undefined>();
  const [draggingGroup, setDraggingGroup] = useState<string | undefined>();
  const [groupDropAt, setGroupDropAt] = useState<GroupDropAt | undefined>();

  const drag = (id: TabId): DragProps => ({
    dragging: dragging === id,
    // A sandbox's label dragged after another sandbox shows where it lands at the end of that sandbox's last tab.
    drop:
      dropAt?.target === id && dragging !== id
        ? dropAt.after ? "after" : "before"
        : groupDropAt?.after && lastInGroup.get(groupDropAt.target) === id && draggingGroup !== groupDropAt.target
          ? "after"
          : undefined,
    onDragStart(e) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", id);
      setDragging(id);
    },
    onDragOver(e) {
      const group = looks.get(id)?.group;
      if (draggingGroup && group !== undefined) return overGroup(e, group);
      // A tab only moves among its sandbox's tabs.
      if (!dragging || looks.get(dragging)?.group !== group) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const box = e.currentTarget.getBoundingClientRect();
      const after = e.clientX > box.left + box.width / 2;
      if (dropAt?.target !== id || dropAt.after !== after) setDropAt({ target: id, after });
    },
    onDrop(e) {
      e.preventDefault();
      if (dragging && dropAt) onMove(dragging, dropAt.target, dropAt.after);
      if (draggingGroup && groupDropAt) onMoveGroup(draggingGroup, groupDropAt.target, groupDropAt.after);
      setDragging(undefined);
      setDropAt(undefined);
      setDraggingGroup(undefined);
      setGroupDropAt(undefined);
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
        label: sessionName(s),
        title: `${sessionTitle(s)} · ${st.text}`,
        group: s.sandbox,
        dot: st.color,
        pulse: isBusy(s),
        asleep: s.asleep,
        background: (s.agents ?? 0) + (s.shells ?? 0) || undefined,
        cards: s.cards,
      };
    }
    const n = newSessions.find((x) => `new-session:${x.key}` === id);
    if (!n) return undefined;
    return { label: "New session", title: n.sandbox ? `${n.sandbox} · New session` : undefined, group: n.sandbox };
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

  /** A dragged sandbox label is over sandbox `name`'s label or tabs: it lands before them, or after past their middle. */
  const overGroup = (e: DragEvent<HTMLElement>, name: string) => {
    if (!draggingGroup) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    // The group lays out no box of its own; its label and tabs span it.
    const parts = [...(e.currentTarget.closest(".tab-group")?.children ?? [e.currentTarget])];
    const left = parts[0].getBoundingClientRect().left;
    const right = parts[parts.length - 1].getBoundingClientRect().right;
    const after = e.clientX > (left + right) / 2;
    if (groupDropAt?.target !== name || groupDropAt.after !== after) setGroupDropAt({ target: name, after });
  };

  const dragGroup = (name: string): DragProps => ({
    dragging: draggingGroup === name,
    drop: groupDropAt?.target === name && !groupDropAt.after && draggingGroup !== name ? "before" : undefined,
    onDragStart(e) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", name);
      setDraggingGroup(name);
    },
    onDragOver(e) {
      overGroup(e, name);
    },
    onDrop(e) {
      e.preventDefault();
      if (draggingGroup && groupDropAt) onMoveGroup(draggingGroup, groupDropAt.target, groupDropAt.after);
      setDraggingGroup(undefined);
      setGroupDropAt(undefined);
    },
    onDragEnd() {
      setDraggingGroup(undefined);
      setGroupDropAt(undefined);
    },
  });

  // Runs of tabs to show: a sandbox's tabs under its label, and each tab with no sandbox on its own.
  const runs: { group?: string; tabs: TabId[] }[] = [];
  for (const id of shown) {
    const group = (looks.get(id) ?? seen.current.get(id))?.group;
    const last = runs[runs.length - 1];
    if (group !== undefined && last?.group === group) last.tabs.push(id);
    else runs.push({ group, tabs: [id] });
  }
  const lastInGroup = new Map(runs.flatMap((r) => (r.group === undefined ? [] : [[r.group, r.tabs[r.tabs.length - 1]] as const])));
  const hues = sandboxHues(runs.flatMap((r) => (r.group === undefined ? [] : [r.group])));
  const run = ({ group, tabs }: { group?: string; tabs: TabId[] }) => {
    if (group === undefined) return tabs.map(tab);
    // A group whose tabs have all closed fades with its last one.
    const closing = tabs.every((id) => !looks.has(id));
    const folded = collapsed.has(group);
    return (
      <div key={`group:${group}`} role="group" aria-label={group} className="tab-group" style={{ "--hue": hues.get(group) } as CSSProperties}>
        <GroupLabel
          name={group}
          closing={closing}
          collapsed={folded}
          count={tabs.filter((id) => looks.has(id)).length}
          onOpen={onOpenSandbox}
          onToggle={onToggleGroup}
          {...dragGroup(group)}
        />
        {!folded && tabs.map(tab)}
      </div>
    );
  };

  return (
    <header className="app-header">
      <div className="tabbar">
        <HomeButton active={active === "sandboxes"} onSelect={() => onSelect("sandboxes")} />
        <nav
          className="tabs"
          role="tablist"
          aria-label="Sessions"
          // Leaving the tabs, not just one tab for the next, takes the drop marker with it.
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            setDropAt(undefined);
            setGroupDropAt(undefined);
          }}
        >
          {runs.map(run)}
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

/** The way to the Sandboxes pages: always first, never closes or moves. Icon only, so its name lives in aria-label and title. */
function HomeButton({ active, onSelect }: { active: boolean; onSelect(): void }) {
  return (
    <button type="button" className={`home-button${active ? " is-active" : ""}`} aria-current={active ? "page" : undefined} aria-label="Sandboxes" title="Sandboxes" onClick={onSelect}>
      <Logo size={16} />
    </button>
  );
}

/** What makes a tab or a sandbox's label draggable, and shows where a dragged one would land. */
interface DragProps {
  dragging: boolean;
  drop?: "before" | "after";
  onDragStart(e: DragEvent<HTMLDivElement>): void;
  onDragOver(e: DragEvent<HTMLDivElement>): void;
  onDrop(e: DragEvent<HTMLDivElement>): void;
  onDragEnd(): void;
}

interface GroupLabelProps {
  name: string;
  closing: boolean;
  /** Its tabs are hidden. */
  collapsed: boolean;
  /** How many tabs it has. */
  count: number;
  onOpen(name: string): void;
  onToggle(name: string): void;
}

/**
 * A sandbox's label, in front of its tabs: opens the sandbox, drags its tabs along, and on its right collapses them out
 * of sight or brings them back. A label dragged before it shows here.
 */
function GroupLabel({ name, closing, collapsed, count, onOpen, onToggle, dragging, drop, ...drag }: DragProps & GroupLabelProps) {
  const tabs = `${count} tab${count === 1 ? "" : "s"}`;
  return (
    <div
      className={`tab-group-label${collapsed ? " is-collapsed" : ""}${dragging ? " is-dragging" : ""}${drop ? ` drop-${drop}` : ""}${closing ? " is-closing" : ""}`}
      draggable={!closing}
      {...(closing ? { "aria-hidden": true, inert: true } : drag)}
    >
      <button type="button" className="tab-group-open" title={`${name}: open the sandbox`} onClick={() => onOpen(name)}>
        <span className="tab-group-name">{name}</span>
      </button>
      <button
        type="button"
        className="tab-group-toggle"
        aria-expanded={!collapsed}
        aria-label={collapsed ? `Show ${name}'s ${tabs}` : `Hide ${name}'s ${tabs}`}
        title={collapsed ? `Show ${tabs}` : `Hide ${tabs}`}
        onClick={() => onToggle(name)}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d={collapsed ? "M2 3.5l3 3 3-3" : "M3.5 2l3 3-3 3"} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}

/** What a tab shows. */
interface TabLook {
  label: string;
  title?: string;
  /** The sandbox whose label it goes under, if any. */
  group?: string;
  dot?: string;
  pulse?: boolean;
  /** Its session waits for its sandbox to start: the tab is greyed. */
  asleep?: boolean;
  /** How many subagents, shells and monitors Claude has running in the background. */
  background?: number;
  /** How many cards in its chat wait for the user's decision. */
  cards?: number;
}

type TabProps = TabLook & { id: TabId; active: TabId } & (
  | (DragProps & { closing?: false; onSelect(tab: TabId): void; onClose(tab: TabId): void })
  /** Already closed: shrinks away, then `onClosed`, and takes no clicks or drags meanwhile. */
  | { closing: true; onClosed(tab: TabId): void }
);

function Tab(props: TabProps) {
  const { id, active, label, title, dot, pulse, asleep, background, cards } = props;
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
      className={`tab${selected ? " is-active" : ""}${asleep ? " is-asleep" : ""}${dragging ? " is-dragging" : ""}${drop ? ` drop-${drop}` : ""}${props.closing ? " is-closing" : ""}`}
      {...handlers}
    >
      <button type="button" role="tab" aria-selected={selected} className="tab-main" title={title ?? label} onClick={() => onSelect(id)}>
        {dot && <span className={`dot dot-small${pulse ? " dot-pulse" : ""}`} style={{ background: dot }} aria-hidden="true" />}
        <span className="tab-label">{label}</span>
        {cards ? (
          <span className="tab-cards" aria-label={cardsWaiting(cards)} title={cardsWaiting(cards)}>
            {cards}
          </span>
        ) : null}
        {background ? (
          <span className="tab-background" aria-label={`${background} running in the background`}>
            {background}
          </span>
        ) : null}
      </button>
      <button type="button" className="tab-close" aria-label={`Close ${label}`} title="Close" onClick={() => onClose(id)}>
        <svg width="10" height="10" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
