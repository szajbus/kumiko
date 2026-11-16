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

/** Who is pushing: the sandbox whose VM the push came from, and the repository. */
export interface Pusher {
  sandbox: string;
  repo: string;
  /** The session the push was run from, as the VM said; never who may push. */
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
 * The policy for pushes from a sandbox's VM. A push goes into the mirror on the user's Mac and no further: nothing
 * reaches GitHub without a card. So the agent may create, update, force-push and delete any branch there, but the
 * default branch, which follows GitHub and changes only through a card, tags, and other refs are refused, with what to
 * do instead, as are names that differ from another branch's only in case. One refused ref refuses the whole push.
 */
export function decide(updates: RefUpdate[], ctx: { defaultBranch?: string; branches?: string[] }): PushDecision {
  const reasons: string[] = [];
  const branches: Extract<PushDecision, { allowed: true }>["branches"] = [];
  for (const u of updates) {
    if (!u.ref.startsWith("refs/heads/")) {
      reasons.push(`${u.ref}: the mirror takes only branches, not ${u.ref.startsWith("refs/tags/") ? "tags" : "other refs"}.`);
      continue;
    }
    const branch = u.ref.slice("refs/heads/".length);
    const twin = [ctx.defaultBranch, ...(ctx.branches ?? [])].find((b) => b !== undefined && b !== branch && b.toLowerCase() === branch.toLowerCase());
    if (twin) {
      reasons.push(`${branch} differs from ${twin} only in case, which the user's Mac takes for the same branch. Pick another name.`);
      continue;
    }
    if (branch === ctx.defaultBranch) {
      reasons.push(`${branch} is the default branch. It follows GitHub, and changes only when the user approves merging a branch into it: push your work to a branch of its own, and call the deliver tool.`);
      continue;
    }
    branches.push({ branch, update: u, created: ZERO.test(u.old), deleted: ZERO.test(u.new) });
  }
  return reasons.length ? { allowed: false, reasons } : { allowed: true, branches };
}

export interface PushOptions {
  /** The socket the mirrors' hooks reach Kumiko on. */
  socket: string;
  mirrors: Mirrors;
  /** Who a relay connection is, as the relay recorded it when it started the git daemon. */
  connection(id: string): Pusher | undefined;
}

/**
 * Answers the mirrors' pre-receive hooks, on a socket of Kumiko's that only the user can reach: decides each push from
 * a sandbox's VM into the mirror, and tells the hook what to print and how to exit. Nothing goes on to GitHub here.
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
      const { updates } = parseHookBody(Buffer.concat(chunks).toString("utf8"));
      const dir = this.opts.mirrors.path(pusher.repo);
      const branchNames = await new Promise<string[]>((resolve) =>
        execFile("git", ["for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads"], { cwd: dir, env: { ...gitEnv(), GIT_DIR: dir } }, (err, out) => resolve(err ? [] : String(out).split("\n").filter(Boolean))),
      );
      const decision = decide(updates, { defaultBranch: await headBranch(dir), branches: branchNames });
      if (!decision.allowed) {
        for (const r of decision.reasons) say(`Kumiko: ${r}`);
        say("Kumiko: nothing was pushed.");
        return end(1);
      }
      // New branches are this sandbox's: after landing one, Kumiko deletes it.
      const fresh = [];
      for (const b of decision.branches) if (b.created && !(await this.opts.mirrors.githubHead(pusher.repo, b.branch))) fresh.push({ branch: b.branch, deleted: false });
      await this.opts.mirrors.noteBranches(pusher.repo, pusher.sandbox, fresh);
      for (const b of decision.branches) {
        say(
          b.deleted
            ? `Kumiko: deleted ${b.branch} in the mirror on the user's computer. GitHub's ${b.branch}, if there is one, is untouched.`
            : `Kumiko: ${b.branch} is in the mirror on the user's computer, not on GitHub. To publish it, call the deliver tool.`,
        );
      }
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

/** Where git keeps a push's new objects until its hook says yes. */
export interface Quarantine {
  objectDirectory?: string;
  alternates?: string;
  quarantinePath?: string;
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
