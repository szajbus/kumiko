import { execFile } from "node:child_process";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { gitEnv, type Mirrors } from "./mirrors.js";

/** The all-zero id git gives the old side of a new ref and the new side of a deleted one. */
const ZERO = /^0+$/;

/** A ref update a push asks for, as the pre-receive hook gets it. */
export interface RefUpdate {
  old: string;
  new: string;
  ref: string;
}

/** Who is pushing: the project whose VM the push came from, and its repository. */
export interface Pusher {
  project: string;
  repo: string;
}

/** What Kumiko makes of a push: refused, with why for each ref that is, or allowed, with the branches it changes. */
export type PushDecision =
  | { allowed: false; reasons: string[] }
  | { allowed: true; branches: { branch: string; update: RefUpdate; created: boolean; deleted: boolean }[] };

/** The hook's lines: `<old> <new> <ref>`, one per ref. */
export function parseUpdates(text: string): RefUpdate[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) (refs\/\S+)$/.exec(l);
      if (!m) throw new Error(`Not a ref update: ${l.slice(0, 200)}`);
      return { old: m[1], new: m[2], ref: m[3] };
    });
}

/**
 * The policy for pushes from a project's VM, in phase 1: the agent's own branches (the ones it created on GitHub
 * through this project's relay) and new ones are pushed on, force-pushes and deletions included. Everything else is
 * refused, with what to do instead: the default branch, tags, and branches someone else created. One refused ref
 * refuses the whole push, as nothing is pushed on until all of it may be.
 */
export function decide(updates: RefUpdate[], pusher: Pusher, ctx: { defaultBranch?: string; createdBy(branch: string): string | undefined }): PushDecision {
  const reasons: string[] = [];
  const branches: Extract<PushDecision, { allowed: true }>["branches"] = [];
  for (const u of updates) {
    if (!u.ref.startsWith("refs/heads/")) {
      reasons.push(`${u.ref}: Kumiko doesn't push ${u.ref.startsWith("refs/tags/") ? "tags" : "refs other than branches"} to GitHub.`);
      continue;
    }
    const branch = u.ref.slice("refs/heads/".length);
    const created = ZERO.test(u.old);
    const deleted = ZERO.test(u.new);
    if (branch === ctx.defaultBranch) {
      reasons.push(`${branch} is the default branch. It changes only when the user approves delivering a branch to it: push your work to a branch of its own.`);
      continue;
    }
    const owner = ctx.createdBy(branch);
    if (!created && owner !== pusher.project) {
      reasons.push(
        owner
          ? `${branch} was created from another project's sandbox, so this one can't change it. Push your work to a branch of its own.`
          : `${branch} wasn't created from this sandbox, so Kumiko won't change it. Push your work to a branch of its own.`,
      );
      continue;
    }
    branches.push({ branch, update: u, created, deleted });
  }
  return reasons.length ? { allowed: false, reasons } : { allowed: true, branches };
}

/** Where git keeps a push's new objects until its hook says yes: GitHub's push must read them from there. */
export interface Quarantine {
  objectDirectory?: string;
  alternates?: string;
  quarantinePath?: string;
}

/**
 * Pushes the allowed updates on to GitHub's URL, all or nothing, each with a lease on what the mirror had: a new
 * branch must not exist there yet, and an existing one must still be where the mirror last saw it. To the URL, not to
 * origin: pushing to a remote's name also updates its tracking refs in the mirror, which the quarantine forbids.
 * Resolves with git's output; rejects with it if GitHub refused.
 */
