import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { isBusy, type SessionEvent } from "@kumiko/shared";
import type { AgentDriver, AgentEvent, AgentMessage, StartOptions, TaskOutput } from "@kumiko/agent";
import { isTaskOutputFile, Sessions } from "../src/sessions.js";
import { SessionStore } from "../src/store.js";

/** A driver that says only what a test makes it say, with the tasks' output the test sets. */
class StubDriver implements AgentDriver {
  private listeners = new Set<(ev: AgentEvent) => void>();
  started?: StartOptions;
  outputs = new Map<string, TaskOutput>();
  stopped: string[] = [];
  backgrounded: (string | undefined)[] = [];
  start(opts: StartOptions) {
    this.started = opts;
  }
  attach() {}
  position() {
    return undefined;
  }
  send() {}
  taskOutput(taskId: string) {
    return Promise.resolve(this.outputs.get(taskId) ?? { output: "", totalBytes: 0, truncated: false });
  }
  async stopTask(taskId: string) {
    this.stopped.push(taskId);
  }
  async backgroundTasks(toolUseId?: string) {
    this.backgrounded.push(toolUseId);
  }
  rewindFiles() {
    return Promise.resolve();
  }
  interrupt() {}
  async stop() {
    this.say({ kind: "exit", code: 0, requested: true });
  }
  async detach() {}
  pendingCalls() {
    return [];
  }
  answer() {}
  pendingAsks() {
    return [];
  }
  setPlanMode() {}
  onEvent(l: (ev: AgentEvent) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  say(ev: AgentEvent) {
    for (const l of this.listeners) l(ev);
  }
  message(payload: AgentMessage) {
    this.say({ kind: "message", payload });
  }
}

const CLAUDE_ID = randomUUID();
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** Claude's messages about a background shell or monitor, as Claude 2.1.309 sends them. */
const started = (taskId: string, toolUseId: string, extra: Record<string, unknown> = {}) => ({ type: "system", subtype: "task_started", task_id: taskId, tool_use_id: toolUseId, description: "Start the dev server", is_backgrounded: true, task_type: "local_bash", ...extra });
const notified = (taskId: string, toolUseId: string, status = "completed") => ({ type: "system", subtype: "task_notification", task_id: taskId, tool_use_id: toolUseId, status, output_file: "", summary: "done" });
const listed = (tasks: { task_id: string; task_type: string; ambient?: boolean }[]) => ({ type: "system", subtype: "background_tasks_changed", tasks: tasks.map((t) => ({ description: "x", ...t })) });
const init = () => ({ type: "system", subtype: "init", session_id: CLAUDE_ID });
const result = () => ({ type: "result", subtype: "success", result: "" });
const monitorCall = (id: string) => ({ type: "assistant", uuid: randomUUID(), message: { id: randomUUID(), content: [{ type: "tool_use", id, name: "Monitor", input: { command: "tail -F build.log", description: "Watch the build log" } }] } });

describe("background tasks in sessions", () => {
  let dir: string;
  let drivers: StubDriver[];
  let sessions: Sessions;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "kumiko-tasks-test-"));
  });
  after(() => rm(dir, { recursive: true, force: true }));

  /** A session whose first turn is over. */
  const setup = () => {
    drivers = [];
    sessions = new Sessions(() => {
      const d = new StubDriver();
      drivers.push(d);
      return d;
    }, new SessionStore(join(dir, randomUUID())));
    const { id } = sessions.start({ sandbox: "one", workdir: "/w", env: [], prompt: "hi" });
    drivers[0].message(init());
    drivers[0].message(result());
    return id;
  };
  const of = (id: string, kind: SessionEvent["kind"]) => sessions.events(id).filter((e) => e.kind === kind);
  /** The monitor lines recorded as what woke Claude. */
  const lines = (id: string) => sessions.events(id).flatMap((e) => (e.kind === "monitor_event" ? [e.payload] : []));

  it("counts shells apart from subagents, and doesn't call the session busy for them", () => {
    const id = setup();
    drivers[0].message(listed([{ task_id: "b1", task_type: "local_bash" }, { task_id: "b2", task_type: "local_bash", ambient: true }]));
    let info = sessions.get(id)!;
    assert.equal(info.shells, 1, "an ambient watcher isn't counted");
    assert.equal(info.agents, undefined);
    assert.ok(!isBusy(info), "a dev server left running isn't work");
    drivers[0].message(listed([{ task_id: "b1", task_type: "local_bash" }, { task_id: "a1", task_type: "local_agent" }]));
    info = sessions.get(id)!;
    assert.deepEqual([info.shells, info.agents], [1, 1]);
    assert.ok(isBusy(info));
    drivers[0].message(listed([]));
    assert.equal(sessions.get(id)!.shells, undefined);
  });

  it("keeps a shell's output once it ends, and says when its start and end arrived", async () => {
    const id = setup();
    drivers[0].message(started("b1", "toolu_1"));
    drivers[0].outputs.set("b1", { output: "ready\n\n[exited with code 0]\n", totalBytes: 28, truncated: false });
    drivers[0].message(notified("b1", "toolu_1"));
    await settle(600);
    assert.deepEqual(
      of(id, "task_output").map((e) => e.payload),
      [{ taskId: "b1", output: "ready\n\n[exited with code 0]\n", totalBytes: 28, truncated: false }],
    );
    const stamps = sessions.events(id).flatMap((e) => (e.kind === "claude" && e.payload.subtype?.toString().startsWith("task_") ? [typeof e.payload.received_at] : []));
    assert.deepEqual(stamps, ["string", "string"]);
  });

  it("records who stopped a task before stopping it, and moves a command to the background", async () => {
    const id = setup();
    drivers[0].message(started("b1", "toolu_1"));
    await sessions.stopTask(id, "b1");
    assert.deepEqual(drivers[0].stopped, ["b1"]);
    assert.deepEqual(of(id, "task_stop").map((e) => e.payload), [{ taskId: "b1" }]);
    await sessions.backgroundTasks(id, "toolu_2");
    assert.deepEqual(drivers[0].backgrounded, ["toolu_2"]);
  });

  it("says which monitor's line woke Claude for a turn of its own, and not for one it was prompted for", async () => {
    const id = setup();
    drivers[0].message(init());
    drivers[0].message(monitorCall("toolu_m"));
    drivers[0].message(started("b9", "toolu_m"));
    drivers[0].message(result());
    // A line, and Claude wakes.
    drivers[0].outputs.set("b9", { output: "event 1\n", totalBytes: 8, truncated: false });
    drivers[0].message(init());
    await settle();
    assert.deepEqual(lines(id).map(({ taskId, line }) => ({ taskId, line })), [{ taskId: "b9", line: "event 1" }]);
    drivers[0].message(result());
    // A prompt's turn isn't a monitor's, even if it printed more meanwhile.
    drivers[0].outputs.set("b9", { output: "event 1\nevent 2\n", totalBytes: 16, truncated: false });
    sessions.prompt(id, "hello");
    drivers[0].message(init());
    await settle();
    assert.equal(of(id, "monitor_event").length, 1);
    drivers[0].message(result());
    // Nor is the turn Claude takes to report on a task that ended.
    drivers[0].message(started("b3", "toolu_3"));
    drivers[0].message(notified("b3", "toolu_3"));
    drivers[0].outputs.set("b9", { output: "event 1\nevent 2\nevent 3\n", totalBytes: 24, truncated: false });
    drivers[0].message(init());
    await settle();
    assert.equal(of(id, "monitor_event").length, 1);
  });

  it("says which monitor woke Claude after the user stopped another task, and which turn it woke Claude for", async () => {
    const id = setup();
    drivers[0].message(init());
    drivers[0].message(monitorCall("toolu_m"));
    drivers[0].message(started("b9", "toolu_m"));
    drivers[0].message(started("b5", "toolu_5"));
    drivers[0].message(result());
    // Stopped by the user: Claude takes no turn for it, so the next turn of its own is still a monitor's.
    await sessions.stopTask(id, "b5");
    drivers[0].message(notified("b5", "toolu_5", "stopped"));
    drivers[0].outputs.set("b9", { output: "check 1\n", totalBytes: 8, truncated: false });
    drivers[0].message(init());
    const turn = sessions.events(id).at(-1)!.seq;
    await settle();
    assert.deepEqual(lines(id), [{ taskId: "b9", line: "check 1", at: turn }]);
    drivers[0].message(result());
    // Nor does a shell a subagent started, which ends with it, or a command Claude waited on.
    drivers[0].message(started("b6", "toolu_6", { parent_task_id: "a1" }));
    drivers[0].message(notified("b6", "toolu_6", "stopped"));
    drivers[0].message(started("b7", "toolu_7", { is_backgrounded: false }));
    drivers[0].message(notified("b7", "toolu_7"));
    drivers[0].outputs.set("b9", { output: "check 1\ncheck 2\n", totalBytes: 16, truncated: false });
    drivers[0].message(init());
    await settle();
    assert.deepEqual(lines(id).map((e) => e.line), ["check 1", "check 2"]);
  });

  it("still says which monitor woke Claude after a prompt it read in the middle of a turn, which got no turn of its own", async () => {
    const id = setup();
    drivers[0].message(init());
    drivers[0].message(monitorCall("toolu_m"));
    drivers[0].message(started("b9", "toolu_m"));
    // Sent while Claude works, and read in the same turn: Claude echoes it, and there is no init for it.
    sessions.prompt(id, "and this too");
    const sent = sessions.events(id).findLast((e) => e.kind === "user_prompt")!.payload.id;
    drivers[0].message({ type: "user", isReplay: true, uuid: sent, message: { role: "user", content: "and this too" } });
    drivers[0].message(result());
    drivers[0].outputs.set("b9", { output: "event 1\n", totalBytes: 8, truncated: false });
    drivers[0].message(init());
    await settle();
    assert.deepEqual(lines(id).map(({ taskId, line }) => ({ taskId, line })), [{ taskId: "b9", line: "event 1" }]);
  });

  it("records the tasks a Claude process took with it, when the next one starts", async () => {
    const id = setup();
    drivers[0].message(started("b1", "toolu_1"));
    drivers[0].message(started("b2", "toolu_2"));
    drivers[0].message(notified("b2", "toolu_2"));
    // Killed, with no word of its shells.
    drivers[0].say({ kind: "exit", code: 137, requested: false });
    sessions.relaunch(id, []);
    assert.deepEqual(of(id, "tasks_lost").map((e) => e.payload), [{ taskIds: ["b1"] }]);
    // Said once: the next start has nothing more to say.
    drivers[1].say({ kind: "exit", code: 137, requested: false });
    sessions.relaunch(id, []);
    assert.equal(of(id, "tasks_lost").length, 1);
    await sessions.flush();
  });

  it("finds a task's output file only where Claude's notification puts one shaped like it", async () => {
    const id = setup();
    const file = "/tmp/claude-1000/-home-me-w/0b9c/tasks/b1.output";
    drivers[0].message(started("b1", "toolu_1"));
    drivers[0].message({ ...notified("b1", "toolu_1"), output_file: file });
    drivers[0].message(started("b2", "toolu_2"));
    drivers[0].message({ ...notified("b2", "toolu_2"), output_file: "/etc/passwd" });
    assert.equal(sessions.taskFile(id, "b1"), file);
    assert.equal(sessions.taskFile(id, "b2"), undefined, "not one of Claude's task files");
    assert.equal(sessions.taskFile(id, "b3"), undefined, "no such task");
    assert.ok(isTaskOutputFile(file, "b1"));
    assert.ok(!isTaskOutputFile(file, "b2"), "another task's");
    assert.ok(!isTaskOutputFile("tmp/tasks/b1.output", "b1"), "relative");
    assert.ok(!isTaskOutputFile("/tmp/x/../../etc/tasks/b1.output", "b1"), "leading elsewhere");
    assert.ok(!isTaskOutputFile("/tmp/x\n/tasks/b1.output", "b1"), "with a newline");
    await sessions.flush();
  });
});
