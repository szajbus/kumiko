import { stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { WebSocketServer, type WebSocket } from "ws";
import {
  ENV_NAME_PATTERN,
  NAME_PATTERN,
  SESSION_ID_PATTERN,
  vmName,
  WORKSPACE_DIR,
  type AccountUsage,
  type ApiError,
  type CreateResponse,
  type DefaultsResponse,
  type EditSpec,
  type OpKind,
  type RewindResponse,
  type SandboxInfo,
  type SandboxSpec,
  type SandboxView,
  type ServerEvent,
  type SessionEvent,
  type StartSessionRequest,
  type TemplatesResponse,
} from "@bentomo/shared";
import { LimaProvider, type Log, type SandboxProvider } from "@bentomo/sandbox";
import { ClaudeDriver, type AgentDriver } from "@bentomo/agent";
import { isLocalRequest } from "./guard.js";
import { BusyError, Operations } from "./operations.js";
import { RewindRefused, SessionEnded, SessionNotFound, SessionNotResumable, Sessions } from "./sessions.js";
import { SessionStore } from "./store.js";
import { serveWeb } from "./static.js";
import { fetchAccountUsage, UsageCache } from "./usage.js";

export interface ServerOptions {
  provider?: SandboxProvider;
  /** 0 picks a free port. */
  port?: number;
  host?: string;
  /** The built web UI; omit to serve the API only. */
  webDir?: string;
  /** How often to re-read `limactl list`, in ms. */
  refreshMs?: number;
  /** The host user's home; defaults to the real one. */
  home?: string;
  /** Where forwarded variables are looked up for the form's "set on host" dots. */
  env?: () => NodeJS.ProcessEnv;
  /** Where sessions are saved for resuming; defaults to `sessions` in Bentomo's home (`BENTOMO_HOME` or `~/.bentomo`). */
  sessionsDir?: string;
  /** Makes the driver for each new agent session; defaults to Claude Code over the provider's exec. */
  driver?: () => AgentDriver;
  /** Reads the account and usage of the Claude in a sandbox; defaults to asking Claude inside it. Cached for 30s per sandbox. */
  usage?: (sandbox: string, env: string[]) => Promise<AccountUsage>;
}

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const provider = opts.provider ?? new LimaProvider({ env: opts.env });
  const env = opts.env ?? (() => process.env);
  const host = opts.host ?? "127.0.0.1";
  const ops = new Operations();
  const sessionStore = new SessionStore(opts.sessionsDir);
  const sessions = new Sessions(opts.driver ?? (() => new ClaudeDriver(provider.exec.bind(provider))), sessionStore);
  const clients = new Set<WebSocket>();
  const readUsage = opts.usage ?? ((sandbox: string, forwarded: string[]) => fetchAccountUsage(provider.exec.bind(provider), sandbox, forwarded));
  // The probe forwards the sandbox's variables, as sessions do, in case the login is CLAUDE_CODE_OAUTH_TOKEN.
  const usage = new UsageCache((sandbox) => readUsage(sandbox, infos.find((i) => i.name === sandbox)?.meta?.spec.env ?? []));

  // ---- list state -------------------------------------------------------------------------

  let infos: SandboxInfo[] = [];
  let listError: string | undefined;
  let lastListJson = "";
  let refreshing: Promise<void> | undefined;
  let refreshAgain = false;

  const broadcast = (ev: ServerEvent) => {
    const msg = JSON.stringify(ev);
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(msg);
  };

  const views = (): SandboxView[] => ops.views(infos, sessions.liveCounts());

  const pushListIfChanged = () => {
    const sandboxes = views();
    const json = JSON.stringify({ sandboxes, listError });
    if (json === lastListJson) return;
    lastListJson = json;
    broadcast({ type: "list", sandboxes, error: listError });
  };

  /** Re-reads the provider's list; concurrent calls coalesce into one extra run. */
  const refresh = (): Promise<void> => {
    if (refreshing) {
      refreshAgain = true;
      return refreshing;
    }
    refreshing = (async () => {
      do {
        refreshAgain = false;
        try {
          infos = await provider.list();
          listError = undefined;
          endOrphanedSessions();
        } catch (err) {
          listError = err instanceof Error ? err.message : String(err);
        }
        pushListIfChanged();
      } while (refreshAgain);
    })().finally(() => (refreshing = undefined));
    return refreshing;
  };

  ops.on("event", (ev) => {
    broadcast(ev);
    if (ev.type !== "log") pushListIfChanged();
  });
  ops.on("settled", () => void refresh());

  sessions.on("changed", () => {
    broadcast({ type: "sessions", sessions: sessions.list() });
    pushListIfChanged();
  });

  /** Sessions whose sandbox stopped or vanished outside Bentomo end too. */
  const endOrphanedSessions = () => {
    for (const [name] of sessions.liveCounts()) {
      if (infos.find((i) => i.name === name)?.status !== "running") void sessions.endSandbox(name, "sandbox");
    }
  };

  /** Ends a sandbox's sessions before an operation takes it down, noting it in the operation's log. */
  const endSessions = async (name: string, log: Log) => {
    const n = sessions.liveCounts().get(name) ?? 0;
    if (!n) return;
    log(`Ending ${n} agent session${n === 1 ? "" : "s"}…`, "note");
    await sessions.endSandbox(name, "sandbox");
  };

  /** Ends the sandbox's sessions and drops the saved ones, for when its VM is deleted. */
  const dropSessions = async (name: string, log: Log) => {
    await endSessions(name, log);
    await sessions.deleteSavedFor(name);
  };

  const timer = setInterval(() => void refresh(), opts.refreshMs ?? 5000);
  await refresh();

  // ---- routes -----------------------------------------------------------------------------

  const app = new Hono();
  const fail = (error: string, details?: string[]): ApiError => (details?.length ? { error, details } : { error });

  /** Routes throw these, or the typed errors below, and `onError` turns them into JSON with the right status. */
  class HttpError extends Error {
    constructor(readonly status: ContentfulStatusCode, message: string, readonly details?: string[]) {
      super(message);
    }
  }

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json(fail(err.message, err.details), err.status);
    if (err instanceof BusyError) return c.json(fail(err.message), 409);
    if (err instanceof SessionNotFound) return c.json(fail(err.message), 404);
    if (err instanceof SessionEnded || err instanceof SessionNotResumable || err instanceof RewindRefused) return c.json(fail(err.message), 409);
    // Anything else is a bug or a tool failing; the UI still gets JSON it can show.
    return c.json(fail(err instanceof Error ? err.message : String(err)), 500);
  });

  app.use("/api/*", async (c, next) => {
    if (!isLocalRequest(c.req.raw.headers)) return c.json(fail("Forbidden: not a local request."), 403);
    await next();
  });

  /** Parses the JSON body, or answers 400 with `usage`. */
  const body = async <T>(c: Context, usage: string): Promise<T> => {
    try {
      return await c.req.json<T>();
    } catch {
      throw new HttpError(400, usage);
    }
  };

  /** Answers 409 while an operation runs on the sandbox. `ops.start` checks again, for a request that raced this one. */
  const assertIdle = (name: string) => {
    const cur = ops.get(name);
    if (cur && !cur.endedAt) throw new BusyError(name, cur.op);
  };

  /** Looks up a sandbox the provider knows: 400 for a bad name, 404 for an unknown one. */
  const known = async (name: string): Promise<SandboxInfo> => {
    if (!NAME_PATTERN.test(name)) throw new HttpError(400, `Invalid sandbox name "${name}".`);
    await refresh();
    const info = infos.find((i) => i.name === name);
    if (!info) throw new HttpError(404, `${vmName(name)} does not exist.`);
    return info;
  };

  /** A sandbox a session can start in: running and not busy. Returns where sessions start and what they forward. */
  const readySandbox = async (name: string): Promise<{ workdir: string; env: string[] }> => {
    const info = await known(name);
    if (info.status !== "running") throw new HttpError(409, `${vmName(name)} is not running. Start it first.`);
    assertIdle(name);
    const spec = info.meta?.spec;
    return { workdir: spec?.workdir ?? WORKSPACE_DIR, env: spec?.env ?? [] };
  };

  app.get("/api/sandboxes", async (c) => {
    await refresh();
    if (listError && infos.length === 0) throw new HttpError(500, listError);
    return c.json(views());
  });

  let templatesCache: TemplatesResponse | undefined;
  app.get("/api/templates", async (c) => {
    templatesCache ??= await provider.templates();
    return c.json(templatesCache);
  });

  /** What the create form starts from: ~/.claude mounted at ~/.claude in the VM, when the host has one. */
  app.get("/api/defaults", async (c) => {
    const home = opts.home ?? homedir();
    const claude = join(home, ".claude");
    const hasClaude = await stat(claude).then((s) => s.isDirectory(), () => false);
    return c.json({
      home,
      mounts: hasClaude ? [{ hostPath: claude, guestPath: "~/.claude", writable: true }] : [],
    } satisfies DefaultsResponse);
  });

  /** Which of the given variable names are set in Bentomo's environment. Never returns values. */
  app.get("/api/env", (c) => {
    const names = (c.req.query("names") ?? "").split(",").map((n) => n.trim()).filter((n) => ENV_NAME_PATTERN.test(n));
    const e = env();
    return c.json(Object.fromEntries(names.map((n) => [n, e[n] !== undefined])));
  });

  app.post("/api/sandboxes", async (c) => {
    const spec = await body<SandboxSpec>(c, "Body must be a JSON SandboxSpec.");
    assertIdle(String(spec?.name ?? "").trim());
    const v = await provider.validate(spec);
    if (v.errors.length) throw new HttpError(400, "Invalid sandbox spec.", v.errors);
    ops.start(v.spec.name, "creating", (log) => provider.create(v.spec, log));
    void refresh();
    return c.json({ name: v.spec.name, warnings: v.warnings } satisfies CreateResponse, 202);
  });

  const action = (op: OpKind, work: (info: SandboxInfo, log: Log) => Promise<void>) => async (c: Context) => {
    const name = c.req.param("name")!;
    assertIdle(name);
    const info = await known(name);
    ops.start(name, op, (log) => work(info, log));
    return c.json({ name, op }, 202);
  };

  app.post("/api/sandboxes/:name/start", action("starting", (i, log) => provider.start(i.name, log)));
  app.post("/api/sandboxes/:name/stop", action("stopping", async (i, log) => {
    await endSessions(i.name, log);
    await provider.stop(i.name, log);
  }));
  app.delete("/api/sandboxes/:name", action("deleting", async (i, log) => {
    await dropSessions(i.name, log);
    await provider.delete(i.name, log);
  }));

  /** Deletes the VM and creates it again from `spec`, ending and dropping its sessions first. */
  const recreate = async (name: string, spec: SandboxSpec, log: Log) => {
    await dropSessions(name, log);
    await provider.delete(name, log);
    await provider.create(spec, log);
  };

  /**
   * Change resources, mounts (VM stopped), forwarded variables or the provisioning script.
   * With `?recreate=1`, delete the VM and create it again from the changed spec instead, running or not.
   */
  app.patch("/api/sandboxes/:name", async (c) => {
    const name = c.req.param("name");
    assertIdle(name);
    await known(name);
    const patch = await body<EditSpec>(c, "Body must be a JSON object of fields to change.");
    const again = c.req.query("recreate") === "1";
    const v = await provider.validateEdit(name, patch, { recreate: again });
    if (v.errors.length) throw new HttpError(400, "Can't apply these changes.", v.errors);
    const op: OpKind = again ? "recreating" : "editing";
    ops.start(name, op, (log) => (again ? recreate(name, v.spec, log) : provider.edit(name, patch, log)));
    return c.json({ name, op, warnings: v.warnings }, 202);
  });

  /** Delete, then create again from the stored spec. */
  app.post("/api/sandboxes/:name/recreate", async (c, next) => {
    const info = await known(c.req.param("name") ?? "");
    if (!info.meta) throw new HttpError(400, info.metaError ?? `${vmName(info.name)} has no stored spec to recreate from.`);
    return next();
  }, action("recreating", (i, log) => recreate(i.name, i.meta!.spec, log)));

  // ---- agent sessions --------------------------------------------------------------------

  /** The session a route names; 404 if there is none. */
  const sessionOf = (c: Context) => {
    const id = c.req.param("id")!;
    const info = sessions.get(id);
    if (!info) throw new SessionNotFound(`No session ${id}.`);
    return info;
  };

  app.get("/api/sessions", (c) => c.json(sessions.list()));

  app.post("/api/sessions", async (c) => {
    const req = await body<StartSessionRequest>(c, "Body must be JSON: { sandbox, prompt }.");
    const name = String(req?.sandbox ?? "");
    const prompt = typeof req?.prompt === "string" ? req.prompt.trim() : "";
    if (!prompt) throw new HttpError(400, "The opening prompt is empty.");
    const model = typeof req?.model === "string" && req.model && req.model !== "default" ? req.model : undefined;
    if (model && !/^[\w.\[\]-]+$/.test(model)) throw new HttpError(400, `Not a model: ${model}`);
    const ready = await readySandbox(name);
    const session = sessions.start({ sandbox: name, workdir: ready.workdir, env: ready.env, prompt, model });
    return c.json({ id: session.id }, 201);
  });

  /** The Claude account of a session's sandbox and how much of its subscription is used. */
  app.get("/api/sessions/:id/usage", async (c) => {
    const { sandbox } = sessionOf(c);
    const info = await known(sandbox);
    if (info.status !== "running") throw new HttpError(409, `${vmName(sandbox)} is not running.`);
    return c.json(await usage.get(sandbox));
  });

  /** Saved sessions that can be resumed, most recent first. */
  app.get("/api/sessions/resumable", async (c) => c.json(await sessions.resumable()));

  /** Deletes a saved session that isn't open. */
  app.delete("/api/sessions/saved/:id", async (c) => {
    if (!(await sessions.deleteSaved(c.req.param("id")))) throw new HttpError(404, `No saved session ${c.req.param("id")}.`);
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:id/resume", async (c) => {
    const stored = await sessionStore.read(c.req.param("id"));
    if (!stored?.info.claudeSessionId) throw new HttpError(404, `No saved session ${c.req.param("id")}.`);
    const ready = await readySandbox(stored.info.sandbox);
    return c.json({ id: sessions.resume(stored, ready.env).id }, 201);
  });

  app.post("/api/sessions/:id/prompt", async (c) => {
    const { id } = sessionOf(c);
    const req = await c.req.json<{ text?: unknown }>().catch(() => ({}) as { text?: unknown });
    const text = typeof req.text === "string" ? req.text.trim() : "";
    if (!text) throw new HttpError(400, "The prompt is empty.");
    sessions.prompt(id, text);
    return c.json({ ok: true }, 202);
  });

  /** Starts a new session from a copy of this one's conversation. Returns the new session's id. */
  app.post("/api/sessions/:id/fork", async (c) => {
    const from = sessionOf(c);
    const ready = await readySandbox(from.sandbox);
    return c.json({ id: sessions.fork(from.id, ready.env).id }, 201);
  });

  /** Rewinds to just before one of this session's prompts, in a new session. Returns its id and the prompt's text. */
  app.post("/api/sessions/:id/rewind", async (c) => {
    const from = sessionOf(c);
    const req = await c.req.json<{ prompt?: unknown; files?: unknown }>().catch(() => ({}) as { prompt?: unknown; files?: unknown });
    if (typeof req.prompt !== "string" || !req.prompt) throw new HttpError(400, "Which message to rewind to?");
    const ready = await readySandbox(from.sandbox);
    const { info, text } = await sessions.rewind(from.id, req.prompt, ready.env, { files: req.files === true });
    return c.json({ id: info.id, text } satisfies RewindResponse, 201);
  });

  app.post("/api/sessions/:id/interrupt", (c) => {
    sessions.interrupt(sessionOf(c).id);
    return c.json({ ok: true }, 202);
  });

  app.delete("/api/sessions/:id", async (c) => {
    await sessions.remove(sessionOf(c).id);
    return c.json({ ok: true });
  });

  app.all("/api/*", (c) => c.json(fail("Not found."), 404));
  if (opts.webDir) app.get("*", serveWeb(opts.webDir));

  // ---- http + websocket -------------------------------------------------------------------

  const server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port: opts.port ?? 4317, hostname: host }, () => resolve(s as Server)) as Server;
  });

  const wss = new WebSocketServer({ noServer: true });
  const sessionSockets = new Set<WebSocket>();
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const sessionId = /^\/api\/sessions\/([^/]+)\/events$/.exec(url.pathname)?.[1];
    // An unknown session is accepted and closed with 4404, which a browser can see; an HTTP 404 would look like a network error.
    if ((url.pathname !== "/api/events" && !(sessionId && SESSION_ID_PATTERN.test(sessionId))) || !isLocalRequest(req.headers)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (sessionId) return streamSession(ws, sessionId, Number(url.searchParams.get("after") ?? 0) || 0);
      clients.add(ws);
      ws.on("close", () => clients.delete(ws));
      ws.on("error", () => clients.delete(ws));
      ws.send(JSON.stringify({ type: "snapshot", sandboxes: views(), logs: ops.logs(), sessions: sessions.list(), error: listError } satisfies ServerEvent));
    });
  });

  /** Replays a session's events after `after`, then streams new ones; closes when the session is removed. */
  const streamSession = (ws: WebSocket, id: string, after: number) => {
    sessionSockets.add(ws);
    const send = (ev: SessionEvent) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(ev));
    const unsubscribe = sessions.subscribe(id, after, { event: send, gone: () => ws.close(4404, "session removed") });
    const done = () => {
      unsubscribe?.();
      sessionSockets.delete(ws);
    };
    ws.on("close", done);
    ws.on("error", done);
    if (!unsubscribe) ws.close(4404, "no such session");
  };

  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://${host}:${port}`,
    port,
    close: async () => {
      clearInterval(timer);
      await sessions.endAll("quit");
      await sessions.flush();
      for (const ws of clients) ws.terminate();
      // Closed rather than terminated, so each tab still gets its session's last event.
      for (const ws of sessionSockets) ws.close(1001, "server closing");
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