export function pushToGitHub(dir: string, url: string, updates: RefUpdate[], q: Quarantine, timeoutMs = 10 * 60_000): Promise<string> {
  const args = ["push", "--atomic", "--porcelain", "--no-verify"];
  for (const u of updates) args.push(`--force-with-lease=${u.ref}:${ZERO.test(u.old) ? "" : u.old}`);
  // No "+": the leases are what allows a force-push, and only from where the mirror saw the branch.
  args.push(url, ...updates.map((u) => `${ZERO.test(u.new) ? "" : u.new}:${u.ref}`));
  const env: NodeJS.ProcessEnv = { ...gitEnv(), GIT_DIR: dir };
  if (q.objectDirectory) env.GIT_OBJECT_DIRECTORY = q.objectDirectory;
  if (q.alternates) env.GIT_ALTERNATE_OBJECT_DIRECTORIES = q.alternates;
  if (q.quarantinePath) env.GIT_QUARANTINE_PATH = q.quarantinePath;
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: dir, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stderr}${stdout}`;
      if (err) reject(Object.assign(new Error(out.trim() || err.message), { output: out }));
      else resolve(out);
    });
  });
}

/** What git and GitHub said, as lines for the agent: GitHub's own lines without the "remote: " git put before them. */
export function githubLines(output: string): string[] {
  return output
    .split("\n")
    .map((l) => l.replace(/\r$/, "").replace(/^remote: ?/, ""))
    .filter((l) => l.trim() && !/^(To |Done$|Enumerating|Counting|Compressing|Writing|Total |Delta )/.test(l) && !/^[ *+=!-]\t/.test(l));
}

export interface PushOptions {
  /** The socket the mirrors' hooks reach Kumiko on. */
  socket: string;
  mirrors: Mirrors;
  /** Who a relay connection is, as the relay recorded it when it started the git daemon. */
  connection(id: string): Pusher | undefined;
  /** Called after GitHub accepted a push. */
  onPushed?(pusher: Pusher, branches: string[]): void;
}

/**
 * Answers the mirrors' pre-receive hooks, on a socket of Kumiko's that only the user can reach: decides each push from
 * a project's VM, pushes what is allowed on to GitHub, and tells the hook what to print and how to exit.
 */
export class Pushes {
  private server?: Server;

  constructor(private readonly opts: PushOptions) {}

  async start(): Promise<void> {
    await mkdir(dirname(this.opts.socket), { recursive: true, mode: 0o700 });
    await rm(this.opts.socket, { force: true });
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.opts.socket, () => resolve());
    });
    await chmod(this.opts.socket, 0o600);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server?.closeAllConnections();
    await rm(this.opts.socket, { force: true }).catch(() => {});
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    const say = (line: string) => res.write(`${line.replace(/\n/g, " ")}\n`);
    const end = (code: number) => res.end(`kumiko-exit ${code}\n`);
    if (req.method !== "POST" || req.url !== "/pre-receive") {
      say("Kumiko: the hook asked for something Kumiko doesn't answer.");
      return end(1);
    }
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const pusher = this.opts.connection(String(req.headers["x-kumiko-connection"] ?? ""));
      if (!pusher) {
        say("Kumiko: this push didn't come through a relay Kumiko knows, so it isn't allowed.");
        return end(1);
      }
      const updates = parseUpdates(Buffer.concat(chunks).toString("utf8"));
      const dir = this.opts.mirrors.path(pusher.repo);
      const defaultBranch = await headBranch(dir);
      const decision = decide(updates, pusher, { defaultBranch, createdBy: (b) => this.opts.mirrors.createdBy(pusher.repo, b) });
      if (!decision.allowed) {
        for (const r of decision.reasons) say(`Kumiko: ${r}`);
        say("Kumiko: nothing was pushed.");
        return end(1);
      }
      if (!decision.branches.length) return end(0);
      const header = (name: string) => {
        const v = req.headers[name];
        return typeof v === "string" && v ? v : undefined;
      };
      const quarantine: Quarantine = {
        objectDirectory: header("x-git-object-directory"),
        alternates: header("x-git-alternate-object-directories"),
        quarantinePath: header("x-git-quarantine-path"),
      };
      let output: string;
      try {
        output = await pushToGitHub(dir, this.opts.mirrors.url(pusher.repo), decision.branches.map((b) => b.update), quarantine);
      } catch (err) {
        for (const l of githubLines((err as { output?: string }).output ?? String(err))) say(l);
        say("Kumiko: GitHub refused the push, so nothing was pushed. If a branch moved on GitHub, fetch and try again.");
        return end(1);
      }
      for (const l of githubLines(output)) say(l);
      await this.opts.mirrors.noteBranches(pusher.repo, pusher.project, decision.branches.map((b) => ({ branch: b.branch, deleted: b.deleted })));
      for (const b of decision.branches) say(`Kumiko: ${b.deleted ? "deleted" : "pushed"} ${b.branch} ${b.deleted ? "on" : "to"} GitHub (${pusher.repo}).`);
      this.opts.onPushed?.(pusher, decision.branches.map((b) => b.branch));
      end(0);
    } catch (err) {
      say(`Kumiko: ${err instanceof Error ? err.message : String(err)}`);
      end(1);
    }
  }
}

/** The mirror's default branch: where its HEAD points, as GitHub's does. */
export function headBranch(dir: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: dir, env: { ...gitEnv(), GIT_DIR: dir } }, (err, stdout) => resolve(err ? undefined : stdout.trim() || undefined));
  });
}
