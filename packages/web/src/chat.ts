import { isCommand, type AgentAsk, type ApprovalCard, type AskAnswer, type AskClosedReason, type Attachment, type EndReason, type LoginAccount, type SessionEvent } from "@kumiko/shared";
import { applyTaskEvent, emptyTasks, reportsEnd, type Task, type TasksState } from "./tasks.ts";
import { applyCompaction, compactionFollowUp, settleCompactions } from "./compaction.ts";

// Turns a session's events into what the chat shows. Claude's stream-json is read loosely: only the fields the
// chat needs, and anything unexpected is skipped rather than breaking the view.

export interface ToolResult {
  text: string;
  isError: boolean;
  /** What Claude's own record of a file edit adds, when it sent one: see FileChange. */
  change?: FileChange;
}

/** One hunk of Claude's patch of a file: its lines start with " ", "-" or "+", and the numbers are 1-based. */
export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/**
 * What the `tool_use_result` of an Edit, a Write or a NotebookEdit says beyond the result's text (Claude sends it for
 * the main thread's calls, not subagents'): the patch it made, with where in the file, or a cell as it was.
 */
export interface FileChange {
  hunks?: Hunk[];
  /** A Write that made the file. */
  created?: boolean;
  /** The user changed Claude's proposed edit before allowing it. */
  userModified?: boolean;
  /** Kumiko kept only the start of the patch. */
  truncated?: boolean;
  /** A NotebookEdit's cell before. */
  oldSource?: string;
}

export type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string; tokens?: number }
  | { type: "tool"; id: string; name: string; input: Record<string, unknown>; partialInput?: string; result?: ToolResult };

export type ChatItem =
  /**
   * A prompt we sent. `id` is what Claude knows it by; `replayed` once Claude has echoed it, which means it can be rewound
   * to. `merged` if Claude took it up in the middle of a turn it was already taking, rather than starting one for it.
   * `shell`: the run id of the command the user ran that this prompt gave Claude (see userShell.ts).
   */
  | { type: "user"; key: string; text: string; id: string; replayed?: boolean; merged?: boolean; attachments?: Attachment[]; shell?: string }
  /** A command the user ran that ended without going to Claude: its session ended, or was closing, or Kumiko restarted. */
  | { type: "shell"; key: string; id: string }
  /** One assistant message: finished blocks, then the ones still streaming (by content index). */
  | { type: "assistant"; key: string; final: Block[]; drafts: Block[] }
  /**
   * Where Claude starts a turn of its own, with no prompt: as it does on hearing that subagents it left working in the
   * background are done, `after` naming those it heard of (by their descriptions), or that shells and monitors ended,
   * `ended` (by task id); or on a monitor printing a line, `monitor`.
   */
  | { type: "unprompted"; key: string; after: string[]; ended?: string[]; monitor?: { taskId: string; line: string } }
  /** The user stopped background task `taskId`. */
  | { type: "task_stop"; key: string; taskId: string }
  | { type: "turn"; key: string; status: "ok" | "interrupted" | "error"; durationMs?: number; costUsd?: number; tokens?: Tokens; message?: string }
  | { type: "error"; key: string; message: string; hint?: string; stderr?: string[]; signedOut?: boolean }
  | { type: "retry"; key: string; attempt?: number; max?: number }
  | { type: "notice"; key: string; text: string }
  /** Claude asking to start a new session on `prompt`; `accepted` once the user has answered, with the `session` it started. */
  | { type: "proposal"; key: string; id: string; prompt: string; title?: string; artifacts?: string[]; accepted?: boolean; session?: string }
  /** Claude asking the user, mid-turn: questions, or a plan to approve. `answer` once the user gave one; `closed` if Claude stopped waiting first. */
  | { type: "ask"; key: string; ask: AgentAsk; answer?: AskAnswer; closed?: AskClosedReason; card?: ApprovalCard }
  /** Another session, `name`d then, sharing copies of artifacts with this one; `told` once Claude has heard of it, with a prompt. */
  | { type: "shared"; key: string; name: string; titles: string[]; told?: boolean }
  | { type: "ended"; key: string; reason: EndReason; code?: number }
  /**
   * Claude compacting its conversation (see compaction.ts): under way, done (with the numbers and the `summary` Claude
   * kept), failed (with Claude's `error`, and the `message` it replied with), or cut short with its turn.
   */
  | {
      type: "compaction";
      key: string;
      status: "running" | "done" | "failed" | "stopped";
      trigger?: "auto" | "manual";
      preTokens?: number;
      postTokens?: number;
      durationMs?: number;
      summary?: string;
      error?: string;
      message?: string;
    };

