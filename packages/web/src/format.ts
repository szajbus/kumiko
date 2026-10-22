import type { EndReason, SessionInfo } from "@kumiko/shared";

// Text the UI shows for numbers, times and sessions. Plain functions, so they can be tested without a browser.

/** A session's name: from /rename, or else the first words of the opening prompt. Its tab shows it under its project's label. */
export function sessionName(s: Pick<SessionInfo, "prompt" | "title">): string {
  const words = (s.title ?? s.prompt).split(/\s+/).filter(Boolean);
  let text = "";
  for (const w of words) {
    if ((text + " " + w).trim().length > 28) return `${text || w.slice(0, 28)}…`;
    text = (text + " " + w).trim();
  }
  return text;
}

/** A session's title where its project doesn't show otherwise: the project, then its name. */
export function sessionTitle(s: Pick<SessionInfo, "sandbox" | "prompt" | "title">): string {
  return `${s.sandbox} · ${sessionName(s)}`;
}

/** The hue a project's tab group would like, from its name, so it stays the same from run to run. */
export function projectHue(name: string): number {
  // FNV-1a: close names still land far apart.
  let h = 0x811c9dc5;
  for (const c of name) h = Math.imul(h ^ c.codePointAt(0)!, 0x01000193) >>> 0;
  // Twelve hues, 30° apart, tell groups apart better than any of 360 would.
  return (h % 12) * 30;
}

/** How far apart two hues are, around the wheel. */
const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

/**
 * The hues of the open projects' tab groups: each its own, unless one before it by name has it already; then the free
 * one furthest from those taken, so it doesn't land beside the one it clashed with. By name, so dragging groups around
 * doesn't change them.
 */
export function projectHues(names: readonly string[]): Map<string, number> {
  const hues = new Map<string, number>();
  const taken: number[] = [];
  for (const name of [...new Set(names)].sort()) {
    const wanted = projectHue(name);
    const free = Array.from({ length: 12 }, (_, i) => i * 30).filter((h) => !taken.includes(h));
    const room = (h: number) => Math.min(...taken.map((t) => hueGap(h, t)));
    const hue = !free.length || free.includes(wanted) ? wanted : free.reduce((a, b) => (room(b) > room(a) || (room(b) === room(a) && hueGap(b, wanted) < hueGap(a, wanted)) ? b : a));
    hues.set(name, hue);
    taken.push(hue);
  }
  return hues;
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
      return "Session ended: Kumiko quit.";
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

/** "812", "4.2k", "13k", "1.2M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const [value, unit] = n < 1e6 ? [n / 1e3, "k"] : [n / 1e6, "M"];
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}${unit}`;
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
