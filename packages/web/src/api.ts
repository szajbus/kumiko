import { useEffect, useRef, useState } from "react";
import type {
  AccountUsage,
  ApiError,
  CreateResponse,
  DefaultsResponse,
  EditSpec,
  LogLine,
  ResumableSession,
  RewindRequest,
  RewindResponse,
  SandboxSpec,
  SandboxView,
  ServerEvent,
  SessionEvent,
  SessionInfo,
  TemplatesResponse,
} from "@bentomo/shared";

declare global {
  interface Window {
    /** Exposed by the Electron preload; absent in a plain browser. */
    bentomo?: { pickFolder(): Promise<string | null>; platform: string; getZoomFactor?(): number; onCloseTab?(cb: (deleteToo: boolean) => void): () => void };
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
  env: (names: string[]) => request<Record<string, boolean>>("GET", `/api/env?names=${encodeURIComponent(names.join(","))}`),
  create: (spec: SandboxSpec) => request<CreateResponse>("POST", "/api/sandboxes", spec),
  start: (name: string) => request("POST", `/api/sandboxes/${name}/start`),
  stop: (name: string) => request("POST", `/api/sandboxes/${name}/stop`),
  recreate: (name: string) => request("POST", `/api/sandboxes/${name}/recreate`),
  remove: (name: string) => request("DELETE", `/api/sandboxes/${name}`),
  /** Saves in place, or with `recreate` deletes the VM and creates it again from the changed spec. */
  edit: (name: string, patch: EditSpec, recreate = false) =>
    request<{ warnings: string[] }>("PATCH", `/api/sandboxes/${name}${recreate ? "?recreate=1" : ""}`, patch),
  startSession: (sandbox: string, prompt: string, model?: string) => request<{ id: string }>("POST", "/api/sessions", { sandbox, prompt, model }),
  prompt: (id: string, text: string) => request("POST", `/api/sessions/${id}/prompt`, { text }),
  /** The Claude account behind a session and how much of its subscription is used. */
  usage: (id: string) => request<AccountUsage>("GET", `/api/sessions/${id}/usage`),
  interrupt: (id: string) => request("POST", `/api/sessions/${id}/interrupt`),
  /** Saved sessions that aren't open, most recent first. */
  resumable: () => request<ResumableSession[]>("GET", "/api/sessions/resumable"),
  /** Reopens a saved session with its chat; returns the same id. */
  resumeSession: (id: string) => request<{ id: string }>("POST", `/api/sessions/${id}/resume`),
  /** Deletes a saved session for good. */
  deleteSavedSession: (id: string) => request("DELETE", `/api/sessions/saved/${id}`),
  /** Starts a new session from a copy of this one's conversation. */
  forkSession: (id: string) => request<{ id: string }>("POST", `/api/sessions/${id}/fork`),
  /** Starts a new session from this one's conversation just before a prompt, optionally with the files put back too. */
  rewindSession: (id: string, prompt: string, files: boolean) =>
    request<RewindResponse>("POST", `/api/sessions/${id}/rewind`, { prompt, files } satisfies RewindRequest & { prompt: string }),
  /** Ends the session if it is live and forgets it; a session Claude has talked to stays resumable. */
  endSession: (id: string) => request("DELETE", `/api/sessions/${id}`),
};

const wsUrl = (path: string) => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;

export interface LiveState {
  sandboxes: SandboxView[];
  logs: Record<string, LogLine[]>;
  /** Agent sessions, live and ended, in the order they started. */
  sessions: SessionInfo[];
  /** The server couldn't list sandboxes (e.g. limactl missing). */
  listError?: string;
  connected: boolean;
  /** True once the first snapshot has arrived. */
  loaded: boolean;
}

/** Keeps the sandbox list and operation logs in sync over /api/events, reconnecting when the server restarts. */
export function useLiveState(): LiveState {
  const [state, setState] = useState<LiveState>({ sandboxes: [], logs: {}, sessions: [], connected: false, loaded: false });
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
        setState((s) => apply(s, ev));
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

function apply(s: LiveState, ev: ServerEvent): LiveState {
  switch (ev.type) {
    case "snapshot":
      return { sandboxes: ev.sandboxes, logs: ev.logs, sessions: ev.sessions, listError: ev.error, connected: true, loaded: true };
    case "list":
      return { ...s, sandboxes: ev.sandboxes, listError: ev.error };
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
}

/**
 * Streams one session's events: the whole buffer first, then new ones. After a dropped connection it resumes from
 * the last `seq` it has, so nothing is lost or repeated.
 */
export function useSessionEvents(id: string): SessionStream {
  const [state, setState] = useState<SessionStream>({ events: [], connected: false, gone: false });

  useEffect(() => {
    let ws: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let lastSeq = 0;
    let retry = 0;
    setState({ events: [], connected: false, gone: false });

    const connect = () => {
      ws = new WebSocket(wsUrl(`/api/sessions/${id}/events?after=${lastSeq}`));
      ws.onopen = () => {
        retry = 0;
        setState((s) => ({ ...s, connected: true }));
      };
      ws.onmessage = (msg) => {
        const ev = JSON.parse(String(msg.data)) as SessionEvent;
        if (ev.seq <= lastSeq) return;
        lastSeq = ev.seq;
        setState((s) => ({ ...s, events: [...s.events, ev] }));
      };
      ws.onclose = (e) => {
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
