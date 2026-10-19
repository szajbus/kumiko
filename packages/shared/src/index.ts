// Types shared by the sandbox adapter, the server and the web UI.
// Nothing in here may import Node or browser APIs.

export const VM_PREFIX = "bm-";

/** Short sandbox names: lowercase letters, digits and dashes, not starting or ending with a dash. */
export const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;

/** Variable names that can be forwarded from the host. */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const DEFAULTS = { cpus: 4, memoryGiB: 4, diskGiB: 100 } as const;

/** Where mounts land in the VM unless the user picks another path. */
export const WORKSPACE_DIR = "/workspace";

export interface Mount {
  hostPath: string;
  writable: boolean;
  /** Where the folder appears in the VM; "~/…" is the VM user's home. Omitted: the same path as on the host. */
  guestPath?: string;
}

/** The default place in the VM for a host folder: /workspace/<folder name>. */
export function defaultGuestPath(hostPath: string): string {
  const base = hostPath.replace(/\/+$/, "").split("/").pop() || "folder";
  return `${WORKSPACE_DIR}/${base}`;
}

/**
 * The `--set` expression that replaces the template's mounts. Unlike `--mount-only`, it can give each
 * mount its own place in the VM, and it doesn't split on commas. "~/" in the VM is Lima's {{.Home}}.
 */
export function mountsExpression(mounts: Mount[]): string {
  const list = mounts.map((m) => {
    const guest = m.guestPath ?? m.hostPath;
    return {
      location: m.hostPath,
      mountPoint: guest.startsWith("~/") ? `{{.Home}}/${guest.slice(2)}` : guest,
      writable: m.writable,
    };
  });
  return `.mounts = ${JSON.stringify(list)}`;
}

/** Defaults the create form starts from. */
export interface DefaultsResponse {
  /** The host user's home, so the UI can show paths as ~/…. */
  home: string;
  mounts: Mount[];
}

export interface SandboxSpec {
  name: string;            // short name, letters/digits/dashes; the VM is "bm-<name>"
  template?: string;       // adapter-specific; Lima default "template:default"
  cpus: number;
  memoryGiB: number;
  diskGiB: number;
  mounts: Mount[];         // guestPath defaults to the host path
  env: string[];           // names of host variables to forward; values never stored
  provision?: string;      // shell script, run once after first start
}

/**
 * What can change after creation. Resources and mounts need the VM stopped (disk can only grow);
 * forwarded variables and the provisioning script can change anytime. Name and template are fixed.
 */
export type EditSpec = Partial<Pick<SandboxSpec, "cpus" | "memoryGiB" | "diskGiB" | "mounts" | "env" | "provision">>;

export type SandboxStatus = "running" | "stopped" | "broken" | "unknown";

export type SetupState = "creating" | "ready" | "provision_failed";

/** What Bentomo keeps on disk for each sandbox it created: ~/.bentomo/sandboxes/<name>.json */
export interface SandboxMeta {
  spec: SandboxSpec;
  provider: "lima";
  createdAt: string;
  setup: SetupState;
  provisionExitCode?: number;
}

export interface SandboxInfo {
  name: string;            // short name, without "bm-"
  status: SandboxStatus;
  cpus?: number; memoryGiB?: number; diskGiB?: number;
  /** Bentomo's metadata, when this sandbox was created by Bentomo. */
  meta?: SandboxMeta;
}

export type OpKind = "creating" | "starting" | "stopping" | "deleting" | "provisioning" | "recreating" | "editing";

/** How a log line is shown: a command being run, a note from Bentomo, success, or an error. */
export type LineKind = "cmd" | "note" | "ok" | "err";

export interface LogLine {
  text: string;
  kind?: LineKind;
}

export interface Operation {
  op: OpKind;
  startedAt: string;
  /** Set once the operation has finished. */
  endedAt?: string;
  result?: "ok" | "error";
  error?: string;
}

/** A sandbox as the UI sees it: Lima's view merged with metadata and the current or last operation. */
export interface SandboxView extends SandboxInfo {
  vm: string;
  provider: "lima";
  /** The running operation, or the last finished one. */
  operation?: Operation;
  busy: boolean;
}

export interface TemplatesResponse {
  templates: string[];
  preferred: string;
}

export interface CreateResponse {
  name: string;
  warnings: string[];
}

export interface ApiError {
  error: string;
  details?: string[];
}

/** Messages on the /api/events WebSocket. */
export type ServerEvent =
  | { type: "snapshot"; sandboxes: SandboxView[]; logs: Record<string, LogLine[]>; error?: string }
  | { type: "list"; sandboxes: SandboxView[]; error?: string }
  | { sandbox: string; op: OpKind; type: "state"; data: Operation }
  | { sandbox: string; op: OpKind; type: "log"; data: LogLine }
  | { sandbox: string; op: OpKind; type: "done"; data: Operation }
  | { sandbox: string; op: OpKind; type: "error"; data: Operation };

export function vmName(name: string): string {
  return VM_PREFIX + name;
}
