import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { formatBytes, LIVE_SESSION_STATUSES, type LoginAccount, type SessionInfo } from "@kumiko/shared";
import { api, errorMessage, type SessionStream } from "./api";
import { fromAttachment, toInput } from "./attachments";
import { ArtifactsButton } from "./ArtifactView";
import { applyEvent, backgroundAgents, startsTurn, unpromptedText, blocksOf, chatRows, emptyChat, loginCards, partialToolSummary, summarize, toolState, toolSummary, type Block, type ChatItem, type ChatState, type ItemRow, type LoginAnswer, type Subagent, type ToolState, type WorkRow } from "./chat";
import { Composer, type ComposerHandle } from "./Composer";
import { HeaderCorner } from "./Corner";
import { Markdown } from "./Markdown";
import { ConfirmDialog } from "./ConfirmDialog";
import { drafts } from "./drafts";
import { endedText, formatCost, formatDuration, formatTokens, planName } from "./format";
import { Fork, Rewind } from "./icons";
import { LoginDialog } from "./LoginDialog";
import { QuoteButton } from "./QuoteButton";
import { Select } from "./Select";
import { COLORS } from "./status";
import { UsageStrip } from "./UsageStrip";
import { widgetLine } from "./widgets";
import { WindowContext } from "./windowContext";

/** How long the note that Claude restarted, or that the sandbox started, stays. */
const RESTARTED_MS = 4000;
/** How long it takes to fade away; as `.banner-success.is-fading` does. */
const FADE_MS = 650;

const MODELS = ["default", "opus", "sonnet", "haiku"];
/** Commands Kumiko handles itself, since Claude can't run them headless; offered alongside Claude's own. */
const OWN_COMMANDS = ["fork", "rewind"];

interface Props {
  session: SessionInfo;
  /** The session's events, which its window streams. */
  stream: SessionStream;
  /** The composer, for the window's other widgets to quote into. */
  composerRef?: RefObject<ComposerHandle | null>;
  /** A fork, or a session Claude asked for, was started; opens its tab. */
  onForked(id: string): void;
  /** Its tab is the one on screen. */
  active?: boolean;
}

/**
 * Tells the server the user has seen the session whenever it has something unread while it is on screen: its tab is
 * the active one, and the window is visible.
 */
