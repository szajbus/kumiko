import { createContext, Fragment, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { formatBytes, LIVE_SESSION_STATUSES, shellCommand, type AskAnswer, type LoginAccount, type SessionInfo } from "@kumiko/shared";
import { api, errorMessage, type SessionStream } from "./api";
import { fromAttachment, toInput } from "./attachments";
import { ArtifactsButton } from "./ArtifactView";
import { AskCard, AskContext } from "./AskCard";
import { CardContext, type CardAction } from "./ApprovalCard";
import { applyEvent, backgroundAgents, startsTurn, unpromptedPlain, blocksOf, chatRows, emptyChat, inputSections, loginCards, partialToolSummary, summarize, toolState, toolSummary, type Block, type ChatItem, type ChatState, type ItemRow, type LoginAnswer, type Subagent, type ToolState, type WorkRow } from "./chat";
import { codeWrap } from "./codeWrap";
import { branchLimits, lastCompaction } from "./compaction";
import { CompactionLine, ContextMeterView, useContextState } from "./CompactionLine";
import { Composer, type ComposerHandle } from "./Composer";
import { HeaderCorner } from "./Corner";
import { Markdown } from "./Markdown";
import { ConfirmDialog } from "./ConfirmDialog";
import { Highlighted } from "./Highlighted";
import { rowKey, useRowTokens } from "./highlight";
import { fileDiff, lineCount, newText, shortPath, shownRows, workChanges, type Changes, type FileDiff } from "./diff";
import { drafts } from "./drafts";
import { endedText, formatCost, formatDuration, formatTokens, planName } from "./format";
import { Fork, Rewind } from "./icons";
import { LoginDialog } from "./LoginDialog";
import { QuoteButton } from "./QuoteButton";
import { Select } from "./Select";
import { ShellCard, UserShellsContext, type UserShellsView } from "./ShellCard";
import { applyShellEvent, type UserShells } from "./userShell";
import { COLORS } from "./status";
import { UsageStrip } from "./UsageStrip";
import { useFold } from "./useFold";
import { WakeBanner, type WakeContext } from "./WakeBanner";
import { toolLine, toolName } from "./toolNames";
import { widgetLine } from "./widgets";
import { WindowContext } from "./windowContext";
import { focusThread } from "./review";
import { MonitorEvents, MonitorLine, MoveToBackground, onReveal, PlainLine, TaskEndLine, TasksButton, TaskToolMeta } from "./TasksPane";
import { emptyTasks, foldMonitorTurns, type TasksState } from "./tasks";

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
  /** While it is asleep, its sandbox and the sandbox's log. */
  wake?: WakeContext;
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
export function SessionView({ session, stream, onForked, composerRef, active = true, wake }: Props) {
  // The title bar's corner is the tab on screen's.
  const headerCorner = useContext(HeaderCorner);
  const corner = active ? headerCorner : undefined;
  useMarkSeen(session, active);
  const chat = useChat(stream.events);
  const shells = useFold<UserShells>(stream.events, () => ({}), (state, added) => added.reduce(applyShellEvent, state));
  const context = useContextState(stream.events);
  const totalCost = useMemo(() => chat.items.reduce((sum, i) => sum + (i.type === "turn" ? (i.costUsd ?? 0) : 0), 0), [chat.items]);
  // What was sent so far, for Up in the composer; a message sent again right after itself is there once.
  const history = useMemo(
    () => [...chat.items, ...chat.queued].flatMap((i) => (i.type === "user" && !i.review ? [i.text] : [])).filter((t, n, all) => t && t !== all[n - 1]),
    [chat.items, chat.queued],
  );
  const [error, setError] = useState<string | undefined>();
  // Messages taken back from the queue, until the chat hears so.
  const [takenBack, setTakenBack] = useState<string[]>([]);
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
  // The last message waiting for Claude can be taken back to be edited; not one with files, which the box can't get
  // back, nor a command's, which has run.
  const waiting = chat.queued.filter((i) => !takenBack.includes(i.id) && !i.shell && !i.review).at(-1);
  const takeBack =
    live && waiting && !waiting.attachments?.length
      ? async () => {
          setError(undefined);
          try {
            const { withdrawn } = await api.withdrawPrompt(session.id, waiting.id);
            if (!withdrawn) return void setError("Claude has read that message already.");
            setTakenBack((ids) => [...ids, waiting.id]);
            return waiting.text;
          } catch (err) {
            setError(errorMessage(err));
            return undefined;
          }
        }
      : undefined;

  const login = useMemo(() => loginCards(chat.items, answer), [chat.items, answer]);
  const shellsView = useMemo<UserShellsView>(() => ({ shells, session: session.id, live }), [shells, session.id, live]);
  const open = login.open;

  // A logged-out card that is still the last word may be out of date (logged in from another session, or before a
  // reload): ask whether the sandbox is logged in now. Nothing shows until the answer is in.
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
  /** The user's answer to what Claude asked mid-turn. */
  const answerAsk = (ask: string, answer: AskAnswer) => call(() => api.answerAsk(session.id, ask, answer));
  const decideCard = (ask: string, action: CardAction) => call(() => api.decideCard(session.id, ask, action));
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
      {corner && createPortal(<UsageStrip sessionId={session.id} live={live} turnDone={idle} cost={totalCost} bufferBytes={session.bufferBytes} context={context} items={chat.items} />, corner)}

      <AskContext.Provider value={live ? answerAsk : undefined}>
      <CardContext.Provider value={live ? decideCard : undefined}>
        <UserShellsContext.Provider value={shellsView}>
        <Chat
          session={session.id}
          chat={chat}
          workdir={session.workdir}
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
                <LoggedOutCard sandbox={session.sandbox} onLogIn={() => setLoggingIn(true)} />
              ),
            }
          }
        />
      </UserShellsContext.Provider>
      </CardContext.Provider>
      </AskContext.Provider>

      {loggingIn && (
        <LoginDialog
          sessionId={session.id}
          sandbox={session.sandbox}
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
          <WakeBanner
            wake={wake}
            waking={waking}
            onStart={async () => {
              setWaking(true);
              if (!(await call(() => api.wakeSession(session.id)))) setWaking(false);
            }}
          />
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
          onTakeBack={takeBack}
          shell={live ? { cwd: session.workdir } : undefined}
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
            const command = shellCommand(text);
            if (command !== undefined) return call(() => api.runShell(session.id, command));
            return call(() => api.prompt(session.id, text, files.map(toInput)));
          }}
          autoFocus
          footer={
            <>
              <Select
                compact
                value={session.planMode ? "plan" : "bypass"}
                className={session.planMode ? "mode-plan" : "mode-bypass"}
                title={session.planMode ? "Claude plans first, and waits for you to approve the plan before it changes anything." : "Claude runs tools without asking for permission. The sandbox is the boundary."}
                disabled={!live || session.status === "starting"}
                groups={[{ options: ["bypass", "plan"] }]}
                labels={{ bypass: "Bypass permissions", plan: "Plan first" }}
                onValueChange={(v) => void call(() => api.setPlanMode(session.id, v === "plan"))}
              />
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
              <ContextMeterView context={context} onCompact={live ? () => void call(() => api.prompt(session.id, "/compact")) : undefined} />
              <TasksButton session={session.id} tasks={chat.tasks} live={live} active={active} />
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
  return useFold(events, emptyChat, (state, added) => added.reduce(applyEvent, state));
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
            <span>It starts in this sandbox, in a tab of its own, with nothing of this conversation but the prompt, which you can change first.</span>
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


/** In place of the last logged-out card, while the sandbox still isn't logged in. */
function LoggedOutCard({ sandbox, onLogIn }: { sandbox: string; onLogIn(): void }) {
  return (
    <div className="chat-error" role="alert">
      <strong>Claude isn't logged in.</strong>
      <div className="chat-error-actions">
        <span>Log in once for the sandbox {sandbox}; all its sessions use it.</span>
        <button type="button" className="btn btn-primary btn-compact" onClick={onLogIn}>
          Log in
        </button>
      </div>
    </div>
  );
}

/** In place of the last logged-out card once the sandbox is logged in, offering to send the failed prompt again. */
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
  session: string;
  chat: ChatState;
  /** Where Claude works: the paths in tool lines are shown relative to it. */
  workdir?: string;
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
  /** Claude's background tasks, and the session they are in. */
  tasks: TasksState;
  session: string;
  live: boolean;
  /** Opening a fold, which mustn't scroll it away by following the bottom. */
  onUnfold(): void;
  workdir?: string;
}
const AgentsContext = createContext<AgentsView>({ agents: {}, tasks: emptyTasks(), session: "", live: false, onUnfold: () => {} });

