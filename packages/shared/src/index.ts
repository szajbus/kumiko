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

/** The working directory in the VM of a sandbox whose spec names none. A project's VM works in its clone instead. */
export const WORKSPACE_DIR = "/workspace";

/**
 * Where a project's Claude home is mounted in its VM, and what CLAUDE_CONFIG_DIR points at there. Set on every
 * command Bentomo runs in a VM and in every shell, so Claude keeps `.claude.json` inside the mount too.
 */
export const CLAUDE_HOME_IN_VM = "~/.claude";

/** The folder beside a clone that holds its worktrees: `<clone>__worktrees`. */
export const WORKTREES_SUFFIX = "__worktrees";

export interface Mount {
  hostPath: string;
  writable: boolean;
  /** Where the folder appears in the VM; "~/…" is the VM user's home. Omitted: the same path as on the host. */
  guestPath?: string;
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

/** The window's tabs as they were, to bring back on the next start. Kept by the server: the desktop app's port, and
 * with it the page's origin and localStorage, changes every launch. */
export interface SavedTabs {
  /** Session ids in tab order. */
  sessions: string[];
  newSession: boolean;
  /** The active tab's id, as the UI names it. */
  active: string;
}

/** The saved tabs in `v`, or undefined if it isn't saved tabs. Session ids that can't be ids are dropped. */
export function parseSavedTabs(v: unknown): SavedTabs | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const { sessions, newSession, active } = v as Partial<Record<keyof SavedTabs, unknown>>;
  if (!Array.isArray(sessions) || typeof active !== "string" || active.length > 100) return undefined;
  const ids = sessions.filter((x): x is string => typeof x === "string" && SESSION_ID_PATTERN.test(x));
  return { sessions: ids.slice(0, 200), newSession: newSession === true, active };
}

/** What the UI needs from the host. */
export interface DefaultsResponse {
  /** The host user's home, so the UI can show paths as ~/…. */
  home: string;
  /** The folder holding each project's Claude home, as `<claudeHomes>/<project id>`. */
  claudeHomes: string;
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

/** `absent`: a project whose VM doesn't exist (its creation failed, or it was deleted outside Bentomo). */
export type SandboxStatus = "running" | "stopped" | "broken" | "unknown" | "absent";

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

// ---- projects -------------------------------------------------------------------------------

/**
 * A local git clone with one VM and one Claude home. Its id is also its sandbox's name, so the VM is `bm-<id>`.
 * Saved in Bentomo's home as `projects/<id>.json`; nothing is written into the repo.
 */
export interface Project {
  id: string;
  /** The clone's real path on the host, mounted at the same path in the VM. */
  clonePath: string;
  /** `<clone>__worktrees`, beside the clone, mounted at the same path in the VM. */
  worktreesPath: string;
  createdAt: string;
}

/** A project id from its clone's folder name: lowercase letters, digits and dashes, short enough for a sandbox name. */
export function suggestProjectId(clonePath: string): string {
  const base = clonePath.replace(/\/+$/, "").split("/").pop() ?? "";
  return base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/, "");
}

/**
 * Which of the mounts every project's VM has this one is, if any: the clone and its worktrees at their own paths, and
 * the Claude home at ~/.claude. With `claudeHome`, the Claude home's host folder must match too.
 */
export function projectMountRole(p: Project, m: Mount, claudeHome?: string): "clone" | "worktrees" | "claude-home" | undefined {
  const guest = m.guestPath ?? m.hostPath;
  if (m.hostPath === p.clonePath && guest === p.clonePath) return "clone";
  if (m.hostPath === p.worktreesPath && guest === p.worktreesPath) return "worktrees";
  if (guest === CLAUDE_HOME_IN_VM && (claudeHome === undefined || m.hostPath === claudeHome)) return "claude-home";
  return undefined;
}

/** A project as the UI sees it: its VM's view, plus the project itself and what needs the user. */
export interface ProjectView extends SandboxView {
  project: Project;
  /** Set when the clone or the worktrees folder is gone from the host; the VM can't start without them. */
  problem?: string;
  /** Sessions in this project that are waiting on the user. */
  waiting: number;
}

/** Creates a project from a clone. Everything but `clonePath` and `name` is the VM's spec. */
export type CreateProjectRequest = Omit<SandboxSpec, "workdir"> & {
  clonePath: string;
};

/**
 * What can change on a project: its VM's spec, as for a sandbox. `mounts` are the extra ones only; the clone,
 * worktrees and Claude home mounts are always there and can't change. The working directory is the clone.
 */
export type ProjectEdit = Omit<EditSpec, "workdir">;

