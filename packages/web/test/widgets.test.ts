import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addWidget, chatWindow, split, type Layout, type SessionEvent } from "@kumiko/shared";
import { columns, dividers, dropPreview, dropZone, lastChanges, normalize, partialJsonString, paneRects, streamingWrites, widgetLine, windowEdge, stepTowards } from "../src/widgets.ts";

describe("partial JSON strings", () => {
  it("reads a value as far as it has streamed", () => {
    assert.deepEqual(partialJsonString('{"a":"b","content":"# Hi\\nthe', "content"), { value: "# Hi\nthe", complete: false });
    assert.deepEqual(partialJsonString('{"content":"done \\"quoted\\""}', "content"), { value: 'done "quoted"', complete: true });
    assert.equal(partialJsonString('{"file_pa', "file_path"), undefined);
  });

  it("leaves an escape cut in half for the next delta", () => {
    assert.deepEqual(partialJsonString('{"content":"a\\', "content"), { value: "a", complete: false });
    assert.deepEqual(partialJsonString('{"content":"a\\u00', "content"), { value: "a", complete: false });
    assert.deepEqual(partialJsonString('{"content":"a\\u00e9', "content"), { value: "aé", complete: false });
  });
});

/** The stream events of one Write tool call, its input cut into `parts`. */
const write = (seq: number, msg: string, parts: string[]): SessionEvent[] => [
  { seq, kind: "claude", payload: { type: "stream_event", api_message_id: msg, event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "Write", input: {} } } } },
  ...parts.map((p, i): SessionEvent => ({ seq: seq + 1 + i, kind: "claude", payload: { type: "stream_event", api_message_id: msg, event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: p } } } })),
];
const result = (seq: number): SessionEvent => ({ seq, kind: "claude", payload: { type: "result" } });

describe("writes streaming in", () => {
  it("are found by path once the path is whole, in the turn under way only", () => {
    const events = [...write(1, "m1", ['{"file_path":"/d/old.md","content":"x"}']), result(3), ...write(4, "m2", ['{"file_path":"/d/./plan', '.md","content":"# Pl', "an"])];
    const writes = streamingWrites(events);
    assert.deepEqual([...writes], [["/d/plan.md", { text: "# Plan", seq: 4 }]]);
    assert.equal(streamingWrites(write(1, "m", ['{"file_path":"/d/pl'])).size, 0);
  });

  it("know when the window has caught up with them", () => {
    const events: SessionEvent[] = [
      { seq: 1, kind: "window", payload: { op: { type: "add", widget: "w2", kind: "artifact" } } },
      { seq: 2, kind: "window", payload: { op: { type: "update", widget: "w3", op: {} } } },
    ];
    assert.equal(lastChanges(events).get("w2"), 1);
    assert.equal(lastChanges([...events, { seq: 3, kind: "window", payload: { op: { type: "sync", widgets: { w2: { kind: "artifact" } } } } }]).get("w2"), 3);
    assert.equal(lastChanges(events).get("w9"), undefined);
  });

  it("name paths as the server does", () => {
    assert.equal(normalize("/a//b/./c/../d.md"), "/a/b/d.md");
  });
});

