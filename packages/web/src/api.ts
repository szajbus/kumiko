import { useEffect, useRef, useState } from "react";
import type {
  AddMirrorRequest,
  AgentSetupResponse,
  GitHubAccount,
  GitHubReposResponse,
  MirrorView,
  MirrorsResponse,
  AskAnswer,
  AccountUsage,
  AttachmentInput,
  ApiError,
  CreateSandboxRequest,
  CreateResponse,
  DefaultsResponse,
  ForkRequest,
  LoginAccount,
  LoginStartResponse,
  LoginStatusResponse,
  LogLine,
  SandboxEdit,
  SandboxView,
  PromptRequest,
  ShellRequest,
  ResumableSession,
  ResumeRequest,
  SessionDisk,
  StatsResponse,
  SavedTabs,
  RewindRequest,
  RewindResponse,
  ServerEvent,
  SessionEvent,
  SessionStreamMessage,
  SessionInfo,
  StartSessionRequest,
  TemplatesResponse,
  UnpushedResponse,
  ReviewDiff,
  WindowState,
} from "@kumiko/shared";

declare global {
  interface Window {
    /** Exposed by the Electron preload; absent in a plain browser. */
    kumiko?: {
      pickFolder(): Promise<string | null>;
      platform: string;
      getZoomFactor(): number;
      onCloseTab(cb: (deleteToo: boolean) => void): () => void;
      /** A PNG, in base64, of part of the window, in page coordinates. */
      capture(rect: { x: number; y: number; width: number; height: number }): Promise<string>;
      /** A PNG, in base64, of what a <webview> in the window shows, by its web contents' id. */
      captureWebview(id: number): Promise<string>;
      /** Calls back when the app blocks a page a <webview> was to show; returns a function that stops listening. */
      onPageBlocked(cb: (webContentsId: number, url: string) => void): () => void;
      onPageWants(cb: (webContentsId: number, url: string) => void): () => void;
      openLink(url: string): void;
    };
  }
}

export class RequestError extends Error {
  constructor(message: string, readonly status: number, readonly details: string[] = []) {
    super(message);
  }
}

/** What to show for a failed call: the server's message for a refused request, or the error's own (e.g. "Failed to fetch"). */
export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & Partial<ApiError>;
  if (!res.ok) throw new RequestError(data.error ?? `${method} ${path} failed (${res.status})`, res.status, data.details);
  return data;
}

/** "owner/name" as two path segments, each encoded. */
const repoPath = (repo: string) => repo.split("/").map(encodeURIComponent).join("/");

