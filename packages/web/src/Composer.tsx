import { Fragment, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { formatBytes } from "@kumiko/shared";
import { hasFiles, readFiles, type ComposerFile } from "./attachments";
import { matchCommands } from "./commands";
import { drafts } from "./drafts";
import { Close, Paperclip, Return, Stop } from "./icons";
import { expandPastes, isMultiline, nextPasteId, pasteLabel, pasteSpans, type Pastes } from "./pastes";
import { quoteInsert } from "./quote";
import { historyStep } from "./userShell";

/** What the composer lets its owner do to it. */
export interface ComposerHandle {
  /** Adds a markdown quote to the end of the message, with the cursor on the line after it, ready for the reply. */
  insertQuote(quoted: string): void;
  /** Puts the cursor in the box. */
  focus(): void;
}

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
  /** Messages sent before, oldest first: Up at the start of the box brings back the one before, Down the one after, as in a shell. */
  history?: string[];
  /**
   * Given while a message sent earlier waits for Claude: Up at the start of the box takes it back into the box, ahead of
   * what is there, to be edited, in place of going through `history`. Resolves to its text, or undefined if it was too late.
   */
  onTakeBack?: () => Promise<string | undefined>;
  /** Keeps the unsent message in `drafts` under this key, and starts from what is there, with the cursor at its end. */
  draftKey?: string;
  /** Shown at the left of the line under the box, opposite the key hint. */
  footer?: ReactNode;
  /**
   * Given where commands run, a message starting with "!" is one to run there: typing "!" into the box turns it into
   * a shell-mode box for the command, and the "!" into its marker. Backspace at the start turns it back.
   */
  shell?: { cwd: string };
  ref?: Ref<ComposerHandle>;
}

const MAX_HEIGHT = 240;
const MAX_SUGGESTIONS = 8;

/**
 * A prompt box: Enter sends, Shift+Enter adds a line. Used by the New session tab and the chat.
 * A multiline paste goes in as a label, "[Pasted text #1 +5 lines]", sent as the text it stands for; pasting the
 * same text again right after a label opens it up into the text, and Backspace takes the label out whole.
 * Files dropped on it, pasted, or picked with the paperclip go with the message; they are listed above the text.
 */