function Chat({ session, chat, workdir, running, live, active, onRewind, onFork, onQuote, onAnswer, actions, hidden }: ChatProps) {
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  // Follows new output while the view is at the bottom; scrolling up stops that until it is back at the bottom.
  const stick = useRef(true);
  const { shells } = useContext(UserShellsContext);
  const unsent = useMemo(() => unsentShells(shells, chat), [shells, chat]);
  const userCount = chat.items.filter((i) => i.type === "user").length + chat.queued.length + Object.keys(shells).length;
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
  const rows = useMemo(() => foldMonitorTurns(chatRows(chat.items)), [chat.items]);
  const agents = useMemo<AgentsView>(() => ({ agents: chat.agents, tasks: chat.tasks, session, live, onUnfold: () => (stick.current = false), workdir }), [chat.agents, chat.tasks, session, live, workdir]);
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
  // The Tasks pane's Show in chat, for a subagent.
  useEffect(() => onReveal(session, (id) => setReveal((r) => ({ id, n: (r?.n ?? 0) + 1 }))), [session]);
  const workBlocks = (row: WorkRow) => row.rows.flatMap((r) => (r.item.type === "assistant" ? blocksOf(r.item).slice(r.from, r.to) : []));
  const toolIds = (row: WorkRow) => workBlocks(row).flatMap((b) => (b.type === "tool" ? [b.id] : []));
  // Claude has only a summary of what's before its last compaction: that shows dimmed, and can't be gone back to.
  const compacted = useMemo(() => lastCompaction(chat.items), [chat.items]);
  const limits = useMemo(() => branchLimits(chat.items, compacted), [chat.items, compacted]);
  // Every row is in a box that takes no room of its own, so dimming one as a compaction passes it changes a class, not
  // what React mounts: a row unfolded stays so.
  const dim = (key: string, index: number, node: ReactNode) => (
    <div key={key} className={index < compacted ? "chat-row is-before" : "chat-row"}>
      {node}
    </div>
  );
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
        noRewind={limits.get(row.item.key)?.noRewind}
        noFork={limits.get(row.item.key)?.noFork}
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
          if (row.type === "monitor") return <MonitorEvents key={row.key} session={session} row={row} task={chat.tasks.byId[row.taskId]} />;
          if (row.type !== "work") return dim(row.from ? `${row.item.key}-${row.from}` : row.item.key, row.index, itemRow(row));
          // Only for saying which subagents work on in it, or opening it on Show: most renders need neither.
          const ids = background.length || reveal ? toolIds(row) : [];
          return dim(
            row.key,
            row.rows[0]?.index ?? 0,
            <Work key={row.key} row={row} changes={row.done ? workChanges(workBlocks(row), chat.agents) : undefined} onUnfold={agents.onUnfold} agents={ids.filter((id) => background.includes(id)).length} reveal={reveal && ids.includes(reveal.id) ? reveal.n : undefined}>
              {row.rows.map(itemRow)}
            </Work>,
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
        {/* Commands the user runs: each goes up into the chat as the prompt that gives it to Claude, once it ends. */}
        {unsent.map((id) => (
          <ShellCard key={id} id={id} prompted={false} />
        ))}
        {/* Sent while Claude works: they go up into the chat where Claude reads them. */}
        {chat.queued.map((item) => (
          <div key={item.key} className="msg-queued">
            <Item item={item} open={false} />
            <div className="msg-queued-note">Queued</div>
          </div>
        ))}
      </div>
    </div>
    {/* Outside the log, so it isn't read out as new output. */}
    <QuoteButton root={box} onQuote={onQuote} copy />
    </>
  );
}

