import { isCompactSummary } from "@kumiko/shared";
import type { ChatItem, ChatState } from "./chat.ts";
import { formatDuration, formatTokens } from "./format.ts";

// Claude compacting its conversation: a summary takes the place of what came before, typed as /compact or by itself
// once the context is nearly full, which can be in the middle of a turn. Claude 2.1.309 says so with a `status` of
// "compacting", then one with `compact_result`, then (if it worked) a `compact_boundary` with the numbers, followed by
// the summary as a synthetic user message. A failed one is followed by a synthetic reply instead ("Compaction canceled.").

export type CompactionItem = Extract<ChatItem, { type: "compaction" }>;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const isCompaction = (i: ChatItem | undefined): i is CompactionItem => i?.type === "compaction";

function replaceAt(s: ChatState, index: number, item: ChatItem): ChatState {
  const items = [...s.items];
  items[index] = item;
  return { ...s, items };
}

/** Applies one of Claude's system messages about compacting; undefined for any other. */
export function applyCompaction(s: ChatState, m: Json, key: string): ChatState | undefined {
  const running = s.items.findLastIndex((i) => isCompaction(i) && i.status === "running");
  if (m.subtype === "status" && m.status === "compacting") {
    if (running >= 0) return s;
    // Only an automatic one counts what it has written of its summary.
    return { ...s, items: [...s.items, { type: "compaction", key: `c-${key}`, status: "running", ...(m.compact_output_chars !== undefined ? { trigger: "auto" } : {}) }] };
  }
  if (m.subtype === "status" && m.compact_result !== undefined) {
    if (m.compact_result !== "failed" || running < 0) return s;
    return replaceAt(s, running, { ...(s.items[running] as CompactionItem), status: "failed", error: str(m.compact_error) });
  }
  if (m.subtype === "compact_boundary") {
    const meta = obj(m.compact_metadata);
    const done = {
      status: "done" as const,
      trigger: meta.trigger === "auto" ? ("auto" as const) : ("manual" as const),
      preTokens: num(meta.pre_tokens),
      postTokens: num(meta.post_tokens),
      durationMs: num(meta.duration_ms),
    };
    if (running >= 0) return replaceAt(s, running, { ...(s.items[running] as CompactionItem), ...done });
    return { ...s, items: [...s.items, { type: "compaction", key: `c-${key}`, ...done }] };
  }
  return undefined;
}

/**
 * Takes in what Claude sends just after a compaction: the summary, after one that worked, or the reply saying why one
 * didn't, which says it better than the error. A summary with no compaction before it, in a chat saved before Kumiko
 * kept Claude's compaction messages, is a compaction of its own, without the numbers. Undefined for anything else.
 */
export function compactionFollowUp(s: ChatState, m: Json, key: string): ChatState | undefined {
  const last = s.items.at(-1);
  const index = s.items.length - 1;
  if (isCompaction(last) && m.type === "user" && m.isSynthetic === true && m.isReplay !== true && last.status === "done" && last.summary === undefined) {
    return replaceAt(s, index, { ...last, summary: summaryText(messageText(obj(m.message).content)) });
  }
  const msg = obj(m.message);
  if (isCompaction(last) && m.type === "assistant" && msg.model === "<synthetic>" && last.status === "failed" && last.message === undefined) {
    return replaceAt(s, index, { ...last, message: messageText(msg.content) });
  }
  if (isCompactSummary(m)) return { ...s, items: [...s.items, { type: "compaction", key: `c-${key}`, status: "done", summary: summaryText(messageText(msg.content)) }] };
  return undefined;
}

/** A compaction still running when its turn ends, or Claude goes, didn't finish. */
export function settleCompactions(s: ChatState): ChatState {
  const running = s.items.findLastIndex((i) => isCompaction(i) && i.status === "running");
  return running < 0 ? s : replaceAt(s, running, { ...(s.items[running] as CompactionItem), status: "stopped" });
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (obj(c).type === "text" ? str(obj(c).text) ?? "" : "")).join("\n");
}

/**
 * The summary as it reads to the user: without what Claude wraps it in for itself, the lead-in, the transcript's path
 * and its instructions for going on.
 */
export function summaryText(text: string): string {
  let body = text;
  const start = body.indexOf("\nSummary:\n");
  if (start >= 0) body = body.slice(start + "\nSummary:\n".length);
  for (const end of ["\n\nIf you need specific details from before compaction", "\nIf you need specific details from before compaction", "\nContinue the conversation from where it left off"]) {
    const at = body.indexOf(end);
    if (at >= 0) body = body.slice(0, at);
  }
  return body.trim();
}

/** What a compaction's line says. */
export function compactionText(item: CompactionItem): string {
  switch (item.status) {
    case "running":
      return item.trigger === "auto" ? "Context full: compacting…" : "Compacting the conversation…";
    case "failed":
      return item.message?.trim() || `Couldn't compact${item.error ? `: ${item.error}` : "."}`;
    case "stopped":
      return "Compaction stopped.";
    case "done": {
      // Without a trigger, from a chat that only kept the summary.
      const parts = [item.trigger === "auto" ? "Auto-compacted" : "Compacted"];
      if (item.preTokens !== undefined && item.postTokens !== undefined) parts.push(`${formatTokens(item.preTokens)} → ${formatTokens(item.postTokens)} tokens`);
      if (item.durationMs !== undefined) parts.push(formatDuration(item.durationMs));
      return parts.join(" · ");
    }
  }
}

/** Where the chat's last finished compaction is; -1 if it has none. Claude has only a summary of what's before it. */
export function lastCompaction(items: readonly ChatItem[]): number {
  return items.findLastIndex((i) => isCompaction(i) && i.status === "done");
}

/** What can't be done from a prompt before Claude's last compaction. */
export interface BranchLimit {
  noRewind: boolean;
  noFork: boolean;
}

/**
 * The prompts, by key, that can't be rewound to or forked from. Claude's history is cut after its last message before
 * the prompt (for a rewind) or before the next prompt (for a fork), and Claude can't resume at a message from before its
 * last compaction (`at`). Rewound to the first prompt, nothing of Claude's is kept and it starts afresh, so that works.
 */
export function branchLimits(items: readonly ChatItem[], at = lastCompaction(items)): Map<string, BranchLimit> {
  const limits = new Map<string, BranchLimit>();
  const firstReply = items.findIndex((i) => i.type === "assistant");
  // Walking back from the compaction, the prompt after each one is known as it is passed.
  let next = items.findIndex((i, k) => k > at && i.type === "user");
  for (let k = at - 1; k >= 0; k--) {
    const item = items[k];
    if (item.type !== "user") continue;
    const noRewind = firstReply >= 0 && firstReply < k;
    const noFork = next >= 0 && next < at;
    if (noRewind || noFork) limits.set(item.key, { noRewind, noFork });
    next = k;
  }
  return limits;
}