describe("the chat's lines for widget tools", () => {
  const doc = { path: "/home/u/.kumiko/shared/artifacts/abc/plan.md", type: "markdown", title: "The plan", text: "" };
  const w = split(addWidget(chatWindow(), "w2", { kind: "artifact", state: doc }), { split: "right" }, "p2", "w2");

  it("name the artifact a tool opened or changed", () => {
    assert.deepEqual(widgetLine("mcp__kumiko__artifact_open", { path: doc.path }, w), { label: "Opened", title: "The plan", widget: "w2" });
    assert.deepEqual(widgetLine("Write", { file_path: doc.path, content: "x" }, w), { label: "Wrote", title: "The plan", widget: "w2" });
    assert.deepEqual(widgetLine("Edit", { file_path: "/home/u/.kumiko/shared/artifacts/abc/./plan.md" }, w), { label: "Edited", title: "The plan", widget: "w2" });
    // A relative path, as Claude may give it, matches by its end.
    assert.equal(widgetLine("mcp__kumiko__artifact_open", { path: "artifacts/abc/plan.md" }, w)?.widget, "w2");
  });

  it("say what was shared, and with which session", () => {
    assert.deepEqual(widgetLine("mcp__kumiko__artifact_share", { session: "s2", artifacts: ["w2", "/x/notes.md"] }, w), { label: "Shared", title: "The plan, notes.md with session s2" });
    assert.deepEqual(widgetLine("mcp__kumiko__artifact_share", { session: "s2", artifacts: ["w2"] }, w, new Map([["s2", "Flaky upload"]])), { label: "Shared", title: "The plan with Flaky upload" });
    assert.deepEqual(widgetLine("mcp__kumiko__artifact_share", {}, w), { label: "Shared", title: undefined });
    assert.deepEqual(widgetLine("mcp__kumiko__session_list", {}, w), { label: "Looked at the project's sessions" });
  });

  it("leave other tools as they are", () => {
    assert.equal(widgetLine("Write", { file_path: "/elsewhere.md" }, w), undefined);
    assert.equal(widgetLine("Bash", { command: "ls" }, w), undefined);
    assert.deepEqual(widgetLine("mcp__kumiko__window_close", { pane: "p2" }, w), { label: "Closed a pane" });
    assert.deepEqual(widgetLine("mcp__kumiko__session_rename", { title: "Fix composer paste" }, w), { label: "Named the session", title: "Fix composer paste" });
    const prompt = "Bump Electron to 39.\n\nRun the tests.";
    assert.deepEqual(widgetLine("mcp__kumiko__session_start", { prompt, title: "Flaky test" }, w), { label: "Asked to start a session", title: "Flaky test", input: { label: "Prompt", text: prompt } });
    // Unnamed, it goes by the prompt's first line; still streaming in, by nothing yet.
    assert.equal(widgetLine("mcp__kumiko__session_start", { prompt }, w)?.title, "Bump Electron to 39.");
    assert.deepEqual(widgetLine("mcp__kumiko__session_start", {}, w), { label: "Asked to start a session", title: undefined });
  });

  it("say which artifact was looked at, reloaded or deleted, by its id or its path", () => {
    assert.deepEqual(widgetLine("mcp__kumiko__artifact_capture", { artifact: "w2" }, w), { label: "Looked at", title: "The plan", widget: "w2" });
    assert.deepEqual(widgetLine("mcp__kumiko__artifact_capture", { artifact: doc.path, reload: true }, w), { label: "Reloaded and looked at", title: "The plan", widget: "w2" });
    assert.deepEqual(widgetLine("mcp__kumiko__artifact_capture", {}, w), { label: "Looked at a pane" });
    assert.deepEqual(widgetLine("mcp__kumiko__artifact_reload", { artifact: "w2" }, w), { label: "Reloaded", title: "The plan", widget: "w2" });
    // Gone from the window by the time the line shows: named by its file.
    assert.deepEqual(widgetLine("mcp__kumiko__artifact_remove", { artifact: "/home/u/.kumiko/shared/artifacts/abc/old.md" }, w), { label: "Deleted", title: "old.md" });
    assert.deepEqual(widgetLine("mcp__kumiko__artifact_remove", { artifact: "http://localhost:5173/" }, w), { label: "Removed", title: "localhost:5173/" });
  });
});

describe("the window's edges", () => {
  it("are a strip along its border, the nearer one in a corner", () => {
    assert.equal(windowEdge(0.5, 0.5, 1000, 600), undefined);
    assert.equal(windowEdge(0.01, 0.5, 1000, 600), "left");
    assert.equal(windowEdge(0.5, 0.99, 1000, 600), "below");
    assert.equal(windowEdge(0.03, 0.5, 1000, 600), undefined, "30 px in is the pane's, not the window's");
    assert.equal(windowEdge(0.005, 0.02, 1000, 600), "left");
  });
});

