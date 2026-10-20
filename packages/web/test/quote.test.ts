import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { quote, quoteInsert } from "../src/quote.ts";

describe("quote", () => {
  it("puts > before each line, and a bare > on an empty one", () => {
    assert.equal(quote("one\n\ntwo"), "> one\n>\n> two");
  });

  it("drops blank lines around the text, line endings and trailing spaces", () => {
    assert.equal(quote("\n  \r\none  \r\ntwo\n\n"), "> one\n> two");
  });

  it("quotes nothing for a blank selection", () => {
    assert.equal(quote(" \n\t"), "");
  });

  it("fences code, with its language, keeping its indentation", () => {
    assert.equal(quote("if (x) {\n  y();  \n}\n", { code: true, lang: "ts" }), "> ```ts\n> if (x) {\n>   y();  \n> }\n> ```");
  });

  it("makes the fence longer than any run of backticks in the code", () => {
    assert.equal(quote("a ```` b", { code: true }), "> `````\n> a ```` b\n> `````");
  });
});

describe("quoteInsert", () => {
  it("leaves a blank line after the quote for the reply", () => {
    assert.deepEqual(quoteInsert("", "> a"), { from: 0, insert: "> a\n\n" });
  });

  it("sets the quote off from the draft by one blank line, however the draft ends", () => {
    assert.deepEqual(quoteInsert("hi", "> a"), { from: 2, insert: "\n\n> a\n\n" });
    assert.deepEqual(quoteInsert("> a\n\n", "> b"), { from: 3, insert: "\n\n> b\n\n" });
  });
});
