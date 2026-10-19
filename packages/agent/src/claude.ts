import type { ChildProcess } from "node:child_process";
import { eachLine } from "@bentomo/sandbox";
import type { AgentDriver, AgentEvent, AgentMessage, Exec, StartOptions } from "./driver.js";

/**
 * Claude Code in its own streaming mode: one JSON object per line on stdin and stdout, and the process stays alive
 * between turns. Permissions are bypassed because the sandbox is the boundary.
 */
export const CLAUDE_COMMAND = [
  // Checkpoints are what lets a prompt's file changes be undone; --replay-user-messages is how Claude says a prompt has one.
  "env CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1 claude -p",
  "--input-format stream-json --output-format stream-json",
  "--verbose --include-partial-messages --replay-user-messages --prompt-suggestions",
  "--permission-mode bypassPermissions",
].join(" ");

/** A model alias or id, checked before it goes into a shell command. */
const MODEL_ALIAS = /^[\w.\[\]-]+$/;

/** The shape of the ids Claude gives sessions; checked before one goes into a shell command. */
const SESSION_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/**
 * The command that starts Claude, continuing session `resume` (as a copy, with `fork`) when given. With `resumeAt`
 * (the id of one of that session's messages) the conversation is cut after that message.
 */
export function claudeCommand(resume?: string, fork?: boolean, resumeAt?: string, model?: string): string {
  if (model !== undefined && !MODEL_ALIAS.test(model)) throw new Error(`Not a model: ${model}`);
  const base = model ? `${CLAUDE_COMMAND} --model ${model}` : CLAUDE_COMMAND;
  if (resume === undefined) return base;
  if (!SESSION_ID.test(resume)) throw new Error(`Not a Claude session id: ${resume}`);
  if (resumeAt !== undefined && !SESSION_ID.test(resumeAt)) throw new Error(`Not a Claude message id: ${resumeAt}`);
  return `${base} --resume ${resume}${fork ? " --fork-session" : ""}${resumeAt ? ` --resume-session-at ${resumeAt}` : ""}`;
}

const STDERR_TAIL = 20;
const REQUEST_TIMEOUT_MS = 15_000;

export interface ClaudeDriverOptions {
  /** How long `stop()` waits after closing stdin before killing the SSH process, in ms. */
  graceMs?: number;
}

/** A stream-json message line for a user prompt, tagged with `uuid` when given. */
export function userMessage(text: string, uuid?: string): string {
  return JSON.stringify({ type: "user", ...(uuid ? { uuid } : {}), message: { role: "user", content: [{ type: "text", text }] } }) + "\n";
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
  private requests = 0;
  /** Control requests waiting for Claude's answer, by request id. */
  private pending = new Map<string, { resolve(): void; reject(err: Error): void }>();
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

  start({ sandbox, workdir, env, prompt, promptId, resume, fork, resumeAt, model }: StartOptions): void {
    if (this.child) throw new Error("This driver has already started.");
    const child = this.exec(sandbox, claudeCommand(resume, fork, resumeAt, model), env, { cwd: workdir });
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
      if (payload.type === "control_response" && this.answer(payload)) return;
      this.emit({ kind: "message", payload });
      // Signed out, Claude still answers each turn, with an error result rather than an exit.
      if (payload.type === "result" && payload.is_error === true && SIGNED_OUT.test(String(payload.result ?? ""))) {
        this.emit({ kind: "error", message: String(payload.result), hint: "Run `claude` once in the sandbox to sign in." });
      }
    });
    eachLine(child.stderr!, (line) => this.keepTail(line));

    this.exited = new Promise<void>((resolve) => {
      // Nothing answers a request once the process is gone.
      const abandon = () => {
        for (const p of this.pending.values()) p.reject(new Error("Claude exited."));
        this.pending.clear();
      };
      let failed = false;
      child.on("error", (err: NodeJS.ErrnoException) => {
        failed = true;
        const message = err.code === "ENOENT" ? "ssh not found on PATH." : `Couldn't start Claude: ${err.message}`;
        this.emit({ kind: "error", message });
        this.emit({ kind: "exit", code: 1, requested: this.requested });
        abandon();
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
        abandon();
        resolve();
      });
    });

    if (prompt !== undefined) this.send(prompt, promptId);
  }

  send(text: string, id?: string): void {
    this.child?.stdin?.write(userMessage(text, id));
  }

  /** Settles the request a `control_response` answers, if one of ours is waiting; false for any other. */
  private answer(msg: AgentMessage): boolean {
    const response = msg.response as { request_id?: unknown; subtype?: unknown; error?: unknown } | undefined;
    const id = typeof response?.request_id === "string" ? response.request_id : undefined;
    const waiting = id ? this.pending.get(id) : undefined;
    if (!id || !waiting) return false;
    this.pending.delete(id);
    if (response?.subtype === "error") waiting.reject(new Error(typeof response.error === "string" ? response.error : "Claude refused the request."));
    else waiting.resolve();
    return true;
  }

  rewindFiles(id: string): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin || this.child?.exitCode != null) return Promise.reject(new Error("Claude isn't running."));
    const request_id = `rewind-${++this.requests}`;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request_id);
        reject(new Error("Claude didn't answer."));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(request_id, {
        resolve: () => (clearTimeout(timer), resolve()),
        reject: (err) => (clearTimeout(timer), reject(err)),
      });
      stdin.write(JSON.stringify({ type: "control_request", request_id, request: { subtype: "rewind_files", user_message_id: id } }) + "\n");
    });
  }

  interrupt(): void {
    const request = { type: "control_request", request_id: `interrupt-${++this.requests}`, request: { subtype: "interrupt" } };
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
