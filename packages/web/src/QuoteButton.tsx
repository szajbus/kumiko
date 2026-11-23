import { useEffect, useRef, useState, type RefObject } from "react";
import { Copy, Quote } from "./icons";
import { keptAround, markdownOf } from "./markdownOf";
import { quote } from "./quote";

/** Gap between the selection and the button. */
const GAP = 6;
const HEIGHT = 28;

/** The selection, when it is text inside `root`, quoted; a selection within one code block is quoted as code. */
function selectedQuote(root: HTMLElement): string | undefined {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const within = range.commonAncestorContainer;
  if (!root.contains(within)) return;
  const pre = (within instanceof Element ? within : within.parentElement)?.closest("pre");
  const lang = pre?.querySelector("code")?.className.match(/language-(\S+)/)?.[1];
  return quote(sel.toString(), pre ? { code: true, lang } : { code: false }) || undefined;
}

/**
 * The selection, when it is inside `root`, as Markdown. What it copies is wrapped in the elements around it that say how
 * it is formatted, so text selected within a code block is still fenced, and items selected in a list still listed.
 */
function selectedMarkdown(root: HTMLElement): string | undefined {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const within = range.commonAncestorContainer;
  if (!root.contains(within)) return;
  const around: Element[] = [];
  for (let el = within instanceof Element ? within : within.parentElement; el && el !== root; el = el.parentElement) around.push(el);
  let copied: Node = range.cloneContents();
  for (const el of keptAround(around)) {
    const shell = el.cloneNode(false);
    shell.appendChild(copied);
    copied = shell;
  }
  return markdownOf(copied) || undefined;
}

/** Where the button goes: under the end of the selection, or over its start when it was made backwards. */
function placeFor(root: HTMLElement, width: number): { top: number; left: number } | undefined {
  const sel = getSelection();
  if (!sel?.rangeCount) return;
  const rects = [...sel.getRangeAt(0).getClientRects()].filter((r) => r.width > 0);
  if (!rects.length) return;
  const { anchorNode: a, focusNode: f } = sel;
  const backwards = a === f ? sel.focusOffset < sel.anchorOffset : Boolean(a && f && a.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_PRECEDING);
  const at = backwards ? rects[0]! : rects.at(-1)!;
  const view = root.getBoundingClientRect();
  const top = backwards ? at.top - GAP - HEIGHT : at.bottom + GAP;
  // Scrolled out of the chat, it would float over the header or the composer.
  if (top < view.top || top + HEIGHT > view.bottom) return;
  return { top, left: Math.max(view.left, Math.min(backwards ? at.left : at.right, view.right - width)) };
}

/** Whether a key press is a bare letter `letter`, typed outside any field. */
function bare(e: KeyboardEvent, letter: string): boolean {
  if (e.key.toLowerCase() !== letter || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing) return false;
  return !(e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable]");
}

/**
 * Text selected in the chat can be quoted into the message: with the button that shows by the selection once it is
 * made, or with Q. With `copy`, it can also be copied as Markdown, with its button or with C. While the mouse is
 * selecting, the buttons wait for it to let go, so they don't follow the drag.
 */
export function QuoteButton({ root, onQuote, copy = false }: { root: RefObject<HTMLElement | null>; onQuote(quoted: string): void; copy?: boolean }) {
  const [place, setPlace] = useState<{ top: number; left: number }>();
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const copyNow = useRef(() => {});
  copyNow.current = () => {
    const md = root.current && selectedMarkdown(root.current);
    if (!md) return;
    void navigator.clipboard.writeText(md).then(() => {
      setCopied(true);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1500);
    });
  };
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  // The listeners stay put across renders, so a drag that is under way isn't forgotten while the chat streams.
  const quoteTo = useRef(onQuote);
  quoteTo.current = onQuote;

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let pressed = false;
    const update = () => {
      setPlace(!pressed && selectedQuote(el) ? placeFor(el, copy ? 170 : 96) : undefined);
      setCopied(false);
    };
    const down = (e: MouseEvent) => {
      if (e.button === 0) pressed = true;
    };
    const up = () => {
      pressed = false;
      update();
    };
    const key = (e: KeyboardEvent) => {
      if (copy && bare(e, "c") && selectedQuote(el)) {
        e.preventDefault();
        copyNow.current();
        return;
      }
      if (!bare(e, "q")) return;
      const quoted = selectedQuote(el);
      if (!quoted) return;
      e.preventDefault();
      quoteTo.current(quoted);
    };
    document.addEventListener("selectionchange", update);
    document.addEventListener("mousedown", down);
    document.addEventListener("mouseup", up);
    document.addEventListener("keydown", key);
    el.addEventListener("scroll", update);
    addEventListener("resize", update);
    return () => {
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("mousedown", down);
      document.removeEventListener("mouseup", up);
      document.removeEventListener("keydown", key);
      el.removeEventListener("scroll", update);
      removeEventListener("resize", update);
    };
  }, [root, copy]);

  if (!place) return null;
  return (
    <div className="selection-actions" style={place}>
      <button
        type="button"
        className="quote-btn"
        title="Quote in your message (Q)"
        // Mouse down, not click: pressing would otherwise clear the selection first.
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const quoted = root.current && selectedQuote(root.current);
          if (quoted) onQuote(quoted);
        }}
      >
        <Quote /> Quote
      </button>
      {copy && (
        <button
          type="button"
          className="quote-btn"
          title="Copy as Markdown (C)"
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            copyNow.current();
          }}
        >
          <Copy /> {copied ? "Copied" : "Copy"}
        </button>
      )}
    </div>
  );
}
