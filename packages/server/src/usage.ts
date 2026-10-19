import type { ChildProcess } from "node:child_process";
import { exitCode, eachLine, shellQuote } from "@bentomo/sandbox";
import type { AccountUsage, UsageWindow } from "@bentomo/shared";

const ACCOUNT = "---account---";
const USAGE = "---usage---";

/**
 * Runs in the sandbox: who Claude is signed in as, then the subscription's usage from the endpoint Claude Code's
 * own /usage reads. The token comes from CLAUDE_CODE_OAUTH_TOKEN or the Claude home's .credentials.json and is handed to
 * curl on stdin, so it never shows up in a process list.
 */
const PROBE = `
echo ${ACCOUNT}
claude auth status 2>/dev/null
echo ${USAGE}
t="\${CLAUDE_CODE_OAUTH_TOKEN:-$(grep -o '"claudeAiOauth":{[^}]*' "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json" 2>/dev/null | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)}"
[ -n "$t" ] || exit 0
printf 'Authorization: Bearer %s\\n' "$t" | curl -fsS -m 15 -H @- -H 'anthropic-beta: oauth-2025-04-20' https://api.anthropic.com/api/oauth/usage
`;

type Exec = (name: string, cmd: string, env: string[]) => ChildProcess;

/** Reads the account and usage of the Claude signed in inside a sandbox. Never rejects: problems end up in `error`. */
export async function fetchAccountUsage(exec: Exec, sandbox: string, env: string[]): Promise<AccountUsage> {
  try {
    const child = exec(sandbox, `bash -c ${shellQuote(PROBE)}`, env);
    child.stdin!.end();
    const lines: string[] = [];
    const errs: string[] = [];
    eachLine(child.stdout!, (l) => lines.push(l));
    eachLine(child.stderr!, (l) => errs.push(l));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    const code = await exitCode(child).finally(() => clearTimeout(timer));
    const usage = parseProbe(lines.join("\n"), new Date());
    if (code !== 0 && !usage.email && !usage.windows.length) usage.error = errs.at(-1) || `The usage check exited with code ${code}.`;
    return usage;
  } catch (err) {
    return { windows: [], error: err instanceof Error ? err.message : String(err), fetchedAt: new Date().toISOString() };
  }
}

const WINDOWS: [key: string, label: string][] = [
  ["five_hour", "Session (5h)"],
  ["seven_day", "Week"],
  ["seven_day_opus", "Week · Opus"],
  ["seven_day_sonnet", "Week · Sonnet"],
];

/** Turns the probe's output into an AccountUsage. */
export function parseProbe(output: string, now: Date): AccountUsage {
  const result: AccountUsage = { windows: [], fetchedAt: now.toISOString() };
  const a = output.indexOf(ACCOUNT);
  const u = output.indexOf(USAGE);
  const account = a >= 0 ? output.slice(a + ACCOUNT.length, u >= 0 ? u : undefined) : "";
  const usage = u >= 0 ? output.slice(u + USAGE.length) : "";

  const acct = parseJson(account);
  if (acct) {
    if (typeof acct.email === "string") result.email = acct.email;
    if (typeof acct.subscriptionType === "string") result.plan = acct.subscriptionType;
  }

  const body = parseJson(usage);
  if (body) {
    for (const [key, label] of WINDOWS) {
      const w = body[key] as { utilization?: unknown; resets_at?: unknown } | null | undefined;
      if (!w || typeof w.utilization !== "number") continue;
      const win: UsageWindow = { id: key, label, usedPercent: Math.min(100, Math.max(0, w.utilization)) };
      if (typeof w.resets_at === "string") win.resetsAt = w.resets_at;
      result.windows.push(win);
    }
  } else if (usage.trim()) {
    result.error = "Claude returned usage in a format Bentomo doesn't know.";
  } else if (result.email) {
    result.error = "Usage isn't available: this sandbox's Claude has no subscription login.";
  }
  return result;
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(text.trim());
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Remembers each sandbox's reading for a while, and shares one in-flight probe between callers. */
export class UsageCache {
  private entries = new Map<string, { at: number; value: AccountUsage } | { pending: Promise<AccountUsage> }>();

  constructor(private readonly load: (sandbox: string) => Promise<AccountUsage>, private readonly ttlMs = 30_000) {}

  /** Drops what is known about a sandbox, e.g. after its Claude logged in. */
  forget(sandbox: string): void {
    this.entries.delete(sandbox);
  }

  get(sandbox: string): Promise<AccountUsage> {
    const e = this.entries.get(sandbox);
    if (e && "pending" in e) return e.pending;
    if (e && Date.now() - e.at < this.ttlMs) return Promise.resolve(e.value);
    const pending = this.load(sandbox).then((value) => {
      this.entries.set(sandbox, { at: Date.now(), value });
      return value;
    });
    this.entries.set(sandbox, { pending });
    pending.catch(() => this.entries.delete(sandbox));
    return pending;
  }
}
