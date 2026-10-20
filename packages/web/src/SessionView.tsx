import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatBytes, LIVE_SESSION_STATUSES, type LoginAccount, type SessionInfo } from "@bentomo/shared";
import { api, errorMessage, useSessionEvents } from "./api";
import { fromAttachment, toInput } from "./attachments";
import { applyEvent, blocksOf, chatRows, emptyChat, loginCards, partialToolSummary, toolSummary, type Block, type ChatItem, type ChatState, type ItemRow, type LoginAnswer, type WorkRow } from "./chat";
import { Composer } from "./Composer";
import { Markdown } from "./Markdown";
import { ConfirmDialog } from "./ConfirmDialog";
import { drafts } from "./drafts";
import { endedText, formatCost, formatDuration, planName } from "./format";
import { Fork, Rewind } from "./icons";
import { LoginDialog } from "./LoginDialog";
import { Select } from "./Select";
import { COLORS, sessionStatus } from "./status";
import { UsageStrip } from "./UsageStrip";

const MODELS = ["default", "opus", "sonnet", "haiku"];
/** Commands Bentomo handles itself, since Claude can't run them headless; offered alongside Claude's own. */
const OWN_COMMANDS = ["fork", "rewind"];

interface Props {
  session: SessionInfo;
  /** A fork was started; opens its tab. */
  onForked(id: string): void;
}

/**
 * Tells the server the user has seen the session whenever it has something unread while it is on screen: this view
 * only renders for the active tab, so on screen means the window is visible.
 */