function useMarkSeen(session: SessionInfo, active: boolean) {
  const { id, unread } = session;
  useEffect(() => {
    if (!unread || !active) return;
    const mark = () => {
      if (document.visibilityState === "visible") api.seen(id).catch(() => {});
    };
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [id, unread, active]);
}

/** The chat widget: its usage in the title bar's corner, the chat folded from its events, and the composer. */
export function SessionView({ session, stream, onForked, composerRef, active = true }: Props) {
  // The title bar's corner is the tab on screen's.
  const headerCorner = useContext(HeaderCorner);
  const corner = active ? headerCorner : undefined;
  useMarkSeen(session, active);
  const chat = useChat(stream.events);
  const totalCost = useMemo(() => chat.items.reduce((sum, i) => sum + (i.type === "turn" ? (i.costUsd ?? 0) : 0), 0), [chat.items]);
  // What was sent so far, for Up in the composer; a message sent again right after itself is there once.
  const history = useMemo(
    () => chat.items.flatMap((i) => (i.type === "user" ? [i.text] : [])).filter((t, n, all) => t && t !== all[n - 1]),
    [chat.items],
  );
  const [error, setError] = useState<string | undefined>();
  const [model, setModel] = useState("");
  // The message a rewind was asked for, until it is confirmed or dropped.
  const [rewinding, setRewinding] = useState<Extract<ChatItem, { type: "user" }> | undefined>();
  const [restoreFiles, setRestoreFiles] = useState(false);
  useEffect(() => setRestoreFiles(false), [rewinding]);
  // Bumped by a rewind, so the composer starts again from the draft it left.
  const [composerKey, setComposerKey] = useState(0);
  const [loggingIn, setLoggingIn] = useState(false);
  // Starting the sandbox of a session opened asleep; it wakes once that is done, which says so for a moment and fades
  // away, however the sandbox was started.
  const [waking, setWaking] = useState(false);
  const [woke, setWoke] = useState<"done" | "fading">();
  const wasAsleep = useRef(session.asleep);
  useEffect(() => {
    if (wasAsleep.current && !session.asleep) {
      setWaking(false);
      setWoke("done");
    }
    wasAsleep.current = session.asleep;
  }, [session.asleep]);
  useEffect(() => {
    if (!woke) return;
    const t = setTimeout(() => setWoke(woke === "done" ? "fading" : undefined), woke === "done" ? RESTARTED_MS : FADE_MS);
    return () => clearTimeout(t);
  }, [woke]);
  // Restarting Claude for Kumiko's new tools: under way, then done, which says so for a moment and fades away.
  const [restart, setRestart] = useState<"pending" | "done" | "fading">();
  // Restarted by Kumiko on its own, once idle: said the same way.
  const wasOutdated = useRef(session.toolsOutdated);
  useEffect(() => {
    if (wasOutdated.current && !session.toolsOutdated && LIVE_SESSION_STATUSES.includes(session.status)) setRestart("done");
    wasOutdated.current = session.toolsOutdated;
  }, [session.toolsOutdated, session.status]);
  useEffect(() => {
    if (restart !== "done" && restart !== "fading") return;
    const t = setTimeout(() => setRestart(restart === "done" ? "fading" : undefined), restart === "done" ? RESTARTED_MS : FADE_MS);
    return () => clearTimeout(t);
  }, [restart]);
  const ownComposer = useRef<ComposerHandle>(null);
  const composer = composerRef ?? ownComposer;
  // Back on screen, the cursor goes in the box, as when the tab first opened.
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) composer.current?.focus();
    wasActive.current = active;
  }, [active, composer]);
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

  // When a prompt sent while this tab is open fails for want of a login, the login opens straight away. A card in the
  // history replayed on opening the tab doesn't, even while Claude is still working past it.
  useEffect(() => {
    if (open && stream.history !== undefined && Number(open) > stream.history) setLoggingIn(true);
  }, [open, stream.history]);

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
  /** The user's answer to Claude asking to start a session; accepted, its tab opens. */
  const answerProposal = (item: ProposalItem, accept: boolean, prompt?: string) =>
    call(() =>
      api.answerProposal(session.id, item.id, accept, prompt).then(({ id, skipped }) => {
        if (id) onForked(id);
        // Started, but without some of what it was to be given.
        if (skipped?.length) setError(`The session started without some artifacts: ${skipped.join(" ")}`);
      }),
    );

  return (
    <div className="session">
      {corner && createPortal(<UsageStrip sessionId={session.id} live={live} turnDone={idle} cost={totalCost} bufferBytes={session.bufferBytes} />, corner)}

      <Chat
        chat={chat}
        running={busy}
        live={live}
        active={active}
        onRewind={canBranch ? setRewinding : undefined}
        onFork={canBranch ? (item) => void fork(item.id) : undefined}
        onQuote={(quoted) => composer.current?.insertQuote(quoted)}
        onAnswer={answerProposal}
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
        {session.asleep && (
          <div className="banner banner-info">
            <span className="banner-text">
              {waking ? "Starting the sandbox…" : "Start the sandbox to resume this session."}
            </span>
            <button
              type="button"
              className="btn btn-primary btn-compact"
              disabled={waking}
              onClick={async () => {
                setWaking(true);
                if (!(await call(() => api.wakeSession(session.id)))) setWaking(false);
              }}
            >
              {waking ? "Starting…" : "Start sandbox"}
            </button>
          </div>
        )}
        {woke && (
          <div className={`banner banner-success${woke === "fading" ? " is-fading" : ""}`} role="status">
            Sandbox started. Claude is ready to continue.
          </div>
        )}
        {session.toolsOutdated && live && !idle && restart === undefined && (
          <div className="banner banner-info" role="status">
            Claude restarts after this turn, for Kumiko's new tools.
          </div>
        )}
        {session.toolsOutdated && live && idle && restart !== "done" && restart !== "fading" && (
          // Kumiko restarts an idle Claude on its own, so this is there for a moment, or if that failed.
          <div className="banner banner-warn">
            <span className="banner-text">Claude needs a restart for Kumiko's new tools.</span>
            <button
              type="button"
              className="btn btn-compact"
              disabled={restart === "pending"}
              onClick={async () => {
                setRestart("pending");
                setRestart((await call(() => api.restartClaude(session.id))) ? "done" : undefined);
              }}
            >
              {restart === "pending" ? "Restarting…" : "Restart Claude"}
            </button>
          </div>
        )}
        {(restart === "done" || restart === "fading") && (
          <div className={`banner banner-success${restart === "fading" ? " is-fading" : ""}`} role="status">
            Claude restarted with Kumiko's new tools.
          </div>
        )}
        <Composer
          key={composerKey}
          ref={composer}
          label="Message Claude"
          commands={session.commands && [...session.commands, ...OWN_COMMANDS.filter((c) => !session.commands!.includes(c))]}
          suggestion={chat.suggestion}
          history={history}
          draftKey={session.id}
          submitLabel="Send"
          placeholder={live ? "Message Claude…" : session.asleep ? "Start the sandbox to continue." : "This session has ended."}
          disabled={!live || session.status === "starting"}
          onStop={session.status === "running" ? () => void call(() => api.interrupt(session.id)) : undefined}
          onSubmit={(text, files) => {
            // Claude can't log in or fork from here, but Kumiko can.
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
              <ArtifactsButton />
            </>
          }
        />
      </div>
    </div>
  );
}

