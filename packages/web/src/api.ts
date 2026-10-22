import { useEffect, useRef, useState } from "react";
import type {
  AccountUsage,
  AttachmentInput,
  ApiError,
  CreateProjectRequest,
  CreateResponse,
  DefaultsResponse,
  ForkRequest,
  LoginAccount,
  LoginStartResponse,
  LoginStatusResponse,
  LogLine,
  ProjectEdit,
  ProjectView,
  PromptRequest,
  ResumableSession,
  SavedTabs,
  RewindRequest,
  RewindResponse,
  ServerEvent,
  SessionEvent,
  SessionStreamMessage,
  SessionInfo,
  StartSessionRequest,
  TemplatesResponse,
  WindowState,
  WorktreesResponse,
} from "@kumiko/shared";

declare global {
  interface Window {
    /** Exposed by the Electron preload; absent in a plain browser. */
    kumiko?: {
      pickFolder(): Promise<string | null>;
      platform: string;
      getZoomFactor?(): number;
      onCloseTab?(cb: (deleteToo: boolean) => void): () => void;
      /** A PNG, in base64, of part of the window, in page coordinates. */
      capture?(rect: { x: number; y: number; width: number; height: number }): Promise<string>;
      /** A PNG, in base64, of what a <webview> in the window shows, by its web contents' id. */
      captureWebview?(id: number): Promise<string>;
      /** Calls back when the app blocks a page a <webview> was to show; returns a function that stops listening. */
      onPageBlocked?(cb: (webContentsId: number, url: string) => void): () => void;
      onPageWants?(cb: (webContentsId: number, url: string) => void): () => void;
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

export const api = {
  templates: () => request<TemplatesResponse>("GET", "/api/templates"),
  defaults: () => request<DefaultsResponse>("GET", "/api/defaults"),
  /** The window's tabs from its last run, or null if none were saved. */
  tabs: () => request<SavedTabs | null>("GET", "/api/tabs"),
  saveTabs: (tabs: SavedTabs) => request("PUT", "/api/tabs", tabs),
  env: (names: string[]) => request<Record<string, boolean>>("GET", `/api/env?names=${encodeURIComponent(names.join(","))}`),
  create: (req: CreateProjectRequest) => request<CreateResponse>("POST", "/api/projects", req),
  start: (id: string) => request("POST", `/api/projects/${id}/start`),
  stop: (id: string) => request("POST", `/api/projects/${id}/stop`),
  recreate: (id: string) => request("POST", `/api/projects/${id}/recreate`),
  restart: (id: string) => request("POST", `/api/projects/${id}/restart`),
  remove: (id: string) => request("DELETE", `/api/projects/${id}`),
  /**
   * Saves in place; with `restart`, stops the VM, saves and starts it again; with `recreate`, deletes the VM and creates it
   * again from the changed spec.
   */
  edit: (id: string, patch: ProjectEdit, how?: "restart" | "recreate") =>
    request<{ warnings: string[] }>("PATCH", `/api/projects/${id}${how ? `?${how}=1` : ""}`, patch),
  /** The clone's worktrees, as git on the host sees them. */
  worktrees: (id: string) => request<WorktreesResponse>("GET", `/api/projects/${id}/worktrees`),
  startSession: (project: string, prompt: string, model?: string, attachments?: AttachmentInput[]) =>
    request<{ id: string }>("POST", "/api/sessions", { sandbox: project, prompt, model, attachments } satisfies StartSessionRequest),
  /** The user has seen the session, so it no longer waits on them. */
  seen: (id: string) => request("POST", `/api/sessions/${id}/seen`),
  /** Whether the session's project is logged in now; starts nothing. */
  loginStatus: (id: string) => request<LoginStatusResponse>("GET", `/api/sessions/${id}/login`),
  /** Starts logging Claude in for the session's project: a sign-in URL, or who it is logged in as already. */
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
  /** The Claude account behind a session and how much of its subscription is used. */
  usage: (id: string) => request<AccountUsage>("GET", `/api/sessions/${id}/usage`),
  interrupt: (id: string) => request("POST", `/api/sessions/${id}/interrupt`),
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
  approveSite: (id: string, widget: string, allow: boolean) => request<WindowState>("POST", `/api/sessions/${id}/window/approve`, { widget, allow }),
  /** Takes a widget out of the window; a pane showing it shows another artifact, or closes. */
  removeWidget: (id: string, widget: string) => request<WindowState>("POST", `/api/sessions/${id}/window/remove`, { widget }),
  /** Sets the share of the first side of the split at `path`. */
  resizeSplit: (id: string, path: string, ratio: number) => request<WindowState>("POST", `/api/sessions/${id}/window/resize`, { path, ratio }),
  /** Saved sessions that aren't open, most recent first. */
  resumable: () => request<ResumableSession[]>("GET", "/api/sessions/resumable"),
  /** Reopens a saved session with its chat; returns the same id. */
  resumeSession: (id: string) => request<{ id: string }>("POST", `/api/sessions/${id}/resume`),
  /** Deletes a saved session for good. */
  deleteSavedSession: (id: string) => request("DELETE", `/api/sessions/saved/${id}`),
  /** Starts a new session from a copy of this one's conversation: all of it, or up to the end of a prompt's turn. */
  forkSession: (id: string, prompt?: string) => request<{ id: string }>("POST", `/api/sessions/${id}/fork`, { prompt } satisfies ForkRequest),
  /** Takes the session back to just before a prompt, optionally with the files put back too. */
  rewindSession: (id: string, prompt: string, files: boolean) =>
    request<RewindResponse>("POST", `/api/sessions/${id}/rewind`, { prompt, files } satisfies RewindRequest & { prompt: string }),
  /** Ends the session if it is live and forgets it; a session Claude has talked to stays resumable. */
  endSession: (id: string) => request("DELETE", `/api/sessions/${id}`),
};

const wsUrl = (path: string) => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;

export interface LiveState {
  projects: ProjectView[];
  /** Why each project record the server can't use can't be; those projects aren't in `projects`. */
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
}

/** Keeps the project list, sessions and operation logs in sync over /api/events, reconnecting when the server restarts. */
export function useLiveState(): LiveState {
  const [state, setState] = useState<LiveState>({ projects: [], unreadable: [], logs: {}, sessions: [], connected: false, loaded: false, snapshots: 0 });
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
      return { projects: ev.projects, unreadable: ev.unreadable, logs: ev.logs, sessions: ev.sessions, listError: ev.error, connected: true, loaded: true, snapshots: s.snapshots + 1 };
    case "list":
      return { ...s, projects: ev.projects, unreadable: ev.unreadable, listError: ev.error };
    case "sessions":
      return { ...s, sessions: ev.sessions };
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
