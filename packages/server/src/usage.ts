import type { ChildProcess } from "node:child_process";
import { exitCode, eachLine, shellQuote } from "@kumiko/sandbox";
import type { AccountUsage, UsageWindow } from "@kumiko/shared";

const NO_TOKEN = "---no-token---";
const STATUS = "---status---";

/**
 * Runs in the sandbox: the subscription's usage from the endpoint Claude Code's own /usage reads, followed by the HTTP
 * status. The token comes from CLAUDE_CODE_OAUTH_TOKEN or the Claude home's .credentials.json and is handed to curl on
 * stdin, so it never shows up in a process list.
 */
const USAGE_PROBE = `
t="\${CLAUDE_CODE_OAUTH_TOKEN:-$(grep -o '"claudeAiOauth":{[^}]*' "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json" 2>/dev/null | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)}"
[ -n "$t" ] || { echo ${NO_TOKEN}; exit 0; }
printf 'Authorization: Bearer %s\\n' "$t" | curl -sS -m 15 -w '\\n${STATUS}%{http_code}\\n' -H @- -H 'anthropic-beta: oauth-2025-04-20' https://api.anthropic.com/api/oauth/usage
`;

type Exec = (name: string, cmd: string, env: string[]) => ChildProcess;

/** Who Claude is signed in as in a sandbox. Both are missing when it isn't, or when that can't be told. */
export interface Account {
  email?: string;
  /** The subscription plan, e.g. "max" or "pro". */
  plan?: string;
}

/** One attempt at reading a subscription's usage. */
export type UsageReading = { windows: UsageWindow[] } | { error: string };

/** Where the cache gets its answers; by default from Claude inside the sandbox. */
export interface UsageSource {
  account(sandbox: string): Promise<Account>;
  usage(sandbox: string): Promise<UsageReading>;
}

/** Asks Claude in each sandbox, forwarding the sandbox's variables in case the login is CLAUDE_CODE_OAUTH_TOKEN. */
export function sandboxUsageSource(exec: Exec, env: (sandbox: string) => string[]): UsageSource {
  return {
    async account(sandbox) {
      const { out } = await run(exec, sandbox, "claude auth status 2>/dev/null", env(sandbox));
      return parseAccount(out);
    },
    async usage(sandbox) {
      const { code, out, err } = await run(exec, sandbox, USAGE_PROBE, env(sandbox));
      return parseUsage(out, err.at(-1) || (code !== 0 ? `The usage check exited with code ${code}.` : undefined));
    },
  };
}

async function run(exec: Exec, sandbox: string, script: string, env: string[]): Promise<{ code: number; out: string; err: string[] }> {
  const child = exec(sandbox, `bash -c ${shellQuote(script)}`, env);
  child.stdin!.end();
  const lines: string[] = [];
  const err: string[] = [];
  eachLine(child.stdout!, (l) => lines.push(l));
  eachLine(child.stderr!, (l) => err.push(l));
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  const code = await exitCode(child).finally(() => clearTimeout(timer));
  return { code, out: lines.join("\n"), err };
}

/** Reads `claude auth status`. */
export function parseAccount(output: string): Account {
  const acct = parseJson(output);
  const result: Account = {};
  if (typeof acct?.email === "string") result.email = acct.email;
  if (typeof acct?.subscriptionType === "string") result.plan = acct.subscriptionType;
  return result;
}

const WINDOWS: [key: string, label: string][] = [
  ["five_hour", "Session (5h)"],
  ["seven_day", "Week"],
  ["seven_day_opus", "Week · Opus"],
  ["seven_day_sonnet", "Week · Sonnet"],
];

