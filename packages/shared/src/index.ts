// Types shared by the sandbox adapter, the server and the web UI.
// Nothing in here may import Node or browser APIs.

export * from "./window.js";
import type { WindowOp } from "./window.js";

export const VM_PREFIX = "km-";

/** Short sandbox names: lowercase letters, digits and dashes, not starting or ending with a dash. */
export const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;

/** Kumiko's own session ids (not Claude's): lowercase hex. Checked before an id names a file or a socket. */
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
 * command Kumiko runs in a VM and in every shell, so Claude keeps `.claude.json` inside the mount too.
 */
export const CLAUDE_HOME_IN_VM = "~/.claude";

/**
 * Kumiko's folder in a VM: `local/` on the VM's own disk, for what must stay there (agents' runs, whose FIFOs don't
 * cross virtiofs), and `shared/`, the project's Kumiko folder mounted from the host.
 */
export const KUMIKO_DIR_IN_VM = "~/.kumiko";

/**
 * Where a project's Kumiko folder is mounted in its VM: what Kumiko and the agent keep for Kumiko, such as the agent's
 * setup scripts and sessions' artifacts. Kept out of the Claude home, which is Claude Code's to change.
 */
export const KUMIKO_HOME_IN_VM = `${KUMIKO_DIR_IN_VM}/shared`;

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
  /** One per New session tab, in tab order: the project picked in it, or "" for none. */
  newSessions: string[];
  /** The active tab's id, as the UI names it. */
  active: string;
  /** The tabs after Projects in the order they were dragged into, named as `active` is. */
  order: string[];
}

/** The saved tabs in `v`, or undefined if it isn't saved tabs. Session ids that can't be ids are dropped. */
export function parseSavedTabs(v: unknown): SavedTabs | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const { sessions, newSessions, active, order } = v as Partial<Record<keyof SavedTabs, unknown>>;
  if (!Array.isArray(sessions) || !Array.isArray(newSessions) || !Array.isArray(order) || typeof active !== "string" || active.length > 100) return undefined;
  const ids = sessions.filter((x): x is string => typeof x === "string" && SESSION_ID_PATTERN.test(x));
  const projects = newSessions.filter((x): x is string => typeof x === "string").map((x) => (NAME_PATTERN.test(x) ? x : ""));
  const tabs = order.filter((x): x is string => typeof x === "string" && x.length <= 100);
  return { sessions: ids.slice(0, 200), newSessions: projects.slice(0, 50), active, order: tabs.slice(0, 250) };
}

/** What the UI needs from the host. */
export interface DefaultsResponse {
  /** The host user's home, so the UI can show paths as ~/…. */
  home: string;
  /** The folder holding each project's Claude home, as `<claudeHomes>/<project id>`. */
  claudeHomes: string;
  /** The folder holding each project's Kumiko folder, as `<kumikoHomes>/<project id>`. */
  kumikoHomes: string;
}

export interface SandboxSpec {
  name: string;            // short name, letters/digits/dashes; the VM is "km-<name>"
  template?: string;       // adapter-specific; Lima default "template:default"
  cpus: number;
  memoryGiB: number;
  diskGiB: number;
  mounts: Mount[];         // guestPath defaults to the host path
  env: string[];           // names of host variables to forward; values never stored
  provision?: string;      // shell script, run once after first start
  /** Where provisioning and sessions start in the VM, created if missing; "~/…" is the VM user's home. Default /workspace. */
  workdir?: string;
  /**
   * Whether the agent may reach services on the host's loopback (its 127.0.0.1), as Lima lets a VM by default through
   * its host address. Off: Kumiko blocks it where Lima can (Lima 2.3 or later, vmType vz).
   */
  hostLoopback?: boolean;
}

/**
 * What can change after creation. Saved in place, resources and mounts need the VM stopped (disk can only grow)
 * and forwarded variables and the provisioning script can change anytime. Saved with a recreate, anything but
 * name and template can change. Name and template are fixed.
 */
export type EditSpec = Partial<Pick<SandboxSpec, "cpus" | "memoryGiB" | "diskGiB" | "mounts" | "env" | "provision" | "workdir" | "hostLoopback">>;

/** A spec as validated, which has its defaults filled in. */
export type ValidSpec = SandboxSpec & { workdir: string };

/** `absent`: a project whose VM doesn't exist (its creation failed, or it was deleted outside Kumiko). */
export type SandboxStatus = "running" | "stopped" | "broken" | "unknown" | "absent";

export type SetupState = "creating" | "ready" | "provision_failed";