function useMarkSeen(session: SessionInfo) {
  const { id, unread } = session;
  useEffect(() => {
    if (!unread) return;
    const mark = () => {
      if (document.visibilityState === "visible") api.seen(id).catch(() => {});
    };
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [id, unread]);
}

/** One session: header, the chat streamed from its events, and the composer. */
export function SessionView({ session, onForked }: Props) {
  const stream = useSessionEvents(session.id);
  useMarkSeen(session);
  const chat = useChat(stream.events);
  const totalCost = useMemo(() => chat.items.reduce((sum, i) => sum + (i.type === "turn" ? (i.costUsd ?? 0) : 0), 0), [chat.items]);
  const [error, setError] = useState<string | undefined>();
  const [model, setModel] = useState("");
  // The message a rewind was asked for, until it is confirmed or dropped.
  const [rewinding, setRewinding] = useState<Extract<ChatItem, { type: "user" }> | undefined>();
  const [restoreFiles, setRestoreFiles] = useState(false);
  useEffect(() => setRestoreFiles(false), [rewinding]);
  // Bumped by a rewind, so the composer starts again from the draft it left.
  const [composerKey, setComposerKey] = useState(0);
  const [loggingIn, setLoggingIn] = useState(false);
  // What is known about the login behind the last logged-out card; `loginCards` decides what that shows.
  const [answer, setAnswer] = useState<LoginAnswer | undefined>();
  const idle = session.status === "idle";
  // Claude reports a full model id; the dropdown lists aliases, so show the alias it belongs to.
  const reported = session.model ?? "";
  const alias = MODELS.find((m) => m !== "default" && reported.toLowerCase().includes(m));
  const currentModel = alias ?? reported;
  const defaultAlias = MODELS.find((m) => m !== "default" && session.defaultModel?.toLowerCase().includes(m));
  const modelOptions = currentModel && !MODELS.includes(currentModel) ? [...MODELS, currentModel] : MODELS;
  // Once Claude reports the model in use, that replaces what was picked.
  // A pick Claude didn't accept is dropped when the turn ends.
  useEffect(() => setModel(""), [reported, idle]);
  const status = sessionStatus(session.status);
  const live = LIVE_SESSION_STATUSES.includes(session.status);
  const busy = live && !idle;

  const login = useMemo(() => loginCards(chat.items, answer), [chat.items, answer]);
  const open = login.open;

  // A logged-out card that is still the last word may be out of date (logged in from another session, or before a
  // reload): ask whether the project is logged in now. Nothing shows until the answer is in.
  useEffect(() => {
    if (!open || answer?.key === open) return;
    let current = true;
    api.loginStatus(session.id).then(
      (res) => current && setAnswer({ key: open, account: res.loggedIn }),
      () => current && setAnswer({ key: open }),
    );
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, session.id]);

  // When a prompt sent while this tab is open fails for want of a login, the login opens straight away. Replaying an
  // old session's chat doesn't: Claude has to have been working since the tab opened.
  const sawWork = useRef(false);
  if (session.status === "running" || session.status === "starting") sawWork.current = true;
  useEffect(() => {
    if (!open || !sawWork.current) return;
    sawWork.current = false;
    setLoggingIn(true);
  }, [open]);

  const call = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setError(undefined);
    try {
      await fn();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    }
  };

  /** A new tab with the conversation up to the end of `prompt`'s turn, or all of it. */
  const fork = (prompt?: string) => call(() => api.forkSession(session.id, prompt).then(({ id }) => onForked(id)));
  const canBranch = idle && Boolean(session.claudeSessionId);

  return (
    <div className="session">
      <div className="session-head">
        <div className="session-where">
          <a className="badge mono" href={`#/project/${session.sandbox}`} title="Open the project">
            {session.sandbox}
          </a>
          <span className="row-status session-status" style={{ color: status.color }}>
            {busy ? <span className="spinner" aria-hidden="true" /> : <span className="dot dot-small" style={{ background: status.color }} aria-hidden="true" />}
            {status.text}
          </span>
        </div>
        <div className="session-controls">
          <UsageStrip sessionId={session.id} live={live} turnDone={idle} cost={totalCost} bufferBytes={session.bufferBytes} />
        </div>
      </div>

      <Chat
        chat={chat}
        running={busy}
        onRewind={canBranch ? setRewinding : undefined}
        onFork={canBranch ? (item) => void fork(item.id) : undefined}
        hidden={login.hidden}
        actions={
          login.card && {
            key: login.card.key,
            node: login.card.account ? (
              <LoggedInCard
                account={login.card.account}
                retried={login.card.retried}
                busy={busy}
                onRetry={() => {
                  const was = answer!;
                  setAnswer({ ...was, retried: true });
                  void call(() => api.retry(session.id)).then((ok) => ok || setAnswer(was));
                }}
              />
            ) : (
              <LoggedOutCard project={session.sandbox} onLogIn={() => setLoggingIn(true)} />
            ),
          }
        }
      />

      {loggingIn && (
        <LoginDialog
          sessionId={session.id}
          project={session.sandbox}
          onClose={() => setLoggingIn(false)}
          onDone={(account) => {
            setLoggingIn(false);
            if (open) setAnswer({ key: open, account });
          }}
        />
      )}

      {rewinding && (
        <ConfirmDialog
          title="Rewind to this message?"
          confirmLabel="Rewind"
          onCancel={() => setRewinding(undefined)}
          onConfirm={() => {
            const target = rewinding;
            setRewinding(undefined);
            void call(() =>
              api.rewindSession(session.id, target.id!, restoreFiles).then(({ text, attachments }) => {
                drafts.set(session.id, { text, files: attachments?.map(fromAttachment) });
                setComposerKey((k) => k + 1);
              }),
            );
          }}
        >
          <p>The conversation goes back to just before this message, and the message goes back into the box to edit. Everything after it is removed.</p>
          <label className="rewind-files">
            <input type="checkbox" checked={restoreFiles} onChange={(e) => setRestoreFiles(e.target.checked)} />
            <span>Also put back the files Claude has changed since.</span>
          </label>
        </ConfirmDialog>
      )}

      <div className="session-foot">
        {stream.gone && <div className="banner banner-warn">This session is no longer on the server.</div>}
        {!stream.connected && !stream.gone && stream.events.length > 0 && (
          <div className="banner banner-warn">Lost connection to the session. Reconnecting…</div>
        )}
        {error && <div className="banner banner-error">{error}</div>}
        <Composer
          key={composerKey}
          label="Message Claude"
          commands={session.commands && [...session.commands, ...OWN_COMMANDS.filter((c) => !session.commands!.includes(c))]}
          suggestion={chat.suggestion}
          draftKey={session.id}
          submitLabel="Send"
          placeholder={live ? "Message Claude…" : "This session has ended."}
          disabled={!live || session.status === "starting"}
          onStop={session.status === "running" ? () => void call(() => api.interrupt(session.id)) : undefined}
          onSubmit={(text, files) => {
            // Claude can't log in or fork from here, but Bentomo can.
            if (text === "/login") return (setLoggingIn(true), Promise.resolve(true));
            if (text === "/fork") return idle ? fork() : (setError("Wait for Claude to finish, or stop it, before forking."), Promise.resolve(false));
            if (text === "/rewind") {
              // To just before the last message, as its arrow would; older ones have their own arrows.
              const last = chat.items.findLast((i): i is UserItem => i.type === "user" && Boolean(i.replayed && i.id));
              if (!idle) setError("Wait for Claude to finish, or stop it, before rewinding.");
              else if (!last || !session.claudeSessionId) setError("There is nothing to rewind yet.");
              else setRewinding(last);
              return Promise.resolve(Boolean(idle && last && session.claudeSessionId));
            }
            return call(() => api.prompt(session.id, text, files.map(toInput)));
          }}
          autoFocus
          footer={
            <>
              <span className="badge badge-bypass" title="Claude runs tools without asking for permission. The sandbox is the boundary.">
                Bypass permissions
              </span>
              <Select
                compact
                value={model || currentModel}
                placeholder="Model"
                disabled={!idle}
                groups={[{ options: modelOptions }]}
                labels={defaultAlias ? { default: `default (${defaultAlias})` } : undefined}
                onValueChange={(v) => {
                  setModel(v);
                  void call(() => api.prompt(session.id, `/model ${v}`));
                }}
              />
            </>
          }
        />
      </div>
    </div>
  );
}

