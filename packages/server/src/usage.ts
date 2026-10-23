import type { ChildProcess } from "node:child_process";
import { exitCode, eachLine, shellQuote } from "@kumiko/sandbox";
import type { AccountUsage, UsageWindow } from "@kumiko/shared";

type Exec = (name: string, cmd: string, env: string[]) => ChildProcess;

/** Who Claude is signed in as in a sandbox. Both are missing when it isn't, or when that can't be told. */
export interface Account {
  email?: string;
  /** The subscription plan, e.g. "max" or "pro". */
  plan?: string;
}

/** Where the cache finds out who a sandbox's Claude is signed in as; by default by asking Claude inside it. */
export interface AccountSource {
  account(sandbox: string): Promise<Account>;
}

/** Asks Claude in each sandbox, forwarding the sandbox's variables in case the login is CLAUDE_CODE_OAUTH_TOKEN. */
export function sandboxAccountSource(exec: Exec, env: (sandbox: string) => string[]): AccountSource {
  return {
    async account(sandbox) {
      const child = exec(sandbox, `bash -c ${shellQuote("claude auth status 2>/dev/null")}`, env(sandbox));
      child.stdin!.end();
      const lines: string[] = [];
      eachLine(child.stdout!, (l) => lines.push(l));
      child.stderr!.resume();
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      await exitCode(child).finally(() => clearTimeout(timer));
      return parseAccount(lines.join("\n"));
    },
  };
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

/**
 * Reads the `rate_limit_info` of a `rate_limit_event`, which Claude sends with each turn on a subscription. Its
 * `unifiedWindows` give each limit's use as a fraction, and when it resets in Unix seconds. Undefined when it has none.
 */
export function parseRateLimit(info: unknown): UsageWindow[] | undefined {
  const unified = (info as { unifiedWindows?: unknown } | undefined)?.unifiedWindows;
  if (!unified || typeof unified !== "object") return undefined;
  const windows: UsageWindow[] = [];
  for (const [key, label] of WINDOWS) {
    const w = (unified as Record<string, { utilization?: unknown; resetsAt?: unknown } | null | undefined>)[key];
    if (!w || typeof w.utilization !== "number") continue;
    const win: UsageWindow = { id: key, label, usedPercent: Math.min(100, Math.max(0, w.utilization * 100)) };
    if (typeof w.resetsAt === "number") win.resetsAt = new Date(w.resetsAt * 1000).toISOString();
    windows.push(win);
  }
  return windows.length ? windows : undefined;
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
}

/**
 * Remembers each sandbox's account, and the latest usage Claude reported for each account, so that sessions on one
 * subscription share it however many sandboxes they run in. Usage comes only with a turn, so there is none until a
 * session has run one since the server started.
 */
export class UsageCache {
  private accounts = new Map<string, { at: number; value: Account } | { pending: Promise<Account> }>();
  private usage = new Map<string, { windows: UsageWindow[]; at: number }>();
  private readonly accountTtlMs: number;

  constructor(private readonly source: AccountSource, opts: UsageCacheOptions = {}) {
    this.accountTtlMs = opts.accountTtlMs ?? 5 * 60_000;
  }

  /** Takes in a `rate_limit_event`'s info from Claude in `sandbox`; a later report for the account wins. */
  async record(sandbox: string, info: unknown): Promise<void> {
    const windows = parseRateLimit(info);
    if (!windows) return;
    const at = Date.now();
    const key = keyOf(sandbox, await this.account(sandbox));
    if ((this.usage.get(key)?.at ?? -1) <= at) this.usage.set(key, { windows, at });
  }

  /** Drops what is known about a sandbox's login, e.g. after its Claude logged in, since the account may be another. */
  forget(sandbox: string): void {
    const e = this.accounts.get(sandbox);
    if (e && "value" in e) this.usage.delete(keyOf(sandbox, e.value));
    this.usage.delete(keyOf(sandbox, {}));
    this.accounts.delete(sandbox);
  }

  async get(sandbox: string): Promise<AccountUsage> {
    const account = await this.account(sandbox);
    const e = this.usage.get(keyOf(sandbox, account));
    const result: AccountUsage = { ...account, windows: e ? e.windows.map(current) : [] };
    if (e) result.fetchedAt = new Date(e.at).toISOString();
    return result;
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

/** A window that has reset since it was reported is unused until Claude reports it again. */
function current(w: UsageWindow): UsageWindow {
  if (!w.resetsAt || Date.parse(w.resetsAt) > Date.now()) return w;
  return { id: w.id, label: w.label, usedPercent: 0 };
}

/** Usage is the subscription's, so it is shared by email; a sandbox whose account is unknown keeps its own. */
function keyOf(sandbox: string, account: Account): string {
  return account.email ? `account:${account.email}` : `sandbox:${sandbox}`;
}
