import type { EndReason, SessionEvent } from "@bentomo/shared";

// Turns a session's events into what the chat shows. Claude's stream-json is read loosely: only the fields the
// chat needs, and anything unexpected is skipped rather than breaking the view.

export interface ToolResult {
  text: string;
  isError: boolean;
}

export type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string; tokens?: number }
  | { type: "tool"; id: string; name: string; input: Record<string, unknown>; partialInput?: string; result?: ToolResult };

export type ChatItem =
  /** A prompt we sent. `id` is what Claude knows it by; `replayed` once Claude has echoed it, which means it can be rewound to. */
  | { type: "user"; key: string; text: string; id?: string; replayed?: boolean }
  /** One assistant message: finished blocks, then the ones still streaming (by content index). */
  | { type: "assistant"; key: string; final: Block[]; drafts: Block[] }
  | { type: "turn"; key: string; status: "ok" | "interrupted" | "error"; durationMs?: number; costUsd?: number; message?: string }
  | { type: "error"; key: string; message: string; hint?: string; stderr?: string[]; signedOut?: boolean }
  | { type: "retry"; key: string; attempt?: number; max?: number }
  | { type: "notice"; key: string; text: string }
  | { type: "ended"; key: string; reason: EndReason; code?: number };

export interface ChatState {
  items: ChatItem[];
  /** Assistant message id → index in items. */
  messages: Record<string, number>;
  /** tool_use id → index of the assistant item holding it. */
  tools: Record<string, number>;
  /** Claude reports cost per session; a turn's cost is the difference. */
  totalCost: number;
  interruptPending: boolean;
  /** Claude's guess at the next prompt, sent after a turn; gone once any prompt is sent. */
  suggestion?: string;
}

export const emptyChat = (): ChatState => ({ items: [], messages: {}, tools: {}, totalCost: 0, interruptPending: false });

/** The blocks to show for an assistant item: finished ones, then drafts past them. */
export function blocksOf(item: Extract<ChatItem, { type: "assistant" }>): Block[] {
  return [...item.final, ...item.drafts.slice(item.final.length).filter(Boolean)];
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

function toBlock(raw: unknown): Block | undefined {
  const b = obj(raw);
  switch (b.type) {
    case "text":
      return { type: "text", text: str(b.text) ?? "" };
    case "thinking":
    case "redacted_thinking":
      return { type: "thinking", text: str(b.thinking) ?? "" };
    case "tool_use":
    case "server_tool_use":
      return { type: "tool", id: str(b.id) ?? "", name: str(b.name) ?? "tool", input: obj(b.input) };
    default:
      return undefined;
  }
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      const o = obj(c);
      return o.type === "text" ? str(o.text) ?? "" : o.type === "image" ? "[image]" : "";
    })
    .join("\n");
}

/** Applies one event; returns a new state, sharing every item that didn't change. */
export function applyEvent(s: ChatState, ev: SessionEvent): ChatState {
  const key = String(ev.seq);
  const push = (item: ChatItem): ChatState => ({ ...s, items: [...s.items, item] });

  switch (ev.kind) {
    case "user_prompt":
      return { ...push({ type: "user", key, text: ev.payload.text, id: ev.payload.id }), suggestion: undefined };
    case "interrupt":
      return { ...s, interruptPending: true };
    case "error":
      return push({ type: "error", key, ...ev.payload });
    case "ended":
      return push({ type: "ended", key, reason: ev.payload.reason, code: ev.payload.code });
    case "claude":
      return applyClaude(s, ev.payload, key);
  }
}