/** What Kumiko keeps on disk for each sandbox it created: ~/.kumiko/sandboxes/<name>.json */
export interface SandboxMeta {
  spec: ValidSpec;
  provider: "lima";
  createdAt: string;
  setup: SetupState;
  provisionExitCode?: number;
  /** The agent's setup scripts this VM was created with, and how each went; absent when there were none. */
  agentSetup?: AgentSetupRun;
}

/**
 * Where the agent keeps its setup scripts, in the project's Kumiko folder: `*.sh` files run in name order after the
 * user's provisioning script whenever the VM is created, so what the agent set up survives a recreate.
 */
export const AGENT_SETUP_DIR = "provision.d";

/** Which files in the agent's setup folder are its scripts; others are left alone. */
export const AGENT_SCRIPT_PATTERN = /^[A-Za-z0-9][\w.-]*\.sh$/;

/** The largest setup script Kumiko runs; anything bigger is more likely a mistake (a log, a binary) than a script. */
export const AGENT_SCRIPT_MAX_BYTES = 1024 * 1024;

/** One of the agent's setup scripts as a VM was created with it. `exitCode` is set once it has run. */
export interface AgentScript {
  file: string;
  script: string;
  exitCode?: number;
}

/** The agent's setup scripts a VM was created with. */
export interface AgentSetupRun {
  scripts: AgentScript[];
}

/** GET /api/projects/:id/agent-setup: the scripts as they are now, each with how it went when the VM was created, if it ran as it is now. */
export interface AgentSetupResponse {
  scripts: AgentScript[];
  /** Files in the folder Kumiko won't run: not named `*.sh`, not plain files, or too big. */
  ignored: string[];
}

export interface SandboxInfo {
  name: string;            // short name, without "km-"
  status: SandboxStatus;
  cpus?: number; memoryGiB?: number; diskGiB?: number;
  /** Kumiko's metadata, when this sandbox was created by Kumiko. */
  meta?: SandboxMeta;
  /** Set when Kumiko has a record of this sandbox that it can't read; `meta` is then missing. */
  metaError?: string;
  /** Set when the sandbox can reach the host's loopback though its spec says it shouldn't: why that isn't blocked. */
  hostLoopbackOpen?: string;
}

export type OpKind = "creating" | "starting" | "stopping" | "deleting" | "recreating" | "restarting" | "editing";

/** How a log line is shown: a command being run, a note from Kumiko, success, or an error. */
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
 * A local git clone with one VM and one Claude home. Its id is also its sandbox's name, so the VM is `km-<id>`.
 * Saved in Kumiko's home as `projects/<id>.json`; nothing is written into the repo.
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
 * Which of the mounts every project's VM has this one is, if any: the clone and its worktrees at their own paths, the
 * Claude home at ~/.claude and the Kumiko folder at ~/.kumiko. With `homes`, the homes' host folders must match too.
 */