describe("stepping a pane", () => {
  // chat | (p2 / p3)
  const rects = new Map([
    ["chat", { x: 0, y: 0, w: 0.6, h: 1 }],
    ["p2", { x: 0.6, y: 0, w: 0.4, h: 0.5 }],
    ["p3", { x: 0.6, y: 0.5, w: 0.4, h: 0.5 }],
  ]);

  it("goes past the pane next to it on that side", () => {
    assert.deepEqual(stepTowards(rects, "p3", "left"), { to: "chat", side: "left" });
    assert.deepEqual(stepTowards(rects, "p3", "above"), { to: "p2", side: "above" });
    assert.deepEqual(stepTowards(rects, "chat", "right"), { to: "p2", side: "right" });
  });

  it("goes along the window's side when nothing is there, unless it spans that side already", () => {
    assert.deepEqual(stepTowards(rects, "p3", "below"), { to: "window", side: "below" });
    assert.deepEqual(stepTowards(rects, "p2", "right"), { to: "window", side: "right" });
    assert.equal(stepTowards(rects, "chat", "left"), undefined);
    assert.deepEqual(stepTowards(rects, "chat", "above"), { to: "window", side: "above" });
  });
});

describe("placing panes", () => {
  const layout: Layout = {
    kind: "split", dir: "row", ratio: 0.6,
    a: { kind: "pane", id: "chat" },
    b: { kind: "split", dir: "column", ratio: 0.5, a: { kind: "pane", id: "p2" }, b: { kind: "pane", id: "p3" } },
  };

  it("gives each pane its share of the window", () => {
    const r = paneRects(layout);
    assert.deepEqual(r.get("chat"), { x: 0, y: 0, w: 0.6, h: 1 });
    assert.deepEqual(r.get("p2"), { x: 0.6, y: 0, w: 0.4, h: 0.5 });
    assert.deepEqual(r.get("p3"), { x: 0.6, y: 0.5, w: 0.4, h: 0.5 });
    assert.equal(columns(layout), 2);
  });

  it("stacks every split when asked", () => {
    const r = paneRects(layout, true);
    assert.deepEqual(r.get("chat"), { x: 0, y: 0, w: 1, h: 0.6 });
    assert.deepEqual(r.get("p3"), { x: 0, y: 0.8, w: 1, h: 0.2 });
  });
});

describe("dropping a pane on another", () => {
  const rect = { x: 100, y: 0, w: 400, h: 200 };

  it("swaps in the middle, and goes beside on the nearest edge elsewhere", () => {
    assert.equal(dropZone(rect, 300, 100), "swap");
    assert.equal(dropZone(rect, 110, 100), "left");
    assert.equal(dropZone(rect, 490, 100), "right");
    assert.equal(dropZone(rect, 300, 10), "above");
    assert.equal(dropZone(rect, 300, 190), "below");
    // Near a corner, the diagonal decides: closer to the top than to the left.
    assert.equal(dropZone(rect, 140, 5), "above");
    assert.equal(dropZone(rect, 104, 30), "left");
  });

  it("previews where it lands", () => {
    assert.deepEqual(dropPreview(rect, "left"), { x: 100, y: 0, w: 200, h: 200 });
    assert.deepEqual(dropPreview(rect, "below"), { x: 100, y: 100, w: 400, h: 100 });
    assert.deepEqual(dropPreview({ x: 0, y: 0, w: 1, h: 1 }, "right", 0.25), { x: 0.75, y: 0, w: 0.25, h: 1 });
    assert.deepEqual(dropPreview(rect, "swap"), rect);
  });
});

describe("dividers", () => {
  it("are one per split, with its path and room", () => {
    const layout: Layout = {
      kind: "split", dir: "row", ratio: 0.6,
      a: { kind: "pane", id: "chat" },
      b: { kind: "split", dir: "column", ratio: 0.5, a: { kind: "pane", id: "p2" }, b: { kind: "pane", id: "p3" } },
    };
    assert.deepEqual(dividers(layout), [
      { path: "", dir: "row", rect: { x: 0, y: 0, w: 1, h: 1 }, ratio: 0.6, across: [1, 1] },
      { path: "b", dir: "column", rect: { x: 0.6, y: 0, w: 0.4, h: 1 }, ratio: 0.5, across: [1, 1] },
    ]);
  });
});
