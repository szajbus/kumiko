import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { SandboxProvider } from "@kumiko/sandbox";
import type { ShellChunk } from "@kumiko/shared";

type Exec = SandboxProvider["exec"];

/** Where commands keep their process ids while they run, and their logs, in the sandbox's home. */
const DIR = `"$HOME"/.cache/kumiko/shell`;

/** Run ids name files in the sandbox, so they are only ever this. */
export const RUN_ID = /^[0-9a-f]{12}$/;

/** After Stop's interrupt, how long a command has to end before it is terminated, then killed. */
export const TERM_AFTER_MS = 3_000;
export const KILL_AFTER_MS = 10_000;

/**
 * The script that runs a command, read from its stdin, so that it can be stopped: `set -m` puts it in a process group
 * of its own, whose id is left in a file for `stop` (setsid would do too, but macOS, where the tests also run, has
 * none). It has no input, so one that asks for some reads end of file rather than waiting forever. Bash's own notices,
 * such as a job's being interrupted, aren't the command's output, so the script's own stderr is dropped.
 * Once the command ends, what it left running in its group is ended too, as closing a terminal would: it would hold
 * on to the output, and outlive Stop, since a job a script puts in the background ignores the interrupt.
 */
export function runScript(id: string): string {
  return [
    "exec 3>&2 2>/dev/null",
    "set -m",
    `mkdir -p ${DIR}`,
    'c=$(cat)',
    'bash -c "$c" </dev/null 2>&3 3>&- &',
    "p=$!",
    `echo "$p" > ${DIR}/${id}.pid`,
    'wait "$p"',
    "r=$?",
    'kill -TERM -- -"$p"',
    `rm -f ${DIR}/${id}.pid`,
    'exit "$r"',
  ].join("\n");
}

/** Sends `signal` to the process group of run `id`, if it is still running. */
export function signalScript(id: string, signal: "INT" | "TERM" | "KILL"): string {
  return `f=${DIR}/${id}.pid; [ -f "$f" ] && kill -${signal} -- -"$(cat "$f")"; true`;
}

/** Writes its stdin to run `id`'s log, and prints the log's path. */
export function logScript(id: string): string {
  return `mkdir -p ${DIR} && f=${DIR}/${id}.log && cat > "$f" && printf %s "$f"`;
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Terminal escapes (colours, cursor moves) that a program prints even without a terminal: they mean nothing here. */
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export const plain = (s: string) => s.replace(ESCAPES, "").replace(/\r\n/g, "\n");

/** One command the user runs, in a sandbox, until it ends or is stopped. */
export class UserShellRun {
  private readonly child: ChildProcess;
  private timers: NodeJS.Timeout[] = [];
  private ended = false;

  constructor(
    private readonly exec: Exec,
    private readonly sandbox: string,
    readonly id: string,
    command: string,
    env: string[],
    cwd: string,
    on: { chunk: (c: ShellChunk) => void; end: (r: { code?: number; error?: string }) => void },
  ) {
    const child = exec(sandbox, `bash -c ${quote(runScript(id))}`, env, { cwd });
    this.child = child;
    for (const stream of ["out", "err"] as const) {
      const decoder = new StringDecoder("utf8");
      const from = stream === "out" ? child.stdout : child.stderr;
      from?.on("data", (d: Buffer) => {
        const text = plain(decoder.write(d));
        if (text) on.chunk({ stream, text });
      });
    }
    let error: string | undefined;
    const finish = (code: number | null) => {
      if (this.ended) return;
      this.ended = true;
      for (const t of this.timers) clearTimeout(t);
      on.end(error ? { error } : { code: code ?? undefined });
    };
    child.on("error", (err) => {
      error = err.message;
      finish(null);
    });
    child.on("close", finish);
    // Something the command started outside its group may still hold the output open: once the command has exited,
    // what it printed by then is all there is, and the run is over.
    child.on("exit", (code) => {
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code);
      }, 500).unref();
    });
    child.stdin?.end(command);
  }

  /** Interrupts the command, as Ctrl+C would; terminates it if it is still running after a while, then kills it. */
  stop(): void {
    if (this.ended || this.timers.length) return;
    this.signal("INT");
    this.timers.push(
      setTimeout(() => this.signal("TERM"), TERM_AFTER_MS),
      setTimeout(() => {
        this.signal("KILL");
        // Gone with the sandbox, say: there is nothing more to wait for.
        setTimeout(() => this.child.kill("SIGKILL"), 2_000).unref();
      }, KILL_AFTER_MS),
    );
  }

  private signal(signal: "INT" | "TERM" | "KILL") {
    if (this.ended) return;
    const killer = this.exec(this.sandbox, `bash -c ${quote(signalScript(this.id, signal))}`, []);
    killer.on("error", () => {});
    killer.stdin?.end();
  }
}

/**
 * What the server keeps of a command's output as it runs, for the chat and for the log Claude can read: all of it, up
 * to `head` characters of its start and `tail` of its end. `cut` counts what was left out between.
 */
export class ShellOutput {
  private start: ShellChunk[] = [];
  private startLength = 0;
  private end: ShellChunk[] = [];
  private endLength = 0;
  cut = 0;

  constructor(
    private readonly head = 1024 * 1024,
    private readonly tail = 15 * 1024 * 1024,
  ) {}

  add(chunk: ShellChunk): void {
    let text = chunk.text;
    if (this.startLength < this.head) {
      const room = this.head - this.startLength;
      this.start.push({ stream: chunk.stream, text: text.slice(0, room) });
      this.startLength += Math.min(room, text.length);
      text = text.slice(room);
    }
    if (!text) return;
    this.end.push({ stream: chunk.stream, text });
    this.endLength += text.length;
    while (this.endLength > this.tail) {
      const first = this.end[0]!;
      const over = this.endLength - this.tail;
      if (first.text.length <= over) {
        this.end.shift();
        this.endLength -= first.text.length;
        this.cut += first.text.length;
      } else {
        this.end[0] = { stream: first.stream, text: first.text.slice(over) };
        this.endLength -= over;
        this.cut += over;
      }
    }
  }

  get length(): number {
    return this.startLength + this.endLength + this.cut;
  }

  /** What is kept, with a line saying what was left out between the start and the end, if anything was. */
  chunks(): ShellChunk[] {
    const gap: ShellChunk[] = this.cut ? [{ stream: "err", text: `\n[… ${this.cut.toLocaleString("en-US")} characters not kept]\n` }] : [];
    return [...this.start, ...gap, ...this.end];
  }
}

/** Writes `text` to run `id`'s log in the sandbox; resolves with the log's path, or undefined if it couldn't. */
export function writeLog(exec: Exec, sandbox: string, id: string, text: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = exec(sandbox, `bash -c ${quote(logScript(id))}`, []);
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(undefined);
    }, 30_000);
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => {});
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && out.startsWith("/") ? out : undefined);
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(text);
  });
}