/** Folds events into the chat incrementally: only new events are applied, and unchanged items keep their identity. */
function useChat(events: SessionStream["events"]): ChatState {
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
type ProposalItem = Extract<ChatItem, { type: "proposal" }>;
/** Answers a proposal; `prompt` is the one to start it on, if the user changed Claude's. */
type AnswerProposal = (item: ProposalItem, accept: boolean, prompt?: string) => Promise<boolean>;

/**
 * Claude asking to start a new session on a prompt: the prompt, which the user can change, and Start or Decline until
 * they answer.
 */
function ProposalCard({ item, onAnswer }: { item: ProposalItem; onAnswer?: AnswerProposal }) {
  const [sending, setSending] = useState<boolean | undefined>();
  const [prompt, setPrompt] = useState(item.prompt);
  const edited = prompt !== item.prompt;
  const answer = async (accept: boolean) => {
    setSending(accept);
    if (!(await onAnswer!(item, accept, accept && edited ? prompt : undefined))) setSending(undefined);
  };
  const answered = item.accepted !== undefined;
  const editable = !answered && onAnswer;
  return (
    <div className={`chat-proposal${answered ? " is-answered" : ""}`} role={answered ? undefined : "group"} aria-label="Claude asks to start a new session">
      <strong>{item.title ? `Claude asks to start a new session, "${item.title}":` : "Claude asks to start a new session:"}</strong>
      {editable ? (
        <textarea
          className="chat-proposal-prompt"
          aria-label="The new session's prompt"
          value={prompt}
          disabled={sending !== undefined}
          onChange={(e) => setPrompt(e.target.value)}
        />
      ) : (
        <div className="chat-proposal-prompt">{item.prompt}</div>
      )}
      {item.artifacts && (
        <span className="chat-proposal-artifacts">
          With {item.artifacts.length > 1 ? "copies of these artifacts" : "a copy of this artifact"}: {item.artifacts.map((p) => p.split("/").pop()).join(", ")}
        </span>
      )}
      {answered ? (
        <span className="chat-proposal-answer">{item.accepted ? "Started in a tab of its own." : "Declined."}</span>
      ) : (
        onAnswer && (
          <div className="chat-error-actions">
            <span>It starts in this project, in a tab of its own, with nothing of this conversation but the prompt, which you can change first.</span>
            <span className="chat-proposal-buttons">
              <button type="button" className="btn btn-secondary btn-compact" disabled={sending !== undefined} onClick={() => void answer(false)}>
                Decline
              </button>
              <button type="button" className="btn btn-primary btn-compact" disabled={sending !== undefined || !prompt.trim()} onClick={() => void answer(true)}>
                {sending === true ? "Starting…" : "Start session"}
              </button>
            </span>
          </div>
        )
      )}
    </div>
  );
}


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
  /** Claude is there: subagents it started in the background may still be working. */
  live: boolean;
  /** On screen; a chat kept in a background tab isn't. */
  active: boolean;
  onRewind?: (item: UserItem) => void;
  onFork?: (item: UserItem) => void;
  /** Text selected in the chat, quoted, to go in the message. */
  onQuote(quoted: string): void;
  /** Answers Claude asking to start a session; resolves to whether that went through. */
  onAnswer?: AnswerProposal;
  /** Shown in place of one item: the logged-out card, with Log in, or once logged in, the green one with Retry. */
  actions?: { key: string; node: ReactNode };
  /** Items not to show at all. */
  hidden?: ReadonlySet<string>;
}

