import type { SandboxProvider } from "@bentomo/sandbox";

/** How a driver runs its agent: the base provider's `exec`, so the sandbox's forwarded variables apply. */
export type Exec = SandboxProvider["exec"];

export interface StartOptions {
  sandbox: string;
  /** Where the agent starts in the VM. */
  workdir: string;
  /** Names of host variables to forward, as for provisioning. */
  env: string[];
  /** Sent as soon as the agent starts, so the session starts working without a second step. */
  prompt: string;
}

/** One parsed protocol message; every one has a `type`. */
export type AgentMessage = Record<string, unknown> & { type: string };

/**
 * What an agent reports.
 * - `message`: one line of the agent's own protocol, parsed (for Claude, a stream-json object).
 * - `error`: something the user should see, with a hint where one exists.
 * - `exit`: the process is gone; always the last event. `requested` is true after `stop()`.
 */
export type AgentEvent =
  | { kind: "message"; payload: AgentMessage }
  | { kind: "error"; message: string; hint?: string; stderr?: string[] }
  | { kind: "exit"; code: number; requested: boolean };

/**
 * One agent process in one sandbox. The session layer only talks to this, so agents other than Claude Code
 * (through ACP, say) can slot in without touching the server or the UI.
 */
export interface AgentDriver {
  start(opts: StartOptions): void;
  /** Sends a prompt; it starts a turn, or queues behind the current one. */
  send(text: string): void;
  /** Ends the current turn but keeps the process. */
  interrupt(): void;
  /** Closes stdin and kills the process if it is still alive after a grace period. Resolves once it has exited. */
  stop(): Promise<void>;
  /** Returns a function that removes the listener. */
  onEvent(listener: (ev: AgentEvent) => void): () => void;
}
