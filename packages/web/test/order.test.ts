import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { arrange, moveTab, replaceTab } from "../src/order.ts";

describe("arrange", () => {
  it("keeps the open tabs in the given order, dropping the ones that are gone", () => {
    assert.deepEqual(arrange(["c", "x", "a", "b"], ["a", "b", "c"]), ["c", "a", "b"]);
  });

  it("puts tabs the order doesn't name last, in the order they come", () => {
    assert.deepEqual(arrange(["b"], ["a", "b", "c"]), ["b", "a", "c"]);
    assert.deepEqual(arrange([], ["a", "b"]), ["a", "b"]);
  });
});

describe("moveTab", () => {
  const tabs = ["a", "b", "c", "d"];

  it("moves a tab before or after another", () => {
    assert.deepEqual(moveTab(tabs, "d", "b", false), ["a", "d", "b", "c"]);
    assert.deepEqual(moveTab(tabs, "a", "c", true), ["b", "c", "a", "d"]);
    assert.deepEqual(moveTab(tabs, "a", "d", true), ["b", "c", "d", "a"]);
    assert.deepEqual(moveTab(tabs, "d", "a", false), ["d", "a", "b", "c"]);
  });

  it("leaves the tabs as they are when dropped on itself or on a tab that isn't there", () => {
    assert.deepEqual(moveTab(tabs, "b", "b", true), tabs);
    assert.deepEqual(moveTab(tabs, "b", "x", false), tabs);
    assert.deepEqual(moveTab(tabs, "x", "b", false), tabs);
  });
});

describe("replaceTab", () => {
  it("puts the new tab in the old one's place, out of its own", () => {
    assert.deepEqual(replaceTab(["a", "b", "c"], "b", "z"), ["a", "z", "c"]);
    assert.deepEqual(replaceTab(["z", "a", "b"], "b", "z"), ["a", "z"]);
  });

  it("leaves the new tab out when there is no old one to replace", () => {
    assert.deepEqual(replaceTab(["a", "z"], undefined, "z"), ["a"]);
    assert.deepEqual(replaceTab(["a", "z"], "x", "z"), ["a"]);
  });
});