/** Folds events into the chat incrementally: only new events are applied, and unchanged items keep their identity. */
function useChat(events: ReturnType<typeof useSessionEvents>["events"]): ChatState {
  const ref = useRef<{ state: ChatState; count: number; last?: unknown }>({ state: emptyChat(), count: 0 });
  return useMemo(() => {
    // The stream only grows; if the last event applied isn't where it was, the stream was reset (a rewind), so start over.
    const same = ref.current.count === 0 || events[ref.current.count - 1] === ref.current.last;
    let { state, count } = same ? ref.current : { state: emptyChat(), count: 0 };
    for (; count < events.length; count++) state = applyEvent(state, events[count]);
    ref.current = { state, count, last: events[count - 1] };
    return state;
  }, [events]);
}

type UserItem = Extract<ChatItem, { type: "user" }>;

/** In place of the last logged-out card, while the project still isn't logged in. */
function LoggedOutCard({ project, onLogIn }: { project: string; onLogIn(): void }) {
  return (
    <div className="chat-error" role="alert">
      <strong>Claude isn't logged in.</strong>
      <div className="chat-error-actions">
        <span>Log in once for the project {project}; all its sessions use it.</span>
        <button type="button" className="btn btn-primary btn-compact" onClick={onLogIn}>
          Log in
        </button>
      </div>
    </div>
  );
}

