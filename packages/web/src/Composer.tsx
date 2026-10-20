import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { formatBytes } from "@bentomo/shared";
import { hasFiles, readFiles, type ComposerFile } from "./attachments";
import { matchCommands } from "./commands";
import { drafts } from "./drafts";
import { Close, Paperclip, Return, Stop } from "./icons";
import { expandPastes, isMultiline, nextPasteId, pasteLabel, pasteSpans, type Pastes } from "./pastes";

interface Props {
  /** Resolves true when the message was taken, so the box clears; false keeps it for another try. */
  onSubmit(text: string, files: ComposerFile[]): Promise<boolean>;
  submitLabel: string;
  /** Sending is blocked (a turn is running, or the session has ended); typing isn't. */
  disabled?: boolean;
  /** Swaps the send icon for Stop; Enter then queues the message for after the turn. */
  onStop?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  label: string;
  /** Slash commands Claude accepts, without the slash. Typing "/" offers them. */
  commands?: string[];
  /** A guess at the next message, shown dimmed while the box is empty: Tab takes it into the box, Backspace drops it. */
  suggestion?: string;
  /** Keeps the unsent message in `drafts` under this key, and starts from what is there, with the cursor at its end. */
  draftKey?: string;
  /** Shown at the left of the line under the box, opposite the key hint. */
  footer?: ReactNode;
}

const MAX_HEIGHT = 240;
const MAX_SUGGESTIONS = 8;

/**
 * A prompt box: Enter sends, Shift+Enter adds a line. Used by the New session tab and the chat.
 * A multiline paste goes in as a label, "[Pasted text #1 +5 lines]", sent as the text it stands for; pasting the
 * same text again right after a label opens it up into the text, and Backspace takes the label out whole.
 * Files dropped on it, pasted, or picked with the paperclip go with the message; they are listed above the text.
 */
