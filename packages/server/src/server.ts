import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
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
  parseSavedTabs,
  SESSION_ID_PATTERN,
  artifactsOf,
  IMAGE_TYPES,
  nextId,
  slotOf,
  urlOrigin,
  vmName,
  WindowError,
  type ApiError,
  type CreateProjectRequest,
  type CreateResponse,
  type DefaultsResponse,
  type EditSpec,
  type ForkRequest,
  type LoginAccount,
  type LoginStartResponse,
  type LoginStatusResponse,
  type PromptRequest,
  type OpKind,
  type Project,
  type ProjectEdit,
  type ProjectView,
  type RewindResponse,
  type SandboxInfo,
  type SandboxSpec,
  type ServerEvent,
  type SessionStreamMessage,
  type SessionInfo,
  type StartSessionRequest,
  type TemplatesResponse,
  type ArtifactState,
  type Side,
  type WindowOp,
  type WorktreesResponse,
} from "@kumiko/shared";
import { LimaProvider, validateSpec, type Log, type SandboxProvider } from "@kumiko/sandbox";
import { ClaudeDriver, execOutput, Runs, type AgentDriver } from "@kumiko/agent";
import { AttachmentRefused, AttachmentStore } from "./attachments.js";
import { ArtifactContent } from "./content.js";
import { GitError, worktreeStatuses } from "./git.js";
import { isLocalRequest } from "./guard.js";
import { LoginFailed, Logins } from "./logins.js";
import { BusyError, Operations } from "./operations.js";
import { homeId, lockHome } from "./home.js";
import { defaultKumikoHome, ProjectExists, ProjectRecordError, ProjectStore } from "./projects.js";
import { RewindRefused, SessionEnded, SessionNotFound, SessionNotResumable, Sessions } from "./sessions.js";
import { docSlotTarget, Widgets, type PaneAnswer } from "./widgets.js";
import { SessionStore, type StoredSession } from "./store.js";
import { TabsStore } from "./tabs.js";
import { serveWeb } from "./static.js";
import { sandboxUsageSource, UsageCache, type UsageSource } from "./usage.js";

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
  /** Where projects and their Claude homes are kept; defaults to Kumiko's home (`KUMIKO_HOME` or `~/.kumiko`). */
  dataDir?: string;
  /** Where forwarded variables are looked up for the form's "set on host" dots. */
  env?: () => NodeJS.ProcessEnv;
  /** Where sessions are saved for resuming; defaults to `sessions` in Kumiko's home (`KUMIKO_HOME` or `~/.kumiko`). */
  sessionsDir?: string;
  /** Makes the driver for each new agent session; defaults to Claude Code over the provider's exec. */
  driver?: () => AgentDriver;
  /** Finds and removes the runs agents work in, in each sandbox; defaults to the provider's exec. */
  runs?: Pick<Runs, "list" | "remove">;
  /** How long to wait for another server to let go of the Kumiko home before refusing to start, in ms. */
  lockWaitMs?: number;
  /** Reads the account and usage of the Claude in a sandbox; defaults to asking Claude inside it. Usage is cached per account. */
  usage?: UsageSource;
}

export interface RunningServer {
  url: string;
  port: number;
  /** Sessions Claude is working in right now. */
  working(): SessionInfo[];
  /**
   * Stops the server. Claude keeps working in every live session, for the next server on the same data to pick up;
   * with `endSessions`, every session ends first, as when its tab closes.
   */
  close(opts?: { endSessions?: boolean }): Promise<void>;
}

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const home = opts.dataDir ?? defaultKumikoHome();
  // One server per home: two would attach to the same Claudes, and each would sweep away the other's runs.
  const lock = await lockHome(home, { waitMs: opts.lockWaitMs });
  try {
    return await serveHome(opts, home, lock);
  } catch (err) {
    await lock.release();
    throw err;
  }
}

