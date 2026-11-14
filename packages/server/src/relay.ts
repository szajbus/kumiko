import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { eachLine, exitCode, shellQuote, type SandboxProvider } from "@kumiko/sandbox";
import { parseRepo, type RelayView } from "@kumiko/shared";
import { gitEnv, type Mirrors } from "./mirrors.js";

/** The host git:// requests go to; core.gitProxy sends only this one through the socket. */
export const RELAY_HOST = "kumiko";

/** git's services a client can ask the relay for. */
export type GitService = "git-upload-pack" | "git-receive-pack";

/** The first thing a git:// client sends, in one pkt-line: the service, the repository's path, then the host and extras. */
export interface GitRequest {
  service: GitService;
  path: string;
  /** Everything after the path's NUL, as it came: `host=…\0` and, for protocol v2, `\0version=2\0`. */
  rest: Buffer;
}

/** The longest request line Kumiko reads; git's own limit for a pkt-line is 65520 bytes. */
const MAX_REQUEST = 65520;

/** How long a connection may take to say what it wants. */
const REQUEST_MS = 10_000;

/** The line the proxy sends before git's request: which session the command runs in. */
const SESSION_LINE = /^kumiko-session ([0-9a-f-]{0,64})\n/;

/**
 * Reads the proxy's session line from the start of what a connection sent, if it has one: the session, if one was
 * named, and what follows. Undefined while it may still be coming.
 */
export function readSessionLine(buf: Buffer): { session?: string; after: Buffer } | undefined {
  const prefix = "kumiko-session ";
  const head = buf.subarray(0, prefix.length).toString("latin1");
  if (!prefix.startsWith(head) && !head.startsWith(prefix)) return { after: buf };
  const nl = buf.indexOf(10);
  if (nl < 0) {
    if (buf.length > 100) throw new Error("not a session line");
    return undefined;
  }
  const m = SESSION_LINE.exec(buf.subarray(0, nl + 1).toString("latin1"));
  if (!m) throw new Error("not a session line");
  return { ...(m[1] ? { session: m[1] } : {}), after: buf.subarray(nl + 1) };
}

/** A pkt-line: four hex digits of length, counting themselves, then the data. */
export function pktLine(data: string | Buffer): Buffer {
  const body = typeof data === "string" ? Buffer.from(data) : data;
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, "0")), body]);
}

/**
 * Reads a git:// request from the start of what a connection sent: the request and whatever came after it, or
 * undefined while the line isn't all there yet. Throws on anything that isn't a request.
 */
export function readRequest(buf: Buffer): { request: GitRequest; after: Buffer } | undefined {
  if (buf.length < 4) return undefined;
  const len = Number.parseInt(buf.subarray(0, 4).toString("latin1"), 16);
  if (!/^[0-9a-f]{4}$/i.test(buf.subarray(0, 4).toString("latin1")) || len < 5 || len > MAX_REQUEST) throw new Error("not a git request");
  if (buf.length < len) return undefined;
  const line = buf.subarray(4, len);
  const nul = line.indexOf(0);
  const head = (nul < 0 ? line : line.subarray(0, nul)).toString("utf8").replace(/\n$/, "");
  const m = /^(git-upload-pack|git-receive-pack) (\S+)$/.exec(head);
  if (!m) throw new Error("not a git request");
  return { request: { service: m[1] as GitService, path: m[2], rest: nul < 0 ? Buffer.alloc(0) : line.subarray(nul) }, after: buf.subarray(len) };
}

/** The repository path git asks the relay for: `/owner/name.git` for the URL insteadOf writes. */
export const relayPath = (repo: string) => `/${parseRepo(repo)!.key}.git`;

/** The URL git in the VM uses in place of GitHub's, which the socket's far end serves. */
export const relayUrl = (repo: string) => `git://${RELAY_HOST}${relayPath(repo)}`;

/**
 * The URLs git in the VM may know the repository by, each sent to the mirror: GitHub's SSH and HTTPS forms, with and
 * without ".git", spelled as origin spells the repository. insteadOf matches prefixes and the longest wins, so the
 * forms without ".git" never cut a longer URL short.
 */
export function remoteForms(repo: string): string[] {
  return [`git@github.com:${repo}.git`, `git@github.com:${repo}`, `https://github.com/${repo}.git`, `https://github.com/${repo}`, `ssh://git@github.com/${repo}.git`];
}

/** A value in git's config file syntax: quoted, with what the quotes and escapes need escaped. */
const configValue = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;

/**
 * The git config Kumiko keeps in the VM, at ~/.config/kumiko/git.config, which the VM user's ~/.gitconfig includes:
 * GitHub's URLs for the repository go to the mirror, and git:// to the relay's host goes through the proxy script.
 * `@DIR@` is where it is, filled in in the VM. The identity is the user's, from the host.
 */
