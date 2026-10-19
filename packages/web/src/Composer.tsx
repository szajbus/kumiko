import { useLayoutEffect, useRef, useState } from "react";
import { Send } from "./icons";

interface Props {
  /** Resolves true when the text was taken, so the box clears; false keeps it for another try. */
  onSubmit(text: string): Promise<boolean>;
  submitLabel: string;
  /** Sending is blocked (a turn is running, or the session has ended); typing isn't. */
  disabled?: boolean;
  /** Shows Stop beside the submit button, which then queues the message for after the turn. */
  onStop?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  label: string;
}

const MAX_HEIGHT = 240;

/** A prompt box: Enter sends, Shift+Enter adds a line. Used by the New session tab and the chat. */
export function Composer({ onSubmit, submitLabel, disabled, onStop, placeholder, autoFocus, label }: Props) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  // Grow with the text, up to a limit, then scroll.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
    // scrollHeight is rounded, so the text can overflow by a fraction of a pixel and show a scrollbar; scroll only past the limit.
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
  }, [text]);

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
        <textarea
          ref={box}
          className="composer-input"
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label={label}
          autoFocus={autoFocus}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
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
        {onStop && (
          <button type="button" className="btn btn-secondary btn-compact composer-btn" onClick={onStop}>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor" />
            </svg>
            Stop
            <kbd className="kbd">Esc</kbd>
          </button>
        )}
        <button type="submit" className="btn btn-primary btn-compact composer-btn" disabled={!canSend}>
          <Send />
          {onStop ? "Queue" : submitLabel}
          <kbd className="kbd">Enter</kbd>
        </button>
      </form>
      <p className="composer-hint">
        <kbd className="kbd">Shift</kbd> + <kbd className="kbd">Enter</kbd> for a new line
      </p>
    </>
  );
}
