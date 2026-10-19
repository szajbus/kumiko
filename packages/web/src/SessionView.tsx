import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { vmName, type SessionInfo } from "@bentomo/shared";
import { api, RequestError, useSessionEvents } from "./api";
import { applyEvent, blocksOf, emptyChat, partialToolSummary, toolSummary, type Block, type ChatItem, type ChatState } from "./chat";
import { Composer } from "./Composer";
import { Markdown } from "./Markdown";
import { Fork } from "./icons";
import { Select } from "./Select";
import { COLORS, sessionStatus } from "./status";

const MODELS = ["default", "opus", "sonnet", "haiku"];

interface Props {
  session: SessionInfo;
  /** A fork was started; opens its tab. */
  onForked(id: string): void;
}

/** One session: header, the chat streamed from its events, and the composer. */
export function SessionView({ session, onForked }: Props) {
  const stream = useSessionEvents(session.id);
  const chat = useChat(stream.events);
  const totalCost = useMemo(() => chat.items.reduce((sum, i) => sum + (i.type === "turn" ? (i.costUsd ?? 0) : 0), 0), [chat.items]);
  const [error, setError] = useState<string | undefined>();
  const [model, setModel] = useState("");
  // Claude reports a full model id; the dropdown lists aliases, so show the alias it belongs to.
  const reported = session.model ?? "";
  const alias = MODELS.find((m) => m !== "default" && reported.toLowerCase().includes(m));
  const currentModel = alias ?? reported;
  const modelOptions = currentModel && !MODELS.includes(currentModel) ? [...MODELS, currentModel] : MODELS;
  // Once Claude reports the model in use, that replaces what was picked.
  useEffect(() => setModel(""), [reported]);
  const status = sessionStatus(session.status);
  const live = session.status === "starting" || session.status === "idle" || session.status === "running";
  const busy = session.status === "starting" || session.status === "running";

  const call = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setError(undefined);
    try {
      await fn();
      return true;
    } catch (err) {
      setError(err instanceof RequestError ? err.message : String(err));
      return false;
    }
  };

  return (
    <div className="session">
      <div className="session-head">
        <div className="session-where">
          <span className="badge mono">{vmName(session.sandbox)}</span>
          <span className="mono dim session-workdir" title={session.workdir}>
            {session.workdir}
          </span>
          <span className="row-status session-status" style={{ color: status.color }}>
            {busy ? <span className="spinner" aria-hidden="true" /> : <span className="dot dot-small" style={{ background: status.color }} aria-hidden="true" />}
            {status.text}
          </span>
        </div>
        <div className="session-controls">
          <span className="badge badge-bypass" title="Claude runs tools without asking for permission. The sandbox is the boundary.">
            Bypass permissions
          </span>
          {totalCost > 0 && (
            <span className="mono dim session-cost" title="Total cost of this session">
              {formatCost(totalCost)}
            </span>
          )}
          <div className="session-picker">
            <Select
              value={model || currentModel}
              placeholder="Model"
              disabled={session.status !== "idle"}
              groups={[{ options: modelOptions }]}
              onValueChange={(v) => {
                setModel(v);
                void call(() => api.prompt(session.id, `/model ${v}`));
              }}
            />
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-compact"
            disabled={!session.claudeSessionId || session.status === "running" || session.status === "starting"}
            title="Continue from here in a new tab, leaving this session as it is"
            onClick={() => void call(() => api.forkSession(session.id).then(({ id }) => onForked(id)))}
          >
            <Fork />
            Fork
          </button>
        </div>
      </div>

      <Chat chat={chat} running={busy} />

      <div className="session-foot">
        {stream.gone && <div className="banner banner-warn">This session is no longer on the server.</div>}
        {!stream.connected && !stream.gone && stream.events.length > 0 && (
          <div className="banner banner-warn">Lost connection to the session. Reconnecting…</div>
        )}
        {error && <div className="banner banner-error">{error}</div>}
        <Composer
          label="Message Claude"
          submitLabel="Send"
          placeholder={live ? "Message Claude…" : "This session has ended."}
          disabled={!live || session.status === "starting"}
          onStop={session.status === "running" ? () => void call(() => api.interrupt(session.id)) : undefined}
          onSubmit={(text) => call(() => api.prompt(session.id, text))}
          autoFocus
        />
      </div>
    </div>
  );
}

/** Folds events into the chat incrementally: only new events are applied, and unchanged items keep their identity. */
function useChat(events: ReturnType<typeof useSessionEvents>["events"]): ChatState {
  const ref = useRef({ state: emptyChat(), count: 0 });
  return useMemo(() => {
    // The stream only grows; if it shrank, it was reset, so start over.
    let { state, count } = events.length < ref.current.count ? { state: emptyChat(), count: 0 } : ref.current;
    for (; count < events.length; count++) state = applyEvent(state, events[count]);
    ref.current = { state, count };
    return state;
  }, [events]);
}

function Chat({ chat, running }: { chat: ChatState; running: boolean }) {
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
        {chat.items.map((item, i) => (
          <Item key={item.key} item={item} open={running && i > lastTurn} />
        ))}
        {running && chat.items.at(-1)?.type === "user" && (
          <div className="chat-waiting">
            <span className="spinner" aria-hidden="true" /> Waiting for Claude…
          </div>
        )}
      </div>
    </div>
  );
}

const Item = memo(function Item({ item, open }: { item: ChatItem; open: boolean }) {
  switch (item.type) {
    case "user":
      return <div className="msg-user">{item.text}</div>;
    case "assistant":
      return (
        <div className="msg-assistant">
          {blocksOf(item).map((b, i) => (
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
          Retrying…{item.attempt !== undefined ? ` attempt ${item.attempt}${item.max ? ` of ${item.max}` : ""}` : ""}
        </div>
      );
    case "notice":
      return <div className="chat-quiet">{item.text}</div>;
    case "ended":
      return <div className="chat-ended">{endedText(item.reason, item.code)}</div>;
  }
});

function endedText(reason: string, code?: number): string {
  switch (reason) {
    case "user":
      return "Session ended.";
    case "sandbox":
      return "Session ended: its sandbox stopped.";
    case "quit":
      return "Session ended: Bentomo quit.";
    default:
      return code ? `Session ended: Claude exited with code ${code}.` : "Session ended: Claude exited.";
  }
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`;
}

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

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
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
