import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionEvent } from "@kumiko/shared";
import { applyEvent, blocksOf, emptyChat, type Block, type ChatState } from "../src/chat.ts";
import { fileDiff, MAX_ROWS, newText, shortPath, shownRows, stringRows, workChanges, type DiffRow } from "../src/diff.ts";

type NewEvent = SessionEvent extends infer E ? (E extends unknown ? Omit<E, "seq"> : never) : never;
type Tool = Extract<Block, { type: "tool" }>;

function fold(events: NewEvent[]): ChatState {
  let seq = 0;
  return events.reduce((s, e) => applyEvent(s, { ...e, seq: ++seq } as SessionEvent), emptyChat());
}
const claude = (payload: Record<string, unknown> & { type: string }): NewEvent => ({ kind: "claude", payload });
const call = (id: string, name: string, input: Record<string, unknown>, parent?: string) =>
  claude({ type: "assistant", ...(parent ? { parent_tool_use_id: parent } : {}), message: { id: `m-${id}`, content: [{ type: "tool_use", id, name, input }] } });
/** A tool's result as Claude 2.1.309 sends it: the tool_result, and beside the message, its structured form. */
const done = (id: string, text: string, toolUseResult?: unknown, isError = false, parent?: string) =>
  claude({
    type: "user",
    ...(parent ? { parent_tool_use_id: parent } : {}),
    message: { content: [{ type: "tool_result", tool_use_id: id, content: text, ...(isError ? { is_error: true } : {}) }] },
    ...(toolUseResult !== undefined ? { tool_use_result: toolUseResult } : {}),
  });
const tools = (s: ChatState): Tool[] => s.items.flatMap((i) => (i.type === "assistant" ? blocksOf(i) : [])).filter((b): b is Tool => b.type === "tool");
const brief = (rows: DiffRow[]) => rows.map((r) => `${{ context: " ", add: "+", remove: "-", gap: "~" }[r.kind]}${r.old ?? ""}:${r.new ?? ""} ${r.text}`);

// From Claude Code 2.1.309: Read app.py, then change greet's "Hello, " to "Hi, ".
const editInput = { replace_all: false, file_path: "/w/app.py", old_string: '    print("Hello, " + name)', new_string: '    print("Hi, " + name)' };
const editPatch = [{ oldStart: 3, oldLines: 7, newStart: 3, newLines: 7, lines: [" ", " ", " def greet(name):", '-    print("Hello, " + name)', '+    print("Hi, " + name)', "     return name", " ", " "] }];
const editResult = { filePath: "/w/app.py", oldString: editInput.old_string, newString: editInput.new_string, structuredPatch: editPatch, userModified: false, replaceAll: false };

