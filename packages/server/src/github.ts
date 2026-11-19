import { execFile } from "node:child_process";
import { parseRepo, type CloseReason, type GitHubAccount, type GitHubRepo } from "@kumiko/shared";

/** gh failed to run, or said something Kumiko can't read. */
export class GhError extends Error {}

/** gh isn't installed, or isn't on PATH. */
export class GhMissing extends GhError {
  constructor() {
    super("The GitHub CLI, gh, isn't installed on this Mac, or isn't on Kumiko's PATH.");
  }
}

interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Where avatars may come from: a URL gh hands back is shown in the window, so only GitHub's own image host. */
const AVATAR_HOSTS = ["avatars.githubusercontent.com"];

/** Each repo as one JSON line: `@json` makes it a string, which gh prints raw, so a description can't break a line. */
const REPO_FIELDS = ".[] | {full_name, private, fork, archived, description, pushed_at} | @json";

/**
 * The GitHub CLI on the host: who it is signed in as, and the repos it can see. It is the user's own login: Kumiko
 * never signs it in or out, and never hands its token to anything.
 */
export class GitHub {
  constructor(private readonly opts: { gh?: string; timeoutMs?: number } = {}) {}

  private get gh(): string {
    return this.opts.gh ?? process.env.KUMIKO_GH ?? "gh";
  }