export function Composer({ onSubmit, submitLabel, disabled, onStop, placeholder, autoFocus, label, commands, suggestion, draftKey, footer }: Props) {
  const [text, setText] = useState(() => (draftKey && drafts.get(draftKey)?.text) || "");
  // Kept until the message is sent, even once a label is deleted, so undo can bring the label back.
  const [pastes, setPastes] = useState<Pastes>(() => (draftKey && drafts.get(draftKey)?.pastes) || {});
  const [files, setFiles] = useState<ComposerFile[]>(() => (draftKey && drafts.get(draftKey)?.files) || []);
  useEffect(() => {
    if (!draftKey) return;
    if (text || files.length) drafts.set(draftKey, { text, pastes, files });
    else drafts.delete(draftKey);
  }, [draftKey, text, pastes, files]);
  // Why the files last dropped, pasted or picked weren't all taken.
  const [refused, setRefused] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const spans = pasteSpans(text, pastes);
  // The label just pasted, while the cursor stays right after it: pasting the same text there opens it up.
  const [fresh, setFresh] = useState<number>();
  const [picked, setPicked] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [sending, setSending] = useState(false);
  // The suggestion Backspace dropped; a new one is a different text, so it shows again.
  const [dropped, setDropped] = useState<string>();
  const ghost = !text && suggestion && suggestion !== dropped ? suggestion : undefined;
  const box = useRef<HTMLTextAreaElement>(null);
  const marks = useRef<HTMLDivElement>(null);

  // A starting text is meant to be carried on with, so the cursor goes after it.
  useEffect(() => {
    const el = box.current;
    if (el?.value) el.setSelectionRange(el.value.length, el.value.length);
    // Only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Grow with the text, up to a limit, then scroll.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
    // scrollHeight is rounded, so the text can overflow by a fraction of a pixel and show a scrollbar; scroll only past the limit.
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
    // The labels' pills sit under the text, so they wrap and scroll with it.
    if (marks.current) marks.current.scrollTop = el.scrollTop;
  }, [text]);

  // Through the editing commands, so the change goes on the box's undo stack like typing does.
  const replace = (start: number, end: number, insert: string) => {
    const el = box.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(start, end);
    if (document.execCommand(insert ? "insertText" : "delete", false, insert)) return;
    el.setRangeText(insert, start, end, "end");
    setText(el.value);
  };

  // Only the command word itself is completed: once there is a space, what follows is its arguments.
  const typed = /^\/(\S*)$/.exec(text)?.[1];
  const suggestions = !dismissed && typed !== undefined && commands ? matchCommands(commands, typed).slice(0, MAX_SUGGESTIONS) : [];
  const choice = suggestions[Math.min(picked, suggestions.length - 1)];
  const complete = (name: string) => {
    setText(`/${name} `);
    setPicked(0);
  };

  const canSend = !disabled && !sending && (text.trim().length > 0 || files.length > 0);

  const attach = async (picked: File[]) => {
    if (!picked.length) return;
    const read = await readFiles(picked, files);
    setFiles((have) => [...have, ...read.files]);
    setRefused(read.errors.join(" ") || undefined);
    box.current?.focus();
  };

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      if (await onSubmit(expandPastes(text, pastes).trim(), files)) {
        setText("");
        setPastes({});
        setFresh(undefined);
        setFiles([]);
        setRefused(undefined);
      }
    } finally {
      setSending(false);
      box.current?.focus();
    }
  };

  return (
    <>
      <form
        className={`composer${dragging ? " composer-dropping" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        onDragOver={(e) => {
          if (!hasFiles(e.dataTransfer)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDragging(true);
        }}
        // Leaving for one of its own children isn't leaving.
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(e) => {
          if (!hasFiles(e.dataTransfer)) return;
          e.preventDefault();
          setDragging(false);
          void attach([...e.dataTransfer.files]);
        }}
      >
        {suggestions.length > 0 && (
          <ul className="command-list" role="listbox" aria-label="Slash commands">
            {suggestions.map((name) => (
              <li
                key={name}
                role="option"
                aria-selected={name === choice}
                className={`command-item mono${name === choice ? " command-item-active" : ""}`}
                // Mouse down, not click: a click would blur the box first.
                onMouseDown={(e) => {
                  e.preventDefault();
                  complete(name);
                  box.current?.focus();
                }}
              >
                /{name}
              </li>
            ))}
          </ul>
        )}
        {files.length > 0 && (
          <ul className="composer-files" aria-label="Attached files">
            {files.map((f) => (
              <li key={f.key} className="composer-file">
                <span className="composer-file-name" title={f.name}>
                  {f.name}
                </span>
                <span className="composer-file-size">{formatBytes(f.size)}</span>
                <button type="button" className="composer-file-remove" aria-label={`Remove ${f.name}`} title="Remove" onClick={() => setFiles(files.filter((x) => x !== f))}>
                  <Close />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="composer-field">
          {spans.length > 0 && (
            <div ref={marks} className="composer-marks" aria-hidden="true">
              {spans.map((s, i) => (
                <Fragment key={s.start}>
                  {text.slice(i ? spans[i - 1]!.end : 0, s.start)}
                  <mark className="composer-paste">{text.slice(s.start, s.end)}</mark>
                </Fragment>
              ))}
              {/* A trailing space keeps a last empty line, as the box has. */}
              {text.slice(spans.at(-1)!.end)}{" "}
            </div>
          )}
          <textarea
            ref={box}
            className="composer-input"
            rows={1}
            value={text}
            placeholder={ghost ?? placeholder}
            aria-label={label}
            autoFocus={autoFocus}
            onChange={(e) => {
              setText(e.target.value);
              setPicked(0);
              setDismissed(false);
              setFresh(undefined);
            }}
            onSelect={(e) => {
              const el = e.currentTarget;
              const after = el.selectionStart === el.selectionEnd && spans.some((s) => s.id === fresh && s.end === el.selectionStart);
              if (fresh !== undefined && !after) setFresh(undefined);
            }}
            onScroll={(e) => {
              if (marks.current) marks.current.scrollTop = e.currentTarget.scrollTop;
            }}
            onPaste={(e) => {
              // A screenshot, or files copied as such. Text that comes with files (a spreadsheet's cells come as an image too) wins.
              if (e.clipboardData.files.length > 0 && !e.clipboardData.getData("text/plain")) {
                e.preventDefault();
                void attach([...e.clipboardData.files]);
                return;
              }
              const pasted = e.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
              if (!isMultiline(pasted)) return;
              e.preventDefault();
              // The same text again, right after its label, opens the label up; anywhere else it is a new paste.
              const el = e.currentTarget;
              const same = el.selectionStart === el.selectionEnd && spans.find((s) => s.end === el.selectionStart && pastes[s.id] === pasted);
              if (same) {
                replace(same.start, same.end, pasted);
                return;
              }
              const id = nextPasteId(pastes);
              setPastes({ ...pastes, [id]: pasted });
              replace(el.selectionStart, el.selectionEnd, pasteLabel(id, pasted));
              setFresh(id);
            }}
            onKeyDown={(e) => {
              if (ghost && !e.nativeEvent.isComposing) {
                if (e.key === "Tab" && !e.shiftKey) {
                  e.preventDefault();
                  setText(ghost);
                  return;
                }
                if (e.key === "Backspace") {
                  e.preventDefault();
                  setDropped(ghost);
                  return;
                }
              }
              // A label goes as one piece, from just after it with Backspace or just before it with Delete.
              const el = e.currentTarget;
              if ((e.key === "Backspace" || e.key === "Delete") && el.selectionStart === el.selectionEnd && !e.nativeEvent.isComposing && !e.altKey && !e.metaKey && !e.ctrlKey) {
                const at = el.selectionStart;
                const label = spans.find((s) => (e.key === "Backspace" ? s.end : s.start) === at);
                if (label) {
                  e.preventDefault();
                  replace(label.start, label.end, "");
                  return;
                }
              }
              if (choice && !e.nativeEvent.isComposing) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const step = e.key === "ArrowDown" ? 1 : -1;
                  setPicked((Math.min(picked, suggestions.length - 1) + step + suggestions.length) % suggestions.length);
                  return;
                }
                // Enter on a name that is already complete sends it; otherwise it completes the highlighted one.
                if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && text !== `/${choice}`)) {
                  e.preventDefault();
                  complete(choice);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setDismissed(true);
                  return;
                }
              }
              if (e.key === "Escape" && onStop && !e.nativeEvent.isComposing) {
                e.preventDefault();
                onStop();
                return;
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
        </div>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void attach([...(e.currentTarget.files ?? [])]);
            // The same file picked again is a change too.
            e.currentTarget.value = "";
          }}
        />
        <button type="button" className="composer-icon" onClick={() => picker.current?.click()} aria-label="Attach files" title="Attach images, PDFs or text files (or drop or paste them)">
          <Paperclip />
        </button>
        {onStop ? (
          <button type="button" className="composer-icon" onClick={onStop} aria-label="Stop" title="Stop (Esc)">
            <Stop />
          </button>
        ) : (
          <button type="submit" className="composer-icon" disabled={!canSend} aria-label={submitLabel} title={`${submitLabel} (Enter)`}>
            <Return />
          </button>
        )}
      </form>
      <div className="composer-hint">
        {(footer || fresh !== undefined || refused) && (
          <div className="composer-footer">
            {footer}
            {fresh !== undefined && <span>Paste again to expand</span>}
            {refused && <span className="composer-refused">{refused}</span>}
          </div>
        )}
        <span className="composer-keys">
          <kbd className="kbd">Shift</kbd> + <kbd className="kbd">Enter</kbd> for a new line
        </span>
      </div>
    </>
  );
}
