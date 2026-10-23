import type { SessionEvent } from "@kumiko/shared";
import type { ChatItem, ChatRow, ItemRow } from "./chat";

// Claude's background tasks, folded from a session's events: shells started with run_in_background or moved to the
// background, Monitor watches, and subagents. Claude reports them all as tasks (task_started, task_updated,
// task_notification); a monitor is a shell to Claude, told apart by the tool that started it.

export type TaskKind = "shell" | "monitor" | "agent";
/** `lost`: Claude went away without saying it ended. */
export type TaskStatus = "running" | "completed" | "failed" | "stopped" | "lost";

export interface Task {
  /** Claude's task id. */
  id: string;
  /** The tool call that started it. */
  toolUseId?: string;
  kind: TaskKind;
  description: string;
  /** The command it runs, for a shell or a monitor. */
  command?: string;
  /** How long it may run in the background before Claude stops it, in ms, as its tool call asked; see `timeLimit`. */
  timeoutMs?: number;
  /** In the background: started there, or moved there since. A foreground one is a command Claude waits on. */
  background: boolean;
  status: TaskStatus;
  /** The subagent task that started it, if one did. */
  parent?: string;
  startedAt?: number;
  endedAt?: number;
  /** Claude's summary of how it ended. */
  summary?: string;
  /** The user stopped it. */
  stoppedByUser?: boolean;
  /** What a subagent is doing now: "Reading b.txt". */
  activity?: string;
  /** What it printed, as kept once it ended. */
  output?: { output: string; totalBytes: number; truncated: boolean };
}

export interface TasksState {
  byId: Record<string, Task>;
  /** Task ids in the order they started. */
  order: string[];
  /** The calls that start tasks, by tool_use id: what the task's own events don't say. */
  calls: Record<string, { name: string; input: Record<string, unknown> }>;
  /** Task id by the tool_use id that started it. */
  byTool: Record<string, string>;
}

export const emptyTasks = (): TasksState => ({ byId: {}, order: [], calls: {}, byTool: {} });

/** Claude's own limit on a background shell, when its call doesn't set one; a monitor's is its timeout_ms. */
export const DEFAULT_TIMEOUT_MS = 30 * 60_000;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const time = (v: unknown): number | undefined => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? undefined : t;
};

/** The tools whose calls start tasks, and what of their input the task list shows. */
const TASK_TOOLS = new Set(["Bash", "Monitor", "Agent", "Task"]);

/** Applies one session event; returns `s` when nothing changed. */
export function applyTaskEvent(s: TasksState, ev: SessionEvent): TasksState {
  switch (ev.kind) {
    case "claude":
      return applyClaude(s, ev.payload);
    case "task_output":
      return update(s, ev.payload.taskId, () => ({ output: { output: ev.payload.output, totalBytes: ev.payload.totalBytes, truncated: ev.payload.truncated } }));
    case "task_stop":
      return update(s, ev.payload.taskId, () => ({ stoppedByUser: true }));
    case "tasks_lost":
      return ev.payload.taskIds.reduce((t, id) => update(t, id, (x) => (x.status === "running" ? { status: "lost" } : {})), s);
    case "ended":
      // Claude is gone, and what it hadn't said was over went with it; one that sleeps with its sandbox too.
      return s.order.reduce((t, id) => update(t, id, (x) => (x.status === "running" ? { status: "lost" } : {})), s);
    default:
      return s;
  }
}