/**
 * What tool lines need to show subagents: theirs is kept apart from the items, so memoised rows needn't re-render for
 * each of their messages.
 */
interface AgentsView {
  agents: Record<string, Subagent>;
  live: boolean;
  /** Opening a fold, which mustn't scroll it away by following the bottom. */
  onUnfold(): void;
}
const AgentsContext = createContext<AgentsView>({ agents: {}, live: false, onUnfold: () => {} });

function Chat({ chat, running, live, active, onRewind, onFork, onQuote, onAnswer, actions, hidden }: ChatProps) {
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  // Follows new output while the view is at the bottom; scrolling up stops that until it is back at the bottom.
  const stick = useRef(true);
  const userCount = chat.items.filter((i) => i.type === "user").length;
  // A chat kept in a background tab measures as empty; following it there would lose its place.
  const shown = (el: HTMLElement) => el.clientHeight > 0;

  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current && shown(el)) el.scrollTop = el.scrollHeight;
  }, [chat, running, active]);

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
      if (stick.current && shown(el)) el.scrollTop = el.scrollHeight;
    });
    follow.observe(el);
    follow.observe(inner.current);
    return () => follow.disconnect();
  }, []);

  // Tool calls after the last turn's end are still in flight while the session runs.
  const lastTurn = chat.items.findLastIndex((i) => i.type === "turn" || i.type === "ended");
  const rows = useMemo(() => chatRows(chat.items), [chat.items]);
  const agents = useMemo<AgentsView>(() => ({ agents: chat.agents, live, onUnfold: () => (stick.current = false) }), [chat.agents, live]);
  const background = live ? backgroundAgents(chat.agents) : [];
  /** The Agent call to bring into view, opening the work it is folded into; `n` tells a second Show from the first. */
  const [reveal, setReveal] = useState<{ id: string; n: number }>();
  useEffect(() => {
    if (!reveal) return;
    stick.current = false;
    // After the work has unfolded, so the line is where it will stay.
    const t = setTimeout(() => box.current?.querySelector(`[data-tool="${CSS.escape(reveal.id)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }), FOLD_MS);
    return () => clearTimeout(t);
  }, [reveal]);
  const toolIds = (row: WorkRow) => row.rows.flatMap((r) => (r.item.type === "assistant" ? blocksOf(r.item).slice(r.from, r.to) : [])).flatMap((b) => (b.type === "tool" ? [b.id] : []));
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
        onAnswer={onAnswer}
        actions={actions?.key === row.item.key ? actions.node : undefined}
      />
    );

  return (
    <>
    <div
      ref={box}
      className="chat"
      role="log"
      aria-live="polite"
      onScroll={(e) => {
        const el = e.currentTarget;
        if (shown(el)) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      <div ref={inner} className="chat-inner">
        <AgentsContext.Provider value={agents}>
        {rows.map((row) => {
          if (row.type !== "work") return itemRow(row);
          const ids = toolIds(row);
          return (
            <Work key={row.key} row={row} onUnfold={agents.onUnfold} agents={ids.filter((id) => background.includes(id)).length} reveal={reveal && ids.includes(reveal.id) ? reveal.n : undefined}>
              {row.rows.map(itemRow)}
            </Work>
          );
        })}
        </AgentsContext.Provider>
        {!running &&
          background.map((id) => (
            <div key={id} className="agent-background">
              <span className="spinner" aria-hidden="true" />
              <span className="agent-background-name">{chat.agents[id].description || "A subagent"}</span>
              <span className="agent-background-what">is working in the background</span>
              {chat.agents[id].activity && <span className="agent-background-now">· {chat.agents[id].activity}</span>}
              <button type="button" className="tool-show" onClick={() => setReveal((r) => ({ id, n: (r?.n ?? 0) + 1 }))}>
                Show
              </button>
            </div>
          ))}
        {running && chat.items.length > 0 && startsTurn(chat.items.at(-1)!) && (
          <div className="chat-waiting">
            <span className="spinner" aria-hidden="true" /> Waiting for Claude…
          </div>
        )}
      </div>
    </div>
    {/* Outside the log, so it isn't read out as new output. */}
    <QuoteButton root={box} onQuote={onQuote} />
    </>
  );
}

/** How long a finished turn's work stays open before folding, so the reply is seen to arrive first. */
const FOLD_DELAY_MS = 250;
/** How long folding and unfolding take; as `.work-body`'s transition does. */
const FOLD_MS = 360;

/**
 * A turn's work. Open while the turn runs; once it is done it folds, with an animation if it was watched running, and
 * shows a line summing it up that opens it again.
 */
interface WorkProps {
  row: Pick<WorkRow, "done" | "summary" | "tools">;
  onUnfold(): void;
  /** Subagents in it still working in the background, which its summary says. */
  agents?: number;
  /** Opens it when it changes. */
  reveal?: number;
  children: ReactNode;
}

function Work({ row, onUnfold, agents, reveal, children }: WorkProps) {
  const [folded, setFolded] = useState(row.done);
  const watched = useRef(!row.done);
  useEffect(() => {
    if (!row.done || !watched.current) return;
    watched.current = false;
    const t = setTimeout(() => setFolded(true), FOLD_DELAY_MS);
    return () => clearTimeout(t);
  }, [row.done]);
  useEffect(() => {
    if (reveal !== undefined) setFolded(false);
  }, [reveal]);

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
          {agents ? (
            <span className="work-agents">
              <span className="spinner" aria-hidden="true" />
              {agents === 1 ? "1 agent working" : `${agents} agents working`}
            </span>
          ) : null}
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
  onAnswer?: AnswerProposal;
  actions?: ReactNode;
}

const Item = memo(function Item({ item, from, to, open, onRewind, onFork, onAnswer, actions }: ItemProps) {
  if (actions) return <>{actions}</>;
  switch (item.type) {
    case "user":
      // Only prompts Claude has echoed are in its history, so only those can be branched from.
      return (
        <div className="msg-user-row">
          {item.replayed && (onRewind || onFork) && (
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
    case "unprompted":
      return <div className="chat-unprompted">{unpromptedText(item.after)}</div>;
    case "proposal":
      return <ProposalCard item={item} onAnswer={onAnswer} />;
    case "shared":
      return (
        <div className="chat-quiet">
          {`"${item.name}" shared ${item.titles.map((t) => `"${t}"`).join(", ")} with this session; ${item.titles.length > 1 ? "they're" : "it's"} in the window's artifacts. `}
          {item.told ? "Claude was told with your next message." : "Claude hears of it with your next message."}
        </div>
      );
    case "ended":
      return <div className="chat-ended">{endedText(item.reason, item.code)}</div>;
  }
});