/** Tokens Claude read and wrote, all models together; `cached` of them read from the prompt cache. */
export interface Tokens {
  total: number;
  cached: number;
}

type AssistantItem = Extract<ChatItem, { type: "assistant" }>;
type UserItem = Extract<ChatItem, { type: "user" }>;

/** A run of Claude's messages: the main thread's, or a subagent's. */
interface Thread<T extends ChatItem = ChatItem> {
  items: T[];
  /** Assistant message id → index in items. */
  messages: Record<string, number>;
  /** tool_use id → index of the assistant item holding it. */
  tools: Record<string, number>;
}

/** What a subagent did, kept apart from the main thread: its own messages, and what Claude reports of its progress. */
export interface Subagent extends Thread<AssistantItem> {
  /** From Claude's task events; unknown for a subagent whose events weren't kept. */
  status?: "running" | "completed" | "failed" | "stopped";
  /** Started with `run_in_background`: it goes on after its Agent call returns. */
  background?: boolean;
  description?: string;
  /** What it is doing now, while it runs: "Reading b.txt". */
  activity?: string;
  usage?: { tokens: number; toolUses: number; durationMs: number };
}

export interface ChatState extends Thread {
  /** Subagents by the tool_use id of the Agent call that started them, wherever that call is. */
  agents: Record<string, Subagent>;
  /** The descriptions of subagents in the background that finished since the last turn began. */
  finished: string[];
  /** Claude reports cost per session; a turn's cost is the difference. */
  totalCost: number;
  /** Likewise for tokens. */
  totalTokens: Tokens;
  interruptPending: boolean;
  /** A turn is under way: for a prompt, or one Claude took by itself. */
  inTurn: boolean;
  /**
   * Prompts sent while a turn was under way, that Claude hasn't taken up yet. Each goes into the chat where Claude does:
   * in the middle of that turn if it reads it there, or starting a turn of its own after it.
   */
  queued: UserItem[];
  /** Claude's guess at the next prompt, sent after a turn; gone once any prompt is sent. */
  suggestion?: string;
  /** Claude's background tasks; see tasks.ts. */
  tasks: TasksState;
  /** The shells and monitors in the background that ended since the last turn began, which Claude reports on. */
  endedTasks: string[];
  /** The monitor line that woke Claude, heard before the turn it woke it for showed. */
  monitorLine?: { taskId: string; line: string };
}

export const emptyChat = (): ChatState => ({ items: [], messages: {}, tools: {}, agents: {}, finished: [], totalCost: 0, totalTokens: { total: 0, cached: 0 }, interruptPending: false, inTurn: false, queued: [], tasks: emptyTasks(), endedTasks: [] });