export const api = {
  templates: () => request<TemplatesResponse>("GET", "/api/templates"),
  defaults: () => request<DefaultsResponse>("GET", "/api/defaults"),
  /** The window's tabs from its last run, or null if none were saved. */
  tabs: () => request<SavedTabs | null>("GET", "/api/tabs"),
  saveTabs: (tabs: SavedTabs) => request("PUT", "/api/tabs", tabs),
  env: (names: string[]) => request<Record<string, boolean>>("GET", `/api/env?names=${encodeURIComponent(names.join(","))}`),
  create: (req: CreateSandboxRequest) => request<CreateResponse>("POST", "/api/sandboxes", req),
  start: (name: string) => request("POST", `/api/sandboxes/${name}/start`),
  stop: (name: string) => request("POST", `/api/sandboxes/${name}/stop`),
  recreate: (name: string) => request("POST", `/api/sandboxes/${name}/recreate`),
  /** Rebuild from scratch: the VM and the workspace disk are deleted and made again, and the repos cloned again. */
  wipe: (name: string) => request("POST", `/api/sandboxes/${name}/recreate?wipe=1`),
  /** What the running VM has that isn't pushed, repo by repo; 409 while it isn't running. */
  unpushed: (name: string) => request<UnpushedResponse>("GET", `/api/sandboxes/${name}/unpushed`),
  restart: (name: string) => request("POST", `/api/sandboxes/${name}/restart`),
  remove: (name: string) => request("DELETE", `/api/sandboxes/${name}`),
  /**
   * Saves in place; with `restart`, stops the VM, saves and starts it again; with `recreate`, deletes the VM and creates it
   * again from the changed spec.
   */
  edit: (name: string, patch: SandboxEdit, how?: "restart" | "recreate") =>
    request<{ warnings: string[] }>("PATCH", `/api/sandboxes/${name}${how ? `?${how}=1` : ""}`, patch),
  /** The agent's setup scripts in the sandbox's Kumiko folder, with how each went when the VM was created. */
  agentSetup: (name: string) => request<AgentSetupResponse>("GET", `/api/sandboxes/${name}/agent-setup`),
  /** Deletes the agent's setup scripts, folder and all, so the next rebuild starts from the user's setup only. */
  deleteAgentSetup: (name: string) => request("DELETE", `/api/sandboxes/${name}/agent-setup`),
  /** Who gh on the host is signed in to GitHub as, or why it isn't. */
  githubAccount: () => request<GitHubAccount>("GET", "/api/github/account"),
  /** The repositories gh's account can see. */
  githubRepos: () => request<GitHubReposResponse>("GET", "/api/github/repos"),
  /** Picks a repository; its mirror is cloned in the background. */
  addMirror: (repo: string, priv?: boolean) => request<MirrorView>("POST", "/api/mirrors", { repo, private: priv } satisfies AddMirrorRequest),
  fetchMirror: (repo: string) => request("POST", `/api/mirrors/${repoPath(repo)}/fetch`),
  removeMirror: (repo: string) => request("DELETE", `/api/mirrors/${repoPath(repo)}`),
  startSession: (sandbox: string, prompt: string, model?: string, attachments?: AttachmentInput[]) =>
    request<{ id: string }>("POST", "/api/sessions", { sandbox, prompt, model, attachments } satisfies StartSessionRequest),
  /** The user has seen the session, so it no longer waits on them. */
  seen: (id: string) => request("POST", `/api/sessions/${id}/seen`),
  /** Whether the session's sandbox is logged in now; starts nothing. */
  loginStatus: (id: string) => request<LoginStatusResponse>("GET", `/api/sessions/${id}/login`),
  /** Starts logging Claude in for the session's sandbox: a sign-in URL, or who it is logged in as already. */
  login: (id: string) => request<LoginStartResponse>("POST", `/api/sessions/${id}/login`),
  /** Finishes the login with the code the sign-in page shows. */
  loginCode: (id: string, code: string) => request<LoginAccount>("POST", `/api/sessions/${id}/login/code`, { code }),
  cancelLogin: (id: string) => request("DELETE", `/api/sessions/${id}/login`),
  /** Where an artifact's content is, by its hash, as an image of `type`. */
  artifactUrl: (hash: string, type: string) => `/api/artifacts/${hash}?as=${encodeURIComponent(type)}`,
  /** An artifact's content, by its hash, as text. */
  artifactText: async (hash: string) => {
    const res = await fetch(`/api/artifacts/${hash}`);
    if (!res.ok) throw new RequestError(`It isn't on the server (${res.status}).`, res.status);
    return res.text();
  },
  /** Starts the session's Claude again, for Kumiko's tools as they are now; the conversation carries on. */
  restartClaude: (id: string) => request<SessionInfo>("POST", `/api/sessions/${id}/restart`),
  /** Starts the session's Claude again and resends the prompt that failed. */
  retry: (id: string) => request("POST", `/api/sessions/${id}/retry`),
  prompt: (id: string, text: string, attachments?: AttachmentInput[]) => request("POST", `/api/sessions/${id}/prompt`, { text, attachments } satisfies PromptRequest),
  /** Runs a command in the session's sandbox (a message starting with "!"); Claude gets it and its output once it ends. */
  runShell: (id: string, command: string) => request<{ id: string }>("POST", `/api/sessions/${id}/shell`, { command } satisfies ShellRequest),
  /** Stops a command the user ran. */
  stopShell: (id: string, run: string) => request("POST", `/api/sessions/${id}/shell/${encodeURIComponent(run)}/stop`),
  /** Takes back a prompt that waits for Claude, to be edited; `withdrawn` is false once Claude has read it. */
  withdrawPrompt: (id: string, prompt: string) => request<{ withdrawn: boolean }>("POST", `/api/sessions/${id}/prompts/${encodeURIComponent(prompt)}/withdraw`),
  /** The Claude account behind a session and how much of its subscription is used. */
  usage: (id: string) => request<AccountUsage>("GET", `/api/sessions/${id}/usage`),
  /** What a session keeps on the host. */
  sessionDisk: (id: string) => request<SessionDisk>("GET", `/api/sessions/${id}/disk`),
  /** The latest CPU, memory and disk reading of each running sandbox. */
  stats: () => request<StatsResponse>("GET", "/api/stats"),
  interrupt: (id: string) => request("POST", `/api/sessions/${id}/interrupt`),
  /** The end of what one of Claude's background shells or monitors has printed; asking costs Claude no turn. */
  taskOutput: (id: string, task: string) => request<{ output: string; totalBytes: number; truncated: boolean }>("GET", `/api/sessions/${id}/tasks/${encodeURIComponent(task)}/output`),
  /** All of what a background task that ended printed, from the start, read from Claude's own file of it while it keeps it. */
  taskFile: (id: string, task: string) => request<{ output: string; totalBytes: number; truncated: boolean }>("GET", `/api/sessions/${id}/tasks/${encodeURIComponent(task)}/file`),
  /** Stops one of Claude's background tasks. */
  stopTask: (id: string, task: string) => request("POST", `/api/sessions/${id}/tasks/${encodeURIComponent(task)}/stop`),
  /** Moves a command Claude waits on to the background: the one `toolUseId` started, or all of them. */
  backgroundTasks: (id: string, toolUseId?: string) => request("POST", `/api/sessions/${id}/tasks/background`, toolUseId ? { toolUseId } : {}),
  /** Opens the Tasks pane beside the chat, or closes it; with `open`, only opens it. */
  toggleTasks: (id: string, open?: boolean) => request<WindowState>("POST", `/api/sessions/${id}/window/tasks`, open ? { open } : {}),
  /** Opens the review pane for deliver card `ask` beside the chat, or closes it; with `open`, only opens it. */
  toggleReview: (id: string, ask: string, open?: boolean) => request<WindowState>("POST", `/api/sessions/${id}/window/review`, open ? { ask, open } : { ask }),
  /** What a deliver card's branch changes: all of it, one commit, or since a commit; `path` asks for those files whole. */
  reviewDiff: (id: string, ask: string, q: { commit?: string; since?: string; w?: boolean; path?: string[] } = {}) => {
    const params = new URLSearchParams();
    if (q.commit) params.set("commit", q.commit);
    if (q.since) params.set("since", q.since);
    if (q.w) params.set("w", "1");
    for (const p of q.path ?? []) params.append("path", p);
    const qs = params.toString();
    return request<ReviewDiff>("GET", `/api/sessions/${id}/cards/${encodeURIComponent(ask)}/diff${qs ? `?${qs}` : ""}`);
  },
  /** A file's content in a deliver card's repository, by blob, to show more of it around a change. */
  reviewBlob: (id: string, ask: string, blob: string) => request<{ text?: string; binary?: boolean }>("GET", `/api/sessions/${id}/cards/${encodeURIComponent(ask)}/blob/${blob}`),
  /** Answers what Claude asked mid-turn: its questions, or its plan. */
  answerAsk: (id: string, ask: string, answer: AskAnswer) => request("POST", `/api/sessions/${id}/asks/${encodeURIComponent(ask)}`, answer),
  /** Decides on an approval card: approve with the choices made on it, decline with a reason, or look again. */
  decideCard: (id: string, ask: string, action: unknown) => request("POST", `/api/sessions/${id}/cards/${encodeURIComponent(ask)}`, action),
  /** Has Claude plan first and wait for approval, or work without asking. */
  setPlanMode: (id: string, plan: boolean) => request("POST", `/api/sessions/${id}/plan-mode`, { plan }),
  /** Closes one of the session window's panes; its widget stays, hidden. */
  closePane: (id: string, pane: string) => request<WindowState>("POST", `/api/sessions/${id}/window/close`, { pane }),
  /**
   * Shows a widget in `pane`, swapping with the pane that shows it now, or with `split`, in a new pane split off `pane`
   * that way; with neither, where a new artifact would go.
   */
  showWidget: (id: string, widget: string, pane?: string, split?: "right" | "below") =>
    request<WindowState>("POST", `/api/sessions/${id}/window/show`, { widget, pane, split }),
  /** Moves a pane to a side of another, or swaps the two. */
  movePane: (id: string, pane: string, to: string, side: string) => request<WindowState>("POST", `/api/sessions/${id}/window/move`, { pane, to, side }),
  /** Answers a pane request: with a picture, with nothing once done, or with why it couldn't be done. */
  answerPane: (id: string, answer: { request: string; data?: string; mimeType?: string; error?: string; fallback?: boolean; note?: string }) =>
    request("POST", `/api/sessions/${id}/window/answer`, answer),
  /** Allows an external site Claude opened, which then loads, or denies it, which takes it out of the window. */
  /** Shows a file the session's Claude named, by its path in the VM, in the Finder; answers with where it is on the Mac. */
  reveal: (id: string, path: string) => request<{ path: string }>("POST", `/api/sessions/${id}/reveal`, { path }),
  approveSite: (id: string, widget: string, allow: boolean) => request<WindowState>("POST", `/api/sessions/${id}/window/approve`, { widget, allow }),
  /** Takes a widget out of the window; a pane showing it shows another artifact, or closes. */
  removeWidget: (id: string, widget: string) => request<WindowState>("POST", `/api/sessions/${id}/window/remove`, { widget }),
  /** Sets the share of the first side of the split at `path`. */
  resizeSplit: (id: string, path: string, ratio: number) => request<WindowState>("POST", `/api/sessions/${id}/window/resize`, { path, ratio }),
  /** Saved sessions that aren't open, most recent first. */
  resumable: () => request<ResumableSession[]>("GET", "/api/sessions/resumable"),
  /** Reopens a saved session with its chat; returns the same id. With `start: false`, a stopped sandbox stays stopped. */
  resumeSession: (id: string, opts: ResumeRequest = {}) => request<{ id: string }>("POST", `/api/sessions/${id}/resume`, opts),
  /** Starts the sandbox of a session opened asleep, and Claude in it. */
  wakeSession: (id: string) => request<SessionInfo>("POST", `/api/sessions/${id}/wake`),
  /** Deletes a saved session for good. */
  deleteSavedSession: (id: string) => request("DELETE", `/api/sessions/saved/${id}`),
  /** Starts a new session from a copy of this one's conversation: all of it, or up to the end of a prompt's turn. */
  forkSession: (id: string, prompt?: string) => request<{ id: string }>("POST", `/api/sessions/${id}/fork`, { prompt } satisfies ForkRequest),
  /** Answers Claude asking to start a new session; accepted, returns the session it started. */
  /** `prompt`: the one to start it on, if the user changed Claude's. */
  answerProposal: (id: string, proposal: string, accept: boolean, prompt?: string) =>
    request<{ id?: string; skipped?: string[] }>("POST", `/api/sessions/${id}/proposals/${proposal}`, { accept, ...(prompt !== undefined ? { prompt } : {}) }),
  /** Takes the session back to just before a prompt, optionally with the files put back too. */
  rewindSession: (id: string, prompt: string, files: boolean) =>
    request<RewindResponse>("POST", `/api/sessions/${id}/rewind`, { prompt, files } satisfies RewindRequest & { prompt: string }),
  /**
   * Closes the session's tab: Claude, if working, finishes its turn first (`finishing`), unless `stop`. Then the session
   * is forgotten; one Claude has talked to stays resumable, unless `delete`.
   */
  closeSession: (id: string, opts: { delete?: boolean; stop?: boolean } = {}) => {
    const query = [opts.delete && "delete", opts.stop && "stop"].filter(Boolean).join("&");
    return request<{ finishing: boolean }>("DELETE", `/api/sessions/${id}${query ? `?${query}` : ""}`);
  },
};