export function vmGitConfig(repo: string, identity: { name?: string; email?: string }): string {
  const user = [identity.name && `\tname = ${configValue(identity.name)}`, identity.email && `\temail = ${configValue(identity.email)}`].filter(Boolean);
  return [
    "# Written by Kumiko whenever the VM starts. Fetches and pushes to GitHub go to Kumiko's mirror on the host.",
    ...(user.length ? ["[user]", ...user] : []),
    "[core]",
    `\tgitProxy = ${configValue(`@DIR@/git-proxy for ${RELAY_HOST}`)}`,
    `[url ${configValue(relayUrl(repo))}]`,
    ...remoteForms(repo).map((u) => `\tinsteadOf = ${configValue(u)}`),
    "",
  ].join("\n");
}

/**
 * The proxy git runs for git:// to Kumiko, with the host and port as arguments: there is only one place to go. It says
 * first which of Kumiko's sessions the command runs in, if any (Kumiko starts Claude with KUMIKO_SESSION), so a push
 * that has to wait for the user is asked about there. That line isn't trusted for anything else.
 */
export const GIT_PROXY = `#!/bin/bash
# Written by Kumiko: git:// to ${RELAY_HOST} goes to the mirrors on the host, over the socket Kumiko forwards here.
# socat is the proxy itself, so it ends when the connection does; what feeds it the session line, then git's side, is
# left to end when git closes that.
exec socat - "UNIX-CONNECT:@SOCK@" < <(printf 'kumiko-session %s\\n' "\${KUMIKO_SESSION:-}"; exec cat 2>/dev/null)
`;

/**
 * The script that sets git in the VM up for the relay, on every start: socat, the proxy git runs for git:// to
 * Kumiko, the config above, included from ~/.gitconfig, and no stale socket where the forward will listen. It prints
 * the socket's path.
 */
export function vmSetupScript(config: string): string {
  return [
    "set -e",
    `need=""; command -v git >/dev/null || need="git"; command -v socat >/dev/null || need="$need socat"`,
    `if [ -n "$need" ]; then sudo apt-get update -qq >/dev/null && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $need >/dev/null; fi`,
    `command -v socat >/dev/null || { echo "socat isn't installed in the VM, and couldn't be installed." >&2; exit 1; }`,
    `d="$HOME/.config/kumiko"; mkdir -p "$d"; sock="$d/git.sock"; rm -f "$sock"`,
    `cat > "$d/git-proxy.new" <<'KUMIKO_PROXY'\n${GIT_PROXY}KUMIKO_PROXY`,
    `sed "s|@SOCK@|$sock|g" "$d/git-proxy.new" > "$d/git-proxy" && rm -f "$d/git-proxy.new"`,
    `chmod 755 "$d/git-proxy"`,
    `cat > "$d/git.config.new" <<'KUMIKO_GIT'\n${config}KUMIKO_GIT`,
    `sed "s|@DIR@|$d|g" "$d/git.config.new" > "$d/git.config" && rm -f "$d/git.config.new"`,
    `git config --global --get-all include.path 2>/dev/null | grep -qxF "$d/git.config" || git config --global --add include.path "$d/git.config"`,
    `printf 'socket %s\\n' "$sock"`,
  ].join("\n");
}

/** Who a connection is: the project whose VM it came from, its repository, and the session the proxy named, if any. */
export interface RelayConnection {
  project: string;
  repo: string;
  session?: string;
}

export interface RelayOptions {
  /** Where the host's sockets go, one per project. Not under anything the VM mounts. */
  dir: string;
  mirrors: Mirrors;
  provider: Pick<SandboxProvider, "exec" | "forward">;
  /** The user's git identity on the host, for commits made in the VM. */
  identity?(): Promise<{ name?: string; email?: string }>;
  /** The socket the mirror's pre-receive hook asks Kumiko about a push on; without it, every push is refused. */
  hookSocket?: string;
  /** Called when a relay's view changes. */
  onChange?(): void;
  /** Called when git in the VM closes a connection. */
  onConnectionClosed?(id: string): void;
  /** How long to wait before setting a relay up again after it failed, at first; it doubles up to a minute. */
  retryMs?: number;
}

/**
 * The relays of the projects whose VMs run: each a socket on the host, forwarded into its VM by an ssh connection
 * Kumiko holds, and for each connection a `git daemon --inetd` serving only that project's mirror.
 */
export class Relays {
  private relays = new Map<string, Relay>();
  /** The connections being served, by the id their git daemon's hook gives: which project, repository and session. */
  private readonly connections = new Map<string, RelayConnection>();
  /** Closed for good: a sync that was under way when Kumiko began quitting starts nothing. */
  private closed = false;