function applyClaude(s: TasksState, m: Json): TasksState {
  if (m.type === "assistant") {
    const content = obj(m.message).content;
    let calls = s.calls;
    for (const b of Array.isArray(content) ? content.map(obj) : []) {
      if (b.type !== "tool_use" || !TASK_TOOLS.has(str(b.name) ?? "") || !str(b.id)) continue;
      calls = { ...calls, [str(b.id)!]: { name: str(b.name)!, input: obj(b.input) } };
    }
    return calls === s.calls ? s : { ...s, calls };
  }
  if (m.type !== "system") return s;
  const id = str(m.task_id);
  if (!id) return s;
  switch (m.subtype) {
    case "task_started": {
      // Workflows, MCP tasks and the like aren't listed.
      if (m.task_type !== "local_bash" && m.task_type !== "local_agent") return s;
      const toolUseId = str(m.tool_use_id);
      const call = toolUseId ? s.calls[toolUseId] : undefined;
      const kind: TaskKind = m.task_type === "local_agent" ? "agent" : call?.name === "Monitor" ? "monitor" : "shell";
      // A Bash call's timeout limits it in the background only when it asked for the background; one moved there later
      // gets Claude's default.
      const timeout = kind === "monitor" ? num(call?.input.timeout_ms) : call?.input.run_in_background === true ? num(call.input.timeout) : undefined;
      const task: Task = {
        id,
        ...(toolUseId ? { toolUseId } : {}),
        kind,
        description: str(m.description) ?? "",
        ...(kind !== "agent" && str(call?.input.command) ? { command: str(call?.input.command) } : {}),
        ...(timeout ? { timeoutMs: timeout } : {}),
        background: m.is_backgrounded === true || kind === "monitor",
        status: "running",
        ...(str(m.parent_task_id) ? { parent: str(m.parent_task_id) } : {}),
        ...(time(m.received_at) ? { startedAt: time(m.received_at) } : {}),
      };
      const fresh = !s.byId[id];
      return { ...s, byId: { ...s.byId, [id]: task }, order: fresh ? [...s.order, id] : s.order, byTool: toolUseId ? { ...s.byTool, [toolUseId]: id } : s.byTool };
    }
    case "task_updated": {
      const patch = obj(m.patch);
      return update(s, id, () => ({
        ...(patch.is_backgrounded === true ? { background: true } : {}),
        ...(num(patch.end_time) ? { endedAt: num(patch.end_time) } : {}),
      }));
    }
    case "task_progress":
      return update(s, id, (t) => (t.status === "running" && str(m.description) ? { activity: str(m.description) } : {}));
    case "task_notification": {
      const status: TaskStatus = m.status === "completed" ? "completed" : m.status === "failed" ? "failed" : "stopped";
      return update(s, id, (t) => ({ status, summary: str(m.summary), endedAt: t.endedAt ?? time(m.received_at), activity: undefined }));
    }
    default:
      return s;
  }
}

function update(s: TasksState, id: string, fn: (t: Task) => Partial<Task>): TasksState {
  const t = s.byId[id];
  if (!t) return s;
  const patch = fn(t);
  if (Object.keys(patch).length === 0) return s;
  return { ...s, byId: { ...s.byId, [id]: { ...t, ...patch } } };
}

/** Tasks in the background, for the list: running ones first, each in the order it started, ended ones newest first. */
export function listed(s: TasksState): { running: Task[]; ended: Task[] } {
  const all = s.order.map((id) => s.byId[id]).filter((t) => t.background);
  const ended = all.filter((t) => t.status !== "running").sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  return { running: nest(all.filter((t) => t.status === "running")), ended };
}

/** Puts tasks a subagent started right after it, so they show under it. */
function nest(tasks: Task[]): Task[] {
  const ids = new Set(tasks.map((t) => t.id));
  const out: Task[] = [];
  const add = (t: Task) => {
    out.push(t);
    for (const child of tasks) if (child.parent === t.id) add(child);
  };
  for (const t of tasks) if (!t.parent || !ids.has(t.parent)) add(t);
  return out;
}

/** The background tasks running now. */
export const runningTasks = (s: TasksState): Task[] => s.order.map((id) => s.byId[id]).filter((t) => t.background && t.status === "running");

/** A foreground command Claude waits on, which can be moved to the background: by the tool call that started it. */
export const foregroundTask = (s: TasksState, toolUseId: string): Task | undefined => {
  const t = s.byId[s.byTool[toolUseId] ?? ""];
  return t && t.kind === "shell" && !t.background && t.status === "running" && !t.parent ? t : undefined;
};

/** The exit code Claude's summary gives, if it gives one. */
export const exitCode = (t: Task): number | undefined => {
  const m = /exit code (\d+)/.exec(t.summary ?? "");
  return m ? Number(m[1]) : undefined;
};

/** Claude stopped it at its time limit. */
export const timedOut = (t: Task): boolean => /background time limit/.test(t.summary ?? "");