/** Reads the usage probe's output; `failure` is what went wrong when curl got no answer. */
export function parseUsage(output: string, failure?: string): UsageReading {
  if (output.includes(NO_TOKEN)) return { error: "Usage isn't available: this sandbox's Claude has no subscription login." };
  const s = output.lastIndexOf(STATUS);
  const status = s >= 0 ? Number(output.slice(s + STATUS.length).trim()) : 0;
  const body = s >= 0 ? output.slice(0, s) : output;
  if (!status) return { error: failure ? `Couldn't reach Claude's usage service: ${failure}` : "Couldn't reach Claude's usage service." };
  if (status === 429) return { error: "Claude's usage service is limiting how often usage can be read." };
  if (status === 401) return { error: "Claude's login token has expired. It renews the next time Claude runs in this project." };
  if (status !== 200) return { error: `Claude's usage service answered with HTTP ${status}.` };
  const json = parseJson(body);
  if (!json) return { error: "Claude returned usage in a format Kumiko doesn't know." };
  const windows: UsageWindow[] = [];
  for (const [key, label] of WINDOWS) {
    const w = json[key] as { utilization?: unknown; resets_at?: unknown } | null | undefined;
    if (!w || typeof w.utilization !== "number") continue;
    const win: UsageWindow = { id: key, label, usedPercent: Math.min(100, Math.max(0, w.utilization)) };
    if (typeof w.resets_at === "string") win.resetsAt = w.resets_at;
    windows.push(win);
  }
  return { windows };
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(text.trim());
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export interface UsageCacheOptions {
  /** How long a sandbox's account is trusted before it is asked again. */
  accountTtlMs?: number;
  /** How long a reading of an account's usage is kept before it is read again. */
  usageTtlMs?: number;
  /** How long to wait after a failed reading before trying again. */
  retryMs?: number;
}

interface UsageEntry {
  windows: UsageWindow[];
  /** When `windows` were read; missing until a reading succeeds. */
  fetchedAt?: string;
  /** Why the latest attempt failed; `windows` are then from an earlier one. */
  error?: string;
  /** When the next caller should read again. */
  nextAt: number;
  pending?: Promise<void>;
}

/**
 * Remembers each sandbox's account, and each account's usage, so that sessions on one subscription share a reading
 * however many sandboxes they run in. A failed reading keeps the last good windows and reports why they may be stale.
 */
export class UsageCache {
  private accounts = new Map<string, { at: number; value: Account } | { pending: Promise<Account> }>();
  private usage = new Map<string, UsageEntry>();
  private readonly accountTtlMs: number;
  private readonly usageTtlMs: number;
  private readonly retryMs: number;

  constructor(private readonly source: UsageSource, opts: UsageCacheOptions = {}) {
    this.accountTtlMs = opts.accountTtlMs ?? 5 * 60_000;
    this.usageTtlMs = opts.usageTtlMs ?? 5 * 60_000;
    this.retryMs = opts.retryMs ?? 2 * 60_000;
  }

  /** Drops what is known about a sandbox's login, e.g. after its Claude logged in, so the next reading is fresh. */
  forget(sandbox: string): void {
    const e = this.accounts.get(sandbox);
    if (e && "value" in e) this.usage.delete(keyOf(sandbox, e.value));
    this.usage.delete(keyOf(sandbox, {}));
    this.accounts.delete(sandbox);
  }

  async get(sandbox: string): Promise<AccountUsage> {
    const account = await this.account(sandbox);
    const key = keyOf(sandbox, account);
    let e = this.usage.get(key);
    if (!e) this.usage.set(key, (e = { windows: [], nextAt: 0 }));
    if (!e.pending && Date.now() >= e.nextAt) e.pending = this.read(sandbox, e);
    await e.pending;
    const result: AccountUsage = { ...account, windows: e.windows };
    if (e.fetchedAt) result.fetchedAt = e.fetchedAt;
    if (e.error) result.error = e.error;
    return result;
  }

  private async read(sandbox: string, e: UsageEntry): Promise<void> {
    const r = await this.source.usage(sandbox).catch((err): UsageReading => ({ error: err instanceof Error ? err.message : String(err) }));
    if ("windows" in r) {
      Object.assign(e, { windows: r.windows, fetchedAt: new Date().toISOString(), error: undefined, nextAt: Date.now() + this.usageTtlMs });
    } else {
      Object.assign(e, { error: r.error, nextAt: Date.now() + this.retryMs });
    }
    e.pending = undefined;
  }

  private account(sandbox: string): Promise<Account> {
    const e = this.accounts.get(sandbox);
    if (e && "pending" in e) return e.pending;
    if (e && Date.now() - e.at < this.accountTtlMs) return Promise.resolve(e.value);
    const pending = this.source.account(sandbox).then(
      (value) => (this.accounts.set(sandbox, { at: Date.now(), value }), value),
      () => (this.accounts.delete(sandbox), {}),
    );
    this.accounts.set(sandbox, { pending });
    return pending;
  }
}

/** Usage is the subscription's, so it is shared by email; a sandbox whose account is unknown keeps its own. */
function keyOf(sandbox: string, account: Account): string {
  return account.email ? `account:${account.email}` : `sandbox:${sandbox}`;
}
