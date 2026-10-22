import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { applyWindowOp, chatWindow, compactWindow, LIVE_SESSION_STATUSES, windowState, type Attachment, type EndReason, type ResumableSession, type RewindRequest, type SessionEvent, type SessionInfo, type WindowOp, type WindowState } from "@kumiko/shared";
import { TOOL_TIMEOUT_MS, type AgentDriver, type AgentFile, type AgentMessage, type StartOptions, type ToolHost } from "@kumiko/agent";
import { chatEvents, type SessionStore, type StoredSession } from "./store.js";
import { trimMessage } from "./trim.js";

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
  /** The model named by the latest /model sent; Claude confirms it in words only, not with an id. */
  pendingModel?: string;
  exited: Promise<void>;
  /** Saves to the store run one after another, so an older state never lands over a newer one. */
  saving: Promise<void>;
  /** Let go of by `detachAll`: Claude carries on without this server, which reports nothing more of it. */
  detached?: boolean;
  /** The session's window, as its `window` events leave it. */
  window: WindowState;
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

type ChainEntry = Extract<SessionEvent, { kind: "claude" }> & { payload: { uuid: string } };

/** One of the messages Claude keeps its history in, as opposed to deltas, system notes and subagents' chatter. */
const isChainEntry = (e: SessionEvent): e is ChainEntry =>
  e.kind === "claude" && (e.payload.type === "assistant" || e.payload.type === "user") && !e.payload.parent_tool_use_id && typeof e.payload.uuid === "string";

const isLive = (s: SessionInfo) => LIVE_SESSION_STATUSES.includes(s.status);

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
 * Agent sessions, kept in memory: one driver per session and a buffer of everything it said, so a tab that opens
 * or reconnects can replay it. Sessions that end stay listed until they are removed, so their tab keeps the transcript.
 * Emits `changed` whenever a session starts, changes status or goes away.
 */
export class Sessions extends EventEmitter<{ changed: [] }> {
  private sessions = new Map<string, Session>();

  constructor(
    private readonly makeDriver: () => AgentDriver,
    private readonly store?: SessionStore,
    private readonly widgets?: SessionWidgets,
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
  start(opts: { sandbox: string; workdir: string; env: string[]; prompt: string; attachments?: Attachment[]; files?: AgentFile[]; model?: string }): SessionInfo {
    const { attachments = [] } = opts;
    // A prompt that is only files is named after them.
    const prompt = opts.prompt || attachments.map((a) => a.name).join(", ");
    const info: SessionInfo = { id: this.newId(), sandbox: opts.sandbox, workdir: opts.workdir, status: "starting", prompt, model: opts.model, startedAt: new Date().toISOString() };
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
    const { endedAt: _endedAt, updatedAt: _updatedAt, unread: _unread, ...rest } = saved;
    const info: SessionInfo = { ...rest, status: "idle" };
    return this.launch(info, stored.events, { sandbox: info.sandbox, workdir: info.workdir, env, ...continuing(saved) });
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
    driver.attach({ sandbox: info.sandbox, run: run.id, offset: run.offset, tools: this.widgets?.tools(s.info).tools, pending: run.pending });
    this.emit("changed");
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
        resumeAt = kept.payload.uuid;
      }
    }
    const info: SessionInfo = { id: this.newId(), sandbox, workdir, prompt, model, status: "idle", startedAt: new Date().toISOString() };
    const seed = this.widgets ? this.widgets.forked(from.info, info, chatEvents(events)) : chatEvents(events);
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
    const at = from.events.findIndex((e) => e.kind === "user_prompt" && e.payload.id === promptId);
    const prompt = from.events[at];
    if (prompt?.kind !== "user_prompt") throw new RewindRefused("That message can't be rewound to.");
    // Claude cuts its history after one of its own messages: the last it logged before this prompt, if any.
    const before = from.events.slice(0, at);
    const kept = before.findLast(isChainEntry);
    if (kept && !from.info.claudeSessionId) throw new RewindRefused("Claude hasn't started this session yet.");

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
    for (const ev of chatEvents(before)) this.push(from, ev);

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

  /** Saved sessions that aren't open, most recently used first. */
  async resumable(): Promise<ResumableSession[]> {
    const saved = await this.store?.readAll();
    return (saved ?? [])
      .map((s) => s.info)
      .filter((i): i is ResumableSession => Boolean(i.claudeSessionId) && !this.sessions.has(i.id))
      .map((i) => ({ ...i, status: "ended" as const }))
      .sort((a, b) => (b.updatedAt ?? b.startedAt).localeCompare(a.updatedAt ?? a.startedAt));
  }

