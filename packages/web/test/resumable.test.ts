import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resumableKey } from "../src/resumable.ts";

describe("resumableKey", () => {
  const live = { sessions: [{ id: "a1" }, { id: "b2" }], projects: [{ name: "web" }, { name: "api" }] };

  it("changes when a session opens or closes", () => {
    assert.notEqual(resumableKey({ ...live, sessions: [{ id: "a1" }] }), resumableKey(live));
  });

  it("changes when a session's tab closes while Claude finishes, and when it is to be deleted then", () => {
    const closing = resumableKey({ ...live, sessions: [{ id: "a1", closing: { delete: false } }, { id: "b2" }] });
    assert.notEqual(closing, resumableKey(live));
    assert.notEqual(resumableKey({ ...live, sessions: [{ id: "a1", closing: { delete: true } }, { id: "b2" }] }), closing);
  });

  it("changes when a project is deleted, even with no session of its open", () => {
    assert.notEqual(resumableKey({ ...live, projects: [{ name: "web" }] }), resumableKey(live));
  });

  it("stays the same when nothing it depends on changes", () => {
    assert.equal(resumableKey({ sessions: [{ id: "a1" }, { id: "b2" }], projects: [{ name: "web" }, { name: "api" }] }), resumableKey(live));
  });
});
