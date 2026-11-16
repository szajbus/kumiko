import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { WebSocketServer, type WebSocket } from "ws";
import {
  AGENT_SETUP_DIR,
  ATTACHMENTS_TOTAL_LIMIT,
  DEFAULTS,
  ENV_NAME_PATTERN,
  formatBytes,
  isWaiting,
  NAME_PATTERN,
  parseAskAnswer,
  parseCardDecision,
  parseRepo,
  parseSavedTabs,
  SESSION_ID_PATTERN,
  artifactsOf,
  IMAGE_TYPES,
  nextId,
  paneOf,
  TASKS,
  urlOrigin,
  TASK_FILE_BYTES,
  vmName,
  WindowError,
  type AgentSetupResponse,
  type AgentSetupRun,
  isBusy,
  type AddMirrorRequest,
  type ApiError,
  type CreateSandboxRequest,
  type GitHubAccount,
  type GitHubReposResponse,
  type MirrorsResponse,
  type CreateResponse,
  type DefaultsResponse,
  type EditSpec,
  type ForkRequest,
  type ResumeRequest,
  type LoginAccount,
  type LoginStartResponse,
  type LoginStatusResponse,
  type PromptRequest,
  type ShellRequest,
  type OpKind,
  type Sandbox,
  type SandboxEdit,
  type SandboxView,
  type RewindResponse,
  type SandboxInfo,
  type SandboxSpec,
  type ValidSpec,
  type ServerEvent,
  type SessionStreamMessage,
  type SessionInfo,
  type StartSessionRequest,
  type SessionDisk,
  type StatsResponse,
  type TemplatesResponse,
  type ArtifactState,
  type Side,
  type WindowOp,
  WORKSPACE_DIR,
} from "@kumiko/shared";
import { LimaProvider, shellQuote, validateSpec, type Log, type SandboxProvider } from "@kumiko/sandbox";
import { ClaudeDriver, execOutput, Runs, type AgentDriver } from "@kumiko/agent";
import { deleteAgentScripts, readAgentScripts, withExitCodes } from "./agentSetup.js";
import { AttachmentRefused, AttachmentStore, attachmentHashes } from "./attachments.js";
import { ArtifactContent, contentHashes } from "./content.js";
import { filesBytes } from "./disk.js";
import { GhError, GitHub, gitHubUrl } from "./github.js";
import { MirrorFetchFailed, MirrorNotFound, MirrorRecordError, Mirrors } from "./mirrors.js";
import { hostIdentity } from "./git.js";
import { Pushes } from "./pushes.js";
import { ApprovalError, Approvals } from "./approvals.js";
import { Relays } from "./relay.js";
import { hasToken, isLocalRequest, isToken, tokenCookie } from "./guard.js";
import { LoginFailed, Logins } from "./logins.js";
import { BusyError, Operations } from "./operations.js";
import { homeId, lockHome } from "./home.js";
import { checkRepos, defaultKumikoHome, SandboxExists, SandboxRecordError, SandboxStore } from "./sandboxes.js";
import { Clones } from "./clones.js";
import { AskRefused, RewindRefused, SessionEnded, SessionNotFound, SessionNotResumable, Sessions, ShellRefused } from "./sessions.js";
import { RUN_ID } from "./userShells.js";
import { docPaneTarget, Widgets, type PaneAnswer } from "./widgets.js";
import { SessionStore, type StoredSession } from "./store.js";
import { TabsStore } from "./tabs.js";
import { serveWeb } from "./static.js";
import { StatsCache } from "./stats.js";
import { sandboxAccountSource, UsageCache, type AccountSource } from "./usage.js";

/** The largest request body: a prompt's attachments, a third bigger in base64, and room for its text. */
const MAX_BODY_BYTES = Math.ceil((ATTACHMENTS_TOTAL_LIMIT * 4) / 3) + 1024 * 1024;

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
  /** Where sandboxes and their Claude homes are kept; defaults to Kumiko's home (`KUMIKO_HOME` or `~/.kumiko`). */
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
  /** Finds out who the Claude in a sandbox is signed in as; defaults to asking Claude inside it. */
  accounts?: AccountSource;
  /** The secret every API request must carry (see `hasToken`); a random one by default. */
  token?: string;
  /** How long Claude may finish its turn after its session's tab closes, in ms; 30 minutes by default. */
  finishMs?: number;
  /** The GitHub CLI the Repos page lists the user's repositories with; defaults to `gh` (or `KUMIKO_GH`). */
  github?: GitHub;
  /**
   * Where a newly picked repository's mirror fetches from. Defaults to GitHub over HTTPS, signing in with gh's token, or `<KUMIKO_GITHUB_URL>/<owner>/<name>.git` when that is set (for running against a stand-in).
   */
  repoUrl?(repo: string): string | Promise<string>;
}

export interface RunningServer {
  url: string;
  port: number;
  /** The secret every API request must carry. */
  token: string;
  /** Signs a browser in with the token, then goes to the UI. */
  loginUrl: string;
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
  const token = opts.token ?? randomBytes(32).toString("hex");
  const ops = new Operations();
  const sandboxes = new SandboxStore(opts.dataDir);
  /** Kumiko's own folder for files it reads out of folders the agent can change. */
  const scratch = join(home, "tmp");
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
  // Windows' widgets map the paths Claude names in its VM to the host: the sandbox's Claude home and Kumiko folder.
  const widgets = new Widgets({
    content,
    scratch,
    home: (sandbox) => {
      const s = sandboxList.find((x) => x.name === sandbox);
      return s && { claudeHome: sandboxes.claudeHome(s.name), kumikoHome: sandboxes.kumikoHome(s.name) };
    },
    vmHome: (sandbox) => execOutput(provider.exec.bind(provider), sandbox, `printf %s "$HOME"`, 10_000),
    pane: (session, pane, what) => askPane(session, pane, what),
    reachable: async (url) => {
      try {
        await fetch(url, { method: "GET", signal: AbortSignal.timeout(3000), redirect: "manual" });
        return true;
      } catch {
        return false;
      }
    },
  });
  // What Claude asked of the windows' panes (a reload, a picture), by request id: done by the first window that does it,
  // or failed once every window has said why it couldn't, since another may yet do it.
  const paneRequests = new Map<string, { resolve(answer: PaneAnswer): void; fail(err: Error, fallback: boolean): void }>();
  /** How long the server waits for a window's answer: a reload and a wait of up to 10 s each, and the picture. */
  const PANE_MS = 30_000;
  const askPane = (session: string, pane: string, what: { reload: boolean; capture: boolean; wait: number }) =>
    new Promise<PaneAnswer>((resolve, reject) => {
      const request = randomUUID();
      let waiting = [...clients].filter((ws) => ws.readyState === ws.OPEN).length;
      // Why it couldn't be done: a window showing the session says more than one that only can't capture, or lacks it.
      let why: { err: Error; fallback: boolean } | undefined;
      const done = () => (clearTimeout(timer), paneRequests.delete(request));
      const timer = setTimeout(() => {
        done();
        reject(why?.err ?? new Error("No window answered: the user needs this session's tab open and on screen in the Kumiko app. Ask them to look at it, then try again."));
      }, PANE_MS);
      paneRequests.set(request, {
        resolve: (answer) => (done(), resolve(answer)),
        fail: (err, fallback) => {
          if (!why || (why.fallback && !fallback)) why = { err, fallback };
          if (--waiting <= 0) (done(), reject(why.err));
        },
      });
      broadcast({ type: "pane", session, pane, request, ...what });
    });
  const sessions = new Sessions(opts.driver ?? (() => new ClaudeDriver(provider.exec.bind(provider), { owner })), sessionStore, widgets, opts.finishMs, provider.exec.bind(provider));
  widgets.sessions = sessions;
  const runs = opts.runs ?? new Runs(provider.exec.bind(provider), owner);
  const clients = new Set<WebSocket>();
  const stats = new StatsCache(provider.exec.bind(provider));
  const usage = new UsageCache(
    opts.accounts ?? sandboxAccountSource(provider.exec.bind(provider), (sandbox) => infos.find((i) => i.name === sandbox)?.meta?.spec.env ?? []),
  );