export function projectMountRole(
  p: Project,
  m: Mount,
  homes?: { claude: string; kumiko: string },
): "clone" | "worktrees" | "claude-home" | "kumiko-home" | undefined {
  const guest = m.guestPath ?? m.hostPath;
  if (m.hostPath === p.clonePath && guest === p.clonePath) return "clone";
  if (m.hostPath === p.worktreesPath && guest === p.worktreesPath) return "worktrees";
  if (guest === CLAUDE_HOME_IN_VM && (homes === undefined || m.hostPath === homes.claude)) return "claude-home";
  if (guest === KUMIKO_HOME_IN_VM && (homes === undefined || m.hostPath === homes.kumiko)) return "kumiko-home";
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
  /** The project's id, which is also its sandbox's short name (without "km-"). */
  sandbox: string;
  workdir: string;          // where Claude was started in the VM
  status: SessionStatus;
  /** The opening prompt, for the tab title. */
  prompt: string;
  /** Set by /rename, or by Claude with Kumiko's session_rename; replaces the prompt in the tab title. */
  title?: string;
  /** Who set `title`; missing when there is none. */
  titleBy?: "user" | "agent";
  /** A sentence or two on what the session is about, set by Claude with session_rename; the list of saved sessions shows it. */
  description?: string;
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
  /** What Kumiko's tools were (a hash of them) when the session's Claude was started; its tools are fixed from then. */
  toolsVersion?: string;
  /** The session's Claude was started with other tools than Kumiko has now, so restarting it would bring the new ones. */
  toolsOutdated?: boolean;
  /**
   * The session's tab was closed while Claude was working: it finishes its turn out of sight, until `until` at the
   * latest, then the session ends, and with `delete` its saved chat goes too. Tabs leave such sessions out.
   */
  closing?: { delete: boolean; until: string };
  /**
   * Opened from its saved chat with no Claude, as its tab came back while its sandbox was stopped: Kumiko doesn't
   * start a sandbox for that on its own. Its status is `ended` until the sandbox runs and Claude continues it.
   */
  asleep?: boolean;
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
 * One entry in a session's event buffer. `claude` carries a raw stream-json line from Claude; the rest are Kumiko's:
 * the prompts we sent (each tagged with an `id` that Claude knows it by, so it can be rewound to), Stop being pressed, errors (SSH, `claude` missing or signed out, a crash) and the end.
 */
export type SessionEvent =
  | { seq: number; kind: "claude"; payload: Record<string, unknown> & { type: string } }
  | { seq: number; kind: "user_prompt"; payload: { text: string; id: string; attachments?: Attachment[] } }
  | { seq: number; kind: "interrupt"; payload: Record<string, never> }
  /** `signedOut`: Claude isn't logged in, so the UI offers to log in instead of only showing the message. */
  | { seq: number; kind: "error"; payload: { message: string; hint?: string; stderr?: string[]; signedOut?: boolean } }
  | { seq: number; kind: "ended"; payload: { reason: EndReason; code?: number } }
  /** A change to the session's window. `toolUseId`: the tool call of Claude's that made it, if one did. */
  | { seq: number; kind: "window"; payload: { op: WindowOp; toolUseId?: string } }
  /**
   * Claude asking, with its tool call `toolUseId`, to start a new session in the project on `prompt`, with copies of
   * the artifacts whose files are `artifacts` (paths in the VM); see `proposal_answer`.
   */
  | { seq: number; kind: "proposal"; payload: { id: string; prompt: string; title?: string; artifacts?: string[]; toolUseId?: string } }
  /** The user's answer to proposal `id`: accepted, starting `session` (on `prompt`, when they changed Claude's), or declined. */
  | { seq: number; kind: "proposal_answer"; payload: { id: string; accepted: boolean; session?: string; prompt?: string } }
  /**
   * Session `from`, named `name` then, sharing copies of artifacts with this one (its artifact_share tool): their files
   * in this session's folder. Claude is told with the user's next message; see `sharesWaiting`.
   */
  | { seq: number; kind: "shared"; payload: { from: string; name: string; artifacts: { path: string; title: string }[] } };

/** A prompt that is one of Claude's commands, such as /model, to which nothing can be added. */
export const isCommand = (text: string) => text.trimStart().startsWith("/");

/** The shares Claude hasn't been told of yet: those since the last prompt that wasn't a command. */
export function sharesWaiting(events: readonly SessionEvent[]): Extract<SessionEvent, { kind: "shared" }>[] {
  const waiting: Extract<SessionEvent, { kind: "shared" }>[] = [];
  for (const e of events) {
    if (e.kind === "shared") waiting.push(e);
    else if (e.kind === "user_prompt" && !isCommand(e.payload.text)) waiting.length = 0;
  }
  return waiting;
}

/** What Claude is told, after the user's message, of artifacts other sessions shared with this one meanwhile. */
export function sharedNote(shares: readonly Extract<SessionEvent, { kind: "shared" }>[]): string {
  if (!shares.length) return "";
  const each = shares.map((s) => `session "${s.payload.name}" (${s.payload.from}) shared ${s.payload.artifacts.map((a) => `"${a.title}", now at ${a.path}`).join("; ")}`);
  return `\n\n(From Kumiko: since your last message, ${each.join("; and ")}. These are copies in your artifacts folder, and your window has them.)`;
}

/**
 * What a session's event socket sends: its events, and once it has replayed the ones it already had, `caught_up`,
 * so a tab can show the history in one go rather than as if it were happening. `buffer` names the buffer the events'
 * `seq`s count in; a tab reconnecting with `?after=<seq>&buffer=<it>` to one that has been replaced since (a rewind, or
 * a server restart and a resume, which number the events afresh) is closed with 4409, to replay it from the start.
 */
export type SessionStreamMessage = SessionEvent | { kind: "caught_up"; buffer: string };

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

/** Opens a saved session again. */
export interface ResumeRequest {
  /**
   * With `false`, a session whose sandbox is stopped opens asleep (see `SessionInfo.asleep`) instead of starting the
   * sandbox: for tabs coming back on their own, rather than at the user's asking.
   */
  start?: boolean;
}

/** Starts a new session from a copy of a session's conversation. */
export interface ForkRequest {
  /** Copy the conversation only up to the end of this prompt's turn; all of it when omitted. */
  prompt?: string;
}

export interface RewindResponse {
  /** The prompt that was rewound to, to be edited and sent again. */
  text: string;
  /** The files that went with it; sent again by their `hash`. */
  attachments?: Attachment[];
}

/**
 * The kinds of file Claude reads itself when they come with a prompt: images it looks at, PDFs, and text. Anything
 * else would need to be a file in the sandbox, for a tool to open.
 */
export type AttachmentKind = "image" | "pdf" | "text";

/** A file sent with a prompt, as the session keeps it: the bytes stay on the server, under `hash` (their SHA-256). */
export interface Attachment {
  name: string;
  kind: AttachmentKind;
  mediaType: string;
  size: number;
  hash: string;
}

/** A file to send with a prompt: a new one with its bytes in base64, or one the server has already, by its `hash`. */
export type AttachmentInput = { name: string; data: string } | { name: string; hash: string };

/**
 * The most a file of each kind may be. The API's own limit for an image is 5 MB. Text is read whole into the context,
 * and every file goes to the API again with each later turn, so they are kept well short of its 32 MB per request.
 */
export const ATTACHMENT_LIMITS: Record<AttachmentKind, number> = { image: 5 * 1024 * 1024, pdf: 10 * 1024 * 1024, text: 256 * 1024 };

/** The most all the files of one prompt may add up to. */
export const ATTACHMENTS_TOTAL_LIMIT = 20 * 1024 * 1024;

/** "256 KB", "5 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;
}

// Both browsers and Node have it; this package is built without either's types.
declare const TextDecoder: new (label: string, options: { fatal: boolean }) => { decode(bytes: Uint8Array): string };

const startsWith = (bytes: Uint8Array, sig: string, at = 0) => [...sig].every((c, i) => bytes[at + i] === c.charCodeAt(0));

/**
 * What a file is, from its bytes rather than its name or the type the browser guessed: an image or a PDF by its
 * signature, text if it is UTF-8 without NULs. Undefined for anything else.
 */
export function attachmentKind(bytes: Uint8Array): { kind: AttachmentKind; mediaType: string } | undefined {
  if (startsWith(bytes, "\x89PNG\r\n\x1a\n")) return { kind: "image", mediaType: "image/png" };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { kind: "image", mediaType: "image/jpeg" };
  if (startsWith(bytes, "GIF87a") || startsWith(bytes, "GIF89a")) return { kind: "image", mediaType: "image/gif" };
  if (startsWith(bytes, "RIFF") && startsWith(bytes, "WEBP", 8)) return { kind: "image", mediaType: "image/webp" };
  if (startsWith(bytes, "%PDF-")) return { kind: "pdf", mediaType: "application/pdf" };
  if (bytes.includes(0)) return undefined;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { kind: "text", mediaType: "text/plain" };
  } catch {
    return undefined;
  }
}