function TurnFooter({ item }: { item: Extract<ChatItem, { type: "turn" }> }) {
  const parts: string[] = [];
  if (item.durationMs !== undefined) parts.push(formatDuration(item.durationMs));
  if (item.costUsd) parts.push(formatCost(item.costUsd));
  if (item.tokens) parts.push(`${formatTokens(item.tokens.total)} tokens (${formatTokens(item.tokens.cached)} cached)`);
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
  const { agents, live, onUnfold } = useContext(AgentsContext);
  const agent = agents[block.id];
  const state = toolState(block, open, live, agent);
  if (!agent) return <ToolCall block={block} state={state} />;
  const blocks = agent.items.flatMap(blocksOf);
  const { summary, tools } = summarize(blocks);
  const calls = blocks.filter((b) => b.type === "tool").length || agent.usage?.toolUses || 0;
  // Once it is done, the summary of its work says the rest.
  const meta = [
    state === "running" && agent.activity,
    (state === "running" || !blocks.length) && calls > 0 && (calls === 1 ? "1 tool call" : `${calls} tool calls`),
    state !== "running" && agent.background && agent.usage?.durationMs && formatDuration(agent.usage.durationMs),
  ].filter(Boolean);
  return (
    <div className="agent" data-tool={block.id}>
      <ToolCall
        block={block}
        state={state}
        meta={
          <span className="agent-meta">
            {agent.background && <span className="agent-badge">background</span>}
            {meta.length > 0 && <span>{meta.join(" · ")}</span>}
          </span>
        }
      />
      {blocks.length > 0 && (
        <div className="agent-work">
          <Work row={{ done: state !== "running", summary, tools }} onUnfold={onUnfold}>
            {blocks.map((b, i) => (
              <BlockView key={i} block={b} open={state === "running"} />
            ))}
          </Work>
        </div>
      )}
    </div>
  );
}