/** The blocks to show for an assistant item: finished ones, then drafts past them. */
export function blocksOf(item: AssistantItem): Block[] {
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

/** What a turn starts with: a prompt, or Claude going on by itself. */
export const startsTurn = (i: ChatItem) => (i.type === "user" && !i.merged) || i.type === "unprompted";
/** Things that show in the middle of a turn's work, splitting it, and stay in view when it folds. */
const splitsWork = (i: ChatItem) => i.type === "ask" || i.type === "compaction" || (i.type === "user" && i.merged === true);
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
    if (!startsTurn(prompt)) continue;
    const start = i;
    while (i < items.length && (isWork(items[i]) || waitsOnUser(items[i]) || splitsWork(items[i]))) i++;
    let end = i;
    while (end < items.length && !startsTurn(items[end])) end++;
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
      // What Claude asked, or a message it read on the way, splits the work like a long message: the work before it
      // folds away, the card stays.
      if (splitsWork(r.item)) {
        flush();
        rows.push(r);
        continue;
      }
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

export type ToolState = "ok" | "error" | "running" | "stopped";

/**
 * How a tool call stands: done, failed, under way, or cut short. `open` while the turn it is in goes on, `live` while
 * Claude is there at all. An Agent call goes by its subagent, which runs on after its call returns when it was started
 * in the background, until Claude reports it done.
 */
export function toolState(block: Extract<Block, { type: "tool" }>, open: boolean, live: boolean, agent?: Subagent): ToolState {
  const own: ToolState = block.result ? (block.result.isError ? "error" : "ok") : open ? "running" : "stopped";
  switch (agent?.status) {
    case "running":
      return (agent.background ? live : open) ? "running" : own === "ok" ? "stopped" : own;
    case "completed":
      return block.result?.isError ? "error" : "ok";
    case "failed":
      return "error";
    case "stopped":
      return "stopped";
    default:
      return own;
  }
}

/** Subagents started in the background that Claude hasn't reported done, by their Agent call's tool_use id. */
export function backgroundAgents(agents: Record<string, Subagent>): string[] {
  return Object.keys(agents).filter((id) => agents[id].background && agents[id].status === "running");
}

/** What the line starting a turn Claude took by itself says: why it did, when that's known. */
export function unpromptedText(after: readonly string[]): string {
  const names = after.filter(Boolean).map((d) => `“${d}”`);
  if (!names.length) return after.length ? "A subagent finished in the background" : "Claude went on by itself";
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${list} finished in the background`;
}

/** The plain line a turn of Claude's own starts with, when the lines for tasks that ended or a monitor's don't say why. */
export function unpromptedPlain(after: readonly string[], ended: readonly Task[], monitor: boolean): string | undefined {
  // A subagent's end has a line of its own when its task is known; one whose task isn't still needs saying.
  const rest = after.filter((d) => !ended.some((t) => t.kind === "agent" && t.description === d));
  return rest.length || (!ended.length && !monitor) ? unpromptedText(rest) : undefined;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function summarize(blocks: Block[]): { summary: string; tools: string } {
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
  const next = applyChatEvent(s, ev);
  const tasks = applyTaskEvent(next.tasks, ev);
  if (tasks === next.tasks) return next;
  // Subagents lost with the Claude process before this one aren't working any more.
  if (ev.kind === "tasks_lost") {
    const lost = new Set(ev.payload.taskIds.flatMap((id) => (tasks.byId[id]?.toolUseId ? [tasks.byId[id].toolUseId!] : [])));
    return { ...next, tasks, agents: stopAgents(next.agents, (id) => lost.has(id)) };
  }
  // A shell or monitor ended that Claude takes a turn to report on: that turn starts by saying so.
  const ended = ev.kind === "claude" && ev.payload.subtype === "task_notification" ? tasks.byId[String(ev.payload.task_id)] : undefined;
  return { ...next, tasks, ...(ended && reportsEnd(ended) ? { endedTasks: [...next.endedTasks, ended.id] } : {}) };
}

function applyChatEvent(s: ChatState, ev: SessionEvent): ChatState {
  const key = String(ev.seq);
  const push = (item: ChatItem): ChatState => ({ ...s, items: [...s.items, item] });

  switch (ev.kind) {
    case "user_prompt": {
      const item: UserItem = { type: "user", key, text: ev.payload.text, id: ev.payload.id, ...(ev.payload.attachments ? { attachments: ev.payload.attachments } : {}), ...(ev.payload.shell ? { shell: ev.payload.shell } : {}) };
      // Sent while Claude works, it waits until Claude takes it up; see `take`.
      const next = s.inTurn ? { ...s, queued: [...s.queued, item], suggestion: undefined } : startTurn({ ...push(item), suggestion: undefined });
      // Claude hears of what was shared with the first prompt after it that isn't a command; see `sharesWaiting`.
      if (isCommand(ev.payload.text) || !s.items.some((i) => i.type === "shared" && !i.told)) return next;
      return { ...next, items: next.items.map((i) => (i.type === "shared" && !i.told ? { ...i, told: true } : i)) };
    }
    case "prompt_withdrawn":
      return { ...s, queued: s.queued.filter((i) => i.id !== ev.payload.id) };
    case "shared":
      return push({ type: "shared", key, name: ev.payload.name, titles: ev.payload.artifacts.map((a) => a.title) });
    case "task_stop":
      return push({ type: "task_stop", key, taskId: ev.payload.taskId });
    case "user_shell_end":
      // One that goes to Claude shows as the prompt that gives it; this one never will.
      return ev.payload.alone ? push({ type: "shell", key, id: ev.payload.id }) : s;
    case "monitor_event": {
      // It comes once the turn it woke Claude for is under way: onto that turn's first line if it shows already, or
      // kept for it. Without `at`, recorded before Kumiko said which turn, it goes on the latest such line.
      const line = { taskId: ev.payload.taskId, line: ev.payload.line };
      const { at } = ev.payload;
      let index: number;
      if (at === undefined) {
        index = s.items.findLastIndex(startsTurn);
        const start = s.items[index];
        if (start?.type !== "unprompted" || start.monitor || start.ended?.length || start.after.length) return { ...s, monitorLine: line };
      } else {
        // The turn that began at `at` starts with the first line after the end of the turn before it, and before its own
        // end. Keys can't say which that is: a prompt Claude took up from the queue keeps its own, earlier one.
        const before = s.items.findLastIndex((i) => i.type === "turn" && Number(i.key) < at);
        const end = s.items.findIndex((i, k) => k > before && i.type === "turn");
        index = s.items.findIndex((i, k) => k > before && (end < 0 || k < end) && startsTurn(i));
        // Not under way yet: kept for it. Over without a word: there is nothing to put it on.
        if (index < 0) return end < 0 ? { ...s, monitorLine: line } : s;
        const start = s.items[index];
        // A turn for a prompt, or for something else that ended, isn't the monitor's.
        if (start.type !== "unprompted" || start.monitor || start.ended?.length || start.after.length) return s;
      }
      const items = [...s.items];
      items[index] = { ...(items[index] as Extract<ChatItem, { type: "unprompted" }>), monitor: line };
      return { ...s, items };
    }
    case "interrupt":
      return { ...s, interruptPending: true };
    case "error":
      return ev.payload.signedOut ? replaceFailedTurn(s, { type: "error", key, ...ev.payload }) : push({ type: "error", key, ...ev.payload });
    case "ended": {
      // Claude is gone, and the turns it hadn't finished with it, and the subagents still working.
      // Prompts it hadn't taken up yet stay in the chat, as they were sent.
      const gone = settleCompactions({ ...s, items: [...s.items, ...s.queued], queued: [], inTurn: false, interruptPending: false, agents: stopAgents(s.agents, () => true) });
      // Stopping with its sandbox isn't an end: the banner says so while it sleeps, and Claude continues after it. A turn
      // it cut short ends there, though, as Claude doesn't take it up again.
      if (ev.payload.asleep) return s.inTurn ? { ...gone, items: [...gone.items, { type: "turn", key, status: "interrupted" }] } : gone;
      return { ...gone, items: [...gone.items, { type: "ended", key, reason: ev.payload.reason, code: ev.payload.code }] };
    }
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
    case "ask":
      return push({ type: "ask", key, ask: ev.payload });
    case "ask_answer":
    case "ask_closed": {
      const index = s.items.findIndex((i) => i.type === "ask" && i.ask.id === ev.payload.id);
      if (index < 0) return s;
      const items = [...s.items];
      const item = items[index] as Extract<ChatItem, { type: "ask" }>;
      items[index] = ev.kind === "ask_answer" ? { ...item, answer: ev.payload.answer } : { ...item, closed: ev.payload.reason };
      return { ...s, items };
    }
    case "card": {
      const index = s.items.findIndex((i) => i.type === "ask" && i.ask.id === ev.payload.id);
      if (index < 0) return s;
      const items = [...s.items];
      items[index] = { ...(items[index] as Extract<ChatItem, { type: "ask" }>), card: ev.payload };
      return { ...s, items };
    }
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
  // A subagent's messages go to it, not the main thread, where they would interleave with Claude's own.
  const parent = str(m.parent_tool_use_id);
  if (parent) {
    const agent = s.agents[parent] ?? { items: [], messages: {}, tools: {} };
    const next = applyThread(agent, m, key);
    return next === agent ? s : { ...s, agents: { ...s.agents, [parent]: next } };
  }

  // Claude says something after its turn ended, with no prompt since: it is taking a turn of its own.
  const speaks = m.type === "stream_event" || m.type === "assistant" || (m.type === "user" && m.isReplay !== true) || (m.type === "system" && m.subtype === "api_retry");
  if (speaks) s = startUnprompted(s, key);
  const followUp = compactionFollowUp(s, m, key);
  if (followUp) return followUp;

  switch (m.type) {
    case "prompt_suggestion":
      return { ...s, suggestion: str(m.suggestion) || undefined };

    case "system":
      if (m.subtype === "api_retry") return { ...s, items: [...s.items, { type: "retry", key, attempt: num(m.attempt), max: num(m.max_retries) }] };
      return applyCompaction(s, m, key) ?? applyTask(s, m);

    case "user": {
      // Claude echoes each prompt back (the sign that it can be rewound to) as it takes it up. One sent while it worked
      // goes into the chat there: in the middle of the turn under way, or starting its own.
      if (m.isReplay === true) {
        const waiting = s.queued.findIndex((i) => i.id === m.uuid);
        if (waiting >= 0) return take(s, waiting, s.inTurn, true);
        const index = s.items.findLastIndex((i) => i.type === "user" && i.id === m.uuid);
        if (index < 0) return s;
        const items = [...s.items];
        items[index] = { ...(items[index] as Extract<ChatItem, { type: "user" }>), replayed: true };
        return { ...s, items };
      }
      return applyThread(s, m, key);
    }

    case "result": {
      const total = num(m.total_cost_usd);
      // The running total starts over when a session is resumed, so a drop means this turn's cost is all of it.
      const costUsd = total !== undefined ? (total >= s.totalCost ? total - s.totalCost : total) : undefined;
      const usage = tokensOf(m.usage);
      const tokens = usage && (usage.total >= s.totalTokens.total ? { total: usage.total - s.totalTokens.total, cached: Math.max(0, usage.cached - s.totalTokens.cached) } : usage);
      const ok = m.subtype === "success" && m.is_error !== true;
      // A monitor's line kept for a turn that ended without a word was for that turn only.
      const base = settleCompactions({ ...s, totalCost: total ?? s.totalCost, totalTokens: usage ?? s.totalTokens, interruptPending: false, inTurn: false, monitorLine: undefined });
      // A slash command like /model is a turn of its own with nothing to sum up.
      if (ok && m.num_turns === 0) return base;
      const status = ok ? "ok" : s.interruptPending && m.subtype === "error_during_execution" ? "interrupted" : "error";
      const errors = Array.isArray(m.errors) ? m.errors.map(String).join("\n") : undefined;
      const message = status === "error" ? str(m.result) || errors || String(m.subtype ?? "error") : undefined;
      return { ...base, items: [...base.items, { type: "turn", key, status, durationMs: num(m.duration_ms), costUsd, tokens, message }] };
    }

    default:
      return applyThread(s, m, key);
  }
}

function startUnprompted(s: ChatState, key: string): ChatState {
  // Before the first turn ends, or while one is under way, Claude is answering.
  if (s.inTurn || !s.items.some((i) => i.type === "turn")) return s;
  // A prompt waits: this turn is for it. Claude echoes most before it says anything, but not a command like /code-review.
  if (s.queued.length) return take(s, 0, false);
  const item: ChatItem = { type: "unprompted", key: `u-${key}`, after: s.finished, ...(s.endedTasks.length ? { ended: s.endedTasks } : {}), ...(s.monitorLine ? { monitor: s.monitorLine } : {}) };
  return startTurn({ ...s, items: [...s.items, item] });
}

/** A turn begins: what finished in the background before it is news for that turn only. */
function startTurn(s: ChatState): ChatState {
  return { ...s, inTurn: true, finished: [], endedTasks: [], monitorLine: undefined };
}

/**
 * Claude takes up queued prompt `index`: in the middle of the turn under way (`merged`), or starting a turn of its own.
 * Either way it shows from here on, where Claude read it.
 */
function take(s: ChatState, index: number, merged: boolean, replayed = false): ChatState {
  const item: UserItem = { ...s.queued[index], ...(replayed ? { replayed } : {}), ...(merged ? { merged } : {}) };
  const next = { ...s, items: [...s.items, item], queued: s.queued.filter((_, i) => i !== index) };
  return merged ? next : startTurn(next);
}

/**
 * Claude's reports on its subagents, by the tool_use id of the Agent call that started each: when it starts, what it
 * is doing, and how it ended. Only these tell when one started in the background is done, as its call returns at once.
 */
function applyTask(s: ChatState, m: Json): ChatState {
  const id = str(m.tool_use_id);
  if (!id) return s;
  const agent = s.agents[id];
  const usage = obj(m.usage);
  const counts = num(usage.total_tokens) !== undefined ? { usage: { tokens: num(usage.total_tokens) ?? 0, toolUses: num(usage.tool_uses) ?? 0, durationMs: num(usage.duration_ms) ?? 0 } } : {};
  let next: Subagent;
  if (m.subtype === "task_started") {
    // Claude reports some tool calls of its own as tasks too, like a Bash command that runs long.
    if (m.task_type !== "local_agent") return s;
    next = { ...(agent ?? { items: [], messages: {}, tools: {} }), status: "running", background: m.is_backgrounded === true, description: str(m.description) };
  } else if (!agent) {
    return s;
  } else if (m.subtype === "task_progress") {
    next = { ...agent, activity: str(m.description), ...counts };
  } else if (m.subtype === "task_notification") {
    const status = m.status === "completed" ? "completed" : m.status === "failed" ? "failed" : "stopped";
    next = { ...agent, status, activity: undefined, ...counts };
    if (agent.background) return { ...s, agents: { ...s.agents, [id]: next }, finished: [...s.finished, agent.description ?? ""] };
  } else {
    return s;
  }
  return { ...s, agents: { ...s.agents, [id]: next } };
}

/** The subagents that `which` picks among those still running, stopped; `agents` itself if there are none. */
export function stopAgents(agents: Record<string, Subagent>, which: (id: string) => boolean): Record<string, Subagent> {
  const ids = Object.keys(agents).filter((id) => agents[id].status === "running" && which(id));
  if (!ids.length) return agents;
  return { ...agents, ...Object.fromEntries(ids.map((id) => [id, { ...agents[id], status: "stopped" as const, activity: undefined }])) };
}

/** Applies one of Claude's messages to a thread: the main one, or a subagent's. Returns `t` when nothing changed. */
function applyThread<T extends Thread<AssistantItem> | ChatState>(t: T, m: Json & { type: string }, key: string): T {
  // A subagent's thread only has Claude's messages; its prompt is in the input of the call that started it.
  const main = "agents" in t;

  /** Replaces the assistant item for `id` (creating it if needed) with `fn` of it. */
  const withMessage = (id: string, fn: (it: AssistantItem) => AssistantItem, extra?: (index: number) => Partial<Thread>): T => {
    let index = t.messages[id];
    let items: ChatItem[] = t.items;
    let messages = t.messages;
    if (index === undefined) {
      index = items.length;
      items = [...items, { type: "assistant", key: `m-${id}`, final: [], drafts: [] }];
      messages = { ...messages, [id]: index };
    } else {
      items = [...items];
    }
    items[index] = fn(items[index] as AssistantItem);
    return { ...t, items, messages, ...extra?.(index) };
  };

  switch (m.type) {
    case "stream_event": {
      const e = obj(m.event);
      if (e.type === "message_start") return withMessage(str(obj(e.message).id) ?? key, (it) => it);
      const id = str(m.api_message_id);
      const index = num(e.index);
      if (!id || index === undefined) return t;
      if (e.type === "content_block_start") {
        const block = toBlock(e.content_block);
        if (!block) return t;
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
      return t;
    }

    case "assistant": {
      const msg = obj(m.message);
      const id = str(msg.id) ?? key;
      const blocks = (Array.isArray(msg.content) ? msg.content : []).map(toBlock).filter((b): b is Block => Boolean(b));
      if (!blocks.length) return t;
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
          const tools = { ...t.tools };
          for (const b of blocks) if (b.type === "tool") tools[b.id] = index;
          return { tools };
        },
      );
    }

    case "user": {
      // Text Claude adds on its own, like a skill's instructions after the Skill tool runs, is for Claude, not the reader.
      const quiet = m.isSynthetic === true || !main;
      const content = obj(m.message).content;
      if (typeof content === "string") return quiet ? t : { ...t, items: [...t.items, { type: "notice", key, text: content }] };
      if (!Array.isArray(content)) return t;
      let next = t;
      for (const raw of content) {
        const c = obj(raw);
        if (c.type === "text" && str(c.text) && !quiet) {
          next = { ...next, items: [...next.items, { type: "notice", key: `${key}-${next.items.length}`, text: str(c.text)! }] };
        } else if (c.type === "tool_result") {
          const toolId = str(c.tool_use_id) ?? "";
          const index = next.tools[toolId];
          if (index === undefined) continue;
          // Claude sends a tool's structured result beside the message; with several results it couldn't say whose.
          const change = content.length === 1 ? fileChange(m.tool_use_result) : undefined;
          const result: ToolResult = { text: resultText(c.content), isError: c.is_error === true, ...(change ? { change } : {}) };
          const items: ChatItem[] = [...next.items];
          const it = items[index] as AssistantItem;
          items[index] = { ...it, final: it.final.map((b) => (b.type === "tool" && b.id === toolId ? { ...b, result } : b)) };
          next = { ...next, items };
        }
      }
      return next;
    }

    default:
      return t;
  }
}

function fileChange(raw: unknown): FileChange | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = obj(raw);
  const flags = { ...(r.userModified === true ? { userModified: true } : {}), ...(r.truncated === true ? { truncated: true } : {}) };
  if (Array.isArray(r.structuredPatch)) {
    const hunks = r.structuredPatch.map(obj).map((h) => ({
      oldStart: num(h.oldStart) ?? 0,
      oldLines: num(h.oldLines) ?? 0,
      newStart: num(h.newStart) ?? 0,
      newLines: num(h.newLines) ?? 0,
      lines: Array.isArray(h.lines) ? h.lines.filter((l): l is string => typeof l === "string") : [],
    }));
    return { hunks, ...(r.type === "create" ? { created: true } : {}), ...flags };
  }
  if (typeof r.old_source === "string") return { oldSource: r.old_source, ...flags };
  return undefined;
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

/**
 * A tool call's input to read: a command as it would be typed, not a JSON string with its line breaks and quotes escaped,
 * then the rest of the input, if there is any.
 */
export function inputSections(input: Record<string, unknown>): { label: string; text: string }[] {
  const { command, ...rest } = input;
  if (typeof command !== "string" || !command) return [{ label: "Input", text: JSON.stringify(input, null, 2) }];
  return [{ label: "Command", text: command }, ...(Object.keys(rest).length ? [{ label: "Input", text: JSON.stringify(rest, null, 2) }] : [])];
}

/** The same summary from input JSON that is still streaming in, as far as it has got. */
export function partialToolSummary(json: string): string {
  for (const k of SUMMARY_KEYS) {
    const v = partialString(json, k);
    if (v !== undefined) return v.split("\n")[0];
  }
  return "";
}

/** String `key` of input JSON that is still streaming in, as far as it has got; undefined until it has begun. */
export function partialString(json: string, key: string): string | undefined {
  const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(json);
  if (!m) return undefined;
  try {
    // Cut where an escape has only begun to arrive.
    return JSON.parse(`"${m[1].replace(/\\(u[0-9a-fA-F]{0,3})?$/, "")}"`) as string;
  } catch {
    return m[1];
  }
}

/**
 * What is known about the login behind one logged-out card: `account` when the sandbox is logged in now (from this
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
 * sandbox is logged in, red while it isn't and no turn has worked since. Until `answer` covers the open card the
 * sandbox may have logged in elsewhere, so nothing shows.
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
