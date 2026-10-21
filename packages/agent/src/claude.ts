import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { eachLine } from "@kumiko/sandbox";
import type { AgentDriver, AgentEvent, AgentFile, AgentMessage, AttachOptions, Exec, RunPosition, StartOptions } from "./driver.js";
import { ATTACHED, attachCommand, closeInputCommand, execOutput, launchCommand, removeCommand, RUN_EXIT_TYPE, RUN_GONE, RUN_LOST, signalCommand, stderrCommand } from "./runs.js";

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
/** Waits between attempts to attach again after an attachment drops, in ms; the last repeats. */
const REATTACH_MS = [250, 500, 1000, 2000, 5000];
/** How long a stop or a detach waits for the sandbox before giving up on it, after the grace period, in ms. */
const GIVE_UP_MS = 4000;

export interface ClaudeDriverOptions {
  /** How long `stop()` waits after closing stdin before killing Claude, in ms. */
  graceMs?: number;
  /** Tags the runs this driver starts, as the Kumiko home's; see `Runs`. */
  owner?: string;
}

/** A file as a content block of its own, the way the API takes it: images and PDFs in base64, text as a titled document. */
export function fileBlock(file: AgentFile): Record<string, unknown> {
  if (file.mediaType.startsWith("image/")) return { type: "image", source: { type: "base64", media_type: file.mediaType, data: file.data.toString("base64") } };
  if (file.mediaType === "application/pdf") return { type: "document", title: file.name, source: { type: "base64", media_type: file.mediaType, data: file.data.toString("base64") } };
  return { type: "document", title: file.name, source: { type: "text", media_type: "text/plain", data: file.data.toString("utf8") } };
}

/** A stream-json message line for a user prompt, tagged with `uuid` when given. Files go before the text, as the API recommends. */
export function userMessage(text: string, uuid?: string, files: AgentFile[] = []): string {
  const content = [...files.map(fileBlock), ...(text ? [{ type: "text", text }] : [])];
  return JSON.stringify({ type: "user", ...(uuid ? { uuid } : {}), message: { role: "user", content } }) + "\n";
}

/** Claude's result text when it isn't signed in, e.g. "Invalid API key · Please run /login". */
export const SIGNED_OUT = /\/login|not logged in|invalid api key|oauth token|authentication/i;

const LOGIN_HINT = "Log in to continue.";

/** A hint for why the process ended, from its exit code and stderr. */
export function exitHint(code: number, stderr: string[]): string | undefined {
  const text = stderr.join("\n");
  if (code === 127 || /claude: (command )?not found/.test(text)) {
    return "Claude Code isn't installed in this sandbox. Stop and start the sandbox to reinstall it.";
  }
  if (SIGNED_OUT.test(text)) return LOGIN_HINT;
  if (code === 255) return "Couldn't reach the sandbox over SSH. Is it still running?";
  return undefined;
}

/**
 * Claude in a run of its own in the sandbox (see `runs.ts`), detached from the SSH connection, so it keeps working
 * when the server goes away. The driver attaches to it over SSH: what it writes goes to Claude's stdin, and Claude's
 * output comes back from the run's log, counted in bytes (`position()`) so another driver can carry on from there.
 * An attachment that drops is made again from where it got to.
 */
export class ClaudeDriver implements AgentDriver {
  private sandbox?: string;
  private run?: string;
  /** Bytes of the run's output reported so far: complete lines only. */
  private offset = 0;
  /** The SSH process attached to the run, if one is. */
  private child?: ChildProcess;
  /** Lines written while no attachment was up, sent once one is. */
  private outbox: string[] = [];
  private listeners = new Set<(ev: AgentEvent) => void>();
  /** Lines of Claude's stdout that weren't JSON, for the error when it exits. */
  private stderr: string[] = [];
  private requested = false;
  private detaching = false;
  /** Nothing more will be reported: Claude exited, or the driver detached. */
  private done = false;
  private exited?: Promise<void>;
  private resolveExited!: () => void;
  private retry?: NodeJS.Timeout;
  private attempts = 0;
  /** Deleting the run once Claude has exited; `stop()` waits for it. */
  private removed: Promise<void> = Promise.resolve();
  private requests = 0;
  /** Control requests waiting for Claude's answer, by request id. */
  private pending = new Map<string, { resolve(): void; reject(err: Error): void }>();
  private readonly graceMs: number;
  private readonly owner?: string;

