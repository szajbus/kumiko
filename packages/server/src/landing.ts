import { execFile } from "node:child_process";
import type { CardCommit, CardFile, CardFlag, CardPr, DeliverCard, DeliverMethod } from "@kumiko/shared";
import { gitEnv } from "./mirrors.js";
import { headBranch } from "./pushes.js";

/** Something the agent has to fix before there is anything to show the user; the message says what. */
export class NotDeliverable extends Error {}

/** git in a mirror, with the user's environment and global config: their identity and signing key. */
export function mirrorGit(dir: string, args: string[], opts: { input?: string; timeoutMs?: number; ok?: number[] } = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", args, { cwd: dir, env: { ...gitEnv(), GIT_DIR: dir }, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 64 * 1024 * 1024 }, (err, out, errOut) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : -1) : 0;
      if (code === 0 || opts.ok?.includes(code)) resolve({ code, out: String(out), err: String(errOut) });
      else reject(new Error(String(errOut).trim() || (err as Error).message));
    });
    if (opts.input !== undefined) child.stdin!.end(opts.input);
  });
}

const rev = (dir: string, ref: string) => mirrorGit(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { ok: [1] }).then((r) => (r.code === 0 ? r.out.trim() : undefined));

/** A Co-Authored-By trailer naming Claude, as Claude Code writes it. */
const CLAUDE_TRAILER = /^co-authored-by:\s*claude\b/i;

/** Whether `branch` is a name Kumiko passes to git as a branch: no options, no ref syntax. */
export function isBranchName(branch: string): boolean {
  return /^[A-Za-z0-9._/-]{1,200}$/.test(branch) && !branch.startsWith("-") && !branch.startsWith("/") && !branch.endsWith("/") && !branch.endsWith(".lock") && !branch.includes("..") && !branch.includes("//");
}

/** What the card shows of a branch, all from the mirror, which is fetched first: commits, files, flags, the merge check. */
export async function deliverFacts(dir: string, branch: string, identityEmail: string | undefined): Promise<Omit<DeliverCard, "kind" | "repo" | "pr" | "title" | "body" | "route" | "method" | "signs">> {
  if (!isBranchName(branch)) throw new NotDeliverable(`"${branch}" isn't a branch name Kumiko delivers.`);
  const base = await headBranch(dir);
  if (!base) throw new NotDeliverable("The repository's mirror has no default branch yet.");
  if (branch === base) throw new NotDeliverable(`${base} is the branch work is delivered to. Deliver a branch made for the work.`);
  const head = await rev(dir, `refs/heads/${branch}`);
  if (!head) throw new NotDeliverable(`${branch} isn't on GitHub. Push it first (git push -u origin ${branch}), then call deliver again.`);
  const baseSha = (await rev(dir, `refs/heads/${base}`))!;
  const log = await mirrorGit(dir, ["log", "--reverse", "--no-color", "--format=%H%x00%s%x00%an%x00%ae%x00%(trailers:unfold,separator=%x01)%x1e", `${baseSha}..${head}`]);
  const commits: CardCommit[] = log.out
    .split("\x1e")
    .map((r) => r.replace(/^\n/, ""))
    .filter((r) => r.trim())
    .map((r) => {
      const [sha, subject, author, email, trailers] = r.split("\0");
      return { sha, subject, author, email, claude: (trailers ?? "").split("\x01").some((t) => CLAUDE_TRAILER.test(t.trim())) };
    });
  if (!commits.length) throw new NotDeliverable(`${branch} has no commits that aren't on ${base} already.`);
  await mergeTree(dir, baseSha, head, branch, base);
  const numstat = await mirrorGit(dir, ["diff", "--numstat", "-z", "--no-renames", `${baseSha}...${head}`]);
  const files: CardFile[] = [];
  const parts = numstat.out.split("\0").filter(Boolean);
  for (const p of parts) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(p);
    if (!m) continue;
    const path = m[3];
    files.push({ path, ...(m[1] === "-" ? {} : { added: Number(m[1]), deleted: Number(m[2]) }), ...(isCi(path) ? { flagged: true } : {}) });
  }
  const flags: CardFlag[] = [];
  for (const f of files.filter((f) => f.flagged)) flags.push({ rule: "ci", subject: f.path, why: "Changes under .github/ decide what CI runs, and with which secrets." });
  for (const c of commits) {
    if (identityEmail && c.email.toLowerCase() !== identityEmail.toLowerCase()) flags.push({ rule: "author", subject: `${c.sha.slice(0, 7)} ${c.subject}`, why: `The commit says it was authored by ${c.author} <${c.email}>, not you. Commits say what their maker wrote, so this is a hint, not a check.` });
    if (!c.claude) flags.push({ rule: "trailer", subject: `${c.sha.slice(0, 7)} ${c.subject}`, why: "It has no Co-Authored-By: Claude trailer, so it may not be Claude's." });
  }
  const trailers = await squashTrailers(dir, baseSha, head);
  return {
    branch,
    base,
    head,
    commits,
    files,
    added: files.reduce((n, f) => n + (f.added ?? 0), 0),
    deleted: files.reduce((n, f) => n + (f.deleted ?? 0), 0),
    flags,
    squashBody: commits.map((c) => `* ${c.subject}`).join("\n"),
    trailers,
  };
}

