import { execFile } from "node:child_process";
import { parseRepo, type GitHubAccount, type GitHubRepo } from "@kumiko/shared";

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
    const user = await this.run(["api", "user", "--jq", "{login, name, avatar_url} | @json"]).catch((err: Error) => ({ code: -1, stdout: "", stderr: err.message }));
    if (user.code !== 0) return { status: "error", detail: firstLines(user.stderr) || `gh api user exited with ${user.code}.` };
    try {
      const u = JSON.parse(user.stdout.trim()) as { login?: unknown; name?: unknown; avatar_url?: unknown };
      if (typeof u.login !== "string" || !u.login) throw new Error("no login");
      return { status: "signed-in", login: u.login, ...(typeof u.name === "string" && u.name ? { name: u.name } : {}), ...avatar(u.avatar_url) };
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
  async prForBranch(repo: string, branch: string): Promise<{ number: number; title: string; url: string } | undefined> {
    const prs = await this.json<{ number: number; title: string; url: string; headRepositoryOwner?: { login?: string } }[]>(
      ["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "number,title,url,headRepositoryOwner", "--limit", "10"],
      "pr list",
    );
    const owner = repo.split("/")[0].toLowerCase();
    const pr = prs.find((p) => !p.headRepositoryOwner?.login || p.headRepositoryOwner.login.toLowerCase() === owner);
    return pr && { number: pr.number, title: pr.title, url: pr.url };
  }

  /** Opens a pull request as the user; resolves with its number and URL. The body goes on stdin, never as an argument. */
  async prCreate(repo: string, opts: { base: string; head: string; title: string; body: string }): Promise<{ number: number; url: string }> {
    const r = await this.run(["pr", "create", "--repo", repo, "--base", opts.base, "--head", opts.head, "--title", opts.title, "--body-file", "-"], 60_000, opts.body);
    if (r.code !== 0) throw new GhError(firstLines(r.stderr) || `gh pr create exited with ${r.code}.`);
    return prUrl(r.stdout);
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

/** The number and URL of the issue or PR whose URL gh printed last. */
export function prUrl(stdout: string): { number: number; url: string } {
  const url = stdout.trim().split("\n").reverse().find((l) => /^https:\/\/\S+\/(pull|issues)\/\d+/.test(l.trim()))?.trim();
  if (!url) throw new GhError("gh didn't say where it opened it.");
  return { number: Number(/\/(\d+)(?:#.*)?$/.exec(url)![1]), url };
}
