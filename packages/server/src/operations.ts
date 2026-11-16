import { EventEmitter } from "node:events";
import { vmName, type LineKind, type LogLine, type OpKind, type Operation, type SandboxInfo, type VmView, type ServerEvent } from "@kumiko/shared";
import type { Log } from "@kumiko/sandbox";

const MAX_LOG_LINES = 5000;

interface Entry {
  operation: Operation;
  log: LogLine[];
}

export class BusyError extends Error {
  constructor(readonly sandbox: string, readonly op: OpKind) {
    super(`${vmName(sandbox)} is busy ${op}. Try again once it's done.`);
  }
}

/**
 * The current or last operation per sandbox and its log lines, kept in memory.
 * One operation per sandbox at a time. Emits a ServerEvent for every change.
 */
export class Operations extends EventEmitter<{ event: [ServerEvent]; settled: [string] }> {
  private entries = new Map<string, Entry>();

  get(name: string): Operation | undefined {
    return this.entries.get(name)?.operation;
  }

  logs(): Record<string, LogLine[]> {
    return Object.fromEntries([...this.entries].map(([name, e]) => [name, e.log]));
  }

  /** Resolves with the operation running for `name` once it has ended; at once, with undefined, if none is running. */
  settled(name: string): Promise<Operation | undefined> {
    const cur = this.get(name);
    if (!cur || cur.endedAt) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const on = (n: string) => {
        if (n !== name) return;
        this.off("settled", on);
        resolve(this.get(name));
      };
      this.on("settled", on);
    });
  }

  /** Sandboxes with an operation running right now. */
  active(): string[] {
    return [...this.entries].filter(([, e]) => !e.operation.endedAt).map(([name]) => name);
  }

  /**
   * Starts `work` as the operation for `name` and returns at once.
   * Throws BusyError if another operation is still running for it.
   */
  start(name: string, op: OpKind, work: (log: Log) => Promise<void>): Operation {
    const cur = this.get(name);
    if (cur && !cur.endedAt) throw new BusyError(name, cur.op);

    const entry: Entry = { operation: { op, startedAt: new Date().toISOString() }, log: [] };
    this.entries.set(name, entry);
    this.emit("event", { sandbox: name, op, type: "state", data: entry.operation });

    const log: Log = (text: string, kind?: LineKind) => {
      const line: LogLine = kind ? { text, kind } : { text };
      entry.log.push(line);
      if (entry.log.length > MAX_LOG_LINES) entry.log.splice(0, entry.log.length - MAX_LOG_LINES);
      this.emit("event", { sandbox: name, op, type: "log", data: line });
    };

    work(log).then(
      () => {
        entry.operation = { ...entry.operation, endedAt: new Date().toISOString(), result: "ok" };
        this.emit("event", { sandbox: name, op, type: "done", data: entry.operation });
        this.emit("settled", name);
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        const first = message.split("\n")[0];
        // Provider errors end with the tool's output tail; it is already in the log, so add only the summary.
        if (!entry.log.some((l) => l.text === first)) log(first, "err");
        entry.operation = { ...entry.operation, endedAt: new Date().toISOString(), result: "error", error: message };
        this.emit("event", { sandbox: name, op, type: "error", data: entry.operation });
        this.emit("settled", name);
      },
    );
    return entry.operation;
  }

  /**
   * Merges the provider's list with operations and live session counts.
   * Sandboxes being created show before Lima knows them.
   */
  views(infos: SandboxInfo[], sessions: Map<string, number> = new Map()): VmView[] {
    const views: VmView[] = infos.map((i) => this.view(i, sessions));
    for (const name of this.active()) {
      if (!infos.some((i) => i.name === name)) views.push(this.view({ name, status: "unknown" }, sessions));
    }
    return views.sort((a, b) => a.name.localeCompare(b.name));
  }

  private view(info: SandboxInfo, sessions: Map<string, number>): VmView {
    const operation = this.get(info.name);
    return { ...info, vm: vmName(info.name), provider: "lima", operation, busy: Boolean(operation && !operation.endedAt), sessions: sessions.get(info.name) ?? 0 };
  }
}
