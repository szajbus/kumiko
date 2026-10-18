import { useEffect, useRef, useState } from "react";
import type { ApiError, CreateResponse, LogLine, SandboxSpec, SandboxView, ServerEvent, TemplatesResponse } from "@bentomo/shared";

declare global {
  interface Window {
    /** Exposed by the Electron preload; absent in a plain browser. */
    bentomo?: { pickFolder(): Promise<string | null>; platform: string };
  }
}

export class RequestError extends Error {
  constructor(message: string, readonly status: number, readonly details: string[] = []) {
    super(message);
  }
}

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
  env: (names: string[]) => request<Record<string, boolean>>("GET", `/api/env?names=${encodeURIComponent(names.join(","))}`),
  create: (spec: SandboxSpec) => request<CreateResponse>("POST", "/api/sandboxes", spec),
  start: (name: string) => request("POST", `/api/sandboxes/${name}/start`),
  stop: (name: string) => request("POST", `/api/sandboxes/${name}/stop`),
  provision: (name: string) => request("POST", `/api/sandboxes/${name}/provision`),
  recreate: (name: string) => request("POST", `/api/sandboxes/${name}/recreate`),
  remove: (name: string) => request("DELETE", `/api/sandboxes/${name}`),
};

export interface LiveState {
  sandboxes: SandboxView[];
  logs: Record<string, LogLine[]>;
  /** The server couldn't list sandboxes (e.g. limactl missing). */
  listError?: string;
  connected: boolean;
  /** True once the first snapshot has arrived. */
  loaded: boolean;
}

/** Keeps the sandbox list and operation logs in sync over /api/events, reconnecting when the server restarts. */
export function useLiveState(): LiveState {
  const [state, setState] = useState<LiveState>({ sandboxes: [], logs: {}, connected: false, loaded: false });
  const retry = useRef(0);

  useEffect(() => {
    let ws: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const connect = () => {
      const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/events`;
      ws = new WebSocket(url);
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
      return { sandboxes: ev.sandboxes, logs: ev.logs, listError: ev.error, connected: true, loaded: true };
    case "list":
      return { ...s, sandboxes: ev.sandboxes, listError: ev.error };
    case "state":
      // A new operation starts a fresh log.
      return { ...s, logs: { ...s.logs, [ev.sandbox]: [] } };
    case "log":
      return { ...s, logs: { ...s.logs, [ev.sandbox]: [...(s.logs[ev.sandbox] ?? []), ev.data] } };
    default:
      return s;
  }
}
