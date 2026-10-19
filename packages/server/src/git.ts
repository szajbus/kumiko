import { execFile } from "node:child_process";
import type { WorktreeStatus, WorktreesResponse } from "@bentomo/shared";

const TIMEOUT_MS = 10_000;

export class GitError extends Error {}

/**
 * Runs git on the host, without a shell, so paths and branch names are only ever arguments or output.
 * GIT_OPTIONAL_LOCKS=0 keeps `status` from taking the index lock, which would race an agent committing in the VM.
 */
export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return reject(new GitError("git isn't installed on this machine, or isn't on PATH."));
        reject(new GitError(String(stderr).trim().split("\n")[0] || err.message));
      },
    );
  });
}

/** True when git exits 0; false when it exits with an error. */
const succeeds = (cwd: string, args: string[]) => git(cwd, args).then(() => true, () => false);

/**
 * Why `path` can't be a project's clone, or undefined if it can: it must be the top of a non-bare repository's
 * main working tree. A linked worktree has a `.git` file pointing elsewhere, so its git dir and common dir differ.
 */
export async function cloneProblem(path: string): Promise<string | undefined> {
  let out: string;
  try {
    out = await git(path, ["rev-parse", "--is-bare-repository", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"]);
  } catch (err) {
    if (err instanceof GitError && /not a git repository/i.test(err.message)) return `${path} is not a git repository.`;
    return err instanceof Error ? err.message : String(err);
  }
  const [bare, top, gitDir, commonDir] = out.split("\n");
  if (bare === "true") return `${path} is a bare repository; pick a clone with a working tree.`;
  if (top !== path) return `${path} is inside the repository at ${top}; pick its top folder.`;
  // --git-common-dir is relative to the cwd when it is the usual .git.
  const common = commonDir.startsWith("/") ? commonDir : `${path}/${commonDir}`;
  if (gitDir !== common.replace(/\/\.?$/, "")) return `${path} is a worktree of another clone; pick the main clone.`;
  return undefined;
}

interface Entry {
  path: string;
  head?: string;
  branch?: string;
  bare?: boolean;
  locked?: boolean;
  prunable?: boolean;
}

/** Parses `git worktree list --porcelain -z`: attributes split by NUL, worktrees by an empty one. */
export function parseWorktrees(out: string): Entry[] {
  const entries: Entry[] = [];
  let cur: Entry | undefined;
  for (const field of out.split("\0")) {
    if (!field) {
      cur = undefined;
      continue;
    }
    const space = field.indexOf(" ");
    const key = space < 0 ? field : field.slice(0, space);
    const value = space < 0 ? "" : field.slice(space + 1);
    if (key === "worktree") entries.push((cur = { path: value }));
    else if (!cur) continue;
    else if (key === "HEAD") cur.head = value;
    else if (key === "branch") cur.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "bare") cur.bare = true;
    else if (key === "locked") cur.locked = true;
    else if (key === "prunable") cur.prunable = true;
  }
  return entries;
}

/** The remote branch the project merges into: origin's HEAD, else origin/main or origin/master. */
async function defaultBranch(clone: string): Promise<string | undefined> {
  const head = await git(clone, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).then((s) => s.trim(), () => "");
  if (head) return head;
  for (const b of ["origin/main", "origin/master"]) {
    if (await succeeds(clone, ["rev-parse", "--verify", "--quiet", `refs/remotes/${b}`])) return b;
  }
  return undefined;
}

/** The commit a branch was created at, from its reflog's oldest entry; undefined once the reflog has expired. */
async function createdAt(cwd: string, branch: string): Promise<string | undefined> {
  const log = await git(cwd, ["log", "--walk-reflogs", "--format=%H", `refs/heads/${branch}`, "--"]).catch(() => "");
  return log.trim().split("\n").at(-1) || undefined;
}

async function status(e: Entry, main: boolean, base: string | undefined): Promise<WorktreeStatus> {
  const w: WorktreeStatus = { path: e.path, branch: e.branch, head: e.head, main, dirty: false, unpushed: 0, merged: false };
  if (e.locked) w.locked = true;
  if (e.prunable) {
    w.prunable = true;
    return w;
  }
  try {
    const [porcelain, upstream] = await Promise.all([
      git(e.path, ["status", "--porcelain", "--untracked-files=normal"]),
      e.branch ? git(e.path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).then((s) => s.trim(), () => "") : Promise.resolve(""),
    ]);
    w.dirty = porcelain.trim().length > 0;
    if (upstream) w.upstream = upstream;
    // Without an upstream, what counts is whether the commits are on any remote at all.
    const range = upstream ? ["@{upstream}..HEAD"] : ["HEAD", "--not", "--remotes"];
    w.unpushed = Number((await git(e.path, ["rev-list", "--count", ...range])).trim()) || 0;
    // The default branch isn't "merged" into itself, and a branch still where it was created has nothing in it yet:
    // contained in the default branch, but because nothing was committed, not because it was merged.
    const isBase = base !== undefined && e.branch === base.slice(base.indexOf("/") + 1);
    if (base && !main && !isBase && e.head && !(e.branch && (await createdAt(e.path, e.branch)) === e.head)) {
      w.merged = await succeeds(e.path, ["merge-base", "--is-ancestor", "HEAD", base]);
    }
  } catch (err) {
    w.error = err instanceof Error ? err.message : String(err);
  }
  return w;
}

/**
 * Every worktree of the clone, the clone first, with what needs attention: uncommitted changes, unpushed commits,
 * and whether it is merged into the remote's default branch. Remote branches are as of the last fetch; nothing is fetched.
 */
export async function worktreeStatuses(clone: string): Promise<WorktreesResponse> {
  const [list, base] = await Promise.all([git(clone, ["worktree", "list", "--porcelain", "-z"]), defaultBranch(clone)]);
  const entries = parseWorktrees(list).filter((e) => !e.bare);
  const worktrees = await Promise.all(entries.map((e) => status(e, e.path === clone, base)));
  return base ? { worktrees, defaultBranch: base } : { worktrees };
}
