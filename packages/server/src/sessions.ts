import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { answerFits, applyWindowOp, chatWindow, chunksLength, compactWindow, isBusy, isCommand, isCompactSummary, keepEnds, LIVE_SESSION_STATUSES, mergeChunks, sharedNote, sharesWaiting, SHELL_COMMAND_MAX, SHELL_KEEP_HEAD, SHELL_KEEP_TAIL, SHELL_PROMPT_CHARS, shellPrompt, windowState, type Attachment, type ShellChunk, type ShellEnd, type ShellStop, type EndReason, type ResumableSession, type RewindRequest, type SessionEvent, type SessionInfo, type WindowOp, type WindowState, type AgentAsk, type AskAnswer, type AskClosedReason } from "@kumiko/shared";
import { TOOL_TIMEOUT_MS, type AgentDriver, type AgentFile, type AgentMessage, type StartOptions, type TaskOutput, type ToolHost } from "@kumiko/agent";
import { chatEvents, type SessionStore, type StoredSession } from "./store.js";
import { trimMessage } from "./trim.js";
import { ShellOutput, UserShellRun, writeLog } from "./userShells.js";
import type { SandboxProvider } from "@kumiko/sandbox";

/** A SessionEvent before it has its place in the buffer. */
type WithoutSeq<E> = E extends unknown ? Omit<E, "seq"> : never;
type NewEvent = WithoutSeq<SessionEvent>;

export interface Subscriber {
  event(ev: SessionEvent): void;
  /** The session was removed; nothing more will come. */
  gone(): void;
  /** The buffer was rewritten (by a rewind); nothing more will come, and a new subscription replays it from the start. */
  reset(): void;
}

interface Session {
  info: SessionInfo;
  driver: AgentDriver;
  events: SessionEvent[];
  /** The size of `events` as JSON, in bytes; shown in the session's header once per turn. */
  bytes: number;
  seq: number;
  /** Names the buffer `seq` counts in; a new one when the buffer is rewritten (a rewind), and per server run. */
  buffer: string;
  subscribers: Set<Subscriber>;
  /** Content blocks started (by stream events) and finished (by `assistant` messages), per message id. */
  blocks: Map<string, { started: number; finished: number }>;
  /** Set by `end`, so the exit that follows is recorded with the right reason. */
  ending?: EndReason;
  /** Set by `endSandbox` for a sandbox that is to run again: the session falls asleep instead of ending, if it can. */
  sleeping?: boolean;
  /** The model named by the latest /model sent; Claude confirms it in words only, not with an id. */
  pendingModel?: string;
  exited: Promise<void>;
  /** Saves to the store run one after another, so an older state never lands over a newer one. */
  saving: Promise<void>;
  /** Let go of by `detachAll`: Claude carries on without this server, which reports nothing more of it. */
  detached?: boolean;
  /** The session's window, as its `window` events leave it. */
  window: WindowState;
  /** Stops Claude once a closed session's time to finish is up. */
  closeTimer?: NodeJS.Timeout;
  /** Ending and forgetting a closed session, once it is under way. */
  finishing?: Promise<void>;
  /** What this Claude process has said of its background shells and monitors; see `TaskWatch`. */
  tasks?: TaskWatch;
  /**
   * Prompts sent whose turns haven't started, by id: a turn that starts with none waiting is one Claude took by itself.
   * One Claude reads in the middle of a turn gets none, so its echo takes it off.
   */
  waiting?: string[];
  /** Commands the user runs in the sandbox, by run id, until they end. */
  userShells: Map<string, UserShell>;
}

/** A command the user runs, as the session follows it: what it printed so far, and what the chat has had of it. */
interface UserShell {
  run: UserShellRun;
  command: string;
  startedAt: number;
  output: ShellOutput;
  /** Printed but not yet in an event: output goes to the chat a few times a second, not on every write. */
  pending: ShellChunk[];
  flush?: NodeJS.Timeout;
  /** Characters the chat had as the command ran; past `SHELL_STREAM_MAX` it has the rest once the command ends. */
  streamed: number;
  stopped?: ShellStop;
}

/**
 * The shells and monitors of one Claude process, as far as the session follows them: to keep a task's output once it
 * ends, and to tell which monitor woke Claude for a turn of its own.
 */
interface TaskWatch {
  /** Shell and monitor tasks by Claude's task id: whether they run, in the background, and were started by a subagent. */
  shells: Map<string, { running: boolean; background: boolean; subagent: boolean }>;
  /** The tool_use ids of Claude's Monitor calls; a task started by one is a monitor. */
  monitorCalls: Set<string>;
  /** Running monitors, by task id, with how much they had printed when last looked at. */
  monitors: Map<string, number>;
  /**
   * A task ended since Claude's last turn ended that Claude takes a turn to report on, so the turn Claude takes next is
   * for that, not a monitor's line: one in the background that ended by itself, not stopped or ending with its subagent.
   * How it ended says so, not whether the user asked to stop it: one can end by itself just before the stop reaches it.
   */
  ended: boolean;
}

/** What sessions' windows need beyond the window itself: the tools Claude changes them with, and the files they show. */
export interface SessionWidgets {
  /** The tools for the session's Claude, and what to add to its system prompt. */
  tools(info: SessionInfo): { tools: ToolHost; appendSystemPrompt?: string };
  /** What Claude is given of the tools, the same for every session: what `toolsVersion` hashes. */
  given(): string;
  /** One of Claude's messages, after the session has taken it in. */
  message(info: SessionInfo, m: AgentMessage): void;
  /** What the session keeps of one of Claude's messages. */
  keep(info: SessionInfo, m: AgentMessage): AgentMessage;
  /** The events a fork starts with, from the original's. */
  forked(from: SessionInfo, to: SessionInfo, events: SessionEvent[]): SessionEvent[];
  /** The session was rewound; its window is as it was then. */
  rewound(info: SessionInfo, window: WindowState): void;
  /** A saved session was deleted for good. */
  deleted(info: SessionInfo): void;
  /** The session is no longer open. */
  closed(id: string): void;
}

export class SessionNotFound extends Error {}
export class SessionEnded extends Error {}
/** A session can't be resumed or forked: it is open already, or has nothing of Claude's to continue. */
export class SessionNotResumable extends Error {}
/** A rewind can't be done: the prompt isn't in the session, a turn is running, or Claude couldn't restore the files. */
export class RewindRefused extends Error {}
/** An answer to something Claude asked that it isn't waiting for any more, or that doesn't fit what it asked. */
export class AskRefused extends Error {}

type ChainEntry = Extract<SessionEvent, { kind: "claude" }> & { payload: { uuid: string } };

/** One of the messages Claude keeps its history in, as opposed to deltas, system notes and subagents' chatter. */
const isChainEntry = (e: SessionEvent): e is ChainEntry =>
  e.kind === "claude" && (e.payload.type === "assistant" || e.payload.type === "user") && !e.payload.parent_tool_use_id && typeof e.payload.uuid === "string";

const isLive = (s: SessionInfo) => LIVE_SESSION_STATUSES.includes(s.status);

/**
 * Whether `kept`, the message a rewind or fork would cut Claude's history after, comes before Claude's last compaction.
 * Claude only has a summary of what's before that, and can't resume at any of it: it exits at once. Chats saved before
 * Kumiko kept Claude's compact_boundary messages only have the summary to say where a compaction was.
 */
const beforeCompaction = (events: readonly SessionEvent[], kept: SessionEvent) =>
  events.indexOf(kept) < events.findLastIndex((e) => e.kind === "claude" && ((e.payload.type === "system" && e.payload.subtype === "compact_boundary") || isCompactSummary(e.payload)));

/** A session's events without how full the context was, which a new Claude, on a cut or copied history, says anew. */
const withoutContext = (events: SessionEvent[]) => events.filter((e) => e.kind !== "context");
const COMPACTED = "Claude only has a summary of the conversation before its last compaction, so it can't go back there.";

/**
 * Claude is working in the session, on a turn or with subagents it left working in the background: closing it now
 * would cut that short.
 */
const isWorking = isBusy;

