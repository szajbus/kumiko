import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionEvent } from "@kumiko/shared";
import { applyEvent, chatRows, emptyChat, type ChatItem, type ChatRow, type ChatState } from "../src/chat.ts";
import { branchLimits, compactionText, lastCompaction, summaryText, type CompactionItem } from "../src/compaction.ts";
import { applyContextEvent, contextMeter, type ContextState } from "../src/context.ts";

// The messages are as Claude 2.1.309 sends them (captured in ~/subcap/compact), cut down to what matters.

type NewEvent = SessionEvent extends infer E ? (E extends unknown ? Omit<E, "seq"> : never) : never;

function fold(events: NewEvent[], from: ChatState = emptyChat()): ChatState {
  return events.reduce((s, e, n) => applyEvent(s, { ...e, seq: n + 1 } as SessionEvent), from);
}

const claude = (payload: Record<string, unknown> & { type: string }): NewEvent => ({ kind: "claude", payload });
const prompt = (text: string, id: string): NewEvent[] => [{ kind: "user_prompt", payload: { text, id } }, claude({ type: "user", uuid: id, isReplay: true, message: { role: "user", content: [{ type: "text", text }] } })];
const reply = (id: string, text: string, usage?: Record<string, number>) => claude({ type: "assistant", uuid: `u-${id}`, message: { id, content: [{ type: "text", text }], ...(usage ? { usage } : {}) } });
const toolCall = (id: string, tool: string) => [
  claude({ type: "assistant", uuid: `u-${id}`, message: { id, content: [{ type: "tool_use", id: tool, name: "Read", input: { file_path: "notes.txt" } }] } }),
  claude({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: tool, content: "lots" }] } }),
];
const result = (extra: Record<string, unknown> = {}) => claude({ type: "result", subtype: "success", duration_ms: 1200, num_turns: 1, ...extra });
const compacting = (auto = false) => claude({ type: "system", subtype: "status", status: "compacting", ...(auto ? { compact_output_chars: 0 } : {}) });
const compacted = () => claude({ type: "system", subtype: "status", status: null, compact_result: "success" });
const boundary = (trigger: "manual" | "auto", pre: number, post: number) =>
  claude({ type: "system", subtype: "compact_boundary", uuid: "b1", compact_metadata: { trigger, pre_tokens: pre, post_tokens: post, cumulative_dropped_tokens: pre - post, duration_ms: 7775 } });
const SUMMARY =
  "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n<tools-used-before-summary>Bash, Read</tools-used-before-summary>\nSummary:\n1. Primary Request and Intent:\n   The user asked how many lines mention kilo.\n\n2. Pending Tasks:\n   - None.\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: /home/u/.claude/sandboxes/x/s.jsonl\nContinue the conversation from where it left off without asking the user any further questions. Resume directly.\n\nThe messages after this summary are the most recent messages from before compaction, kept verbatim.";
const summary = (asBlock = false) => claude({ type: "user", uuid: "s1", isReplay: false, isSynthetic: true, message: { role: "user", content: asBlock ? [{ type: "text", text: SUMMARY }] : SUMMARY } });
const synthetic = (text: string) => claude({ type: "assistant", uuid: "syn", message: { id: "syn", model: "<synthetic>", content: [{ type: "text", text }] } });