async function serveHome(opts: ServerOptions, home: string, lock: Awaited<ReturnType<typeof lockHome>>): Promise<RunningServer> {
  const owner = await homeId(home);
  const provider = opts.provider ?? new LimaProvider({ env: opts.env });
  const env = opts.env ?? (() => process.env);
  const host = opts.host ?? "127.0.0.1";
  const ops = new Operations();
  const projects = new ProjectStore(opts.dataDir);
  const logins = new Logins(provider.exec.bind(provider));
  const sessionStore = new SessionStore(opts.sessionsDir);
  // Files sent with prompts are kept as long as a saved session names them.
  const attachments = new AttachmentStore(join(sessionStore.dir, "attachments"));
  const saved = (await sessionStore.readAll()).flatMap((s) => s.events);
  await attachments.sweep(saved);
  // What windows showed of their artifacts, likewise.
  const content = new ArtifactContent(join(sessionStore.dir, "artifacts"));
  await content.sweep(saved);
  const tabs = new TabsStore(opts.dataDir);
  // Windows' widgets map the paths Claude names in its VM to the host: the project's mounts, and the VM user's home.
  const widgets = new Widgets({
    content,
    home: (sandbox) => {
      const p = projectList.find((x) => x.id === sandbox);
      return p && { claudeHome: projects.claudeHome(p.id), roots: [p.clonePath, p.worktreesPath] };
    },
    vmHome: (sandbox) => execOutput(provider.exec.bind(provider), sandbox, `printf %s "$HOME"`, 10_000),
    pane: (session, slot, what) => askPane(session, slot, what),
    reachable: async (url) => {
      try {
        await fetch(url, { method: "GET", signal: AbortSignal.timeout(3000), redirect: "manual" });
        return true;
      } catch {
        return false;
      }
    },
  });
  // What Claude asked of the windows' panes (a reload, a picture), by request id, until one answers.
  const paneRequests = new Map<string, { resolve(answer: PaneAnswer): void; reject(err: Error): void }>();
  /** How long the server waits for a window's answer: a reload and a wait of up to 10 s each, and the picture. */
  const PANE_MS = 30_000;
  const askPane = (session: string, slot: string, what: { reload: boolean; capture: boolean; wait: number }) =>
    new Promise<PaneAnswer>((resolve, reject) => {
      const request = randomUUID();
      const timer = setTimeout(() => {
        paneRequests.delete(request);
        reject(new Error("No window answered: the user needs this session's tab open and on screen in the Kumiko app. Ask them to look at it, then try again."));
      }, PANE_MS);
      paneRequests.set(request, {
        resolve: (answer) => (clearTimeout(timer), paneRequests.delete(request), resolve(answer)),
        reject: (err) => (clearTimeout(timer), paneRequests.delete(request), reject(err)),
      });
      broadcast({ type: "pane", session, slot, request, ...what });
    });
  const sessions = new Sessions(opts.driver ?? (() => new ClaudeDriver(provider.exec.bind(provider), { owner })), sessionStore, widgets);
  widgets.sessions = sessions;
  const runs = opts.runs ?? new Runs(provider.exec.bind(provider), owner);
  const clients = new Set<WebSocket>();
  const usage = new UsageCache(
    opts.usage ?? sandboxUsageSource(provider.exec.bind(provider), (sandbox) => infos.find((i) => i.name === sandbox)?.meta?.spec.env ?? []),
  );

  // ---- list state -------------------------------------------------------------------------

  let infos: SandboxInfo[] = [];
  let projectList: Project[] = [];
  /** Why each project record that can't be used can't be; those projects are left out of the list. */
  let unreadable: string[] = [];
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

  /** A project's VM as last listed; `absent` when the provider has neither the VM nor a record of it. */
  const infoOf = (id: string): SandboxInfo => infos.find((i) => i.name === id) ?? { name: id, status: "absent" };

  /** Each project with its VM's view. VMs that aren't a project's are left out. */
  const views = (): ProjectView[] => {
    const vms = ops.views(projectList.map((p) => infoOf(p.id)), sessions.liveCounts());
    const waiting = new Map<string, number>();
    for (const s of sessions.list()) if (isWaiting(s)) waiting.set(s.sandbox, (waiting.get(s.sandbox) ?? 0) + 1);
    return projectList.map((project) => {
      const vm = vms.find((v) => v.name === project.id)!;
      const problem = problems.get(project.id);
      return { ...vm, project, waiting: waiting.get(project.id) ?? 0, ...(problem ? { problem } : {}) };
    });
  };

  const pushListIfChanged = () => {
    const list = views();
    const json = JSON.stringify({ list, unreadable, listError });
    if (json === lastListJson) return;
    lastListJson = json;
    broadcast({ type: "list", projects: list, unreadable, error: listError });
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
        ({ projects: projectList, errors: unreadable } = await projects.list());
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

  /** Sessions whose sandbox stopped or vanished outside Kumiko end too. */
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

  /** Saves that a session's run is over, without having seen it end: the VM restarted, say. It stays resumable. */
  const markRunDead = (stored: StoredSession) =>
    stored.run?.live ? sessionStore.write({ ...stored, run: { ...stored.run, live: false } }) : Promise.resolve();

  /** Runs in the sandbox that no saved session will attach to again; their agents are stopped and the runs deleted. */
  const sweepRuns = async (sandbox: string, found: Map<string, unknown>) => {
    await sessions.flush();
    const wanted = new Set((await sessionStore.readAll()).flatMap((x) => (x.run?.live ? [x.run.id] : [])));
    await runs.remove(sandbox, [...found.keys()].filter((id) => !wanted.has(id))).catch(() => {});
  };

  /**
   * Picks up the sessions a server before this one left working: those whose Claude still runs, or has exited since,
   * are open again, as they were. Those whose sandbox isn't running, or whose run is gone, are only saved, to resume.
   * Runs nobody will pick up are removed.
   */
  const reopenSessions = async () => {
    const saved = (await sessionStore.readAll()).filter((x) => x.run?.live);
    const running = projectList.map((p) => p.id).filter((id) => infoOf(id).status === "running");
    await Promise.all(
      running.map(async (sandbox) => {
        let found: Map<string, string>;
        try {
          found = await runs.list(sandbox);
        } catch {
          // Can't tell; they stay as they are, and resuming one asks again.
          return;
        }
        for (const stored of saved.filter((x) => x.info.sandbox === sandbox)) {
          const state = found.get(stored.run!.id);
          try {
            if (state === "alive" || state === "exited") {
              sessions.reopen(stored);
              continue;
            }
          } catch {
            // A saved run that can't be attached to (not a run id, say) is as good as gone.
          }
          await markRunDead(stored);
        }
        await sweepRuns(sandbox, found);
      }),
    );
    await Promise.all(saved.filter((x) => !running.includes(x.info.sandbox)).map(markRunDead));
  };

  const timer = setInterval(() => void refresh(), opts.refreshMs ?? 5000);
  await refresh();
  await reopenSessions();

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
    if (err instanceof AttachmentRefused || err instanceof WindowError) return c.json(fail(err.message), 400);
    if (err instanceof LoginFailed) return c.json(fail(err.message, err.output), 422);
    if (err instanceof BusyError || err instanceof ProjectExists || err instanceof ProjectRecordError) return c.json(fail(err.message), 409);
    if (err instanceof SessionNotFound) return c.json(fail(err.message), 404);
    if (err instanceof SessionEnded || err instanceof SessionNotResumable || err instanceof RewindRefused) return c.json(fail(err.message), 409);
    // Anything else is a bug or a tool failing; the UI still gets JSON it can show.
    return c.json(fail(err instanceof Error ? err.message : String(err)), 500);
  });

  /** The port the server listens on, which a browser's requests must come from (see `isLocalRequest`). */
  const ownPort = () => (server.address() as AddressInfo).port;

  app.use("/api/*", async (c, next) => {
    if (!isLocalRequest(c.req.raw.headers, ownPort())) return c.json(fail("Forbidden: not a local request."), 403);
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

  /** Looks up a project's record, without asking the provider: 400 for a bad id, 404 for an unknown one. */
  const projectOf = async (id: string): Promise<Project> => {
    if (!NAME_PATTERN.test(id)) throw new HttpError(400, `Invalid project name "${id}".`);
    const project = await projects.get(id);
    if (!project) throw new HttpError(404, `There is no project ${id}.`);
    return project;
  };

  /** Looks up a project as `projectOf` does, with its VM's current state. */
  const known = async (id: string): Promise<{ project: Project; info: SandboxInfo }> => {
    const project = await projectOf(id);
    await refresh();
    return { project, info: infoOf(id) };
  };

  /**
   * A project a session can start in: VM running and not busy. Refreshes Kumiko's instructions in its Claude home,
   * so they follow the app. Returns where sessions start (the clone) and what they forward.
   */
  const readyProject = async (id: string): Promise<{ workdir: string; env: string[] }> => {
    const { project, info } = await known(id);
    if (info.status !== "running") throw new HttpError(409, `${vmName(id)} is not running. Start it first.`);
    assertIdle(id);
    await projects.writeManaged(project);
    await widgets.prepare(id);
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

  /** The window's tabs from its last run, or null if none were saved. */
  app.get("/api/tabs", async (c) => c.json((await tabs.read()) ?? null));

  app.put("/api/tabs", async (c) => {
    const saved = parseSavedTabs(await body<unknown>(c, "Body must be JSON: { sessions, newSessions, active }."));
    if (!saved) throw new HttpError(400, "Body must be JSON: { sessions, newSessions, active }.");
    await tabs.write(saved);
    return c.json({ ok: true });
  });

  /** Which of the given variable names are set in Kumiko's environment. Never returns values. */
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
    if (typeof req !== "object" || req === null) throw new HttpError(400, "Body must be a JSON object.");
    const { name: rawName, clonePath, ...rest } = req;
    const id = String(rawName ?? "").trim();
    const base = { ...rest, mounts: Array.isArray(rest.mounts) ? rest.mounts : [], env: Array.isArray(rest.env) ? rest.env : [] };
    assertIdle(id);
    const checked = await projects.check(id, String(clonePath ?? ""));
    // The VM's own settings, before anything is made on the host; the fixed mounts are checked once they exist.
    const { errors: specErrors } = await validateSpec({ ...base, name: id }, env());
    // Both checks know a bad name; it is said once.
    const errors = [...new Set([...checked.errors, ...specErrors])];
    if (errors.length || !checked.clonePath || !checked.worktreesPath) throw new HttpError(400, "Can't create this project.", errors);

    const { project, rollback } = await projects.create(id, checked.clonePath, checked.worktreesPath);
    const v = await provider.validate(projects.spec(project, base));
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

  type Work = (project: Project, info: SandboxInfo, log: Log) => Promise<void>;

  /** An operation on a project's VM, run in the background. `check` can refuse it first, by throwing. */
  const action = (op: OpKind, work: Work, check?: (project: Project, info: SandboxInfo) => Promise<void>) => async (c: Context) => {
    const id = c.req.param("id")!;
    assertIdle(id);
    const { project, info } = await known(id);
    await check?.(project, info);
    ops.start(id, op, (log) => work(project, info, log));
    return c.json({ name: id, op }, 202);
  };

  /** The VM can't start without the clone and worktrees folder it mounts. */
  const assertFolders = async (project: Project) => {
    const problem = await projects.problem(project);
    if (problem) throw new HttpError(409, problem);
  };

  const startVm: Work = async (p, _i, log) => {
    await projects.writeManaged(p);
    await provider.start(p.id, log);
    // Runs left from before the VM stopped have nothing running in them any more.
    await sweepRuns(p.id, await runs.list(p.id).catch(() => new Map()));
  };
  const checkStart = async (p: Project, i: SandboxInfo) => {
    if (i.status === "absent") throw new HttpError(409, `${vmName(p.id)} doesn't exist. Recreate it.`);
    await assertFolders(p);
  };

  app.post("/api/projects/:id/start", action("starting", startVm, checkStart));

  /**
   * As `readyProject`, but a stopped VM is started first, and an operation already running on it is waited out
   * (a start from the Projects page, say), so a session can be asked for in any project.
   */
  const startedProject = async (id: string): Promise<{ workdir: string; env: string[] }> => {
    const { project, info } = await known(id);
    if (info.status === "stopped" && !ops.active().includes(id)) {
      await checkStart(project, info);
      try {
        ops.start(id, "starting", (log) => startVm(project, info, log));
      } catch (err) {
        // Another request started it first; wait for that one.
        if (!(err instanceof BusyError)) throw err;
      }
    }
    const op = await ops.settled(id);
    if (op?.op === "starting" && op.result === "error") throw new HttpError(409, `${vmName(id)} didn't start: ${op.error?.split("\n")[0]}`);
    return readyProject(id);
  };
  app.post("/api/projects/:id/stop", action("stopping", async (p, _i, log) => {
    await endSessions(p.id, log);
    await provider.stop(p.id, log);
  }));

  /**
   * Stops the VM (ending its sessions) and starts it again, running `between` while it is stopped. Lima reads its
   * config on start, so resource and mount changes apply; the disk and what provisioning installed stay.
   */
  const restart = async (p: Project, i: SandboxInfo, log: Log, between?: () => Promise<void>) => {
    await endSessions(p.id, log);
    if (i.status !== "stopped") await provider.stop(p.id, log);
    await between?.();
    await startVm(p, i, log);
  };

  app.post("/api/projects/:id/restart", action("restarting", (p, i, log) => restart(p, i, log), checkStart));

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
   * ones; the project's own are added back. With `?recreate=1`, delete the VM and create it again from the changed spec;
   * with `?restart=1`, stop it, save, and start it again, so resources and mounts can change while it runs.
   */
  app.patch("/api/projects/:id", async (c) => {
    const id = c.req.param("id");
    assertIdle(id);
    const { project, info } = await known(id);
    const raw = await body<ProjectEdit>(c, "Body must be a JSON object of fields to change.");
    const { workdir: _workdir, ...edit } = (raw ?? {}) as EditSpec;
    const patch: EditSpec = Array.isArray(edit.mounts) ? { ...edit, mounts: projects.mounts(project, edit.mounts) } : edit;
    const again = c.req.query("recreate") === "1";
    const restarting = !again && c.req.query("restart") === "1";
    if (again || restarting) await assertFolders(project);
    if (again && info.status === "absent") {
      // Nothing to edit in place: build the VM from the stored spec with the changes.
      const v = await validateSpec({ ...vmSpec(project, info), ...patch, name: id, workdir: project.clonePath }, env());
      if (v.errors.length) throw new HttpError(400, "Can't apply these changes.", v.errors);
      ops.start(id, "recreating", (log) => recreate(project, v.spec, log));
      return c.json({ name: id, op: "recreating", warnings: v.warnings }, 202);
    }
    const v = await provider.validateEdit(id, patch, { recreate: again, restart: restarting });
    if (v.errors.length) throw new HttpError(400, "Can't apply these changes.", v.errors);
    const op: OpKind = again ? "recreating" : restarting ? "restarting" : "editing";
    ops.start(id, op, (log) =>
      again
        ? recreate(project, projects.spec(project, v.spec), log)
        : restarting
          ? restart(project, info, log, () => provider.edit(id, patch, log))
          : provider.edit(id, patch, log),
    );
    return c.json({ name: id, op, warnings: v.warnings }, 202);
  });

  /** Delete, then create again from the stored spec (or the defaults, if there is none). */
  app.post(
    "/api/projects/:id/recreate",
    action(
      "recreating",
      (p, i, log) => recreate(p, vmSpec(p, i), log),
      async (p, i) => {
        if (i.metaError) throw new HttpError(400, i.metaError);
        await assertFolders(p);
      },
    ),
  );

  /** The clone's worktrees, from git on the host, with what needs attention in each. Needs nothing of the VM. */
  app.get("/api/projects/:id/worktrees", async (c) => {
    const project = await projectOf(c.req.param("id"));
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
    if (!prompt && !req?.attachments?.length) throw new HttpError(400, "The opening prompt is empty.");
    const model = typeof req?.model === "string" && req.model && req.model !== "default" ? req.model : undefined;
    if (model && !/^[\w.\[\]-]+$/.test(model)) throw new HttpError(400, `Not a model: ${model}`);
    const ready = await startedProject(name);
    const sent = await attachments.take(req.attachments);
    const session = sessions.start({ sandbox: name, workdir: ready.workdir, env: ready.env, prompt, model, ...sent });
    return c.json({ id: session.id }, 201);
  });

  /** The Claude account of a session's sandbox and how much of its subscription is used. */
  app.get("/api/sessions/:id/usage", async (c) => {
    const { sandbox } = sessionOf(c);
    const { info } = await known(sandbox);
    if (info.status !== "running") throw new HttpError(409, `${vmName(sandbox)} is not running. Start it first.`);
    return c.json(await usage.get(sandbox));
  });

  /** Saved sessions that can be resumed, most recent first. */
  app.get("/api/sessions/resumable", async (c) => c.json(await sessions.resumable()));

  /** Deletes a saved session that isn't open. */
  app.delete("/api/sessions/saved/:id", async (c) => {
    if (!(await sessions.deleteSaved(c.req.param("id")))) throw new HttpError(404, `No saved session ${c.req.param("id")}.`);
    return c.json({ ok: true });
  });

  /** Opens a saved session again: its Claude where it is still running, or a new one continuing its conversation. */
  app.post("/api/sessions/:id/resume", async (c) => {
    const stored = await sessionStore.read(c.req.param("id"));
    if (!stored || (!stored.info.claudeSessionId && !stored.run?.live)) throw new HttpError(404, `No saved session ${c.req.param("id")}.`);
    const ready = await startedProject(stored.info.sandbox);
    if (stored.run?.live && !sessions.get(stored.info.id)) {
      // Not knowing whether its Claude still runs, starting another on the same conversation could have two at once.
      const found = await runs.list(stored.info.sandbox).catch(() => undefined);
      if (!found) throw new HttpError(503, `Couldn't reach ${vmName(stored.info.sandbox)} to find this session's Claude. Try again.`);
      const state = found.get(stored.run.id);
      if (state === "alive" || state === "exited") return c.json({ id: sessions.reopen(stored).id }, 201);
      await markRunDead(stored);
      if (!stored.info.claudeSessionId) throw new HttpError(404, `No saved session ${c.req.param("id")}.`);
    }
    return c.json({ id: sessions.resume(stored, ready.env).id }, 201);
  });

  app.post("/api/sessions/:id/prompt", async (c) => {
    const { id } = sessionOf(c);
    const req = await c.req.json<Partial<PromptRequest>>().catch(() => ({}) as Partial<PromptRequest>);
    const text = typeof req.text === "string" ? req.text.trim() : "";
    if (!text && !req.attachments?.length) throw new HttpError(400, "The prompt is empty.");
    const sent = await attachments.take(req.attachments);
    sessions.prompt(id, text, sent.attachments, sent.files);
    return c.json({ ok: true }, 202);
  });

  /** Starts a new session from a copy of this one's conversation, or of it up to one prompt's turn. Returns the new session's id. */
  app.post("/api/sessions/:id/fork", async (c) => {
    const from = sessionOf(c);
    const req = await c.req.json<ForkRequest>().catch(() => ({}) as ForkRequest);
    if (req.prompt !== undefined && typeof req.prompt !== "string") throw new HttpError(400, "Which message to fork from?");
    const ready = await readyProject(from.sandbox);
    return c.json({ id: sessions.fork(from.id, ready.env, req.prompt).id }, 201);
  });

  /** Rewinds this session in place to just before one of its prompts. Returns the prompt's text. */
  app.post("/api/sessions/:id/rewind", async (c) => {
    const from = sessionOf(c);
    const req = await c.req.json<{ prompt?: unknown; files?: unknown }>().catch(() => ({}) as { prompt?: unknown; files?: unknown });
    if (typeof req.prompt !== "string" || !req.prompt) throw new HttpError(400, "Which message to rewind to?");
    const ready = await readyProject(from.sandbox);
    return c.json((await sessions.rewind(from.id, req.prompt, ready.env, { files: req.files === true })) satisfies RewindResponse);
  });

  // A login is the project's: its Claude home holds it, so every session of the project shares it. It is started from
  // a session because that is where being logged out shows.

  /** Whether the session's project is logged in now, without starting a login. */
  app.get("/api/sessions/:id/login", async (c) => {
    const { sandbox } = sessionOf(c);
    const { info } = await known(sandbox);
    if (info.status !== "running") return c.json({} satisfies LoginStatusResponse);
    const account = await logins.account(sandbox);
    return c.json((account ? { loggedIn: account } : {}) satisfies LoginStatusResponse);
  });

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
    // Read before the swap, so a file that is gone fails the retry instead of sending the prompt without it.
    const files = last?.kind === "user_prompt" ? await attachments.load(last.payload.attachments) : [];
    sessions.relaunch(id, ready.env);
    if (last?.kind === "user_prompt") sessions.prompt(id, last.payload.text, last.payload.attachments, files);
    return c.json({ ok: true }, 202);
  });

  /**
   * What a window shows of an artifact's file, by its hash. Text as text, an image as `as` says, if it is one: nothing
   * served here runs, even opened as a page.
   */
  app.get("/api/artifacts/:hash", async (c) => {
    const data = await content.get(c.req.param("hash"));
    if (!data) return c.json(fail("No such content."), 404);
    const as = c.req.query("as") ?? "";
    const type = Object.values(IMAGE_TYPES).includes(as) ? as : "text/plain; charset=utf-8";
    return c.body(new Uint8Array(data), 200, {
      "content-type": type,
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
      // The same hash is always the same content.
      "cache-control": "private, max-age=31536000, immutable",
    });
  });

  /** Starts the session's Claude again, carrying on its conversation: for Kumiko's tools as they are now. */
  app.post("/api/sessions/:id/restart", async (c) => {
    const { id, sandbox } = sessionOf(c);
    const ready = await readyProject(sandbox);
    return c.json(sessions.relaunch(id, ready.env));
  });

  /** The user is looking at the session, so it no longer waits on them. */
  app.post("/api/sessions/:id/seen", (c) => {
    sessions.markSeen(sessionOf(c).id);
    return c.json({ ok: true });
  });

  // The user closing one of the window's slots, or showing a widget again. Claude's tools change the window too, but
  // not through here. Either may change which files are watched, and a widget shown again may have changed while hidden.
  app.post("/api/sessions/:id/window/close", async (c) => {
    const req = await c.req.json<{ slot?: unknown }>().catch(() => ({}) as { slot?: unknown });
    if (typeof req.slot !== "string" || !req.slot) throw new HttpError(400, "Which slot to close?");
    const { id } = sessionOf(c);
    const w = sessions.changeWindow(id, { type: "close", slot: req.slot });
    void widgets.refresh(id);
    return c.json(w);
  });

  // The user rearranging the window: a slot to a side of another, or swapped with it; and a split dragged to a new size.
  const SIDES = ["left", "right", "above", "below", "swap"];
  app.post("/api/sessions/:id/window/move", async (c) => {
    const req = await c.req.json<{ slot?: unknown; to?: unknown; side?: unknown }>().catch(() => ({}) as { slot?: unknown; to?: unknown; side?: unknown });
    if (typeof req.slot !== "string" || typeof req.to !== "string" || typeof req.side !== "string" || !SIDES.includes(req.side)) {
      throw new HttpError(400, `Body must be JSON: { slot, to, side }, side one of ${SIDES.join(", ")}.`);
    }
    return c.json(sessions.changeWindow(sessionOf(c).id, { type: "move", slot: req.slot, to: req.to, side: req.side as Side | "swap" }));
  });

  // A window answering a pane request: the picture, nothing (a reload alone), or why it couldn't. The first answer wins.
  app.post("/api/sessions/:id/window/answer", async (c) => {
    type Answer = { request?: unknown; data?: unknown; mimeType?: unknown; error?: unknown; note?: unknown };
    const req = await c.req.json<Answer>().catch(() => ({}) as Answer);
    const waiting = typeof req.request === "string" ? paneRequests.get(req.request) : undefined;
    if (!waiting) return c.json({ ok: false }, 404);
    const note = typeof req.note === "string" ? req.note.slice(0, 2000) : undefined;
    if (typeof req.error === "string") waiting.reject(new Error(req.error));
    else if (typeof req.data === "string" && typeof req.mimeType === "string" && /^image\/(png|jpeg)$/.test(req.mimeType)) waiting.resolve({ image: { data: req.data, mimeType: req.mimeType }, note });
    else waiting.resolve({ note });
    return c.json({ ok: true });
  });

  // The user allowing an external site Claude opened, which then loads, along with any other page of the same site
  // waiting; or denying it, which takes the page out of the window.
  app.post("/api/sessions/:id/window/approve", async (c) => {
    const req = await c.req.json<{ widget?: unknown; allow?: unknown }>().catch(() => ({}) as { widget?: unknown; allow?: unknown });
    if (typeof req.widget !== "string" || typeof req.allow !== "boolean") throw new HttpError(400, "Body must be JSON: { widget, allow }.");
    const { id } = sessionOf(c);
    const w = sessions.window(id)!;
    const site = w.widgets[req.widget]?.state as ArtifactState | undefined;
    if (w.widgets[req.widget]?.kind !== "artifact" || site?.type !== "web") throw new HttpError(400, `${req.widget} isn't a website waiting to be allowed.`);
    let after = w;
    // Denied, it's as if it never opened: its pane goes back to what it showed, or closes.
    if (!req.allow) after = (await widgets.remove(id, req.widget, "close")).window;
    else {
      const origin = urlOrigin(site.path);
      for (const [widget, a] of artifactsOf(w)) {
        if (a.type === "web" && !a.approved && urlOrigin(a.path) === origin) after = sessions.changeWindow(id, { type: "update", widget, op: { approved: true } });
      }
    }
    return c.json(after);
  });

  // The user taking an artifact out of the window; a pane showing it shows another instead, or closes.
  app.post("/api/sessions/:id/window/remove", async (c) => {
    const req = await c.req.json<{ widget?: unknown }>().catch(() => ({}) as { widget?: unknown });
    if (typeof req.widget !== "string" || !req.widget) throw new HttpError(400, "Which widget to remove?");
    const { id } = sessionOf(c);
    const w = sessions.window(id)!;
    if (!w.widgets[req.widget]) throw new HttpError(400, `There is no widget ${req.widget}.`);
    const { window: after } = await widgets.remove(id, req.widget, "another");
    return c.json(after);
  });

  app.post("/api/sessions/:id/window/resize", async (c) => {
    const req = await c.req.json<{ path?: unknown; ratio?: unknown }>().catch(() => ({}) as { path?: unknown; ratio?: unknown });
    if (typeof req.path !== "string" || typeof req.ratio !== "number") throw new HttpError(400, "Body must be JSON: { path, ratio }.");
    return c.json(sessions.changeWindow(sessionOf(c).id, { type: "resize", path: req.path, ratio: req.ratio }));
  });

  // In `slot`, swapping with the slot that shows it now, if any; with `split`, in a new slot split off `slot` that way;
  // without either, where Claude's artifact_open would put it.
  app.post("/api/sessions/:id/window/show", async (c) => {
    type ShowRequest = { widget?: unknown; slot?: unknown; split?: unknown };
    const req = await c.req.json<ShowRequest>().catch(() => ({}) as ShowRequest);
    if (typeof req.widget !== "string" || !req.widget) throw new HttpError(400, "Which widget to show?");
    if (req.slot !== undefined && (typeof req.slot !== "string" || !req.slot)) throw new HttpError(400, "Which slot to show it in?");
    if (req.split !== undefined && req.split !== "right" && req.split !== "below") throw new HttpError(400, 'split is "right" or "below".');
    const { id } = sessionOf(c);
    const w = sessions.window(id)!;
    if (!req.slot && !req.split && slotOf(w, req.widget)) return c.json(w);
    const target = req.split ? undefined : req.slot ? { slot: req.slot } : docSlotTarget(w);
    const op: WindowOp =
      target && "slot" in target
        ? { type: "show", slot: target.slot, widget: req.widget }
        : { type: "split", place: { split: req.split === "below" ? "below" : "right", ...(req.split && req.slot ? { of: req.slot } : {}) }, slot: nextId(w, "s"), widget: req.widget };
    const shown = sessions.changeWindow(id, op);
    void widgets.refresh(id);
    return c.json(shown);
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
    if ((url.pathname !== "/api/events" && !(sessionId && SESSION_ID_PATTERN.test(sessionId))) || !isLocalRequest(req.headers, ownPort())) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (sessionId) return streamSession(ws, sessionId, Number(url.searchParams.get("after") ?? 0) || 0, url.searchParams.get("buffer") ?? undefined);
      clients.add(ws);
      ws.on("close", () => clients.delete(ws));
      ws.on("error", () => clients.delete(ws));
      ws.send(JSON.stringify({ type: "snapshot", projects: views(), unreadable, logs: ops.logs(), sessions: sessions.list(), error: listError } satisfies ServerEvent));
    });
  });

  /**
   * Replays a session's events after `after`, says it has caught up, then streams new ones; closes when the session is
   * removed or rewound. `after` counts in `buffer`: one that has been replaced is replayed from the start instead.
   */
  const streamSession = (ws: WebSocket, id: string, after: number, buffer?: string) => {
    const current = sessions.bufferOf(id);
    if (buffer !== undefined && current !== undefined && buffer !== current) return ws.close(4409, "session buffer replaced");
    sessionSockets.add(ws);
    const send = (msg: SessionStreamMessage) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
    const unsubscribe = sessions.subscribe(id, after, { event: send, gone: () => ws.close(4404, "session removed"), reset: () => ws.close(4409, "session rewound") });
    const done = () => {
      unsubscribe?.();
      sessionSockets.delete(ws);
    };
    ws.on("close", done);
    ws.on("error", done);
    if (!unsubscribe) ws.close(4404, "no such session");
    else send({ kind: "caught_up", buffer: current! });
  };

  const port = ownPort();
  await lock.setPort(port);
  return {
    url: `http://${host}:${port}`,
    port,
    working: () => sessions.list().filter((s) => s.status === "running" || s.status === "starting"),
    close: async ({ endSessions = false } = {}) => {
      clearInterval(timer);
      logins.cancelAll();
      if (endSessions) await sessions.endAll("quit");
      else await sessions.detachAll();
      await sessions.flush();
      widgets.close();
      for (const ws of clients) ws.terminate();
      // Closed rather than terminated, so each tab still gets its session's last event.
      for (const ws of sessionSockets) ws.close(1001, "server closing");
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
      await lock.release();
    },
  };
}
