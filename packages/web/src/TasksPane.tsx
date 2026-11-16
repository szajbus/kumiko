import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { formatBytes, TASK_FILE_BYTES, type SessionEvent } from "@kumiko/shared";
import { api, errorMessage } from "./api";
import { formatDuration } from "./format";
import { PaneGrip } from "./PaneGrip";
import { COLORS } from "./status";
import { applyTaskEvent, emptyTasks, endText, listed, quietEventsText, runningTasks, timeLimit, type MonitorRow, type Task, type TasksState } from "./tasks";
import { WindowContext } from "./windowContext";

// The Tasks pane, and the parts of the chat that show Claude's background tasks. See tasks.ts for the state.

/** Folds a session's events into its tasks incrementally, as `useChat` does the chat. */
export function useTasks(events: readonly SessionEvent[]): TasksState {
  const ref = useRef<{ state: TasksState; count: number; last?: unknown }>({ state: emptyTasks(), count: 0 });
  return useMemo(() => {
    const same = ref.current.count === 0 || events[ref.current.count - 1] === ref.current.last;
    let { state, count } = same ? ref.current : { state: emptyTasks(), count: 0 };
    for (; count < events.length; count++) state = applyTaskEvent(state, events[count]);
    ref.current = { state, count, last: events[count - 1] };
    return state;
  }, [events]);
}

// Which task the pane shows, per session: the chat picks one with Show, the pane with a click.
const chosen = new Map<string, string>();
const choosers = new Set<() => void>();
const choose = (session: string, task: string) => {
  chosen.set(session, task);
  for (const l of choosers) l();
};
const useChosen = (session: string) =>
  useSyncExternalStore(
    (l) => (choosers.add(l), () => choosers.delete(l)),
    () => chosen.get(session),
  );

/** Opens the Tasks pane on task `task`. */
export function showTask(session: string, task: string) {
  choose(session, task);
  void api.toggleTasks(session, true).catch((err) => console.error(err));
}

// Asking the chat to bring a subagent's Agent call into view, from the pane.
const revealers = new Map<string, (toolUseId: string) => void>();
/** The chat of `session` listens for subagents to reveal; returns the function that stops it. */
export function onReveal(session: string, fn: (toolUseId: string) => void): () => void {
  revealers.set(session, fn);
  return () => {
    if (revealers.get(session) === fn) revealers.delete(session);
  };
}

/** The time now, once a second while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const ago = (now: number, t?: number) => (t === undefined ? "" : now - t < 60_000 ? "just now" : `${formatDuration(now - t).split(" ")[0]} ago`);

/** How long a task has run, or ran. */
function ran(t: Task, now: number): string | undefined {
  if (t.startedAt === undefined) return undefined;
  return formatDuration(Math.max(0, (t.status === "running" ? now : (t.endedAt ?? now)) - t.startedAt));
}

const KIND_LABEL = { shell: "Shell", monitor: "Monitor", agent: "Subagent" } as const;

/** A task's mark: its kind while it runs, how it ended after. */
export function TaskIcon({ task }: { task: Task }) {
  if (task.status === "running") {
    if (task.kind === "agent") return <span className="task-icon is-agent" aria-label="Subagent">◆</span>;
    if (task.kind === "monitor") return <span className="task-icon is-monitor" aria-label="Monitor">◉</span>;
    return <span className="task-icon is-shell" aria-label="Shell">▶</span>;
  }
  // A subagent keeps its mark; how it ended is said beside it.
  if (task.kind === "agent") return <span className="task-icon is-agent" aria-label="Subagent">◆</span>;
  if (task.status === "completed") return <span className="task-icon is-ok" aria-label="Finished">✓</span>;
  if (task.status === "failed") return <span className="task-icon is-failed" aria-label="Failed">✕</span>;
  if (task.status === "stopped" && !task.stoppedByUser && /time limit/.test(endText(task))) return <span className="task-icon is-stopped" aria-label="Stopped">⏱</span>;
  return <span className="task-icon is-stopped" aria-label="Stopped">■</span>;
}

// Ended tasks the user cleared from the list, per session; kept in the browser.
const clearedKey = (session: string) => `kumiko.tasks.cleared.${session}`;
const loadCleared = (session: string): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(clearedKey(session)) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
};

