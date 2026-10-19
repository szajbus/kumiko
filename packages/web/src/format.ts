import type { EndReason, SessionInfo } from "@bentomo/shared";

// Text the UI shows for numbers, times and sessions. Plain functions, so they can be tested without a browser.

/** A session's tab title: its project and its name from /rename, or else the first words of the opening prompt. */
export function sessionTitle(s: Pick<SessionInfo, "sandbox" | "prompt" | "title">): string {
  const words = (s.title ?? s.prompt).split(/\s+/).filter(Boolean);
  let text = "";
  for (const w of words) {
    if ((text + " " + w).trim().length > 28) return `${s.sandbox} · ${text || w.slice(0, 28)}…`;
    text = (text + " " + w).trim();
  }
  return `${s.sandbox} · ${text}`;
}

/** "max" → "Max". */
export function planName(plan: string): string {
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

/** "resets in 2h 5m", "resets in 3d 4h"; empty once the time has passed. */
export function resetText(ms: number): string | undefined {
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  const m = Math.ceil(ms / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `resets in ${d}d ${h}h`;
  if (h > 0) return `resets in ${h}h ${m % 60}m`;
  return `resets in ${m}m`;
}

/** "just now", "5 min ago", "3 hours ago", "1 day ago". */
export function ago(iso: string, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (min < 60 * 24) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.round(min / (60 * 24));
  return `${d} ${d === 1 ? "day" : "days"} ago`;
}

/** The line that closes an ended session's chat. */
export function endedText(reason: EndReason, code?: number): string {
  switch (reason) {
    case "user":
      return "Session ended.";
    case "sandbox":
      return "Session ended: its sandbox stopped.";
    case "quit":
      return "Session ended: Bentomo quit.";
    default:
      return code ? `Session ended: Claude exited with code ${code}.` : "Session ended: Claude exited.";
  }
}

/** "812 B", "4.2 KB", "13 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const [value, unit] = n < 1024 ** 2 ? [n / 1024, "KB"] : [n / 1024 ** 2, "MB"];
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${unit}`;
}

/** "$0.0042" below a cent, "$1.25" otherwise. */
export function formatCost(usd: number): string {
  return `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`;
}

/** "4.2s" under a minute, then "2m 5s". */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** A host path as ~/… when it is under the user's home. */
export function tilde(path: string, home?: string): string {
  return home && (path === home || path.startsWith(home + "/")) ? `~${path.slice(home.length)}` : path;
}
