import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { LIVE_SESSION_STATUSES, type EndReason, type SessionEvent, type SessionInfo } from "@bentomo/shared";
import type { AgentDriver, AgentMessage } from "@bentomo/agent";

/** A SessionEvent before it has its place in the buffer. */
type WithoutSeq<E> = E extends unknown ? Omit<E, "seq"> : never;
type NewEvent = WithoutSeq<SessionEvent>;

export interface Subscriber {
  event(ev: SessionEvent): void;
  /** The session was removed; nothing more will come. */
  gone(): void;
}

interface Session {
  info: SessionInfo;
  driver: AgentDriver;
  events: SessionEvent[];
  seq: number;
  subscribers: Set<Subscriber>;
  /** Content blocks started (by stream events) and finished (by `assistant` messages), per message id. */
  blocks: Map<string, { started: number; finished: number }>;
  /** Set by `end`, so the exit that follows is recorded with the right reason. */
  ending?: EndReason;
  exited: Promise<void>;
}

export class SessionNotFound extends Error {}
export class SessionEnded extends Error {}

const isLive = (s: SessionInfo) => LIVE_SESSION_STATUSES.includes(s.status);

/**
 * Agent sessions, kept in memory: one driver per session and a buffer of everything it said, so a tab that opens
 * or reconnects can replay it. Sessions that end stay listed until they are removed, so their tab keeps the transcript.
 * Emits `changed` whenever a session starts, changes status or goes away.
 */
export class Sessions extends EventEmitter<{ changed: [] }> {
  private sessions = new Map<string, Session>();

  constructor(private readonly makeDriver: () => AgentDriver) {
    super();
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info);
  }

  get(id: string): SessionInfo | undefined {
    return this.sessions.get(id)?.info;
  }

  /** How many sessions are live in each sandbox. */
  liveCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const { info } of this.sessions.values()) if (isLive(info)) counts.set(info.sandbox, (counts.get(info.sandbox) ?? 0) + 1);
    return counts;
  }

  start(opts: { sandbox: string; workdir: string; env: string[]; prompt: string }): SessionInfo {
    let id: string;
    do id = randomBytes(6).toString("hex");
    while (this.sessions.has(id));
    const driver = this.makeDriver();
    const info: SessionInfo = { id, sandbox: opts.sandbox, workdir: opts.workdir, status: "starting", prompt: opts.prompt, startedAt: new Date().toISOString() };
    let resolveExit!: () => void;
    const s: Session = { info, driver, events: [], seq: 0, subscribers: new Set(), blocks: new Map(), exited: new Promise((r) => (resolveExit = r)) };
    this.sessions.set(id, s);

    driver.onEvent((ev) => {
      switch (ev.kind) {
        case "message":
          this.push(s, { kind: "claude", payload: ev.payload });
          this.onMessage(s, ev.payload);
          break;
        case "error":
          this.push(s, { kind: "error", payload: { message: ev.message, hint: ev.hint, stderr: ev.stderr } });
          break;
        case "exit": {
          const reason = s.ending ?? "exit";
          const failed = !s.ending && (ev.code !== 0 || s.info.status === "starting");
          this.setInfo(s, { status: failed ? "failed" : "ended", endedAt: new Date().toISOString() });
          this.push(s, { kind: "ended", payload: { reason, code: ev.code } });
          resolveExit();
          break;
        }
      }
    });

    this.push(s, { kind: "user_prompt", payload: { text: opts.prompt } });
    driver.start({ sandbox: opts.sandbox, workdir: opts.workdir, env: opts.env, prompt: opts.prompt });
    this.emit("changed");
    return info;
  }

  private onMessage(s: Session, m: AgentMessage) {
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

    if (m.type === "system" && m.subtype === "init") {
      // Claude sends init at the start of every turn, so it also marks a queued prompt's turn starting.
      this.setInfo(s, {
        claudeSessionId: typeof m.session_id === "string" ? m.session_id : s.info.claudeSessionId,
        model: typeof m.model === "string" ? m.model : s.info.model,
        status: "running",
      });
    } else if (m.type === "assistant" && isLive(s.info)) {
      // /model shows up here first, as the model of the next real reply.
      const model = (m.message as { model?: unknown } | undefined)?.model;
      if (typeof model === "string" && !model.startsWith("<")) this.setInfo(s, { model });
    } else if (m.type === "result") {
      this.setInfo(s, { status: "idle" });
      // A finished message carries everything its deltas did, so drop them to keep long sessions small. Deltas of
      // a message cut short by Stop are all there is of it, so those stay.
      const done = new Set([...s.blocks].filter(([, c]) => c.finished >= c.started).map(([id]) => id));
      s.events = s.events.filter((e) => !(e.kind === "claude" && e.payload.type === "stream_event" && done.has(String(e.payload.api_message_id))));
      s.blocks.clear();
    }
  }

  private setInfo(s: Session, patch: Partial<SessionInfo>) {
    if (!isLive(s.info) && patch.status && LIVE_SESSION_STATUSES.includes(patch.status)) return;
    const next = { ...s.info, ...patch };
    if (JSON.stringify(next) === JSON.stringify(s.info)) return;
    s.info = next;
    this.emit("changed");
  }

  private push(s: Session, ev: NewEvent) {
    const full = { ...ev, seq: ++s.seq } as SessionEvent;
    s.events.push(full);
    for (const sub of s.subscribers) sub.event(full);
  }

  private live(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new SessionNotFound(`No session ${id}.`);
    if (!isLive(s.info)) throw new SessionEnded(`Session ${id} has ended.`);
    return s;
  }

  prompt(id: string, text: string): void {
    const s = this.live(id);
    this.push(s, { kind: "user_prompt", payload: { text } });
    s.driver.send(text);
    if (s.info.status === "idle") this.setInfo(s, { status: "running" });
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
    for (const sub of s.subscribers) sub.gone();
    s.subscribers.clear();
    this.sessions.delete(id);
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
}
