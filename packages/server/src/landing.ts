import { execFile } from "node:child_process";
import type { CardCommit, CardFile, CardFlag, CardPr, DeliverCard, DeliverMethod } from "@kumiko/shared";
import { gitEnv } from "./mirrors.js";
import { headBranch } from "./pushes.js";

/** Something the agent has to fix before there is anything to show the user; the message says what. */
export class NotDeliverable extends Error {}

/** git in a mirror, with the user's environment and global config: their identity and signing key. */
export function mirrorGit(dir: string, args: string[], opts: { input?: string; timeoutMs?: number; ok?: number[]; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", args, { cwd: dir, env: { ...gitEnv(), GIT_DIR: dir, ...opts.env }, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 64 * 1024 * 1024 }, (err, out, errOut) => {
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

/**
 * The branch work lands on: `wanted` if the agent named one, else the default branch. Either way it must be on GitHub,
 * where it lands, and the mirror's copy must be GitHub's: a base with pushes GitHub doesn't have is delivered first.
 */
export async function baseOf(dir: string, branch: string, wanted: string | undefined): Promise<{ base: string; baseSha: string }> {
  const def = await headBranch(dir);
  if (!def) throw new NotDeliverable("The repository's mirror has no default branch yet.");
  const base = wanted ?? def;
  if (!isBranchName(base)) throw new NotDeliverable(`"${base}" isn't a branch name Kumiko delivers to.`);
  if (branch === base) throw new NotDeliverable(`${base} is the branch work is delivered to. Deliver a branch made for the work.`);
  const baseSha = await rev(dir, `refs/github/heads/${base}`);
  if (!baseSha) throw new NotDeliverable(`${base} isn't on GitHub, so nothing can be delivered to it.${wanted ? ` Deliver ${base} first, or pick a base GitHub has.` : ""}`);
  const mirror = await rev(dir, `refs/heads/${base}`);
  if (mirror && mirror !== baseSha) throw new NotDeliverable(`${base} has commits in the mirror that GitHub doesn't have. Deliver ${base} first, then call deliver on ${branch} again.`);
  return { base, baseSha };
}

/**
 * What the card shows of a branch, all from the mirror, which is fetched first: commits, files, flags, the merge check.
 * Compared with `base`, the default branch unless the agent named another.
 */
export async function deliverFacts(dir: string, branch: string, identityEmail: string | undefined, wantedBase?: string): Promise<Omit<DeliverCard, "kind" | "repo" | "pr" | "title" | "body" | "route" | "method" | "signs" | "toSign" | "github" | "ahead" | "lost">> {
  if (!isBranchName(branch)) throw new NotDeliverable(`"${branch}" isn't a branch name Kumiko delivers.`);
  const { base, baseSha } = await baseOf(dir, branch, wantedBase);
  const head = await rev(dir, `refs/heads/${branch}`);
  if (!head) throw new NotDeliverable(`${branch} isn't pushed. Push it first (git push -u origin ${branch}), then call deliver again.`);
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

/** Whether a file is under .github/, which decides what CI runs, with the repository's secrets. */
export const isCi = (path: string) => path === ".github" || path.startsWith(".github/");

/**
 * Claude's Co-Authored-By trailers from the branch's commits, each once. Only Claude's: the commits are the agent's to
 * write, and anyone else they name would show on GitHub as a co-author of a commit the user signed.
 */
async function squashTrailers(dir: string, base: string, head: string): Promise<string[]> {
  const r = await mirrorGit(dir, ["log", "--reverse", "--format=%(trailers:key=Co-authored-by,unfold,separator=%x01)%x1e", `${base}..${head}`]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of r.out.split(/[\x01\x1e\n]/).map((x) => x.trim()).filter(Boolean)) {
    const line = t.replace(/^co-authored-by:\s*/i, "Co-Authored-By: ");
    if (!CLAUDE_TRAILER.test(line)) continue;
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
 * How Kumiko signs what it lands: with the key the user's git config names, or else, with GPG (git's default format),
 * with a usable key GPG has for their email, named exactly, so the card's promise and the signature come from the same
 * lookup. git's own fallback asks GPG for "name <email>", which a key whose user ID differs (a comment, another
 * spelling) doesn't match, and then fails. Undefined: Kumiko doesn't sign, even with commit.gpgsign on.
 */
export async function signingKey(dir: string): Promise<{ key?: string } | undefined> {
  const get = async (key: string) => {
    const r = await mirrorGit(dir, ["config", "--get", key], { ok: [1] });
    return r.code === 0 ? r.out.trim() : "";
  };
  if (await get("user.signingkey")) return {};
  const format = (await get("gpg.format")) || "openpgp";
  const email = (await get("committer.email")) || (await get("user.email"));
  if (format !== "openpgp" || !email) return undefined;
  // git reads gpg.program and gpg.openpgp.program as one setting: the last one set wins.
  const programs = await mirrorGit(dir, ["config", "--get-regexp", "^gpg\\.(openpgp\\.)?program$"], { ok: [1] });
  const gpg = programs.out.trim().split("\n").filter(Boolean).at(-1)?.replace(/^\S+\s+/, "") || "gpg";
  const out = await new Promise<string>((resolve) => {
    execFile(gpg, ["--batch", "--with-colons", "--fixed-list-mode", "--list-secret-keys", `<${email}>`], { env: gitEnv(), timeout: 10_000 }, (err, stdout) => resolve(err ? "" : String(stdout)));
  });
  const key = usableKey(out);
  return key ? { key } : undefined;
}

/**
 * The fingerprint of the first secret key in GPG's colon listing that can sign: not expired, revoked or disabled, and
 * able to sign, itself or through a subkey (a capital S).
 */
export function usableKey(colons: string): string | undefined {
  let candidate = false;
  for (const line of colons.split("\n")) {
    const f = line.split(":");
    if (f[0] === "sec") candidate = !["e", "r", "d", "i"].includes(f[1]) && (f[11] ?? "").includes("S") && !(f[14] ?? "").startsWith("#");
    else if (f[0] === "fpr" && candidate) return f[9] || undefined;
    else if (f[0] !== "fpr" && f[0] !== "grp") candidate = false;
  }
  return undefined;
}

/** Whether Kumiko will sign what it lands. */
export const signs = async (dir: string) => (await signingKey(dir)) !== undefined;

/** The commits `head` has that aren't on GitHub, in any branch of it, oldest first, parents before children. */
function unpublished(dir: string, head: string): Promise<string[]> {
  return mirrorGit(dir, ["rev-list", "--reverse", "--topo-order", head, "--not", "--glob=refs/github/heads/*"]).then((r) => r.out.split("\n").filter(Boolean));
}

/** A commit as git stores it: its headers, in order, and its message exactly. */
async function readCommit(dir: string, sha: string): Promise<{ headers: [string, string][]; message: string }> {
  const raw = (await mirrorGit(dir, ["cat-file", "commit", sha])).out;
  const split = raw.indexOf("\n\n");
  const head = split < 0 ? raw : raw.slice(0, split);
  const headers: [string, string][] = [];
  for (const line of head.split("\n")) {
    // A continuation line belongs to the header before it (a signature spans many).
    if (line.startsWith(" ") && headers.length) headers[headers.length - 1][1] += `\n${line.slice(1)}`;
    else {
      const sp = line.indexOf(" ");
      headers.push([line.slice(0, sp), line.slice(sp + 1)]);
    }
  }
  return { headers, message: split < 0 ? "" : raw.slice(split + 2) };
}

/** How many of the commits `head` has that aren't on GitHub carry no signature: what publishing it would sign. */
export async function unsignedCount(dir: string, head: string): Promise<number> {
  let n = 0;
  for (const sha of await unpublished(dir, head)) if (!(await readCommit(dir, sha)).headers.some(([k]) => k === "gpgsig" || k === "gpgsig-sha256")) n++;
  return n;
}

/** An identity line's parts, "Name <email> 1700000000 +0100", as git's environment takes them. */
function identity(line: string, who: "AUTHOR" | "COMMITTER"): NodeJS.ProcessEnv {
  const m = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!m) throw new Error(`A commit's ${who.toLowerCase()} can't be read: ${line.slice(0, 200)}`);
  return { [`GIT_${who}_NAME`]: m[1], [`GIT_${who}_EMAIL`]: m[2], [`GIT_${who}_DATE`]: `@${m[3]} ${m[4]}` };
}

/**
 * Signs the commits `head` has that aren't on GitHub with the user's key, in the mirror, changing nothing else: each
 * keeps its tree, author, committer, dates and message, so only the shas change. Commits already on GitHub are left
 * alone, whoever made them, and a commit already signed is kept as it is unless a parent of it changed. Resolves with
 * the new tip and how many commits were written, without moving any branch.
 */
export async function resign(dir: string, head: string, sign: { key?: string }): Promise<{ tip: string; signed: number }> {
  const mapped = new Map<string, string>();
  let signed = 0;
  for (const sha of await unpublished(dir, head)) {
    const { headers, message } = await readCommit(dir, sha);
    const get = (k: string) => headers.filter(([h]) => h === k).map(([, v]) => v);
    const parents = get("parent");
    const newParents = parents.map((p) => mapped.get(p) ?? p);
    const isSigned = get("gpgsig").length > 0 || get("gpgsig-sha256").length > 0;
    if (isSigned && newParents.every((p, i) => p === parents[i])) {
      mapped.set(sha, sha);
      continue;
    }
    const extra = headers.filter(([h]) => !["tree", "parent", "author", "committer", "gpgsig", "gpgsig-sha256"].includes(h));
    // commit-tree can't write other headers (an encoding, a merged tag): such a commit stays as it was.
    if (extra.length) {
      if (newParents.some((p, i) => p !== parents[i])) throw new Error(`Commit ${sha.slice(0, 7)} has headers Kumiko can't write again (${extra.map(([h]) => h).join(", ")}), so its branch can't be signed.`);
      mapped.set(sha, sha);
      continue;
    }
    const env = { ...identity(get("author")[0] ?? "", "AUTHOR"), ...identity(get("committer")[0] ?? "", "COMMITTER") };
    const out = await mirrorGit(dir, ["commit-tree", sign.key ? `-S${sign.key}` : "-S", get("tree")[0], ...newParents.flatMap((p) => ["-p", p]), "-F", "-"], { input: message, env, timeoutMs: 5 * 60_000 });
    mapped.set(sha, out.out.trim());
    signed++;
  }
  return { tip: mapped.get(head) ?? head, signed };
}

/** Whether git in the mirror has an author and committer to write a commit as: the user's config, or git's environment. */
export async function gitHasIdentity(dir: string): Promise<boolean> {
  const ok = (v: string) => mirrorGit(dir, ["var", v]).then(() => true, () => false);
  return (await ok("GIT_AUTHOR_IDENT")) && (await ok("GIT_COMMITTER_IDENT"));
}

/** The commits on GitHub's copy of a branch that the mirror's no longer has, as a card lists them. */
export interface LostCommit {
  sha: string;
  subject: string;
  /** Dropped: nothing in the branch makes its change. Changed: a commit with its subject does something else. */
  how: "dropped" | "changed";
}

/** Each commit's patch id, by sha: a fingerprint of the change it makes, the same after a rebase or a new signature. */
async function patchIds(dir: string, range: string[]): Promise<Map<string, string>> {
  const log = await mirrorGit(dir, ["log", "--no-merges", "-p", "--format=commit %H", ...range]);
  const ids = await mirrorGit(dir, ["patch-id", "--stable"], { input: log.out });
  const map = new Map<string, string>();
  for (const line of ids.out.split("\n").filter(Boolean)) {
    const [id, sha] = line.split(" ");
    map.set(sha, id);
  }
  return map;
}

/**
 * What publishing `local` over GitHub's copy of the branch, `github`, would lose: the commits there whose change the
 * new branch no longer makes. Compared by what commits change, not by sha, so a rebase or Kumiko's signing loses
 * nothing; and if the branch as a whole still makes every change GitHub's does (squashed, reordered), nothing either.
 */
export async function lostCommits(dir: string, github: string | undefined, local: string, base: string): Promise<LostCommit[]> {
  if (!github || github === local) return [];
  if ((await mirrorGit(dir, ["merge-base", "--is-ancestor", github, local], { ok: [1] })).code === 0) return [];
  // GitHub's changes all in the branch already: merging them in changes nothing.
  const merged = await mirrorGit(dir, ["merge-tree", "--write-tree", "--no-messages", local, github], { ok: [1] });
  const localTree = (await mirrorGit(dir, ["rev-parse", `${local}^{tree}`])).out.trim();
  if (merged.code === 0 && merged.out.split("\n")[0] === localTree) return [];
  const theirs = await patchIds(dir, [github, `^${local}`, `^${base}`]);
  const ours = await patchIds(dir, [local, `^${base}`]);
  const kept = new Set(ours.values());
  const subjects = async (range: string[]) => {
    const out = await mirrorGit(dir, ["log", "--no-merges", "--format=%H%x00%s", ...range]);
    return new Map(out.out.split("\n").filter(Boolean).map((l) => l.split("\0") as [string, string]));
  };
  const theirSubjects = await subjects([github, `^${local}`, `^${base}`]);
  const ourSubjects = new Set((await subjects([local, `^${base}`])).values());
  const lost: LostCommit[] = [];
  for (const [sha, subject] of [...theirSubjects].reverse()) {
    if (kept.has(theirs.get(sha) ?? "")) continue;
    lost.push({ sha, subject, how: ourSubjects.has(subject) ? "changed" : "dropped" });
  }
  return lost;
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
 * Lands the card's branch on its base (the default branch, or the one the agent named) in the mirror and pushes it to GitHub: a merge commit or a squash,
 * signed with the user's key when their config has one. The branch must still be where the card had it. If the default
 * branch moves on GitHub meanwhile, the lease fails, and it is merged again once. `as` is who the commit is by, when
 * git's config doesn't say.
 */
export async function land(
  dir: string,
  url: string,
  opts: {
    branch: string;
    /** What lands: the branch's commit the card showed, or the same commits signed on the way. */
    head: string;
    /** Where the branch must still be, if not at `head`: the commit the card showed, before Kumiko signed it. */
    check?: string;
    method: DeliverMethod;
    message: string;
    /** The branch it lands on, as the card showed it. */
    base: string;
    sign: { key?: string } | undefined;
    as?: { name: string; email: string };
    fetch(): Promise<void>;
  },
): Promise<Landed> {
  for (let attempt = 0; ; attempt++) {
    await opts.fetch();
    const { base, baseSha } = await baseOf(dir, opts.branch, opts.base);
    const now = await rev(dir, `refs/heads/${opts.branch}`);
    if (now !== opts.head && now !== opts.check) {
      const count = now ? Number((await mirrorGit(dir, ["rev-list", "--count", `${opts.check ?? opts.head}..${now}`], { ok: [128] })).out.trim()) || 0 : 0;
      throw new BranchMoved(now ?? "", count);
    }
    const tree = await mergeTree(dir, baseSha, opts.head, opts.branch, base);
    const parents = opts.method === "merge" ? ["-p", baseSha, "-p", opts.head] : ["-p", baseSha];
    // Not signing means not signing: commit.gpgsign would otherwise have git try the lookup that just found nothing.
    const sign = opts.sign ? [opts.sign.key ? `-S${opts.sign.key}` : "-S"] : ["--no-gpg-sign"];
    const as = opts.as ? { GIT_AUTHOR_NAME: opts.as.name, GIT_AUTHOR_EMAIL: opts.as.email, GIT_COMMITTER_NAME: opts.as.name, GIT_COMMITTER_EMAIL: opts.as.email } : {};
    const commit = await mirrorGit(dir, ["commit-tree", ...sign, tree, ...parents, "-F", "-"], { input: opts.message, env: as, timeoutMs: 5 * 60_000 });
    const sha = commit.out.trim();
    const push = await mirrorGit(dir, ["push", "--porcelain", `--force-with-lease=refs/heads/${base}:${baseSha}`, url, `${sha}:refs/heads/${base}`], { ok: [1], timeoutMs: 5 * 60_000 });
    if (push.code === 0) return { sha, base, signed: opts.sign !== undefined };
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
