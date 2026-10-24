import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { eachLine, shellQuote } from "@kumiko/sandbox";
import type { AskAnswer } from "@kumiko/shared";
import { AskBridge, type PendingAsk } from "./asks.js";
import type { AgentDriver, AgentEvent, AgentFile, AgentMessage, AttachOptions, Exec, RunPosition, StartOptions, TaskOutput } from "./driver.js";
import { mcpConfig, ToolBridge, type PendingCall } from "./tools.js";
import { ATTACHED, attachCommand, closeInputCommand, execOutput, launchCommand, removeCommand, RUN_EXIT_TYPE, RUN_GONE, RUN_LOST, signalCommand, stderrCommand } from "./runs.js";

/**
 * Claude Code in its own streaming mode: one JSON object per line on stdin and stdout, and the process stays alive
 * between turns. Permissions are bypassed because the sandbox is the boundary; the permission prompts that remain, for
 * the tools that ask the user something, come to the driver over the same streams (see `AskBridge`).
 */
export const CLAUDE_COMMAND = [
  // Checkpoints are what lets a prompt's file changes be undone; --replay-user-messages is how Claude says a prompt has one.
  "env CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1 claude -p",
  "--input-format stream-json --output-format stream-json",
  "--verbose --include-partial-messages --replay-user-messages --prompt-suggestions",
  "--permission-mode bypassPermissions --permission-prompt-tool stdio",
].join(" ");

/** A model alias or id, checked before it goes into a shell command. */
const MODEL_ALIAS = /^[\w.\[\]-]+$/;

/** The shape of the ids Claude gives sessions; checked before one goes into a shell command. */
const SESSION_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/**
 * The command that starts Claude, continuing session `resume` (as a copy, with `fork`) when given. With `resumeAt`
 * (the id of one of that session's messages) the conversation is cut after that message. With `tools`, Claude reaches
 * the tools the driver hosts; `appendSystemPrompt` is added to its system prompt.
 */
export function claudeCommand(resume?: string, fork?: boolean, resumeAt?: string, model?: string, extra: { tools?: boolean; appendSystemPrompt?: string } = {}): string {
  if (model !== undefined && !MODEL_ALIAS.test(model)) throw new Error(`Not a model: ${model}`);
  let base = model ? `${CLAUDE_COMMAND} --model ${model}` : CLAUDE_COMMAND;
  if (extra.tools) base += ` --mcp-config ${shellQuote(mcpConfig())}`;
  if (extra.appendSystemPrompt) base += ` --append-system-prompt ${shellQuote(extra.appendSystemPrompt)}`;
  if (resume === undefined) return base;
  if (!SESSION_ID.test(resume)) throw new Error(`Not a Claude session id: ${resume}`);
  if (resumeAt !== undefined && !SESSION_ID.test(resumeAt)) throw new Error(`Not a Claude message id: ${resumeAt}`);
  return `${base} --resume ${resume}${fork ? " --fork-session" : ""}${resumeAt ? ` --resume-session-at ${resumeAt}` : ""}`;
}

const STDERR_TAIL = 20;
/**
 * What the ids of control requests about background tasks start with. Their answers are only for the driver that asked,
 * so one that comes after a detach is dropped rather than reported.
 */