const isCi = (path: string) => path === ".github" || path.startsWith(".github/");

/** The Co-Authored-By trailers of the branch's commits, each once, in the order they first appear. */
async function squashTrailers(dir: string, base: string, head: string): Promise<string[]> {
  const r = await mirrorGit(dir, ["log", "--reverse", "--format=%(trailers:key=Co-authored-by,unfold,separator=%x01)%x1e", `${base}..${head}`]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of r.out.split(/[\x01\x1e\n]/).map((x) => x.trim()).filter(Boolean)) {
    const line = t.replace(/^co-authored-by:\s*/i, "Co-Authored-By: ");
    if (!seen.has(line.toLowerCase())) {
      seen.add(line.toLowerCase());
      out.push(line);
    }
  }
  return out;
}

/** Merges in memory; resolves with the tree, or throws NotDeliverable naming the conflicted files. */
async function mergeTree(dir: string, base: string, head: string, branch: string, baseName: string): Promise<string> {
  const r = await mirrorGit(dir, ["merge-tree", "--write-tree", "--name-only", "--no-messages", base, head], { ok: [1] });
  const lines = r.out.split("\n").filter(Boolean);
  if (r.code === 1) {
    const files = lines.slice(1);
    throw new NotDeliverable(
      `${branch} doesn't merge cleanly into ${baseName}${files.length ? ` (conflicts in ${files.slice(0, 10).join(", ")}${files.length > 10 ? `, and ${files.length - 10} more` : ""})` : ""}. Merge origin/${baseName} into it, resolve, push, and call deliver again.`,
    );
  }
  return lines[0];
}

/**
 * Whether Kumiko can sign with the user's key: their config names one, or signs every commit, or, with GPG (git's
 * default format), GPG has a secret key for their email, which is what `git commit-tree -S` uses when none is named.
 */
export async function signs(dir: string): Promise<boolean> {
  const get = async (key: string, type?: string) => {
    const r = await mirrorGit(dir, ["config", ...(type ? [`--type=${type}`] : []), "--get", key], { ok: [1] });
    return r.code === 0 ? r.out.trim() : "";
  };
  if (await get("user.signingkey")) return true;
  if ((await get("commit.gpgsign", "bool")) === "true") return true;
  const format = (await get("gpg.format")) || "openpgp";
  const email = await get("user.email");
  if (format !== "openpgp" || !email) return false;
  const gpg = (await get("gpg.openpgp.program")) || (await get("gpg.program")) || "gpg";
  return new Promise((resolve) => {
    execFile(gpg, ["--batch", "--with-colons", "--list-secret-keys", `<${email}>`], { env: gitEnv(), timeout: 10_000 }, (err, stdout) =>
      resolve(!err && /^sec:/m.test(String(stdout))),
    );
  });
}

