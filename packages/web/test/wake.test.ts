import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ResumableSession, SandboxView, SessionInfo } from "@kumiko/shared";
import { projectSessions, wakeProgress } from "../src/wake.ts";

const sandbox = (over: Partial<SandboxView>): SandboxView =>
  ({ name: "web", vm: "kumiko-web", provider: "lima", status: "stopped", busy: false, sessions: 0, ...over }) as SandboxView;

const session = (id: string, over: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, sandbox: "web", status: "idle", prompt: id, startedAt: "2026-10-30T10:00:00.000Z", ...over }) as SessionInfo;

const saved = (id: string, updatedAt: string, over: Partial<SessionInfo> = {}): ResumableSession =>
  ({ ...session(id, { status: "ended", updatedAt, ...over }), claudeSessionId: `c-${id}` }) as ResumableSession;

describe("wakeProgress", () => {
  it("says what the sandbox's start is doing, with the log's last line", () => {
    const p = wakeProgress(sandbox({ busy: true, operation: { op: "starting", startedAt: "" } }), [
      { text: "$ limactl start kumiko-web", kind: "cmd" },
      { text: "guest agent is running  " },
      { text: "" },
    ]);
    assert.equal(p.text, "Starting the sandbox…");
    assert.deepEqual(p.steps.map((s) => s.state), ["now", "todo"]);
    assert.equal(p.line, "guest agent is running");
  });

  it("names provisioning once the start reaches it", () => {
    const p = wakeProgress(sandbox({ busy: true, operation: { op: "starting", startedAt: "" } }), [{ text: "— provisioning", kind: "note" }]);
    assert.equal(p.text, "Provisioning…");
  });

  it("moves on to Claude once the sandbox runs, without the log", () => {
    const p = wakeProgress(sandbox({ status: "running" }), [{ text: "done", kind: "ok" }]);
    assert.equal(p.text, "Starting Claude…");
    assert.deepEqual(p.steps.map((s) => s.state), ["done", "now"]);
    assert.equal(p.line, undefined);
  });
});

describe("projectSessions", () => {
  it("lists the project's saved sessions without a tab as closed, most recent first", () => {
    const { open, closed } = projectSessions(
      "web",
      [session("a1")],
      [saved("b2", "2026-10-30T09:00:00.000Z"), saved("c3", "2026-10-30T12:00:00.000Z"), saved("d4", "2026-10-30T13:00:00.000Z", { sandbox: "api" })],
    );
    assert.deepEqual(open.map((s) => s.id), ["a1"]);
    assert.deepEqual(closed.map((s) => s.id), ["c3", "b2"]);
  });

  it("doesn't list a session Claude finishes after its tab closed as closed, nor as open", () => {
    const finishing = session("a1", { closing: { until: "2026-10-30T14:00:00.000Z", delete: false } });
    const { open, closed } = projectSessions("web", [finishing], [saved("a1", "2026-10-30T13:00:00.000Z")]);
    assert.deepEqual(open, []);
    assert.deepEqual(closed, []);
  });

  it("puts the open sessions waiting on the user first", () => {
    const { open } = projectSessions("web", [session("a1"), session("b2", { unread: true })], []);
    assert.deepEqual(open.map((s) => s.id), ["b2", "a1"]);
  });
});