  // ---- list state -------------------------------------------------------------------------

  let infos: SandboxInfo[] = [];
  let sandboxList: Sandbox[] = [];
  /** Why each sandbox record that can't be used can't be; those sandboxes are left out of the list. */
  let unreadable: string[] = [];
  let listError: string | undefined;
  let lastListJson = "";
  let refreshing: Promise<void> | undefined;
  let refreshAgain = false;

  const broadcast = (ev: ServerEvent) => {
    const msg = JSON.stringify(ev);
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(msg);
  };

  /** A sandbox's VM as last listed; `absent` when the provider has neither the VM nor a record of it. */
  const infoOf = (name: string): SandboxInfo => infos.find((i) => i.name === name) ?? { name, status: "absent" };

  /** Each sandbox with its VM's view. VMs that aren't a sandbox's are left out. */
  const views = (): SandboxView[] => {
    const vms = ops.views(sandboxList.map((s) => infoOf(s.name)), sessions.liveCounts());
    const waiting = new Map<string, number>();
    for (const s of sessions.list()) if (isWaiting(s)) waiting.set(s.sandbox, (waiting.get(s.sandbox) ?? 0) + 1);
    return sandboxList.map((sandbox) => {
      const vm = vms.find((v) => v.name === sandbox.name)!;
      return { ...vm, sandbox, repos: clones.view(sandbox.name, sandbox.repos), waiting: waiting.get(sandbox.name) ?? 0 };
    });
  };