const wsUrl = (path: string) => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;

export interface LiveState {
  sandboxes: SandboxView[];
  /** Why each sandbox record the server can't use can't be; those sandboxes aren't in `sandboxes`. */
  unreadable: string[];
  logs: Record<string, LogLine[]>;
  /** Agent sessions, live and ended, in the order they started. */
  sessions: SessionInfo[];
  /** The server couldn't list the VMs (e.g. limactl missing). */
  listError?: string;
  connected: boolean;
  /** True once the first snapshot has arrived. */
  loaded: boolean;
  /** How many snapshots have arrived: one per connection, so it goes up when the server restarts. */
  snapshots: number;
  /** The repository mirrors; undefined until a server that keeps them has sent them. */
  mirrors?: MirrorsResponse;
}

/** Keeps the sandbox list, sessions and operation logs in sync over /api/events, reconnecting when the server restarts. */
export function useLiveState(): LiveState {
  const [state, setState] = useState<LiveState>({ sandboxes: [], unreadable: [], logs: {}, sessions: [], connected: false, loaded: false, snapshots: 0 });
  const retry = useRef(0);

  useEffect(() => {
    let ws: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const connect = () => {
      ws = new WebSocket(wsUrl("/api/events"));
      ws.onopen = () => {
        retry.current = 0;
      };
      ws.onmessage = (msg) => {
        const ev = JSON.parse(String(msg.data)) as ServerEvent;
        if (ev.type === "pane") answerPaneRequest(ev);
        else setState((s) => apply(s, ev));
      };
      ws.onclose = () => {
        setState((s) => ({ ...s, connected: false }));
        if (closed) return;
        const delay = Math.min(5000, 300 * 2 ** retry.current++);
        timer = setTimeout(connect, delay);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, []);

  return state;
}

export type PaneRequest = Extract<ServerEvent, { type: "pane" }>;
const paneListeners = new Set<(ev: PaneRequest) => boolean>();

/**
 * Listens for the server asking, for Claude, to reload or capture a pane; the listener says whether it answers it.
 * Returns a function that stops listening.
 */
export function onPaneRequest(listener: (ev: PaneRequest) => boolean): () => void {
  paneListeners.add(listener);
  return () => paneListeners.delete(listener);
}

/** Every window answers, so the server needn't wait out one that doesn't show the session. */
function answerPaneRequest(ev: PaneRequest) {
  let answered = false;
  for (const l of paneListeners) answered = l(ev) || answered;
  if (!answered) void api.answerPane(ev.session, { request: ev.request, error: "The session isn't on screen in the user's window. Ask them to open its tab, then try again.", fallback: true }).catch(() => {});
}

function apply(s: LiveState, ev: ServerEvent): LiveState {
  switch (ev.type) {
    case "snapshot":
      return { sandboxes: ev.sandboxes, unreadable: ev.unreadable, logs: ev.logs, sessions: ev.sessions, listError: ev.error, connected: true, loaded: true, snapshots: s.snapshots + 1, mirrors: ev.mirrors };
    case "list":
      return { ...s, sandboxes: ev.sandboxes, unreadable: ev.unreadable, listError: ev.error };
    case "sessions":
      return { ...s, sessions: ev.sessions };
    case "mirrors":
      return { ...s, mirrors: { mirrors: ev.mirrors, ...(ev.error ? { error: ev.error } : {}) } };
    case "state":
      // A new operation starts a fresh log.
      return { ...s, logs: { ...s.logs, [ev.sandbox]: [] } };
    case "log":
      return { ...s, logs: { ...s.logs, [ev.sandbox]: [...(s.logs[ev.sandbox] ?? []), ev.data] } };
    default:
      return s;
  }
}

export interface SessionStream {
  events: SessionEvent[];
  connected: boolean;
  /** The server doesn't know this session (it was removed, or the server restarted). */
  gone: boolean;
  /** The last `seq` of the history replayed on connecting, once it's in; later events are new work. */
  history?: number;
}

/**
 * Streams one session's events: the whole buffer first, then new ones. After a dropped connection it resumes from
 * the last `seq` it has, so nothing is lost or repeated. A buffer replaced since (after a rewind, or a server restart and
 * a resume, which number the events afresh) is closed with 4409, so it starts over.
 */
export function useSessionEvents(id: string): SessionStream {
  const [state, setState] = useState<SessionStream>({ events: [], connected: false, gone: false });

  useEffect(() => {
    let ws: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let lastSeq = 0;
    // The buffer `lastSeq` counts in, from the server's caught_up.
    let buffer: string | undefined;
    let retry = 0;
    setState({ events: [], connected: false, gone: false });

    const connect = () => {
      // What the server replays is held back until it has caught up, then shown at once: history, not new work.
      let backlog: SessionEvent[] | undefined = [];
      const replay = lastSeq === 0;
      ws = new WebSocket(wsUrl(`/api/sessions/${id}/events?after=${lastSeq}${buffer ? `&buffer=${buffer}` : ""}`));
      ws.onopen = () => {
        retry = 0;
        setState((s) => ({ ...s, connected: true }));
      };
      ws.onmessage = (msg) => {
        const ev = JSON.parse(String(msg.data)) as SessionStreamMessage;
        if (ev.kind === "caught_up") {
          buffer = ev.buffer;
          const caught = backlog ?? [];
          backlog = undefined;
          if (caught.length || replay) setState((s) => ({ ...s, events: [...s.events, ...caught], history: replay ? lastSeq : s.history }));
          return;
        }
        if (ev.seq <= lastSeq) return;
        lastSeq = ev.seq;
        if (backlog) backlog.push(ev);
        else setState((s) => ({ ...s, events: [...s.events, ev] }));
      };
      ws.onclose = (e) => {
        if (e.code === 4409 && !closed) {
          lastSeq = 0;
          buffer = undefined;
          setState({ events: [], connected: false, gone: false });
          connect();
          return;
        }
        setState((s) => ({ ...s, connected: false, gone: s.gone || e.code === 4404 }));
        if (closed || e.code === 4404) return;
        timer = setTimeout(connect, Math.min(5000, 300 * 2 ** retry++));
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [id]);

  return state;
}

/** What the server says about the host; undefined until it answers. */
export function useDefaults(): DefaultsResponse | undefined {
  const [defaults, setDefaults] = useState<DefaultsResponse | undefined>();
  useEffect(() => {
    api.defaults().then(setDefaults, () => {});
  }, []);
  return defaults;
}

/** The host user's home, for showing paths as ~/…; undefined until the server answers. */
export function useHome(): string | undefined {
  return useDefaults()?.home;
}

/** How often the sandboxes' readings are asked for while something shows them; the VMs take one every 3 s. */
const STATS_MS = 3000;
const statsListeners = new Set<(s: StatsResponse) => void>();
let statsLatest: StatsResponse = {};
/** Set while the poll runs: waiting for an answer or for the next turn. */
let statsPolling = false;

/** One poll for every view that shows readings; it pauses while the window is hidden, as nobody sees them then. */
function pollStats() {
  if (!statsListeners.size) {
    statsPolling = false;
    statsLatest = {};
    return;
  }
  const next = () => void setTimeout(pollStats, STATS_MS);
  if (document.hidden) return next();
  api
    .stats()
    .then((s) => {
      statsLatest = s;
      for (const l of statsListeners) l(s);
    })
    .catch(() => {})
    .finally(next);
}

/** The latest reading of each running sandbox, by name, kept fresh while the component is mounted. */
export function useSandboxStats(): StatsResponse {
  const [stats, setStats] = useState(statsLatest);
  useEffect(() => {
    statsListeners.add(setStats);
    if (!statsPolling) {
      statsPolling = true;
      pollStats();
    }
    return () => void statsListeners.delete(setStats);
  }, []);
  return stats;
}
