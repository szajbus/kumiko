// Types shared by the sandbox adapter, the server and the web UI.
// Nothing in here may import Node or browser APIs.

export * from "./window.js";
export * from "./asks.js";
export * from "./cards.js";
export * from "./userShell.js";
export * from "./review.js";
import type { WindowOp } from "./window.js";
import type { AgentAsk, AskAnswer, AskClosedReason } from "./asks.js";
import type { ApprovalCard } from "./cards.js";
import type { ShellChunk, ShellStop } from "./userShell.js";

export const VM_PREFIX = "kumiko-";

/** Short sandbox names: lowercase letters, digits and dashes, not starting or ending with a dash. */
export const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;

/** Kumiko's own session ids (not Claude's): lowercase hex. Checked before an id names a file or a socket. */
export const SESSION_ID_PATTERN = /^[0-9a-f]{1,64}$/;

/** Variable names that can be forwarded from the host. */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const DEFAULTS = { cpus: 4, memoryGiB: 4, diskGiB: 100, workspaceGiB: 50 } as const;

/** The smallest resources a sandbox can have. */
export const MINIMUMS = { cpus: 1, memoryGiB: 1, diskGiB: 10, workspaceGiB: 1 } as const;

/** The sandbox's workspace disk in the VM, and where every session starts: its repos are cloned here. */
export const WORKSPACE_DIR = "/workspace";

/**
 * Where a sandbox's Claude home is mounted in its VM, and what CLAUDE_CONFIG_DIR points at there. Set on every
 * command Kumiko runs in a VM and in every shell, so Claude keeps `.claude.json` inside the mount too.
 */
export const CLAUDE_HOME_IN_VM = "~/.claude";

/**
 * Kumiko's folder in a VM: `local/` on the VM's own disk, for what must stay there (agents' runs, whose FIFOs don't
 * cross virtiofs), and `shared/`, the sandbox's Kumiko folder mounted from the host.
 */
export const KUMIKO_DIR_IN_VM = "~/.kumiko";

/**
 * Where a sandbox's Kumiko folder is in its VM, whatever else: what Kumiko and the agent keep for Kumiko, such as the
 * agent's setup scripts and sessions' artifacts. Kept out of the Claude home, which is Claude Code's to change. The
 * folder is mounted at its path on the host, so a path in it is the same in the VM and on the user's computer, and this
 * is a link to it (`Mount.alias`). Sandboxes made before, and ones with an extra mount in the way, mount it here.
 */
export const KUMIKO_HOME_IN_VM = `${KUMIKO_DIR_IN_VM}/shared`;

/** The folder beside a repo's clone in /workspace that holds its worktrees: `<folder>__worktrees`. */
export const WORKTREES_SUFFIX = "__worktrees";

export interface Mount {
  hostPath: string;
  writable: boolean;
  /** Where the folder appears in the VM; "~/…" is the VM user's home. Omitted: the same path as on the host. */
  guestPath?: string;
  /** Another path in the VM that leads to it: a link Kumiko makes on every start. Only Kumiko's own mounts have one. */
  alias?: string;
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
  const key = (ms: Mount[]) => JSON.stringify(ms.map((m) => [m.hostPath, m.guestPath ?? m.hostPath, m.writable, m.alias ?? null]));
  return key(a) === key(b);
}

/** The window's tabs as they were, to bring back on the next start. Kept by the server: the desktop app's port, and
 * with it the page's origin and localStorage, changes every launch. */
export interface SavedTabs {
  /** Session ids in tab order. */
  sessions: string[];
  /** One per New session tab, in tab order: the sandbox picked in it, or "" for none. */
  newSessions: string[];
  /** The active tab's id, as the UI names it. */
  active: string;
  /** The tabs after Sandboxes in the order they were dragged into, named as `active` is. */
  order: string[];
  /** The sandboxes whose tabs are collapsed behind their label. */
  collapsed?: string[];
}

