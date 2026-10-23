import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_TOOL_RESULT_CHARS, editResult, trimMessage, truncate } from "../src/trim.js";

describe("trimMessage", () => {
  const big = "x".repeat(MAX_TOOL_RESULT_CHARS + 2048);

  it("cuts long tool results, as a string or as text blocks, and says how much went", () => {
    const m = trimMessage({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "a", content: big },
          { type: "tool_result", tool_use_id: "b", content: [{ type: "text", text: big }, { type: "image", source: {} }] },
          { type: "text", text: big },
        ],
      },
    });
    const [a, b, text] = (m.message as { content: { content?: unknown; text?: string }[] }).content;
    assert.equal(a.content, truncate(big));
    assert.match(String(a.content), /\n… 2 KB more not kept by Kumiko$/);
    assert.deepEqual(b.content, [{ type: "text", text: truncate(big) }, { type: "image", source: {} }]);
    assert.equal(text.text, big, "only tool results are cut");
  });

  it("drops tool_use_result, which repeats the output, and leaves everything else alone", () => {
    const user = { type: "user", tool_use_result: { stdout: big }, uuid: "u", message: { content: [{ type: "tool_result", content: "ok" }] } };
    assert.deepEqual(trimMessage(user), { type: "user", uuid: "u", message: { content: [{ type: "tool_result", content: "ok" }] } });
    const assistant = { type: "assistant", message: { content: [{ type: "text", text: big }] } };
    assert.equal(trimMessage(assistant), assistant);
    const replay = { type: "user", isReplay: true, message: { content: "hi" } };
    assert.equal(trimMessage(replay), replay);
  });

  it("keeps an edit's patch, without the whole file it also carries", () => {
    // As Claude Code 2.1.309 sends an Edit's result.
    const patch = [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" alpha", "-beta", "+BETA", " gamma"] }];
    const tool_use_result = { filePath: "/w/a.txt", oldString: "beta", newString: "BETA", originalFile: big, structuredPatch: patch, userModified: false, replaceAll: false };
    const m = trimMessage({ type: "user", tool_use_result, message: { content: [{ type: "tool_result", content: "ok" }] } });
    assert.deepEqual(m.tool_use_result, { userModified: false, replaceAll: false, structuredPatch: patch });
    // A Write's says whether it made the file; its content is in the call's input already.
    const created = { type: "create", filePath: "/w/n.md", content: big, structuredPatch: [], originalFile: null, userModified: false };
    assert.deepEqual(editResult(created), { type: "create", userModified: false, structuredPatch: [] });
    const cell = { new_source: "x = 2", old_source: "x = 1", cell_type: "code", language: "python", edit_mode: "replace", cell_id: "c1", error: "", notebook_path: "/w/nb.ipynb", original_file: big, updated_file: big };
    assert.deepEqual(editResult(cell), { cell_id: "c1", cell_type: "code", edit_mode: "replace", old_source: "x = 1" });
    assert.equal(editResult("Error: String to replace not found in file."), undefined);
  });

  it("cuts a long patch, and says it did", () => {
    const line = `+${"y".repeat(1023)}`;
    const patch = [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 100, lines: Array(100).fill(line) }];
    const kept = editResult({ structuredPatch: patch }) as { structuredPatch: { lines: string[] }[]; truncated?: boolean };
    assert.equal(kept.truncated, true);
    assert.equal(kept.structuredPatch[0].lines.length, 63);
  });

  it("drops the data of images and documents, in a prompt Claude echoes or in a tool result", () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: big } };
    const m = trimMessage({
      type: "user",
      isReplay: true,
      message: {
        content: [
          image,
          { type: "document", title: "notes.txt", source: { type: "text", media_type: "text/plain", data: big } },
          { type: "tool_result", tool_use_id: "a", content: [image] },
          { type: "text", text: "look" },
        ],
      },
    });
    assert.deepEqual((m.message as { content: unknown[] }).content, [
      { type: "image", source: { type: "base64", media_type: "image/png" } },
      { type: "document", title: "notes.txt", source: { type: "text", media_type: "text/plain" } },
      { type: "tool_result", tool_use_id: "a", content: [{ type: "image", source: { type: "base64", media_type: "image/png" } }] },
      { type: "text", text: "look" },
    ]);
  });

  it("keeps short text as it is", () => {
    assert.equal(truncate("short"), "short");
  });
});
