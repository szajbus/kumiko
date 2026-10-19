// Types shared by the sandbox adapter, the server and the web UI.
// Nothing in here may import Node or browser APIs.

export const VM_PREFIX = "bm-";

/** Short sandbox names: lowercase letters, digits and dashes, not starting or ending with a dash. */
export const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;

/** Bentomo's own session ids (not Claude's): lowercase hex. Checked before an id names a file or a socket. */
export const SESSION_ID_PATTERN = /^[0-9a-f]{1,64}$/;

/** Variable names that can be forwarded from the host. */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const DEFAULTS = { cpus: 4, memoryGiB: 4, diskGiB: 100 } as const;

/** The smallest resources a sandbox can have. */
export const MINIMUMS = { cpus: 1, memoryGiB: 1, diskGiB: 10 } as const;

/** The default working directory in the VM. Mounts land under the working directory unless the user picks another path. */
export const WORKSPACE_DIR = "/workspace";

export interface Mount {
  hostPath: string;
  writable: boolean;
  /** Where the folder appears in the VM; "~/…" is the VM user's home. Omitted: the same path as on the host. */
  guestPath?: string;
}

/** The default place in the VM for a host folder: <working directory>/<folder name>. */
export function defaultGuestPath(hostPath: string, workdir: string = WORKSPACE_DIR): string {
  const base = hostPath.replace(/\/+$/, "").split("/").pop() || "folder";
  return `${workdir.replace(/\/+$/, "")}/${base}`;
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

/** Whether two mount lists give the VM the same folders at the same places, in the same order. */
export function sameMounts(a: Mount[], b: Mount[]): boolean {
  const key = (ms: Mount[]) => JSON.stringify(ms.map((m) => [m.hostPath, m.guestPath ?? m.hostPath, m.writable]));
  return key(a) === key(b);
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
  /** Where provisioning and sessions start in the VM, created if missing; "~/…" is the VM user's home. Default /workspace. */
  workdir?: string;
}

/**
 * What can change after creation. Saved in place, resources and mounts need the VM stopped (disk can only grow)
 * and forwarded variables and the provisioning script can change anytime. Saved with a recreate, anything but
 * name and template can change. Name and template are fixed.
 */
export type EditSpec = Partial<Pick<SandboxSpec, "cpus" | "memoryGiB" | "diskGiB" | "mounts" | "env" | "provision" | "workdir">>;

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
  /** Set when Bentomo has a record of this sandbox that it can't read; `meta` is then missing. */
  metaError?: string;
}

export type OpKind = "creating" | "starting" | "stopping" | "deleting" | "recreating" | "editing";

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
  /** Live agent sessions in this sandbox. */
  sessions: number;
}

// ---- agent sessions -------------------------------------------------------------------------

/** `starting` until Claude answers, `running` during a turn, `idle` between turns; `ended` and `failed` are final. */
export type SessionStatus = "starting" | "idle" | "running" | "ended" | "failed";

export const LIVE_SESSION_STATUSES: readonly SessionStatus[] = ["starting", "idle", "running"];

export interface SessionInfo {
  id: string;
  sandbox: string;          // short name, without "bm-"
  workdir: string;          // where Claude was started in the VM
  status: SessionStatus;
  /** The opening prompt, for the tab title. */
  prompt: string;
  /** Set by /rename; replaces the prompt in the tab title. */
  title?: string;
  startedAt: string;
  endedAt?: string;
  /** When the session was last saved to disk; orders the list of sessions that can be resumed. */
  updatedAt?: string;
  /** Claude's own session id and model, from its `system/init`. */
  claudeSessionId?: string;
  model?: string;
  /** The slash commands Claude accepts in this session (without the slash), from its `system/init`. */
  commands?: string[];
  /** How much memory the session's event buffer takes on the server, in bytes; updated when a turn ends. */
  bufferBytes?: number;
}

/** Why a session ended: its tab closing, its sandbox stopping, the app quitting, or the process exiting by itself. */
export type EndReason = "user" | "sandbox" | "quit" | "exit";

/**
 * One entry in a session's event buffer. `claude` carries a raw stream-json line from Claude; the rest are Bentomo's:
 * the prompts we sent (each tagged with an `id` that Claude knows it by, so it can be rewound to), Stop being pressed, errors (SSH, `claude` missing or signed out, a crash) and the end.
 */
export type SessionEvent =
  | { seq: number; kind: "claude"; payload: Record<string, unknown> & { type: string } }
  | { seq: number; kind: "user_prompt"; payload: { text: string; id?: string } }
  | { seq: number; kind: "interrupt"; payload: Record<string, never> }
  | { seq: number; kind: "error"; payload: { message: string; hint?: string; stderr?: string[] } }
  | { seq: number; kind: "ended"; payload: { reason: EndReason; code?: number } };

/** Rewinds a session to just before one of its prompts, in a new session. */
export interface RewindRequest {
  /** Also put the files Claude changed since back as they were. */
  files: boolean;
}

export interface RewindResponse {
  /** The new session. */
  id: string;
  /** The prompt that was rewound to, to be edited and sent again. */
  text: string;
}

/** One of the subscription's usage limits: the current 5-hour session, the week, a model's share of the week. */
export interface UsageWindow {
  id: string;
  label: string;
  /** Share of the limit used so far, 0–100. */
  usedPercent: number;
  /** When the window resets, ISO 8601. */
  resetsAt?: string;
}

/** The Claude account a sandbox is signed in to, with how much of its subscription is used. Either half can be missing. */
export interface AccountUsage {
  email?: string;
  /** The subscription plan, e.g. "max" or "pro". */
  plan?: string;
  windows: UsageWindow[];
  /** Set when usage couldn't be read; the account may still be known. */
  error?: string;
  fetchedAt: string;
}

export interface StartSessionRequest {
  sandbox: string;
  prompt: string;
  /** A model alias to start with; Claude's default when omitted. */
  model?: string;
}

/** A session saved on disk that can be resumed: closed, or left behind when Bentomo quit. */
export type ResumableSession = SessionInfo & { claudeSessionId: string };

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
  | { type: "snapshot"; sandboxes: SandboxView[]; logs: Record<string, LogLine[]>; sessions: SessionInfo[]; error?: string }
  | { type: "list"; sandboxes: SandboxView[]; error?: string }
  /** Sent whenever a session starts, changes status or ends. */
  | { type: "sessions"; sessions: SessionInfo[] }
  | { sandbox: string; op: OpKind; type: "state"; data: Operation }
  | { sandbox: string; op: OpKind; type: "log"; data: LogLine }
  | { sandbox: string; op: OpKind; type: "done"; data: Operation }
  | { sandbox: string; op: OpKind; type: "error"; data: Operation };

export function vmName(name: string): string {
  return VM_PREFIX + name;
}