/** How long after Claude says a task ended its output is read to be kept, so the line saying how it ended is in it. */
const OUTPUT_SETTLE_MS = 500;

/** How often a running command's output goes to the chat, in ms, and how much of it, in characters, before it ends. */
const SHELL_FLUSH_MS = 100;
const SHELL_STREAM_MAX = 256 * 1024;

/** A command can't be run or stopped: no sandbox to run it in, it is too long, or there is no such command running. */
export class ShellRefused extends Error {}

/**
 * The commands the user ran that the events say started and never ended: they ran in a server that went away, or in
 * the session this one was forked from. Each gets an end, keeping what it printed.
 */
function lostShells(events: readonly SessionEvent[], running: ReadonlyMap<string, unknown>): NewEvent[] {
  const open = new Map<string, ShellChunk[]>();
  for (const e of events) {
    if (e.kind === "user_shell") open.set(e.payload.id, []);
    else if (e.kind === "user_shell_output") open.get(e.payload.id)?.push(e.payload.chunk);
    else if (e.kind === "user_shell_end") open.delete(e.payload.id);
  }
  return [...open].filter(([id]) => !running.has(id)).map(([id, chunks]) => {
    const kept = keepEnds(chunks, SHELL_KEEP_HEAD, SHELL_KEEP_TAIL);
    return { kind: "user_shell_end", payload: { id, stopped: "lost", durationMs: 0, output: kept.chunks, cut: kept.cut } };
  });
}

/** How long Claude may go on with its turn after its session is closed, before it is stopped. */
export const FINISH_MS = 30 * 60_000;

/**
 * How to start Claude on the session's history: as it is, or cut where a rewind left it; on the model it was using, if
 * that was chosen rather than the default, since a Claude started again starts on the default.
 */
const continuing = (info: SessionInfo): Pick<StartOptions, "resume" | "fork" | "resumeAt" | "model"> => ({
  ...(info.resumeAt ? { resume: info.claudeSessionId, fork: true, resumeAt: info.resumeAt } : { resume: info.claudeSessionId }),
  ...keptModel(info),
});

/** The model the session was using, for a Claude started again on it; none if that was the default. */
const keptModel = (info: SessionInfo): Pick<StartOptions, "model"> => (info.model && info.model !== info.defaultModel ? { model: info.model } : {});

/** A hash of what Claude is given of Kumiko's: its tools, what it is told of them, and how long it waits for them. */
const toolsVersion = (widgets: SessionWidgets | undefined) =>
  createHash("sha256")
    .update(JSON.stringify([widgets?.given() ?? "", TOOL_TIMEOUT_MS]))
    .digest("hex")
    .slice(0, 12);

const sizeOf = (e: SessionEvent) => Buffer.byteLength(JSON.stringify(e));

/**
 * Whether `file` is shaped like the file Claude keeps task `taskId`'s output in: an absolute path ending in
 * `tasks/<taskId>.output`, with nothing in it that leads elsewhere. It goes into a command in the sandbox.
 */
export function isTaskOutputFile(file: string, taskId: string): boolean {
  return file.startsWith("/") && file.endsWith(`/tasks/${taskId}.output`) && !/[\0\n\r]/.test(file) && !file.split("/").includes("..");
}

/** Claude's task ids that the events say started and haven't said ended or were lost. */
function openTasks(events: readonly SessionEvent[]): string[] {
  const open = new Set<string>();
  for (const e of events) {
    if (e.kind === "tasks_lost") for (const id of e.payload.taskIds) open.delete(id);
    if (e.kind !== "claude" || e.payload.type !== "system" || typeof e.payload.task_id !== "string") continue;
    if (e.payload.subtype === "task_started") open.add(e.payload.task_id);
    else if (e.payload.subtype === "task_notification") open.delete(e.payload.task_id);
  }
  return [...open];
}

/**
 * Claude's message, with when it arrived for a task's start or end, which Claude doesn't say, so the chat can tell how
 * long a task has run. Messages read again after a restart get the time they were read.
 */
const stamped = (m: AgentMessage): AgentMessage =>
  m.type === "system" && (m.subtype === "task_started" || m.subtype === "task_notification") ? { ...m, received_at: new Date().toISOString() } : m;

/** The driver of a session opened asleep: there is no Claude behind it, so it says nothing and has nothing to stop. */
const noDriver: AgentDriver = {
  start: () => {
    throw new Error("Not a driver to start.");
  },
  attach: () => {
    throw new Error("Not a driver to attach.");
  },
  position: () => undefined,
  send: () => {
    throw new SessionEnded("Claude isn't running in this session.");
  },
  withdraw: () => Promise.reject(new SessionEnded("Claude isn't running in this session.")),
  rewindFiles: () => Promise.reject(new SessionEnded("Claude isn't running in this session.")),
  taskOutput: () => Promise.reject(new SessionEnded("Claude isn't running in this session.")),
  stopTask: () => Promise.reject(new SessionEnded("Claude isn't running in this session.")),
  backgroundTasks: () => Promise.reject(new SessionEnded("Claude isn't running in this session.")),
  interrupt: () => {},
  stop: () => Promise.resolve(),
  detach: () => Promise.resolve(),
  pendingCalls: () => [],
  answer: () => {
    throw new SessionEnded("Claude isn't running in this session.");
  },
  pendingAsks: () => [],
  setPlanMode: () => {},
  onEvent: () => () => {},
};

/** What Claude asked in the session that hasn't been answered, and that it hasn't stopped waiting for, oldest first. */
function openAsks(events: readonly SessionEvent[]): AgentAsk[] {
  const settled = new Set(events.flatMap((e) => (e.kind === "ask_answer" || e.kind === "ask_closed" ? [e.payload.id] : [])));
  return events.flatMap((e) => (e.kind === "ask" && !settled.has(e.payload.id) ? [e.payload] : []));
}

/**
 * Agent sessions, kept in memory: one driver per session and a buffer of everything it said, so a tab that opens
 * or reconnects can replay it. Sessions that end stay listed until they are removed, so their tab keeps the transcript.
 * Emits `changed` whenever a session starts, changes status or goes away.
 */
/** `rateLimit`: Claude in `sandbox` reported how much of its subscription is used, with a turn. */
export class Sessions extends EventEmitter<{ changed: []; rateLimit: [sandbox: string, info: unknown] }> {
  private sessions = new Map<string, Session>();