describe("file diffs", () => {
  it("draws an Edit from Claude's patch, numbered, with what changed in the line marked", () => {
    const [edit] = tools(fold([call("t1", "Edit", editInput), done("t1", "The file /w/app.py has been updated successfully.", editResult)]));
    const d = fileDiff(edit)!;
    assert.deepEqual([d.added, d.removed, d.numbered, d.fromPatch], [1, 1, true, true]);
    assert.deepEqual(brief(d.rows), [" 3:3 ", " 4:4 ", " 5:5 def greet(name):", '-6: ' + editInput.old_string, '+:6 ' + editInput.new_string, " 7:7     return name", " 8:8 ", " 9:9 "]);
    assert.deepEqual(d.rows[3].mark, [12, 16], "ello");
    assert.deepEqual(d.rows[4].mark, [12, 13], "i");
  });

  it("puts a gap between hunks, saying how many lines it leaves out", () => {
    const patch = [
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" a", "-b", "+B", " c"] },
      { oldStart: 20, oldLines: 2, newStart: 20, newLines: 2, lines: [" t", "-u", "+U"] },
    ];
    const [edit] = tools(fold([call("t1", "Edit", { file_path: "/w/x", old_string: "b", new_string: "B", replace_all: true }), done("t1", "ok", { structuredPatch: patch, replaceAll: true })]));
    const d = fileDiff(edit)!;
    assert.deepEqual(brief(d.rows), [" 1:1 a", "-2: b", "+:2 B", " 3:3 c", "~: ", " 20:20 t", "-21: u", "+:21 U"]);
    assert.equal(d.rows[4].skipped, 16);
    assert.equal(d.replaceAll, true);
  });

  it("diffs an edit's input where Claude sent no patch: a subagent's, or one kept before Kumiko kept patches", () => {
    const [sub] = tools(fold([call("t1", "Edit", { file_path: "/w/f", old_string: "alpha\nbeta\ngamma", new_string: "alpha\nBETA\ngamma\ndelta" }), done("t1", "The file /w/f has been updated successfully.")]));
    const d = fileDiff(sub)!;
    assert.deepEqual(brief(d.rows), [" : alpha", "-: beta", "+: BETA", " : gamma", "+: delta"]);
    assert.deepEqual([d.added, d.removed, d.numbered, d.fromPatch], [2, 1, false, false]);
  });

  it("shows a Write of a new file as its lines added, numbered from 1", () => {
    const content = "# Notes\n\n- First note\n";
    const created = { type: "create", filePath: "/w/notes.md", content, structuredPatch: [], originalFile: null, userModified: false };
    const [write] = tools(fold([call("t1", "Write", { file_path: "/w/notes.md", content }), done("t1", "File created successfully at: /w/notes.md", created)]));
    const d = fileDiff(write)!;
    assert.deepEqual(brief(d.rows), ["+:1 # Notes", "+:2 ", "+:3 - First note"]);
    assert.equal(d.created, true);
    // Without the structured result, its text says it was new all the same.
    const [bare] = tools(fold([call("t2", "Write", { file_path: "/w/notes.md", content }), done("t2", "File created successfully at: /w/notes.md")]));
    assert.equal(fileDiff(bare)!.created, true);
  });

  it("shows a Write over a file from its patch, or as rewritten when there is none", () => {
    const patch = [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 4, lines: ["-# Notes", "+# Todo", " ", " - First note", "-- Second note", "-- Third note", "+- New item"] }];
    const content = "# Todo\n\n- First note\n- New item\n";
    const s = fold([
      call("t1", "Write", { file_path: "/w/notes.md", content }),
      done("t1", "The file /w/notes.md has been updated successfully.", { type: "update", structuredPatch: patch, userModified: false }),
      call("t2", "Write", { file_path: "/w/notes.md", content }),
      done("t2", "The file /w/notes.md has been updated successfully."),
    ]);
    const [withPatch, without] = tools(s).map((t) => fileDiff(t)!);
    assert.deepEqual([withPatch.added, withPatch.removed, withPatch.rewrote], [2, 3, undefined]);
    assert.deepEqual([without.added, without.removed, without.rewrote, without.created], [4, 0, true, undefined]);
  });

  it("shows a failed edit's error, and what it tried, changing nothing", () => {
    const input = { file_path: "/w/app.py", old_string: "THIS DOES NOT EXIST", new_string: "x" };
    const [edit] = tools(fold([call("t1", "Edit", input), done("t1", "<tool_use_error>String to replace not found in file.\nString: THIS DOES NOT EXIST</tool_use_error>", "Error: String to replace not found in file.\nString: THIS DOES NOT EXIST", true)]));
    const d = fileDiff(edit)!;
    assert.equal(d.error, "String to replace not found in file.\nString: THIS DOES NOT EXIST");
    assert.deepEqual(brief(d.rows), ["-: THIS DOES NOT EXIST", "+: x"]);
    assert.deepEqual([d.added, d.removed], [0, 0]);
  });

  it("draws an edit as far as its input has streamed", () => {
    const s = fold([
      claude({ type: "stream_event", api_message_id: "m1", event: { type: "message_start", message: { id: "m1" } } }),
      claude({ type: "stream_event", api_message_id: "m1", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "Edit", input: {} } } }),
      claude({ type: "stream_event", api_message_id: "m1", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"replace_all": false, "file_path": "/w/app.py", "old_string": "Hello\\nthere", "new_string": "Hi\\nth' } } }),
    ]);
    const [edit] = tools(s);
    const d = fileDiff(edit)!;
    assert.equal(d.path, "/w/app.py");
    assert.deepEqual(brief(d.rows), ["-: Hello", "-: there", "+: Hi", "+: th"]);
  });

  it("diffs a NotebookEdit's cell against the source Claude says it had", () => {
    const cell = { new_source: "x = 2\nprint(x * 10)", old_source: "x = 1\nprint(x)", cell_type: "code", edit_mode: "replace", cell_id: "c1" };
    const [nb] = tools(fold([call("t1", "NotebookEdit", { notebook_path: "/w/nb.ipynb", cell_id: "c1", new_source: cell.new_source }), done("t1", "Updated cell c1 with x = 2\nprint(x * 10)", cell)]));
    const d = fileDiff(nb)!;
    assert.deepEqual([d.path, d.cell, d.added, d.removed], ["/w/nb.ipynb", "c1", 2, 2]);
  });

  it("says when the user changed Claude's edit before allowing it", () => {
    const [edit] = tools(fold([call("t1", "Edit", editInput), done("t1", "ok", { ...editResult, userModified: true })]));
    assert.equal(fileDiff(edit)!.userModified, true);
  });

  it("is only for the tools that edit files", () => {
    const [bash] = tools(fold([call("t1", "Bash", { command: "ls" }), done("t1", "a")]));
    assert.equal(fileDiff(bash), undefined);
    const [multi] = tools(fold([call("t2", "MultiEdit", { file_path: "/w/a", edits: [] }), done("t2", "ok")]));
    assert.equal(fileDiff(multi), undefined);
  });

  it("cuts a long diff, between hunks where it can", () => {
    const rows = stringRows("", Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"));
    assert.equal(shownRows(rows, false).length, 30);
    assert.equal(shownRows(rows, true).length, 50);
    assert.equal(shownRows(rows.slice(0, MAX_ROWS), false).length, MAX_ROWS);
    const gapped: DiffRow[] = [...rows.slice(0, 25), { kind: "gap", text: "", skipped: 3 }, ...rows.slice(25)];
    assert.equal(shownRows(gapped, false).length, 25);
  });

  it("copies the new side", () => {
    assert.equal(newText(stringRows("a\nb\nc", "a\nB\nc")), "a\nB\nc");
  });

  it("shortens a path in the working folder", () => {
    assert.deepEqual(shortPath("/w/src/app.py", "/w"), { dir: "src/", name: "app.py" });
    assert.deepEqual(shortPath("/w/app.py", "/w/"), { dir: "", name: "app.py" });
    assert.deepEqual(shortPath("/elsewhere/app.py", "/w"), { dir: "/elsewhere/", name: "app.py" });
    assert.deepEqual(shortPath("/wide/app.py", "/w"), { dir: "/wide/", name: "app.py" });
  });

  it("sums the files a turn's work changed, its subagents' too, counting a file once", () => {
    const s = fold([
      call("t1", "Edit", editInput),
      done("t1", "ok", editResult),
      call("t2", "Edit", { file_path: "/w/app.py", old_string: "a", new_string: "b" }),
      done("t2", "ok"),
      call("t3", "Edit", { file_path: "/w/b.py", old_string: "x", new_string: "y" }),
      done("t3", "<tool_use_error>String to replace not found in file.</tool_use_error>", undefined, true),
      call("a1", "Agent", { description: "Fix it", prompt: "Fix it" }),
      call("s1", "Write", { file_path: "/w/sub.txt", content: "hello\n" }, "a1"),
      done("s1", "File created successfully at: /w/sub.txt", undefined, false, "a1"),
      done("a1", "Fixed."),
    ]);
    const blocks = s.items.flatMap((i) => (i.type === "assistant" ? blocksOf(i) : []));
    assert.deepEqual(workChanges(blocks, s.agents), { files: 2, added: 3, removed: 2 });
    assert.equal(workChanges([], s.agents), undefined);
  });
});