  constructor(private readonly exec: Exec, opts: ClaudeDriverOptions = {}) {
    this.graceMs = opts.graceMs ?? 5000;
    this.owner = opts.owner;
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

  position(): RunPosition | undefined {
    return this.run ? { run: this.run, offset: this.offset } : undefined;
  }

  start({ sandbox, workdir, env, prompt, promptId, files, resume, fork, resumeAt, model, run }: StartOptions): void {
    if (this.sandbox) throw new Error("This driver has already started.");
    const runId = run ?? `run-${randomBytes(6).toString("hex")}`;
    const command = launchCommand(runId, claudeCommand(resume, fork, resumeAt, model), this.owner);
    this.begin(sandbox, runId, 0);
    this.connect(this.exec(sandbox, command, env, { cwd: workdir }), true);
    if (prompt !== undefined) this.send(prompt, promptId, files);
  }

  attach({ sandbox, run, offset }: AttachOptions): void {
    if (this.sandbox) throw new Error("This driver has already started.");
    const command = attachCommand(run, offset);
    this.begin(sandbox, run, offset);
    this.connect(this.exec(sandbox, command, []), false);
  }

  private begin(sandbox: string, run: string, offset: number) {
    this.sandbox = sandbox;
    this.run = run;
    this.offset = offset;
    this.exited = new Promise<void>((r) => (this.resolveExited = r));
  }

  /**
   * Follows one attachment. Until it says it is attached, a launch that fails is Claude failing to start; after that,
   * an attachment that ends without Claude's exit in the log has dropped, and another is made.
   */
  private connect(child: ChildProcess, launching: boolean) {
    this.child = child;
    // Writes after the process is gone fail with EPIPE; what happened shows in how it closes.
    child.stdin!.on("error", () => {});
    for (const line of this.outbox.splice(0)) child.stdin!.write(line);
    let attached = false;
    const sshErr: string[] = [];
    let buf: Buffer = Buffer.alloc(0);
    child.stdout!.on("data", (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      let i: number;
      while (this.child === child && !this.done && (i = buf.indexOf(10)) >= 0) {
        const line = buf.subarray(0, i).toString("utf8");
        buf = buf.subarray(i + 1);
        this.offset += i + 1;
        this.attempts = 0;
        this.line(line);
      }
    });
    eachLine(child.stderr!, (line) => {
      if (line === ATTACHED) attached = true;
      else if (line.trim()) sshErr.push(line);
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (this.child !== child) return;
      this.child = undefined;
      const message = err.code === "ENOENT" ? "ssh not found on PATH." : `Couldn't start Claude: ${err.message}`;
      void this.finish(1, { message });
    });
    child.on("close", (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      if (this.done) return;
      const exitCode = code ?? (signal ? 128 : 1);
      if (this.detaching) return this.settle();
      if (exitCode === RUN_GONE || exitCode === RUN_LOST) {
        return void this.finish(exitCode, { message: "Claude's process in the sandbox is gone; the sandbox may have restarted.", stderr: sshErr });
      }
      if (launching && !attached) {
        const tail = sshErr.slice(-STDERR_TAIL);
        return void this.finish(exitCode, { message: `Claude didn't start (exit ${exitCode}).`, hint: exitHint(exitCode, tail), stderr: tail });
      }
      this.reattach();
    });
  }

  /** Attaches again from where the last attachment got to, after a wait that grows with each failed attempt. */
  private reattach() {
    const delay = REATTACH_MS[Math.min(this.attempts++, REATTACH_MS.length - 1)];
    clearTimeout(this.retry);
    this.retry = setTimeout(() => {
      if (this.done || this.detaching || this.child) return;
      this.connect(this.exec(this.sandbox!, attachCommand(this.run!, this.offset), []), false);
    }, delay);
  }

  /** One line of Claude's output. */
  private line(line: string) {
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
    if (payload.type === RUN_EXIT_TYPE) {
      void this.finish(typeof payload.code === "number" ? payload.code : 1);
      return;
    }
    if (payload.type === "control_response" && this.answer(payload)) return;
    this.emit({ kind: "message", payload });
    // Signed out, Claude still answers each turn, with an error result rather than an exit.
    if (payload.type === "result" && payload.is_error === true && SIGNED_OUT.test(String(payload.result ?? ""))) {
      // The failed turn already shows Claude's own words ("Invalid API key · Please run /login").
      this.emit({ kind: "error", message: "Claude isn't logged in.", hint: LOGIN_HINT, signedOut: true });
    }
  }

  /**
   * Claude has exited (or can't be reached any more): says so, unless it was asked to, with the tail of its stderr, then
   * deletes its run. `failure` describes a failure that isn't Claude's own exit.
   */
  private async finish(code: number, failure?: { message: string; hint?: string; stderr?: string[] }) {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.retry);
    const sandbox = this.sandbox!;
    const run = this.run!;
    if (!this.requested) {
      if (failure) {
        const stderr = failure.stderr?.length ? failure.stderr : undefined;
        this.emit({ kind: "error", message: failure.message, hint: failure.hint, stderr });
      } else {
        const err = await execOutput(this.exec, sandbox, stderrCommand(run, STDERR_TAIL), 10_000).catch(() => "");
        const tail = [...err.split("\n").filter((l) => l.trim()), ...this.stderr].slice(-STDERR_TAIL);
        const message = code === 0 ? "Claude exited." : `Claude exited with code ${code}.`;
        const signedOut = SIGNED_OUT.test(tail.join("\n")) && code !== 127;
        this.emit({ kind: "error", message, hint: exitHint(code, tail), stderr: tail.length ? tail : undefined, ...(signedOut ? { signedOut } : {}) });
      }
    }
    this.emit({ kind: "exit", code, requested: this.requested });
    this.settle();
    // Nothing more will be read from the run: it goes, with the attachment still on it.
    this.removed = execOutput(this.exec, sandbox, removeCommand(run), 10_000).then(() => {}, () => {});
    this.child?.stdin?.end();
  }