/** Commands the user ran that the chat doesn't show yet: running, or ended and on their way to Claude. */
function unsentShells(shells: UserShells, chat: ChatState): string[] {
  const shown = new Set([...chat.items, ...chat.queued].flatMap((i) => (i.type === "user" && i.shell ? [i.shell] : i.type === "shell" ? [i.id] : [])));
  return Object.keys(shells).filter((id) => !shown.has(id));
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
  /** The files it changed, which its summary says. */
  changes?: Changes;
  onUnfold(): void;
  /** Subagents in it still working in the background, which its summary says. */
  agents?: number;
  /** Opens it when it changes. */
  reveal?: number;
  children: ReactNode;
}

function Work({ row, changes, onUnfold, agents, reveal, children }: WorkProps) {
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
          {changes && (
            <span className="work-changes">
              <span>{changes.files === 1 ? "1 file changed" : `${changes.files} files changed`}</span>
              <LineCounts added={changes.added} removed={changes.removed} />
            </span>
          )}
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
  /** A prompt before Claude's last compaction, which can't be rewound to, or forked from. */
  noRewind?: boolean;
  noFork?: boolean;
  onAnswer?: AnswerProposal;
  actions?: ReactNode;
}

/** Why a prompt before Claude's last compaction can't be rewound to or forked from. */
const COMPACTED = "Claude only has a summary of this now, so it can't go back here.";

