// The fenced code blocks in a message being written, for the composer to colour them as it does in the chat.

import { fenceLanguage } from "./highlight.ts";

/** A fenced block in the text, by offsets: its opening fence line, its content, and its closing fence, once typed. */
export interface CodeBlockSpan {
  /** Where its opening fence starts. */
  start: number;
  /** Where its content starts (after the opening fence's line) and ends (before the closing fence's line). */
  contentStart: number;
  contentEnd: number;
  /** Where the block ends: after its closing fence, or at the end of the text while it isn't closed yet. */
  end: number;
  lang?: string;
}

const OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * The text's fenced code blocks, as Markdown has them: a line of three or more backticks or tildes opens one, a line of
 * at least as many of the same closes it. One not closed yet runs to the end of the text.
 */
export function codeBlocks(text: string): CodeBlockSpan[] {
  const blocks: CodeBlockSpan[] = [];
  let open: { fence: string; start: number; contentStart: number; lang?: string } | undefined;
  let pos = 0;
  for (const line of text.split("\n")) {
    const lineEnd = pos + line.length;
    const next = Math.min(text.length, lineEnd + 1);
    if (!open) {
      const m = OPEN.exec(line);
      // A backtick fence's info has no backticks: "```x```" on a line is inline code.
      if (m && !(m[1][0] === "`" && m[2].includes("`"))) {
        const lang = fenceLanguage(m[2]);
        open = { fence: m[1], start: pos, contentStart: next, ...(lang ? { lang } : {}) };
      }
    } else {
      const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (m && m[1][0] === open.fence[0] && m[1].length >= open.fence.length) {
        blocks.push({ start: open.start, contentStart: open.contentStart, contentEnd: Math.max(open.contentStart, pos - 1), end: lineEnd, ...(open.lang ? { lang: open.lang } : {}) });
        open = undefined;
      }
    }
    pos = next;
    if (lineEnd >= text.length) break;
  }
  if (open) blocks.push({ start: open.start, contentStart: open.contentStart, contentEnd: text.length, end: text.length, ...(open.lang ? { lang: open.lang } : {}) });
  return blocks;
}
