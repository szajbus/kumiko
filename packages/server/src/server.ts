import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { WebSocketServer, type WebSocket } from "ws";
import {
  DEFAULTS,
  ENV_NAME_PATTERN,
  isWaiting,
  NAME_PATTERN,
  SESSION_ID_PATTERN,
  vmName,
  type AccountUsage,
  type ApiError,
  type CreateProjectRequest,
  type CreateResponse,
  type DefaultsResponse,
  type EditSpec,
  type LoginAccount,
  type LoginStartResponse,
  type OpKind,
  type Project,
  type ProjectEdit,
  type ProjectView,
  type RewindResponse,
  type SandboxInfo,
  type SandboxSpec,
  type SandboxView,
  type ServerEvent,
  type SessionEvent,
  type StartSessionRequest,
  type TemplatesResponse,
  type WorktreesResponse,
} from "@bentomo/shared";
import { LimaProvider, validateSpec, type Log, type SandboxProvider } from "@bentomo/sandbox";
import { ClaudeDriver, type AgentDriver } from "@bentomo/agent";
import { GitError, worktreeStatuses } from "./git.js";
import { isLocalRequest } from "./guard.js";
import { LoginFailed, Logins } from "./logins.js";
import { BusyError, Operations } from "./operations.js";
import { ProjectStore } from "./projects.js";
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
  /** Where projects and their Claude homes are kept; defaults to Bentomo's home (`BENTOMO_HOME` or `~/.bentomo`). */
  dataDir?: string;
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
  const projects = new ProjectStore(opts.dataDir);
  const logins = new Logins(provider.exec.bind(provider));
  const sessionStore = new SessionStore(opts.sessionsDir);
  const sessions = new Sessions(opts.driver ?? (() => new ClaudeDriver(provider.exec.bind(provider))), sessionStore);
  const clients = new Set<WebSocket>();
  const readUsage = opts.usage ?? ((sandbox: string, forwarded: string[]) => fetchAccountUsage(provider.exec.bind(provider), sandbox, forwarded));
  // The probe forwards the sandbox's variables, as sessions do, in case the login is CLAUDE_CODE_OAUTH_TOKEN.
  const usage = new UsageCache((sandbox) => readUsage(sandbox, infos.find((i) => i.name === sandbox)?.meta?.spec.env ?? []));

  // ---- list state -------------------------------------------------------------------------

  let infos: SandboxInfo[] = [];
  let projectList: Project[] = [];
  /** What is wrong with each project's folders on the host, by id. */
  let problems = new Map<string, string>();
  let listError: string | undefined;
  let lastListJson = "";
  let refreshing: Promise<void> | undefined;
  let refreshAgain = false;

  const broadcast = (ev: ServerEvent) => {
    const msg = JSON.stringify(ev);
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(msg);
  };

  /** Each project with its VM's view. A project whose VM doesn't exist (yet) shows as `absent`, or `unknown` while busy. */
  const views = (): ProjectView[] => {
    const vms = ops.views(infos, sessions.liveCounts());
    const waiting = new Map<string, number>();
    for (const s of sessions.list()) if (isWaiting(s)) waiting.set(s.sandbox, (waiting.get(s.sandbox) ?? 0) + 1);
    return projectList.map((project) => {
      const vm: SandboxView = vms.find((v) => v.name === project.id) ?? { name: project.id, status: "absent", vm: vmName(project.id), provider: "lima", busy: false, sessions: 0 };
      const problem = problems.get(project.id);
      return { ...vm, project, waiting: waiting.get(project.id) ?? 0, ...(problem ? { problem } : {}) };
    });
  };

  const pushListIfChanged = () => {
    const list = views();
    const json = JSON.stringify({ list, listError });
    if (json === lastListJson) return;
    lastListJson = json;
    broadcast({ type: "list", projects: list, error: listError });
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
        projectList = await projects.list();
        problems = new Map((await Promise.all(projectList.map(async (p) => [p.id, await projects.problem(p)] as const))).filter((e): e is [string, string] => Boolean(e[1])));
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
    if (err instanceof LoginFailed) return c.json(fail(err.message, err.output), 422);
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

  /** Looks up a project: 400 for a bad id, 404 for an unknown one. Returns it with its VM's current state. */
  const known = async (id: string): Promise<{ project: Project; info: SandboxInfo }> => {
    if (!NAME_PATTERN.test(id)) throw new HttpError(400, `Invalid project name "${id}".`);
    await refresh();
    const project = projectList.find((p) => p.id === id);
    if (!project) throw new HttpError(404, `There is no project ${id}.`);
    return { project, info: infos.find((i) => i.name === id) ?? { name: id, status: "absent" } };
  };

  /**
   * A project a session can start in: VM running and not busy. Refreshes Bentomo's instructions in its Claude home,
   * so they follow the app. Returns where sessions start (the clone) and what they forward.
   */
  const readyProject = async (id: string): Promise<{ workdir: string; env: string[] }> => {
    const { project, info } = await known(id);
    if (info.status !== "running") throw new HttpError(409, `${vmName(id)} is not running. Start it first.`);
    assertIdle(id);
    await projects.writeManaged(project);
    return { workdir: project.clonePath, env: info.meta?.spec.env ?? [] };
  };

  /** The VM's spec for a (re)create: the stored one with the project's fixed mounts made current, or the defaults. */
  const vmSpec = (project: Project, info: SandboxInfo): SandboxSpec =>
    projects.spec(project, info.meta?.spec ?? { ...DEFAULTS, mounts: [], env: [] });

  app.get("/api/projects", async (c) => {
    await refresh();
    return c.json(views());
  });

  let templatesCache: TemplatesResponse | undefined;
  app.get("/api/templates", async (c) => {
    templatesCache ??= await provider.templates();
    return c.json(templatesCache);
  });

  app.get("/api/defaults", (c) => c.json({ home: opts.home ?? homedir(), claudeHomes: projects.claudeRoot } satisfies DefaultsResponse));

  /** Which of the given variable names are set in Bentomo's environment. Never returns values. */
  app.get("/api/env", (c) => {
    const names = (c.req.query("names") ?? "").split(",").map((n) => n.trim()).filter((n) => ENV_NAME_PATTERN.test(n));
    const e = env();
    return c.json(Object.fromEntries(names.map((n) => [n, e[n] !== undefined])));
  });

  /**
   * Creates a project from a local clone: checks it, creates `<clone>__worktrees` and the project's Claude home, then
   * creates its VM in the background. Fails without leaving anything behind if a check fails.
   */
  app.post("/api/projects", async (c) => {
    const req = await body<CreateProjectRequest>(c, "Body must be JSON: { name, clonePath, cpus, memoryGiB, diskGiB, mounts, env }.");
    const id = String(req?.name ?? "").trim();
    assertIdle(id);
    const checked = await projects.check(id, String(req?.clonePath ?? ""));
    // The VM's own settings, before anything is made on the host; the fixed mounts are checked once they exist.
    const { errors: specErrors } = await validateSpec({ ...req, name: id, mounts: Array.isArray(req?.mounts) ? req.mounts : [], workdir: undefined }, env());
    const errors = [...checked.errors, ...specErrors.filter((e) => !e.startsWith("Name must"))];
    if (errors.length || !checked.clonePath || !checked.worktreesPath) throw new HttpError(400, "Can't create this project.", errors);

    const { project, rollback } = await projects.create(id, checked.clonePath, checked.worktreesPath).catch((err: unknown) => {
      throw new HttpError(409, err instanceof Error ? err.message : String(err));
    });
    const v = await provider.validate(projects.spec(project, { ...req, mounts: req.mounts ?? [], env: req.env ?? [] }));
    if (v.errors.length) {
      await rollback();
      throw new HttpError(400, "Can't create this project.", v.errors);
    }
    try {
      ops.start(id, "creating", (log) => provider.create(v.spec, log));
    } catch (err) {
      // The record is this request's own claim, so undoing it can't touch another project's.
      await rollback();
      throw err;
    }
    void refresh();
    return c.json({ name: id, warnings: v.warnings } satisfies CreateResponse, 202);
  });

  const action = (op: OpKind, work: (project: Project, info: SandboxInfo, log: Log) => Promise<void>) => async (c: Context) => {
    const id = c.req.param("id")!;
    assertIdle(id);
    const { project, info } = await known(id);
    ops.start(id, op, (log) => work(project, info, log));
    return c.json({ name: id, op }, 202);
  };

  /** The VM can't start without the clone and worktrees folder it mounts. */
  const assertFolders = async (project: Project) => {
    const problem = await projects.problem(project);
    if (problem) throw new HttpError(409, problem);
  };

  app.post("/api/projects/:id/start", async (c, next) => {
    const { project, info } = await known(c.req.param("id") ?? "");
    if (info.status === "absent") throw new HttpError(409, `${vmName(project.id)} doesn't exist. Recreate it.`);
    await assertFolders(project);
    return next();
  }, action("starting", async (p, _i, log) => {
    await projects.writeManaged(p);
    await provider.start(p.id, log);
  }));
  app.post("/api/projects/:id/stop", action("stopping", async (p, _i, log) => {
    await endSessions(p.id, log);
    await provider.stop(p.id, log);
  }));

  /** Deletes the project: its VM, its Claude home (login and Claude's history) and its saved sessions. The clone and worktrees stay. */
  app.delete("/api/projects/:id", action("deleting", async (p, _i, log) => {
    await endSessions(p.id, log);
    await provider.delete(p.id, log);
    await sessions.deleteSavedFor(p.id);
    await projects.remove(p.id);
    log(`Deleted the project's Claude home. ${p.clonePath} and its worktrees are untouched.`, "note");
  }));

  /**
   * Deletes the VM and creates it again from `spec`, ending its sessions first. Saved sessions stay resumable: Claude's
   * history is in the project's Claude home, on the host.
   */
  const recreate = async (project: Project, spec: SandboxSpec, log: Log) => {
    await endSessions(project.id, log);
    await provider.delete(project.id, log);
    await projects.writeManaged(project);
    await provider.create(spec, log);
  };

  /**
   * Change resources, extra mounts (VM stopped), forwarded variables or the provisioning script. `mounts` are the extra
   * ones; the project's own are added back. With `?recreate=1`, delete the VM and create it again from the changed spec.
   */
  app.patch("/api/projects/:id", async (c) => {
    const id = c.req.param("id");
    assertIdle(id);
    const { project, info } = await known(id);
    const raw = await body<ProjectEdit>(c, "Body must be a JSON object of fields to change.");
    const { workdir: _workdir, ...edit } = (raw ?? {}) as EditSpec;
    const patch: EditSpec = edit.mounts ? { ...edit, mounts: projects.spec(project, { ...DEFAULTS, mounts: edit.mounts, env: [] }).mounts } : edit;
    const again = c.req.query("recreate") === "1";
    if (again && info.status === "absent") {
      // Nothing to edit in place: build the VM from the stored spec with the changes.
      const v = await validateSpec({ ...vmSpec(project, info), ...patch, name: id, workdir: project.clonePath }, env());
      if (v.errors.length) throw new HttpError(400, "Can't apply these changes.", v.errors);
      ops.start(id, "recreating", (log) => recreate(project, v.spec, log));
      return c.json({ name: id, op: "recreating", warnings: v.warnings }, 202);
    }
    const v = await provider.validateEdit(id, patch, { recreate: again });
    if (v.errors.length) throw new HttpError(400, "Can't apply these changes.", v.errors);
    const op: OpKind = again ? "recreating" : "editing";
    if (again) await assertFolders(project);
    ops.start(id, op, (log) => (again ? recreate(project, projects.spec(project, v.spec), log) : provider.edit(id, patch, log)));
    return c.json({ name: id, op, warnings: v.warnings }, 202);
  });

  /** Delete, then create again from the stored spec (or the defaults, if there is none). */
  app.post("/api/projects/:id/recreate", async (c, next) => {
    const { project, info } = await known(c.req.param("id") ?? "");
    if (info.metaError) throw new HttpError(400, info.metaError);
    await assertFolders(project);
    return next();
  }, action("recreating", (p, i, log) => recreate(p, vmSpec(p, i), log)));

  /** The clone's worktrees, from git on the host, with what needs attention in each. */
  app.get("/api/projects/:id/worktrees", async (c) => {
    const { project } = await known(c.req.param("id") ?? "");
    await assertFolders(project);
    try {
      return c.json((await worktreeStatuses(project.clonePath)) satisfies WorktreesResponse);
    } catch (err) {
      if (err instanceof GitError) throw new HttpError(500, `git: ${err.message}`);
      throw err;
    }
  });

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
    const ready = await readyProject(name);
    const session = sessions.start({ sandbox: name, workdir: ready.workdir, env: ready.env, prompt, model });
    return c.json({ id: session.id }, 201);
  });

  /** The Claude account of a session's sandbox and how much of its subscription is used. */
  app.get("/api/sessions/:id/usage", async (c) => {
    const { sandbox } = sessionOf(c);
    const { info } = await known(sandbox);
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
    const ready = await readyProject(stored.info.sandbox);
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
    const ready = await readyProject(from.sandbox);
    return c.json({ id: sessions.fork(from.id, ready.env).id }, 201);
  });

  /** Rewinds to just before one of this session's prompts, in a new session. Returns its id and the prompt's text. */
  app.post("/api/sessions/:id/rewind", async (c) => {
    const from = sessionOf(c);
    const req = await c.req.json<{ prompt?: unknown; files?: unknown }>().catch(() => ({}) as { prompt?: unknown; files?: unknown });
    if (typeof req.prompt !== "string" || !req.prompt) throw new HttpError(400, "Which message to rewind to?");
    const ready = await readyProject(from.sandbox);
    const { info, text } = await sessions.rewind(from.id, req.prompt, ready.env, { files: req.files === true });
    return c.json({ id: info.id, text } satisfies RewindResponse, 201);
  });

  // A login is the project's: its Claude home holds it, so every session of the project shares it. It is started from
  // a session because that is where being logged out shows.

  /** Starts logging Claude in for the session's project: the sign-in URL, or who it is logged in as already. */
  app.post("/api/sessions/:id/login", async (c) => {
    const { sandbox } = sessionOf(c);
    const ready = await readyProject(sandbox);
    return c.json((await logins.start(sandbox, ready.workdir)) satisfies LoginStartResponse);
  });

  /** Finishes the login with the code from the sign-in page. 422 with Claude's output if it doesn't take. */
  app.post("/api/sessions/:id/login/code", async (c) => {
    const { sandbox } = sessionOf(c);
    const req = await c.req.json<{ code?: unknown }>().catch(() => ({}) as { code?: unknown });
    if (typeof req.code !== "string" || !req.code.trim()) throw new HttpError(400, "Paste the code from the sign-in page.");
    const account = await logins.finish(sandbox, req.code);
    usage.forget(sandbox);
    return c.json(account satisfies LoginAccount);
  });

  app.delete("/api/sessions/:id/login", (c) => {
    logins.cancel(sessionOf(c).sandbox);
    return c.json({ ok: true });
  });

  /**
   * After a login: starts the session's Claude again (a process that started logged out stays so) and sends the last
   * prompt again, the one that failed.
   */
  app.post("/api/sessions/:id/retry", async (c) => {
    const { id, sandbox } = sessionOf(c);
    const ready = await readyProject(sandbox);
    const last = sessions.events(id).findLast((e) => e.kind === "user_prompt");
    sessions.relaunch(id, ready.env);
    if (last?.kind === "user_prompt") sessions.prompt(id, last.payload.text);
    return c.json({ ok: true }, 202);
  });

  /** The user is looking at the session, so it no longer waits on them. */
  app.post("/api/sessions/:id/seen", (c) => {
    sessions.markSeen(sessionOf(c).id);
    return c.json({ ok: true });
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
      ws.send(JSON.stringify({ type: "snapshot", projects: views(), logs: ops.logs(), sessions: sessions.list(), error: listError } satisfies ServerEvent));
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
      logins.cancelAll();
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