const Item = memo(function Item({ item, from, to, open, onRewind, onFork, noRewind, noFork, onAnswer, actions }: ItemProps) {
  if (actions) return <>{actions}</>;
  switch (item.type) {
    case "shell":
      return <ShellCard id={item.id} prompted={false} />;
    case "user": {
      // Only prompts Claude has echoed are in its history, so only those can be branched from.
      const buttons = item.replayed && (onRewind || onFork) && (
        <div className="msg-actions">
          {onFork && (
            <button
              type="button"
              className={`btn btn-secondary btn-compact${noFork ? " is-off" : ""}`}
              title={noFork ? `${COMPACTED} Fork from a message after the last compaction.` : "Fork from here: a new tab with the conversation up to Claude's reply to this message"}
              aria-label="Fork from this message"
              aria-disabled={noFork || undefined}
              onClick={() => !noFork && onFork(item)}
            >
              <Fork />
            </button>
          )}
          {onRewind && (
            <button
              type="button"
              className={`btn btn-secondary btn-compact${noRewind ? " is-off" : ""}`}
              title={noRewind ? `${COMPACTED} Rewind to a message after the last compaction, or to the first one, which starts afresh.` : "Rewind to just before this message"}
              aria-label="Rewind to this message"
              aria-disabled={noRewind || undefined}
              onClick={() => !noRewind && onRewind(item)}
            >
              <Rewind />
            </button>
          )}
        </div>
      );
      // A command the user ran shows as itself, where the prompt that gave it to Claude is.
      if (item.shell) return <ShellCard id={item.shell} prompted actions={buttons} />;
      // A comment in a review thread, or what the user decided on a card Claude no longer waited on: one line, as
      // the thread or the card shows it all.
      if (item.review) return <ReviewLine review={item.review} />;
      return (
        <div className="msg-user-row">
          {buttons}
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
    }
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
      return <UnpromptedLine item={item} />;
    case "task_stop":
      return <TaskStopLine taskId={item.taskId} />;
    case "proposal":
      return <ProposalCard item={item} onAnswer={onAnswer} />;
    case "ask":
      return <AskCard item={item} />;
    case "shared":
      return (
        <div className="chat-quiet">
          {`"${item.name}" shared ${item.titles.map((t) => `"${t}"`).join(", ")} with this session; ${item.titles.length > 1 ? "they're" : "it's"} in the window's artifacts. `}
          {item.told ? "Claude was told with your next message." : "Claude hears of it with your next message."}
        </div>
      );
    case "ended":
      return <div className="chat-ended">{endedText(item.reason, item.code)}</div>;
    case "compaction":
      return <CompactionLine item={item} />;
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
  const { agents, live, onUnfold, tasks, session } = useContext(AgentsContext);
  const agent = agents[block.id];
  const state = toolState(block, open, live, agent);
  if (!agent) return <ShellToolLine block={block} state={state} tasks={tasks} session={session} live={live} />;
  const blocks = agent.items.flatMap(blocksOf);
  const { summary, tools } = summarize(blocks);
  const changes = state !== "running" ? workChanges(blocks, agents) : undefined;
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
          <Work row={{ done: state !== "running", summary, tools }} changes={changes} onUnfold={onUnfold}>
            {blocks.map((b, i) => (
              <BlockView key={i} block={b} open={state === "running"} />
            ))}
          </Work>
        </div>
      )}
    </div>
  );
}

