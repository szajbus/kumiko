import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionEvent } from "@kumiko/shared";
import { applyEvent, chatRows, emptyChat, type ChatItem, type ChatState } from "../src/chat.ts";
import { endText, foldMonitorTurns, foregroundTask, listed, runningTasks, timeLimit, type MonitorRow } from "../src/tasks.ts";

type NewEvent = SessionEvent extends infer E ? (E extends unknown ? Omit<E, "seq"> : never) : never;

function fold(events: NewEvent[], from: ChatState = emptyChat(), seq = 0): ChatState {
  return events.reduce((s, e) => applyEvent(s, { ...e, seq: ++seq } as SessionEvent), from);
}

const claude = (payload: Record<string, unknown> & { type: string }): NewEvent => ({ kind: "claude", payload });
const call = (id: string, name: string, input: Record<string, unknown>, parent?: string) =>
  claude({ type: "assistant", message: { id: `m-${id}`, content: [{ type: "tool_use", id, name, input }] }, ...(parent ? { parent_tool_use_id: parent } : {}) });
const text = (id: string, t: string) => claude({ type: "assistant", message: { id, content: [{ type: "text", text: t }] } });
const init = () => claude({ type: "system", subtype: "init" });
const result = () => claude({ type: "result", subtype: "success", duration_ms: 900 });
const started = (taskId: string, toolUseId: string, extra: Record<string, unknown> = {}) =>
  claude({ type: "system", subtype: "task_started", task_id: taskId, tool_use_id: toolUseId, description: `task ${taskId}`, is_backgrounded: true, task_type: "local_bash", received_at: "2026-10-23T14:02:00.000Z", ...extra });
const notified = (taskId: string, status: string, summary: string) =>
  claude({ type: "system", subtype: "task_notification", task_id: taskId, status, output_file: "", summary, received_at: "2026-10-23T14:05:00.000Z" });
const ofType = <T extends ChatItem["type"]>(s: ChatState, type: T) => s.items.filter((i): i is Extract<ChatItem, { type: T }> => i.type === type);

