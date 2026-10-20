import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { landingAfterClose } from "../src/landing.ts";

describe("landingAfterClose", () => {
  const tabs = ["projects", "session:a", "session:b", "session:c", "new-session:1"] as const;

  it("lands on the tab to the left of the closed one", () => {
    assert.equal(landingAfterClose(tabs, "session:b"), "session:a");
    assert.equal(landingAfterClose(tabs, "session:c"), "session:b");
    assert.equal(landingAfterClose(tabs, "new-session:1"), "session:c");
  });

  it("lands on the left-most remaining tab when nothing is to the left but Projects", () => {
    assert.equal(landingAfterClose(tabs, "session:a"), "session:b");
    assert.equal(landingAfterClose(["projects", "session:a", "new-session:1"], "session:a"), "new-session:1");
  });

  it("lands on Projects only when no other tab is left", () => {
    assert.equal(landingAfterClose(["projects", "session:a"], "session:a"), "projects");
    assert.equal(landingAfterClose(["projects", "new-session:1"], "new-session:1"), "projects");
  });
});