  constructor(private readonly opts: RelayOptions) {}

  /** Starts a relay for each project in `want` (by id, to its repository) that has none, and stops the others. */
  sync(want: Map<string, string>): void {
    if (this.closed) return;
    for (const [id, relay] of this.relays) {
      if (want.get(id) === relay.repo) continue;
      this.relays.delete(id);
      void relay.stop();
    }
    for (const [id, repo] of want) {
      if (this.relays.has(id)) continue;
      const relay = new Relay(id, repo, this.opts, this.connections);
      this.relays.set(id, relay);
      relay.start();
    }
  }

  view(id: string): RelayView | undefined {
    return this.relays.get(id)?.view();
  }

  /** Who a connection's git daemon serves, while it is open. */
  connection(id: string): RelayConnection | undefined {
    return this.connections.get(id);
  }

  async close(): Promise<void> {
    this.closed = true;
    const all = [...this.relays.values()];
    this.relays.clear();
    await Promise.all(all.map((r) => r.stop()));
  }
}

class Relay {
  private state: RelayView["state"] = "connecting";
  private error?: string;
  private stopped = false;
  private server?: Server;
  private forward?: ChildProcess;
  private wake?: () => void;
  private readonly conns = new Set<Socket>();
  private readonly daemons = new Set<ChildProcess>();
  private readonly socket: string;
  private running?: Promise<void>;

  constructor(
    readonly id: string,
    readonly repo: string,
    private readonly opts: RelayOptions,
    private readonly connections: Map<string, RelayConnection>,
  ) {
    this.socket = join(opts.dir, `git-${id}.sock`);
  }

  view(): RelayView {
    return { repo: this.repo, state: this.state, ...(this.error ? { error: this.error } : {}) };
  }

  start() {
    this.running = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const forward = this.forward;
    forward?.kill();
    // ssh ends at once when told to; one that doesn't mustn't hold up Kumiko quitting.
    if (forward) setTimeout(() => forward.exitCode === null && forward.signalCode === null && forward.kill("SIGKILL"), 5000).unref();
    this.wake?.();
    for (const c of this.conns) c.destroy();
    for (const d of this.daemons) d.kill();
    await this.running;
  }

  private set(state: RelayView["state"], error?: string) {
    if (this.stopped || (state === this.state && error === this.error)) return;
    this.state = state;
    this.error = error;
    this.opts.onChange?.();
  }

