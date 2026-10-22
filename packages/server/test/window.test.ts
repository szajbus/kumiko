import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { CHAT, slotIds, WindowError, type SessionEvent, type WindowOp } from "@kumiko/shared";
import type { AgentDriver, AgentEvent, AgentMessage, StartOptions } from "@kumiko/agent";
import { Sessions } from "../src/sessions.js";
import { chatEvents, SessionStore } from "../src/store.js";

/** A driver that says only what a test makes it say. */
class StubDriver implements AgentDriver {
  private listeners = new Set<(ev: AgentEvent) => void>();
  started?: StartOptions;
  start(opts: StartOptions) {
    this.started = opts;
  }
  attach() {}
  position() {
    return undefined;
  }
  send() {}
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

/** A whole turn as Claude reports it: init, a reply it keeps in its history, and the result. */
function turn(d: StubDriver) {
  d.message({ type: "system", subtype: "init", session_id: CLAUDE_ID });
  d.message({ type: "assistant", uuid: randomUUID(), message: { id: randomUUID(), content: [] } });
  d.message({ type: "result", subtype: "success", result: "" });
}

const add = (widget: string): WindowOp => ({ type: "add", widget, kind: "chat" });
const right = (slot: string, widget: string, of?: string): WindowOp => ({ type: "split", place: { split: "right", of }, slot, widget });
const windowEvents = (events: readonly SessionEvent[]) => events.filter((e) => e.kind === "window");

describe("session windows", () => {
  let dir: string;
  let store: SessionStore;
  let drivers: StubDriver[];
  let sessions: Sessions;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "kumiko-window-test-"));
  });
  after(() => rm(dir, { recursive: true, force: true }));

  const setup = () => {
    store = new SessionStore(join(dir, randomUUID()));
    drivers = [];
    sessions = new Sessions(() => {
      const d = new StubDriver();
      drivers.push(d);
      return d;
    }, store);
    const { id } = sessions.start({ sandbox: "one", workdir: "/w", env: [], prompt: "hi" });
    return id;
  };
  const promptIds = (id: string) => sessions.events(id).flatMap((e) => (e.kind === "user_prompt" && e.payload.id ? [e.payload.id] : []));

  it("starts with the chat alone, and changes as ops come", () => {
    const id = setup();
    assert.deepEqual(slotIds(sessions.window(id)!.layout), [CHAT]);
    sessions.changeWindow(id, add("w2"), "toolu_1");
    const w = sessions.changeWindow(id, right("s2", "w2"));
    assert.deepEqual(slotIds(w.layout), [CHAT, "s2"]);
    const recorded = windowEvents(sessions.events(id));
    assert.equal(recorded.length, 2);
    assert.equal(recorded[0].kind === "window" && recorded[0].payload.toolUseId, "toolu_1");
  });

  it("refuses an op that doesn't fit, recording nothing", () => {
    const id = setup();
    const before = sessions.events(id).length;
    assert.throws(() => sessions.changeWindow(id, { type: "close", slot: CHAT }), WindowError);
    assert.throws(() => sessions.changeWindow(id, right("s2", "w9")), WindowError);
    assert.equal(sessions.events(id).length, before);
  });

  it("brings a turn's ops down to one when the turn ends", () => {
    const id = setup();
    const d = drivers[0];
    d.message({ type: "system", subtype: "init", session_id: CLAUDE_ID });
    sessions.changeWindow(id, add("w2"));
    sessions.changeWindow(id, right("s2", "w2"));
    sessions.changeWindow(id, add("w3"));
    const w = sessions.window(id);
    d.message({ type: "result", subtype: "success", result: "" });
    const left = windowEvents(sessions.events(id));
    assert.equal(left.length, 1);
    assert.equal(left[0].kind === "window" && left[0].payload.op.type, "sync");
    assert.deepEqual(sessions.window(id), w);
  });

  it("rewinds the window with the chat", async () => {
    const id = setup();
    const d = drivers[0];
    sessions.changeWindow(id, add("w2"));
    sessions.changeWindow(id, right("s2", "w2"));
    turn(d);
    sessions.prompt(id, "more");
    sessions.changeWindow(id, add("w3"));
    sessions.changeWindow(id, right("s3", "w3", "s2"));
    turn(d);
    assert.deepEqual(slotIds(sessions.window(id)!.layout), [CHAT, "s2", "s3"]);
    await sessions.rewind(id, promptIds(id)[1], [], { files: false });
    assert.deepEqual(slotIds(sessions.window(id)!.layout), [CHAT, "s2"]);
    assert.equal(sessions.window(id)!.widgets.w3, undefined);
  });

  it("forks the window with the chat", () => {
    const id = setup();
    sessions.changeWindow(id, add("w2"));
    sessions.changeWindow(id, right("s2", "w2"));
    turn(drivers[0]);
    const fork = sessions.fork(id, []);
    assert.deepEqual(sessions.window(fork.id), sessions.window(id));
  });

  it("saves the window, and a resumed session has it again", async () => {
    const id = setup();
    sessions.changeWindow(id, add("w2"));
    turn(drivers[0]);
    // Between turns: saved straight away.
    sessions.changeWindow(id, right("s2", "w2"));
    const w = sessions.window(id);
    await sessions.flush();
    await sessions.remove(id);
    const stored = await store.read(id);
    assert.ok(stored);
    const again = new Sessions(() => new StubDriver(), store);
    again.resume(stored, []);
    assert.deepEqual(again.window(id), w);
  });

  it("keeps events of kinds it doesn't know when saving, as a newer Kumiko's", () => {
    const newer = { seq: 2, kind: "board", payload: {} } as unknown as SessionEvent;
    const events: SessionEvent[] = [
      { seq: 1, kind: "user_prompt", payload: { text: "hi" } },
      newer,
      { seq: 3, kind: "window", payload: { op: add("w2") } },
      { seq: 4, kind: "error", payload: { message: "gone" } },
      { seq: 5, kind: "claude", payload: { type: "system", subtype: "init" } },
    ];
    assert.deepEqual(chatEvents(events).map((e) => e.seq), [1, 2, 3]);
  });

  it("says a Claude started with other tools is outdated, until it is restarted", async () => {
    const id = setup();
    turn(drivers[0]);
    const started = sessions.get(id)!;
    assert.ok(started.toolsVersion);
    assert.equal(started.toolsOutdated, undefined);
    const stored = { info: { ...started, toolsVersion: "older" }, events: [...sessions.events(id)], run: { id: "r", offset: 0, live: true } };
    await sessions.remove(id);
    const again = new Sessions(() => new StubDriver(), store);
    assert.equal(again.reopen(stored).toolsOutdated, true);
    const restarted = again.relaunch(id, []);
    assert.equal(restarted.toolsOutdated, undefined);
    assert.equal(restarted.toolsVersion, started.toolsVersion);
  });

  it("restarts Claude on the model it was using, leaving a finished turn unread when asked to", async () => {
    const id = setup();
    drivers[0].message({ type: "system", subtype: "init", session_id: CLAUDE_ID, model: "claude-sonnet-5-5" });
    drivers[0].message({ type: "result", subtype: "success", result: "" });
    // Chosen with /model, not the default.
    sessions.prompt(id, "/model opus");
    drivers[0].message({ type: "system", subtype: "init", session_id: CLAUDE_ID, model: "claude-opus-5-5" });
    drivers[0].message({ type: "result", subtype: "success", result: "Set model to opus" });
    assert.equal(sessions.get(id)!.unread, true);
    sessions.relaunch(id, [], { keepUnread: true });
    assert.equal(drivers[1].started?.model, "opus");
    assert.equal(drivers[1].started?.resume, CLAUDE_ID);
    assert.equal(sessions.get(id)!.unread, true);
    sessions.relaunch(id, []);
    assert.equal(sessions.get(id)!.unread, false);
    await sessions.flush();
  });

  it("changes the window of live sessions only", async () => {
    const id = setup();
    await sessions.end(id, "user");
    assert.throws(() => sessions.changeWindow(id, add("w2")), /has ended/);
  });
});