/** One worktree of a project's clone, as git on the host sees it. */
export interface WorktreeStatus {
  path: string;
  /** The branch checked out, without refs/heads/; missing when HEAD is detached. */
  branch?: string;
  head?: string;
  /** The clone itself, which git lists first. */
  main: boolean;
  /** Uncommitted changes, untracked files included. */
  dirty: boolean;
  /** Commits not on the branch's upstream, or on no remote at all when it has none. */
  unpushed: number;
  /** The upstream, e.g. "origin/fix-x"; missing when the branch has none. */
  upstream?: string;
  /** HEAD is contained in the remote's default branch (as of the last fetch), so the worktree can go. */
  merged: boolean;
  /** git's own flags: locked by the user, or prunable because its folder is gone. */
  locked?: boolean;
  prunable?: boolean;
  /** Set when git couldn't read this worktree's state. */
  error?: string;
}

export interface WorktreesResponse {
  worktrees: WorktreeStatus[];
  /** The remote branch "merged" is measured against, e.g. "origin/main"; missing when there is none. */
  defaultBranch?: string;
}

// ---- agent sessions -------------------------------------------------------------------------

/** `starting` until Claude answers, `running` during a turn, `idle` between turns; `ended` and `failed` are final. */
export type SessionStatus = "starting" | "idle" | "running" | "ended" | "failed";

export const LIVE_SESSION_STATUSES: readonly SessionStatus[] = ["starting", "idle", "running"];

export interface SessionInfo {
  id: string;
  /** The project's id, which is also its sandbox's short name (without "bm-"). */
  sandbox: string;
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
  /**
   * After a rewind, the message of `claudeSessionId` that Claude's history is cut after. Claude gives the cut history
   * a new id only with its next turn, so until then a restart has to make the same cut.
   */
  resumeAt?: string;
  model?: string;
  /** The model Claude used by default, known when the session started without choosing one. */
  defaultModel?: string;
  /** The slash commands Claude accepts in this session (without the slash), from its `system/init`. */
  commands?: string[];
  /** How much memory the session's event buffer takes on the server, in bytes; updated when a turn ends. */
  bufferBytes?: number;
  /** Claude finished a turn, or the session ended by itself, since the user last looked at it. */
  unread?: boolean;
}

/**
 * Whether a session is waiting on the user: Claude finished (or the session stopped by itself) and nobody has looked
 * since. Claude runs with permissions bypassed, so a finished turn is the only way it waits for an answer.
 */
export function isWaiting(s: SessionInfo): boolean {
  return s.unread === true && s.status !== "running" && s.status !== "starting";
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
  /** `signedOut`: Claude isn't logged in, so the UI offers to log in instead of only showing the message. */
  | { seq: number; kind: "error"; payload: { message: string; hint?: string; stderr?: string[]; signedOut?: boolean } }
  | { seq: number; kind: "ended"; payload: { reason: EndReason; code?: number } };

/** Who Claude is logged in as in a project's Claude home. */
export interface LoginAccount {
  email?: string;
  /** The subscription plan, e.g. "max" or "pro". */
  plan?: string;
}

/**
 * Starting a login from a session: the page to sign in on, after which Claude shows a code to paste back; or, when
 * the project is logged in already (from another session, say), who it is logged in as.
 */
export type LoginStartResponse = { url: string } | { loggedIn: LoginAccount };

/** Whether a project's Claude is logged in now; `loggedIn` is missing when it isn't, or its sandbox isn't running. */
export interface LoginStatusResponse {
  loggedIn?: LoginAccount;
}

/** Rewinds a session in place to just before one of its prompts. */
export interface RewindRequest {
  /** Also put the files Claude changed since back as they were. */
  files: boolean;
}

/** Starts a new session from a copy of a session's conversation. */
export interface ForkRequest {
  /** Copy the conversation only up to the end of this prompt's turn; all of it when omitted. */
  prompt?: string;
}

export interface RewindResponse {
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
  /** Why the latest attempt to read usage failed; `windows` are then from the last one that worked, if any. */
  error?: string;
  /** When `windows` were read; missing until usage has been read once. */
  fetchedAt?: string;
}

export interface StartSessionRequest {
  /** The project's id. */
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
  /** The project's id. */
  name: string;
  warnings: string[];
}

export interface ApiError {
  error: string;
  details?: string[];
}

/** Messages on the /api/events WebSocket. */
export type ServerEvent =
  /** `error`: the VMs couldn't be listed. `unreadable`: why each project record that can't be used can't be. */
  | { type: "snapshot"; projects: ProjectView[]; unreadable: string[]; logs: Record<string, LogLine[]>; sessions: SessionInfo[]; error?: string }
  | { type: "list"; projects: ProjectView[]; unreadable: string[]; error?: string }
  /** Sent whenever a session starts, changes status or ends. */
  | { type: "sessions"; sessions: SessionInfo[] }
  | { sandbox: string; op: OpKind; type: "state"; data: Operation }
  | { sandbox: string; op: OpKind; type: "log"; data: LogLine }
  | { sandbox: string; op: OpKind; type: "done"; data: Operation }
  | { sandbox: string; op: OpKind; type: "error"; data: Operation };

export function vmName(name: string): string {
  return VM_PREFIX + name;
}
