import { execFile } from "node:child_process";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import type { CardFile, PushCard } from "@kumiko/shared";
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
  /** The session the push was run from, as the VM said; only where to ask, never who may push. */
  session?: string;
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
export function decide(
  updates: RefUpdate[],
  pusher: Pusher,
  ctx: {
    defaultBranch?: string;
    createdBy(branch: string): string | undefined;
    /** The project's branch was replaced on GitHub by a different one of the same name. */
    replaced?(branch: string): boolean;
    /** The branches there are, to catch a name that differs from one only in case, which macOS takes for the same. */
    branches?: string[];
  },
): PushDecision {
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
    const twin = [ctx.defaultBranch, ...(ctx.branches ?? [])].find((b) => b !== undefined && b !== branch && b.toLowerCase() === branch.toLowerCase());
    if (twin) {
      reasons.push(`${branch} differs from ${twin} only in case, which the user's Mac takes for the same branch. Pick another name.`);
      continue;
    }
    if (branch === ctx.defaultBranch) {
      reasons.push(`${branch} is the default branch. It changes only when the user approves delivering a branch to it: push your work to a branch of its own, and call the deliver tool.`);
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
    if (!created && ctx.replaced?.(branch)) {
      reasons.push(`${branch} on GitHub isn't the one this sandbox pushed any more: someone replaced it. Push your work to a branch of its own.`);
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

/** git in the mirror, seeing the objects of a push that waits in quarantine. */
function quarantineGit(dir: string, args: string[], q: Quarantine): Promise<{ code: number; out: string }> {
  const env: NodeJS.ProcessEnv = { ...gitEnv(), GIT_DIR: dir };
  if (q.objectDirectory) env.GIT_OBJECT_DIRECTORY = q.objectDirectory;
  if (q.alternates) env.GIT_ALTERNATE_OBJECT_DIRECTORIES = q.alternates;
  return new Promise((resolve) => {
    execFile("git", args, { cwd: dir, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve({ code: err ? 1 : 0, out: String(stdout) }));
  });
}

/** The tree `.github` has at `rev`; undefined when it has none. */
export async function ciTree(dir: string, rev: string, q: Quarantine = {}): Promise<string | undefined> {
  const r = await quarantineGit(dir, ["rev-parse", "--verify", "--quiet", `${rev}:.github`], q);
  return r.code === 0 ? r.out.trim() || undefined : undefined;
}

/** What a push changes under .github/ compared with the default branch, as the card shows it. */
export async function ciPushCard(dir: string, repo: string, base: string, update: RefUpdate, q: Quarantine): Promise<PushCard> {
  const branch = update.ref.slice("refs/heads/".length);
  const created = ZERO.test(update.old);
  const numstat = await quarantineGit(dir, ["diff", "--numstat", "--no-renames", `refs/heads/${base}...${update.new}`, "--", ".github"], q);
  const files: CardFile[] = numstat.out.split("\n").filter(Boolean).map((l) => {
    const [a, d, ...path] = l.split("\t");
    return { path: path.join("\t"), ...(a === "-" ? {} : { added: Number(a), deleted: Number(d) }), flagged: true };
  });
  const count = await quarantineGit(dir, ["rev-list", "--count", update.new, created ? `^refs/heads/${base}` : `^${update.old}`], q);
  const ff = created || (await quarantineGit(dir, ["merge-base", "--is-ancestor", update.old, update.new], q)).code === 0;
  return { kind: "push", repo, branch, ...(created ? {} : { old: update.old }), new: update.new, fastForward: ff, commits: Number(count.out.trim()) || 0, files, base };
}

/** The user's answer to a push that waits for them: allowed, or refused with what git in the VM shows. */
export type PushAnswer = { allowed: true } | { allowed: false; message: string };

export interface PushOptions {
  /** The socket the mirrors' hooks reach Kumiko on. */
  socket: string;
  mirrors: Mirrors;
  /** Who a relay connection is, as the relay recorded it when it started the git daemon. */
  connection(id: string): Pusher | undefined;
  /** Called after GitHub accepted a push. */
  onPushed?(pusher: Pusher, branches: string[]): void;
  /**
   * Asks the user about a push that changes CI, while git in the VM waits: resolves with their answer. `done` is told
   * how the push went once it was allowed.
   */
  askCi?(pusher: Pusher, connection: string, card: PushCard): { answer: Promise<PushAnswer>; done(ok: boolean, text: string): void };
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
    // Hooks still waiting (on GitHub, or on the user) are cut off rather than waited for: their pushes are refused.
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
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
      const { quarantine, updates } = parseHookBody(Buffer.concat(chunks).toString("utf8"));
      const dir = this.opts.mirrors.path(pusher.repo);
      const defaultBranch = await headBranch(dir);
      const branchNames = (await quarantineGit(dir, ["for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads"], {})).out.split("\n").filter(Boolean);
      // A branch the project pushed, whose tip on GitHub doesn't come from what it pushed last, is someone else's now.
      const replaced = new Set<string>();
      for (const u of updates) {
        const branch = u.ref.replace(/^refs\/heads\//, "");
        const last = this.opts.mirrors.lastPushed(pusher.repo, branch);
        if (!last || ZERO.test(u.old) || last === u.old || this.opts.mirrors.createdBy(pusher.repo, branch) !== pusher.project) continue;
        if ((await quarantineGit(dir, ["merge-base", "--is-ancestor", last, u.old], {})).code !== 0) replaced.add(branch);
      }
      const decision = decide(updates, pusher, {
        defaultBranch,
        createdBy: (b) => this.opts.mirrors.createdBy(pusher.repo, b),
        replaced: (b) => replaced.has(b),
        branches: branchNames,
      });
      if (!decision.allowed) {
        for (const r of decision.reasons) say(`Kumiko: ${r}`);
        say("Kumiko: nothing was pushed.");
        return end(1);
      }
      if (!decision.branches.length) return end(0);

      // GitHub runs a branch's own workflows on push, with the repository's secrets: a push whose .github differs from
      // the default branch's, in a way the user hasn't allowed for this branch, waits for them.
      const connection = String(req.headers["x-kumiko-connection"]);
      const ci = new Map<string, string>();
      const asked: ReturnType<NonNullable<PushOptions["askCi"]>>[] = [];
      // What CI runs on the default branch now, not at the last fetch: a workflow removed there since still counts.
      await this.opts.mirrors.fetch(pusher.repo).catch(() => {});
      const baseTree = defaultBranch ? await ciTree(dir, `refs/heads/${defaultBranch}`) : undefined;
      for (const b of decision.branches) {
        if (b.deleted) continue;
        const tree = await ciTree(dir, b.update.new, quarantine);
        if (tree === baseTree || this.opts.mirrors.ciAllowed(pusher.repo, b.branch) === (tree ?? "none")) continue;
        if (!this.opts.askCi || !defaultBranch) {
          say(`Kumiko: ${b.branch} changes .github/, which decides what CI runs with the repository's secrets, and Kumiko can't ask the user about it here. Nothing was pushed.`);
          return end(1);
        }
        const card = await ciPushCard(dir, pusher.repo, defaultBranch, b.update, quarantine);
        say(`Kumiko: ${b.branch} changes ${card.files.map((f) => f.path).join(", ") || ".github/"}, which decides what CI runs with the repository's secrets.`);
        say("Kumiko: waiting for the user to allow it in Kumiko…");
        const ask = this.opts.askCi(pusher, connection, card);
        asked.push(ask);
        const answer = await ask.answer;
        if (!answer.allowed) {
          for (const a of asked.slice(0, -1)) a.done(false, "Another branch in the same push wasn't allowed");
          say(`Kumiko: ${answer.message}`);
          say("Kumiko: nothing was pushed.");
          return end(1);
        }
        ci.set(b.branch, tree ?? "none");
      }
      let output: string;
      try {
        output = await pushToGitHub(dir, this.opts.mirrors.url(pusher.repo), decision.branches.map((b) => b.update), quarantine);
      } catch (err) {
        for (const l of githubLines((err as { output?: string }).output ?? String(err))) say(l);
        say("Kumiko: GitHub refused the push, so nothing was pushed. If a branch moved on GitHub, fetch and try again.");
        for (const a of asked) a.done(false, "GitHub refused the push");
        return end(1);
      }
      for (const l of githubLines(output)) say(l);
      await this.opts.mirrors.noteBranches(pusher.repo, pusher.project, decision.branches.map((b) => ({ branch: b.branch, deleted: b.deleted, sha: b.update.new, ...(ci.has(b.branch) ? { ci: ci.get(b.branch) } : {}) })));
      for (const a of asked) a.done(true, "Pushed to GitHub, with its CI change");
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
  // The full ref, cut here: --short would say "heads/main" if a tag were called main too.
  return new Promise((resolve) => {
    execFile("git", ["symbolic-ref", "--quiet", "HEAD"], { cwd: dir, env: { ...gitEnv(), GIT_DIR: dir } }, (err, stdout) => {
      const ref = stdout.trim();
      resolve(!err && ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) || undefined : undefined);
    });
  });
}

/**
 * What the hook sends: where the push's objects wait, one "name value" line each, then an empty line, then git's ref
 * updates. In the body, not in headers, so paths with any characters in them come through as they are.
 */
export function parseHookBody(text: string): { quarantine: Quarantine; updates: RefUpdate[] } {
  const split = text.indexOf("\n\n");
  const head = split < 0 ? "" : text.slice(0, split);
  const quarantine: Quarantine = {};
  for (const line of head.split("\n")) {
    const sp = line.indexOf(" ");
    const [name, value] = sp < 0 ? [line, ""] : [line.slice(0, sp), line.slice(sp + 1)];
    if (!value) continue;
    if (name === "object-directory") quarantine.objectDirectory = value;
    else if (name === "alternates") quarantine.alternates = value;
    else if (name === "quarantine") quarantine.quarantinePath = value;
  }
  return { quarantine, updates: parseUpdates(split < 0 ? text : text.slice(split + 2)) };
}