function applyClaude(s: ChatState, m: Json & { type: string }, key: string): ChatState {
  // Subagents' own messages would interleave with the main thread; their tool call shows as one line instead.
  if (m.parent_tool_use_id) return s;

  /** Replaces the assistant item for `id` (creating it if needed) with `fn` of it. */
  const withMessage = (id: string, fn: (it: Extract<ChatItem, { type: "assistant" }>) => Extract<ChatItem, { type: "assistant" }>, extra?: (index: number) => Partial<ChatState>): ChatState => {
    let index = s.messages[id];
    let items = s.items;
    let messages = s.messages;
    if (index === undefined) {
      index = items.length;
      items = [...items, { type: "assistant", key: `m-${id}`, final: [], drafts: [] }];
      messages = { ...messages, [id]: index };
    } else {
      items = [...items];
    }
    items[index] = fn(items[index] as Extract<ChatItem, { type: "assistant" }>);
    return { ...s, items, messages, ...extra?.(index) };
  };

  switch (m.type) {
    case "prompt_suggestion":
      return { ...s, suggestion: str(m.suggestion) || undefined };

    case "system":
      if (m.subtype === "api_retry") return { ...s, items: [...s.items, { type: "retry", key, attempt: num(m.attempt), max: num(m.max_retries) }] };
      return s;

    case "stream_event": {
      const e = obj(m.event);
      if (e.type === "message_start") return withMessage(str(obj(e.message).id) ?? key, (it) => it);
      const id = str(m.api_message_id);
      const index = num(e.index);
      if (!id || index === undefined) return s;
      if (e.type === "content_block_start") {
        const block = toBlock(e.content_block);
        if (!block) return s;
        if (block.type === "tool") block.partialInput = "";
        return withMessage(id, (it) => {
          const drafts = [...it.drafts];
          drafts[index] = block;
          return { ...it, drafts };
        });
      }
      if (e.type === "content_block_delta") {
        const d = obj(e.delta);
        return withMessage(id, (it) => {
          const cur = it.drafts[index];
          if (!cur) return it;
          let next: Block = cur;
          if (d.type === "text_delta" && cur.type === "text") next = { ...cur, text: cur.text + (str(d.text) ?? "") };
          else if (d.type === "thinking_delta" && cur.type === "thinking") next = { ...cur, text: cur.text + (str(d.thinking) ?? ""), tokens: num(d.estimated_tokens) ?? cur.tokens };
          else if (d.type === "input_json_delta" && cur.type === "tool") next = { ...cur, partialInput: (cur.partialInput ?? "") + (str(d.partial_json) ?? "") };
          else return it;
          const drafts = [...it.drafts];
          drafts[index] = next;
          return { ...it, drafts };
        });
      }
      return s;
    }

    case "assistant": {
      const msg = obj(m.message);
      const id = str(msg.id) ?? key;
      const blocks = (Array.isArray(msg.content) ? msg.content : []).map(toBlock).filter((b): b is Block => Boolean(b));
      if (!blocks.length) return s;
      return withMessage(
        id,
        (it) => {
          // A thinking block's final text can be empty when Claude only streamed it; keep what streamed.
          const merged = blocks.map((b, i) => {
            const draft = it.drafts[it.final.length + i];
            return b.type === "thinking" && !b.text && draft?.type === "thinking" ? { ...b, text: draft.text, tokens: draft.tokens } : b;
          });
          return { ...it, final: [...it.final, ...merged] };
        },
        (index) => {
          const tools = { ...s.tools };
          for (const b of blocks) if (b.type === "tool") tools[b.id] = index;
          return { tools };
        },
      );
    }

    case "user": {
      // Claude echoes each prompt back (the sign that it can be rewound to); the chat already shows it.
      if (m.isReplay === true) {
        const index = s.items.findLastIndex((i) => i.type === "user" && i.id !== undefined && i.id === m.uuid);
        if (index < 0) return s;
        const items = [...s.items];
        items[index] = { ...(items[index] as Extract<ChatItem, { type: "user" }>), replayed: true };
        return { ...s, items };
      }
      const content = obj(m.message).content;
      if (typeof content === "string") return { ...s, items: [...s.items, { type: "notice", key, text: content }] };
      if (!Array.isArray(content)) return s;
      let next = s;
      for (const raw of content) {
        const c = obj(raw);
        if (c.type === "text" && str(c.text)) {
          next = { ...next, items: [...next.items, { type: "notice", key: `${key}-${next.items.length}`, text: str(c.text)! }] };
        } else if (c.type === "tool_result") {
          const toolId = str(c.tool_use_id) ?? "";
          const index = next.tools[toolId];
          if (index === undefined) continue;
          const result: ToolResult = { text: resultText(c.content), isError: c.is_error === true };
          const items = [...next.items];
          const it = items[index] as Extract<ChatItem, { type: "assistant" }>;
          items[index] = { ...it, final: it.final.map((b) => (b.type === "tool" && b.id === toolId ? { ...b, result } : b)) };
          next = { ...next, items };
        }
      }
      return next;
    }

    case "result": {
      const total = num(m.total_cost_usd);
      // The running total starts over when a session is resumed, so a drop means this turn's cost is all of it.
      const costUsd = total !== undefined ? (total >= s.totalCost ? total - s.totalCost : total) : undefined;
      const ok = m.subtype === "success" && m.is_error !== true;
      const base = { ...s, totalCost: total ?? s.totalCost, interruptPending: false };
      // A slash command like /model is a turn of its own with nothing to sum up.
      if (ok && m.num_turns === 0) return base;
      const status = ok ? "ok" : s.interruptPending && m.subtype === "error_during_execution" ? "interrupted" : "error";
      const errors = Array.isArray(m.errors) ? m.errors.map(String).join("\n") : undefined;
      const message = status === "error" ? str(m.result) || errors || String(m.subtype ?? "error") : undefined;
      return { ...base, items: [...base.items, { type: "turn", key, status, durationMs: num(m.duration_ms), costUsd, message }] };
    }

    default:
      return s;
  }
}

const SUMMARY_KEYS = ["file_path", "command", "path", "pattern", "url", "query", "notebook_path", "description", "prompt"];

/** A short summary of a tool call's input: the file path or command, mostly. */
export function toolSummary(input: Record<string, unknown>): string {
  for (const k of SUMMARY_KEYS) {
    const v = input[k];
    if (typeof v === "string" && v) return v.split("\n")[0];
  }
  const first = Object.values(input).find((v) => typeof v === "string") as string | undefined;
  return first?.split("\n")[0] ?? "";
}

/** The same summary from input JSON that is still streaming in, as far as it has got. */
export function partialToolSummary(json: string): string {
  for (const k of SUMMARY_KEYS) {
    const m = new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(json);
    if (m) {
      try {
        return (JSON.parse(`"${m[1].replace(/\\$/, "")}"`) as string).split("\n")[0];
      } catch {
        return m[1];
      }
    }
  }
  return "";
}
