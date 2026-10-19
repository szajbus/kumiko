/**
 * Multiline pastes stand in the composer as a short label, "[Pasted text #1 +5 lines]", and go out as what was
 * pasted. The labels are plain text in the box; a label only counts while it is whole and its number is known.
 */

/** What each label number stands for. */
export type Pastes = Record<number, string>;

/** Where a whole, known label sits in the text. */
export interface PasteSpan {
  id: number;
  start: number;
  end: number;
}

/** Line breaks only, so a paste that isn't one line is the only kind that gets a label. */
export const isMultiline = (text: string) => /\r|\n/.test(text);

/** The label: the paste's number and how many lines it adds past the first. */
export function pasteLabel(id: number, content: string): string {
  const added = content.match(/\r\n|\r|\n/g)?.length ?? 0;
  return `[Pasted text #${id} +${added} ${added === 1 ? "line" : "lines"}]`;
}

/** The number for the next paste: one past the highest so far, so a label put back by undo keeps its own. */
export function nextPasteId(pastes: Pastes): number {
  return Math.max(0, ...Object.keys(pastes).map(Number)) + 1;
}

/** The whole, known labels in the text, in order. */
export function pasteSpans(text: string, pastes: Pastes): PasteSpan[] {
  const spans: PasteSpan[] = [];
  for (const m of text.matchAll(/\[Pasted text #(\d+) \+\d+ lines?\]/g)) {
    const id = Number(m[1]);
    if (id in pastes && m[0] === pasteLabel(id, pastes[id]!)) spans.push({ id, start: m.index, end: m.index + m[0].length });
  }
  return spans;
}

/** The text with each label replaced by what it stands for: what gets sent. */
export function expandPastes(text: string, pastes: Pastes): string {
  let out = "";
  let at = 0;
  for (const s of pasteSpans(text, pastes)) {
    out += text.slice(at, s.start) + pastes[s.id];
    at = s.end;
  }
  return out + text.slice(at);
}
