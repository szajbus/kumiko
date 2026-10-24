import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shownSource } from "../src/artifactSource.ts";

describe("an artifact's source", () => {
  it("shows, with its language, while it is written and when asked for, so Wrap shows with it", () => {
    assert.equal(shownSource("html", true, false), "html");
    assert.equal(shownSource("svg", false, true), "xml");
    assert.equal(shownSource("mermaid", true, true), "mermaid");
    assert.equal(shownSource("html", false, false), undefined, "the page is drawn");
  });

  it("never shows for artifacts that aren't drawn from a source", () => {
    for (const type of ["markdown", "image", "preview", "web"] as const) {
      assert.equal(shownSource(type, true, true), undefined, type);
    }
  });
});