/** How a task ended, in a few words: "exit 0", "exit 2", "stopped by you", "stopped at its time limit". */
export function endText(t: Task): string {
  if (t.status === "running") return "running";
  if (t.status === "lost") return "ended with the agent";
  if (t.stoppedByUser) return "stopped by you";
  if (timedOut(t)) return "stopped at its time limit";
  if (t.status === "stopped") return t.parent ? "stopped with its subagent" : "stopped";
  if (t.kind === "monitor") return t.status === "failed" ? "failed" : "ended";
  if (t.kind === "agent") return t.status === "failed" ? "failed" : "finished";
  const code = exitCode(t);
  return code !== undefined ? `exit ${code}` : t.status === "failed" ? "failed" : "finished";
}

/** When Claude will stop it, if it is a shell or monitor whose start is known. */
export function timeLimit(t: Task): number | undefined {
  if (t.kind === "agent" || t.startedAt === undefined) return undefined;
  return t.startedAt + (t.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

/** Whether Claude takes a turn of its own to report on a task's end: not for one stopped by the user, or with its subagent. */
export function reportsEnd(t: Task): boolean {
  return t.background && !t.parent && (t.status === "completed" || t.status === "failed" || timedOut(t));
}

// ---------------------------------------------------------------------------------------------------------------
// Monitor turns, folded: each line a monitor prints wakes Claude for a turn of its own, mostly to say nothing needs
// doing. A done turn like that, with nothing but a short reply, folds into a row of the monitor's events.

/** One quiet turn a monitor woke Claude for: the line, and Claude's reply. */
export interface MonitorEventRow {
  key: string;
  line: string;
  reply: string;
}

/** Consecutive quiet turns of one monitor, as one row. */
export interface MonitorRow {
  type: "monitor";
  key: string;
  taskId: string;
  events: MonitorEventRow[];
}

/** A reply this long, or with a heading, says something: the turn shows in full. */
const QUIET_CHARS = 300;

type Unprompted = Extract<ChatItem, { type: "unprompted" }>;

/**
 * Folds the done turns a monitor woke Claude for, that are no more than a short reply, into rows of that monitor's
 * events; consecutive ones, of one monitor, into one row. Everything else stays as `chatRows` laid it out.
 */
export function foldMonitorTurns(rows: readonly ChatRow[]): (ChatRow | MonitorRow)[] {
  const out: (ChatRow | MonitorRow)[] = [];
  let i = 0;
  while (i < rows.length) {
    const quiet = quietTurn(rows, i);
    if (!quiet) {
      out.push(rows[i++]);
      continue;
    }
    const last = out.at(-1);
    const event = { key: quiet.start.key, line: quiet.start.monitor!.line, reply: quiet.reply };
    if (last?.type === "monitor" && last.taskId === quiet.start.monitor!.taskId) last.events.push(event);
    else out.push({ type: "monitor", key: `monitor-${quiet.start.key}`, taskId: quiet.start.monitor!.taskId, events: [event] });
    i = quiet.end;
  }
  return out;
}

/** The quiet monitor turn starting at row `i`, if one does: its start, its reply, and the row after its end. */
function quietTurn(rows: readonly ChatRow[], i: number): { start: Unprompted; reply: string; end: number } | undefined {
  const first = rows[i];
  if (first.type !== "item" || first.item.type !== "unprompted") return undefined;
  const start = first.item;
  if (!start.monitor || start.after.length || start.ended?.length) return undefined;
  let reply = "";
  for (let k = i + 1; k < rows.length; k++) {
    const r = rows[k];
    // Thinking folds into the work before the reply; a tool call is something done, and the turn shows.
    const parts = r.type === "work" ? r.rows : [r as ItemRow];
    for (const part of parts) {
      const item = part.item;
      if (item.type === "turn") return r.type === "item" && item.status === "ok" && reply.trim().length < QUIET_CHARS && !/^#{1,6} /m.test(reply) ? { start, reply: reply.trim(), end: k + 1 } : undefined;
      if (item.type !== "assistant") return undefined;
      const blocks = [...item.final, ...item.drafts.slice(item.final.length).filter(Boolean)].slice(part.from, part.to);
      if (blocks.some((b) => b.type === "tool")) return undefined;
      reply += blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    }
  }
  return undefined;
}
