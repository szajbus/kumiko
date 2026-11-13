import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PendingAsk, PendingCall } from "@kumiko/agent";
import { SESSION_ID_PATTERN, type SessionEvent, type SessionInfo } from "@kumiko/shared";

export function defaultSessionsDir(): string {
  return join(process.env.KUMIKO_HOME ?? join(homedir(), ".kumiko"), "sessions");
}

/**
 * The agent process a session had when it was saved, in the sandbox. `offset` is how much of the run's output the saved
 * chat covers; `live` until its agent has exited or is known to be gone, so the next server can attach to it again.
 */
export interface StoredRun {
  id: string;
  offset: number;
  live: boolean;
  /** Calls to Kumiko's tools Claude was waiting on, for the next server to answer. */
  pending?: PendingCall[];
  /** What Claude asked the user that it is still waiting on, for the next server to take over. */
  asks?: PendingAsk[];
}

/** What is kept of a session: its info and the chat, which is all that is shown again when it is resumed. */
export interface StoredSession {
  info: SessionInfo;
  events: SessionEvent[];
  run?: StoredRun;
}

/** One JSON file per session that has talked to Claude. Claude's own transcript stays in the sandbox. */
export class SessionStore {
  constructor(readonly dir: string = defaultSessionsDir()) {}

  /** Ids come from URLs, where %2F decodes to "/", so only Kumiko's own id shape may name a file. */
  private file(id: string): string {
    if (!SESSION_ID_PATTERN.test(id)) throw new Error(`Not a session id: ${id}`);
    return join(this.dir, `${id}.json`);
  }

  async read(id: string): Promise<StoredSession | undefined> {
    if (!SESSION_ID_PATTERN.test(id)) return undefined;
    try {
      const stored = JSON.parse(await readFile(this.file(id), "utf8")) as StoredSession;
      return stored?.info?.id === id && Array.isArray(stored.events) ? stored : undefined;
    } catch {
      return undefined;
    }
  }

  async readAll(): Promise<StoredSession[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return [];
    }
    const all = await Promise.all(files.filter((f) => f.endsWith(".json")).map((f) => this.read(f.slice(0, -".json".length))));
    return all.filter((s): s is StoredSession => Boolean(s));
  }

  async write(stored: StoredSession): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.file(stored.info.id)}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(stored) + "\n");
    await rename(tmp, this.file(stored.info.id));
  }

  /** How big the session's file is; 0 when it hasn't been saved. */
  async size(id: string): Promise<number> {
    if (!SESSION_ID_PATTERN.test(id)) return 0;
    return stat(this.file(id)).then((s) => s.size, () => 0);
  }

  async remove(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
  }
}

/**
 * Claude's messages about compacting its conversation: one starting, how it ended, and where it did. Claude also sends
 * `status` for much else, which isn't kept.
 */
const isCompaction = (m: Record<string, unknown>) => m.subtype === "compact_boundary" || (m.subtype === "status" && (m.status === "compacting" || m.compact_result !== undefined));

/**
 * The events worth keeping: the chat. Deltas, init and the like are dropped, and a resumed chat looks the same. Of
 * Claude's system messages, compactions stay, and of its task events, those that say a subagent started and how it
 * ended: without them a resumed chat can't tell whether one in the background finished. The deltas of the messages in
 * `unfinished` are kept: in a turn still going, they are all there is of those messages yet.
 * Kinds this build doesn't know are kept: a newer Kumiko saved them, and saving the session again mustn't lose them.
 */
export function chatEvents(events: SessionEvent[], unfinished?: ReadonlySet<string>): SessionEvent[] {
  return events.filter((e) => {
    if (e.kind === "error" || e.kind === "ended") return false;
    if (e.kind !== "claude") return true;
    if (e.payload.type === "stream_event") return Boolean(unfinished?.has(String(e.payload.api_message_id)));
    if (e.payload.type === "system") return e.payload.subtype === "task_started" || e.payload.subtype === "task_notification" || isCompaction(e.payload);
    return e.payload.type === "assistant" || e.payload.type === "user" || e.payload.type === "result";
  });
}
