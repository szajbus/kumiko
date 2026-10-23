import { isCommand, type Attachment, type EndReason, type LoginAccount, type SessionEvent } from "@kumiko/shared";

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
  | { type: "user"; key: string; text: string; id: string; replayed?: boolean; attachments?: Attachment[] }
  /** One assistant message: finished blocks, then the ones still streaming (by content index). */
  | { type: "assistant"; key: string; final: Block[]; drafts: Block[] }
  | { type: "turn"; key: string; status: "ok" | "interrupted" | "error"; durationMs?: number; costUsd?: number; tokens?: Tokens; message?: string }
  | { type: "error"; key: string; message: string; hint?: string; stderr?: string[]; signedOut?: boolean }
  | { type: "retry"; key: string; attempt?: number; max?: number }
  | { type: "notice"; key: string; text: string }
  /** Claude asking to start a new session on `prompt`; `accepted` once the user has answered, with the `session` it started. */
  | { type: "proposal"; key: string; id: string; prompt: string; title?: string; artifacts?: string[]; accepted?: boolean; session?: string }
  /** Another session, `name`d then, sharing copies of artifacts with this one; `told` once Claude has heard of it, with a prompt. */
  | { type: "shared"; key: string; name: string; titles: string[]; told?: boolean }
  | { type: "ended"; key: string; reason: EndReason; code?: number };

/** Tokens Claude read and wrote, all models together; `cached` of them read from the prompt cache. */
export interface Tokens {
  total: number;
  cached: number;
}

export interface ChatState {
  items: ChatItem[];
  /** Assistant message id → index in items. */
  messages: Record<string, number>;
  /** tool_use id → index of the assistant item holding it. */
  tools: Record<string, number>;
  /** Claude reports cost per session; a turn's cost is the difference. */
  totalCost: number;
  /** Likewise for tokens. */
  totalTokens: Tokens;
  interruptPending: boolean;
  /** Claude's guess at the next prompt, sent after a turn; gone once any prompt is sent. */
  suggestion?: string;
}

export const emptyChat = (): ChatState => ({ items: [], messages: {}, tools: {}, totalCost: 0, totalTokens: { total: 0, cached: 0 }, interruptPending: false });

/** The blocks to show for an assistant item: finished ones, then drafts past them. */
export function blocksOf(item: Extract<ChatItem, { type: "assistant" }>): Block[] {
  return [...item.final, ...item.drafts.slice(item.final.length).filter(Boolean)];
}

/** One thing the chat renders: an item, or for an assistant item split across a turn's work and its reply, blocks `from` to `to` of it. */
export interface ItemRow {
  type: "item";
  item: ChatItem;
  index: number;
  from?: number;
  to?: number;
}

/**
 * What Claude did on its way to a turn's reply: thinking, tool calls and what it said in between. Once the turn is
 * `done` it folds away behind a line summing it up, leaving the reply below it.
 */
export interface WorkRow {
  type: "work";
  key: string;
  rows: ItemRow[];
  done: boolean;
  summary: string;
  /** Which tools ran, and how often: "Bash 3, Read 2". */
  tools: string;
}

export type ChatRow = ItemRow | WorkRow;

const isWork = (i: ChatItem) => i.type === "assistant" || i.type === "retry" || i.type === "notice";
/** Items for the user that come in while Claude works, and stay in view when its work folds. */
const waitsOnUser = (i: ChatItem) => i.type === "proposal" || i.type === "shared";

