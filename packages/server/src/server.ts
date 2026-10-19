import { stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { WebSocketServer, type WebSocket } from "ws";
import {
  ENV_NAME_PATTERN,
  NAME_PATTERN,
  vmName,
  WORKSPACE_DIR,
  type ApiError,
  type CreateResponse,
  type DefaultsResponse,
  type EditSpec,
  type OpKind,
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
import { SessionEnded, SessionNotFound, SessionNotResumable, Sessions } from "./sessions.js";
import { SessionStore } from "./store.js";
import { serveWeb } from "./static.js";

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

  app.use("/api/*", async (c, next) => {
    if (!isLocalRequest(c.req.raw.headers)) return c.json(fail("Forbidden: not a local request."), 403);
    await next();
  });

  app.get("/api/sandboxes", async (c) => {
    await refresh();
    if (listError && infos.length === 0) return c.json(fail(listError), 500);
    return c.json(views());
  });

  let templatesCache: TemplatesResponse | undefined;
  app.get("/api/templates", async (c) => {
    try {
      templatesCache ??= await provider.templates();
      return c.json(templatesCache);
    } catch (err) {
      return c.json(fail(err instanceof Error ? err.message : String(err)), 500);
    }
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

  const begin = (name: string, op: OpKind, work: (log: Log) => Promise<void>) => {
    ops.start(name, op, work);
  };

  app.post("/api/sandboxes", async (c) => {
    let body: SandboxSpec;
    try {
      body = await c.req.json<SandboxSpec>();
    } catch {
      return c.json(fail("Body must be a JSON SandboxSpec."), 400);
    }
    const name = String(body?.name ?? "").trim();
    if (ops.running(name)) return c.json(fail(`${vmName(name)} is busy ${ops.get(name)!.op}.`), 409);
    let v;
    try {
      v = await provider.validate(body);
    } catch (err) {
      return c.json(fail(err instanceof Error ? err.message : String(err)), 500);
    }
    if (v.errors.length) return c.json(fail("Invalid sandbox spec.", v.errors), 400);
    try {
      begin(v.spec.name, "creating", (log) => provider.create(v.spec, log));
    } catch (err) {
      if (err instanceof BusyError) return c.json(fail(err.message), 409);
      throw err;
    }
    void refresh();
    return c.json({ name: v.spec.name, warnings: v.warnings } satisfies CreateResponse, 202);
  });

  /** Looks up a sandbox the provider knows; 400 for a bad name, 404 for an unknown one. */
  const known = async (name: string): Promise<SandboxInfo | ApiError> => {
    if (!NAME_PATTERN.test(name)) return fail(`Invalid sandbox name "${name}".`);
    await refresh();
    return infos.find((i) => i.name === name) ?? fail(`${vmName(name)} does not exist.`);
  };

  const action = (op: OpKind, work: (info: SandboxInfo, log: Log) => Promise<void>) => async (c: Context) => {
    const name = c.req.param("name")!;
    const cur = ops.get(name);
    if (cur && !cur.endedAt) return c.json(fail(`${vmName(name)} is busy ${cur.op}.`), 409);
    const info = await known(name);
    if ("error" in info) return c.json(info, NAME_PATTERN.test(name) ? 404 : 400);
    try {
      begin(name, op, (log) => work(info, log));
    } catch (err) {
      if (err instanceof BusyError) return c.json(fail(err.message), 409);
      throw err;
    }
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

  /**
   * Change resources, mounts (VM stopped), forwarded variables or the provisioning script.
   * With `?recreate=1`, delete the VM and create it again from the changed spec instead, running or not.
   */
  app.patch("/api/sandboxes/:name", async (c) => {
    const name = c.req.param("name");
    const cur = ops.get(name);
    if (cur && !cur.endedAt) return c.json(fail(`${vmName(name)} is busy ${cur.op}.`), 409);
    const info = await known(name);
    if ("error" in info) return c.json(info, NAME_PATTERN.test(name) ? 404 : 400);
    let patch: EditSpec;
    try {
      patch = await c.req.json<EditSpec>();
    } catch {
      return c.json(fail("Body must be a JSON object of fields to change."), 400);
    }
    const recreate = c.req.query("recreate") === "1";
    const v = await provider.validateEdit(name, patch, { recreate });
    if (v.errors.length) return c.json(fail("Can't apply these changes.", v.errors), 400);
    const op: OpKind = recreate ? "recreating" : "editing";
    try {
      begin(name, op, async (log) => {
        if (!recreate) return provider.edit(name, patch, log);
        await dropSessions(name, log);
        await provider.delete(name, log);
        await provider.create(v.spec, log);
      });
    } catch (err) {
      if (err instanceof BusyError) return c.json(fail(err.message), 409);
      throw err;
    }
    return c.json({ name, op, warnings: v.warnings }, 202);
  });

  /** Delete, then create again from the stored spec. */
  app.post("/api/sandboxes/:name/recreate", async (c, next) => {
    const info = await known(c.req.param("name") ?? "");
    if (!("error" in info) && !info.meta) return c.json(fail(`${vmName(info.name)} has no stored spec to recreate from.`), 400);
    return next();
  }, action("recreating", async (i, log) => {
    const spec = i.meta!.spec;
    await dropSessions(i.name, log);
    await provider.delete(i.name, log);
    await provider.create(spec, log);
  }));

  // ---- agent sessions --------------------------------------------------------------------

  app.get("/api/sessions", (c) => c.json(sessions.list()));

  app.post("/api/sessions", async (c) => {
    let body: StartSessionRequest;
    try {
      body = await c.req.json<StartSessionRequest>();
    } catch {
      return c.json(fail("Body must be JSON: { sandbox, prompt }."), 400);
    }
    const name = String(body?.sandbox ?? "");
    const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) return c.json(fail("The opening prompt is empty."), 400);
    const ready = await readySandbox(name);
    if (ready instanceof Response) return ready;
    const session = sessions.start({ sandbox: name, workdir: ready.workdir, env: ready.env, prompt });
    return c.json({ id: session.id }, 201);
  });

  /** A sandbox a session can start in: running and not busy; otherwise the error response to send. */
  const readySandbox = async (name: string): Promise<Response | { workdir: string; env: string[] }> => {
    const info = await known(name);
    if ("error" in info) return new Response(JSON.stringify(info), { status: NAME_PATTERN.test(name) ? 404 : 400, headers: { "content-type": "application/json" } });
    const refuse = (message: string) => new Response(JSON.stringify(fail(message)), { status: 409, headers: { "content-type": "application/json" } });
    if (info.status !== "running") return refuse(`${vmName(name)} is not running. Start it first.`);
    const cur = ops.get(name);
    if (cur && !cur.endedAt) return refuse(`${vmName(name)} is busy ${cur.op}.`);
    const spec = info.meta?.spec;
    return { workdir: spec?.workdir ?? WORKSPACE_DIR, env: spec?.env ?? [] };
  };

  /** Saved sessions that can be resumed, most recent first. */
  app.get("/api/sessions/resumable", async (c) => c.json(await sessions.resumable()));

  /** Deletes a saved session that isn't open. */
  app.delete("/api/sessions/saved/:id", async (c) => {
    try {
      if (!(await sessions.deleteSaved(c.req.param("id")))) return c.json(fail(`No saved session ${c.req.param("id")}.`), 404);
    } catch (err) {
      if (err instanceof SessionNotResumable) return c.json(fail("This session is open; close its tab first."), 409);
      throw err;
    }
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:id/resume", async (c) => {
    const stored = await sessionStore.read(c.req.param("id"));
    if (!stored?.info.claudeSessionId) return c.json(fail(`No saved session ${c.req.param("id")}.`), 404);
    const ready = await readySandbox(stored.info.sandbox);
    if (ready instanceof Response) return ready;
    try {
      return c.json({ id: sessions.resume(stored, ready.env).id }, 201);
    } catch (err) {
      if (err instanceof SessionNotResumable) return c.json(fail("This session is already open."), 409);
      throw err;
    }
  });

  /** Runs `fn` on a session: 404 if it doesn't exist, 409 if it has ended. */
  const onSession = (fn: (id: string, c: Context) => Promise<Response> | Response) => async (c: Context) => {
    try {
      return await fn(c.req.param("id")!, c);
    } catch (err) {
      if (err instanceof SessionNotFound) return c.json(fail(err.message), 404);
      if (err instanceof SessionEnded || err instanceof SessionNotResumable) return c.json(fail(err.message), 409);
      throw err;
    }
  };

  app.post("/api/sessions/:id/prompt", onSession(async (id, c) => {
    const body = await c.req.json<{ text?: unknown }>().catch(() => ({}) as { text?: unknown });
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return c.json(fail("The prompt is empty."), 400);
    sessions.prompt(id, text);
    return c.json({ ok: true }, 202);
  }));

  /** Starts a new session from a copy of this one's conversation. Returns the new session's id. */
  app.post("/api/sessions/:id/fork", onSession(async (id, c) => {
    const from = sessions.get(id);
    if (!from) throw new SessionNotFound(`No session ${id}.`);
    const ready = await readySandbox(from.sandbox);
    if (ready instanceof Response) return ready;
    return c.json({ id: sessions.fork(id, ready.env).id }, 201);
  }));

  app.post("/api/sessions/:id/interrupt", onSession((id, c) => {
    sessions.interrupt(id);
    return c.json({ ok: true }, 202);
  }));

  app.delete("/api/sessions/:id", onSession(async (id, c) => {
    if (!sessions.get(id)) throw new SessionNotFound(`No session ${id}.`);
    await sessions.remove(id);
    return c.json({ ok: true });
  }));

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
    const sessionId = /^\/api\/sessions\/([0-9a-f]+)\/events$/.exec(url.pathname)?.[1];
    // An unknown session is accepted and closed with 4404, which a browser can see; an HTTP 404 would look like a network error.
    if ((url.pathname !== "/api/events" && !sessionId) || !isLocalRequest(req.headers)) {
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
