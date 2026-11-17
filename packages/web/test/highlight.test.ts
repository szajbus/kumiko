import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { languageOf, pieces, rowKey, rowTokens, tokenize } from "../src/highlight.ts";
import type { DiffRow } from "../src/diff.ts";

describe("highlighting diffs", () => {
  it("knows a file's language by its extension or its name", () => {
    assert.equal(languageOf("packages/web/src/App.tsx"), "tsx");
    assert.equal(languageOf("a/b/Dockerfile"), "docker");
    assert.equal(languageOf("Makefile"), "make");
    assert.equal(languageOf(".github/workflows/test.yml"), "yaml");
    assert.equal(languageOf(".env.local"), "dotenv");
    assert.equal(languageOf("notes.txt"), undefined);
    assert.equal(languageOf("README"), undefined);
  });

  it("splits tokens where the changed part starts and ends", () => {
    const tokens = [{ content: "const ", color: "#k" }, { content: "a = 1", color: "#v" }, { content: ";" }];
    assert.deepEqual(pieces("const a = 1;", tokens, [4, 8]), [
      { text: "cons", color: "#k", marked: false },
      { text: "t ", color: "#k", marked: true },
      { text: "a ", color: "#v", marked: true },
      { text: "= 1", color: "#v", marked: false },
      { text: ";", marked: false },
    ]);
  });

  it("ignores tokens that don't spell the line, keeping the mark", () => {
    assert.deepEqual(pieces("abc", [{ content: "xyz", color: "#k" }], [1, 2]), [
      { text: "a", marked: false },
      { text: "b", marked: true },
      { text: "c", marked: false },
    ]);
  });

  it("colours each side knowing the lines before it", async () => {
    const lines = await tokenize(["/* a", "still comment */", "const x = 1;"], "typescript");
    assert.ok(lines);
    const color = (line: number, text: string) => lines[line].find((t) => t.content.includes(text))?.color;
    assert.equal(color(1, "still"), color(0, "a"), "the second line is inside the comment");
    assert.notEqual(color(2, "const"), color(1, "still"));
    assert.equal(await tokenize(["x"], "no-such-language"), undefined);
  });

  it("gives removed lines the old side's tokens and the rest the new side's", async () => {
    const rows: DiffRow[] = [
      { kind: "context", text: "const a = `", old: 1, new: 1 },
      { kind: "remove", text: "old`;", old: 2 },
      { kind: "add", text: "new`;", new: 2 },
    ];
    const map = await rowTokens(rows, "typescript");
    assert.deepEqual(map.get(rowKey(rows[1]))?.map((t) => t.content).join(""), "old`;");
    assert.deepEqual(map.get(rowKey(rows[2]))?.map((t) => t.content).join(""), "new`;");
    // Both are inside the template string the context line opened.
    assert.equal(map.get(rowKey(rows[1]))![0].color, map.get(rowKey(rows[2]))![0].color);
  });
});

describe("highlighting code blocks", () => {
  it("knows a block's language by its fence, as people write it", async () => {
    const { fenceLanguage } = await import("../src/highlight.ts");
    assert.equal(fenceLanguage("ts"), "typescript");
    assert.equal(fenceLanguage("typescript"), "typescript");
    assert.equal(fenceLanguage("sh"), "shellscript");
    assert.equal(fenceLanguage("console"), "shellscript");
    assert.equal(fenceLanguage("Python"), "python");
    assert.equal(fenceLanguage("js {1,3}"), "javascript");
    assert.equal(fenceLanguage("text"), undefined);
    assert.equal(fenceLanguage("mermaid"), undefined);
    assert.equal(fenceLanguage(undefined), undefined);
  });
});