  /** Nothing answers a request once the driver is done; `stop()` and `detach()` resolve. */
  private settle() {
    this.done = true;
    for (const p of this.pending.values()) p.reject(new Error(this.detaching ? "Detached from Claude." : "Claude exited."));
    this.pending.clear();
    this.resolveExited();
  }

  private write(line: string) {
    if (this.done) return;
    if (this.child) this.child.stdin!.write(line);
    else this.outbox.push(line);
  }

  send(text: string, id?: string, files?: AgentFile[]): void {
    this.write(userMessage(text, id, files));
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
    if (!this.sandbox || this.done || this.requested) return Promise.reject(new Error("Claude isn't running."));
    const request_id = `rewind-${++this.requests}`;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request_id);
        reject(new Error("Claude didn't answer in time. Try again."));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(request_id, {
        resolve: () => (clearTimeout(timer), resolve()),
        reject: (err) => (clearTimeout(timer), reject(err)),
      });
      this.write(JSON.stringify({ type: "control_request", request_id, request: { subtype: "rewind_files", user_message_id: id } }) + "\n");
    });
  }

  interrupt(): void {
    const request = { type: "control_request", request_id: `interrupt-${++this.requests}`, request: { subtype: "interrupt" } };
    this.write(JSON.stringify(request) + "\n");
  }

  /**
   * Closes Claude's stdin, so it exits once its turn is done, and follows its output until it has; after the grace
   * period it is sent SIGTERM, then SIGKILL. A sandbox that can't be reached is given up on.
   */
  async stop(): Promise<void> {
    if (!this.exited) return;
    if (this.done) return this.exited.then(() => this.removed);
    this.requested = true;
    const sandbox = this.sandbox!;
    const run = this.run!;
    const remote = (cmd: string) => execOutput(this.exec, sandbox, cmd, 5000).then(() => true, () => false);
    void remote(closeInputCommand(run)).then((ok) => {
      // Not attached and not reachable: there is nothing to wait for.
      if (!ok && !this.child) void this.finish(255);
    });
    const term = setTimeout(() => void remote(signalCommand(run, "TERM")), this.graceMs);
    const kill = setTimeout(() => void remote(signalCommand(run, "KILL")), this.graceMs + 2000);
    const giveUp = setTimeout(() => void this.finish(255), this.graceMs + 2000 + GIVE_UP_MS);
    try {
      await this.exited;
    } finally {
      clearTimeout(term);
      clearTimeout(kill);
      clearTimeout(giveUp);
    }
    await this.removed;
  }

  async detach(): Promise<void> {
    if (!this.exited || this.done) return this.exited;
    this.detaching = true;
    clearTimeout(this.retry);
    const child = this.child;
    if (!child) return this.settle();
    // EOF ends the attachment in the sandbox; Claude, holding its own input open, doesn't notice.
    child.stdin!.end();
    const kill = setTimeout(() => child.kill("SIGKILL"), GIVE_UP_MS);
    try {
      await this.exited;
    } finally {
      clearTimeout(kill);
    }
  }
}