  const pushListIfChanged = () => {
    const list = views();
    const json = JSON.stringify({ list, unreadable, listError });
    if (json === lastListJson) return;
    lastListJson = json;
    broadcast({ type: "list", sandboxes: list, unreadable, error: listError });
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
        ({ sandboxes: sandboxList, errors: unreadable } = await sandboxes.list());
        try {
          infos = await provider.list();
          listError = undefined;
          endOrphanedSessions();
          wakeAsleep();
        } catch (err) {
          listError = err instanceof Error ? err.message : String(err);
        }
        pushListIfChanged();
        syncRelays();
      } while (refreshAgain);
    })().finally(() => (refreshing = undefined));
    return refreshing;
  };

  ops.on("event", (ev) => {
    broadcast(ev);
    if (ev.type !== "log") pushListIfChanged();
  });
  ops.on("settled", () => void refresh());

  sessions.on("rateLimit", (sandbox, info) => void usage.record(sandbox, info));
  sessions.on("changed", () => {
    broadcast({ type: "sessions", sessions: sessions.list() });
    pushListIfChanged();
    if (serving) restartOutdated();
  });

  /**
   * Sessions whose Claude was started with other tools than this Kumiko's (it was updated while they ran) get a new
   * Claude on the same conversation as soon as they are idle: at once, or when their turn ends. Tried once each; if
   * that fails, the chat offers to restart it by hand.
   */
  const restartTried = new Set<string>();
  /** Set once the server is up: sessions reopened before then are restarted then, as what it takes isn't ready yet. */
  let serving = false;
  const restartOutdated = () => {
    for (const info of sessions.list()) {
      if (!info.toolsOutdated || info.status !== "idle" || info.closing || restartTried.has(info.id)) continue;
      restartTried.add(info.id);
      void (async () => {
        try {
          const ready = await readySandbox(info.sandbox);
          // It may have started a turn, or ended, while the sandbox was checked.
          if (sessions.get(info.id)?.status === "idle") sessions.relaunch(info.id, ready.env, { keepUnread: true });
          else restartTried.delete(info.id);
        } catch (err) {
          console.error(`Couldn't restart session ${info.id}'s Claude for Kumiko's new tools: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    }
  };

  /** Sessions whose sandbox stopped outside Kumiko fall asleep too; those whose sandbox vanished end. */
  const endOrphanedSessions = () => {
    for (const [name] of sessions.liveCounts()) {
      const info = infos.find((i) => i.name === name);
      if (info?.status !== "running") void sessions.endSandbox(name, "sandbox", { sleep: info !== undefined });
    }
  };

  /** Sessions opened asleep get their Claude once their sandbox runs, however it was started. */
  const waking = new Set<string>();
  const wakeAsleep = () => {
    if (!serving) return;
    for (const info of sessions.list()) {
      if (!info.asleep || waking.has(info.id) || ops.active().includes(info.sandbox)) continue;
      if (infos.find((i) => i.name === info.sandbox)?.status !== "running") continue;
      waking.add(info.id);
      void (async () => {
        try {
          const ready = await readySandbox(info.sandbox);
          // Its tab may have closed meanwhile.
          if (sessions.get(info.id)) sessions.wake(info.id, ready.env);
        } catch (err) {
          console.error(`Couldn't start Claude in session ${info.id}: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          waking.delete(info.id);
        }
      })();
    }
  };

  /**
   * Ends a sandbox's sessions before an operation takes it down, noting it in the operation's log. With `sleep`, for a
   * sandbox that is to run again, they fall asleep instead, and continue once it runs, however it is started.
   */
  const endSessions = async (name: string, log: Log, { sleep = false }: { sleep?: boolean } = {}) => {
    const n = sessions.liveCounts().get(name) ?? 0;
    if (!n) return;
    log(`${sleep ? "Pausing" : "Ending"} ${n} agent session${n === 1 ? "" : "s"}…`, "note");
    await sessions.endSandbox(name, "sandbox", { sleep });
  };

  /**
   * Saves that a session's run is over, without having seen it end: the VM restarted, say. It stays resumable, unless
   * its tab was closed to delete it once Claude finished, which it now has.
   */
  const markRunDead = (stored: StoredSession) => {
    if (!stored.run?.live) return Promise.resolve();
    if (stored.info.closing?.delete) return sessionStore.remove(stored.info.id);
    const { closing: _closing, ...info } = stored.info;
    return sessionStore.write({ ...stored, info, run: { ...stored.run, live: false } });
  };

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
    const running = sandboxList.map((s) => s.name).filter((name) => infoOf(name).status === "running");
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

  // ---- repository mirrors ------------------------------------------------------------------

  const github = opts.github ?? new GitHub();
  const githubBase = process.env.KUMIKO_GITHUB_URL;
  const mirrors = new Mirrors({
    home,
    remoteUrl: opts.repoUrl ?? ((repo) => (githubBase ? `${githubBase.replace(/\/$/, "")}/${repo}.git` : gitHubUrl(repo))),
    credentialHelper: github.credentialHelper(),
    onChange: () => {
      broadcast({ type: "mirrors", ...mirrorsView() });
      pushListIfChanged();
    },
  });
  // ---- the relays from sandboxes' VMs to their mirrors, and the clones made through them ----
  // Not under anything a VM mounts: each socket is only for the ssh forward into its own VM, and the hooks' for git on
  // the host.
  const runDir = join(home, "run");
  /** Pushes waiting for the user, by relay connection: they stop waiting when git in the VM goes. */
  const waitingPushes = new Map<string, () => void>();
  const pushes = new Pushes({
    socket: join(runDir, "hook.sock"),
    mirrors,
    connection: (id) => relays.connection(id),
    askCi: (pusher, connection, card) => {
      const asked = approvals.askPush(pusher, card);
      waitingPushes.set(connection, asked.closed);
      void asked.answer.finally(() => waitingPushes.delete(connection));
      return asked;
    },
  });
  // Without it pushes are refused, with curl saying why; Kumiko still starts.
  await pushes.start().catch((err) => console.error(`Pushes from sandboxes are off: Kumiko couldn't listen for the mirrors' hooks: ${err instanceof Error ? err.message : String(err)}`));
  const clones = new Clones(provider.exec.bind(provider), () => pushListIfChanged());
  const relays = new Relays({
    dir: runDir,
    hookSocket: join(runDir, "hook.sock"),
    onConnectionClosed: (id) => waitingPushes.get(id)?.(),
    mirrors,
    provider,
    identity: hostIdentity,
    onChange: () => pushListIfChanged(),
    // Git in the VM reaches the mirrors now: the repos missing from /workspace are cloned.
    onConnected: (name) => {
      const s = sandboxList.find((x) => x.name === name);
      if (s) clones.sync(name, s.repos);
    },
  });
  /** Each running sandbox with repos gets a relay to their mirrors; what is known of a stopped one's clones is forgotten. */
  const syncRelays = () => {
    const want = new Map<string, string[]>();
    for (const s of sandboxList) {
      if (infoOf(s.name).status !== "running" || ops.active().includes(s.name)) {
        if (infoOf(s.name).status !== "running") clones.forget(s.name);
        continue;
      }
      if (s.repos.length) want.set(s.name, s.repos.map((r) => r.repo));
    }
    relays.sync(want);
  };
  // ---- the tools that wait for the user's approval, and their cards ----
  const approvals = new Approvals(
    {
      get: (id) => sessions.get(id),
      events: (id) => sessions.events(id),
      putCard: (id, card) => sessions.putCard(id, card),
      answerAsk: (id, ask, answer) => sessions.answerAsk(id, ask, answer),
      list: () => sessions.list(),
      hostAsk: (id, ask, onAnswer) => sessions.hostAsk(id, ask, onAnswer),
      closeHostAsk: (id, ask) => sessions.closeHostAsk(id, ask),
    },
    {
      mirrors,
      github,
      reposOf: async (name) => {
        const s = sandboxList.find((x) => x.name === name) ?? (await sandboxes.get(name).catch(() => undefined));
        return s?.repos.map((r) => r.repo) ?? [];
      },
      identity: hostIdentity,
      choicesFile: join(home, "choices.json"),
    },
  );
  sessions.approvals = approvals;
  widgets.extraTools = { list: () => approvals.list(), call: (info, name, args, toolUseId) => approvals.call(info, name, args, toolUseId) };
  const mirrorsView = (): MirrorsResponse => (mirrors.readError ? { mirrors: mirrors.list(), error: mirrors.readError } : { mirrors: mirrors.list() });
  await mirrors.start();

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
    if (err instanceof BusyError || err instanceof SandboxExists || err instanceof SandboxRecordError || err instanceof MirrorRecordError) return c.json(fail(err.message), 409);
    if (err instanceof SessionNotFound || err instanceof MirrorNotFound) return c.json(fail(err.message), 404);
    if (err instanceof MirrorFetchFailed || err instanceof GhError) return c.json(fail(err.message), 502);
    if (err instanceof SessionEnded || err instanceof SessionNotResumable || err instanceof RewindRefused || err instanceof AskRefused || err instanceof ShellRefused) return c.json(fail(err.message), 409);
    // Anything else is a bug or a tool failing; the UI still gets JSON it can show.
    return c.json(fail(err instanceof Error ? err.message : String(err)), 500);
  });

  /** The port the server listens on, which a browser's requests must come from (see `isLocalRequest`). */
  const ownPort = () => (server.address() as AddressInfo).port;

  // The token goes into a cookie only the server reads (HttpOnly) and only its own pages send (SameSite=Strict), and the
  // address it came in on is left behind. Through the dev UI's proxy the cookie is that page's, which works the same.
  app.get("/api/login", (c) => {
    if (!isLocalRequest(c.req.raw.headers, ownPort()) || !isToken(c.req.query("token"), token)) return c.json(fail("Forbidden: not this server's token."), 403);
    c.header("set-cookie", `${tokenCookie(ownPort())}=${token}; Path=/; HttpOnly; SameSite=Strict`);
    c.header("cache-control", "no-store");
    return c.redirect("/", 302);
  });

  app.use("/api/*", async (c, next) => {
    if (!isLocalRequest(c.req.raw.headers, ownPort())) return c.json(fail("Forbidden: not a local request."), 403);
    if (!hasToken(c.req.raw.headers, token, ownPort())) return c.json(fail("Forbidden: open Kumiko from the address its server printed, which signs this browser in."), 403);
    await next();
  });
  // Bodies are read whole, so their size is capped: room for a prompt's attachments, in base64, and its text.
  app.use("/api/*", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json(fail(`Too big: a request can be ${formatBytes(MAX_BODY_BYTES)} at most.`), 413) }));

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

  /** Looks up a sandbox's record, without asking the provider: 400 for a bad name, 404 for an unknown one. */
  const sandboxOf = async (name: string): Promise<Sandbox> => {
    if (!NAME_PATTERN.test(name)) throw new HttpError(400, `Invalid sandbox name "${name}".`);
    const sandbox = await sandboxes.get(name);
    if (!sandbox) throw new HttpError(404, `There is no sandbox ${name}.`);
    return sandbox;
  };

  /** Looks up a sandbox as `sandboxOf` does, with its VM's current state. */
  const known = async (name: string): Promise<{ sandbox: Sandbox; info: SandboxInfo }> => {
    const sandbox = await sandboxOf(name);
    await refresh();
    return { sandbox, info: infoOf(name) };
  };

  /**
   * A sandbox a session can start in: VM running and not busy. Refreshes Kumiko's instructions in its Claude home,
   * so they follow the app. Returns where sessions start (/workspace) and what they forward.
   */
  const readySandbox = async (name: string): Promise<{ workdir: string; env: string[] }> => {
    const { sandbox, info } = await known(name);
    if (info.status !== "running") throw new HttpError(409, `${vmName(name)} is not running. Start it first.`);
    assertIdle(name);
    await sandboxes.writeManaged(sandbox, info.meta?.spec);
    await widgets.prepare(name);
    return { workdir: WORKSPACE_DIR, env: info.meta?.spec.env ?? [] };
  };

  /** The VM's spec for a (re)create: the stored one with the sandbox's fixed mounts made current, or the defaults. */
  const vmSpec = (sandbox: Sandbox, info: SandboxInfo): SandboxSpec => {
    const spec = info.meta?.spec ?? { ...DEFAULTS, mounts: [], env: [] };
    return sandboxes.spec(sandbox.name, { ...spec, workspaceGiB: spec.workspaceGiB ?? DEFAULTS.workspaceGiB });
  };

  app.get("/api/sandboxes", async (c) => {
    await refresh();
    return c.json(views());
  });

  /** The latest CPU, memory and disk reading of each running VM; pages poll it while they show them. */
  app.get("/api/stats", (c) => {
    const running = views().filter((v) => v.status === "running" && !v.busy).map((v) => v.name);
    return c.json(stats.get(running) satisfies StatsResponse);
  });

  let templatesCache: TemplatesResponse | undefined;
  app.get("/api/templates", async (c) => {
    templatesCache ??= await provider.templates();
    return c.json(templatesCache);
  });

  app.get("/api/defaults", (c) => c.json({ home: opts.home ?? homedir(), claudeHomes: sandboxes.claudeRoot, kumikoHomes: sandboxes.kumikoRoot } satisfies DefaultsResponse));

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

  /** The repositories that have a mirror, which a sandbox's repos are picked from. */
  const mirrored = () => mirrors.list().map((m) => m.repo);

  /**
   * Creates a sandbox with repos picked from the mirrors: checks it, makes its record and Claude home, then creates its
   * VM and workspace disk in the background. The repos are cloned once git in the VM reaches the mirrors. Fails
   * without leaving anything behind if a check fails.
   */
  app.post("/api/sandboxes", async (c) => {
    const req = await body<CreateSandboxRequest>(c, "Body must be JSON: { name, repos, cpus, memoryGiB, diskGiB, workspaceGiB, mounts, env }.");
    if (typeof req !== "object" || req === null) throw new HttpError(400, "Body must be a JSON object.");
    const { name: rawName, repos: rawRepos, ...rest } = req;
    const name = String(rawName ?? "").trim();
    const base = { ...rest, workspaceGiB: rest.workspaceGiB ?? DEFAULTS.workspaceGiB, mounts: Array.isArray(rest.mounts) ? rest.mounts : [], env: Array.isArray(rest.env) ? rest.env : [] };
    assertIdle(name);
    const checked = await sandboxes.check(name, rawRepos ?? [], mirrored());
    // The VM's own settings, before anything is made on the host; the fixed mounts are checked once they exist.
    const { errors: specErrors } = await validateSpec({ ...base, name }, env());
    // Both checks know a bad name; it is said once.
    const errors = [...new Set([...checked.errors, ...specErrors])];
    if (errors.length) throw new HttpError(400, "Can't create this sandbox.", errors);

    const { sandbox, rollback } = await sandboxes.create(name, checked.repos);
    const v = await provider.validate(sandboxes.spec(name, base));
    if (v.errors.length) {
      await rollback();
      throw new HttpError(400, "Can't create this sandbox.", v.errors);
    }
    try {
      ops.start(name, "creating", async (log) => {
        // Sessions saved from an earlier sandbox of this name started in folders this one doesn't have.
        await sessions.deleteSavedFor(name);
        await sandboxes.writeManaged(sandbox, v.spec);
        await provider.create(v.spec, log, await agentSetup(sandbox));
      });
    } catch (err) {
      // The record is this request's own claim, so undoing it can't touch another sandbox's.
      await rollback();
      throw err;
    }
    void refresh();
    return c.json({ name, warnings: v.warnings } satisfies CreateResponse, 202);
  });

  type Work = (sandbox: Sandbox, info: SandboxInfo, log: Log) => Promise<void>;

  /** An operation on a sandbox's VM, run in the background. `check` can refuse it first, by throwing. */
  const action = (op: OpKind, work: Work, check?: (sandbox: Sandbox, info: SandboxInfo) => Promise<void>) => async (c: Context) => {
    const name = c.req.param("name")!;
    assertIdle(name);
    const { sandbox, info } = await known(name);
    await check?.(sandbox, info);
    ops.start(name, op, (log) => work(sandbox, info, log));
    return c.json({ name, op }, 202);
  };

  const startVm: Work = async (s, i, log) => {
    await sandboxes.writeManaged(s, i.meta?.spec);
    await provider.start(s.name, log);
    // Runs left from before the VM stopped have nothing running in them any more.
    await sweepRuns(s.name, await runs.list(s.name).catch(() => new Map()));
  };
  const checkStart = async (s: Sandbox, i: SandboxInfo) => {
    if (i.status === "absent") throw new HttpError(409, `${vmName(s.name)} doesn't exist. Rebuild it.`);
  };

  app.post("/api/sandboxes/:name/start", action("starting", startVm, checkStart));

  /**
   * As `readySandbox`, but a stopped VM is started first, and an operation already running on it is waited out
   * (a start from the Sandboxes page, say), so a session can be asked for in any sandbox.
   */
  const startedSandbox = async (name: string): Promise<{ workdir: string; env: string[] }> => {
    const { sandbox, info } = await known(name);
    if (info.status === "stopped" && !ops.active().includes(name)) {
      await checkStart(sandbox, info);
      try {
        ops.start(name, "starting", (log) => startVm(sandbox, info, log));
      } catch (err) {
        // Another request started it first; wait for that one.
        if (!(err instanceof BusyError)) throw err;
      }
    }
    const op = await ops.settled(name);
    if (op?.op === "starting" && op.result === "error") throw new HttpError(409, `${vmName(name)} didn't start: ${op.error?.split("\n")[0]}`);
    return readySandbox(name);
  };
  app.post("/api/sandboxes/:name/stop", action("stopping", async (s, _i, log) => {
    await endSessions(s.name, log, { sleep: true });
    await provider.stop(s.name, log);
  }));

  /**
   * Stops the VM (its sessions fall asleep) and starts it again, running `between` while it is stopped. Lima reads its
   * config on start, so resource and mount changes apply; the disks and what provisioning installed stay. `edited` is
   * the spec `between` saves, which the VM starts with rather than the one in `i`.
   */
  const restart = async (s: Sandbox, i: SandboxInfo, log: Log, between?: () => Promise<void>, edited?: ValidSpec) => {
    await endSessions(s.name, log, { sleep: true });
    if (i.status !== "stopped") await provider.stop(s.name, log);
    await between?.();
    await startVm(s, edited && i.meta ? { ...i, meta: { ...i.meta, spec: edited } } : i, log);
  };

  app.post("/api/sandboxes/:name/restart", action("restarting", (s, i, log) => restart(s, i, log), checkStart));

  /** Deletes the sandbox: its VM and workspace disk, its Claude home (login and Claude's history) and its saved sessions. */
  app.delete("/api/sandboxes/:name", action("deleting", async (s, _i, log) => {
    await endSessions(s.name, log);
    await provider.delete(s.name, log);
    await sessions.deleteSavedFor(s.name);
    await sandboxes.remove(s.name);
    clones.forget(s.name);
    log("Deleted the sandbox's Claude home and saved sessions.", "note");
  }));

  /**
   * Deletes the VM and creates it again from `spec`, its sessions asleep meanwhile. They can continue: Claude's
   * history is in the sandbox's Claude home, on the host, and the workspace disk is kept and attached to the new VM.
   */
  const recreate = async (sandbox: Sandbox, spec: SandboxSpec, log: Log) => {
    await endSessions(sandbox.name, log, { sleep: true });
    await provider.delete(sandbox.name, log, { keepWorkspace: true });
    await sandboxes.writeManaged(sandbox, spec);
    await provider.create(spec, log, await agentSetup(sandbox));
  };

  /** The agent's setup scripts a VM is created with, read once its sessions have ended, so none can change them while it is provisioned. */
  const agentSetup = async (sandbox: Sandbox): Promise<AgentSetupRun | undefined> => {
    const { scripts } = await readAgentScripts(sandboxes.kumikoHome(sandbox.name), scratch);
    return scripts.length ? { scripts } : undefined;
  };

  /** The agent's setup scripts as they are now, with how each went when the VM was created. */
  app.get("/api/sandboxes/:name/agent-setup", async (c) => {
    const { sandbox, info } = await known(c.req.param("name"));
    const now = await readAgentScripts(sandboxes.kumikoHome(sandbox.name), scratch);
    return c.json(withExitCodes(info.meta?.agentSetup, now) satisfies AgentSetupResponse);
  });

  /**
   * Deletes the agent's setup scripts, so the next rebuild starts from the user's setup only. Not while the VM is being
   * worked on, since a create reads them. The VM as it is keeps what they installed.
   */
  app.delete("/api/sandboxes/:name/agent-setup", async (c) => {
    const name = c.req.param("name");
    assertIdle(name);
    const sandbox = await sandboxOf(name);
    const dir = `${sandboxes.kumikoHome(sandbox.name)}/${AGENT_SETUP_DIR}`;
    if (!(await deleteAgentScripts(sandboxes.kumikoHome(sandbox.name)))) throw new HttpError(409, `Couldn't delete ${dir}: a folder on the way leads somewhere else.`);
    return c.json({});
  });

  /**
   * Adds the repos in `repos` that the sandbox doesn't have, each with a folder of its own, and rewrites kumiko.md. A
   * running VM's relay is set up again for them, and they are cloned once it reaches the mirrors.
   */
  const addRepos = async (sandbox: Sandbox, repos: string[], spec: SandboxSpec | undefined): Promise<Sandbox> => {
    const updated = await sandboxes.addRepos(sandbox.name, repos);
    await sandboxes.writeManaged(updated, spec);
    await refresh();
    return updated;
  };

  /**
   * Change resources, extra mounts (VM stopped), forwarded variables, the provisioning script, or the repos. `mounts`
   * are the extra ones; the sandbox's own are added back. `repos` is the whole list: new ones are added and cloned.
   * With `?recreate=1`, delete the VM and create it again from the changed spec, keeping the workspace disk; with
   * `?restart=1`, stop it, save, and start it again, so resources and mounts can change while it runs.
   */
  app.patch("/api/sandboxes/:name", async (c) => {
    const name = c.req.param("name");
    assertIdle(name);
    const { sandbox, info } = await known(name);
    const raw = await body<SandboxEdit>(c, "Body must be a JSON object of fields to change.");
    const { workdir: _workdir, repos: rawRepos, ...edit } = (raw ?? {}) as SandboxEdit & { workdir?: unknown };
    const picked = checkRepos(rawRepos, mirrored());
    if (picked.errors.length) throw new HttpError(400, "Can't apply these changes.", picked.errors);
    const added = rawRepos === undefined ? [] : picked.repos.filter((r) => !sandbox.repos.some((x) => x.repo.toLowerCase() === r.toLowerCase()));
    const removed = rawRepos === undefined ? [] : sandbox.repos.filter((x) => !picked.repos.some((r) => r.toLowerCase() === x.repo.toLowerCase()));
    if (removed.length) throw new HttpError(400, "Can't apply these changes.", [`Repos can't be taken out of a sandbox yet: ${removed.map((r) => r.repo).join(", ")}.`]);
    const patch: EditSpec = Array.isArray(edit.mounts) ? { ...edit, mounts: sandboxes.mounts(name, edit.mounts) } : edit;
    const again = c.req.query("recreate") === "1";
    const restarting = !again && c.req.query("restart") === "1";
    // Only repos: nothing for the VM to do.
    if (!again && !restarting && Object.keys(patch).length === 0) {
      if (added.length) await addRepos(sandbox, added, info.meta?.spec);
      return c.json({ name, warnings: [] });
    }
    if (again && info.status === "absent") {
      // Nothing to edit in place: build the VM from the stored spec with the changes.
      const v = await validateSpec({ ...vmSpec(sandbox, info), ...patch, name, workdir: WORKSPACE_DIR }, env());
      if (v.errors.length) throw new HttpError(400, "Can't apply these changes.", v.errors);
      const updated = added.length ? await addRepos(sandbox, added, v.spec) : sandbox;
      ops.start(name, "recreating", (log) => recreate(updated, v.spec, log));
      return c.json({ name, op: "recreating", warnings: v.warnings }, 202);
    }
    const v = await provider.validateEdit(name, patch, { recreate: again, restart: restarting });
    if (v.errors.length) throw new HttpError(400, "Can't apply these changes.", v.errors);
    const updated = added.length ? await addRepos(sandbox, added, v.spec) : sandbox;
    const op: OpKind = again ? "recreating" : restarting ? "restarting" : "editing";
    ops.start(name, op, (log) =>
      again
        ? recreate(updated, sandboxes.spec(name, v.spec), log)
        : restarting
          ? restart(updated, info, log, () => provider.edit(name, patch, log), v.spec)
          : // The script and variables can change while it runs: the agent's guide follows them now, not at the next session.
            provider.edit(name, patch, log).then(() => sandboxes.writeManaged(updated, v.spec)),
    );
    return c.json({ name, op, warnings: v.warnings }, 202);
  });

  /** Delete the VM, keeping its workspace disk, then create it again from the stored spec (or the defaults, if there is none). */
  app.post(
    "/api/sandboxes/:name/recreate",
    action(
      "recreating",
      (s, i, log) => recreate(s, vmSpec(s, i), log),
      async (_s, i) => {
        if (i.metaError) throw new HttpError(400, i.metaError);
      },
    ),
  );

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
    const ready = await startedSandbox(name);
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
  /** What a session keeps on the host, as of when its chat was last saved. */
  app.get("/api/sessions/:id/disk", async (c) => {
    const info = sessionOf(c);
    const events = (await sessionStore.read(info.id))?.events ?? [];
    const [chat, artifacts, attached, shown] = await Promise.all([
      sessionStore.size(info.id),
      widgets.folderBytes(info),
      filesBytes(attachments.dir, attachmentHashes(events)),
      filesBytes(content.dir, contentHashes(events)),
    ]);
    return c.json({ chat, artifacts, files: attached + shown } satisfies SessionDisk);
  });

  app.get("/api/sessions/resumable", async (c) => c.json(await sessions.resumable()));

  /** Deletes a saved session that isn't open. */
  app.delete("/api/sessions/saved/:id", async (c) => {
    if (!(await sessions.deleteSaved(c.req.param("id")))) throw new HttpError(404, `No saved session ${c.req.param("id")}.`);
    return c.json({ ok: true });
  });

  /**
   * Opens a saved session again: its Claude where it is still running, or a new one continuing its conversation. With
   * `start: false`, one whose sandbox is stopped opens asleep instead, and wakes once the sandbox runs.
   */
  app.post("/api/sessions/:id/resume", async (c) => {
    const req = await c.req.json<ResumeRequest>().catch(() => ({}) as ResumeRequest);
    // One whose tab closed while Claude finishes opens again as it is, if it hasn't finished yet.
    if (await sessions.keep(c.req.param("id"))) return c.json({ id: c.req.param("id") }, 201);
    const stored = await sessionStore.read(c.req.param("id"));
    if (!stored || (!stored.info.claudeSessionId && !stored.run?.live)) throw new HttpError(404, `No saved session ${c.req.param("id")}.`);
    if (req.start === false && !sessions.get(stored.info.id) && (await known(stored.info.sandbox)).info.status === "stopped" && !ops.active().includes(stored.info.sandbox)) {
      // Nothing runs in a stopped sandbox, its Claude included.
      await markRunDead(stored);
      // One closed to be deleted once Claude finished is deleted now.
      if (!stored.info.claudeSessionId || (stored.run?.live && stored.info.closing?.delete)) throw new HttpError(404, `No saved session ${c.req.param("id")}.`);
      return c.json({ id: sessions.openAsleep(stored).id }, 201);
    }
    const ready = await startedSandbox(stored.info.sandbox);
    if (stored.run?.live && !sessions.get(stored.info.id)) {
      // Not knowing whether its Claude still runs, starting another on the same conversation could have two at once.
      const found = await runs.list(stored.info.sandbox).catch(() => undefined);
      if (!found) throw new HttpError(503, `Couldn't reach ${vmName(stored.info.sandbox)} to find this session's Claude. Try again.`);
      const state = found.get(stored.run.id);
      // Opened by the user, it isn't closing any more.
      const { closing: _closing, ...info } = stored.info;
      if (state === "alive" || state === "exited") return c.json({ id: sessions.reopen({ ...stored, info }).id }, 201);
      await markRunDead(stored);
      if (!stored.info.claudeSessionId) throw new HttpError(404, `No saved session ${c.req.param("id")}.`);
    }
    return c.json({ id: sessions.resume(stored, ready.env).id }, 201);
  });

  /** Starts the sandbox of a session opened asleep, if it is stopped, and Claude on the session. */
  app.post("/api/sessions/:id/wake", async (c) => {
    const { id, sandbox } = sessionOf(c);
    const ready = await startedSandbox(sandbox);
    return c.json(sessions.wake(id, ready.env));
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

  /** Runs a command in the session's sandbox, a message starting with "!": answered with its run's id. */
  app.post("/api/sessions/:id/shell", async (c) => {
    const { id, sandbox } = sessionOf(c);
    const req = await c.req.json<Partial<ShellRequest>>().catch(() => ({}) as Partial<ShellRequest>);
    const command = typeof req.command === "string" ? req.command.trim() : "";
    if (!command) throw new HttpError(400, "The command is empty.");
    const ready = await readySandbox(sandbox);
    return c.json({ id: sessions.runShell(id, command, ready.env) }, 202);
  });

  app.post("/api/sessions/:id/shell/:run/stop", (c) => {
    const run = c.req.param("run");
    if (!RUN_ID.test(run)) throw new HttpError(400, "Which command?");
    sessions.stopShell(sessionOf(c).id, run);
    return c.json({ ok: true });
  });

  /** Takes back a prompt sent while Claude worked, before Claude reads it, to be edited: `withdrawn` false if it was too late. */
  app.post("/api/sessions/:id/prompts/:prompt/withdraw", async (c) => {
    const prompt = c.req.param("prompt");
    if (!/^[A-Za-z0-9-]{1,64}$/.test(prompt)) throw new HttpError(400, "Which prompt?");
    return c.json({ withdrawn: await sessions.withdrawPrompt(sessionOf(c).id, prompt) });
  });

  /** Starts a new session from a copy of this one's conversation, or of it up to one prompt's turn. Returns the new session's id. */
  app.post("/api/sessions/:id/fork", async (c) => {
    const from = sessionOf(c);
    const req = await c.req.json<ForkRequest>().catch(() => ({}) as ForkRequest);
    if (req.prompt !== undefined && typeof req.prompt !== "string") throw new HttpError(400, "Which message to fork from?");
    const ready = await readySandbox(from.sandbox);
    return c.json({ id: sessions.fork(from.id, ready.env, req.prompt).id }, 201);
  });

  /** Proposals being accepted, so a second Start meanwhile doesn't start another session. */
  const accepting = new Set<string>();
  /**
   * The user's answer to Claude asking to start a new session (its session_start tool): accepted, it starts in the
   * sandbox on the proposed prompt, or on `prompt` if the user changed it, named as proposed, with copies of the
   * artifacts asked for, and its id is returned, with what couldn't be copied; declined, nothing starts.
   */
  app.post("/api/sessions/:id/proposals/:proposal", async (c) => {
    const from = sessionOf(c);
    const proposalId = c.req.param("proposal");
    const req = await c.req.json<{ accept?: unknown; prompt?: unknown }>().catch(() => ({}) as { accept?: unknown; prompt?: unknown });
    if (typeof req.accept !== "boolean") throw new HttpError(400, "Body must be JSON: { accept, prompt? }.");
    if (req.prompt !== undefined && typeof req.prompt !== "string") throw new HttpError(400, "The prompt must be a string.");
    const edited = req.prompt?.trim();
    if (req.accept && edited === "") throw new HttpError(400, "Give the new session a prompt.");
    const proposal = sessions.openProposal(from.id, proposalId);
    if (!proposal || accepting.has(proposalId)) throw new HttpError(409, "That has been answered already.");
    if (!req.accept) {
      sessions.answerProposal(from.id, proposalId, false);
      return c.json({ ok: true });
    }
    accepting.add(proposalId);
    try {
      const ready = await startedSandbox(from.sandbox);
      const { title, artifacts = [] } = proposal;
      // The prompt the user started it on, said in the answer only when it isn't Claude's.
      const prompt = edited ?? proposal.prompt;
      const changed = prompt !== proposal.prompt ? prompt : undefined;
      // The artifacts it is given go in its folder before its Claude starts, and the prompt says where they are.
      const id = sessions.newId();
      const { copied, skipped } = artifacts.length ? await widgets.copyArtifacts(from, { id, sandbox: from.sandbox }, artifacts) : { copied: [], skipped: [] };
      const given = copied.length
        ? `\n\nCopies of artifacts from the session that asked for this one are in your artifacts folder, and your window shows them: ${copied.map((c) => `${c.path} ("${c.title}")`).join(", ")}.`
        : "";
      const session = sessions.start({ sandbox: from.sandbox, workdir: ready.workdir, env: ready.env, prompt: prompt + given, id });
      sessions.answerProposal(from.id, proposalId, true, session.id, changed);
      if (title) sessions.rename(session.id, title, "agent");
      if (copied.length) await widgets.addCopies(session, copied, true);
      return c.json({ id: session.id, ...(skipped.length ? { skipped } : {}) }, 201);
    } finally {
      accepting.delete(proposalId);
    }
  });

  /** Rewinds this session in place to just before one of its prompts. Returns the prompt's text. */
  app.post("/api/sessions/:id/rewind", async (c) => {
    const from = sessionOf(c);
    const req = await c.req.json<{ prompt?: unknown; files?: unknown }>().catch(() => ({}) as { prompt?: unknown; files?: unknown });
    if (typeof req.prompt !== "string" || !req.prompt) throw new HttpError(400, "Which message to rewind to?");
    const ready = await readySandbox(from.sandbox);
    return c.json((await sessions.rewind(from.id, req.prompt, ready.env, { files: req.files === true })) satisfies RewindResponse);
  });

  // A login is the sandbox's: its Claude home holds it, so every session of the sandbox shares it. It is started from
  // a session because that is where being logged out shows.

  /** Whether the session's sandbox is logged in now, without starting a login. */
  app.get("/api/sessions/:id/login", async (c) => {
    const { sandbox } = sessionOf(c);
    const { info } = await known(sandbox);
    if (info.status !== "running") return c.json({} satisfies LoginStatusResponse);
    const account = await logins.account(sandbox);
    return c.json((account ? { loggedIn: account } : {}) satisfies LoginStatusResponse);
  });

  /** Starts logging Claude in for the session's sandbox: the sign-in URL, or who it is logged in as already. */
  app.post("/api/sessions/:id/login", async (c) => {
    const { sandbox } = sessionOf(c);
    const ready = await readySandbox(sandbox);
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
    const ready = await readySandbox(sandbox);
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
    const ready = await readySandbox(sandbox);
    // Restarted on its own meanwhile: nothing more to do.
    if (!sessions.get(id)?.toolsOutdated) return c.json(sessions.get(id));
    restartTried.add(id);
    return c.json(sessions.relaunch(id, ready.env));
  });

  /** The user is looking at the session, so it no longer waits on them. */
  app.post("/api/sessions/:id/seen", (c) => {
    sessions.markSeen(sessionOf(c).id);
    return c.json({ ok: true });
  });

  // The user closing one of the window's panes, or showing a widget again. Claude's tools change the window too, but
  // not through here. Either may change which files are watched, and a widget shown again may have changed while hidden.
  app.post("/api/sessions/:id/window/close", async (c) => {
    const req = await c.req.json<{ pane?: unknown }>().catch(() => ({}) as { pane?: unknown });
    if (typeof req.pane !== "string" || !req.pane) throw new HttpError(400, "Which pane to close?");
    const { id } = sessionOf(c);
    const w = sessions.changeWindow(id, { type: "close", pane: req.pane });
    void widgets.refresh(id);
    return c.json(w);
  });

  // The user rearranging the window: a pane to a side of another, or swapped with it; and a split dragged to a new size.
  const SIDES = ["left", "right", "above", "below", "swap"];
  app.post("/api/sessions/:id/window/move", async (c) => {
    const req = await c.req.json<{ pane?: unknown; to?: unknown; side?: unknown }>().catch(() => ({}) as { pane?: unknown; to?: unknown; side?: unknown });
    if (typeof req.pane !== "string" || typeof req.to !== "string" || typeof req.side !== "string" || !SIDES.includes(req.side)) {
      throw new HttpError(400, `Body must be JSON: { pane, to, side }, side one of ${SIDES.join(", ")}.`);
    }
    return c.json(sessions.changeWindow(sessionOf(c).id, { type: "move", pane: req.pane, to: req.to, side: req.side as Side | "swap" }));
  });

  // A window answering a pane request: the picture, nothing (a reload alone), or why it couldn't, with `fallback` when
  // another window could do better (it doesn't show the session, or can't take pictures).
  app.post("/api/sessions/:id/window/answer", async (c) => {
    type Answer = { request?: unknown; data?: unknown; mimeType?: unknown; error?: unknown; fallback?: unknown; note?: unknown };
    const req = await c.req.json<Answer>().catch(() => ({}) as Answer);
    const waiting = typeof req.request === "string" ? paneRequests.get(req.request) : undefined;
    if (!waiting) return c.json({ ok: false }, 404);
    const note = typeof req.note === "string" ? req.note.slice(0, 2000) : undefined;
    if (typeof req.error === "string") waiting.fail(new Error(req.error), req.fallback === true);
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

  // In `pane`, swapping with the pane that shows it now, if any; with `split`, in a new pane split off `pane` that way;
  // without either, where Claude's artifact_open would put it.
  app.post("/api/sessions/:id/window/show", async (c) => {
    type ShowRequest = { widget?: unknown; pane?: unknown; split?: unknown };
    const req = await c.req.json<ShowRequest>().catch(() => ({}) as ShowRequest);
    if (typeof req.widget !== "string" || !req.widget) throw new HttpError(400, "Which widget to show?");
    if (req.pane !== undefined && (typeof req.pane !== "string" || !req.pane)) throw new HttpError(400, "Which pane to show it in?");
    if (req.split !== undefined && req.split !== "right" && req.split !== "below") throw new HttpError(400, 'split is "right" or "below".');
    const { id } = sessionOf(c);
    const w = sessions.window(id)!;
    if (!req.pane && !req.split && paneOf(w, req.widget)) return c.json(w);
    const target = req.split ? undefined : req.pane ? { pane: req.pane } : docPaneTarget(w);
    const op: WindowOp =
      target && "pane" in target
        ? { type: "show", pane: target.pane, widget: req.widget }
        : { type: "split", place: { split: req.split === "below" ? "below" : "right", ...(req.split && req.pane ? { of: req.pane } : {}) }, pane: nextId(w, "p"), widget: req.widget };
    const shown = sessions.changeWindow(id, op);
    void widgets.refresh(id);
    return c.json(shown);
  });

  // Claude's background shells and monitors: what one has printed so far, and stopping one (subagents too). Asking costs
  // Claude no turn. Task ids are Claude's, such as "b9yuskb88".
  const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;
  const taskOf = (c: { req: { param(name: string): string } }) => {
    const task = c.req.param("task");
    if (!TASK_ID.test(task)) throw new HttpError(400, `Not a task id: ${task}`);
    return task;
  };
  app.get("/api/sessions/:id/tasks/:task/output", async (c) => c.json(await sessions.taskOutput(sessionOf(c).id, taskOf(c))));
  // All of what a task that ended printed, read from Claude's own file of it in the sandbox, for as long as Claude keeps
  // it: from its start, up to TASK_FILE_BYTES. 410 once the file is gone, as a VM restart takes it.
  app.get("/api/sessions/:id/tasks/:task/file", async (c) => {
    const { id, sandbox } = sessionOf(c);
    const task = taskOf(c);
    const file = sessions.taskFile(id, task);
    if (!file) throw new HttpError(404, "Claude didn't say where this task's output is kept.");
    const q = shellQuote(file);
    // Its size on the first line, then as much of it as is shown; exit 3 if it isn't there. One command, as the sandbox
    // runs it with exec.
    const cmd = `bash -c ${shellQuote(`[ -f ${q} ] || exit 3; wc -c < ${q}; head -c ${TASK_FILE_BYTES} ${q}`)}`;
    const out = await execOutput(provider.exec.bind(provider), sandbox, cmd, 30_000).catch((err: Error) => {
      if (/^exit 3\b/.test(err.message)) throw new HttpError(410, "Claude's file of this output is gone.");
      throw new HttpError(503, `Couldn't read it from ${vmName(sandbox)}: ${err.message}`);
    });
    const nl = out.indexOf("\n");
    const totalBytes = Number(out.slice(0, nl).trim());
    const truncated = totalBytes > TASK_FILE_BYTES;
    // Cut at a byte count, the last line may end inside a character: what is shown ends with the last whole line.
    const output = out.slice(nl + 1);
    const lastLine = output.lastIndexOf("\n");
    return c.json({ output: truncated && lastLine >= 0 ? output.slice(0, lastLine + 1) : output, totalBytes, truncated });
  });
  app.post("/api/sessions/:id/tasks/:task/stop", async (c) => {
    await sessions.stopTask(sessionOf(c).id, taskOf(c));
    return c.json({ ok: true });
  });

  /** Moves a command Claude is waiting on to the background, as Ctrl+B does in Claude: the one `toolUseId` started, or all. */
  app.post("/api/sessions/:id/tasks/background", async (c) => {
    const req = await c.req.json<{ toolUseId?: unknown }>().catch(() => ({}) as { toolUseId?: unknown });
    if (req.toolUseId !== undefined && (typeof req.toolUseId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(req.toolUseId))) throw new HttpError(400, "toolUseId is a tool call's id.");
    await sessions.backgroundTasks(sessionOf(c).id, req.toolUseId);
    return c.json({ ok: true });
  });

  // The Tasks pane: opened beside the chat, or closed if it is open; with `open`, only opened.
  app.post("/api/sessions/:id/window/tasks", async (c) => {
    const req = await c.req.json<{ open?: unknown }>().catch(() => ({}) as { open?: unknown });
    const { id } = sessionOf(c);
    let w = sessions.window(id)!;
    if (!w.widgets[TASKS]) w = sessions.changeWindow(id, { type: "add", widget: TASKS, kind: "tasks" });
    const pane = paneOf(w, TASKS);
    if (pane) return c.json(req.open === true ? w : sessions.changeWindow(id, { type: "close", pane }));
    return c.json(sessions.changeWindow(id, { type: "split", place: { split: "right", size: 0.4 }, pane: nextId(w, "p"), widget: TASKS }));
  });

  /** Answers what Claude asked mid-turn: its questions, or its plan. 409 once it isn't waiting for that any more. */
  app.post("/api/sessions/:id/asks/:ask", async (c) => {
    const answer = parseAskAnswer(await c.req.json().catch(() => undefined));
    if (!answer) throw new HttpError(400, "Send an answer: answers to the questions, approve, feedback with its text, or skip.");
    sessions.answerAsk(sessionOf(c).id, c.req.param("ask"), answer);
    return c.json({ ok: true });
  });

  /**
   * Decides on an approval card: `{ action: "approve", decision }`, `{ action: "decline", reason? }`, or
   * `{ action: "refresh" }` to work a stale card out again. Answers with the card as it is now.
   */
  app.post("/api/sessions/:id/cards/:ask", async (c) => {
    const req = await body<{ action?: unknown; decision?: unknown; reason?: unknown }>(c, "Send { action: approve | decline | refresh }.");
    const id = sessionOf(c).id;
    const ask = c.req.param("ask");
    let action: Parameters<Approvals["decide"]>[2];
    if (req.action === "approve") {
      const decision = parseCardDecision(req.decision);
      if (!decision) throw new HttpError(400, "Send the decision: the route and method, or the text as you left it.");
      action = { action: "approve", decision };
    } else if (req.action === "decline") action = { action: "decline", ...(typeof req.reason === "string" ? { reason: req.reason } : {}) };
    else if (req.action === "refresh") action = { action: "refresh" };
    else throw new HttpError(400, "action must be approve, decline or refresh.");
    try {
      return c.json(await approvals.decide(id, ask, action));
    } catch (err) {
      if (err instanceof ApprovalError || err instanceof AskRefused) throw new HttpError(409, err.message);
      throw err;
    }
  });

  /** Has Claude plan first, waiting for the user to approve the plan, or work without asking; `{ plan }`. */
  app.post("/api/sessions/:id/plan-mode", async (c) => {
    const { plan } = await body<{ plan?: unknown }>(c, "Send { plan: true } or { plan: false }.");
    if (typeof plan !== "boolean") throw new HttpError(400, "Send { plan: true } or { plan: false }.");
    sessions.setPlanMode(sessionOf(c).id, plan);
    return c.json({ ok: true }, 202);
  });

  app.post("/api/sessions/:id/interrupt", (c) => {
    sessions.interrupt(sessionOf(c).id);
    return c.json({ ok: true }, 202);
  });

  /**
   * Closes a session's tab: once Claude finishes its turn (202), or at once with `?stop` or when it isn't working.
   * With `?delete`, its saved chat goes too.
   */
  app.delete("/api/sessions/:id", async (c) => {
    const finishing = await sessions.close(sessionOf(c).id, { forget: c.req.query("delete") !== undefined, stop: c.req.query("stop") !== undefined });
    return c.json({ ok: true, finishing }, finishing ? 202 : 200);
  });

  // ---- repository mirrors ----

  /** Who gh on the host is signed in to GitHub as, or why it isn't. */
  app.get("/api/github/account", async (c) => c.json((await github.account()) satisfies GitHubAccount));

  /** The repositories gh's account can see, to pick mirrors from. */
  app.get("/api/github/repos", async (c) => c.json({ repos: await github.repos() } satisfies GitHubReposResponse));

  app.get("/api/mirrors", (c) => c.json(mirrorsView()));

  /** Picks a repository and starts cloning its mirror; the page follows the clone through `mirrors` events. */
  app.post("/api/mirrors", async (c) => {
    const req = await body<AddMirrorRequest>(c, "Body must be JSON: { repo, private }.");
    if (!parseRepo(req?.repo)) throw new HttpError(400, "repo must be a GitHub repository, as owner/name.");
    return c.json(await mirrors.pick(req.repo, typeof req.private === "boolean" ? { private: req.private } : {}), 201);
  });

  /** Fetches the mirror from GitHub, or joins the fetch under way; answers at once, and the page follows it. */
  app.post("/api/mirrors/:owner/:name/fetch", (c) => {
    const repo = `${c.req.param("owner")}/${c.req.param("name")}`;
    if (!mirrors.get(repo)) throw new MirrorNotFound(`${repo} isn't one of Kumiko's repositories.`);
    void mirrors.fetch(repo).catch(() => {});
    return c.json({ ok: true }, 202);
  });

  /** Unpicks the repository and deletes its mirror. */
  app.delete("/api/mirrors/:owner/:name", async (c) => {
    await mirrors.remove(`${c.req.param("owner")}/${c.req.param("name")}`);
    return c.json({ ok: true });
  });

  app.all("/api/*", (c) => c.json(fail("Not found."), 404));
  if (opts.webDir) app.get("*", serveWeb(opts.webDir));

  // ---- http + websocket -------------------------------------------------------------------

  const server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port: opts.port ?? 4317, hostname: host }, () => resolve(s as Server)) as Server;
  });
  serving = true;
  restartOutdated();
  wakeAsleep();

  const wss = new WebSocketServer({ noServer: true });
  const sessionSockets = new Set<WebSocket>();
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const sessionId = /^\/api\/sessions\/([^/]+)\/events$/.exec(url.pathname)?.[1];
    // An unknown session is accepted and closed with 4404, which a browser can see; an HTTP 404 would look like a network error.
    if ((url.pathname !== "/api/events" && !(sessionId && SESSION_ID_PATTERN.test(sessionId))) || !isLocalRequest(req.headers, ownPort()) || !hasToken(req.headers, token, ownPort())) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (sessionId) return streamSession(ws, sessionId, Number(url.searchParams.get("after") ?? 0) || 0, url.searchParams.get("buffer") ?? undefined);
      clients.add(ws);
      ws.on("close", () => clients.delete(ws));
      ws.on("error", () => clients.delete(ws));
      ws.send(JSON.stringify({ type: "snapshot", sandboxes: views(), unreadable, logs: ops.logs(), sessions: sessions.list(), error: listError, mirrors: mirrorsView() } satisfies ServerEvent));
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
  const url = `http://${host}:${port}`;
  return {
    url,
    port,
    token,
    loginUrl: `${url}/api/login?token=${token}`,
    working: () => sessions.list().filter(isBusy),
    close: async ({ endSessions = false } = {}) => {
      clearInterval(timer);
      stats.stopAll();
      logins.cancelAll();
      await relays.close();
      await pushes.close();
      await mirrors.close();
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
