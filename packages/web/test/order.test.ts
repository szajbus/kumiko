import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { arrange, group, moveGroup, moveTab, replaceTab, unfolded } from "../src/order.ts";

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

describe("group", () => {
  const groupOf = (t: string) => (t.includes(":") ? t.split(":")[0] : undefined);

  it("puts each group's tabs together where its first tab is, keeping their order", () => {
    assert.deepEqual(group(["a:1", "b:1", "a:2", "c:1", "b:2"], groupOf), ["a:1", "a:2", "b:1", "b:2", "c:1"]);
  });

  it("puts tabs in no group last", () => {
    assert.deepEqual(group(["x", "a:1", "y", "b:1", "a:2"], groupOf), ["a:1", "a:2", "b:1", "x", "y"]);
  });

  it("leaves grouped tabs as they are", () => {
    const tabs = ["b:2", "b:1", "a:1", "x"];
    assert.deepEqual(group(tabs, groupOf), tabs);
  });
});

describe("moveGroup", () => {
  const groupOf = (t: string) => (t.includes(":") ? t.split(":")[0] : undefined);
  const tabs = ["a:1", "a:2", "b:1", "c:1", "c:2", "x"];

  it("moves a group's tabs before or after another group's", () => {
    assert.deepEqual(moveGroup(tabs, groupOf, "c", "a", false), ["c:1", "c:2", "a:1", "a:2", "b:1", "x"]);
    assert.deepEqual(moveGroup(tabs, groupOf, "a", "c", true), ["b:1", "c:1", "c:2", "a:1", "a:2", "x"]);
    assert.deepEqual(moveGroup(tabs, groupOf, "a", "b", true), ["b:1", "a:1", "a:2", "c:1", "c:2", "x"]);
  });

  it("leaves the tabs as they are when dropped on itself or on a group that isn't there", () => {
    assert.deepEqual(moveGroup(tabs, groupOf, "a", "a", true), tabs);
    assert.deepEqual(moveGroup(tabs, groupOf, "a", "z", false), tabs);
    assert.deepEqual(moveGroup(tabs, groupOf, "z", "a", false), tabs);
  });
});

describe("unfolded", () => {
  const groupOf = (t: string) => (t === "x" ? undefined : t[0]);
  const tabs = ["a1", "a2", "b1", "x"];

  it("leaves out the tabs of collapsed groups, keeping loose ones", () => {
    assert.deepEqual(unfolded(tabs, groupOf, new Set(["a"])), ["b1", "x"]);
    assert.deepEqual(unfolded(tabs, groupOf, new Set()), tabs);
  });

  it("keeps the tab asked for, though its group is collapsed", () => {
    assert.deepEqual(unfolded(tabs, groupOf, new Set(["a", "b"]), "a2"), ["a2", "x"]);
  });
});
