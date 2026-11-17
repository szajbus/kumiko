import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { codeBlocks } from "../src/composerCode.ts";

const parts = (text: string) => codeBlocks(text).map((b) => ({ fence: text.slice(b.start, b.contentStart), code: text.slice(b.contentStart, b.contentEnd), close: text.slice(b.contentEnd, b.end), lang: b.lang }));

describe("code blocks in the composer", () => {
  it("finds a closed block, its language and its content", () => {
    assert.deepEqual(parts("Look:\n```ts\nconst a = 1;\nlet b;\n```\nthanks"), [{ fence: "```ts\n", code: "const a = 1;\nlet b;", close: "\n```", lang: "typescript" }]);
  });

  it("runs a block not closed yet to the end, as it is being typed", () => {
    assert.deepEqual(parts("```py\ndef f():"), [{ fence: "```py\n", code: "def f():", close: "", lang: "python" }]);
    assert.deepEqual(parts("```"), [{ fence: "```", code: "", close: "", lang: undefined }]);
  });

  it("closes only on a fence of the same kind, at least as long", () => {
    assert.deepEqual(parts("````md\n```\nin\n```\n````").map((p) => p.code), ["```\nin\n```"]);
    assert.deepEqual(parts("~~~\n```\n~~~").map((p) => p.code), ["```"]);
  });

  it("finds several, and takes ```x``` on one line for inline code", () => {
    assert.equal(codeBlocks("```a``` b").length, 0);
    assert.deepEqual(parts("```sh\nls\n```\n\n```\nplain\n```").map((p) => [p.code, p.lang]), [["ls", "shellscript"], ["plain", undefined]]);
    assert.deepEqual(parts("```\n```").map((p) => p.code), [""]);
  });
});
