import { useState } from "react";
import { threadUnread, type ReviewThread } from "@kumiko/shared";
import { Markdown } from "./Markdown";
import { threadState } from "./review";

const short = (sha: string) => sha.slice(0, 7);

/** What the pane does with a thread: reply in it, which sends Claude the reply, and mark it. Each resolves to an error, if any. */
export interface ThreadActions {
  reply(thread: ReviewThread, text: string): Promise<string | undefined>;
  mark(thread: ReviewThread, change: { resolved?: boolean; read?: true }): void;
}

/**
 * A thread on the changes: the user's comments and Claude's replies, with where it stands. `where` names what it's on
 * when it isn't shown on it (a line at an earlier commit, a commit, the whole change). `outdated`: what it's on changed
 * since it was started.
 */
export function ThreadView({ t, where, head, canReply, actions, outdated, focused }: { t: ReviewThread; where?: string; head: string; canReply: boolean; actions: ThreadActions; outdated?: boolean; focused?: boolean }) {
  const [replying, setReplying] = useState(false);
  const [open, setOpen] = useState(false);
  const state = threadState(t);
  const unread = threadUnread(t);
  const firstUnread = unread ? (t.readTo ? t.messages.findIndex((m) => m.id === t.readTo) + 1 : 0) : t.messages.length;
  const changeDone = outdated && (state === "will-change" || state === "requested");
  const folded = state === "resolved" && !open;
  return (
    <div className={`rv-thread is-${state}${focused ? " is-focused" : ""}${unread ? " is-unread" : ""}`} data-thread={t.id}>
      <div className="rv-thread-h">
        {unread > 0 && <span className="rv-unread-dot" aria-label="Unread reply" />}
        {where && <span className="rv-thread-where">{where}</span>}
        {t.head !== head && <span className="rv-thread-at">at {short(t.head)}</span>}
        {state === "waiting" && <span className="tool-tag">waiting for Claude</span>}
        {state === "will-change" && <span className="tool-tag rv-tag-change">will change</span>}
        {state === "requested" && <span className="tool-tag rv-tag-change">change requested</span>}
        {outdated && <span className="tool-tag">outdated</span>}
        {state === "resolved" && <span className="tool-tag">resolved</span>}
        <span className="rv-spacer" />
        {unread > 0 && (
          <button type="button" className="link-btn" onClick={() => actions.mark(t, { read: true })} title="Mark its replies read (a)">
            Got it
          </button>
        )}
        {state === "resolved" ? (
          <>
            <button type="button" className="link-btn" onClick={() => setOpen((o) => !o)}>
              {open ? "Hide" : `Show ${t.messages.length === 1 ? "1 comment" : `${t.messages.length} comments`}`}
            </button>
            {canReply && (
              <button type="button" className="link-btn" onClick={() => actions.mark(t, { resolved: false })}>
                Reopen
              </button>
            )}
          </>
        ) : (
          !changeDone && (
            <button type="button" className="link-btn" onClick={() => actions.mark(t, { resolved: true })}>
              Resolve
            </button>
          )
        )}
      </div>
      {!folded && (
        <>
          {t.anchor.kind === "line" && (where || t.head !== head) && t.anchor.quote.trim() && <pre className="rv-thread-quote">{t.anchor.quote}</pre>}
          {t.messages.map((m, i) => (
            <div key={m.id} className={`rv-msg is-${m.by}${m.by === "claude" && i >= firstUnread ? " is-unread" : ""}`}>
              <div className="rv-msg-by">{m.by === "user" ? "You" : "Claude"}</div>
              {m.by === "claude" ? <Markdown text={m.text} /> : <div className="rv-msg-text">{m.text}</div>}
            </div>
          ))}
          {changeDone && (
            <div className="rv-thread-done">
              <span>This changed since. Claude may have made the change.</span>
              <button type="button" className="btn btn-secondary btn-compact" onClick={() => actions.mark(t, { resolved: true })}>
                Resolve
              </button>
            </div>
          )}
          {canReply &&
            (replying ? (
              <CommentEditor label="Reply" placeholder="Reply to Claude" onSend={async (text) => {
                const err = await actions.reply(t, text);
                if (!err) setReplying(false);
                return err;
              }} onCancel={() => setReplying(false)} />
            ) : (
              <button type="button" className="rv-thread-reply" onClick={() => setReplying(true)}>
                Reply…
              </button>
            ))}
        </>
      )}
    </div>
  );
}

/**
 * Writing a comment, which goes to Claude when sent: a question, or a change to ask for. Cmd+Enter sends it, and Esc
 * drops it. `onSend` resolves to an error, if it didn't go.
 */
export function CommentEditor({ label = "Comment", placeholder, onSend, onCancel }: { label?: string; placeholder: string; onSend(text: string): Promise<string | undefined>; onCancel(): void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    const err = await onSend(text);
    setBusy(false);
    if (err) setError(err);
  };
  return (
    <div className="rv-note is-editing rv-editor">
      <textarea
        className="rv-note-ta"
        autoFocus
        value={text}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      {error && <div className="rv-editor-error">{error}</div>}
      <div className="rv-note-f">
        <span className="rv-note-hint">Goes to Claude now</span>
        <button type="button" className="btn btn-secondary btn-compact" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary btn-compact" disabled={!text.trim() || busy} onClick={() => void send()}>
          {busy ? "Sending…" : label}
        </button>
      </div>
    </div>
  );
}