/** In place of the last logged-out card once the project is logged in, offering to send the failed prompt again. */
function LoggedInCard({ account, retried, busy, onRetry }: { account: LoginAccount; retried?: boolean; busy: boolean; onRetry(): void }) {
  return (
    <div className="chat-ok" role="status">
      <strong>
        Logged in as {account.email ?? "your Claude account"}
        {account.plan ? ` (${planName(account.plan)})` : ""}.
      </strong>
      {!retried && (
        <div className="chat-error-actions">
          <span>Send your last message again, logged in.</span>
          <button type="button" className="btn btn-primary btn-compact" disabled={busy} onClick={onRetry}>
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

interface ChatProps {
  chat: ChatState;
  running: boolean;
  onRewind?: (item: UserItem) => void;
  onFork?: (item: UserItem) => void;
  /** Shown in place of one item: the logged-out card, with Log in, or once logged in, the green one with Retry. */
  actions?: { key: string; node: ReactNode };
  /** Items not to show at all. */
  hidden?: ReadonlySet<string>;
}

function Chat({ chat, running, onRewind, onFork, actions, hidden }: ChatProps) {
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  // Follows new output while the view is at the bottom; scrolling up stops that until it is back at the bottom.
  const stick = useRef(true);
  const userCount = chat.items.filter((i) => i.type === "user").length;

  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat, running]);

  // Sending a message always brings the chat back down.
  useLayoutEffect(() => {
    stick.current = true;
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [userCount]);

  // Content can also grow or the box shrink without a new event: markdown laying out, the composer growing.
  useEffect(() => {
    const el = box.current;
    if (!el || !inner.current) return;
    const follow = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    follow.observe(el);
    follow.observe(inner.current);
    return () => follow.disconnect();
  }, []);

  // Tool calls after the last turn's end are still in flight while the session runs.
  const lastTurn = chat.items.findLastIndex((i) => i.type === "turn" || i.type === "ended");
  const rows = useMemo(() => chatRows(chat.items), [chat.items]);
  const itemRow = (row: ItemRow) =>
    hidden?.has(row.item.key) ? null : (
      <Item
        key={row.from ? `${row.item.key}-${row.from}` : row.item.key}
        item={row.item}
        from={row.from}
        to={row.to}
        open={running && row.index > lastTurn}
        onRewind={onRewind}
        onFork={onFork}
        actions={actions?.key === row.item.key ? actions.node : undefined}
      />
    );

  return (
    <div
      ref={box}
      className="chat"
      role="log"
      aria-live="polite"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      <div ref={inner} className="chat-inner">
        {rows.map((row) =>
          row.type === "work" ? (
            <Work key={row.key} row={row} onUnfold={() => (stick.current = false)}>
              {row.rows.map(itemRow)}
            </Work>
          ) : (
            itemRow(row)
          ),
        )}
        {running && chat.items.at(-1)?.type === "user" && (
          <div className="chat-waiting">
            <span className="spinner" aria-hidden="true" /> Waiting for Claude…
          </div>
        )}
      </div>
    </div>
  );
}

/** How long a finished turn's work stays open before folding, so the reply is seen to arrive first. */
const FOLD_DELAY_MS = 250;

/**
 * A turn's work. Open while the turn runs; once it is done it folds, with an animation if it was watched running, and
 * shows a line summing it up that opens it again.
 */
function Work({ row, onUnfold, children }: { row: WorkRow; onUnfold(): void; children: ReactNode }) {
  const [folded, setFolded] = useState(row.done);
  const watched = useRef(!row.done);
  useEffect(() => {
    if (!row.done || !watched.current) return;
    watched.current = false;
    const t = setTimeout(() => setFolded(true), FOLD_DELAY_MS);
    return () => clearTimeout(t);
  }, [row.done]);

  return (
    <div className={`work${folded ? " is-folded" : ""}`}>
      {row.done && (
        <button
          type="button"
          className="work-summary"
          aria-expanded={!folded}
          title={row.tools || undefined}
          onClick={() => {
            // Opening it grows the chat below the line; following the bottom would scroll the line away.
            if (folded) onUnfold();
            setFolded(!folded);
          }}
        >
          {row.summary}
        </button>
      )}
      <div className="work-body" inert={folded}>
        <div className="work-clip">
          <div className="work-items">{children}</div>
        </div>
      </div>
    </div>
  );
}

interface ItemProps {
  item: ChatItem;
  /** For an assistant item, the blocks to show, when not all of them. */
  from?: number;
  to?: number;
  open: boolean;
  onRewind?: (item: UserItem) => void;
  onFork?: (item: UserItem) => void;
  actions?: ReactNode;
}

const Item = memo(function Item({ item, from, to, open, onRewind, onFork, actions }: ItemProps) {
  if (actions) return <>{actions}</>;
  switch (item.type) {
    case "user":
      // Only prompts Claude has echoed are in its history, so only those can be branched from.
      return (
        <div className="msg-user-row">
          {item.replayed && item.id && (onRewind || onFork) && (
            <div className="msg-actions">
              {onFork && (
                <button type="button" className="btn btn-secondary btn-compact" title="Fork from here: a new tab with the conversation up to Claude's reply to this message" aria-label="Fork from this message" onClick={() => onFork(item)}>
                  <Fork />
                </button>
              )}
              {onRewind && (
                <button type="button" className="btn btn-secondary btn-compact" title="Rewind to just before this message" aria-label="Rewind to this message" onClick={() => onRewind(item)}>
                  <Rewind />
                </button>
              )}
            </div>
          )}
          <div className="msg-user">
            {item.attachments?.length ? (
              <>
                {item.text && <div className="msg-user-text">{item.text}</div>}
                <ul className="msg-files" aria-label="Attached files">
                  {item.attachments.map((a, i) => (
                    <li key={i} className="msg-file" title={`${a.name}, ${formatBytes(a.size)}`}>
                      {a.name}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              item.text
            )}
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="msg-assistant">
          {blocksOf(item).slice(from, to).map((b, i) => (
            <BlockView key={i} block={b} open={open} />
          ))}
        </div>
      );
    case "turn":
      return <TurnFooter item={item} />;
    case "error":
      return (
        <div className="chat-error" role="alert">
          <strong>{item.message}</strong>
          {item.hint && <span>{item.hint}</span>}
          {item.stderr && item.stderr.length > 0 && <pre className="mono">{item.stderr.join("\n")}</pre>}
        </div>
      );
    case "retry":
      return (
        <div className="chat-quiet">
          Retrying{item.attempt !== undefined ? ` (attempt ${item.attempt}${item.max ? ` of ${item.max}` : ""})` : ""}…
        </div>
      );
    case "notice":
      return <div className="chat-quiet">{item.text}</div>;
    case "ended":
      return <div className="chat-ended">{endedText(item.reason, item.code)}</div>;
  }
});

function TurnFooter({ item }: { item: Extract<ChatItem, { type: "turn" }> }) {
  const parts: string[] = [];
  if (item.durationMs !== undefined) parts.push(formatDuration(item.durationMs));
  if (item.costUsd) parts.push(formatCost(item.costUsd));
  if (item.status === "error") {
    return (
      <div className="chat-error" role="alert">
        <strong>The turn failed.</strong>
        {item.message && <span>{item.message}</span>}
        {parts.length > 0 && <span className="chat-turn-meta">{parts.join(" · ")}</span>}
      </div>
    );
  }
  return (
    <div className="chat-turn">
      {item.status === "interrupted" && <span>Interrupted</span>}
      {parts.map((p) => (
        <span key={p}>{p}</span>
      ))}
    </div>
  );
}

function BlockView({ block, open }: { block: Block; open: boolean }) {
  switch (block.type) {
    case "text":
      return block.text ? <Markdown text={block.text} /> : null;
    case "thinking":
      return (
        <details className="thinking">
          <summary>Thinking{block.tokens ? ` · ~${block.tokens} tokens` : ""}</summary>
          {block.text ? <div className="thinking-text">{block.text}</div> : <div className="thinking-text dim">Claude didn't share its thinking.</div>}
        </details>
      );
    case "tool":
      return <ToolLine block={block} open={open} />;
  }
}

function ToolLine({ block, open }: { block: Extract<Block, { type: "tool" }>; open: boolean }) {
  const summary = toolSummary(block.input) || partialToolSummary(block.partialInput ?? "");
  const state = block.result ? (block.result.isError ? "error" : "ok") : open ? "running" : "stopped";
  return (
    <details className={`tool tool-${state}`}>
      <summary>
        <ToolIcon state={state} />
        <span className="tool-name">{block.name}</span>
        <span className="mono tool-summary">{summary}</span>
      </summary>
      <div className="tool-body">
        <div className="eyebrow">Input</div>
        <pre className="mono">{Object.keys(block.input).length ? JSON.stringify(block.input, null, 2) : block.partialInput || "{}"}</pre>
        {block.result && (
          <>
            <div className="eyebrow">{block.result.isError ? "Error" : "Result"}</div>
            <pre className="mono">{block.result.text || "(no output)"}</pre>
          </>
        )}
      </div>
    </details>
  );
}

function ToolIcon({ state }: { state: "ok" | "error" | "running" | "stopped" }) {
  if (state === "running") return <span className="spinner" aria-label="Running" />;
  if (state === "ok")
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" aria-label="Done">
        <path d="M3 7.4l2.6 2.6L11 4.5" fill="none" stroke={COLORS.running} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (state === "error")
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" aria-label="Failed">
        <path d="M4 4l6 6M10 4l-6 6" stroke={COLORS.failed} strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    );
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-label="Stopped">
      <path d="M4 7h6" stroke={COLORS.stopped} strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
