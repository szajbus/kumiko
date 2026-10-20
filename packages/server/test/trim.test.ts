import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_TOOL_RESULT_CHARS, trimMessage, truncate } from "../src/trim.js";

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
    assert.match(String(a.content), /\n… 2 KB more not kept by Bentomo$/);
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