/** A typed /compact after one turn, as Claude streams it. */
const manualCompact: NewEvent[] = [
  ...prompt("Read notes1.txt", "p1"),
  reply("m1", "About 570 lines."),
  result(),
  ...prompt("/compact", "p2"),
  compacting(),
  compacted(),
  claude({ type: "system", subtype: "init" }),
  boundary("manual", 57834, 7078),
  summary(),
  claude({ type: "user", uuid: "out1", isReplay: true, message: { role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>" } }),
  result({ num_turns: 0, total_cost_usd: 0.0128 }),
];

const compactions = (s: ChatState) => s.items.filter((i): i is CompactionItem => i.type === "compaction");
const shape = (rows: ChatRow[]): string[] => rows.map((r) => (r.type === "work" ? `work[${shape(r.rows).join(" ")}]` : r.item.type));

describe("compaction in the chat", () => {
  it("shows a typed /compact as a line with the numbers and the summary, in place of the turn's footer", () => {
    const s = fold(manualCompact);
    assert.deepEqual(s.items.map((i) => i.type), ["user", "assistant", "turn", "user", "compaction"]);
    const [c] = compactions(s);
    assert.equal(c.status, "done");
    assert.equal(c.trigger, "manual");
    assert.equal(compactionText(c), "Compacted · 58k → 7.1k tokens · 7.8s");
    assert.equal(c.summary, "1. Primary Request and Intent:\n   The user asked how many lines mention kilo.\n\n2. Pending Tasks:\n   - None.");
    assert.equal(s.inTurn, false);
  });

  it("shows it running from Claude's first word of it, before it's done", () => {
    // Up to Claude's status saying it's compacting.
    const s = fold(manualCompact.slice(0, 7));
    const [c] = compactions(s);
    assert.equal(c.status, "running");
    assert.equal(compactionText(c), "Compacting the conversation…");
    // Saying it's done comes before the numbers do.
    assert.equal(compactions(fold(manualCompact.slice(7, 8), s))[0].status, "running");
  });

  it("says why one failed in Claude's own words, without its reply showing as well", () => {
    const s = fold([
      ...prompt("hi", "p1"),
      reply("m1", "Hi."),
      result(),
      ...prompt("/compact", "p2"),
      compacting(),
      claude({ type: "system", subtype: "status", status: null, compact_result: "failed", compact_error: "API Error: Request was aborted." }),
      synthetic("Compaction canceled."),
      result({ num_turns: 0 }),
    ]);
    assert.deepEqual(s.items.map((i) => i.type), ["user", "assistant", "turn", "user", "compaction"]);
    const [c] = compactions(s);
    assert.equal(c.status, "failed");
    assert.equal(c.error, "API Error: Request was aborted.");
    assert.equal(compactionText(c), "Compaction canceled.");
  });

  it("stops one still running when its turn ends, or Claude goes", () => {
    const running = fold([...prompt("/compact", "p1"), compacting()]);
    assert.equal(compactions(fold([result({ num_turns: 0 })], running))[0].status, "stopped");
    assert.equal(compactions(applyEvent(running, { seq: 9, kind: "ended", payload: { reason: "exit", code: 1 } }))[0].status, "stopped");
  });

  it("splits a turn's work around an auto-compaction in the middle of it, so the line stays in view", () => {
    const s = fold([
      ...prompt("Read the notes", "p1"),
      ...toolCall("m1", "t1"),
      compacting(true),
      compacted(),
      boundary("auto", 69794, 19759),
      summary(true),
      ...toolCall("m2", "t2"),
      reply("m3", "Done."),
      result(),
    ]);
    assert.deepEqual(shape(chatRows(s.items)), ["user", "work[assistant]", "compaction", "work[assistant]", "assistant", "turn"]);
    const [c] = compactions(s);
    assert.equal(c.trigger, "auto");
    assert.equal(compactionText(c), "Auto-compacted · 70k → 20k tokens · 7.8s");
    assert.ok(c.summary?.startsWith("1. Primary Request"));
  });

  it("names an automatic one as such while it runs", () => {
    const s = fold([...prompt("Read the notes", "p1"), ...toolCall("m1", "t1"), compacting(true)]);
    assert.equal(compactionText(compactions(s)[0]), "Context full: compacting…");
  });

  it("finds a compaction by its summary alone, in a chat saved before Kumiko kept Claude's compaction messages", () => {
    const s = fold([...prompt("Read notes1.txt", "p1"), reply("m1", "About 570 lines."), result(), ...prompt("/compact", "p2"), summary(), result({ num_turns: 0 }), ...prompt("What colour?", "p3")]);
    assert.deepEqual(s.items.map((i) => i.type), ["user", "assistant", "turn", "user", "compaction", "user"]);
    const [c] = compactions(s);
    assert.equal(compactionText(c), "Compacted");
    assert.ok(c.summary?.startsWith("1. Primary Request"));
    assert.equal(lastCompaction(s.items), 4);
  });

  it("keeps the summary's text, without what Claude wraps it in for itself", () => {
    assert.equal(summaryText(SUMMARY).split("\n")[0], "1. Primary Request and Intent:");
    assert.ok(!summaryText(SUMMARY).includes("transcript"));
    assert.equal(summaryText("Just this."), "Just this.");
  });
});

describe("going back across a compaction", () => {
  // p1's turn, then /compact (p2), then p3 and p4 after it.
  const s = fold([...manualCompact, ...prompt("What colour?", "p3"), reply("m3", "Teal."), result(), ...prompt("And?", "p4"), reply("m4", "That's all."), result()]);
  const at = (id: string) => s.items.findIndex((i: ChatItem) => i.type === "user" && i.id === id);

  it("finds the last compaction", () => {
    assert.equal(lastCompaction(s.items), at("p2") + 1);
    assert.equal(lastCompaction(fold(prompt("hi", "p1")).items), -1);
  });

  it("only rewinds to a prompt after it, or to the first, which starts afresh, and only forks where the cut comes after it", () => {
    const limits = branchLimits(s.items);
    const key = (id: string) => s.items[at(id)].key;
    // Rewinding to p1 starts afresh; forking from it cuts at p1's reply, before the compaction.
    assert.deepEqual(limits.get(key("p1")), { noRewind: false, noFork: true });
    // Rewinding to /compact cuts at p1's reply too; forking from it cuts at what it left, after.
    assert.deepEqual(limits.get(key("p2")), { noRewind: true, noFork: false });
    assert.equal(limits.get(key("p3")), undefined);
    assert.equal(limits.get(key("p4")), undefined);
    assert.equal(branchLimits(fold(prompt("hi", "p1")).items).size, 0);
  });
});

describe("context meter", () => {
  const ctx = (payload: { tokens: number; window: number; autoCompact: boolean; threshold?: number }): SessionEvent => ({ seq: 1, kind: "context", payload });
  const ev = (payload: Record<string, unknown> & { type: string }): SessionEvent => ({ seq: 1, kind: "claude", payload });

  it("takes what Claude says when asked, then follows the main thread's messages", () => {
    let c = applyContextEvent(undefined, ctx({ tokens: 18985, window: 1_000_000, autoCompact: true, threshold: 967_000 }));
    c = applyContextEvent(c, ev({ type: "assistant", parent_tool_use_id: null, message: { usage: { input_tokens: 2, cache_creation_input_tokens: 9118, cache_read_input_tokens: 47862, output_tokens: 109 } } }));
    assert.equal(c?.tokens, 57091);
    // A subagent's context is its own.
    const sub = applyContextEvent(c, ev({ type: "assistant", parent_tool_use_id: "toolu_1", message: { usage: { input_tokens: 2, cache_read_input_tokens: 15806 } } }));
    assert.equal(sub, c);
    // A reply Claude makes up itself carries no usage.
    assert.equal(applyContextEvent(c, ev({ type: "assistant", message: { model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 } } })), c);
  });

  it("says when it's compacting, and drops to what's left after", () => {
    let c: ContextState | undefined = { tokens: 69794, window: 100_000, autoCompact: true, threshold: 67_000, compacting: false };
    c = applyContextEvent(c, ev({ type: "system", subtype: "status", status: "compacting" }));
    assert.equal(c?.compacting, true);
    c = applyContextEvent(c, ev({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 69794, post_tokens: 19759 } }));
    assert.deepEqual(c, { tokens: 19759, window: 100_000, autoCompact: true, threshold: 67_000, compacting: false });
  });

  it("stops saying it's compacting when the turn ends, even unsaid how, but not on a late answer from before", () => {
    const running: ContextState = { tokens: 69794, window: 100_000, autoCompact: true, threshold: 67_000, compacting: true };
    assert.equal(applyContextEvent(running, ev({ type: "result", subtype: "error_during_execution" }))?.compacting, false);
    assert.equal(applyContextEvent(running, ctx({ tokens: 69000, window: 100_000, autoCompact: true, threshold: 67_000 }))?.compacting, true);
  });

  it("shows nothing until the window is known", () => {
    assert.equal(contextMeter(undefined), undefined);
    assert.equal(contextMeter({ tokens: 500, compacting: false }), undefined);
  });

  it("is quiet, then counts down to auto-compaction, then offers to compact now", () => {
    const at = (tokens: number) => contextMeter({ tokens, window: 1_000_000, autoCompact: true, threshold: 967_000, compacting: false })!;
    assert.deepEqual([at(184_000).level, at(184_000).text, at(184_000).compactNow], ["ok", "19%", false]);
    assert.deepEqual([at(830_000).level, at(830_000).text, at(830_000).compactNow], ["warn", "14% until auto-compact", false]);
    assert.deepEqual([at(940_000).level, at(940_000).text, at(940_000).compactNow], ["high", "3% until auto-compact", true]);
    assert.equal(at(990_000).percent, 100);
  });

  it("measures against the whole window with auto-compaction off", () => {
    const at = (tokens: number) => contextMeter({ tokens, window: 1_000_000, autoCompact: false, compacting: false })!;
    assert.equal(at(620_000).text, "62% of context used");
    assert.deepEqual([at(960_000).text, at(960_000).compactNow], ["Context low: 4% left", true]);
  });
});