/** The saved tabs in `v`, or undefined if it isn't saved tabs. Session ids that can't be ids are dropped. */
export function parseSavedTabs(v: unknown): SavedTabs | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const { sessions, newSessions, active, order, collapsed } = v as Partial<Record<keyof SavedTabs, unknown>>;
  if (!Array.isArray(sessions) || !Array.isArray(newSessions) || !Array.isArray(order) || typeof active !== "string" || active.length > 100) return undefined;
  const ids = sessions.filter((x): x is string => typeof x === "string" && SESSION_ID_PATTERN.test(x));
  const picked = newSessions.filter((x): x is string => typeof x === "string").map((x) => (NAME_PATTERN.test(x) ? x : ""));
  const tabs = order.filter((x): x is string => typeof x === "string" && x.length <= 100);
  // Saved before tabs could collapse: none are.
  const folded = Array.isArray(collapsed) ? collapsed.filter((x): x is string => typeof x === "string" && NAME_PATTERN.test(x)) : [];
  return { sessions: ids.slice(0, 200), newSessions: picked.slice(0, 50), active, order: tabs.slice(0, 250), collapsed: folded.slice(0, 100) };
}

/** What the UI needs from the host. */
export interface DefaultsResponse {
  /** The host user's home, so the UI can show paths as ~/…. */
  home: string;
  /** The folder holding each sandbox's Claude home, as `<claudeHomes>/<sandbox>`. */
  claudeHomes: string;
  /** The folder holding each sandbox's Kumiko folder, as `<kumikoHomes>/<sandbox>`. */
  kumikoHomes: string;
}

