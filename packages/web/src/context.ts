import type { SessionEvent } from "@kumiko/shared";
import { formatTokens } from "./format.ts";

// How full Claude's context is, for the meter by the composer. Kumiko asks Claude at the start and after each turn and
// compaction (the `context` events), which says the window and where auto-compaction comes; in between, the main
// thread's messages say how many tokens each request took, which is how full the context was then. Subagents have
// contexts of their own, so theirs don't count.

export interface ContextState {
  tokens: number;
  /** Unknown until Claude has been asked. */
  window?: number;
  autoCompact?: boolean;
  threshold?: number;
  /** A compaction is under way. */
  compacting: boolean;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

/** Applies one event; returns `c` itself when it changes nothing. */
export function applyContextEvent(c: ContextState | undefined, ev: SessionEvent): ContextState | undefined {
  // An answer can come late, asked before a compaction that is under way now.
  if (ev.kind === "context") return { ...ev.payload, compacting: c?.compacting ?? false };
  if (ev.kind === "ended") return c?.compacting ? { ...c, compacting: false } : c;
  if (ev.kind !== "claude") return c;
  const m = ev.payload;
  // A compaction stopped with its turn may not say how it ended.
  if (m.type === "result") return c?.compacting ? { ...c, compacting: false } : c;
  if (m.type === "assistant" && !m.parent_tool_use_id) {
    const u = obj(obj(m.message).usage);
    const tokens = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens) + num(u.output_tokens);
    // A reply Claude makes up itself, to a command, carries no usage.
    return tokens > 0 ? { compacting: false, ...c, tokens } : c;
  }
  if (m.type === "system" && m.subtype === "status") {
    if (m.status === "compacting") return { tokens: 0, ...c, compacting: true };
    return m.compact_result !== undefined && c?.compacting ? { ...c, compacting: false } : c;
  }
  if (m.type === "system" && m.subtype === "compact_boundary") {
    const post = obj(m.compact_metadata).post_tokens;
    return { tokens: 0, ...c, ...(typeof post === "number" ? { tokens: post } : {}), compacting: false };
  }
  return c;
}

/** Where warnings start, and get louder: shares of the way to auto-compaction, or to a full window with it off. */
export const WARN_AT = 0.8;
export const HIGH_AT = 0.95;

export interface ContextMeter {
  /** How much of the bar is filled, 0–100. */
  percent: number;
  /** What it fills up to, in tokens: where Claude compacts by itself, or the whole window. */
  limit: number;
  /** Claude compacts by itself at `limit`. */
  auto: boolean;
  level: "ok" | "warn" | "high";
  text: string;
  title: string;
  /** Worth offering to compact now. */
  compactNow: boolean;
}

/**
 * What the meter shows; undefined while the window isn't known. The bar fills up to where Claude compacts by itself, or
 * to the end of the window when it won't.
 */
export function contextMeter(c: ContextState | undefined): ContextMeter | undefined {
  if (!c?.window) return undefined;
  const auto = c.autoCompact !== false && c.threshold !== undefined;
  const limit = auto ? c.threshold! : c.window;
  const share = Math.min(1, c.tokens / limit);
  const percent = Math.round(share * 100);
  const level = share >= HIGH_AT ? "high" : share >= WARN_AT ? "warn" : "ok";
  const left = 100 - percent;
  const text = auto ? (level === "ok" ? `${percent}%` : `${left}% until auto-compact`) : level === "high" ? `Context low: ${left}% left` : `${percent}% of context used`;
  const title = auto
    ? `Context: ${formatTokens(c.tokens)} tokens. Claude compacts the conversation by itself at ${formatTokens(limit)} (of a ${formatTokens(c.window)} window): ${percent}% of the way there. Type /compact to do it now.`
    : `Context: ${formatTokens(c.tokens)} of ${formatTokens(c.window)} tokens. Auto-compaction is off: once the context is full, Claude can't go on until it's compacted. Type /compact to do it now.`;
  return { percent, limit, auto, level, text, title, compactNow: level === "high" };
}