/** One tool call's line, opening to its input and result; `meta` goes at its right. */
function ToolCall({ block, state, meta }: { block: Extract<Block, { type: "tool" }>; state: ToolState; meta?: ReactNode }) {
  const ctx = useContext(WindowContext);
  // A call that opened, changed or closed something in the window says so in words, with a way back to a closed artifact.
  const line = ctx && widgetLine(block.name, block.input, ctx.window, ctx.sessionNames);
  const hidden = line?.widget && !Object.values(ctx!.window.panes).includes(line.widget);
  const summary = toolSummary(block.input) || partialToolSummary(block.partialInput ?? "");
  return (
    <details className={`tool tool-${state}${line ? " tool-widget" : ""}`}>
      <summary>
        <ToolIcon state={state} />
        <span className="tool-name">{line?.label ?? block.name}</span>
        {line ? <span className="tool-summary tool-title">{line.title}</span> : <span className="mono tool-summary">{summary}</span>}
        {meta}
        {hidden && ctx!.live && (
          <button
            type="button"
            className="tool-show"
            onClick={(e) => {
              // Not the summary's own click, which would open the details.
              e.preventDefault();
              ctx!.show(line!.widget!);
            }}
          >
            Show
          </button>
        )}
      </summary>
      <div className="tool-body">
        <div className="eyebrow">{line?.input?.label ?? "Input"}</div>
        <pre className="mono">{line?.input?.text ?? (Object.keys(block.input).length ? JSON.stringify(block.input, null, 2) : block.partialInput || "{}")}</pre>
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

function ToolIcon({ state }: { state: ToolState }) {
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