/** The Tasks pane: Claude's background tasks, running then ended, and the one chosen, with its output. */
export function TasksPane({ session, events, pane, live }: { session: string; events: readonly SessionEvent[]; pane: string; live: boolean }) {
  const ctx = useContext(WindowContext);
  const tasks = useTasks(events);
  const [cleared, setCleared] = useState(() => loadCleared(session));
  const { running, ended: allEnded } = listed(tasks);
  const ended = allEnded.filter((t) => !cleared.has(t.id));
  const pick = useChosen(session);
  const current = (pick && tasks.byId[pick]) || running[0] || ended[0];
  const now = useNow(running.length > 0);
  const clear = () => {
    const next = new Set([...cleared, ...allEnded.map((t) => t.id)]);
    localStorage.setItem(clearedKey(session), JSON.stringify([...next]));
    setCleared(next);
  };

  return (
    <div className="tasks">
      <div className="tasks-head">
        <PaneGrip pane={pane} />
        <span className="tasks-title">Tasks</span>
        <span className="tasks-count">
          {running.length} running · {ended.length} ended
        </span>
        <span className="tasks-spacer" />
        {ended.length > 0 && (
          <button type="button" className="tasks-clear" onClick={clear} title="Take the ended tasks off the list">
            Clear ended
          </button>
        )}
        {ctx?.live && (
          <button type="button" className="artifact-close" aria-label="Close Tasks" title={`Close (${MOD}+Shift+B)`} onClick={() => ctx.close(pane)}>
            <svg width="10" height="10" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
      {!running.length && !ended.length ? (
        <p className="tasks-empty">Nothing in the background. Commands Claude runs in the background, its Monitor watches and its background subagents show here.</p>
      ) : (
        <>
          <ul className="tasks-list" aria-label="Background tasks">
            {running.length > 0 && <li className="tasks-group">Running</li>}
            {running.map((t) => (
              <TaskRow key={t.id} task={t} now={now} selected={t === current} child={Boolean(t.parent && tasks.byId[t.parent]?.status === "running")} onSelect={() => choose(session, t.id)} />
            ))}
            {ended.length > 0 && <li className="tasks-group">Ended</li>}
            {ended.map((t) => (
              <TaskRow key={t.id} task={t} now={now} selected={t === current} onSelect={() => choose(session, t.id)} />
            ))}
          </ul>
          {current && <TaskDetail key={current.id} session={session} task={current} live={live} active={ctx?.active ?? true} now={now} />}
        </>
      )}
    </div>
  );
}

function TaskRow({ task, now, selected, child, onSelect }: { task: Task; now: number; selected: boolean; child?: boolean; onSelect(): void }) {
  const limit = timeLimit(task);
  const meta = task.status === "running" ? (task.kind === "monitor" && limit ? `ends in ${formatDuration(Math.max(0, limit - now)).split(" ")[0]}` : ran(task, now)) : `${endText(task)}${task.endedAt ? ` · ${ago(now, task.endedAt)}` : ""}`;
  return (
    <li>
      <button type="button" className={`task-row${selected ? " is-selected" : ""}${child ? " is-child" : ""}`} aria-current={selected || undefined} onClick={onSelect}>
        <TaskIcon task={task} />
        <span className={`task-name${task.kind !== "agent" && !task.description ? " mono" : ""}`}>{task.description || task.command || KIND_LABEL[task.kind]}</span>
        {meta && <span className="task-meta">{meta}</span>}
      </button>
    </li>
  );
}

/** How often a running task's output is read while it is shown; slower while it prints nothing. */
const POLL_MS = 1000;
const IDLE_POLL_MS = 3000;

/**
 * What a shell or monitor printed: read from Claude every second while it runs and is on screen, or kept from when it
 * ended. Claude keeps only the end of it.
 */
function useOutput(session: string, task: Task, live: boolean, active: boolean) {
  const [read, setRead] = useState<{ output: string; totalBytes: number; truncated: boolean }>();
  const [error, setError] = useState<string>();
  const running = task.status === "running";
  const shell = task.kind !== "agent";
  useEffect(() => {
    if (!shell || !live || !active || (!running && task.output)) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    let quiet = 0;
    let last = -1;
    const poll = async () => {
      try {
        const o = await api.taskOutput(session, task.id);
        if (stop) return;
        setRead(o);
        setError(undefined);
        quiet = o.totalBytes === last ? quiet + 1 : 0;
        last = o.totalBytes;
      } catch (err) {
        if (!stop) setError(errorMessage(err));
      }
      if (stop || !running) return;
      timer = setTimeout(poll, document.visibilityState === "visible" && quiet < 5 ? POLL_MS : IDLE_POLL_MS);
    };
    void poll();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [session, task.id, shell, running, live, active, task.output]);
  return { shown: running ? read : (task.output ?? read), error };
}

function TaskDetail({ session, task, live, active, now }: { session: string; task: Task; live: boolean; active: boolean; now: number }) {
  const { shown: tail, error } = useOutput(session, task, live, active);
  // All of it, read from Claude's file when asked for; or why it couldn't be.
  const [all, setAll] = useState<{ output: string; totalBytes: number; truncated: boolean } | "reading" | { failed: string }>();
  const full = typeof all === "object" && "output" in all ? all : undefined;
  const shown = full ?? tail;
  const showAll = async () => {
    setAll("reading");
    try {
      const read = await api.taskFile(session, task.id);
      // From its start, which is where to begin reading it.
      follow.current = false;
      setAll(read);
      requestAnimationFrame(() => out.current?.scrollTo({ top: 0 }));
    } catch (err) {
      setAll({ failed: errorMessage(err) });
    }
  };
  const [stopping, setStopping] = useState(false);
  const [failed, setFailed] = useState<string>();
  const out = useRef<HTMLPreElement>(null);
  // Follows the end while it is at the end; scrolled up, it stays.
  const follow = useRef(true);
  useLayoutEffect(() => {
    const el = out.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [shown?.output]);
  const limit = timeLimit(task);
  const running = task.status === "running";
  const stop = async () => {
    setStopping(true);
    setFailed(undefined);
    try {
      await api.stopTask(session, task.id);
    } catch (err) {
      setFailed(errorMessage(err));
      setStopping(false);
    }
  };

  return (
    <div className="task-detail">
      <div className="task-detail-head">
        <TaskIcon task={task} />
        <span className="task-detail-title">{task.description || KIND_LABEL[task.kind]}</span>
        <span className={`task-pill is-${task.status === "running" ? "running" : task.status === "completed" ? "ok" : task.status === "failed" ? "failed" : "stopped"}`}>
          {running ? `Running${ran(task, now) ? ` · ${ran(task, now)}` : ""}` : endText(task).replace(/^./, (c) => c.toUpperCase())}
        </span>
        {running && live && (
          <button type="button" className="btn btn-secondary btn-compact task-stop" disabled={stopping} onClick={() => void stop()}>
            {stopping ? "Stopping…" : "Stop"}
          </button>
        )}
      </div>
      {failed && <div className="banner banner-error">{failed}</div>}
      {task.command && <pre className="task-command mono">{task.command}</pre>}
      <dl className="task-facts">
        {task.kind === "agent" && task.activity && (
          <>
            <dt>Doing</dt>
            <dd>{task.activity}</dd>
          </>
        )}
        {task.startedAt !== undefined && (
          <>
            <dt>{running ? "Started" : "Ran"}</dt>
            <dd>{running ? clock(task.startedAt) : `${clock(task.startedAt)} → ${task.endedAt ? clock(task.endedAt) : "?"}${ran(task, now) ? ` (${ran(task, now)})` : ""}`}</dd>
          </>
        )}
        {running && limit !== undefined && (
          <>
            <dt>Time limit</dt>
            <dd>Claude stops it at {clock(limit)}</dd>
          </>
        )}
      </dl>
      {task.kind === "agent" ? (
        task.toolUseId && (
          <button type="button" className="btn btn-secondary btn-compact task-reveal" onClick={() => revealers.get(session)?.(task.toolUseId!)}>
            Show in chat
          </button>
        )
      ) : (
        <>
          <pre
            ref={out}
            className="task-output mono"
            tabIndex={0}
            aria-label="Output"
            onScroll={(e) => {
              const el = e.currentTarget;
              follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
          >
            {!full && shown?.truncated && <span className="task-output-cut">… only the end of {formatBytesShort(shown.totalBytes)} is kept{"\n"}</span>}
            {shown ? shown.output || <span className="task-output-cut">Nothing printed yet.</span> : <span className="task-output-cut">{live ? "Reading…" : "Its output wasn't kept."}</span>}
            {full?.truncated && <span className="task-output-cut">{"\n"}… cut at {formatBytes(TASK_FILE_BYTES)} of {formatBytesShort(full.totalBytes)}</span>}
          </pre>
          <div className="task-output-foot">
            {error ? (
              <span className="task-output-error">Couldn't read it: {error}</span>
            ) : typeof all === "object" && "failed" in all ? (
              <span className="task-output-error">{all.failed}</span>
            ) : !running && !full && tail?.truncated ? (
              <button type="button" className="tasks-clear" disabled={all === "reading"} onClick={() => void showAll()}>
                {all === "reading" ? "Reading…" : "Show all"}
              </button>
            ) : (
              <span />
            )}
            {shown && <span>{formatBytesShort(shown.totalBytes)}</span>}
          </div>
        </>
      )}
    </div>
  );
}

const formatBytesShort = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Beside a Bash or Monitor call that runs in the background: that it does, how long for, and Show. */
export function TaskToolMeta({ session, task }: { session: string; task: Task }) {
  const now = useNow(task.status === "running");
  const limit = timeLimit(task);
  const what = task.status === "running" ? (task.kind === "monitor" ? (limit ? `ends in ${formatDuration(Math.max(0, limit - now)).split(" ")[0]}` : undefined) : ran(task, now)) : endText(task);
  return (
    <span className="agent-meta">
      <span className="agent-badge">{task.kind === "monitor" ? "watching" : "background"}</span>
      {what && <span>{what}</span>}
      <button
        type="button"
        className="tool-show"
        onClick={(e) => {
          // Not the summary's own click, which would open the details.
          e.preventDefault();
          showTask(session, task.id);
        }}
      >
        Show
      </button>
    </span>
  );
}

/** Beside a Bash call Claude is waiting on: a way to move it to the background, as Ctrl+B does. */
export function MoveToBackground({ session, toolUseId }: { session: string; toolUseId: string }) {
  const [moving, setMoving] = useState(false);
  return (
    <button
      type="button"
      className="tool-show"
      disabled={moving}
      title="Let Claude go on while it runs (Ctrl+B)"
      onClick={(e) => {
        e.preventDefault();
        setMoving(true);
        void api.backgroundTasks(session, toolUseId).catch(() => setMoving(false));
      }}
    >
      {moving ? "Moving…" : "Move to background"}
    </button>
  );
}

/**
 * One line a background task leaves in the chat, as all of them look: a fold arrow where it folds, the mark, the task's
 * name, what happened, and one button on the right.
 */
function BackgroundLine({ fold, mark, name, what, action }: { fold?: { open: boolean; toggle(): void }; mark?: ReactNode; name?: string; what: ReactNode; action?: ReactNode }) {
  const body = (
    <>
      <span className="bg-line-fold" aria-hidden="true">{fold && <span className={`tri${fold.open ? "" : " is-right"}`} />}</span>
      <span className="bg-line-mark">{mark}</span>
      {name && <span className="bg-line-name">{name}</span>}
      <span className="bg-line-what">{what}</span>
    </>
  );
  return (
    <div className="bg-line">
      {fold ? (
        <button type="button" className="bg-line-toggle" aria-expanded={fold.open} onClick={fold.toggle}>
          {body}
        </button>
      ) : (
        body
      )}
      {action}
    </div>
  );
}

const nameOf = (task: Task) => task.description || task.command || KIND_LABEL[task.kind];

/** A line for a task that ended: what it was, and how it ended, with a way to its output, or to a subagent's work. */
export function TaskEndLine({ session, task }: { session: string; task: Task }) {
  const how = task.kind === "shell" && (task.status === "failed" || task.status === "completed") ? `${task.status === "failed" ? "failed" : "finished"} · ${endText(task)}` : endText(task);
  const action =
    task.kind === "agent" ? (
      task.toolUseId && (
        <button type="button" className="tool-show" onClick={() => revealers.get(session)?.(task.toolUseId!)}>
          Show
        </button>
      )
    ) : (
      <button type="button" className="tool-show" onClick={() => showTask(session, task.id)}>
        Output
      </button>
    );
  return <BackgroundLine mark={<TaskIcon task={task} />} name={nameOf(task)} what={how} action={action} />;
}

/** Where Claude starts a turn of its own for a reason it can't name: a plain line, in the same look. */
export function PlainLine({ text }: { text: string }) {
  return <BackgroundLine what={text} />;
}

const monitorMark = (
  <span className="task-icon is-monitor" aria-label="Monitor">
    ◉
  </span>
);

const showMonitor = (session: string, task?: Task) =>
  task && (
    <button type="button" className="tool-show" onClick={() => showTask(session, task.id)}>
      Show
    </button>
  );

/** A monitor's line that woke Claude for the turn this starts. */
export function MonitorLine({ session, task, line }: { session: string; task?: Task; line: string }) {
  return <BackgroundLine mark={monitorMark} name={task?.description || "A monitor"} what={line ? <code>{line}</code> : "printed a line"} action={showMonitor(session, task)} />;
}

/** How many of a monitor's quiet turns show before "more". */
const SHOWN_EVENTS = 5;

/** A monitor's quiet turns, folded into one line: opened, its lines, each with what Claude said to it. */
export function MonitorEvents({ session, row, task }: { session: string; row: MonitorRow; task?: Task }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const n = row.events.length;
  const shown = all ? row.events : row.events.slice(-SHOWN_EVENTS);
  const what = quietEventsText(row);
  return (
    <div className="monitor-events">
      <BackgroundLine fold={{ open, toggle: () => setOpen(!open) }} mark={monitorMark} name={task?.description || "A monitor"} what={what} action={showMonitor(session, task)} />
      {open && (
        <ul className="monitor-event-list">
          {n > shown.length && (
            <li>
              <button type="button" className="tasks-clear" onClick={() => setAll(true)}>
                {n - shown.length} more…
              </button>
            </li>
          )}
          {shown.map((e) => (
            <li key={e.key} className="monitor-event">
              <code>{e.line}</code>
              <span className="monitor-event-reply">→ {e.reply}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** How long the composer's Tasks chip stays after the last task ended. */
const CHIP_LINGERS_MS = 5 * 60_000;

/** The composer's Tasks chip: how many run in the background, opening the pane; with ⌘⇧B, and Ctrl+B to move a command. */
export function TasksButton({ session, tasks, live, active }: { session: string; tasks: TasksState; live: boolean; active: boolean }) {
  const ctx = useContext(WindowContext);
  const running = runningTasks(tasks).length;
  const lastEnd = Math.max(0, ...tasks.order.map((id) => tasks.byId[id]).filter((t) => t.background).map((t) => t.endedAt ?? 0));
  const now = useNow(running === 0 && lastEnd > 0);
  const open = Boolean(ctx && Object.values(ctx.window.panes).includes("tasks"));
  const shown = live && (running > 0 || open || (lastEnd > 0 && now - lastEnd < CHIP_LINGERS_MS));
  const latest = useRef({ tasks, session });
  latest.current = { tasks, session };
  useEffect(() => {
    if (!live || !active) return;
    const onKey = (e: KeyboardEvent) => {
      // ⌘⇧B (Ctrl+Shift+B elsewhere): the pane. Ctrl+B: the commands Claude waits on, to the background, as in Claude.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.code === "KeyB") {
        e.preventDefault();
        void api.toggleTasks(latest.current.session).catch((err) => console.error(err));
      } else if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.code === "KeyB") {
        const { tasks: t } = latest.current;
        if (!t.order.some((id) => t.byId[id].kind === "shell" && !t.byId[id].background && t.byId[id].status === "running" && !t.byId[id].parent)) return;
        e.preventDefault();
        void api.backgroundTasks(latest.current.session).catch((err) => console.error(err));
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [live, active]);
  if (!shown) return null;
  return (
    <button
      type="button"
      className={`select-trigger select-compact tasks-button${running ? " is-running" : ""}${open ? " is-open" : ""}`}
      title={`Show or hide background tasks (${MOD}+Shift+B)`}
      onClick={() => void api.toggleTasks(session).catch((err) => console.error(err))}
    >
      <span className="tasks-button-mark" aria-hidden="true" style={{ borderColor: running ? COLORS.running : COLORS.stopped }} />
      {running ? (running === 1 ? "1 task" : `${running} tasks`) : "Tasks"}
    </button>
  );
}

const MOD = typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "Cmd" : "Ctrl";