/**
 * A tool call that isn't a subagent's: a Bash or Monitor call running in the background says so, with Show; one Claude
 * waits on can be moved there.
 */
function ShellToolLine({ block, state, tasks, session, live }: { block: Extract<Block, { type: "tool" }>; state: ToolState; tasks: TasksState; session: string; live: boolean }) {
  const task = tasks.byId[tasks.byTool[block.id] ?? ""];
  if (!task || task.kind === "agent") return <ToolCall block={block} state={state} />;
  if (task.background) {
    const own: ToolState = task.status === "running" ? (live ? "running" : "stopped") : task.status === "completed" ? "ok" : task.status === "failed" ? "error" : "stopped";
    return <ToolCall block={block} state={own} meta={<TaskToolMeta session={session} task={task} />} />;
  }
  if (task.status === "running" && state === "running" && !task.parent) return <ToolCall block={block} state={state} meta={<MoveToBackground session={session} toolUseId={block.id} />} />;
  return <ToolCall block={block} state={state} />;
}

/** Where Claude starts a turn of its own: what woke it, when that's known. */
function UnpromptedLine({ item }: { item: Extract<ChatItem, { type: "unprompted" }> }) {
  const { tasks, session } = useContext(AgentsContext);
  const ended = (item.ended ?? []).map((id) => tasks.byId[id]).filter(Boolean);
  const plain = unpromptedPlain(item.after, ended, Boolean(item.monitor));
  return (
    <>
      {plain !== undefined && <PlainLine text={plain} />}
      {ended.map((t) => (
        <TaskEndLine key={t.id} session={session} task={t} />
      ))}
      {item.monitor && <MonitorLine session={session} task={tasks.byId[item.monitor.taskId]} line={item.monitor.line} />}
    </>
  );
}

/** The user stopped a background task. */
function TaskStopLine({ taskId }: { taskId: string }) {
  const { tasks, session } = useContext(AgentsContext);
  const task = tasks.byId[taskId];
  return task ? <TaskEndLine session={session} task={{ ...task, stoppedByUser: true, status: task.status === "running" ? "stopped" : task.status }} /> : null;
}

