import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { AgentDriver, AgentEvent, AgentMessage, StartOptions } from "@kumiko/agent";
import { Sessions } from "../src/sessions.js";
import { SessionStore } from "../src/store.js";

/** A driver that says only what a test makes it say; stopped, it exits once `exit` is called, as Claude does once its turn is over. */
class StubDriver implements AgentDriver {
  private listeners = new Set<(ev: AgentEvent) => void>();
  started?: StartOptions;
  stopped = false;
  interrupts = 0;
  start(opts: StartOptions) {
    this.started = opts;
  }
  attach() {}
  position() {
    return { run: "r", offset: 0 };
  }
  send() {}
  taskOutput() {
    return Promise.resolve({ output: "", totalBytes: 0, truncated: false });
  }
  stopTask() {
    return Promise.resolve();
  }
  backgroundTasks() {
    return Promise.resolve();
  }
  rewindFiles() {
    return Promise.resolve();
  }
  interrupt() {
    this.interrupts++;
  }
  private exited?: () => void;
  stop() {
    this.stopped = true;
    return new Promise<void>((r) => (this.exited = r));
  }
  exit() {
    this.say({ kind: "exit", code: 0, requested: this.stopped });
    this.exited?.();
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
const init = (d: StubDriver) => d.message({ type: "system", subtype: "init", session_id: CLAUDE_ID });
const result = (d: StubDriver) => d.message({ type: "result", subtype: "success", result: "" });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await tick(5);
  assert.ok(ok(), "timed out");
};

describe("closing a session while Claude works", () => {
  let dir: string;
  let store: SessionStore;
  let drivers: StubDriver[];
  let sessions: Sessions;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "kumiko-closing-test-"));
  });
  after(() => rm(dir, { recursive: true, force: true }));

  const make = (finishMs?: number) => {
    drivers = [];
    sessions = new Sessions(
      () => {
        const d = new StubDriver();
        drivers.push(d);
        return d;
      },
      store,
      undefined,
      finishMs,
    );
  };
  beforeEach(() => {
    store = new SessionStore(join(dir, randomUUID()));
    make();
  });

  /** A session with Claude working on its first turn. */
  const working = () => {
    const { id } = sessions.start({ sandbox: "one", workdir: "/w", env: [], prompt: "hi" });
    init(drivers[0]);
    assert.equal(sessions.get(id)?.status, "running");
    return id;
  };

  it("lets Claude finish its turn, then forgets the session and keeps it resumable", async () => {
    const id = working();
    assert.equal(await sessions.close(id), true);
    const closing = sessions.get(id)?.closing;
    assert.equal(closing?.delete, false);
    assert.ok(Date.parse(closing!.until) > Date.now() + 29 * 60_000, "it has 30 minutes");
    assert.equal(drivers[0].stopped, false, "Claude isn't stopped while it works");
    assert.equal((await sessions.resumable()).find((s) => s.id === id)?.status, "running", "it can be resumed meanwhile");

    result(drivers[0]);
    await until(() => drivers[0].stopped);
    drivers[0].exit();
    await until(() => !sessions.get(id));
    await sessions.flush();
    const stored = await store.read(id);
    assert.ok(stored, "its chat is saved");
    assert.equal(sessions.resume(stored, []).closing, undefined, "resumed, it isn't closing");
  });

  it("deletes the saved chat once Claude is done, when closed to delete", async () => {
    const id = working();
    assert.equal(await sessions.close(id, { forget: true }), true);
    result(drivers[0]);
    await until(() => drivers[0].stopped);
    drivers[0].exit();
    await until(() => !sessions.get(id));
    assert.equal(await store.read(id), undefined);
  });

  it("stops Claude at once when told to, or when it isn't working", async () => {
    const id = working();
    const closed = sessions.close(id, { forget: true, stop: true });
    await until(() => drivers[0].stopped);
    drivers[0].exit();
    assert.equal(await closed, false);
    assert.equal(sessions.get(id), undefined);
    assert.equal(await store.read(id), undefined);

    const { id: idle } = sessions.start({ sandbox: "one", workdir: "/w", env: [], prompt: "hi" });
    init(drivers[1]);
    result(drivers[1]);
    const closing = sessions.close(idle);
    await until(() => drivers[1].stopped);
    drivers[1].exit();
    assert.equal(await closing, false);
    assert.equal(sessions.get(idle), undefined);
  });

  it("stops Claude once its time is up", async () => {
    make(30);
    const id = working();
    await sessions.close(id, { forget: true });
    await until(() => drivers[0].stopped);
    drivers[0].exit();
    await until(() => !sessions.get(id));
    assert.equal(await store.read(id), undefined);
  });

  it("interrupts a queued prompt's turn, so only the one under way is finished", async () => {
    const id = working();
    sessions.prompt(id, "next");
    await sessions.close(id);
    result(drivers[0]);
    await until(() => drivers[0].stopped);
    init(drivers[0]);
    assert.equal(drivers[0].interrupts, 1);
    result(drivers[0]);
    drivers[0].exit();
    await until(() => !sessions.get(id));
  });

  it("is taken back, Claude still working, until it is done", async () => {
    const id = working();
    await sessions.close(id, { forget: true });
    assert.equal(await sessions.keep(id), true);
    assert.equal(sessions.get(id)?.closing, undefined);
    result(drivers[0]);
    await tick(10);
    assert.equal(drivers[0].stopped, false);
    assert.equal(sessions.get(id)?.status, "idle");
    assert.equal(await sessions.keep(id), false, "an open session isn't closing");
  });

  it("is deleted when done if its saved chat is deleted meanwhile", async () => {
    const id = working();
    await sessions.close(id);
    assert.equal(await sessions.deleteSaved(id), true);
    assert.equal(sessions.get(id)?.closing?.delete, true);
    assert.ok(!(await sessions.resumable()).some((s) => s.id === id));
    result(drivers[0]);
    await until(() => drivers[0].stopped);
    drivers[0].exit();
    await until(() => !sessions.get(id));
    assert.equal(await store.read(id), undefined);
  });

  it("goes on finishing in the next server, or ends there if its turn is over", async () => {
    const id = working();
    await sessions.close(id, { forget: true });
    await sessions.detachAll();
    await sessions.flush();
    const stored = (await store.read(id))!;
    assert.equal(stored.info.closing?.delete, true);

    make();
    sessions.reopen(stored);
    assert.ok(sessions.get(id)?.closing);
    result(drivers[0]);
    await until(() => drivers[0].stopped);
    drivers[0].exit();
    await until(() => !sessions.get(id));
    assert.equal(await store.read(id), undefined);

    make();
    sessions.reopen({ ...stored, info: { ...stored.info, status: "idle" } });
    await until(() => drivers[0].stopped);
    drivers[0].exit();
    await until(() => !sessions.get(id));
  });
});
