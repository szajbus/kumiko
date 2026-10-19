import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionEvent } from "@bentomo/shared";
import { applyEvent, blocksOf, emptyChat, partialToolSummary, toolSummary, type ChatItem, type ChatState } from "../src/chat.ts";

type NewEvent = SessionEvent extends infer E ? (E extends unknown ? Omit<E, "seq"> : never) : never;

/** Folds events into a chat, numbering them as the server would. */
function fold(events: NewEvent[], from: ChatState = emptyChat(), seq = 0): ChatState {
  return events.reduce((s, e) => applyEvent(s, { ...e, seq: ++seq } as SessionEvent), from);
}

const claude = (payload: Record<string, unknown> & { type: string }): NewEvent => ({ kind: "claude", payload });
const stream = (id: string, event: Record<string, unknown>) => claude({ type: "stream_event", api_message_id: id, event });
const assistant = (id: string, content: unknown[]) => claude({ type: "assistant", message: { id, content } });
const result = (extra: Record<string, unknown> = {}) => claude({ type: "result", subtype: "success", duration_ms: 1200, ...extra });
const ofType = <T extends ChatItem["type"]>(s: ChatState, type: T) => s.items.filter((i): i is Extract<ChatItem, { type: T }> => i.type === type);

describe("chat", () => {
  it("shows a logged-out turn as one error, in place of Claude's reply and the failed turn", () => {
    const signedOut: NewEvent = { kind: "error", payload: { message: "Claude isn't logged in.", hint: "Log in to continue.", signedOut: true } };
    const s = fold([
      { kind: "user_prompt", payload: { text: "hi", id: "p1" } },
      assistant("m1", [{ type: "text", text: "Not logged in · Please run /login" }]),
      result({ subtype: "success", is_error: true, result: "Not logged in · Please run /login" }),
      signedOut,
    ]);
    assert.deepEqual(s.items.map((i) => i.type), ["user", "error"]);
    assert.deepEqual(s.messages, {}, "the dropped reply leaves no index behind");

    // A turn that did more than fail on the login keeps everything.
    const worked = fold([
      { kind: "user_prompt", payload: { text: "hi", id: "p1" } },
      assistant("m1", [{ type: "text", text: "Done." }]),
      result(),
      signedOut,
    ]);
    assert.deepEqual(worked.items.map((i) => i.type), ["user", "assistant", "turn", "error"]);
  });

  it("shows streamed text as it arrives, then the finished message in its place", () => {
    const streaming = fold([
      { kind: "user_prompt", payload: { text: "hi", id: "p1" } },
      stream("m1", { type: "message_start", message: { id: "m1" } }),
      stream("m1", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      stream("m1", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }),
      stream("m1", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } }),
    ]);
    const [draft] = ofType(streaming, "assistant");
    assert.deepEqual(blocksOf(draft), [{ type: "text", text: "Hello" }]);

    const done = fold([assistant("m1", [{ type: "text", text: "Hello!" }])], streaming, 5);
    const [msg] = ofType(done, "assistant");
    assert.deepEqual(blocksOf(msg), [{ type: "text", text: "Hello!" }]);
    assert.equal(ofType(done, "assistant").length, 1, "the finished message replaces its draft, not adds to it");
  });

  it("keeps streamed thinking when the finished block comes back empty", () => {
    const s = fold([
      stream("m1", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
      stream("m1", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm", estimated_tokens: 12 } }),
      assistant("m1", [{ type: "thinking", thinking: "" }]),
    ]);
    assert.deepEqual(blocksOf(ofType(s, "assistant")[0]), [{ type: "thinking", text: "hmm", tokens: 12 }]);
  });

  it("attaches tool results to their call", () => {
    const s = fold([
      assistant("m1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]),
      claude({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a\nb" }], is_error: true }] } }),
    ]);
    const [tool] = blocksOf(ofType(s, "assistant")[0]);
    assert.ok(tool.type === "tool");
    assert.deepEqual(tool.result, { text: "a\nb", isError: true });
  });

  it("marks a prompt rewindable once Claude echoes it", () => {
    const s = fold([{ kind: "user_prompt", payload: { text: "hi", id: "p1" } }, claude({ type: "user", isReplay: true, uuid: "p1", message: { content: "hi" } })]);
    const users = ofType(s, "user");
    assert.equal(users.length, 1, "the echo isn't shown again");
    assert.equal(users[0].replayed, true);
  });

  it("works out each turn's cost from the running total, which restarts on resume", () => {
    const s = fold([result({ total_cost_usd: 0.5 }), result({ total_cost_usd: 0.75 }), result({ total_cost_usd: 0.1 })]);
    assert.deepEqual(ofType(s, "turn").map((t) => t.costUsd), [0.5, 0.25, 0.1]);
  });

  it("gives a slash command no footer, and shows Stop as an interruption rather than an error", () => {
    const s = fold([
      result({ num_turns: 0 }),
      { kind: "interrupt", payload: {} },
      claude({ type: "result", subtype: "error_during_execution", is_error: true }),
      claude({ type: "result", subtype: "error_max_turns", is_error: true, errors: ["too many"] }),
    ]);
    assert.deepEqual(ofType(s, "turn").map((t) => [t.status, t.message]), [["interrupted", undefined], ["error", "too many"]]);
  });

  it("leaves subagents' messages out of the main thread", () => {
    const s = fold([claude({ type: "assistant", parent_tool_use_id: "t1", message: { id: "m9", content: [{ type: "text", text: "sub" }] } })]);
    assert.deepEqual(s.items, []);
  });

  it("offers Claude's suggestion until a prompt is sent", () => {
    const s = fold([claude({ type: "prompt_suggestion", suggestion: "run the tests" })]);
    assert.equal(s.suggestion, "run the tests");
    assert.equal(fold([{ kind: "user_prompt", payload: { text: "x" } }], s, 1).suggestion, undefined);
  });

  it("keeps the identity of items an event didn't touch, so memoised rows don't re-render", () => {
    const before = fold([{ kind: "user_prompt", payload: { text: "hi" } }, assistant("m1", [{ type: "text", text: "a" }])]);
    const after = fold([stream("m2", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })], before, 2);
    assert.equal(after.items[0], before.items[0]);
    assert.equal(after.items[1], before.items[1]);
  });

  it("skips events it doesn't understand", () => {
    const s = fold([claude({ type: "something_new" }), stream("m1", { type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "x" } })]);
    assert.ok(s.items.every((i) => i.type !== "assistant" || blocksOf(i).length === 0));
  });
});

describe("tool summaries", () => {
  it("prefers the path or command, first line only", () => {
    assert.equal(toolSummary({ description: "list", command: "ls -la\necho" }), "ls -la");
    assert.equal(toolSummary({ other: "x" }), "x");
    assert.equal(toolSummary({}), "");
  });

  it("reads as much as has streamed of the input JSON", () => {
    assert.equal(partialToolSummary('{"file_path": "/a/b'), "/a/b");
    assert.equal(partialToolSummary('{"command": "echo \\"hi\\"\\nls'), 'echo "hi"');
    assert.equal(partialToolSummary('{"command": "x\\'), "x");
    assert.equal(partialToolSummary('{"nothing": 1'), "");
  });
});
