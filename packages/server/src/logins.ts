import type { ChildProcess } from "node:child_process";
import { eachLine, exitCode, type SandboxProvider } from "@bentomo/sandbox";
import type { LoginAccount, LoginStartResponse } from "@bentomo/shared";

type Exec = SandboxProvider["exec"];

/** A login that couldn't start or didn't take; `output` is what Claude printed, for the user to read. */
export class LoginFailed extends Error {
  constructor(message: string, readonly output: string[] = []) {
    super(message);
  }
}

/** Where Claude may send the user to sign in. Anything else isn't opened. */
const SIGN_IN_HOSTS = ["claude.com", "claude.ai", "anthropic.com"];

function signInUrl(line: string): string | undefined {
  for (const m of line.matchAll(/https:\/\/\S+/g)) {
    try {
      const url = new URL(m[0]);
      if (SIGN_IN_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`))) return url.href;
    } catch {
      // not a URL after all
    }
  }
  return undefined;
}

interface Pending {
  child: ChildProcess;
  url: string;
  output: string[];
  exited: Promise<number>;
  timer: ReturnType<typeof setTimeout>;
}

const OUTPUT_LINES = 40;

/**
 * Logs Claude in, in a project's sandbox, with `claude auth login`: it prints a sign-in URL, then waits on stdin for
 * the code the sign-in page shows. The login lands in the project's Claude home (CLAUDE_CONFIG_DIR), so it is the
 * project's, not a session's. One login per project at a time; a second request joins the first.
 */
export class Logins {
  private pending = new Map<string, Pending>();
  /** Starts under way, so requests that arrive together share one login. */
  private starting = new Map<string, Promise<LoginStartResponse>>();

  constructor(
    private readonly exec: Exec,
    private readonly opts: { waitForCodeMs?: number; startMs?: number; finishMs?: number; statusMs?: number } = {},
  ) {}

  /** Who Claude in the project's sandbox is logged in as, or undefined when it isn't (or doesn't answer in time). */
  async account(project: string): Promise<LoginAccount | undefined> {
    const child = this.exec(project, "claude auth status --json", []);
    child.stdin!.end();
    const out: string[] = [];
    eachLine(child.stdout!, (l) => out.push(l));
    child.stderr!.resume();
    const kill = setTimeout(() => child.kill("SIGTERM"), this.opts.statusMs ?? 30_000);
    await exitCode(child).finally(() => clearTimeout(kill)); // 1 when logged out; the JSON says the same
    try {
      const s = JSON.parse(out.join("\n")) as { loggedIn?: unknown; email?: unknown; subscriptionType?: unknown };
      if (s.loggedIn !== true) return undefined;
      return {
        ...(typeof s.email === "string" ? { email: s.email } : {}),
        ...(typeof s.subscriptionType === "string" ? { plan: s.subscriptionType } : {}),
      };
    } catch {
      return undefined;
    }
  }

  /** Starts a login, or joins the one running; resolves with the sign-in URL. Says who it is if already logged in. */
  start(project: string, cwd: string): Promise<LoginStartResponse> {
    const running = this.pending.get(project);
    if (running) return Promise.resolve({ url: running.url });
    const under = this.starting.get(project);
    if (under) return under;
    const begun = this.begin(project, cwd).finally(() => this.starting.delete(project));
    this.starting.set(project, begun);
    return begun;
  }

  private async begin(project: string, cwd: string): Promise<LoginStartResponse> {
    const account = await this.account(project);
    if (account) return { loggedIn: account };

    const child = this.exec(project, "claude auth login", [], { cwd });
    const output: string[] = [];
    const keep = (l: string) => {
      output.push(l);
      if (output.length > OUTPUT_LINES) output.shift();
    };
    const exited = exitCode(child);
    const url = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => fail("Claude didn't show a sign-in link."), this.opts.startMs ?? 30_000);
      const fail = (why: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        reject(new LoginFailed(why, output));
      };
      eachLine(child.stdout!, (l) => {
        keep(l);
        const found = signInUrl(l);
        if (found && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve(found);
        }
      });
      eachLine(child.stderr!, keep);
      void exited.then((code) => fail(`Claude's login exited (code ${code}) before showing a sign-in link.`));
    });

    // Nobody pastes a code after this long; the login gives up rather than waiting forever.
    const timer = setTimeout(() => this.cancel(project), this.opts.waitForCodeMs ?? 10 * 60_000);
    const entry: Pending = { child, url, output, exited, timer };
    this.pending.set(project, entry);
    void exited.then(() => {
      clearTimeout(timer);
      if (this.pending.get(project) === entry) this.pending.delete(project);
    });
    return { url };
  }

  /** Hands the code from the sign-in page to the waiting login; resolves with the account once Claude is logged in. */
  async finish(project: string, code: string): Promise<LoginAccount> {
    const p = this.pending.get(project);
    if (!p) throw new LoginFailed("No login is waiting for a code. Start again.");
    const trimmed = code.trim();
    if (!trimmed || /\s/.test(trimmed) || trimmed.length > 4096) throw new LoginFailed("That doesn't look like a code from the sign-in page.");
    this.pending.delete(project);
    clearTimeout(p.timer);
    p.child.stdin!.end(`${trimmed}\n`);
    const kill = setTimeout(() => p.child.kill("SIGTERM"), this.opts.finishMs ?? 60_000);
    const exit = await p.exited.finally(() => clearTimeout(kill));
    if (exit !== 0) throw new LoginFailed("Claude didn't accept the code.", p.output);
    const account = await this.account(project);
    if (!account) throw new LoginFailed("The login finished, but Claude still isn't logged in.", p.output);
    return account;
  }

  /** Gives up on a waiting login, if there is one. */
  cancel(project: string): void {
    const p = this.pending.get(project);
    if (!p) return;
    this.pending.delete(project);
    clearTimeout(p.timer);
    p.child.kill("SIGTERM");
  }

  cancelAll(): void {
    for (const project of [...this.pending.keys()]) this.cancel(project);
  }
}