const TASK_REQUEST = "task-";
const REQUEST_TIMEOUT_MS = 15_000;
/** Waits between attempts to attach again after an attachment drops, in ms; the last repeats. */
const REATTACH_MS = [250, 500, 1000, 2000, 5000];
/** How long a detach waits for calls under way to be answered before leaving them pending, in ms. */
const DRAIN_MS = 5000;
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
  /** Letting go: nothing more of Claude's output is read, so the position stands for the next driver. */
  private frozen = false;
  private exited?: Promise<void>;
  private resolveExited!: () => void;
  private retry?: NodeJS.Timeout;
  private attempts = 0;
  /** Deleting the run once Claude has exited; `stop()` waits for it. */
  private removed: Promise<void> = Promise.resolve();
  private requests = 0;
  /** Control requests waiting for Claude's answer, by request id. */
  private pending = new Map<string, { resolve(response: unknown): void; reject(err: Error): void }>();
  /** Answers Claude's calls to the caller's tools, if it was given any. */
  private tools?: ToolBridge;
  /** What Claude asks the user, mid-turn. */
  private readonly asks = new AskBridge((line) => this.write(line), (ev) => this.emit(ev));
  /** Whether Claude is in plan mode, as it last said; `mode` events are sent when it changes. */
  private plan?: boolean;
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

  start({ sandbox, workdir, env, prompt, promptId, files, resume, fork, resumeAt, model, run, tools, appendSystemPrompt }: StartOptions): void {
    if (this.sandbox) throw new Error("This driver has already started.");
    const runId = run ?? `run-${randomBytes(6).toString("hex")}`;
    const command = launchCommand(runId, claudeCommand(resume, fork, resumeAt, model, { tools: Boolean(tools), appendSystemPrompt }), this.owner);
    if (tools) this.tools = new ToolBridge(tools, (line) => this.write(line));
    this.begin(sandbox, runId, 0);
    this.connect(this.exec(sandbox, command, env, { cwd: workdir }), true);
    if (prompt !== undefined) this.send(prompt, promptId, files);
  }

  attach({ sandbox, run, offset, tools, pending, asks }: AttachOptions): void {
    if (this.sandbox) throw new Error("This driver has already started.");
    const command = attachCommand(run, offset);
    if (tools) this.tools = new ToolBridge(tools, (line) => this.write(line));
    this.begin(sandbox, run, offset);
    this.connect(this.exec(sandbox, command, []), false);
    if (pending?.length) this.tools?.rerun(pending);
    if (asks?.length) this.asks.adopt(asks);
  }

  pendingCalls(): PendingCall[] {
    return this.tools?.pending() ?? [];
  }

  pendingAsks(): PendingAsk[] {
    return this.asks.pending();
  }

  answer(id: string, answer: AskAnswer): void {
    if (!this.sandbox || this.done || this.frozen) throw new Error("Claude isn't running.");
    this.asks.answer(id, answer);
  }

  setPlanMode(plan: boolean): void {
    const request = { subtype: "set_permission_mode", mode: plan ? "plan" : "bypassPermissions" };
    this.write(JSON.stringify({ type: "control_request", request_id: `mode-${++this.requests}`, request }) + "\n");
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
      while (this.child === child && !this.done && !this.frozen && (i = buf.indexOf(10)) >= 0) {
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
      if (this.detaching) return this.release();
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
    if (payload.type === "control_response" && this.settle(payload)) return;
    if (this.asks.handle(payload)) return;
    if (this.tools?.handle(payload)) return;
    this.asks.seen(payload);
    this.emit({ kind: "message", payload });
    // Claude says which mode it is in with every turn's init, and when it changes: by us, by its own EnterPlanMode, or
    // back once a plan is approved.
    const mode = payload.type === "system" && (payload.subtype === "init" || payload.subtype === "status") ? payload.permissionMode : undefined;
    if (typeof mode === "string" && (mode === "plan") !== this.plan) {
      this.plan = mode === "plan";
      this.emit({ kind: "mode", plan: this.plan });
    }
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
    this.asks.close();
    this.emit({ kind: "exit", code, requested: this.requested });
    this.release();
    // Nothing more will be read from the run: it goes, with the attachment still on it.
    this.removed = execOutput(this.exec, sandbox, removeCommand(run), 10_000).then(() => {}, () => {});
    this.child?.stdin?.end();
  }

  /** Nothing answers a request once the driver is done; `stop()` and `detach()` resolve. */
  private release() {
    this.done = true;
    if (this.detaching) this.tools?.release();
    else this.tools?.close();
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
  private settle(msg: AgentMessage): boolean {
    const response = msg.response as { request_id?: unknown; subtype?: unknown; error?: unknown } | undefined;
    const id = typeof response?.request_id === "string" ? response.request_id : undefined;
    const waiting = id ? this.pending.get(id) : undefined;
    // An answer about a task that an earlier driver asked for: nobody waits for it, and it is no news for the session.
    if (id && !waiting && id.startsWith(TASK_REQUEST)) return true;
    if (!id || !waiting) return false;
    this.pending.delete(id);
    if (response?.subtype === "error") waiting.reject(new Error(typeof response.error === "string" ? response.error : "Claude refused the request."));
    else waiting.resolve((response as { response?: unknown }).response);
    return true;
  }

  withdraw(id: string): Promise<boolean> {
    return this.request("withdraw", { subtype: "cancel_async_message", message_uuid: id }).then((r) => (r as { cancelled?: unknown } | undefined)?.cancelled === true);
  }

  rewindFiles(id: string): Promise<void> {
    return this.request("rewind", { subtype: "rewind_files", user_message_id: id }).then(() => {});
  }

  taskOutput(taskId: string): Promise<TaskOutput> {
    return this.request(`${TASK_REQUEST}output`, { subtype: "get_task_output", task_id: taskId }).then((r) => {
      const o = (r ?? {}) as { output?: unknown; total_bytes?: unknown; truncated?: unknown };
      return { output: typeof o.output === "string" ? o.output : "", totalBytes: typeof o.total_bytes === "number" ? o.total_bytes : 0, truncated: o.truncated === true };
    });
  }

  stopTask(taskId: string): Promise<void> {
    return this.request(`${TASK_REQUEST}stop`, { subtype: "stop_task", task_id: taskId }).then(() => {});
  }

  backgroundTasks(toolUseId?: string): Promise<void> {
    return this.request(`${TASK_REQUEST}background`, { subtype: "background_tasks", ...(toolUseId ? { tool_use_id: toolUseId } : {}) }).then(() => {});
  }

  /** Sends a control request, and resolves with Claude's answer to it; rejects if Claude refuses, or doesn't answer in time. */
  private request(kind: string, request: Record<string, unknown>): Promise<unknown> {
    if (!this.sandbox || this.done || this.requested) return Promise.reject(new Error("Claude isn't running."));
    const request_id = `${kind}-${++this.requests}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request_id);
        reject(new Error("Claude didn't answer in time. Try again."));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(request_id, {
        resolve: (r) => (clearTimeout(timer), resolve(r)),
        reject: (err) => (clearTimeout(timer), reject(err)),
      });
      this.write(JSON.stringify({ type: "control_request", request_id, request }) + "\n");
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

  /**
   * Lets go of Claude, handing over exactly: nothing more of its output is read, so the position stands and whatever
   * follows it (calls too) is the next driver's; calls under way are answered (for up to DRAIN_MS; the rest stay
   * pending); then Claude's input is closed, and the attachment's exit says everything written reached it. Only if the
   * attachment has to be killed, or there is none, may answers have been lost: those calls are handed on too.
   */
  async detach(): Promise<void> {
    if (!this.exited || this.done) return this.exited;
    this.frozen = true;
    await this.tools?.drain(DRAIN_MS);
    this.detaching = true;
    clearTimeout(this.retry);
    const child = this.child;
    if (!child) {
      if (this.outbox.length) this.tools?.answersMayBeLost();
      return this.release();
    }
    // EOF ends the attachment in the sandbox; Claude, holding its own input open, doesn't notice.
    child.stdin!.end();
    const kill = setTimeout(() => {
      this.tools?.answersMayBeLost();
      child.kill("SIGKILL");
    }, GIVE_UP_MS);
    try {
      await this.exited;
    } finally {
      clearTimeout(kill);
    }
  }
}