  /** Keeps the relay up until it is stopped: the socket, the mirror, the VM's setup and the forward, again after each failure. */
  private async run(): Promise<void> {
    let delay = this.opts.retryMs ?? 2000;
    try {
      await mkdir(this.opts.dir, { recursive: true, mode: 0o700 });
      await rm(this.socket, { force: true });
      // Half-open: git finishing what it sends must still get all of the answer.
      this.server = createServer({ allowHalfOpen: true }, (c) => this.serve(c));
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(this.socket, () => resolve());
      });
    } catch (err) {
      this.set("down", `Kumiko couldn't listen on ${this.socket}: ${message(err)}`);
      return;
    }
    while (!this.stopped) {
      const upAt = Date.now();
      try {
        await this.opts.mirrors.ensure(this.repo);
        if (this.stopped) break;
        const guest = await this.setUpVm();
        if (this.stopped) break;
        await this.hold(guest);
      } catch (err) {
        this.set("down", message(err));
      }
      if (this.stopped) break;
      // A forward that held for a while and then dropped is set up again soon; one that keeps failing, less and less often.
      if (Date.now() - upAt > 60_000) delay = this.opts.retryMs ?? 2000;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        this.wake = () => (clearTimeout(timer), resolve());
      });
      delay = Math.min(delay * 2, 60_000);
    }
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
    await rm(this.socket, { force: true }).catch(() => {});
  }

  /** Runs the VM's setup and resolves with the path the forward listens on in the VM. */
  private async setUpVm(): Promise<string> {
    const identity = (await this.opts.identity?.().catch(() => ({}))) ?? {};
    const script = vmSetupScript(vmGitConfig(this.repo, identity));
    const child = this.opts.provider.exec(this.id, `bash -c ${shellQuote(script)}`, []);
    child.stdin!.end();
    const out: string[] = [];
    const err: string[] = [];
    eachLine(child.stdout!, (l) => out.push(l));
    eachLine(child.stderr!, (l) => err.push(l));
    const code = await exitCode(child);
    const path = out.map((l) => /^socket (\/.+)$/.exec(l)?.[1]).find(Boolean);
    if (code !== 0 || !path) throw new Error(`Setting up git in the VM failed (exit ${code})${err.length ? `: ${err.slice(-3).join(" ")}` : "."}`);
    return path;
  }

  /** Holds the forward until it ends; it is up once its socket shows in the VM. */
  private async hold(guest: string): Promise<void> {
    const child = this.opts.provider.forward(this.id, guest, this.socket);
    this.forward = child;
    const err: string[] = [];
    eachLine(child.stderr!, (l) => err.push(l));
    const ended = exitCode(child);
    let over = false;
    void ended.then(() => (over = true));
    // Checked until it shows, however long ssh takes: often at first, then once a second.
    for (let i = 0; !over && !this.stopped; i++) {
      if (await this.inVm(`[ -S ${shellQuote(guest)} ]`)) {
        this.set("connected");
        break;
      }
      await new Promise((r) => setTimeout(r, i < 40 ? 250 : 1000));
    }
    const code = await ended;
    this.forward = undefined;
    if (!this.stopped) throw new Error(`The ssh connection holding the relay ended (exit ${code})${err.length ? `: ${err.slice(-2).join(" ")}` : "."}`);
  }

  private async inVm(cmd: string): Promise<boolean> {
    const child = this.opts.provider.exec(this.id, cmd, []);
    child.stdin!.end();
    child.stdout!.resume();
    child.stderr!.resume();
    return (await exitCode(child)) === 0;
  }

  /**
   * Serves one connection: reads what it asks for, refuses anything but this project's repository, refreshes the
   * mirror before a fetch, then hands the connection to a git daemon of its own, with the request it read.
   */
  private serve(conn: Socket) {
    this.conns.add(conn);
    conn.on("close", () => this.conns.delete(conn));
    conn.on("error", () => conn.destroy());
    let buf: Buffer = Buffer.alloc(0);
    const timer = setTimeout(() => conn.destroy(), REQUEST_MS);
    let session: string | undefined;
    let sessionRead = false;
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      let read: ReturnType<typeof readRequest>;
      try {
        if (!sessionRead) {
          const line = readSessionLine(buf);
          if (!line) return;
          sessionRead = true;
          session = line.session;
          buf = line.after;
        }
        read = readRequest(buf);
      } catch {
        clearTimeout(timer);
        conn.end(pktLine("ERR Kumiko's relay only speaks git.\n"));
        return;
      }
      if (!read) return;
      clearTimeout(timer);
      conn.off("data", onData);
      conn.pause();
      void this.handOver(conn, read.request, read.after, session);
    };
    conn.on("data", onData);
  }

  private async handOver(conn: Socket, request: GitRequest, after: Buffer, session?: string) {
    const path = relayPath(this.repo);
    if (request.path.toLowerCase().replace(/(\.git)?\/?$/, ".git") !== path) {
      conn.end(pktLine(`ERR Kumiko: this VM can only reach ${this.repo} (${relayUrl(this.repo)}), not ${request.path}.\n`));
      return;
    }
    // A fetch gets what is on GitHub now. If GitHub can't be reached, the mirror as it is still serves.
    if (request.service === "git-upload-pack") await this.opts.mirrors.fetch(this.repo).catch(() => {});
    if (conn.destroyed || this.stopped) return conn.destroy();
    const dir = this.opts.mirrors.path(this.repo);
    const connection = randomUUID();
    const daemon = spawn(
      "git",
      ["daemon", "--inetd", "--informative-errors", "--export-all", "--enable=receive-pack", `--base-path=${this.opts.mirrors.root}`, "--strict-paths", dir],
      {
        cwd: this.opts.mirrors.root,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...gitEnv(), KUMIKO_SANDBOX: this.id, KUMIKO_CONNECTION: connection, ...(this.opts.hookSocket ? { KUMIKO_HOOK_SOCKET: this.opts.hookSocket } : {}) },
      },
    );
    this.daemons.add(daemon);
    this.connections.set(connection, { project: this.id, repo: this.repo, ...(session ? { session } : {}) });
    // A push waiting in the hook for the user stops waiting when git in the VM goes away.
    conn.once("close", () => this.opts.onConnectionClosed?.(connection));
    daemon.on("error", () => conn.destroy());
    daemon.stdin!.on("error", () => {});
    daemon.stderr!.resume();
    // Once its output is all read, not when it exits: the end of the pack may still be on its way.
    daemon.on("close", () => {
      this.daemons.delete(daemon);
      this.connections.delete(connection);
      conn.end();
    });
    // The request again, with the path as the mirror has it, whatever case the VM's URL used.
    daemon.stdin!.write(Buffer.concat([pktLine(Buffer.concat([Buffer.from(`${request.service} ${path}`), request.rest])), after]));
    conn.pipe(daemon.stdin!);
    daemon.stdout!.pipe(conn);
    conn.resume();
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
