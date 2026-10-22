/** Where a quote comes from: prose, or a code block, with the language it is marked as, if any. */
export type QuoteSource = { code: false } | { code: true; lang?: string };

/**
 * `text` as a markdown quote, "> " before each line and a bare ">" for an empty one. Text from a code block goes in a
 * fence first, long enough not to be closed by a run of backticks inside it. Blank lines around the text are dropped.
 */
export function quote(text: string, source: QuoteSource = { code: false }): string {
  let lines = text.replace(/\r\n?/g, "\n").split("\n");
  // Code keeps its indentation and only loses blank lines around it; prose loses trailing spaces too.
  if (!source.code) lines = lines.map((l) => l.trimEnd());
  const blank = (l: string) => !l.trim();
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return "";
  lines = lines.slice(first, lines.findLastIndex((l) => !blank(l)) + 1);
  if (source.code) {
    const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
    const fence = "`".repeat(Math.max(3, longest + 1));
    lines = [fence + (source.lang ?? ""), ...lines, fence];
  }
  return lines.map((l) => (blank(l) ? ">" : `> ${l}`)).join("\n");
}

/**
 * How to add `quoted` to the end of `draft`: what to replace from `from` to the end. The quote is set off from what is
 * already there by a blank line, and is followed by one, so what is typed next isn't taken into the quote.
 */
export function quoteInsert(draft: string, quoted: string): { from: number; insert: string } {
  const kept = draft.trimEnd();
  return { from: kept.length, insert: `${kept ? "\n\n" : ""}${quoted}\n\n` };
}

/**
 * A quote of an artifact, with the line before it that says which: by its title and where it is (a file's name, or a
 * page's address), for the agent to find it.
 */
export function quoteFrom(quoted: string, title: string, where: string): string {
  if (!quoted) return "";
  const named = where && where !== title ? `"${title}" (\`${where}\`)` : `"${title}"`;
  return `From the artifact ${named}:\n${quoted}`;
}
