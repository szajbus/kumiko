import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { SESSION_ID_PATTERN, type SessionEvent, type SessionInfo } from "@kumiko/shared";

export function defaultSessionsDir(): string {
  return join(process.env.KUMIKO_HOME ?? join(homedir(), ".kumiko"), "sessions");
}

/** What is kept of a session: its info and the chat, which is all that is shown again when it is resumed. */
export interface StoredSession {
  info: SessionInfo;
  events: SessionEvent[];
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

  async remove(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
  }
}

/** The events worth keeping: the chat. Deltas, init and the like are dropped, and a resumed chat looks the same. */
export function chatEvents(events: SessionEvent[]): SessionEvent[] {
  return events.filter((e) => {
    if (e.kind === "user_prompt" || e.kind === "interrupt") return true;
    if (e.kind !== "claude") return false;
    return e.payload.type === "assistant" || e.payload.type === "user" || e.payload.type === "result";
  });
}