  /** Runs gh without a shell; resolves with its exit code, and rejects only when it can't run at all. */
  private run(args: string[], timeoutMs = this.opts.timeoutMs ?? 30_000, input?: string): Promise<GhResult> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.gh,
        args,
        // No prompts, update notices or colours: gh's output is read, not shown to a terminal.
        { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1", CLICOLOR: "0" } },
        (err, stdout, stderr) => {
          const code = (err as NodeJS.ErrnoException | null)?.code;
          if (code === "ENOENT") return reject(new GhMissing());
          if (err && typeof code !== "number") return reject(new GhError(`gh ${args[0]} failed: ${err.message}`));
          resolve({ code: typeof code === "number" ? code : 0, stdout: String(stdout), stderr: String(stderr) });
        },
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(input ?? "");
    });
  }

  /** Who gh is signed in to github.com as; never rejects. */
  async account(): Promise<GitHubAccount> {
    let status: GhResult;
    try {
      status = await this.run(["auth", "status", "--hostname", "github.com"]);
    } catch (err) {
      if (err instanceof GhMissing) return { status: "missing" };
      return { status: "error", detail: err instanceof Error ? err.message : String(err) };
    }
    // Older gh prints its status on stderr, newer on stdout.
    if (status.code !== 0) return { status: "signed-out", detail: firstLines(status.stderr || status.stdout) };
    const user = await this.run(["api", "user", "--jq", "{id, login, name, avatar_url} | @json"]).catch((err: Error) => ({ code: -1, stdout: "", stderr: err.message }));
    if (user.code !== 0) return { status: "error", detail: firstLines(user.stderr) || `gh api user exited with ${user.code}.` };
    try {
      const u = JSON.parse(user.stdout.trim()) as { id?: unknown; login?: unknown; name?: unknown; avatar_url?: unknown };
      if (typeof u.login !== "string" || !u.login) throw new Error("no login");
      return { status: "signed-in", login: u.login, ...(typeof u.id === "number" ? { id: u.id } : {}), ...(typeof u.name === "string" && u.name ? { name: u.name } : {}), ...avatar(u.avatar_url) };
    } catch {
      return { status: "error", detail: "gh api user answered with something Kumiko can't read." };
    }
  }

  /** Every repo gh's account can see, its own and its organizations', most recently pushed first. */
  async repos(): Promise<GitHubRepo[]> {
    const r = await this.run(["api", "--paginate", "/user/repos?per_page=100&sort=pushed", "--jq", REPO_FIELDS], 120_000);
    if (r.code !== 0) throw new GhError(firstLines(r.stderr) || `gh api /user/repos exited with ${r.code}.`);
    const repos: GitHubRepo[] = [];
    for (const line of r.stdout.split("\n")) {
      if (!line.trim()) continue;
      let x: Record<string, unknown>;
      try {
        x = JSON.parse(line) as Record<string, unknown>;
      } catch {
        throw new GhError("gh api /user/repos answered with something Kumiko can't read.");
      }
      // Only names Kumiko could make a mirror of; GitHub's own are all of that shape.
      if (!parseRepo(x.full_name)) continue;
      repos.push({
        repo: x.full_name as string,
        private: x.private === true,
        fork: x.fork === true,
        archived: x.archived === true,
        ...(typeof x.description === "string" && x.description ? { description: x.description } : {}),
        ...(typeof x.pushed_at === "string" ? { pushedAt: x.pushed_at } : {}),
      });
    }
    return repos.sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""));
  }

  /** Runs gh and parses what it prints as JSON; rejects with gh's message when it fails. */
  private async json<T>(args: string[], what: string): Promise<T> {
    const r = await this.run(args, 60_000);
    if (r.code !== 0) throw new GhError(firstLines(r.stderr) || `gh ${what} exited with ${r.code}.`);
    try {
      return JSON.parse(r.stdout) as T;
    } catch {
      throw new GhError(`gh ${what} answered with something Kumiko can't read.`);
    }
  }

  /** The open pull request from `branch` in `repo` itself (one origin, no forks), if there is one. */
  async prForBranch(repo: string, branch: string): Promise<{ number: number; title: string; url: string; base?: string } | undefined> {
    const prs = await this.json<{ number: number; title: string; url: string; baseRefName?: string; headRepositoryOwner?: { login?: string } }[]>(
      ["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "number,title,url,baseRefName,headRepositoryOwner", "--limit", "10"],
      "pr list",
    );
    const owner = repo.split("/")[0].toLowerCase();
    const pr = prs.find((p) => !p.headRepositoryOwner?.login || p.headRepositoryOwner.login.toLowerCase() === owner);
    return pr && { number: pr.number, title: pr.title, url: pr.url, ...(pr.baseRefName ? { base: pr.baseRefName } : {}) };
  }

  /** Opens a pull request as the user; resolves with its number and URL. The body goes on stdin, never as an argument. */
  async prCreate(repo: string, opts: { base: string; head: string; title: string; body: string }): Promise<{ number: number; url: string }> {
    const r = await this.run(["pr", "create", "--repo", repo, "--base", opts.base, "--head", opts.head, "--title", opts.title, "--body-file", "-"], 60_000, opts.body);
    if (r.code !== 0) throw new GhError(firstLines(r.stderr) || `gh pr create exited with ${r.code}.`);
    return prUrl(r.stdout);
  }

  /** An issue or a PR, with its comments, as Kumiko gives it to the agent; undefined when there is no such one. */
  async item(repo: string, type: "issue" | "pr", number: number): Promise<GitHubItem | undefined> {
    const fields = type === "pr" ? `${ITEM_FIELDS},headRefName,baseRefName,files,reviews` : ITEM_FIELDS;
    const r = await this.run([type, "view", String(number), "--repo", repo, "--json", fields], 60_000);
    if (r.code !== 0) {
      if (/could not resolve|not found/i.test(r.stderr)) return undefined;
      throw new GhError(firstLines(r.stderr) || `gh ${type} view exited with ${r.code}.`);
    }
    try {
      return JSON.parse(r.stdout) as GitHubItem;
    } catch {
      throw new GhError(`gh ${type} view answered with something Kumiko can't read.`);
    }
  }

  /** Issues or PRs, newest first. */
  async items(repo: string, type: "issue" | "pr", opts: { state: "open" | "closed" | "all"; search?: string; limit: number }): Promise<GitHubItem[]> {
    const fields = type === "pr" ? "number,title,state,author,labels,updatedAt,url,headRefName" : "number,title,state,author,labels,updatedAt,url";
    return this.json<GitHubItem[]>([type, "list", "--repo", repo, "--state", opts.state, ...(opts.search ? ["--search", opts.search] : []), "--limit", String(opts.limit), "--json", fields], `${type} list`);
  }

  /** The repository's labels: the only ones Claude's issues may have. */
  async labels(repo: string): Promise<{ name: string; color?: string; description?: string }[]> {
    return this.json<{ name: string; color?: string; description?: string }[]>(["label", "list", "--repo", repo, "--limit", "500", "--json", "name,color,description"], "label list");
  }

  /**
   * A GET of GitHub's REST API as the user, for a path Kumiko checked is the repo's own (see actions.ts). Resolves with
   * the response's body; a status GitHub refused with resolves too, with its message, since that is an answer the agent
   * reads.
   */
  async apiGet(path: string): Promise<{ ok: true; body: string } | { ok: false; message: string }> {
    const r = await this.run(["api", "--method", "GET", path], 60_000);
    if (r.code === 0) return { ok: true, body: r.stdout };
    const said = firstLines(r.stderr).replace(/^gh: /, "");
    if (!said) throw new GhError(`gh api exited with ${r.code}.`);
    return { ok: false, message: said };
  }

  /** A GitHub Actions run, with its jobs and their steps; undefined when there is no such run. */
  async workflowRun(repo: string, id: number, attempt?: number): Promise<WorkflowRun | undefined> {
    const r = await this.run(["run", "view", String(id), "--repo", repo, ...(attempt ? ["--attempt", String(attempt)] : []), "--json", RUN_FIELDS], 60_000);
    if (r.code !== 0) {
      if (/not found|could not find|404/i.test(r.stderr)) return undefined;
      throw new GhError(firstLines(r.stderr) || `gh run view exited with ${r.code}.`);
    }
    try {
      return JSON.parse(r.stdout) as WorkflowRun;
    } catch {
      throw new GhError("gh run view answered with something Kumiko can't read.");
    }
  }

  /**
   * A run's logs as gh prints them, a line each: job, step and the line, tab-separated. Only the failed steps' with
   * `failed`; only one job's with `job`. Resolves with gh's message instead when it can't give them, as for a run still
   * going.
   */
  async runLog(repo: string, id: number, opts: { failed: boolean; job?: number; attempt?: number }): Promise<{ ok: true; log: string } | { ok: false; message: string }> {
    const args = ["run", "view", String(id), "--repo", repo, opts.failed ? "--log-failed" : "--log", ...(opts.job ? ["--job", String(opts.job)] : []), ...(opts.attempt ? ["--attempt", String(opts.attempt)] : [])];
    const r = await this.run(args, 3 * 60_000);
    if (r.code === 0) return { ok: true, log: r.stdout };
    const said = firstLines(r.stderr);
    if (!said) throw new GhError(`gh run view exited with ${r.code}.`);
    return { ok: false, message: said };
  }

  /** Opens an issue as the user; resolves with its number and URL. */
  async issueCreate(repo: string, opts: { title: string; body: string; labels: string[] }): Promise<{ number: number; url: string }> {
    const r = await this.run(["issue", "create", "--repo", repo, "--title", opts.title, ...opts.labels.flatMap((l) => ["--label", l]), "--body-file", "-"], 60_000, opts.body);
    if (r.code !== 0) throw new GhError(firstLines(r.stderr) || `gh issue create exited with ${r.code}.`);
    return prUrl(r.stdout);
  }

  /** Comments on an issue or a PR as the user; resolves with the comment's URL. */
  async comment(repo: string, type: "issue" | "pr", number: number, body: string): Promise<string> {
    const r = await this.run([type, "comment", String(number), "--repo", repo, "--body-file", "-"], 60_000, body);
    if (r.code !== 0) throw new GhError(firstLines(r.stderr) || `gh ${type} comment exited with ${r.code}.`);
    return r.stdout.trim().split("\n").reverse().find((l) => l.startsWith("https://"))?.trim() ?? "";
  }

  /**
   * Closes or reopens an issue or a PR as the user, with a comment if there is one, and for an issue closed, why. The
   * comment goes as `--comment=…`, so one starting with a dash stays a comment.
   */
  async setState(repo: string, type: "issue" | "pr", number: number, action: "close" | "reopen", opts: { comment?: string; reason?: CloseReason } = {}): Promise<void> {
    const args = [type, action, String(number), "--repo", repo];
    if (opts.reason) args.push(`--reason=${opts.reason === "not_planned" ? "not planned" : "completed"}`);
    if (opts.comment) args.push(`--comment=${opts.comment}`);
    const r = await this.run(args, 60_000);
    if (r.code !== 0) throw new GhError(firstLines(r.stderr) || `gh ${type} ${action} exited with ${r.code}.`);
  }

  /** Changes an issue's or a PR's title, description or both, as the user. */
  async edit(repo: string, type: "issue" | "pr", number: number, opts: { title?: string; body?: string }): Promise<void> {
    const args = [type, "edit", String(number), "--repo", repo];
    if (opts.title !== undefined) args.push(`--title=${opts.title}`);
    if (opts.body !== undefined) args.push("--body-file", "-");
    const r = await this.run(args, 60_000, opts.body);
    if (r.code !== 0) throw new GhError(firstLines(r.stderr) || `gh ${type} edit exited with ${r.code}.`);
  }

  /** Closes a pull request with a comment. */
  async prClose(repo: string, number: number, comment: string): Promise<void> {
    const r = await this.run(["pr", "close", String(number), "--repo", repo, "--comment", comment], 60_000);
    if (r.code !== 0) throw new GhError(firstLines(r.stderr) || `gh pr close exited with ${r.code}.`);
  }

  /**
   * The git credential helper that has gh hand git its token, as `gh auth setup-git` sets up: git runs it through a
   * shell, so the path is quoted. The token stays between gh and git; Kumiko never sees it.
   */
  credentialHelper(): string {
    return `!'${this.gh.replace(/'/g, "'\\''")}' auth git-credential`;
  }
}

