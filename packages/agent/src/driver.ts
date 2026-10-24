import type { SandboxProvider } from "@kumiko/sandbox";
import type { AgentAsk, AskAnswer, AskClosedReason } from "@kumiko/shared";
import type { PendingAsk } from "./asks.js";
import type { PendingCall, ToolHost } from "./tools.js";

/** How a driver runs its agent: the base provider's `exec`, so the sandbox's forwarded variables apply. */
export type Exec = SandboxProvider["exec"];

export interface StartOptions {
  sandbox: string;
  /** Where the agent starts in the VM. */
  workdir: string;
  /** Names of host variables to forward, as for provisioning. */
  env: string[];
  /** Sent as soon as the agent starts, so the session starts working without a second step. Omit when resuming. */
  prompt?: string;
  /** The id `prompt` is known by; see `send`. */
  promptId?: string;
  /** Files that go with `prompt`. */
  files?: AgentFile[];
  /** The agent's own id of an earlier session to continue; its history is already in the sandbox. */
  resume?: string;
  /** With `resume`: continue under a new session id, leaving the original as it is. */
  fork?: boolean;
  /** With `resume`: continue from this message of the earlier session (its id, from the agent's own stream), dropping what came after. */
  resumeAt?: string;
  /** The model to start with (an alias such as "opus"); the agent's default when omitted. */
  model?: string;
  /** The id of the run the agent starts in; a new one is made up when omitted. See `runs.ts`. */
  run?: string;
  /** Tools the caller hosts for the agent; see `tools.ts`. */
  tools?: ToolHost;
  /** Added to the agent's system prompt. */
  appendSystemPrompt?: string;
}

/** Where to pick up an agent that is already running: its run, and how far into its output the caller has got. */
export interface AttachOptions {
  sandbox: string;
  run: string;
  /** Bytes of the run's output already consumed; what follows is reported as if live. */
  offset: number;
  /** The tools the agent was started with, which it may call again. */
  tools?: ToolHost;
  /** Calls to them the driver that detached left unanswered, to answer now. */
  pending?: PendingCall[];
  /** What the agent asked the user that the driver that detached left open; see `pendingAsks`. */
  asks?: PendingAsk[];
}

/** A driver's place in its run's output: everything before `offset` has been reported. */
export interface RunPosition {
  run: string;
  offset: number;
}

/** A file sent with a prompt, for the agent to read itself: an image, a PDF, or text (`text/plain`, UTF-8). */
export interface AgentFile {
  name: string;
  mediaType: string;
  data: Buffer;
}

/** The end of a background task's output, as the agent keeps it: at most its last few KiB, of `totalBytes` in all. */
export interface TaskOutput {
  output: string;
  totalBytes: number;
  /** `output` is only the end of it. */
  truncated: boolean;
}

/** One parsed protocol message; every one has a `type`. */
export type AgentMessage = Record<string, unknown> & { type: string };

/**
 * What an agent reports.
 * - `message`: one line of the agent's own protocol, parsed (for Claude, a stream-json object).
 * - `error`: something the user should see, with a hint where one exists. `signedOut` when the agent isn't logged in.
 * - `ask`: the agent waits on the user, mid-turn, for an answer to give with `answer`.
 * - `ask_closed`: it stopped waiting without one: the turn was stopped, or the agent exited.
 * - `mode`: the agent is planning (it waits for the user to approve a plan before changing anything), or not.
 * - `exit`: the process is gone; always the last event, unless the driver detaches. `requested` is true after `stop()`.
 */
export type AgentEvent =
  | { kind: "message"; payload: AgentMessage }
  | { kind: "ask"; ask: AgentAsk }
  | { kind: "ask_closed"; id: string; reason: AskClosedReason }
  | { kind: "mode"; plan: boolean }
  | { kind: "error"; message: string; hint?: string; stderr?: string[]; signedOut?: boolean }
  | { kind: "exit"; code: number; requested: boolean };

/**
 * One agent process in one sandbox. The session layer only talks to this, so agents other than Claude Code
 * (through ACP, say) can slot in without touching the server or the UI.
 */
export interface AgentDriver {
  /** Starts the agent in a run of its own, detached from the server, and attaches to it. */
  start(opts: StartOptions): void;
  /** Attaches to a run started earlier (by another server, say), replaying its output from `offset`. */
  attach(opts: AttachOptions): void;
  /** The run and how much of its output has been reported, once started or attached. */
  position(): RunPosition | undefined;
  /**
   * Sends a prompt; it starts a turn, or queues behind the current one. The agent tags the prompt with `id` in its
   * stream and in its history, which is what `rewindFiles` and `resumeAt` refer to. `files` go with it.
   */
  send(text: string, id?: string, files?: AgentFile[]): void;
  /**
   * Takes back prompt `id`, sent while the agent worked, if it hasn't read it yet: true if it never will, false if it
   * already has (or never got it), and the prompt runs as sent.
   */
  withdraw(id: string): Promise<boolean>;
  /** Puts the files the agent changed back as they were before prompt `id`. Rejects if the agent has no checkpoint for it. */
  rewindFiles(id: string): Promise<void>;
  /**
   * The end of what a background shell or monitor (by the agent's task id) has printed so far, or all of it once it
   * ended. Asking costs the agent no turn.
   */
  taskOutput(taskId: string): Promise<TaskOutput>;
  /** Stops a background task: a shell, a monitor or a subagent. The agent hears of it with the next prompt. */
  stopTask(taskId: string): Promise<void>;
  /** Moves foreground tasks to the background, letting their tool calls return: the one `toolUseId` started, or all. */
  backgroundTasks(toolUseId?: string): Promise<void>;
  /** Ends the current turn but keeps the process. */
  interrupt(): void;
  /** Closes stdin and kills the process if it is still alive after a grace period. Resolves once it has exited. */
  stop(): Promise<void>;
  /** Lets go of the agent and leaves it running, to be attached to again from `position()`. Reports nothing more. */
  detach(): Promise<void>;
  /** Calls to the caller's tools the agent is waiting on; after a detach, the ones the next driver should answer. */
  pendingCalls(): PendingCall[];
  /**
   * Answers what the agent asked (an `ask` event). The answer is kept until the agent is seen to have it, so a driver
   * that attaches later sends it again. Throws if the agent isn't waiting for it, or the answer doesn't fit the ask.
   */
  answer(id: string, answer: AskAnswer): void;
  /** What the agent asked that it hasn't had an answer to; after a detach, what the next driver takes over. */
  pendingAsks(): PendingAsk[];
  /** Has the agent plan before it changes anything, or not; a `mode` event follows once it has switched. */
  setPlanMode(plan: boolean): void;
  /** Returns a function that removes the listener. */
  onEvent(listener: (ev: AgentEvent) => void): () => void;
}