export function Composer({ onSubmit, submitLabel, disabled, onStop, placeholder, autoFocus, label, commands, suggestion, history = [], onTakeBack, draftKey, footer, shell, ref }: Props) {
  const draft = (draftKey && drafts.get(draftKey)?.text) || "";
  // In shell mode the box holds the command, and the "!" is its marker: what the message is starts with it.
  const [shellMode, setShellModeState] = useState(() => Boolean(shell) && draft.startsWith("!"));
  const [text, setText] = useState(() => (shell && draft.startsWith("!") ? draft.slice(1) : draft));
  // Read in handlers that run before a render, such as the change an edit made through `replace` sets off.
  const shellRef = useRef(shellMode);
  const setShellMode = (on: boolean) => {
    shellRef.current = on;
    setShellModeState(on);
  };
  // Left with Backspace: the "!" typed next is part of a prompt, until the box is sent or cleared.
  const literal = useRef(false);
  const value = shellMode ? `!${text}` : text;
  // Kept until the message is sent, even once a label is deleted, so undo can bring the label back.
  const [pastes, setPastes] = useState<Pastes>(() => (draftKey && drafts.get(draftKey)?.pastes) || {});
  const [files, setFiles] = useState<ComposerFile[]>(() => (draftKey && drafts.get(draftKey)?.files) || []);
  useEffect(() => {
    if (!draftKey) return;
    if (value || files.length) drafts.set(draftKey, { text: value, pastes, files });
    else drafts.delete(draftKey);
  }, [draftKey, value, pastes, files]);
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
  const ghost = !text && !shellMode && suggestion && suggestion !== dropped ? suggestion : undefined;
  // Which of `history` is in the box while going through it, and what was being written before that, for Down to come back to.
  const [recalled, setRecalled] = useState<number>();
  const stash = useRef("");
  // A message being taken back, so Up pressed again meanwhile doesn't ask for it twice.
  const takingBack = useRef(false);
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

  /** Puts a message in the box as an edit, in shell mode if it is a command. */
  const putValue = (v: string) => {
    const command = Boolean(shell) && v.startsWith("!");
    setShellMode(command);
    literal.current = false;
    replace(0, box.current?.value.length ?? 0, command ? v.slice(1) : v);
  };

  useImperativeHandle(ref, () => ({
    insertQuote(quoted) {
      const el = box.current;
      if (!el || !quoted) return;
      const { from, insert } = quoteInsert(el.value, quoted);
      replace(from, el.value.length, insert);
      el.scrollTop = el.scrollHeight;
    },
    focus() {
      box.current?.focus();
    },
  }));

  // Only the command word itself is completed: once there is a space, what follows is its arguments.
  const typed = shellMode ? undefined : /^\/(\S*)$/.exec(text)?.[1];
  const suggestions = !dismissed && typed !== undefined && commands ? matchCommands(commands, typed).slice(0, MAX_SUGGESTIONS) : [];
  const choice = suggestions[Math.min(picked, suggestions.length - 1)];
  const complete = (name: string) => {
    setText(`/${name} `);
    setPicked(0);
  };

  // A command goes on its own: files can't go with it.
  const canSend = !disabled && !sending && (shellMode ? text.trim().length > 0 && files.length === 0 : text.trim().length > 0 || files.length > 0);

  const attach = async (picked: File[]) => {
    if (!picked.length) return;
    if (shellRef.current) {
      setRefused("Files can't go with a shell command.");
      return;
    }
    const read = await readFiles(picked, files);
    setFiles((have) => [...have, ...read.files]);
    setRefused(read.errors.join(" ") || undefined);
    box.current?.focus();
  };

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      const message = expandPastes(text, pastes).trim();
      if (await onSubmit(shellMode ? `!${message}` : message, files)) {
        setText("");
        setShellMode(false);
        literal.current = false;
        setPastes({});
        setFresh(undefined);
        setFiles([]);
        setRefused(undefined);
        setRecalled(undefined);
      }
    } finally {
      setSending(false);
      box.current?.focus();
    }
  };

  return (
    <>
      <form
        className={`composer${dragging ? " composer-dropping" : ""}${shellMode ? " is-shell" : ""}`}
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
        {shellMode && (
          <span className="composer-mark" aria-hidden="true">
            !
          </span>
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
            placeholder={shellMode ? "Shell command" : (ghost ?? placeholder)}
            aria-label={shellMode ? "Shell command" : label}
            autoFocus={autoFocus}
            onChange={(e) => {
              const typedValue = e.target.value;
              if (!typedValue) literal.current = false;
              if (shell && !shellRef.current && !literal.current && typedValue.startsWith("!")) {
                setShellMode(true);
                setText(typedValue.slice(1));
                if (files.length) setRefused("Files can't go with a shell command.");
              } else setText(typedValue);
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
              // A command is better seen whole than as a label.
              if (shellMode || !isMultiline(pasted)) return;
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
              const el = e.currentTarget;
              // Backspace at the very start takes the "!" away: the box is a prompt again, with what is in it.
              if (shellMode && e.key === "Backspace" && el.selectionStart === 0 && el.selectionEnd === 0 && !e.nativeEvent.isComposing) {
                e.preventDefault();
                setShellMode(false);
                literal.current = !text;
                return;
              }
              // A label goes as one piece, from just after it with Backspace or just before it with Delete.
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
              // A waiting message comes back before history does, from the very start of the box; not into a command.
              if (e.key === "ArrowUp" && onTakeBack && !shellMode && recalled === undefined && el.selectionStart === 0 && el.selectionEnd === 0 && !e.nativeEvent.isComposing && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
                e.preventDefault();
                if (takingBack.current) return;
                takingBack.current = true;
                void onTakeBack()
                  .then((taken) => {
                    if (taken === undefined || !box.current) return;
                    // As an edit, so undo takes it out again; the cursor ends up after it.
                    replace(0, 0, box.current.value ? `${taken}\n\n` : taken);
                    box.current.setSelectionRange(taken.length, taken.length);
                  })
                  .finally(() => (takingBack.current = false));
                return;
              }
              // History: from the very start (or end) of the box, or anywhere on the first (or last) line of a message brought back and left as it was.
              if ((e.key === "ArrowUp" || e.key === "ArrowDown") && el.selectionStart === el.selectionEnd && !e.nativeEvent.isComposing && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
                const up = e.key === "ArrowUp";
                const at = el.selectionStart;
                const untouched = recalled !== undefined && value === history[recalled];
                const edge = up ? at === 0 || (untouched && !text.slice(0, at).includes("\n")) : at === text.length || (untouched && !text.slice(at).includes("\n"));
                const from = recalled ?? history.length;
                // In shell mode, only the commands run before; otherwise everything sent.
                const to = historyStep(history, from, up, shellMode);
                if (edge && to !== undefined) {
                  e.preventDefault();
                  if (recalled === undefined) stash.current = value;
                  setRecalled(to < history.length ? to : undefined);
                  putValue(to < history.length ? history[to]! : stash.current);
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
        <button type="button" className="composer-icon" disabled={shellMode} onClick={() => picker.current?.click()} aria-label="Attach files" title={shellMode ? "Files can't go with a shell command" : "Attach images, PDFs or text files (or drop or paste them)"}>
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
        {(footer || shellMode || fresh !== undefined || refused) && (
          <div className="composer-footer">
            {shellMode && shell ? (
              <span className="composer-shell" title="Runs in the sandbox. Claude gets the command and its output, and replies. Backspace at the start goes back to a message.">
                <span className="composer-shell-label">Shell</span> <span className="composer-shell-where">in {shell.cwd}</span>
              </span>
            ) : (
              footer
            )}
            {fresh !== undefined && <span>Paste again to expand</span>}
            {refused && <span className="composer-refused">{refused}</span>}
          </div>
        )}
      </div>
    </>
  );
}