  constructor(
    private readonly makeDriver: () => AgentDriver,
    private readonly store?: SessionStore,
    private readonly widgets?: SessionWidgets,
    private readonly finishMs = FINISH_MS,
    /** Runs the commands the user sends; without it, they can't be run. */
    private readonly exec?: SandboxProvider["exec"],
  ) {
    super();
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info);
  }

  get(id: string): SessionInfo | undefined {
    return this.sessions.get(id)?.info;
  }

  /** The name of the session's event buffer; see `SessionStreamMessage`. */
  bufferOf(id: string): string | undefined {
    return this.sessions.get(id)?.buffer;
  }

  /** The session's event buffer, as it stands. */
  events(id: string): readonly SessionEvent[] {
    return this.sessions.get(id)?.events ?? [];
  }

  /** The session's window, as it stands. */
  window(id: string): WindowState | undefined {
    return this.sessions.get(id)?.window;
  }

  /** How many sessions are live in each sandbox. */
  liveCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const { info } of this.sessions.values()) if (isLive(info)) counts.set(info.sandbox, (counts.get(info.sandbox) ?? 0) + 1);
    return counts;
  }

  /** Starts Claude on an opening prompt; `attachments` are what the session records of `files`, which Claude gets. */
  start(opts: { sandbox: string; workdir: string; env: string[]; prompt: string; attachments?: Attachment[]; files?: AgentFile[]; model?: string; id?: string }): SessionInfo {
    const { attachments = [] } = opts;
    // A prompt that is only files is named after them.
    const prompt = opts.prompt || attachments.map((a) => a.name).join(", ");
    if (opts.id && this.sessions.has(opts.id)) throw new Error(`There is a session ${opts.id} already.`);
    const info: SessionInfo = { id: opts.id ?? this.newId(), sandbox: opts.sandbox, workdir: opts.workdir, status: "starting", prompt, model: opts.model, startedAt: new Date().toISOString() };
    const promptId = randomUUID();
    const seed: NewEvent = { kind: "user_prompt", payload: { text: opts.prompt, id: promptId, ...(attachments.length ? { attachments } : {}) } };
    return this.launch(info, [seed], { sandbox: opts.sandbox, workdir: opts.workdir, env: opts.env, prompt: opts.prompt, promptId, files: opts.files, model: opts.model });
  }

  /**
   * Continues a saved session under its own id, with its chat restored. Claude has no turn running, so it is
   * ready (`idle`) at once instead of waiting for an init message that only comes with the next prompt.
   */
  resume(stored: StoredSession, env: string[]): SessionInfo {
    const { info: saved } = stored;
    if (this.sessions.has(saved.id)) throw new SessionNotResumable("This session is already open.");
    if (!saved.claudeSessionId) throw new SessionNotResumable("This session has nothing of Claude's to resume.");
    const { endedAt: _endedAt, updatedAt: _updatedAt, unread: _unread, closing: _closing, agents: _agents, shells: _shells, asking: _asking, ...rest } = saved;
    const info: SessionInfo = { ...rest, status: "idle" };
    return this.launch(info, stored.events, { sandbox: info.sandbox, workdir: info.workdir, env, ...continuing(saved) });
  }

  /**
   * Opens a saved session with its chat but no Claude, for its tab while its sandbox is stopped; `wake` starts Claude
   * on it once the sandbox runs. Until then it is `ended`, so nothing can be sent to it.
   */
  openAsleep(stored: StoredSession): SessionInfo {
    const { info: saved } = stored;
    if (this.sessions.has(saved.id)) throw new SessionNotResumable("This session is already open.");
    if (!saved.claudeSessionId) throw new SessionNotResumable("This session has nothing of Claude's to resume.");
    const { endedAt: _endedAt, updatedAt: _updatedAt, closing: _closing, toolsOutdated: _outdated, agents: _agents, shells: _shells, asking: _asking, ...rest } = saved;
    const s = this.newSession({ ...rest, status: "ended", asleep: true }, stored.events);
    this.closeAsks(s, "exited");
    s.driver = noDriver;
    this.sessions.set(saved.id, s);
    this.emit("changed");
    return s.info;
  }

  /** Starts Claude on a session opened asleep, continuing its conversation; one awake already is left as it is. */
  wake(id: string, env: string[]): SessionInfo {
    const s = this.sessions.get(id);
    if (!s) throw new SessionNotFound(`No session ${id}.`);
    if (!s.info.asleep) return s.info;
    const { asleep: _asleep, ...rest } = s.info;
    s.info = { ...rest, status: "idle" };
    s.ending = undefined;
    s.sleeping = undefined;
    this.startDriver(s, { sandbox: s.info.sandbox, workdir: s.info.workdir, env, ...continuing(s.info) });
    this.emit("changed");
    this.save(s);
    return s.info;
  }

  /**
   * Opens a saved session whose Claude is still running (or has exited since) in its run in the sandbox, as a server
   * that went away left it: the saved chat, then everything Claude said after it, as if live. A turn that was in
   * progress comes back with its deltas and status; one that ended in the meantime leaves the session idle and unread.
   */
  reopen(stored: StoredSession): SessionInfo {
    const { info: saved, run } = stored;
    if (this.sessions.has(saved.id)) throw new SessionNotResumable("This session is already open.");
    if (!run?.live) throw new SessionNotResumable("This session's Claude isn't running any more.");
    const { updatedAt: _updatedAt, toolsOutdated: _outdated, ...rest } = saved;
    // The Claude it attaches to keeps the tools it started with, which this Kumiko may have changed since.
    const info: SessionInfo = { ...rest, ...(saved.toolsVersion !== toolsVersion(this.widgets) ? { toolsOutdated: true } : {}) };
    const s = this.newSession(info, stored.events);
    // Deltas saved mid-turn are dropped like any others once their message is finished.
    for (const e of s.events) if (e.kind === "claude") this.countBlocks(s, e.payload);
    this.sessions.set(info.id, s);
    const driver = this.makeDriver();
    this.wire(s, driver);
    driver.attach({ sandbox: info.sandbox, run: run.id, offset: run.offset, tools: this.widgets?.tools(s.info).tools, pending: run.pending, asks: run.asks });
    this.emit("changed");
    // Closed while Claude worked: it goes on finishing, or, if its turn was over already, ends now.
    if (info.closing) {
      if (isWorking(info)) this.armClose(s);
      else void this.finish(s);
    }
    return s.info;
  }

  /**
   * Starts a new session from a copy of this one's conversation, which carries on as it was. With `promptId`, the copy
   * ends with that prompt's turn.
   */
  fork(id: string, env: string[], promptId?: string): SessionInfo {
    const from = this.sessions.get(id);
    if (!from) throw new SessionNotFound(`No session ${id}.`);
    const { claudeSessionId, sandbox, workdir, prompt, model } = from.info;
    if (!claudeSessionId) throw new SessionNotResumable("There is nothing to fork yet: Claude hasn't started this session.");
    let events = from.events;
    let resumeAt = from.info.resumeAt;
    if (promptId !== undefined) {
      const at = events.findIndex((e) => e.kind === "user_prompt" && e.payload.id === promptId);
      if (at < 0) throw new SessionNotResumable("That message can't be forked from.");
      // Up to the next prompt; Claude's history is cut after the last of its messages before that.
      const next = events.findIndex((e, i) => i > at && e.kind === "user_prompt");
      if (next >= 0) {
        events = events.slice(0, next);
        const kept = events.findLast(isChainEntry);
        if (!kept) throw new SessionNotResumable("That message can't be forked from.");
        if (beforeCompaction(from.events, kept)) throw new SessionNotResumable(COMPACTED);
        resumeAt = kept.payload.uuid;
      }
    }
    const info: SessionInfo = { id: this.newId(), sandbox, workdir, prompt, model, status: "idle", startedAt: new Date().toISOString() };
    const seed = withoutContext(this.widgets ? this.widgets.forked(from.info, info, chatEvents(events)) : chatEvents(events));
    return this.launch(info, seed, { sandbox, workdir, env, resume: claudeSessionId, fork: true, ...(resumeAt ? { resumeAt } : {}), ...keptModel(from.info) });
  }

  /**
   * Takes the session back to just before prompt `promptId`: the chat after it is dropped, and Claude starts again on
   * its history cut at the same place. With `files`, the files Claude changed since are put back first; if that fails
   * nothing changes. Returns the prompt's text and files, for the caller to edit and send again.
   */
  async rewind(id: string, promptId: string, env: string[], { files }: RewindRequest): Promise<{ text: string; attachments?: Attachment[] }> {
    const from = this.live(id);
    if (from.info.status !== "idle") throw new RewindRefused("Wait for Claude to finish, or stop it, before rewinding.");
    if (from.userShells.size) throw new RewindRefused("Wait for your command to finish, or stop it, before rewinding.");
    const at = from.events.findIndex((e) => e.kind === "user_prompt" && e.payload.id === promptId);
    const prompt = from.events[at];
    if (prompt?.kind !== "user_prompt") throw new RewindRefused("That message can't be rewound to.");
    // Claude cuts its history after one of its own messages: the last it logged before this prompt, if any.
    const before = from.events.slice(0, at);
    const kept = before.findLast(isChainEntry);
    if (kept && !from.info.claudeSessionId) throw new RewindRefused("Claude hasn't started this session yet.");
    if (kept && beforeCompaction(from.events, kept)) throw new RewindRefused(COMPACTED);

    if (files) {
      try {
        await from.driver.rewindFiles(promptId);
      } catch (err) {
        throw new RewindRefused(`Couldn't restore the files: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Checked again: a prompt may have been sent while the files were being restored.
    if (from.info.status !== "idle" || !isLive(from.info)) throw new RewindRefused("Claude started working again; try once it's done.");

    // Tabs on the session drop what they have and subscribe again, to the chat as it is now.
    for (const sub of from.subscribers) sub.reset();
    from.subscribers.clear();
    from.events = [];
    from.buffer = randomBytes(6).toString("hex");
    from.bytes = 0;
    from.blocks.clear();
    from.pendingModel = undefined;
    from.window = chatWindow();
    for (const ev of withoutContext(chatEvents(before))) this.push(from, ev);

    // Rewound to the first prompt, there is nothing of Claude's to keep: it starts afresh and gets a new id.
    const { claudeSessionId, resumeAt: _resumeAt, ...rest } = from.info;
    from.info = { ...rest, status: "idle", unread: false, bufferBytes: from.bytes, ...(kept ? { claudeSessionId, resumeAt: kept.payload.uuid } : {}) };
    const old = from.driver;
    this.widgets?.rewound(from.info, from.window);
    this.startDriver(from, { sandbox: from.info.sandbox, workdir: from.info.workdir, env, ...(kept ? continuing(from.info) : {}) });
    void old.stop();
    this.emit("changed");
    this.save(from);
    return { text: prompt.payload.text, attachments: prompt.payload.attachments };
  }

  /**
   * Saved sessions that aren't open, most recently used first; those whose tab closed while Claude finishes are among
   * them, as they are now, unless they are to be deleted.
   */
  async resumable(): Promise<ResumableSession[]> {
    const saved = await this.store?.readAll();
    const finishing = [...this.sessions.values()].map((s) => s.info).filter((i) => i.closing && !i.closing.delete);
    const listed: SessionInfo[] = [
      ...(saved ?? [])
        .map((s) => s.info)
        .filter((i) => !this.sessions.has(i.id) && !i.closing?.delete)
        .map((i) => ({ ...i, status: "ended" as const })),
      ...finishing.map((i) => ({ ...i, updatedAt: i.updatedAt ?? new Date().toISOString() })),
    ];
    return listed
      .filter((i): i is ResumableSession => Boolean(i.claudeSessionId))
      .sort((a, b) => (b.updatedAt ?? b.startedAt).localeCompare(a.updatedAt ?? a.startedAt));
  }

  /**
   * Deletes a saved session for good. An open one can't be: close its tab first. One closed while Claude finishes is
   * deleted once it has.
   */
  async deleteSaved(id: string): Promise<boolean> {
    const open = this.sessions.get(id);
    if (open?.info.closing) {
      this.setInfo(open, { closing: { ...open.info.closing, delete: true } });
      this.save(open);
      return true;
    }
    if (open) throw new SessionNotResumable("This session is open; close its tab first.");
    const stored = await this.store?.read(id);
    if (!stored) return false;
    await this.store!.remove(id);
    this.widgets?.deleted(stored.info);
    return true;
  }

  /** Deletes every saved session of a project that is going away: Claude's transcripts go with its Claude home. */
  async deleteSavedFor(sandbox: string): Promise<void> {
    if (!this.store) return;
    await this.flush();
    const saved = await this.store.readAll();
    await Promise.all(saved.filter((x) => x.info.sandbox === sandbox).map((x) => this.store!.remove(x.info.id)));
  }

  /** An id no open session has, for one about to start; see `start`. */
  newId(): string {
    let id: string;
    do id = randomBytes(6).toString("hex");
    while (this.sessions.has(id));
    return id;
  }

  /** A session with `seed` in a new buffer, not yet listed and with no driver. */
  private newSession(info: SessionInfo, seed: NewEvent[]): Session {
    const s: Session = { info, driver: undefined!, events: [], bytes: 0, seq: 0, buffer: randomBytes(6).toString("hex"), subscribers: new Set(), blocks: new Map(), exited: Promise.resolve(), saving: Promise.resolve(), window: chatWindow(), userShells: new Map() };
    for (const ev of seed) this.push(s, ev);
    for (const ev of lostShells(s.events, s.userShells)) this.push(s, ev);
    this.dropShellOutput(s);
    s.info = { ...info, bufferBytes: s.bytes };
    return s;
  }

  private launch(info: SessionInfo, seed: NewEvent[], driverOpts: StartOptions): SessionInfo {
    const s = this.newSession(info, seed);
    this.sessions.set(info.id, s);
    try {
      this.startDriver(s, driverOpts);
    } catch (err) {
      // Nothing started (e.g. a saved Claude id that isn't one), so there is no exit to wait for: forget it now.
      this.sessions.delete(info.id);
      throw err;
    }
    this.emit("changed");
    // Saved with its run straight away, so a server that goes away before Claude says anything can find it again.
    this.save(s);
    return s.info;
  }

  /**
   * Starts a Claude process for the session, in a run of its own. Nothing the last one asked can be answered now; a
   * session that was planning goes on planning, as Claude starts with permissions bypassed.
   */
  private startDriver(s: Session, driverOpts: StartOptions) {
    const driver = this.makeDriver();
    this.closeAsks(s, "exited");
    this.wire(s, driver);
    const widgets = this.widgets?.tools(s.info);
    const { toolsOutdated: _outdated, ...info } = s.info;
    s.info = { ...info, toolsVersion: toolsVersion(this.widgets) };
    // Tasks the last process never said were over went with it.
    const lost = openTasks(s.events);
    if (lost.length) this.push(s, { kind: "tasks_lost", payload: { taskIds: lost } });
    s.tasks = undefined;
    s.waiting = driverOpts.prompt !== undefined && driverOpts.promptId ? [driverOpts.promptId] : [];
    driver.start({ ...driverOpts, run: `${s.info.id}-${randomBytes(4).toString("hex")}`, ...widgets });
    if (s.info.planMode) driver.setPlanMode(true);
  }

  /** Records that Claude stopped waiting for everything it asked, for `reason`. */
  private closeAsks(s: Session, reason: AskClosedReason) {
    for (const ask of openAsks(s.events)) this.push(s, { kind: "ask_closed", payload: { id: ask.id, reason } });
    if (s.info.asking) this.setInfo(s, { asking: undefined });
  }

  /** Claude asked the user something, as `driver` reports it. */
  private onAsk(s: Session, driver: AgentDriver, ask: AgentAsk) {
    if (s.events.some((e) => e.kind === "ask" && e.payload.id === ask.id)) {
      // Read again, after a server went away without saving how far it had read: if the user has answered it since, the
      // answer may never have reached Claude, so it goes again.
      const answered = s.events.find((e) => e.kind === "ask_answer" && e.payload.id === ask.id);
      if (answered?.kind === "ask_answer") {
        try {
          driver.answer(ask.id, answered.payload.answer);
        } catch {
          // It knows the ask already, with its answer: Claude has had it.
        }
      }
      return;
    }
    this.push(s, { kind: "ask", payload: ask });
    this.setInfo(s, { asking: ask.kind });
    // Saved at once, with the ask among the run's, so a server that goes away now leaves it for the next.
    this.save(s);
  }

  /** Makes `driver` the session's. Once another replaces it, or the session is detached, nothing it says reaches the session. */
  private wire(s: Session, driver: AgentDriver) {
    let resolveExit!: () => void;
    s.driver = driver;
    s.exited = new Promise((r) => (resolveExit = r));

    driver.onEvent((ev) => {
      if (s.driver !== driver || s.detached) return;
      switch (ev.kind) {
        case "message":
          this.push(s, { kind: "claude", payload: stamped(ev.payload) });
          this.onMessage(s, ev.payload);
          this.widgets?.message(s.info, ev.payload);
          break;
        case "error":
          this.push(s, { kind: "error", payload: { message: ev.message, hint: ev.hint, stderr: ev.stderr, ...(ev.signedOut ? { signedOut: true } : {}) } });
          break;
        case "ask":
          this.onAsk(s, driver, ev.ask);
          break;
        case "ask_closed":
          if (!openAsks(s.events).some((a) => a.id === ev.id)) break;
          this.push(s, { kind: "ask_closed", payload: { id: ev.id, reason: ev.reason } });
          this.setInfo(s, { asking: openAsks(s.events).at(-1)?.kind });
          break;
        case "mode":
          this.setInfo(s, { planMode: ev.plan || undefined });
          break;
        case "context": {
          // Only the latest says anything, so it takes the place of the one before. It's saved with the next turn; a
          // server started in between hears anew from Claude.
          const was = s.events.findIndex((e) => e.kind === "context");
          if (was >= 0) s.bytes -= sizeOf(s.events.splice(was, 1)[0]);
          this.push(s, { kind: "context", payload: ev.usage });
          break;
        }
        case "exit": {
          this.closeAsks(s, "exited");
          this.stopShells(s, "ended");
          const reason = s.ending ?? "exit";
          const failed = !s.ending && (ev.code !== 0 || s.info.status === "starting");
          // A session that stopped by itself needs the user to look; one they ended doesn't.
          const unread = s.ending ? s.info.unread : true;
          // Stopped with its sandbox, it continues once that runs again, if it has anything of Claude's to continue.
          const asleep = s.sleeping === true && !s.info.closing && s.info.claudeSessionId !== undefined;
          this.setInfo(s, { status: failed ? "failed" : "ended", endedAt: new Date().toISOString(), bufferBytes: s.bytes, unread, agents: undefined, shells: undefined, ...(asleep ? { asleep } : {}) });
          this.push(s, { kind: "ended", payload: { reason, code: ev.code, ...(asleep ? { asleep } : {}) } });
          this.save(s);
          resolveExit();
          if (s.info.closing) void this.finish(s);
          break;
        }
      }
    });
  }

  /**
   * Swaps the session's Claude process for a new one, keeping the chat: for after a login, since a process that
   * started logged out stays that way. It continues Claude's session if a turn ever succeeded in it; otherwise there is
   * nothing of Claude's to continue, and it starts afresh. Works on an ended session too, which becomes live again.
   * `keepUnread`: a restart the user didn't ask for leaves a finished turn waiting on them.
   */
  relaunch(id: string, env: string[], { keepUnread = false }: { keepUnread?: boolean } = {}): SessionInfo {
    const s = this.sessions.get(id);
    if (!s) throw new SessionNotFound(`No session ${id}.`);
    if (s.info.status === "running" || s.info.status === "starting") throw new SessionNotResumable("Wait for Claude to finish, or stop it, first.");
    const succeeded = s.events.some((e) => e.kind === "claude" && e.payload.type === "result" && e.payload.is_error !== true);
    const resume = succeeded && s.info.claudeSessionId ? continuing(s.info) : undefined;
    const old = s.driver;
    const live = isLive(s.info);
    const { endedAt: _endedAt, asleep: _asleep, agents: _agents, shells: _shells, ...rest } = s.info;
    // A fresh start gets a new Claude id from its first init; until then there is nothing to fork or resume.
    s.info = { ...rest, status: "idle", unread: keepUnread ? s.info.unread : false, ...(resume ? {} : { claudeSessionId: undefined, resumeAt: undefined }) };
    s.ending = undefined;
    s.sleeping = undefined;
    s.blocks.clear();
    this.startDriver(s, { sandbox: s.info.sandbox, workdir: s.info.workdir, env, ...resume });
    if (live) void old.stop();
    this.emit("changed");
    this.save(s);
    return s.info;
  }

  /**
   * Writes the session's chat to the store, with its run and how much of the run's output the chat covers: once Claude
   * has given it an id to resume by, and while its run is live, so the next server can attach to it again.
   */
  private save(s: Session) {
    const { store } = this;
    if (!store) return;
    const at = s.driver.position();
    const live = isLive(s.info) && at !== undefined;
    // Only its run made it worth keeping, and that has ended with nothing of Claude's to resume.
    if (!s.info.claudeSessionId && !live) return this.forget(s);
    const unfinished = new Set([...s.blocks].filter(([, c]) => c.finished < c.started).map(([id]) => id));
    // Asleep is how its tab is, while open: opened again, it is asleep only if its sandbox is stopped then.
    const { asleep: _asleep, ...info } = s.info;
    const stored: StoredSession = {
      info: { ...info, updatedAt: new Date().toISOString() },
      events: chatEvents(s.events, live ? unfinished : undefined),
      ...(at ? { run: { id: at.run, offset: at.offset, live, ...(live && s.driver.pendingCalls().length ? { pending: s.driver.pendingCalls() } : {}), ...(live && s.driver.pendingAsks().length ? { asks: s.driver.pendingAsks() } : {}) } } : {}),
    };
    s.saving = s.saving.then(() => store.write(stored)).catch(() => {});
  }

  /** Deletes the session's saved copy, which no longer matches its chat and has nothing of Claude's to resume yet. */
  private forget(s: Session) {
    const { store } = this;
    if (!store) return;
    s.saving = s.saving.then(() => store.remove(s.info.id)).catch(() => {});
  }

  /** Resolves once everything handed to the store has been written. */
  async flush(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.saving));
  }

  /** Counts the content blocks a message starts (with its deltas) and finishes (whole), by message id. */
  private countBlocks(s: Session, m: AgentMessage) {
    const count = (id: unknown, field: "started" | "finished", n: number) => {
      if (typeof id !== "string") return;
      const c = s.blocks.get(id) ?? { started: 0, finished: 0 };
      c[field] += n;
      s.blocks.set(id, c);
    };
    if (m.type === "stream_event" && (m.event as { type?: unknown } | undefined)?.type === "content_block_start") count(m.api_message_id, "started", 1);
    if (m.type === "assistant") {
      const msg = m.message as { id?: unknown; content?: unknown } | undefined;
      count(msg?.id, "finished", Array.isArray(msg?.content) ? msg.content.length : 0);
    }
  }

  private onMessage(s: Session, m: AgentMessage) {
    this.countBlocks(s, m);

    this.watchTasks(s, m);
    if (m.type === "user" && m.isReplay === true) s.waiting = s.waiting?.filter((id) => id !== m.uuid);
    if (m.type === "system" && m.subtype === "init") {
      // A turn nobody prompted, with no task ended to report on: a monitor's line may have woken Claude.
      if (s.waiting?.length) s.waiting = s.waiting.slice(1);
      // The init is the last event recorded: the turn it starts is the one the line is for.
      else if (s.tasks && !s.tasks.ended && s.tasks.monitors.size) void this.findMonitorEvent(s, s.seq);
      // Claude sends init at the start of every turn, so it also marks a queued prompt's turn starting.
      const isNew = typeof m.session_id === "string" && m.session_id !== s.info.claudeSessionId;
      this.setInfo(s, {
        claudeSessionId: typeof m.session_id === "string" ? m.session_id : s.info.claudeSessionId,
        // The cut history has its own id now, which a restart resumes as it is.
        resumeAt: isNew ? undefined : s.info.resumeAt,
        model: typeof m.model === "string" ? m.model : s.info.model,
        // Started without a model chosen: the first one reported is the default.
        defaultModel: s.info.defaultModel ?? (!s.info.model && typeof m.model === "string" ? m.model : undefined),
        commands: Array.isArray(m.slash_commands) ? m.slash_commands.filter((c): c is string => typeof c === "string") : s.info.commands,
        status: "running",
      });
      // Saved as soon as it can be resumed, in case the app goes away before the first turn ends.
      if (isNew) this.save(s);
      // A prompt queued in a session that was closed: the turn it was waiting for is all Claude finishes.
      if (s.finishing) s.driver.interrupt();
    } else if (m.type === "rate_limit_event") {
      this.emit("rateLimit", s.info.sandbox, m.rate_limit_info);
    } else if (m.type === "system" && m.subtype === "background_tasks_changed") {
      // Claude lists what it has running in the background whenever that changes. Subagents are work; shells and
      // monitors are counted apart, and watchers Claude marks ambient not at all.
      const tasks = Array.isArray(m.tasks) ? (m.tasks as { task_type?: unknown; ambient?: unknown }[]) : [];
      const agents = tasks.filter((t) => t?.task_type === "local_agent").length;
      const shells = tasks.filter((t) => t?.task_type !== "local_agent" && t?.ambient !== true).length;
      this.setInfo(s, { agents: agents || undefined, shells: shells || undefined });
    } else if (m.type === "system" && m.subtype === "session_title_changed") {
      // /rename; saved with the turn's result that follows.
      if (typeof m.title === "string" && m.title.trim()) this.setInfo(s, { title: m.title.trim(), titleBy: "user" });
    } else if (m.type === "assistant" && isLive(s.info)) {
      // /model shows up here first, as the model of the next real reply.
      const model = (m.message as { model?: unknown } | undefined)?.model;
      if (typeof model === "string" && !model.startsWith("<")) this.setInfo(s, { model });
    } else if (m.type === "result") {
      // A finished message carries everything its deltas did, so drop them to keep long sessions small. Deltas of
      // a message cut short by Stop are all there is of it, so those stay.
      const done = new Set([...s.blocks].filter(([, c]) => c.finished >= c.started).map(([id]) => id));
      s.events = s.events.filter((e) => !(e.kind === "claude" && e.payload.type === "stream_event" && done.has(String(e.payload.api_message_id))));
      // The turn's changes to the window come down to the state they left it in.
      s.events = compactWindow(s.events);
      s.bytes = s.events.reduce((n, e) => n + sizeOf(e), 0);
      s.blocks.clear();
      if (s.tasks) s.tasks.ended = false;
      const switched = s.pendingModel && typeof m.result === "string" && m.result.startsWith("Set model to");
      // Claude is done and waits for the user, until they look.
      this.setInfo(s, { status: "idle", bufferBytes: s.bytes, unread: true, ...(switched ? { model: s.pendingModel } : {}) });
      this.save(s);
      // Closed with subagents still working in the background: once they are done, Claude takes a turn of its own to
      // report on them, and the session ends after that one.
      if (s.info.closing && !isWorking(s.info)) void this.finish(s);
    }
  }

  private setInfo(s: Session, patch: Partial<SessionInfo>) {
    if (!isLive(s.info) && patch.status && LIVE_SESSION_STATUSES.includes(patch.status)) return;
    const next = { ...s.info, ...patch };
    if (JSON.stringify(next) === JSON.stringify(s.info)) return;
    s.info = next;
    this.emit("changed");
  }

  /** Records an event; a window event's resulting window is `window` when the caller has applied it already. */
  private push(s: Session, ev: NewEvent, window?: WindowState) {
    // Large tool output is cut before it is kept; Claude's own transcript in the sandbox has all of it.
    const trimmed = (p: AgentMessage) => (this.widgets ? this.widgets.keep(s.info, trimMessage(p)) : trimMessage(p));
    const kept = ev.kind === "claude" ? { ...ev, payload: trimmed(ev.payload) } : ev;
    const full = { ...kept, seq: ++s.seq } as SessionEvent;
    if (full.kind === "window") s.window = window ?? windowState([full], s.window);
    s.events.push(full);
    s.bytes += sizeOf(full);
    for (const sub of s.subscribers) sub.event(full);
  }

  private live(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new SessionNotFound(`No session ${id}.`);
    if (!isLive(s.info)) throw new SessionEnded("This session has ended. Close its tab, then resume it from a New session tab.");
    return s;
  }

  /**
   * Sends a prompt; `attachments` are what the session records of `files`, which Claude gets. With `shell`, the prompt
   * gives Claude a command the user ran, which Claude gets as `shell.text` while the chat shows `text`.
   */
  prompt(id: string, text: string, attachments: Attachment[] = [], files: AgentFile[] = [], shell?: { id: string; text: string }): void {
    const s = this.live(id);
    // Claude reads nothing more until what it asked is settled: a message sent meanwhile answers it, and comes next.
    for (const ask of openAsks(s.events)) {
      try {
        this.answerAsk(id, ask.id, { kind: "message" });
      } catch {
        // Claude isn't waiting for it after all: the message goes as it is.
      }
    }
    const promptId = randomUUID();
    // Artifacts other sessions shared since the last message: Claude hears of them with this one, unless it is a command.
    const note = isCommand(text) ? "" : sharedNote(sharesWaiting(s.events));
    this.push(s, { kind: "user_prompt", payload: { text, id: promptId, ...(attachments.length ? { attachments } : {}), ...(shell ? { shell: shell.id } : {}) } });
    s.pendingModel = shell ? undefined : /^\/model\s+(\S+)/.exec(text)?.[1];
    s.waiting = [...(s.waiting ?? []), promptId];
    s.driver.send((shell?.text ?? text) + note, promptId, files);
    if (s.info.status === "idle") this.setInfo(s, { status: "running" });
    // Kumiko's own record of the prompt is nowhere in Claude's output, so it is saved now.
    this.save(s);
  }

  /**
   * Runs `command` in the session's sandbox, in its working directory, with the forwarded variables `env`, as a
   * message starting with "!" does. Its output streams into the chat, and once it ends Claude gets the command and
   * its output as a prompt, and replies, or reads it in the middle of the turn it is taking. Returns the run's id.
   */
  runShell(id: string, command: string, env: string[]): string {
    const s = this.live(id);
    if (!this.exec || s.driver === noDriver) throw new ShellRefused("Commands can't run in this session.");
    if (!command.trim()) throw new ShellRefused("The command is empty.");
    if (command.length > SHELL_COMMAND_MAX) throw new ShellRefused(`The command is too long: ${command.length.toLocaleString("en-US")} characters, of ${SHELL_COMMAND_MAX.toLocaleString("en-US")} at most.`);
    const runId = randomBytes(6).toString("hex");
    const { sandbox, workdir } = s.info;
    const startedAt = Date.now();
    this.push(s, { kind: "user_shell", payload: { id: runId, command, cwd: workdir, startedAt: new Date(startedAt).toISOString() } });
    const shell: UserShell = { run: undefined!, command, startedAt, output: new ShellOutput(), pending: [], streamed: 0 };
    s.userShells.set(runId, shell);
    shell.run = new UserShellRun(this.exec, sandbox, runId, command, env, workdir, {
      chunk: (c) => {
        shell.output.add(c);
        if (shell.streamed >= SHELL_STREAM_MAX) return;
        const room = SHELL_STREAM_MAX - shell.streamed;
        shell.pending.push(c.text.length > room ? { stream: c.stream, text: c.text.slice(0, room) } : c);
        shell.streamed += Math.min(room, c.text.length);
        shell.flush ??= setTimeout(() => this.flushShell(s, runId, shell), SHELL_FLUSH_MS);
      },
      end: (r) => void this.endShell(s, runId, shell, r),
    });
    return runId;
  }

  /** Stops command `runId`, which the user ran in the session. */
  stopShell(id: string, runId: string): void {
    const s = this.sessions.get(id);
    if (!s) throw new SessionNotFound(`No session ${id}.`);
    const shell = s.userShells.get(runId);
    if (!shell) throw new ShellRefused("That command isn't running.");
    shell.stopped ??= "user";
    shell.run.stop();
  }

  private stopShells(s: Session, reason: ShellStop) {
    for (const shell of s.userShells.values()) {
      shell.stopped ??= reason;
      shell.run.stop();
    }
  }

  private flushShell(s: Session, runId: string, shell: UserShell) {
    clearTimeout(shell.flush);
    shell.flush = undefined;
    for (const chunk of mergeChunks(shell.pending.splice(0))) if (!s.detached) this.push(s, { kind: "user_shell_output", payload: { id: runId, chunk } });
  }

  /**
   * Command `runId` ended: the chat keeps the start and end of what it printed in place of what streamed in, and Claude
   * gets it as a prompt, with all of it in a log in the sandbox when Claude can't get all of it.
   */
  private async endShell(s: Session, runId: string, shell: UserShell, r: { code?: number; error?: string }) {
    this.flushShell(s, runId, shell);
    const durationMs = Date.now() - shell.startedAt;
    // An interrupted command exits with 128 plus the signal's number, as it would in a terminal; Stop says it better.
    const end: ShellEnd = { ...(shell.stopped && (r.code === undefined || r.code > 128) ? { stopped: shell.stopped } : { code: r.code }), ...(r.error ? { error: r.error } : {}), durationMs };
    const all = shell.output.chunks();
    const log = this.exec && (shell.output.cut || chunksLength(all) > SHELL_PROMPT_CHARS) ? await writeLog(this.exec, s.info.sandbox, runId, all.map((c) => c.text).join("")) : undefined;
    s.userShells.delete(runId);
    if (s.detached) return;
    const kept = keepEnds(all, SHELL_KEEP_HEAD, SHELL_KEEP_TAIL);
    this.push(s, { kind: "user_shell_end", payload: { id: runId, ...end, output: kept.chunks, cut: kept.cut + shell.output.cut, ...(log ? { log } : {}) } });
    this.dropShellOutput(s);
    // A command that ended with its session has no Claude to tell; one ended by the user's Stop still goes to Claude.
    if (isLive(s.info) && end.stopped !== "ended" && s.driver !== noDriver) {
      try {
        this.prompt(s.info.id, `!${shell.command}`, [], [], { id: runId, text: shellPrompt(shell.command, all, end, log) });
        return;
      } catch {
        // Claude went as the command ended: the chat keeps it all the same.
      }
    }
    this.save(s);
  }

  /** Drops the output of commands that have ended, whose end keeps what the chat shows of it. */
  private dropShellOutput(s: Session) {
    const ended = new Set(s.events.flatMap((e) => (e.kind === "user_shell_end" ? [e.payload.id] : [])));
    if (!s.events.some((e) => e.kind === "user_shell_output" && ended.has(e.payload.id))) return;
    s.events = s.events.filter((e) => !(e.kind === "user_shell_output" && ended.has(e.payload.id)));
    s.bytes = s.events.reduce((n, e) => n + sizeOf(e), 0);
  }

  /**
   * Takes back prompt `promptId`, sent while Claude worked, so it can be edited and sent again; false if Claude has
   * read it already, and it runs as sent.
   */
  async withdrawPrompt(id: string, promptId: string): Promise<boolean> {
    const s = this.live(id);
    if (!(await s.driver.withdraw(promptId))) return false;
    s.waiting = s.waiting?.filter((p) => p !== promptId);
    this.push(s, { kind: "prompt_withdrawn", payload: { id: promptId } });
    this.save(s);
    return true;
  }

  /**
   * Changes the session's window, from Claude's tool call `toolUseId` or from the user; returns the window as it is
   * now. Throws WindowError, changing nothing, if the change doesn't fit the window. Live sessions only, like a prompt.
   */
  changeWindow(id: string, op: WindowOp, toolUseId?: string): WindowState {
    const s = this.live(id);
    const after = applyWindowOp(s.window, op);
    this.push(s, { kind: "window", payload: toolUseId ? { op, toolUseId } : { op } }, after);
    // A turn's changes are saved with its result; one between turns has nothing else to be saved with.
    if (s.info.status === "idle") this.save(s);
    return s.window;
  }

  /**
   * Names the session, as Claude does with Kumiko's tool, and with `description` describes it; the user's /rename goes
   * through Claude instead.
   */
  rename(id: string, title: string | undefined, by: "user" | "agent", description?: string): void {
    const s = this.live(id);
    this.setInfo(s, { ...(title !== undefined && { title, titleBy: by }), ...(description !== undefined && { description }) });
    // Like a change to the window: saved with the turn's result, or now if there is none to come.
    if (s.info.status === "idle") this.save(s);
  }

  /**
   * Records Claude's tool call `toolUseId` asking the user to start a new session on `prompt`; returns the proposal's
   * id. Nothing starts until the user accepts it (see `answerProposal`).
   */
  propose(id: string, proposal: { prompt: string; title?: string; artifacts?: string[] }, toolUseId?: string): string {
    const s = this.live(id);
    const proposalId = randomUUID();
    this.push(s, { kind: "proposal", payload: { id: proposalId, ...proposal, ...(toolUseId ? { toolUseId } : {}) } });
    if (s.info.status === "idle") this.save(s);
    return proposalId;
  }

  /** Proposal `proposalId` of the session, if it is there and hasn't been answered. */
  openProposal(id: string, proposalId: string): { prompt: string; title?: string; artifacts?: string[] } | undefined {
    const events = this.sessions.get(id)?.events ?? [];
    if (events.some((e) => e.kind === "proposal_answer" && e.payload.id === proposalId)) return undefined;
    const p = events.find((e) => e.kind === "proposal" && e.payload.id === proposalId);
    if (p?.kind !== "proposal") return undefined;
    const { id: _id, toolUseId: _toolUseId, ...proposal } = p.payload;
    return proposal;
  }

  /** Records that session `from` shared copies of artifacts with session `id`; see `sharesWaiting`. */
  shared(id: string, from: SessionInfo, name: string, artifacts: { path: string; title: string }[]): void {
    const s = this.live(id);
    this.push(s, { kind: "shared", payload: { from: from.id, name, artifacts } });
    if (s.info.status === "idle") this.save(s);
  }

  /** Records the user's answer to a proposal: accepted, having started `session` (on `prompt`, if they changed it), or declined. */
  answerProposal(id: string, proposalId: string, accepted: boolean, session?: string, prompt?: string): void {
    const s = this.sessions.get(id);
    if (!s) throw new SessionNotFound(`No session ${id}.`);
    this.push(s, { kind: "proposal_answer", payload: { id: proposalId, accepted, ...(session ? { session } : {}), ...(prompt !== undefined ? { prompt } : {}) } });
    if (s.info.status !== "running" && s.info.status !== "starting") this.save(s);
  }

  /** Answers what Claude asked, ask `askId`. Throws AskRefused if it isn't waiting for that, or the answer doesn't fit. */
  answerAsk(id: string, askId: string, answer: AskAnswer): void {
    const s = this.live(id);
    const ask = openAsks(s.events).find((a) => a.id === askId);
    if (!ask) throw new AskRefused("That has been answered already, or Claude stopped waiting for it.");
    if (!answerFits(ask.kind, answer)) throw new AskRefused("That isn't an answer to this.");
    try {
      s.driver.answer(askId, answer);
    } catch (err) {
      throw new AskRefused(err instanceof Error ? err.message : String(err));
    }
    this.push(s, { kind: "ask_answer", payload: { id: askId, answer } });
    this.setInfo(s, { asking: openAsks(s.events).at(-1)?.kind });
    this.save(s);
  }

  /** Has Claude plan, and wait for the user to approve the plan, before it changes anything; or not. */
  setPlanMode(id: string, plan: boolean): void {
    this.live(id).driver.setPlanMode(plan);
  }

  /** The user has looked at the session: it no longer waits on them. */
  markSeen(id: string): void {
    const s = this.sessions.get(id);
    if (!s) throw new SessionNotFound(`No session ${id}.`);
    if (s.info.unread) this.setInfo(s, { unread: false });
  }

  /** Follows what Claude says of its shells and monitors; see `TaskWatch`. */
  private watchTasks(s: Session, m: AgentMessage) {
    const w = (s.tasks ??= { shells: new Map(), monitorCalls: new Set(), monitors: new Map(), ended: false });
    if (m.type === "assistant" && !m.parent_tool_use_id) {
      const content = (m.message as { content?: unknown } | undefined)?.content;
      for (const b of Array.isArray(content) ? (content as { type?: unknown; name?: unknown; id?: unknown }[]) : [])
        if (b?.type === "tool_use" && b.name === "Monitor" && typeof b.id === "string") w.monitorCalls.add(b.id);
    }
    if (m.type !== "system" || typeof m.task_id !== "string") return;
    const id = m.task_id;
    if (m.subtype === "task_started" && m.task_type === "local_bash") {
      w.shells.set(id, { running: true, background: m.is_backgrounded === true, subagent: typeof m.parent_task_id === "string" });
      if (typeof m.tool_use_id === "string" && w.monitorCalls.has(m.tool_use_id)) w.monitors.set(id, 0);
    } else if (m.subtype === "task_updated" && (m.patch as { is_backgrounded?: unknown } | undefined)?.is_backgrounded === true) {
      const shell = w.shells.get(id);
      if (shell) shell.background = true;
    } else if (m.subtype === "task_notification") {
      const shell = w.shells.get(id);
      const timedOut = typeof m.summary === "string" && m.summary.includes("background time limit");
      const byItself = m.status === "completed" || m.status === "failed" || timedOut;
      // A subagent's end is reported too; a shell's only when it ran in the background, on its own.
      if (byItself && (!shell || (shell.background && !shell.subagent))) w.ended = true;
      w.monitors.delete(id);
      if (!shell?.running) return;
      shell.running = false;
      // Claude deletes a task's output soon after, and all of it when it exits: what it printed is kept with the session.
      // It adds how the task ended ("[killed]") just after it says so, hence the wait.
      const driver = s.driver;
      void new Promise((r) => setTimeout(r, OUTPUT_SETTLE_MS)).then(() => driver.taskOutput(id)).then(
        (o) => {
          if (isLive(s.info)) this.push(s, { kind: "task_output", payload: { taskId: id, output: o.output, totalBytes: o.totalBytes, truncated: o.truncated } });
        },
        () => {},
      );
    }
  }

  /**
   * Which monitor woke Claude for the turn it is starting, if one did: the one whose output grew since it was last looked
   * at. Claude's stream doesn't say, so its newest line is recorded for the chat to start that turn with.
   */
  private async findMonitorEvent(s: Session, at: number) {
    const w = s.tasks!;
    const driver = s.driver;
    for (const [id, seen] of [...w.monitors]) {
      const o = await driver.taskOutput(id).catch(() => undefined);
      if (!o || o.totalBytes <= seen || s.driver !== driver) continue;
      w.monitors.set(id, o.totalBytes);
      const line = o.output.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
      if (isLive(s.info)) this.push(s, { kind: "monitor_event", payload: { taskId: id, line, at } });
      return;
    }
  }

  /**
   * Where Claude keeps all of what background task `taskId` printed, as its notification of the task's end says, if it
   * says so of a file shaped like Claude's task output. On a session that has ended too, while it is open.
   */
  taskFile(id: string, taskId: string): string | undefined {
    const s = this.sessions.get(id);
    if (!s) throw new SessionNotFound(`No session ${id}.`);
    for (const e of s.events) {
      if (e.kind !== "claude" || e.payload.subtype !== "task_notification" || e.payload.task_id !== taskId) continue;
      const file = e.payload.output_file;
      if (typeof file === "string" && isTaskOutputFile(file, taskId)) return file;
    }
    return undefined;
  }

  /** The end of what background task `taskId` has printed, from Claude, which keeps it. */
  taskOutput(id: string, taskId: string): Promise<TaskOutput> {
    return this.live(id).driver.taskOutput(taskId);
  }

  /** Stops a background task, as the user asked; recorded first, so the chat can say who stopped it. */
  async stopTask(id: string, taskId: string): Promise<void> {
    const s = this.live(id);
    this.push(s, { kind: "task_stop", payload: { taskId } });
    await s.driver.stopTask(taskId);
  }

  /** Moves foreground tasks to the background: the one tool call `toolUseId` started, or all of them. */
  backgroundTasks(id: string, toolUseId?: string): Promise<void> {
    return this.live(id).driver.backgroundTasks(toolUseId);
  }

  interrupt(id: string): void {
    const s = this.live(id);
    this.push(s, { kind: "interrupt", payload: {} });
    s.driver.interrupt();
  }

  /**
   * Replays the events after `after`, then passes on each new one until unsubscribed.
   * Returns undefined for an unknown session.
   */
  subscribe(id: string, after: number, sub: Subscriber): (() => void) | undefined {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    for (const ev of s.events) if (ev.seq > after) sub.event(ev);
    s.subscribers.add(sub);
    return () => s.subscribers.delete(sub);
  }

  /** Ends a live session; resolves once its process has exited. Ended sessions are left as they are. */
  async end(id: string, reason: EndReason): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) throw new SessionNotFound(`No session ${id}.`);
    if (!isLive(s.info)) return;
    s.ending ??= reason;
    await s.driver.stop();
    await s.exited;
  }

  /**
   * Closes a session's tab. Claude, if working, finishes its turn first, out of the tabs' sight, for up to `finishMs`;
   * with `stop`, or with Claude not working, the session ends at once. Then it is forgotten, and with `forget` its saved
   * chat is deleted too. Resolves true once Claude is left to finish, or false once the session is gone.
   */
  async close(id: string, { forget = false, stop = false }: { forget?: boolean; stop?: boolean } = {}): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) throw new SessionNotFound(`No session ${id}.`);
    const until = s.info.closing?.until ?? new Date(Date.now() + this.finishMs).toISOString();
    this.setInfo(s, { closing: { delete: forget || s.info.closing?.delete === true, until } });
    if (stop || s.finishing || !isLive(s.info) || !isWorking(s.info)) {
      await this.finish(s);
      return false;
    }
    this.armClose(s);
    this.save(s);
    return true;
  }

  /** Stops a closed session's Claude when its time to finish is up. */
  private armClose(s: Session) {
    clearTimeout(s.closeTimer);
    s.closeTimer = setTimeout(() => void this.finish(s), Math.max(0, Date.parse(s.info.closing!.until) - Date.now()));
  }

  /** Ends a closed session if it is live, then forgets it, with its saved chat if it is to be deleted, and tells its subscribers. */
  private finish(s: Session): Promise<void> {
    s.finishing ??= (async () => {
      clearTimeout(s.closeTimer);
      const { id } = s.info;
      await this.end(id, "user");
      await s.saving;
      for (const sub of s.subscribers) sub.gone();
      s.subscribers.clear();
      this.sessions.delete(id);
      this.widgets?.closed(id);
      if (s.info.closing?.delete) await this.deleteSaved(id).catch(() => {});
      this.emit("changed");
    })();
    return s.finishing;
  }

  /**
   * Takes back a session whose tab was closed while Claude finishes: it is open again, Claude still working. Resolves
   * whether it was; if it was too late, once the session is gone.
   */
  async keep(id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s?.info.closing) return false;
    if (s.finishing) {
      await s.finishing;
      return false;
    }
    clearTimeout(s.closeTimer);
    const { closing: _closing, ...info } = s.info;
    s.info = info;
    this.emit("changed");
    this.save(s);
    return true;
  }

  /**
   * Ends every live session in a sandbox; returns how many there were. With `sleep`, for a sandbox that is to run
   * again, they fall asleep instead (see `SessionInfo.asleep`), and continue once it runs.
   */
  async endSandbox(sandbox: string, reason: EndReason, { sleep = false }: { sleep?: boolean } = {}): Promise<number> {
    const live = [...this.sessions.values()].filter((s) => s.info.sandbox === sandbox && isLive(s.info));
    for (const s of live) s.sleeping = sleep;
    await Promise.all(live.map((s) => this.end(s.info.id, reason)));
    return live.length;
  }

  async endAll(reason: EndReason): Promise<void> {
    const all = [...this.sessions.values()];
    // One closed may be gone already, forgotten as it ended.
    await Promise.all(all.map((s) => this.end(s.info.id, reason).catch((err) => { if (!(err instanceof SessionNotFound)) throw err; })));
    // Closed sessions that ended are forgotten, and deleted if they were to be, before the server goes.
    await Promise.all(all.map((s) => s.finishing));
  }

  /**
   * Lets go of every live session and leaves its Claude working, for the next server to `reopen`: each is saved with
   * its run once let go of. Nothing more is reported of them.
   */
  async detachAll(): Promise<void> {
    const live = [...this.sessions.values()].filter((s) => isLive(s.info));
    await Promise.all(
      live.map(async (s) => {
        // Saved once let go of, with where its output was read to and the calls it leaves pending, as they end up.
        s.detached = true;
        clearTimeout(s.closeTimer);
        // A command can't be picked up by the next server, which only finds that it ran, as far as it had got.
        for (const shell of s.userShells.values()) shell.run.stop();
        await s.driver.detach();
        this.save(s);
      }),
    );
  }
}