/** Why a file can't go with a prompt, or what it is if it can. */
export function checkAttachment(name: string, bytes: Uint8Array): { kind: AttachmentKind; mediaType: string } | { error: string } {
  if (bytes.length === 0) return { error: `${name} is empty.` };
  const what = attachmentKind(bytes);
  if (!what) return { error: `${name} can't be attached: only images, PDFs and text files can.` };
  const max = ATTACHMENT_LIMITS[what.kind];
  if (bytes.length > max) return { error: `${name} is too big to attach: ${formatBytes(bytes.length)}, and ${what.kind === "text" ? "a text file" : what.kind === "pdf" ? "a PDF" : "an image"} can be ${formatBytes(max)} at most.` };
  return what;
}

/** A prompt for a running session. */
export interface PromptRequest {
  text: string;
  attachments?: AttachmentInput[];
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
  attachments?: AttachmentInput[];
  /** A model alias to start with; Claude's default when omitted. */
  model?: string;
}

/** A session saved on disk that can be resumed: closed, or left behind when Kumiko quit. */
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
  /**
   * Asks the window showing session `session`, for Claude, to load the page in pane `pane` again (`reload`, waiting for
   * it to load), then to take a picture of the pane as it is on screen (`capture`), `wait` ms later, and to answer
   * `POST /api/sessions/:session/window/answer` with `request`: the picture, or nothing, or why it couldn't.
   */
  | { type: "pane"; session: string; pane: string; request: string; reload: boolean; capture: boolean; wait: number }
  | { sandbox: string; op: OpKind; type: "state"; data: Operation }
  | { sandbox: string; op: OpKind; type: "log"; data: LogLine }
  | { sandbox: string; op: OpKind; type: "done"; data: Operation }
  | { sandbox: string; op: OpKind; type: "error"; data: Operation };

export function vmName(name: string): string {
  return VM_PREFIX + name;
}
