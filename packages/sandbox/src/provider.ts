import type { ChildProcess } from "node:child_process";
import type { AgentSetupRun, EditSpec, LineKind, SandboxInfo, SandboxSpec } from "@kumiko/shared";
import type { Validation } from "./validate.js";

/** Receives progress, one line at a time. */
export type Log = (line: string, kind?: LineKind) => void;

export interface SandboxProvider {
  id: "lima";
  list(): Promise<SandboxInfo[]>;                      // Kumiko's instances only
  /** Creates the VM, starts it and provisions it: Claude Code, the user's script, then the agent's scripts in `agentSetup`. */
  create(spec: SandboxSpec, log: Log, agentSetup?: AgentSetupRun): Promise<void>;
  start(name: string, log: Log): Promise<void>;
  stop(name: string, log: Log): Promise<void>;
  /** Deletes the VM and its record, and its workspace disk unless `keepWorkspace` (a recreate keeps it). */
  delete(name: string, log: Log, opts?: { keepWorkspace?: boolean }): Promise<void>;
  /**
   * Checks an edit before `edit`: errors block it (e.g. resources changed while running), warnings don't.
   * With `recreate`, the VM is rebuilt from the result, so only the spec itself has to be valid. With `restart`, the VM
   * is stopped before the edit, so resources and mounts can change while it runs.
   */
  validateEdit(name: string, patch: EditSpec, opts?: { recreate?: boolean; restart?: boolean }): Promise<Validation>;
  /** Applies an edit: `limactl edit` for resources and mounts, then the stored spec. */
  edit(name: string, patch: EditSpec, log: Log): Promise<void>;
  /** Runs `cmd` in the VM with stdio piped; sessions pass the sandbox's working directory as `cwd`. */
  exec(name: string, cmd: string, env: string[], opts?: { cwd?: string }): ChildProcess;
  /**
   * Forwards Unix socket `guestPath` in the VM to `hostPath` on the host, for as long as the process runs: each
   * connection to the one in the VM becomes a connection to the one on the host. It exits when the VM goes, or when the
   * forward can't be set up (the guest path is taken, say), with why on stderr.
   */
  forward(name: string, guestPath: string, hostPath: string): ChildProcess;
  /**
   * Checks a spec before `create`: errors block it, warnings (unset variables) don't. With `newSandbox`, nothing of an
   * earlier sandbox of the same name may be left, such as its workspace disk.
   */
  validate(spec: SandboxSpec, opts?: { newSandbox?: boolean }): Promise<Validation>;
  /** Templates the create form can offer, plus the one to preselect. */
  templates(): Promise<{ templates: string[]; preferred: string }>;
}

/** A failed operation; `message` ends with the tail of the tool's output. */
export class ProviderError extends Error {
  constructor(message: string, readonly exitCode?: number) {
    super(message);
    this.name = "ProviderError";
  }
}
