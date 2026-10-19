import type { ChildProcess } from "node:child_process";
import type { EditSpec, LineKind, SandboxInfo, SandboxSpec } from "@bentomo/shared";
import type { Validation } from "./validate.js";

/** Receives progress, one line at a time. */
export type Log = (line: string, kind?: LineKind) => void;

export interface SandboxProvider {
  id: "lima";
  list(): Promise<SandboxInfo[]>;                      // bm- instances only
  create(spec: SandboxSpec, log: Log): Promise<void>;  // create + first start + provision
  start(name: string, log: Log): Promise<void>;
  stop(name: string, log: Log): Promise<void>;
  delete(name: string, log: Log): Promise<void>;
  /** Checks an edit before `edit`: errors block it (e.g. resources changed while running), warnings don't. */
  validateEdit(name: string, patch: EditSpec): Promise<Validation>;
  /** Applies an edit: `limactl edit` for resources and mounts, then the stored spec. */
  edit(name: string, patch: EditSpec, log: Log): Promise<void>;
  /** Re-run the stored provisioning command and update the setup state. */
  provision(name: string, log: Log): Promise<void>;
  exec(name: string, cmd: string, env: string[]): ChildProcess; // stdio piped; the PoC's ACP pipe
  /** Checks a spec before `create`: errors block it, warnings (unset variables) don't. */
  validate(spec: SandboxSpec): Promise<Validation>;
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