/** One tool call's line, opening to its input and result; `meta` goes at its right. */
function ToolCall({ block, state, meta }: { block: Extract<Block, { type: "tool" }>; state: ToolState; meta?: ReactNode }) {
  const diff = fileDiff(block);
  if (diff) return <EditCall name={block.name} diff={diff} state={state} />;
  return <PlainToolCall block={block} state={state} meta={meta} />;
}

/** A file edit's line: the file and how many lines it added and removed, opening to the diff. */
function EditCall({ name, diff, state }: { name: string; diff: FileDiff; state: ToolState }) {
  const { workdir } = useContext(AgentsContext);
  const [open, setOpen] = useState(false);
  const { dir, name: file } = shortPath(diff.path, workdir);
  const failed = diff.error !== undefined;
  return (
    <details className={`tool tool-${state} tool-edit`} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary title={diff.path || undefined}>
        <ToolIcon state={state} />
        <span className="tool-name">{name}</span>
        <span className="mono tool-summary">
          <span className="tool-path-dir">{dir}</span>
          <span className="tool-path-name">{file}</span>
          {diff.cell && <span className="tool-path-dir"> · cell {diff.cell}</span>}
        </span>
        <span className="tool-stat">
          {diff.created && <span className="tool-tag tool-tag-new">new file</span>}
          {diff.rewrote && <span className="tool-tag">rewrote</span>}
          {diff.replaceAll && <span className="tool-tag">all occurrences</span>}
          {diff.userModified && <span className="tool-tag">changed by you</span>}
          {state === "running" ? (
            <span>{name === "Write" ? "writing…" : "editing…"}</span>
          ) : failed ? (
            <span className="tool-stat-error">{diff.error!.split("\n")[0].replace(/\.$/, "")}</span>
          ) : (
            state === "ok" && <LineCounts added={diff.added} removed={diff.removed} />
          )}
        </span>
      </summary>
      {open && (
        <div className="tool-body">
          {failed && <div className="tool-edit-error">{diff.error}</div>}
          {failed && diff.rows.length > 0 && <div className="eyebrow">What it tried</div>}
          {diff.rows.length > 0 ? <DiffView diff={diff} dim={failed} /> : !failed && <div className="tool-edit-note">{name === "Write" ? "An empty file." : "Nothing changed."}</div>}
          {diff.truncated && <div className="tool-edit-note">Kumiko kept only the start of this diff.</div>}
          {!diff.numbered && !failed && state === "ok" && name === "Edit" && <div className="tool-edit-note">No line numbers: Claude didn't say where in the file this was.</div>}
        </div>
      )}
    </details>
  );
}

/** Lines added and removed, as "+12 −3"; a side with none is left out. */
function LineCounts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="line-counts">
      {(added > 0 || removed === 0) && <span className="diff-added">+{added}</span>}
      {removed > 0 && <span className="diff-removed">−{removed}</span>}
    </span>
  );
}