export interface SandboxSpec {
  name: string;            // short name, letters/digits/dashes; the VM is "kumiko-<name>"
  template?: string;       // adapter-specific; Lima default "template:default"
  cpus: number;
  memoryGiB: number;
  diskGiB: number;
  /**
   * The size of the sandbox's workspace disk: a Lima disk of its own, mounted at /workspace, which outlives the VM. It
   * is kept when the VM is recreated and deleted with the sandbox. Missing: no workspace disk.
   */
  workspaceGiB?: number;
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
export type EditSpec = Partial<Pick<SandboxSpec, "cpus" | "memoryGiB" | "diskGiB" | "workspaceGiB" | "mounts" | "env" | "provision" | "workdir" | "hostLoopback">>;

/** A spec as validated, which has its defaults filled in. */
export type ValidSpec = SandboxSpec & { workdir: string };

/** `absent`: a sandbox whose VM doesn't exist (its creation failed, or it was deleted outside Kumiko). */
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
 * Where the agent keeps its setup scripts, in the sandbox's Kumiko folder: `*.sh` files run in name order after the
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

/** GET /api/sandboxes/:name/agent-setup: the scripts as they are now, each with how it went when the VM was created, if it ran as it is now. */
export interface AgentSetupResponse {
  scripts: AgentScript[];
  /** Files in the folder Kumiko won't run: not named `*.sh`, not plain files, or too big. */
  ignored: string[];
}

export interface SandboxInfo {
  name: string;            // short name, without "kumiko-"
  status: SandboxStatus;
  cpus?: number; memoryGiB?: number; diskGiB?: number;
  /** The workspace disk's size, as Lima has it; missing when the sandbox has none, or it is gone. */
  workspaceGiB?: number;
  /** Kumiko's metadata, when this sandbox was created by Kumiko. */
  meta?: SandboxMeta;
  /** Set when Kumiko has a record of this sandbox that it can't read; `meta` is then missing. */
  metaError?: string;
  /** Set when the sandbox can reach the host's loopback though its spec says it shouldn't: why that isn't blocked. */
  hostLoopbackOpen?: string;
}

/** What a running sandbox is using right now, as the VM itself sees it. */
export interface SandboxStats {
  /** How busy its CPUs were since the reading before, 0–100 across all of them; missing on the first reading. */
  cpuPercent?: number;
  /** The 1-minute load average. */
  load: number;
  memTotalBytes: number;
  /** Total less what's available, so the page cache doesn't count. */
  memUsedBytes: number;
  /** The VM's root filesystem; folders mounted from the host aren't on it. */
  diskUsedBytes: number;
  diskFreeBytes: number;
  /** The workspace disk at /workspace; missing when the VM has none mounted there. */
  workspaceUsedBytes?: number;
  workspaceFreeBytes?: number;
}

/**
 * `GET /api/sessions/:id/disk`: what a session keeps on the host, in bytes: its saved chat, its artifacts' folder, and
 * the attachments and artifact versions its chat names, which other sessions (its forks) may name too.
 */
export interface SessionDisk {
  chat: number;
  artifacts: number;
  files: number;
}

/** `GET /api/stats`: the latest reading of each running sandbox, by name; one with none yet is left out. */
export type StatsResponse = Record<string, SandboxStats>;

export type OpKind ="creating" | "starting" | "stopping" | "deleting" | "recreating" | "restarting" | "editing";

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

/** A VM as the UI sees it: Lima's view merged with metadata and the current or last operation. */
export interface VmView extends SandboxInfo {
  vm: string;
  provider: "lima";
  /** The running operation, or the last finished one. */
  operation?: Operation;
  busy: boolean;
  /** Live agent sessions in this sandbox. */
  sessions: number;
}

// ---- sandboxes ------------------------------------------------------------------------------

/** A repo of a sandbox: a GitHub repository with a mirror on the host, cloned in the VM at `/workspace/<folder>`. */
export interface SandboxRepo {
  /** "owner/name", as GitHub spells it. */
  repo: string;
  /** Its folder in /workspace, given when it was added and never changed; its worktrees go in `<folder>__worktrees`. */
  folder: string;
}

/**
 * A sandbox: a VM of its own for Claude, with a Claude home, a Kumiko folder, and the repos cloned on its workspace
 * disk. Its name is also its VM's, as `kumiko-<name>`. Saved in Kumiko's home as `workspaces/<name>.json`.
 */
export interface Sandbox {
  name: string;
  createdAt: string;
  repos: SandboxRepo[];
  /**
   * Folders of repos taken out of the sandbox while its VM was stopped, deleted from /workspace when it next starts.
   * Their names aren't given to another repo meanwhile.
   */
  dropped?: string[];
}

/**
 * The folder a repo gets in /workspace: its name, unless `taken` has that, then `owner-name`, then with a number.
 * Folders already given keep theirs, so only the newcomer is renamed. Case is ignored, as the Mac's file system does.
 */
export function repoFolder(repo: string, taken: Iterable<string>): string {
  const p = parseRepo(repo);
  if (!p) throw new Error(`Not a repository: ${repo}`);
  // Each folder comes with its worktrees folder beside it: a newcomer can't be either, nor have its own be either.
  const used = new Set([...taken].flatMap((t) => [t.toLowerCase(), `${t}${WORKTREES_SUFFIX}`.toLowerCase()]));
  const free = (f: string) => !used.has(f.toLowerCase()) && !used.has(`${f}${WORKTREES_SUFFIX}`.toLowerCase());
  for (const f of [p.name, `${p.owner}-${p.name}`]) if (free(f)) return f;
  for (let n = 2; ; n++) {
    const f = `${p.owner}-${p.name}-${n}`;
    if (free(f)) return f;
  }
}

/**
 * The folders for repos picked together: each its name, but every repo whose name another of them shares gets its
 * owner in front, so neither depends on the order they were picked in. `kept` are folders given before, and
 * `reserved` folders no repo may have, such as those still to be deleted.
 */
export function repoFolders(repos: string[], kept: SandboxRepo[] = [], reserved: string[] = []): SandboxRepo[] {
  const names = repos.map((r) => parseRepo(r)?.name.toLowerCase());
  const out = [...kept];
  for (const [i, repo] of repos.entries()) {
    if (kept.some((k) => k.repo.toLowerCase() === repo.toLowerCase())) continue;
    const shared = names.filter((n) => n === names[i]).length > 1;
    const p = parseRepo(repo);
    if (!p) throw new Error(`Not a repository: ${repo}`);
    const taken = [...reserved, ...out.map((o) => o.folder), ...(shared ? [p.name] : [])];
    out.push({ repo, folder: repoFolder(repo, taken) });
  }
  return out;
}

/**
 * Which of the mounts every sandbox's VM has this one is, if any: the Claude home at ~/.claude and the Kumiko folder,
 * at its host path with ~/.kumiko/shared linking to it, or at ~/.kumiko/shared itself. With `homes`, their host folders
 * must match too.
 */
export function sandboxMountRole(m: Mount, homes?: { claude: string; kumiko: string }): "claude-home" | "kumiko-home" | undefined {
  const guest = m.guestPath ?? m.hostPath;
  if (guest === CLAUDE_HOME_IN_VM && (homes === undefined || m.hostPath === homes.claude)) return "claude-home";
  if ((guest === KUMIKO_HOME_IN_VM || m.alias === KUMIKO_HOME_IN_VM) && (homes === undefined || m.hostPath === homes.kumiko)) return "kumiko-home";
  return undefined;
}

/**
 * Where the sandbox's Kumiko folder is in its VM, as `mounts` (its spec's) have it: its host path, or ~/.kumiko/shared
 * for a sandbox that mounts it there. Undefined if none of them is the Kumiko folder.
 */
export function kumikoFolderInVm(mounts: Mount[]): string | undefined {
  const m = mounts.find((x) => sandboxMountRole(x) === "kumiko-home");
  return m && (m.guestPath ?? m.hostPath);
}

/** How a repo's clone in the VM is, as Kumiko last found it. */
export interface RepoState extends SandboxRepo {
  /** `pending` until Kumiko has looked: while the VM is stopped, or git can't reach the mirrors yet. */
  state: "pending" | "cloning" | "cloned" | "failed";
  /** Why the clone failed, or, while it is pending, why git in the VM can't reach the mirrors. */
  error?: string;
}

/** A sandbox as the UI sees it: its VM's view, plus the sandbox itself and what needs the user. */
export interface SandboxView extends VmView {
  sandbox: Sandbox;
  /** Its repos, with how each one's clone is. */
  repos: RepoState[];
  /** Sessions in this sandbox that are waiting on the user. */
  waiting: number;
  /**
   * The places in its VM that are folders on this Mac (mount points, and links to them such as ~/.kumiko/shared), as
   * paths in the VM: a file under one can be shown in the Finder.
   */
  shared?: string[];
}

/** Work in one repo of a sandbox that only its VM has: lost if its folder goes, or the workspace disk. */
export interface RepoUnpushed extends SandboxRepo {
  /** Local branches with commits that aren't on their upstream, or on no remote at all when they have none. */
  branches: { name: string; ahead: number; upstream?: string }[];
  /** Worktrees, the clone included, with uncommitted changes (untracked files count), as paths in the VM. */
  dirty: { worktree: string; files: number }[];
  stashes: number;
  /** Why the repo couldn't be looked at: its folder is gone, or git failed there. */
  error?: string;
}

/** `GET /api/sandboxes/:name/unpushed`: what a running sandbox's VM has that isn't pushed, repo by repo. */
export interface UnpushedResponse {
  repos: RepoUnpushed[];
}

/** Whether there is anything in `u` that would be lost. */
export const hasUnpushed = (u: RepoUnpushed) => u.branches.length > 0 || u.dirty.length > 0 || u.stashes > 0;

/** Creates a sandbox. Everything but `name` and `repos` is the VM's spec; the workspace disk is always there. */
export type CreateSandboxRequest = Omit<SandboxSpec, "workdir" | "workspaceGiB"> & {
  workspaceGiB: number;
  /** "owner/name" of each repo, picked from the mirrors. */
  repos: string[];
};

/**
 * What can change on a sandbox: its VM's spec, as for any VM, and its repos. `mounts` are the extra ones only; the
 * Claude home and Kumiko folder mounts are always there. `repos` is the whole list: new ones are cloned.
 */
export type SandboxEdit = Omit<EditSpec, "workdir"> & { repos?: string[] };

// ---- agent sessions -------------------------------------------------------------------------

/** `starting` until Claude answers, `running` during a turn, `idle` between turns; `ended` and `failed` are final. */
export type SessionStatus = "starting" | "idle" | "running" | "ended" | "failed";

export const LIVE_SESSION_STATUSES: readonly SessionStatus[] = ["starting", "idle", "running"];

export interface SessionInfo {
  id: string;
  /** The sandbox's name (without "kumiko-"). */
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
   * No Claude for now, as its sandbox is stopped: it stopped with the sandbox, or its tab came back while the sandbox
   * was stopped, which Kumiko doesn't start on its own for that. Its status is `ended` until the sandbox runs, however
   * it is started, and Claude continues it.
   */
  asleep?: boolean;
  /** Subagents Claude started in the background that are still working, its turn over or not; none when missing. */
  agents?: number;
  /**
   * Shells and monitors Claude left running in the background; none when missing. Unlike subagents, they aren't work:
   * a dev server can run for as long as Claude lets it without the session being busy.
   */
  shells?: number;
  /** Claude waits, mid-turn, for the user to answer its questions or approve its plan; see the `ask` event. */
  asking?: AgentAsk["kind"];
  /**
   * Cards in the chat waiting for the user's decision: what Claude asks (questions, a plan, an approval) and its
   * proposals to start a new session, which it doesn't wait on; none when missing.
   */
  cards?: number;
  /** Claude is in plan mode: it plans, and waits for the user to approve the plan before it changes anything. */
  planMode?: boolean;
}

/**
 * Whether a session is waiting on the user: Claude asked something mid-turn, or it finished (or the session stopped by
 * itself) and nobody has looked since.
 */
export function isWaiting(s: SessionInfo): boolean {
  return s.asking !== undefined || (s.unread === true && !isBusy(s));
}

/**
 * Whether Claude is at work in a session: on a turn, or with subagents it left working in the background after one.
 * Once those finish, Claude takes a turn of its own to report on them. A turn that waits on the user's answer isn't
 * work: nothing happens until they answer.
 */
export function isBusy(s: SessionInfo): boolean {
  if (s.asking !== undefined) return false;
  return s.status === "running" || s.status === "starting" || (s.status === "idle" && (s.agents ?? 0) > 0);
}

/** Why a session ended: its tab closing, its sandbox stopping, the app quitting, or the process exiting by itself. */
export type EndReason = "user" | "sandbox" | "quit" | "exit";

/**
 * One entry in a session's event buffer. `claude` carries a raw stream-json line from Claude; the rest are Kumiko's:
 * the prompts we sent (each tagged with an `id` that Claude knows it by, so it can be rewound to), Stop being pressed, errors (SSH, `claude` missing or signed out, a crash) and the end.
 */
export type SessionEvent =
  | { seq: number; kind: "claude"; payload: Record<string, unknown> & { type: string } }
  /** `shell`: the id of the `user_shell` this prompt gives Claude, its `text` being "!" and the command. */
  | { seq: number; kind: "user_prompt"; payload: { text: string; id: string; attachments?: Attachment[]; shell?: string } }
  /** Prompt `id`, sent while Claude worked, taken back before Claude read it, to be edited: it never runs. */
  | { seq: number; kind: "prompt_withdrawn"; payload: { id: string } }
  | { seq: number; kind: "interrupt"; payload: Record<string, never> }
  /** `signedOut`: Claude isn't logged in, so the UI offers to log in instead of only showing the message. */
  | { seq: number; kind: "error"; payload: { message: string; hint?: string; stderr?: string[]; signedOut?: boolean } }
  /** `asleep`: it stopped with its sandbox, and continues once that runs again (see `SessionInfo.asleep`). */
  | { seq: number; kind: "ended"; payload: { reason: EndReason; code?: number; asleep?: boolean } }
  /** A change to the session's window. `toolUseId`: the tool call of Claude's that made it, if one did. */
  | { seq: number; kind: "window"; payload: { op: WindowOp; toolUseId?: string } }
  /**
   * Claude asking, with its tool call `toolUseId`, to start a new session in the sandbox on `prompt`, with copies of
   * the artifacts whose files are `artifacts` (paths in the VM); see `proposal_answer`.
   */
  | { seq: number; kind: "proposal"; payload: { id: string; prompt: string; title?: string; artifacts?: string[]; toolUseId?: string } }
  /** The user's answer to proposal `id`: accepted, starting `session` (on `prompt`, when they changed Claude's), or declined. */
  | { seq: number; kind: "proposal_answer"; payload: { id: string; accepted: boolean; session?: string; prompt?: string } }
  /**
   * Session `from`, named `name` then, sharing copies of artifacts with this one (its artifact_share tool): their files
   * in this session's folder. Claude is told with the user's next message; see `sharesWaiting`.
   */
  | { seq: number; kind: "shared"; payload: { from: string; name: string; artifacts: { path: string; title: string }[] } }
  /** Claude asking the user something mid-turn, and waiting for the answer: see `ask_answer` and `ask_closed`. */
  | { seq: number; kind: "ask"; payload: AgentAsk }
  | { seq: number; kind: "ask_answer"; payload: { id: string; answer: AskAnswer } }
  /** Claude stopped waiting for ask `id` without an answer. */
  | { seq: number; kind: "ask_closed"; payload: { id: string; reason: AskClosedReason } }
  /** The card for an approval ask, whole, each time it changes; the latest for an id is how it is. */
  | { seq: number; kind: "card"; payload: ApprovalCard }
  /**
   * The end of what background task `taskId` (Claude's id: a shell or a monitor) printed, read once it ended, so it can
   * still be read once Claude, which keeps it, is gone. `totalBytes` it printed in all; `truncated` if this is only the end.
   */
  | { seq: number; kind: "task_output"; payload: { taskId: string; output: string; totalBytes: number; truncated: boolean } }
  /** The user stopped background task `taskId`; Claude's own report of it follows, and Claude hears of it with the next prompt. */
  | { seq: number; kind: "task_stop"; payload: { taskId: string } }
  /**
   * Background tasks the last Claude process reported started but never ended, gone with it as a new one starts: it
   * was killed, or crashed. By Claude's task ids.
   */
  | { seq: number; kind: "tasks_lost"; payload: { taskIds: string[] } }
  /**
   * What woke Claude for a turn of its own: monitor `taskId` printed `line`. `at` is the seq of the event that started
   * that turn (Claude's init), as this comes once the turn is under way; missing in events recorded before it was added.
   */
  | { seq: number; kind: "monitor_event"; payload: { taskId: string; line: string; at?: number } }
  /**
   * The user running `command` in the sandbox, in `cwd`, from `startedAt` on: a message starting with "!". Its output
   * follows, then its end, and then the prompt that gives Claude both (a `user_prompt` naming it as its `shell`).
   */
  | { seq: number; kind: "user_shell"; payload: { id: string; command: string; cwd: string; startedAt: string } }
  /**
   * Some of what command `id` printed, as it ran, `at` characters into its output. Past the start the chat keeps, only
   * the latest are kept, so one can come after a gap. All are dropped once it ends, whose event keeps what the chat shows.
   */
  | { seq: number; kind: "user_shell_output"; payload: { id: string; chunk: ShellChunk; at: number } }
  /**
   * Command `id` ended: with exit `code`, or `stopped`, or with an `error` if it couldn't run. `output` is what the chat
   * keeps of what it printed, `cut` characters having been left out of its middle; `log` the file in the sandbox with
   * all of it, written when Claude couldn't get all of it. `alone` when Claude doesn't get it: its session ended, or is
   * closing, or Kumiko lost it; otherwise the prompt that gives it to Claude follows, once Claude isn't waiting on an
   * answer from the user.
   */
  | { seq: number; kind: "user_shell_end"; payload: { id: string; code?: number; stopped?: ShellStop; error?: string; durationMs: number; output: ShellChunk[]; cut: number; log?: string; alone?: true } }
  /** How full Claude's context is, as it said when asked: at the start, and after each turn and compaction. */
  | { seq: number; kind: "context"; payload: ContextUsage };

/**
 * How full the agent's context is. `tokens` of a `window`; with auto-compaction on, Claude compacts the conversation by
 * itself once `tokens` reach `threshold`.
 */
export interface ContextUsage {
  tokens: number;
  window: number;
  autoCompact: boolean;
  threshold?: number;
}

/**
 * Whether one of Claude's stream-json messages is the summary a compaction leaves: a synthetic user message, in Claude
 * Code's own words. Chats saved before Kumiko kept Claude's `compact_boundary` messages only have this to say where one was.
 */
export function isCompactSummary(m: Record<string, unknown>): boolean {
  if (m.type !== "user" || m.isSynthetic !== true || m.isReplay === true) return false;
  const content = (m.message as { content?: unknown } | undefined)?.content;
  const first = Array.isArray(content) ? (content[0] as { text?: unknown } | undefined)?.text : content;
  return typeof first === "string" && first.startsWith(COMPACT_SUMMARY_START);
}
const COMPACT_SUMMARY_START = "This session is being continued from a previous conversation";

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

/** Who Claude is logged in as in a sandbox's Claude home. */
export interface LoginAccount {
  email?: string;
  /** The subscription plan, e.g. "max" or "pro". */
  plan?: string;
}

/**
 * Starting a login from a session: the page to sign in on, after which Claude shows a code to paste back; or, when
 * the sandbox is logged in already (from another session, say), who it is logged in as.
 */
export type LoginStartResponse = { url: string } | { loggedIn: LoginAccount };

/** Whether a sandbox's Claude is logged in now; `loggedIn` is missing when it isn't, or its sandbox isn't running. */
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
 * The most a file of each kind may be. The API's own limit for an image is 5 MB, and a PDF is kept a little under the
 * whole of a prompt's files.
 */
export const ATTACHMENT_LIMITS: Record<AttachmentKind, number> = { image: 5 * 1024 * 1024, pdf: 20 * 1024 * 1024, text: 10 * 1024 * 1024 };

/**
 * The most all the files of one prompt may add up to: in base64 they are a third more, which brings 24 MB to the API's
 * 32 MB per request. Every file goes to the API again with each later turn, so a session that has sent this much once
 * can still go past it.
 */
export const ATTACHMENTS_TOTAL_LIMIT = 24 * 1024 * 1024;

/**
 * How much of a background task's output Show all reads from Claude's file of it: the start of a longer one. More makes
 * the Tasks pane stall as it lays the text out.
 */
export const TASK_FILE_BYTES = 1024 * 1024;

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

/** Runs `command` in the session's sandbox, as a message starting with "!" does; answered with the run's id. */
export interface ShellRequest {
  command: string;
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
  /** The sandbox's name. */
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
  /** The sandbox's name. */
  name: string;
  warnings: string[];
}

export interface ApiError {
  error: string;
  details?: string[];
}

/** Messages on the /api/events WebSocket. */
export type ServerEvent =
  /** `error`: the VMs couldn't be listed. `unreadable`: why each sandbox record that can't be used can't be. */
  | { type: "snapshot"; sandboxes: SandboxView[]; unreadable: string[]; logs: Record<string, LogLine[]>; sessions: SessionInfo[]; error?: string; mirrors?: MirrorsResponse }
  | { type: "list"; sandboxes: SandboxView[]; unreadable: string[]; error?: string }
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
  | { sandbox: string; op: OpKind; type: "error"; data: Operation }
  /** Sent whenever a repository mirror is added, removed, or starts or ends a fetch. */
  | ({ type: "mirrors" } & MirrorsResponse);

export function vmName(name: string): string {
  return VM_PREFIX + name;
}

/** The Lima disk holding a sandbox's /workspace, which outlives its VM. */
export function workspaceDiskName(name: string): string {
  return `${vmName(name)}-workspace`;
}

/** A GitHub account or organization name: letters, digits and single dashes, up to 39 characters. */
export const REPO_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** A GitHub repository's name, without ".git", which GitHub drops; "." and ".." aren't names. */
export const REPO_NAME_PATTERN = /^(?!\.\.?$)(?!.*\.git$)[A-Za-z0-9._-]{1,100}$/i;

/**
 * A repository as "owner/name", checked, since it names folders on the host; undefined when it isn't one.
 * GitHub ignores case in both parts, and so does the Mac's file system, so `key` is the lowercase form.
 */
export function parseRepo(repo: unknown): { owner: string; name: string; repo: string; key: string } | undefined {
  if (typeof repo !== "string") return undefined;
  const m = /^([^/]+)\/([^/]+)$/.exec(repo);
  if (!m || !REPO_OWNER_PATTERN.test(m[1]) || !REPO_NAME_PATTERN.test(m[2])) return undefined;
  return { owner: m[1], name: m[2], repo, key: repo.toLowerCase() };
}

/**
 * The GitHub repository a git remote URL names, in any of the forms git accepts for github.com: scp-like SSH, ssh://
 * and https://, with or without ".git". Undefined for anything else.
 */
export function repoFromRemote(url: unknown): ReturnType<typeof parseRepo> {
  if (typeof url !== "string") return undefined;
  const m = /^(?:git@github\.com:|ssh:\/\/git@github\.com(?::22)?\/|https:\/\/(?:[^@/]+@)?github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? parseRepo(m[1]) : undefined;
}

/** A repository mirror as the Repos page shows it. */
export interface MirrorView {
  /** "owner/name", as GitHub spells it. */
  repo: string;
  /** The bare repository on the host. */
  path: string;
  addedAt: string;
  private?: boolean;
  /** `cloning` until the first fetch has worked, `fetching` during a later one. */
  state: "cloning" | "fetching" | "ready" | "failed";
  /** When the fetch under way started. */
  startedAt?: string;
  /** When the last fetch that worked ended. */
  fetchedAt?: string;
  /** Why the last fetch failed, and when; cleared by one that works. */
  error?: { message: string; at: string };
  /** On disk, in bytes, as of the last fetch or gc. */
  size?: number;
  branches?: number;
  tags?: number;
}

export interface MirrorsResponse {
  mirrors: MirrorView[];
  /** Why Kumiko's list of repositories couldn't be read when it started. */
  error?: string;
}

/** The GitHub account of the `gh` CLI on the host, which lists the repos to pick from. */
export type GitHubAccount =
  /** `id`: the account's number, which its noreply email address starts with. */
  | { status: "signed-in"; login: string; id?: number; name?: string; avatarUrl?: string }
  /** gh isn't installed, or isn't on Kumiko's PATH. */
  | { status: "missing" }
  /** `detail`: what `gh auth status` said. */
  | { status: "signed-out"; detail?: string }
  /** gh is there and signed in, but asking it failed. */
  | { status: "error"; detail: string };

/** One of the user's GitHub repositories, as the picker lists them. */
export interface GitHubRepo {
  repo: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  description?: string;
  pushedAt?: string;
}

export interface GitHubReposResponse {
  repos: GitHubRepo[];
}

export interface AddMirrorRequest {
  repo: string;
  private?: boolean;
}
