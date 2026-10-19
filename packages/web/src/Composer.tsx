import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { matchCommands } from "./commands";
import { drafts } from "./drafts";
import { Return, Stop } from "./icons";

interface Props {
  /** Resolves true when the text was taken, so the box clears; false keeps it for another try. */
  onSubmit(text: string): Promise<boolean>;
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
  /** Keeps the unsent text in `drafts` under this key, and starts from what is there, with the cursor at its end. */
  draftKey?: string;
  /** Shown at the left of the line under the box, opposite the key hint. */
  footer?: ReactNode;
}

const MAX_HEIGHT = 240;
const MAX_SUGGESTIONS = 8;

/** A prompt box: Enter sends, Shift+Enter adds a line. Used by the New session tab and the chat. */
export function Composer({ onSubmit, submitLabel, disabled, onStop, placeholder, autoFocus, label, commands, suggestion, draftKey, footer }: Props) {
  const [text, setTextState] = useState(() => (draftKey && drafts.get(draftKey)) || "");
  const setText = (value: string) => {
    setTextState(value);
    if (!draftKey) return;
    if (value) drafts.set(draftKey, value);
    else drafts.delete(draftKey);
  };
  const [picked, setPicked] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [sending, setSending] = useState(false);
  // The suggestion Backspace dropped; a new one is a different text, so it shows again.
  const [dropped, setDropped] = useState<string>();
  const ghost = !text && suggestion && suggestion !== dropped ? suggestion : undefined;
  const box = useRef<HTMLTextAreaElement>(null);

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
  }, [text]);

  // Only the command word itself is completed: once there is a space, what follows is its arguments.
  const typed = /^\/(\S*)$/.exec(text)?.[1];
  const suggestions = !dismissed && typed !== undefined && commands ? matchCommands(commands, typed).slice(0, MAX_SUGGESTIONS) : [];
  const choice = suggestions[Math.min(picked, suggestions.length - 1)];
  const complete = (name: string) => {
    setText(`/${name} `);
    setPicked(0);
  };

  const canSend = !disabled && !sending && text.trim().length > 0;

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      if (await onSubmit(text.trim())) setText("");
    } finally {
      setSending(false);
      box.current?.focus();
    }
  };

  return (
    <>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
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
        {footer && <div className="composer-footer">{footer}</div>}
        <span className="composer-keys">
          <kbd className="kbd">Shift</kbd> + <kbd className="kbd">Enter</kbd> for a new line
        </span>
      </div>
    </>
  );
}
