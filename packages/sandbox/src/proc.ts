import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { Readable } from "node:stream";
import { ProviderError, type Log } from "./provider.js";

const TAIL_LINES = 15;

/** Calls `onLine` for every complete line on the stream; a trailing partial line is flushed at the end. */
export function eachLine(stream: Readable, onLine: (line: string) => void): void {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.search(/\r?\n|\r/)) >= 0) {
      const sep = buf[i] === "\r" && buf[i + 1] === "\n" ? 2 : 1;
      onLine(buf.slice(0, i));
      buf = buf.slice(i + sep);
    }
  });
  stream.on("end", () => {
    if (buf) onLine(buf);
    buf = "";
  });
}

/** limactl logs as logfmt (`time=… level=info msg="…"`); show just the message, prefixed by level when it matters. */
export function tidyLimaLine(line: string): { text: string; kind?: "err" } {
  const m = /^time="[^"]*"\s+level=(\w+)\s+msg="((?:[^"\\]|\\.)*)"(.*)$/.exec(line);
  if (!m) return { text: line };
  const [, level, rawMsg, rest] = m;
  const msg = rawMsg.replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c));
  const extra = rest.trim();
  const text = extra ? `${msg} ${extra}` : msg;
  if (level === "error" || level === "fatal") return { text: `error: ${text}`, kind: "err" };
  if (level === "warning") return { text: `warning: ${text}` };
  return { text };
}

export interface RunResult {
  code: number;
  stdout: string;
  tail: string[];
}

export interface RunOptions extends SpawnOptions {
  /** Stream stdout and stderr lines here. */
  log?: Log;
  /** Collect stdout instead of logging it (for JSON output). */
  captureStdout?: boolean;
  /** Format lines as limactl's logfmt. */
  lima?: boolean;
}

/** Runs a command, line-buffering its output into `log`. Resolves with the exit code; never rejects on non-zero. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const { log, captureStdout, lima, ...spawnOpts } = opts;
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { ...spawnOpts, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(err);
      return;
    }
    const tail: string[] = [];
    let stdout = "";
    const onLine = (line: string) => {
      const { text, kind } = lima ? tidyLimaLine(line) : { text: line, kind: undefined };
      tail.push(text);
      if (tail.length > TAIL_LINES) tail.shift();
      log?.(text, kind);
    };
    if (captureStdout) {
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (c: string) => (stdout += c));
    } else {
      eachLine(child.stdout!, onLine);
    }
    eachLine(child.stderr!, onLine);
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") reject(new ProviderError(`${cmd} not found on PATH. Is it installed?`));
      else reject(err);
    });
    child.on("close", (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), stdout, tail }));
  });
}

/** Like `run`, but rejects with the output tail when the command fails. */
export async function runOk(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const res = await run(cmd, args, opts);
  if (res.code !== 0) {
    const tail = res.tail.length ? `\n${res.tail.join("\n")}` : "";
    throw new ProviderError(`${cmd} ${args[0] ?? ""} exited with code ${res.code}${tail}`, res.code);
  }
  return res;
}

/** Waits for a child process to exit and returns its exit code. */
export function exitCode(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}