/** The card's branch moved after it was shown. */
export class BranchMoved extends Error {
  constructor(readonly to: string, readonly commits: number) {
    super("The branch moved.");
  }
}

export interface Landed {
  sha: string;
  base: string;
  signed: boolean;
}

/**
 * Lands the card's branch on the default branch in the mirror and pushes it to GitHub: a merge commit or a squash,
 * signed with the user's key when their config has one. The branch must still be where the card had it. If the default
 * branch moves on GitHub meanwhile, the lease fails, and it is merged again once.
 */
export async function land(
  dir: string,
  url: string,
  opts: { branch: string; head: string; method: DeliverMethod; message: string; sign: boolean; fetch(): Promise<void> },
): Promise<Landed> {
  for (let attempt = 0; ; attempt++) {
    await opts.fetch();
    const base = await headBranch(dir);
    if (!base) throw new Error("The repository's mirror has no default branch.");
    const now = await rev(dir, `refs/heads/${opts.branch}`);
    if (now !== opts.head) {
      const count = now ? Number((await mirrorGit(dir, ["rev-list", "--count", `${opts.head}..${now}`], { ok: [128] })).out.trim()) || 0 : 0;
      throw new BranchMoved(now ?? "", count);
    }
    const baseSha = (await rev(dir, `refs/heads/${base}`))!;
    const tree = await mergeTree(dir, baseSha, opts.head, opts.branch, base);
    const parents = opts.method === "merge" ? ["-p", baseSha, "-p", opts.head] : ["-p", baseSha];
    const commit = await mirrorGit(dir, ["commit-tree", ...(opts.sign ? ["-S"] : []), tree, ...parents, "-F", "-"], { input: opts.message, timeoutMs: 5 * 60_000 });
    const sha = commit.out.trim();
    const push = await mirrorGit(dir, ["push", "--porcelain", `--force-with-lease=refs/heads/${base}:${baseSha}`, url, `${sha}:refs/heads/${base}`], { ok: [1], timeoutMs: 5 * 60_000 });
    if (push.code === 0) return { sha, base, signed: opts.sign };
    // Someone else landed something first: merge again on top of theirs, once.
    // Only for a lease that failed, not for GitHub refusing it outright (a protected branch, say).
    if (attempt === 0 && /stale info|fetch first/.test(push.out + push.err)) continue;
    throw new Error(`GitHub refused the push to ${base}: ${(push.err + push.out).trim().split("\n").filter((l) => l.trim()).slice(-3).join(" ")}`);
  }
}

/** Deletes a branch on GitHub, if it is still where it was landed from. */
export async function deleteBranch(dir: string, url: string, branch: string, head: string): Promise<boolean> {
  const r = await mirrorGit(dir, ["push", "--porcelain", `--force-with-lease=refs/heads/${branch}:${head}`, url, `:refs/heads/${branch}`], { ok: [1] });
  return r.code === 0;
}

/** The merge commit's message: GitHub's wording when the branch has a PR, so GitHub shows it merged. */
export function mergeMessage(repo: string, branch: string, pr?: CardPr): string {
  return pr ? `Merge pull request #${pr.number} from ${repo.split("/")[0]}/${branch}\n\n${pr.title}\n` : `Merge branch '${branch}'\n`;
}

/** The squash commit's message: the subject and body as the user left them, then the branch's co-author trailers. */
export function squashMessage(subject: string, body: string, trailers: string[]): string {
  const text = [subject.trim(), body.trim()].filter(Boolean).join("\n\n");
  const missing = trailers.filter((t) => !text.toLowerCase().includes(t.toLowerCase()));
  return `${text}${missing.length ? `\n\n${missing.join("\n")}` : ""}\n`;
}