/** Text this long, or with a heading in it, is meant to be read: an answer, not a remark on the way to one. */
const SUBSTANTIAL_CHARS = 300;
const isSubstantial = (b: Block) => b.type === "text" && (b.text.trim().length >= SUBSTANTIAL_CHARS || /^#{1,6} /m.test(b.text));

/**
 * Lays the chat out by turn. Each prompt's run of assistant messages, retries and notices is its work; the text that
 * ends it is the reply. Anything else, like the turn's footer or an error, shows on its own after the work. A long
 * message in the middle of the work shows too, splitting the work around it, so an answer followed by some tidying up
 * isn't folded away. While the turn runs, all of the work shows, still in its groups so nothing jumps when they fold;
 * once it is done, a group is only kept if there is more than text in it.
 */
export function chatRows(items: readonly ChatItem[]): ChatRow[] {
  const rows: ChatRow[] = [];
  const row = (index: number, from?: number, to?: number): ItemRow => ({ type: "item", item: items[index], index, from, to });
  let i = 0;
  while (i < items.length) {
    const prompt = items[i];
    rows.push(row(i++));
    if (prompt.type !== "user") continue;
    const start = i;
    while (i < items.length && (isWork(items[i]) || waitsOnUser(items[i]))) i++;
    let end = i;
    while (end < items.length && items[end].type !== "user") end++;
    const done = items.slice(start, end).some((it) => it.type === "turn");
    // Claude's asks to start sessions, and shares from other sessions, are for the user: they show after the work
    // rather than fold away with it.
    const asks = Array.from({ length: i - start }, (_, k) => start + k).filter((k) => waitsOnUser(items[k])).map((k) => row(k));
    const work = Array.from({ length: i - start }, (_, k) => row(start + k)).filter((r) => !waitsOnUser(r.item));
    if (!work.length) {
      rows.push(...asks);
      for (; i < end; i++) rows.push(row(i));
      continue;
    }

    const reply: ItemRow[] = [];
    if (done) {
      // Peel the text that ends the turn off the work, back to the last thing that wasn't text.
      while (work.length) {
        const last = work.at(-1)!;
        if (last.item.type !== "assistant") break;
        const blocks = blocksOf(last.item);
        let cut = blocks.length;
        while (cut > 0 && blocks[cut - 1].type === "text") cut--;
        if (cut === blocks.length && cut > 0) break;
        reply.unshift(cut === 0 ? last : row(last.index, cut, blocks.length));
        work.pop();
        if (cut > 0) {
          work.push(row(last.index, 0, cut));
          break;
        }
      }
    }

    // Split what is left at long messages: each run between them is a group of its own.
    let group: ItemRow[] = [];
    const flush = () => {
      if (!group.length) return;
      const blocks = group.flatMap((r) => (r.item.type === "assistant" ? blocksOf(r.item).slice(r.from, r.to) : []));
      if (done && !blocks.some((b) => b.type !== "text")) rows.push(...group);
      else {
        const first = group[0];
        rows.push({ type: "work", key: `work-${first.item.key}${first.from ? `-${first.from}` : ""}`, rows: group, done, ...summarize(blocks) });
      }
      group = [];
    };
    for (const r of work) {
      if (r.item.type !== "assistant") {
        group.push(r);
        continue;
      }
      const blocks = blocksOf(r.item);
      const from = r.from ?? 0;
      const to = r.to ?? blocks.length;
      const part = (a: number, b: number) => (a === 0 && b === blocks.length ? row(r.index) : row(r.index, a, b));
      let at = from;
      for (let k = from; k < to; k++) {
        if (!isSubstantial(blocks[k])) continue;
        if (k > at) group.push(part(at, k));
        flush();
        rows.push(part(k, k + 1));
        at = k + 1;
      }
      if (at < to || (from === to && to === 0)) group.push(part(at, to));
    }
    flush();
    rows.push(...reply);
    rows.push(...asks);
    for (; i < end; i++) rows.push(row(i));
  }
  return rows;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function summarize(blocks: Block[]): { summary: string; tools: string } {
  const tools = blocks.filter((b) => b.type === "tool");
  const failed = tools.filter((b) => b.result?.isError).length;
  const thoughts = blocks.filter((b) => b.type === "thinking").length;
  const messages = blocks.filter((b) => b.type === "text" && b.text).length;
  const parts: string[] = [];
  if (tools.length) parts.push(count(tools.length, "tool call") + (failed ? ` (${failed} failed)` : ""));
  if (thoughts) parts.push(count(thoughts, "thought"));
  if (messages) parts.push(count(messages, "message"));
  const byName = new Map<string, number>();
  for (const t of tools) byName.set(t.name, (byName.get(t.name) ?? 0) + 1);
  return {
    summary: parts.join(" · "),
    tools: [...byName].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} ${n}`).join(", "),
  };
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
    case "user_prompt": {
      const next = { ...push({ type: "user", key, text: ev.payload.text, id: ev.payload.id, ...(ev.payload.attachments ? { attachments: ev.payload.attachments } : {}) }), suggestion: undefined };
      // Claude hears of what was shared with the first prompt after it that isn't a command; see `sharesWaiting`.
      if (isCommand(ev.payload.text) || !s.items.some((i) => i.type === "shared" && !i.told)) return next;
      return { ...next, items: next.items.map((i) => (i.type === "shared" && !i.told ? { ...i, told: true } : i)) };
    }
    case "shared":
      return push({ type: "shared", key, name: ev.payload.name, titles: ev.payload.artifacts.map((a) => a.title) });
    case "interrupt":
      return { ...s, interruptPending: true };
    case "error":
      return ev.payload.signedOut ? replaceFailedTurn(s, { type: "error", key, ...ev.payload }) : push({ type: "error", key, ...ev.payload });
    case "ended":
      // Stopping with its sandbox isn't an end: the banner says so while it sleeps, and Claude continues after it.
      if (ev.payload.asleep) return s;
      return push({ type: "ended", key, reason: ev.payload.reason, code: ev.payload.code });
    case "claude":
      return applyClaude(s, ev.payload, key);
    case "proposal":
      return push({
        type: "proposal",
        key,
        id: ev.payload.id,
        prompt: ev.payload.prompt,
        ...(ev.payload.title ? { title: ev.payload.title } : {}),
        ...(ev.payload.artifacts?.length ? { artifacts: ev.payload.artifacts } : {}),
      });
    case "proposal_answer": {
      const index = s.items.findIndex((i) => i.type === "proposal" && i.id === ev.payload.id);
      if (index < 0) return s;
      const items = [...s.items];
      items[index] = {
        ...(items[index] as Extract<ChatItem, { type: "proposal" }>),
        accepted: ev.payload.accepted,
        ...(ev.payload.session ? { session: ev.payload.session } : {}),
        // The prompt it started on, when the user changed Claude's.
        ...(ev.payload.prompt !== undefined ? { prompt: ev.payload.prompt } : {}),
      };
      return { ...s, items };
    }
    default:
      // The window's events, and kinds a newer Kumiko adds, aren't the chat's.
      return s;
  }
}

/**
 * Being logged out reaches the chat three times: Claude's reply ("Not logged in · Please run /login"), the failed turn,
 * then our error. The error says it best and can offer to log in, so it replaces the other two. Only those: anything
 * else after the prompt means it wasn't that kind of turn, and everything stays.
 */
function replaceFailedTurn(s: ChatState, error: ChatItem): ChatState {
  const cut = s.items.findLastIndex((i) => i.type === "user") + 1;
  const tail = s.items.slice(cut);
  const failedTurn = tail.length > 0 && tail.every((i) => i.type === "assistant" || (i.type === "turn" && i.status === "error"));
  if (!failedTurn) return { ...s, items: [...s.items, error] };
  const keep = (index: Record<string, number>) => Object.fromEntries(Object.entries(index).filter(([, i]) => i < cut));
  return { ...s, items: [...s.items.slice(0, cut), error], messages: keep(s.messages), tools: keep(s.tools) };
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
        const index = s.items.findLastIndex((i) => i.type === "user" && i.id === m.uuid);
        if (index < 0) return s;
        const items = [...s.items];
        items[index] = { ...(items[index] as Extract<ChatItem, { type: "user" }>), replayed: true };
        return { ...s, items };
      }
      // Text Claude adds on its own, like a skill's instructions after the Skill tool runs, is for Claude, not the reader.
      const synthetic = m.isSynthetic === true;
      const content = obj(m.message).content;
      if (typeof content === "string") return synthetic ? s : { ...s, items: [...s.items, { type: "notice", key, text: content }] };
      if (!Array.isArray(content)) return s;
      let next = s;
      for (const raw of content) {
        const c = obj(raw);
        if (c.type === "text" && str(c.text) && !synthetic) {
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
      const usage = tokensOf(m.usage);
      const tokens = usage && (usage.total >= s.totalTokens.total ? { total: usage.total - s.totalTokens.total, cached: Math.max(0, usage.cached - s.totalTokens.cached) } : usage);
      const ok = m.subtype === "success" && m.is_error !== true;
      const base = { ...s, totalCost: total ?? s.totalCost, totalTokens: usage ?? s.totalTokens, interruptPending: false };
      // A slash command like /model is a turn of its own with nothing to sum up.
      if (ok && m.num_turns === 0) return base;
      const status = ok ? "ok" : s.interruptPending && m.subtype === "error_during_execution" ? "interrupted" : "error";
      const errors = Array.isArray(m.errors) ? m.errors.map(String).join("\n") : undefined;
      const message = status === "error" ? str(m.result) || errors || String(m.subtype ?? "error") : undefined;
      return { ...base, items: [...base.items, { type: "turn", key, status, durationMs: num(m.duration_ms), costUsd, tokens, message }] };
    }

    default:
      return s;
  }
}

/** A result's usage as tokens; like its cost, it is a running total for the session. */
function tokensOf(raw: unknown): Tokens | undefined {
  const u = obj(raw);
  const [input, output, write, read] = [u.input_tokens, u.output_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens].map((v) => num(v) ?? 0);
  const total = input + output + write + read;
  return total > 0 ? { total, cached: read } : undefined;
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

/**
 * What is known about the login behind one logged-out card: `account` when the project is logged in now (from this
 * tab, or found so on asking), none when it was asked and isn't. `retried` once Retry was pressed after logging in.
 */
export interface LoginAnswer {
  key: string;
  account?: LoginAccount;
  retried?: boolean;
}

export interface LoginCards {
  /** The logged-out card no turn has worked since, if any: the one a login answers and the one to ask about. */
  open?: string;
  /** The one card shown: red with Log in while logged out, green with who it is once logged in. */
  card?: { key: string; account?: LoginAccount; retried?: boolean };
  /** Every other logged-out card: history, with nothing left to say. */
  hidden: ReadonlySet<string>;
}

/**
 * Which logged-out cards show. Only the last can, and only while it says something: green once `answer` says the
 * project is logged in, red while it isn't and no turn has worked since. Until `answer` covers the open card the
 * project may have logged in elsewhere, so nothing shows.
 */
export function loginCards(items: readonly ChatItem[], answer?: LoginAnswer): LoginCards {
  const at = items.findLastIndex((i) => i.type === "error" && i.signedOut === true);
  const keys = items.filter((i) => i.type === "error" && i.signedOut === true).map((i) => i.key);
  const last = at < 0 ? undefined : items[at].key;
  const open = last && !items.slice(at).some((i) => i.type === "turn" && i.status === "ok") ? last : undefined;
  const mine = answer && answer.key === last ? answer : undefined;
  const card = mine?.account ? { key: mine.key, account: mine.account, retried: mine.retried } : open && mine ? { key: open } : undefined;
  return { open, card, hidden: new Set(keys.filter((k) => k !== card?.key)) };
}
