import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionEvent } from "@kumiko/shared";
import { applyEvent, blocksOf, chatRows, emptyChat, loginCards, partialToolSummary, toolSummary, type ChatItem, type ChatRow, type ChatState } from "../src/chat.ts";

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
  it("passes over events of kinds it doesn't know, as a newer Kumiko's", () => {
    const s = applyEvent(emptyChat(), { seq: 1, kind: "user_prompt", payload: { text: "hi" } });
    assert.equal(applyEvent(s, { seq: 2, kind: "board", payload: {} } as unknown as SessionEvent), s);
  });

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

  it("shows only the last logged-out card, and only while it has something to say", () => {
    const out = (key: string): ChatItem => ({ type: "error", key, message: "Claude isn't logged in.", signedOut: true });
    const user = (key: string): ChatItem => ({ type: "user", key, text: "hi" });
    const ok: ChatItem = { type: "turn", key: "t", status: "ok" };
    const account = { email: "you@example.com", plan: "max" };
    const items = [user("u1"), out("e1"), user("u2"), out("e2")];

    // Not asked yet: it may have logged in elsewhere, so nothing shows, and e2 is the card to ask about.
    assert.deepEqual(loginCards(items), { open: "e2", card: undefined, hidden: new Set(["e1", "e2"]) });
    // Still logged out: red. An answer about an older card says nothing about this one.
    assert.deepEqual(loginCards(items, { key: "e2" }).card, { key: "e2" });
    assert.equal(loginCards(items, { key: "e1", account }).card, undefined);
    // Logged in: green, and it stays after a turn works, with Retry gone once pressed.
    assert.deepEqual(loginCards(items, { key: "e2", account }).card, { key: "e2", account, retried: undefined });
    const worked = loginCards([...items, user("u3"), ok], { key: "e2", account, retried: true });
    assert.deepEqual([worked.open, worked.card, [...worked.hidden]], [undefined, { key: "e2", account, retried: true }, ["e1"]]);
    // A turn worked without a login from here: nothing left to say.
    assert.deepEqual(loginCards([...items, user("u3"), ok], { key: "e2" }), { open: undefined, card: undefined, hidden: new Set(["e1", "e2"]) });
    assert.deepEqual(loginCards([user("u1"), ok]), { open: undefined, card: undefined, hidden: new Set() });
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

  it("leaves out text Claude adds for itself, like a skill's instructions", () => {
    const s = fold([
      assistant("m1", [{ type: "tool_use", id: "t1", name: "Skill", input: { skill: "hello" } }]),
      claude({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "Launching skill: hello" }] } }),
      claude({ type: "user", isSynthetic: true, message: { content: [{ type: "text", text: "Base directory for this skill: /x\n\nSay hi." }] } }),
      claude({ type: "user", isSynthetic: true, message: { content: "Say hi." } }),
    ]);
    assert.deepEqual(ofType(s, "notice"), []);
    const [tool] = blocksOf(ofType(s, "assistant")[0]);
    assert.ok(tool.type === "tool");
    assert.equal(tool.result?.text, "Launching skill: hello");
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

  it("works out each turn's tokens from the running total, which restarts on resume", () => {
    const usage = (input: number, output: number, write: number, read: number) => ({ usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: write, cache_read_input_tokens: read } });
    const s = fold([result(usage(10, 20, 100, 0)), result(usage(15, 50, 150, 130)), result(usage(5, 5, 0, 40)), result()]);
    assert.deepEqual(ofType(s, "turn").map((t) => t.tokens), [{ total: 130, cached: 0 }, { total: 215, cached: 130 }, { total: 50, cached: 40 }, undefined]);
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

  it("shows Claude's ask to start a session, and the user's answer to it", () => {
    const asked = fold([{ kind: "proposal", payload: { id: "a1", prompt: "Fix the test.", title: "Flaky test", toolUseId: "t1" } }]);
    assert.deepEqual(ofType(asked, "proposal"), [{ type: "proposal", key: "1", id: "a1", prompt: "Fix the test.", title: "Flaky test" }]);
    const accepted = fold([{ kind: "proposal_answer", payload: { id: "a1", accepted: true, session: "s2" } }], asked, 1);
    assert.deepEqual(ofType(accepted, "proposal")[0], { type: "proposal", key: "1", id: "a1", prompt: "Fix the test.", title: "Flaky test", accepted: true, session: "s2" });
    const withCopies = fold([{ kind: "proposal", payload: { id: "a3", prompt: "Go.", artifacts: ["/f/plan.md"] } }]);
    assert.deepEqual(ofType(withCopies, "proposal")[0].artifacts, ["/f/plan.md"]);
    // A share is told to Claude with the next prompt that isn't a command.
    const shared = fold([{ kind: "shared", payload: { from: "s1", name: "Upload form", artifacts: [{ path: "/f/plan.md", title: "The plan" }] } }]);
    assert.deepEqual(ofType(shared, "shared"), [{ type: "shared", key: "1", name: "Upload form", titles: ["The plan"] }]);
    assert.equal(ofType(fold([{ kind: "user_prompt", payload: { text: "/model opus" } }], shared, 1), "shared")[0].told, undefined);
    assert.equal(ofType(fold([{ kind: "user_prompt", payload: { text: "Go on." } }], shared, 1), "shared")[0].told, true);
    // An answer to an ask that isn't there (rewound away) changes nothing.
    assert.equal(fold([{ kind: "proposal_answer", payload: { id: "a2", accepted: false } }], asked, 1), asked);
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

describe("chat rows", () => {
  const prompt = (id: string): NewEvent => ({ kind: "user_prompt", payload: { text: "go", id } });
  const toolResult = (id: string, isError = false) =>
    claude({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok", is_error: isError }] } });
  /** Each row as a short string: the item's type and its block range, or the work's rows in brackets. */
  const shape = (rows: ChatRow[]): string[] =>
    rows.map((r) => (r.type === "work" ? `work${r.done ? "" : " (open)"}[${shape(r.rows).join(" ")}]` : r.from !== undefined ? `${r.item.type}:${r.from}-${r.to}` : r.item.type));
  const work = [
    prompt("p1"),
    assistant("m1", [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Looking." }, { type: "tool_use", id: "t1", name: "Read", input: {} }]),
    toolResult("t1"),
    assistant("m2", [{ type: "tool_use", id: "t2", name: "Bash", input: {} }, { type: "tool_use", id: "t3", name: "Read", input: {} }]),
    toolResult("t2", true),
    toolResult("t3"),
    assistant("m3", [{ type: "text", text: "Here it is." }]),
  ];

  it("keeps a running turn's work in an open group", () => {
    const rows = chatRows(fold(work).items);
    assert.deepEqual(shape(rows), ["user", "work (open)[assistant assistant assistant]"]);
  });

  it("folds a finished turn's work, leaving the reply and the footer out of it", () => {
    const rows = chatRows(fold([...work, result()]).items);
    assert.deepEqual(shape(rows), ["user", "work[assistant assistant]", "assistant", "turn"]);
    const group = rows[1] as Extract<ChatRow, { type: "work" }>;
    assert.equal(group.summary, "3 tool calls (1 failed) · 1 thought · 1 message");
    assert.equal(group.tools, "Read 2, Bash 1");
  });

  it("splits a message whose text ends the turn", () => {
    const rows = chatRows(
      fold([prompt("p1"), assistant("m1", [{ type: "tool_use", id: "t1", name: "Read", input: {} }, { type: "text", text: "Done." }]), toolResult("t1"), result()]).items,
    );
    assert.deepEqual(shape(rows), ["user", "work[assistant:0-1]", "assistant:1-2", "turn"]);
  });

  const answer = "Yes, this can mostly be secured. ".repeat(12);
  const answered = [
    prompt("p1"),
    assistant("m1", [{ type: "tool_use", id: "t1", name: "Read", input: {} }]),
    toolResult("t1"),
    assistant("m2", [{ type: "text", text: answer }, { type: "tool_use", id: "t2", name: "Bash", input: {} }]),
    toolResult("t2"),
    assistant("m3", [{ type: "tool_use", id: "t3", name: "Bash", input: {} }]),
    toolResult("t3"),
    assistant("m4", [{ type: "text", text: "I've also removed the temporary copy." }]),
  ];

  it("keeps a long message in the middle of the work out of the fold", () => {
    const rows = chatRows(fold([...answered, result()]).items);
    assert.deepEqual(shape(rows), ["user", "work[assistant]", "assistant:0-1", "work[assistant:1-2 assistant]", "assistant", "turn"]);
    assert.equal((rows[2] as Extract<ChatRow, { type: "item" }>).item.key, "m-m2");
    assert.equal((rows[3] as Extract<ChatRow, { type: "work" }>).summary, "2 tool calls");
  });

  it("shows a long message the same way while the turn runs", () => {
    const rows = chatRows(fold(answered).items);
    assert.deepEqual(shape(rows), ["user", "work (open)[assistant]", "assistant:0-1", "work (open)[assistant:1-2 assistant assistant]"]);
  });

  it("keeps short remarks and headed text apart: only the latter stays out", () => {
    const rows = chatRows(
      fold([
        prompt("p1"),
        assistant("m1", [{ type: "text", text: "Now I'll look." }, { type: "tool_use", id: "t1", name: "Read", input: {} }]),
        toolResult("t1"),
        assistant("m2", [{ type: "text", text: "## Findings\nIt's fine." }, { type: "tool_use", id: "t2", name: "Bash", input: {} }]),
        toolResult("t2"),
        assistant("m3", [{ type: "text", text: "Done." }]),
        result(),
      ]).items,
    );
    assert.deepEqual(shape(rows), ["user", "work[assistant]", "assistant:0-1", "work[assistant:1-2]", "assistant", "turn"]);
  });

  it("shows Claude's asks to start a session after the work and the reply, so they don't fold away", () => {
    const ask: NewEvent = { kind: "proposal", payload: { id: "a1", prompt: "Fix the test." } };
    const call = assistant("m1", [{ type: "tool_use", id: "t1", name: "mcp__kumiko__session_start", input: {} }]);
    const running = fold([prompt("p1"), call, ask, toolResult("t1"), assistant("m2", [{ type: "text", text: "Asked." }])]).items;
    assert.deepEqual(shape(chatRows(running)), ["user", "work (open)[assistant assistant]", "proposal"]);
    const done = fold([prompt("p1"), call, ask, toolResult("t1"), assistant("m2", [{ type: "text", text: "Asked." }]), result()]).items;
    assert.deepEqual(shape(chatRows(done)), ["user", "work[assistant]", "assistant", "proposal", "turn"]);
  });

  it("leaves a turn that only talked as it is", () => {
    const rows = chatRows(fold([prompt("p1"), assistant("m1", [{ type: "text", text: "Hi." }]), result(), prompt("p2")]).items);
    assert.deepEqual(shape(rows), ["user", "assistant", "turn", "user"]);
  });
});
