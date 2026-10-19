import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expandPastes, isMultiline, nextPasteId, pasteLabel, pasteSpans } from "../src/pastes.ts";

describe("pastes", () => {
  const code = "a\nb\nc";

  it("labels a paste with its number and the lines it adds past the first", () => {
    assert.equal(pasteLabel(1, code), "[Pasted text #1 +2 lines]");
    assert.equal(pasteLabel(3, "a\n"), "[Pasted text #3 +1 line]");
  });

  it("only labels a paste that breaks a line", () => {
    assert.equal(isMultiline("one line"), false);
    assert.equal(isMultiline(code), true);
  });

  it("numbers the next paste past the highest so far", () => {
    assert.equal(nextPasteId({}), 1);
    assert.equal(nextPasteId({ 1: code, 4: code }), 5);
  });

  it("sends each whole, known label as what it stands for", () => {
    const pastes = { 1: code, 2: "x\ny" };
    const text = `see ${pasteLabel(1, code)} and ${pasteLabel(2, "x\ny")}, twice ${pasteLabel(1, code)}`;
    assert.equal(expandPastes(text, pastes), `see ${code} and x\ny, twice ${code}`);
  });

  it("leaves a broken, unknown or miscounted label as typed", () => {
    const pastes = { 1: code };
    for (const text of ["[Pasted text #1 +2 line", "[Pasted text #2 +2 lines]", "[Pasted text #1 +5 lines]"]) {
      assert.deepEqual(pasteSpans(text, pastes), []);
      assert.equal(expandPastes(text, pastes), text);
    }
  });

  it("finds where the labels sit", () => {
    const label = pasteLabel(1, code);
    assert.deepEqual(pasteSpans(`hi ${label}`, { 1: code }), [{ id: 1, start: 3, end: 3 + label.length }]);
  });
});
