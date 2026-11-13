import type { GitHubRepo, MirrorView } from "@kumiko/shared";
import { ago } from "./format.ts";
import { COLORS } from "./status.ts";

/** The repos whose name or description has every word of the query in it, ignoring case; all of them for none. */
export function filterRepos(repos: GitHubRepo[], query: string): GitHubRepo[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return repos;
  return repos.filter((r) => {
    const text = `${r.repo} ${r.description ?? ""}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** Where the first match of the query is in `text`, to highlight it: [before, match, after]. */
export function highlight(text: string, query: string): [string, string, string] {
  const word = query.trim().split(/\s+/)[0]?.toLowerCase();
  const at = word ? text.toLowerCase().indexOf(word) : -1;
  if (at < 0) return [text, "", ""];
  return [text.slice(0, at), text.slice(at, at + word.length), text.slice(at + word.length)];
}

export interface MirrorStatus {
  text: string;
  /** A second line: the branches and tags, or when it last worked. */
  sub?: string;
  color: string;
  /** A fetch is under way: a spinner instead of the dot. */
  busy: boolean;
}

const counts = (m: MirrorView) =>
  m.branches === undefined ? undefined : `${m.branches} ${m.branches === 1 ? "branch" : "branches"} · ${m.tags ?? 0} ${m.tags === 1 ? "tag" : "tags"}`;

/** What the Last fetch column says of a mirror. */
export function mirrorStatus(m: MirrorView, now = Date.now()): MirrorStatus {
  switch (m.state) {
    case "cloning":
      return { text: "Cloning…", color: COLORS.busy, busy: true };
    case "fetching":
      return { text: "Fetching…", sub: m.fetchedAt && `last ${ago(m.fetchedAt, now)}`, color: COLORS.busy, busy: true };
    case "failed":
      return {
        text: `Failed ${ago(m.error?.at ?? m.addedAt, now)}`,
        sub: m.fetchedAt ? `last good fetch ${ago(m.fetchedAt, now)}` : "never fetched",
        color: COLORS.failed,
        busy: false,
      };
    default: {
      const t = m.fetchedAt ? ago(m.fetchedAt, now) : "—";
      return { text: t.charAt(0).toUpperCase() + t.slice(1), sub: counts(m), color: COLORS.running, busy: false };
    }
  }
}