  /** Deletes a saved session for good. An open one can't be: close its tab first. */
  async deleteSaved(id: string): Promise<boolean> {
    if (this.sessions.has(id)) throw new SessionNotResumable("This session is open; close its tab first.");
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

  private newId(): string {
    let id: string;
    do id = randomBytes(6).toString("hex");
    while (this.sessions.has(id));
    return id;
  }

  /** A session with `seed` in a new buffer, not yet listed and with no driver. */
  private newSession(info: SessionInfo, seed: NewEvent[]): Session {
    const s: Session = { info, driver: undefined!, events: [], bytes: 0, seq: 0, buffer: randomBytes(6).toString("hex"), subscribers: new Set(), blocks: new Map(), exited: Promise.resolve(), saving: Promise.resolve(), window: chatWindow() };
    for (const ev of seed) this.push(s, ev);
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

  /** Starts a Claude process for the session, in a run of its own. */
  private startDriver(s: Session, driverOpts: StartOptions) {
    const driver = this.makeDriver();
    this.wire(s, driver);
    const widgets = this.widgets?.tools(s.info);
    const { toolsOutdated: _outdated, ...info } = s.info;
    s.info = { ...info, toolsVersion: toolsVersion(this.widgets) };
    driver.start({ ...driverOpts, run: `${s.info.id}-${randomBytes(4).toString("hex")}`, ...widgets });
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
          this.push(s, { kind: "claude", payload: ev.payload });
          this.onMessage(s, ev.payload);
          this.widgets?.message(s.info, ev.payload);
          break;
        case "error":
          this.push(s, { kind: "error", payload: { message: ev.message, hint: ev.hint, stderr: ev.stderr, ...(ev.signedOut ? { signedOut: true } : {}) } });
          break;
        case "exit": {
          const reason = s.ending ?? "exit";
          const failed = !s.ending && (ev.code !== 0 || s.info.status === "starting");
          // A session that stopped by itself needs the user to look; one they ended doesn't.
          const unread = s.ending ? s.info.unread : true;
          this.setInfo(s, { status: failed ? "failed" : "ended", endedAt: new Date().toISOString(), bufferBytes: s.bytes, unread });
          this.push(s, { kind: "ended", payload: { reason, code: ev.code } });
          this.save(s);
          resolveExit();
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
    const { endedAt: _endedAt, ...rest } = s.info;
    // A fresh start gets a new Claude id from its first init; until then there is nothing to fork or resume.
    s.info = { ...rest, status: "idle", unread: keepUnread ? s.info.unread : false, ...(resume ? {} : { claudeSessionId: undefined, resumeAt: undefined }) };
    s.ending = undefined;
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
    const stored: StoredSession = {
      info: { ...s.info, updatedAt: new Date().toISOString() },
      events: chatEvents(s.events, live ? unfinished : undefined),
      ...(at ? { run: { id: at.run, offset: at.offset, live, ...(live && s.driver.pendingCalls().length ? { pending: s.driver.pendingCalls() } : {}) } } : {}),
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

    if (m.type === "system" && m.subtype === "init") {
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
    } else if (m.type === "system" && m.subtype === "session_title_changed") {
      // /rename; saved with the turn's result that follows.
      if (typeof m.title === "string" && m.title.trim()) this.setInfo(s, { title: m.title.trim() });
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
      const switched = s.pendingModel && typeof m.result === "string" && m.result.startsWith("Set model to");
      // Claude is done and waits for the user, until they look.
      this.setInfo(s, { status: "idle", bufferBytes: s.bytes, unread: true, ...(switched ? { model: s.pendingModel } : {}) });
      this.save(s);
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

  /** Sends a prompt; `attachments` are what the session records of `files`, which Claude gets. */
  prompt(id: string, text: string, attachments: Attachment[] = [], files: AgentFile[] = []): void {
    const s = this.live(id);
    const promptId = randomUUID();
    this.push(s, { kind: "user_prompt", payload: { text, id: promptId, ...(attachments.length ? { attachments } : {}) } });
    s.pendingModel = /^\/model\s+(\S+)/.exec(text)?.[1];
    s.driver.send(text, promptId, files);
    if (s.info.status === "idle") this.setInfo(s, { status: "running" });
    // Kumiko's own record of the prompt is nowhere in Claude's output, so it is saved now.
    this.save(s);
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

  /** The user has looked at the session: it no longer waits on them. */
  markSeen(id: string): void {
    const s = this.sessions.get(id);
    if (!s) throw new SessionNotFound(`No session ${id}.`);
    if (s.info.unread) this.setInfo(s, { unread: false });
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

  /** Ends a session if it is live, then forgets it and tells its subscribers. */
  async remove(id: string): Promise<void> {
    await this.end(id, "user");
    const s = this.sessions.get(id);
    if (!s) return;
    await s.saving;
    for (const sub of s.subscribers) sub.gone();
    s.subscribers.clear();
    this.sessions.delete(id);
    this.widgets?.closed(id);
    this.emit("changed");
  }

  /** Ends every live session in a sandbox; returns how many there were. */
  async endSandbox(sandbox: string, reason: EndReason): Promise<number> {
    const ids = [...this.sessions.values()].filter((s) => s.info.sandbox === sandbox && isLive(s.info)).map((s) => s.info.id);
    await Promise.all(ids.map((id) => this.end(id, reason)));
    return ids.length;
  }

  async endAll(reason: EndReason): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.end(id, reason)));
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
        await s.driver.detach();
        this.save(s);
      }),
    );
  }
}