/** A unified diff, cut when it is long, with the code blocks' Wrap and a Copy of its new side. */
function DiffView({ diff, dim }: { diff: FileDiff; dim: boolean }) {
  const [all, setAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const wrapped = useSyncExternalStore(codeWrap.subscribe, codeWrap.get);
  const rows = shownRows(diff.rows, all);
  // All the rows, shown or not, so showing the rest doesn't highlight again.
  const tokens = useRowTokens(diff.path, diff.rows);
  const total = lineCount(diff.rows);
  const hidden = total - lineCount(rows);
  // Old and new line numbers from a patch; a written file has only new ones.
  const columns = diff.fromPatch ? 2 : diff.numbered ? 1 : 0;
  const copy = () => {
    void navigator.clipboard.writeText(newText(diff.rows)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className={`diff md-code${wrapped ? " is-wrapped" : ""}${dim ? " is-dim" : ""}`}>
      <div className="diff-scroll">
        <table>
          <tbody>
            {rows.map((r, i) =>
              r.kind === "gap" ? (
                <tr key={i} className="diff-gap">
                  <td colSpan={columns + 2}>{r.skipped ? `⋯ ${r.skipped === 1 ? "1 unchanged line" : `${r.skipped} unchanged lines`}` : "⋯"}</td>
                </tr>
              ) : (
                <tr key={i} className={`diff-${r.kind}`}>
                  {columns === 2 && <td className="diff-n">{r.old}</td>}
                  {columns > 0 && <td className="diff-n">{r.new}</td>}
                  <td className="diff-sign">{r.kind === "add" ? "+" : r.kind === "remove" ? "−" : " "}</td>
                  <td className="diff-code">
                    <Highlighted text={r.text} tokens={tokens.get(rowKey(r))} mark={r.mark} markClass="diff-mark" />
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
      {hidden > 0 && (
        <div className="diff-more">
          <span>{hidden === 1 ? "1 more line" : `${hidden} more lines`}</span>
          <button type="button" className="link-btn" onClick={() => setAll(true)}>
            Show all {total} lines
          </button>
        </div>
      )}
      <div className="md-code-actions">
        <button
          type="button"
          className="md-code-btn"
          aria-pressed={wrapped}
          onClick={() => codeWrap.set(!wrapped)}
          title={wrapped ? "Stop wrapping long lines in code blocks" : "Wrap long lines in code blocks"}
        >
          Wrap
        </button>
        <button type="button" className="md-code-btn" onClick={copy} title="Copy the new text">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function PlainToolCall({ block, state, meta }: { block: Extract<Block, { type: "tool" }>; state: ToolState; meta?: ReactNode }) {
  const ctx = useContext(WindowContext);
  // A call that opened, changed or closed something in the window says so in words, with a way back to a closed artifact.
  const line = ctx && widgetLine(block.name, block.input, ctx.window, ctx.sessionNames);
  const hidden = line?.widget && !Object.values(ctx!.window.panes).includes(line.widget);
  // Kumiko's other tools, and loading tools, say what they did in words too; any other tool goes by its name.
  const words = line ? undefined : toolLine(block.name, block.input);
  const summary = toolSummary(block.input) || partialToolSummary(block.partialInput ?? "");
  return (
    <details className={`tool tool-${state}${line || words ? " tool-widget" : ""}`}>
      <summary>
        <ToolIcon state={state} />
        <span className="tool-name">{line?.label ?? words?.label ?? toolName(block.name)}</span>
        {line ? (
          <span className="tool-summary tool-title">{line.title}</span>
        ) : words ? (
          <span className={`tool-summary${words.mono ? " mono" : " tool-title"}`}>{words.title}</span>
        ) : (
          <span className="mono tool-summary">{summary}</span>
        )}
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
        {line?.input ? (
          <>
            <div className="eyebrow">{line.input.label}</div>
            <pre className="mono">{line.input.text}</pre>
          </>
        ) : Object.keys(block.input).length ? (
          inputSections(block.input).map((s) => (
            <Fragment key={s.label}>
              <div className="eyebrow">{s.label}</div>
              <pre className="mono">{s.text}</pre>
            </Fragment>
          ))
        ) : (
          <>
            <div className="eyebrow">Input</div>
            <pre className="mono">{block.partialInput || "{}"}</pre>
          </>
        )}
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

/** A user prompt that came from the review: one line, which opens the review pane on its thread. */
function ReviewLine({ review }: { review: { thread?: string; ask: string; where?: string } }) {
  const win = useContext(WindowContext);
  if (!review.thread) return <div className="chat-quiet">Told Claude what you decided on the card</div>;
  const open = () => {
    focusThread(review.ask, review.thread!);
    win?.review(review.ask, true);
  };
  return (
    <div className="chat-quiet chat-review-line">
      You commented on{" "}
      <button type="button" className="link-btn" onClick={open}>
        <code>{review.where ?? "the change"}</code>
      </button>
    </div>
  );
}