describe("background tasks", () => {
  it("lists shells, monitors and subagents in the background, with a subagent's shells under it", () => {
    const s = fold([
      { kind: "user_prompt", payload: { text: "go", id: "p1" } },
      call("t-dev", "Bash", { command: "npm run dev", description: "Start the dev server", run_in_background: true }),
      started("b-dev", "t-dev"),
      call("t-mon", "Monitor", { command: "tail -F build.log", description: "Watch the build", timeout_ms: 600000 }),
      started("b-mon", "t-mon"),
      call("t-agent", "Agent", { description: "Run the tests", run_in_background: true }),
      started("a-1", "t-agent", { task_type: "local_agent" }),
      call("t-sub", "Bash", { command: "npx vitest", run_in_background: true }, "t-agent"),
      started("b-sub", "t-sub", { parent_task_id: "a-1", owned_by_subagent: true }),
      // A foreground command isn't in the background, so isn't listed; one that ended is listed apart.
      call("t-fg", "Bash", { command: "npm test" }),
      started("b-fg", "t-fg", { is_backgrounded: false }),
      call("t-old", "Bash", { command: "npm ci", run_in_background: true }),
      started("b-old", "t-old"),
      notified("b-old", "completed", 'Background command "npm ci" completed (exit code 0)'),
    ]);
    const { running, ended } = listed(s.tasks);
    assert.deepEqual(running.map((t) => [t.id, t.kind]), [["b-dev", "shell"], ["b-mon", "monitor"], ["a-1", "agent"], ["b-sub", "shell"]]);
    assert.equal(running[0].command, "npm run dev");
    assert.equal(running[0].startedAt, Date.parse("2026-10-23T14:02:00.000Z"));
    assert.equal(timeLimit(running[0]), Date.parse("2026-10-23T14:32:00.000Z"), "Claude's 30 minutes, by default");
    assert.equal(timeLimit(running[1]), Date.parse("2026-10-23T14:12:00.000Z"), "a monitor's own timeout");
    assert.deepEqual(ended.map((t) => [t.id, endText(t)]), [["b-old", "exit 0"]]);
    assert.equal(runningTasks(s.tasks).length, 4);
    assert.equal(foregroundTask(s.tasks, "t-fg")?.id, "b-fg", "a command Claude waits on can be moved");
    assert.equal(foregroundTask(s.tasks, "t-dev"), undefined);

    // Moved to the background, it is listed, with Claude's limit there rather than its foreground timeout.
    const timed = fold([call("t-fg2", "Bash", { command: "npm test", timeout: 120000 }), started("b-fg2", "t-fg2", { is_backgrounded: false })], s, 100);
    const moved = fold([claude({ type: "system", subtype: "task_updated", task_id: "b-fg2", patch: { is_backgrounded: true } })], timed, 200);
    const task = listed(moved.tasks).running.find((t) => t.id === "b-fg2")!;
    assert.equal(timeLimit(task), Date.parse("2026-10-23T14:32:00.000Z"));
  });

  it("says how each ended, keeps what it printed, and loses what Claude took with it", () => {
    const s = fold([
      started("b1", "t1"),
      started("b2", "t2"),
      started("b3", "t3"),
      started("b4", "t4"),
      started("b5", "t5"),
      notified("b1", "failed", 'Background command "tsc" failed with exit code 2'),
      { kind: "task_stop", payload: { taskId: "b2" } },
      notified("b2", "stopped", "tail the log"),
      notified("b3", "stopped", 'Background command "vite" was stopped after reaching its background time limit'),
      { kind: "task_output", payload: { taskId: "b1", output: "error TS2304\n\n[exited with code 2]\n", totalBytes: 34, truncated: false } },
      { kind: "tasks_lost", payload: { taskIds: ["b4"] } },
    ]);
    const t = s.tasks.byId;
    assert.deepEqual(["b1", "b2", "b3", "b4", "b5"].map((id) => endText(t[id])), ["exit 2", "stopped by you", "stopped at its time limit", "ended with the agent", "running"]);
    assert.match(t.b1.output!.output, /exited with code 2/);
    // The session ending takes the rest.
    assert.equal(endText(fold([{ kind: "ended", payload: { reason: "exit", code: 1 } }], s, 100).tasks.byId.b5), "ended with the agent");
  });

  it("stops the subagents a Claude process took with it", () => {
    const s = fold([
      { kind: "user_prompt", payload: { text: "go", id: "p1" } },
      call("t-agent", "Agent", { description: "Run the tests", run_in_background: true }),
      started("a-1", "t-agent", { task_type: "local_agent" }),
      claude({ type: "result", subtype: "success", duration_ms: 900 }),
      { kind: "tasks_lost", payload: { taskIds: ["a-1"] } },
    ]);
    assert.equal(s.agents["t-agent"].status, "stopped");
    assert.equal(endText(s.tasks.byId["a-1"]), "ended with the agent");
  });

  it("starts Claude's turn about a task with what ended, but not for a stop by the user, which has a line of its own", () => {
    const s = fold([
      { kind: "user_prompt", payload: { text: "go", id: "p1" } },
      init(),
      call("t1", "Bash", { command: "npm ci", run_in_background: true }),
      started("b1", "t1"),
      call("t2", "Bash", { command: "tail -F log", run_in_background: true }),
      started("b2", "t2"),
      text("m1", "started"),
      result(),
      { kind: "task_stop", payload: { taskId: "b2" } },
      notified("b2", "stopped", "tail the log"),
      notified("b1", "completed", 'Background command "npm ci" completed (exit code 0)'),
      init(),
      text("m2", "Dependencies are installed."),
      result(),
    ]);
    assert.deepEqual(ofType(s, "task_stop").map((i) => i.taskId), ["b2"]);
    assert.deepEqual(ofType(s, "unprompted").map((i) => i.ended), [["b1"]]);
  });

  it("folds quiet turns a monitor woke Claude for, and shows one that did something", () => {
    const wake = (n: number, reply: NewEvent[]): NewEvent[] => [
      init(),
      { kind: "monitor_event", payload: { taskId: "b-mon", line: `event ${n}` } },
      ...reply,
      result(),
    ];
    const s = fold([
      { kind: "user_prompt", payload: { text: "watch", id: "p1" } },
      call("t-mon", "Monitor", { command: "tail -F build.log", description: "Watch the build" }),
      started("b-mon", "t-mon"),
      text("m0", "watching"),
      result(),
      ...wake(1, [text("m1", "No action is needed.")]),
      // Claude often thinks first: that is no more than a reply.
      ...wake(2, [claude({ type: "assistant", message: { id: "m2t", content: [{ type: "thinking", thinking: "" }] } }), text("m2", "No action is needed.")]),
      // This one reads a file: it shows in full, as does what came first in it.
      ...wake(3, [call("t-read", "Read", { file_path: "src/x.ts" }), text("m3", "The build broke; fixing it.")]),
      // The line can come after the turn's first words.
      init(),
      text("m4", "Still fine."),
      { kind: "monitor_event", payload: { taskId: "b-mon", line: "event 4" } },
      result(),
    ]);
    assert.deepEqual(ofType(s, "unprompted").map((i) => i.monitor?.line), ["event 1", "event 2", "event 3", "event 4"]);
    const rows = foldMonitorTurns(chatRows(s.items));
    const monitors = rows.filter((r): r is MonitorRow => r.type === "monitor");
    assert.deepEqual(monitors.map((m) => m.events.map((e) => [e.line, e.reply])), [[["event 1", "No action is needed."], ["event 2", "No action is needed."]], [["event 4", "Still fine."]]]);
    assert.ok(rows.some((r) => r.type === "item" && r.item.type === "unprompted" && r.item.monitor?.line === "event 3"), "the turn that did something isn't folded");
  });
});
