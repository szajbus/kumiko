import type { ChildProcess } from "node:child_process";
import { eachLine } from "@bentomo/sandbox";
import type { AgentDriver, AgentEvent, AgentMessage, Exec, StartOptions } from "./driver.js";

/**
 * Claude Code in its own streaming mode: one JSON object per line on stdin and stdout, and the process stays alive
 * between turns. Permissions are bypassed because the sandbox is the boundary.
 */
export const CLAUDE_COMMAND = [
  "claude -p",
  "--input-format stream-json --output-format stream-json",
  "--verbose --include-partial-messages",
  "--permission-mode bypassPermissions",
].join(" ");

/** The shape of the ids Claude gives sessions; checked before one goes into a shell command. */
const SESSION_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** The command that starts Claude, continuing session `resume` (as a copy, with `fork`) when given. */
export function claudeCommand(resume?: string, fork?: boolean): string {
  if (resume === undefined) return CLAUDE_COMMAND;
  if (!SESSION_ID.test(resume)) throw new Error(`Not a Claude session id: ${resume}`);
  return `${CLAUDE_COMMAND} --resume ${resume}${fork ? " --fork-session" : ""}`;
}

const STDERR_TAIL = 20;

export interface ClaudeDriverOptions {
  /** How long `stop()` waits after closing stdin before killing the SSH process, in ms. */
  graceMs?: number;
}

/** A stream-json message line for a user prompt. */
export function userMessage(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n";
}

/** Claude's result text when it isn't signed in, e.g. "Invalid API key · Please run /login". */
const SIGNED_OUT = /\/login|not logged in|invalid api key|oauth token|authentication/i;

/** A hint for why the process ended, from its exit code and stderr. */
export function exitHint(code: number, stderr: string[]): string | undefined {
  const text = stderr.join("\n");
  if (code === 127 || /claude: (command )?not found/.test(text)) {
    return "Claude Code isn't installed in this sandbox. Stop and start the sandbox to reinstall it.";
  }
  if (SIGNED_OUT.test(text)) return "Run `claude` once in the sandbox to sign in.";
  if (code === 255) return "Couldn't reach the sandbox over SSH. Is it still running?";
  return undefined;
}

export class ClaudeDriver implements AgentDriver {
  private child?: ChildProcess;
  private listeners = new Set<(ev: AgentEvent) => void>();
  private stderr: string[] = [];
  private requested = false;
  private exited?: Promise<void>;
  private interrupts = 0;
  private readonly graceMs: number;

  constructor(private readonly exec: Exec, opts: ClaudeDriverOptions = {}) {
    this.graceMs = opts.graceMs ?? 5000;
  }

  onEvent(listener: (ev: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(ev: AgentEvent) {
    for (const l of this.listeners) l(ev);
  }

  private keepTail(line: string) {
    this.stderr.push(line);
    if (this.stderr.length > STDERR_TAIL) this.stderr.shift();
  }

  start({ sandbox, workdir, env, prompt, resume, fork }: StartOptions): void {
    if (this.child) throw new Error("This driver has already started.");
    const child = this.exec(sandbox, claudeCommand(resume, fork), env, { cwd: workdir });
    this.child = child;
    // Writes after the process is gone fail with EPIPE; the exit event already says what happened.
    child.stdin!.on("error", () => {});

    eachLine(child.stdout!, (line) => {
      if (!line.trim()) return;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        this.keepTail(line);
        return;
      }
      if (!msg || typeof msg !== "object" || typeof (msg as { type?: unknown }).type !== "string") return;
      const payload = msg as AgentMessage;
      this.emit({ kind: "message", payload });
      // Signed out, Claude still answers each turn, with an error result rather than an exit.
      if (payload.type === "result" && payload.is_error === true && SIGNED_OUT.test(String(payload.result ?? ""))) {
        this.emit({ kind: "error", message: String(payload.result), hint: "Run `claude` once in the sandbox to sign in." });
      }
    });
    eachLine(child.stderr!, (line) => this.keepTail(line));

    this.exited = new Promise<void>((resolve) => {
      let failed = false;
      child.on("error", (err: NodeJS.ErrnoException) => {
        failed = true;
        const message = err.code === "ENOENT" ? "ssh not found on PATH." : `Couldn't start Claude: ${err.message}`;
        this.emit({ kind: "error", message });
        this.emit({ kind: "exit", code: 1, requested: this.requested });
        resolve();
      });
      child.on("close", (code, signal) => {
        if (failed) return;
        const exitCode = code ?? (signal ? 128 : 1);
        if (!this.requested) {
          const tail = [...this.stderr];
          const message = exitCode === 0 ? "Claude exited." : `Claude exited with code ${exitCode}.`;
          this.emit({ kind: "error", message, hint: exitHint(exitCode, tail), stderr: tail.length ? tail : undefined });
        }
        this.emit({ kind: "exit", code: exitCode, requested: this.requested });
        resolve();
      });
    });

    if (prompt !== undefined) this.send(prompt);
  }

  send(text: string): void {
    this.child?.stdin?.write(userMessage(text));
  }

  interrupt(): void {
    const request = { type: "control_request", request_id: `interrupt-${++this.interrupts}`, request: { subtype: "interrupt" } };
    this.child?.stdin?.write(JSON.stringify(request) + "\n");
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child || !this.exited) return;
    if (child.exitCode !== null || child.signalCode !== null) return this.exited;
    this.requested = true;
    child.stdin?.end();
    const term = setTimeout(() => child.kill("SIGTERM"), this.graceMs);
    const kill = setTimeout(() => child.kill("SIGKILL"), this.graceMs + 2000);
    try {
      await this.exited;
    } finally {
      clearTimeout(term);
      clearTimeout(kill);
    }
  }
}