function avatar(url: unknown): { avatarUrl?: string } {
  if (typeof url !== "string") return {};
  try {
    const u = new URL(url);
    return u.protocol === "https:" && AVATAR_HOSTS.includes(u.hostname) ? { avatarUrl: u.href } : {};
  } catch {
    return {};
  }
}

/** The start of what gh printed, enough to say why. */
function firstLines(text: string): string {
  return text.trim().split("\n").slice(0, 4).join("\n").slice(0, 500);
}

/** Where git fetches a GitHub repo from: over HTTPS, with gh's token. */
export function gitHubUrl(repo: string): string {
  return `https://github.com/${repo}.git`;
}

/** The fields Kumiko reads of an issue or a PR. */
const ITEM_FIELDS = "number,title,state,author,body,labels,comments,url";

/** An issue or a PR as gh's --json gives it. */
export interface GitHubItem {
  number: number;
  title: string;
  state: string;
  author?: { login?: string };
  body?: string;
  labels?: { name: string }[];
  comments?: { author?: { login?: string }; body?: string; createdAt?: string }[];
  url: string;
  updatedAt?: string;
  headRefName?: string;
  baseRefName?: string;
  files?: { path: string; additions?: number; deletions?: number }[];
  reviews?: { author?: { login?: string }; body?: string; state?: string }[];
}

/** The fields Kumiko reads of a workflow run. */
const RUN_FIELDS = "attempt,conclusion,createdAt,databaseId,displayTitle,event,headBranch,headSha,jobs,name,status,url,workflowName";

/** A workflow run as gh run view's --json gives it. */
export interface WorkflowRun {
  databaseId: number;
  attempt?: number;
  name?: string;
  workflowName?: string;
  displayTitle?: string;
  status: string;
  conclusion?: string;
  event?: string;
  headBranch?: string;
  headSha?: string;
  createdAt?: string;
  url: string;
  jobs?: { databaseId: number; name: string; status: string; conclusion?: string; url?: string; steps?: { number: number; name: string; status: string; conclusion?: string }[] }[];
}

/** The number and URL of the issue or PR whose URL gh printed last. */
export function prUrl(stdout: string): { number: number; url: string } {
  const url = stdout.trim().split("\n").reverse().find((l) => /^https:\/\/\S+\/(pull|issues)\/\d+/.test(l.trim()))?.trim();
  if (!url) throw new GhError("gh didn't say where it opened it.");
  return { number: Number(/\/(\d+)(?:#.*)?$/.exec(url)![1]), url };
}
