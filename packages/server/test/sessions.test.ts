import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { appendFile, chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";
import { isBusy, isWaiting, type ProjectView, type ServerEvent, type SessionEvent, type SessionInfo, type SessionStreamMessage } from "@kumiko/shared";
import { RUNS_DIR, userMessage } from "@kumiko/agent";
import { LimaProvider, MetadataStore, shellQuote } from "@kumiko/sandbox";
import { startServer, type RunningServer, type ServerOptions } from "../src/index.js";
import type { StoredSession } from "../src/store.js";
import { makeClone } from "./repo.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, "../../../sandbox/fixtures");
const fakeClaude = resolve(here, "../../../agent/fixtures/fake-claude.mjs");

describe("sessions", () => {
  let server: RunningServer;
  let root: string;
  let limaDir: string;
  /** The clone of project "one", where its sessions start. */
  let workdir: string;
  let sessionsDir: string;
  const events: ServerEvent[] = [];
  let ws: WebSocket;
  let serverOpts: ServerOptions;

  /** Starts the server and listens to its events. */
  const boot = async () => {
    server = await startServer(serverOpts);
    ws = new WebSocket(`${server.url.replace("http", "ws")}/api/events`, { headers: { authorization: `Bearer ${server.token}` } });
    ws.on("message", (m) => events.push(JSON.parse(String(m))));
    await new Promise((r) => ws.once("open", r));
  };
  /** Closes the server and starts another on the same data, as a restart of the app does. */
  const restart = async (opts?: { endSessions?: boolean }, meanwhile?: () => Promise<void>) => {
    ws.close();
    await server.close(opts);
    await meanwhile?.();
    await boot();
  };

  const api = (path: string, init: RequestInit = {}) =>
    fetch(server.url + path, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${server.token}`, ...init.headers } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = (r: Response): Promise<any> => r.json();
  const waitFor = async <T>(fn: () => T | undefined | Promise<T | undefined>, ms = 10000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const finished = (name: string, op: string, since: number) =>
    waitFor(() => events.slice(since).find((e) => "sandbox" in e && e.sandbox === name && e.op === op && (e.type === "done" || e.type === "error")));
  const session = async (id: string): Promise<SessionInfo | undefined> => ((await json(await api("/api/sessions"))) as SessionInfo[]).find((s) => s.id === id);
  const sandbox = async (name: string): Promise<ProjectView> => ((await json(await api("/api/projects"))) as ProjectView[]).find((s) => s.name === name)!;

  /** A socket on a session's events, collecting them; `caughtUp` is how many had come when the replay was done. */
  const listen = async (id: string, afterSeq = 0, inBuffer?: string) => {
    const got: SessionEvent[] = [];
    let caughtUp: number | undefined;
    let buffer: string | undefined;
    const sock = new WebSocket(`${server.url.replace("http", "ws")}/api/sessions/${id}/events?after=${afterSeq}${inBuffer ? `&buffer=${inBuffer}` : ""}`, { headers: { authorization: `Bearer ${server.token}` } });
    sock.on("message", (m) => {
      const msg = JSON.parse(String(m)) as SessionStreamMessage;
      if (msg.kind === "caught_up") {
        caughtUp ??= got.length;
        buffer = msg.buffer;
      } else got.push(msg);
    });
    const closed = new Promise<number>((r) => sock.once("close", (code) => r(code)));
    await new Promise((r) => sock.once("open", r));
    const results = () => got.filter((e) => e.kind === "claude" && e.payload.type === "result");
    return { got, sock, closed, results, caughtUp: () => caughtUp, buffer: () => buffer };
  };

  /** Creates a project from a fresh clone; returns the clone. */
  const create = async (name: string, spec: object = {}) => {
    const clonePath = await makeClone(root, name);
    const since = events.length;
    const res = await api("/api/projects", { method: "POST", body: JSON.stringify({ name, clonePath, cpus: 1, memoryGiB: 1, diskGiB: 10, mounts: [], env: ["TOKEN"], ...spec }) });
    assert.equal(res.status, 202);
    assert.equal((await finished(name, "creating", since)).type, "done");
    return clonePath;
  };

  const startSession = async (sandboxName: string, prompt: string): Promise<string> => {
    const res = await api("/api/sessions", { method: "POST", body: JSON.stringify({ sandbox: sandboxName, prompt }) });
    assert.equal(res.status, 201);
    return (await json(res)).id;
  };

  before(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "kumiko-sessions-test-")));
    limaDir = join(root, "lima");
    await mkdir(limaDir);
    process.env.FAKE_LIMA_DIR = limaDir;
    // The fake ssh's VM home is $FAKE_LIMA_DIR/vm-home; a claude there is found first and the installer skips it.
    const bin = join(limaDir, "vm-home", ".local", "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "claude"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fakeClaude)} "$@"\n`);
    await chmod(join(bin, "claude"), 0o755);

    const env = () => ({ TOKEN: "forwarded-value" });
    const provider = new LimaProvider({
      limactl: join(fixtures, "fake-limactl.mjs"),
      ssh: join(fixtures, "fake-ssh.sh"),
      metadata: new MetadataStore(join(root, "sandboxes")),
      env,
    });
    sessionsDir = join(root, "sessions");
    serverOpts = { provider, port: 0, refreshMs: 200, env, home: root, dataDir: join(root, "data"), sessionsDir };
    await boot();
    workdir = await create("one");
  });

  after(async () => {
    ws.close();
    // Claude would otherwise keep running in the fake sandbox, which is this machine.
    await server.close({ endSessions: true });
  });

  it("refuses bad starts", async () => {
    const post = (body: object) => api("/api/sessions", { method: "POST", body: JSON.stringify(body) });
    assert.equal((await post({ sandbox: "one", prompt: "  " })).status, 400);
    assert.equal((await post({ sandbox: "nope", prompt: "hi" })).status, 404);
    assert.equal((await post({ sandbox: "Bad!", prompt: "hi" })).status, 400);
    // A VM that isn't a project's can't host a session.
    await writeFile(join(limaDir, "km-stray.json"), JSON.stringify({ name: "km-stray", status: "Running" }));
    assert.equal((await post({ sandbox: "stray", prompt: "hi" })).status, 404);
    assert.equal((await api("/api/sessions/abc123/prompt", { method: "POST", body: '{"text":"x"}' })).status, 404);
  });

  it("starts a stopped sandbox for a session asked for in it", async () => {
    await create("cold");
    await writeFile(join(limaDir, "km-cold.json"), JSON.stringify({ name: "km-cold", status: "Stopped" }));
    await waitFor(async () => (await sandbox("cold")).status === "stopped");
    const since = events.length;
    // Two at once: the second waits on the start the first began.
    const [a, b] = await Promise.all([startSession("cold", "hi"), startSession("cold", "there")]);
    assert.equal(events.slice(since).filter((e) => "sandbox" in e && e.sandbox === "cold" && e.op === "starting" && e.type === "state").length, 1, "started once");
    assert.equal((await sandbox("cold")).status, "running");
    for (const id of [a, b]) await waitFor(async () => (await session(id))?.status === "idle");
  });

  it("opens a session asleep instead of starting its stopped sandbox, and wakes it once the sandbox runs", async () => {
    await create("dozy");
    const idle = (x: string) => waitFor(async () => { const i = await session(x); return i?.status === "idle" && i.claudeSessionId ? i : undefined; });
    const id = await startSession("dozy", "remember me");
    await idle(id);
    const stop = async () => {
      const since = events.length;
      assert.equal((await api("/api/projects/dozy/stop", { method: "POST" })).status, 202);
      assert.equal((await finished("dozy", "stopping", since)).type, "done");
    };
    /** Closes its tab, then opens it again as a tab coming back does. */
    const reopen = async () => {
      await api(`/api/sessions/${id}`, { method: "DELETE" });
      const res = await api(`/api/sessions/${id}/resume`, { method: "POST", body: JSON.stringify({ start: false }) });
      assert.equal(res.status, 201);
      return session(id);
    };

    await stop();
    const asleep = await reopen();
    assert.equal(asleep?.asleep, true);
    assert.equal(asleep?.status, "ended");
    assert.equal((await sandbox("dozy")).status, "stopped", "the sandbox stays stopped");
    const chat = await listen(id);
    assert.ok(chat.got.some((e) => e.kind === "user_prompt" && e.payload.text === "remember me"), "its chat is there");
    assert.equal((await api(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text: "hi" }) })).status, 409);
    assert.ok(!((await json(await api("/api/sessions/resumable"))) as SessionInfo[]).some((x) => x.id === id), "it is open, not in the list");

    // Its banner starts the sandbox, and Claude continues the conversation.
    const woken = (await json(await api(`/api/sessions/${id}/wake`, { method: "POST" }))) as SessionInfo;
    assert.equal(woken.status, "idle");
    assert.equal(woken.asleep, undefined);
    assert.equal((await sandbox("dozy")).status, "running");
    await api(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text: "still there?" }) });
    await waitFor(() => chat.results().length === 2);
    assert.ok(chat.got.some((e) => e.kind === "claude" && e.payload.type === "result" && e.payload.result === "You said: still there?"), "the same tab gets the new turn");

    // Started some other way, the sandbox wakes it all the same.
    await stop();
    assert.equal((await reopen())?.asleep, true);
    assert.equal((await api("/api/projects/dozy/start", { method: "POST" })).status, 202);
    await idle(id);
    assert.equal((await session(id))?.asleep, undefined);

    // With the sandbox running, it opens awake at once.
    assert.equal((await reopen())?.asleep, undefined);
    await api(`/api/sessions/${id}`, { method: "DELETE" });
  });

  it("refuses to close the chat's pane, or a pane that isn't there", async () => {
    const id = await startSession("one", "hi");
    await waitFor(async () => (await session(id))?.status === "idle");
    const closePane = (sid: string, body: string) => api(`/api/sessions/${sid}/window/close`, { method: "POST", body });
    const chat = await closePane(id, JSON.stringify({ pane: "chat" }));
    assert.equal(chat.status, 400);
    assert.match((await json(chat)).error, /can't be closed/);
    assert.equal((await closePane(id, JSON.stringify({ pane: "p9" }))).status, 400);
    assert.equal((await closePane(id, "{}")).status, 400);
    assert.equal((await closePane("abc123", JSON.stringify({ pane: "p2" }))).status, 404);
    assert.equal((await api(`/api/sessions/${id}`, { method: "DELETE" })).status, 200);
  });

  it("holds a conversation, streams it and replays it", async () => {
    const id = await startSession("one", "hello there");
    const s = await listen(id);
    await waitFor(() => s.results().length === 1);
    assert.deepEqual(s.got[0], { seq: 1, kind: "user_prompt", payload: { text: "hello there", id: (s.got[0] as { payload: { id?: string } }).payload.id } });
    assert.match((s.got[0] as { payload: { id?: string } }).payload.id ?? "", /^[0-9a-f-]{36}$/, "the prompt is tagged with an id");
    const init = s.got.find((e) => e.kind === "claude" && e.payload.subtype === "init");
    assert.equal(init?.kind === "claude" && init.payload.cwd, workdir, "Claude starts in the project's clone");
    assert.ok(s.got.some((e) => e.kind === "claude" && e.payload.type === "stream_event"), "deltas stream live");

    const info = await waitFor(async () => {
      const x = await session(id);
      return x?.status === "idle" ? x : undefined;
    });
    assert.equal(info?.sandbox, "one");
    assert.equal(info?.model, "claude-sonnet-5-5");
    assert.deepEqual(info?.commands, ["compact", "model", "context"], "the slash commands from init are kept on the session");
    assert.ok(info?.claudeSessionId);
    assert.ok((info?.bufferBytes ?? 0) > 0, "the buffer's size is reported when the turn ends");
    assert.equal((await sandbox("one")).sessions, 1);
    assert.ok(events.some((e) => e.type === "sessions" && e.sessions.some((x) => x.id === id)));

    // A finished turn waits on the user until they look.
    assert.equal(info?.unread, true);
    assert.equal((await sandbox("one")).waiting, 1);
    assert.equal((await api(`/api/sessions/${id}/seen`, { method: "POST" })).status, 200);
    assert.equal((await session(id))?.unread, false);
    assert.equal((await sandbox("one")).waiting, 0);
    assert.equal((await api("/api/sessions/abc123/seen", { method: "POST" })).status, 404);

    // A forwarded variable reaches Claude's tools.
    assert.equal((await api(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text: "env TOKEN" }) })).status, 202);
    await waitFor(() => s.results().length === 2);
    assert.ok(s.got.some((e) => e.kind === "claude" && e.payload.type === "user" && JSON.stringify(e.payload).includes("forwarded-value")));

    // Claude's config is the project's Claude home, mounted at ~/.claude in the VM.
    await api(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text: "env CLAUDE_CONFIG_DIR" }) });
    await waitFor(() => s.results().length === 3);
    assert.ok(s.got.some((e) => e.kind === "claude" && e.payload.type === "user" && JSON.stringify(e.payload).includes(join(limaDir, "vm-home", ".claude"))));

    // Stop ends the turn, not the session.
    await api(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text: "slow" }) });
    await waitFor(() => s.got.some((e) => e.kind === "claude" && JSON.stringify(e.payload).includes('"text":"3 "')));
    assert.equal((await api(`/api/sessions/${id}/interrupt`, { method: "POST" })).status, 202);
    await waitFor(() => s.results().length === 4);
    const interrupted = s.results()[3];
    assert.equal(interrupted.kind === "claude" && interrupted.payload.subtype, "error_during_execution");
    assert.ok(s.got.some((e) => e.kind === "interrupt"));
    assert.equal((await session(id))?.status, "idle");

    // A reconnecting tab replays from its last seq; finished turns no longer carry their deltas.
    const lastSeq = s.got.at(-1)!.seq;
    await api(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text: "/model haiku" }) });
    await waitFor(() => s.results().length === 5);
    // The picker follows /model at once, without waiting for the next reply to name the model.
    assert.equal((await session(id))?.model, "haiku");
    const again = await listen(id, lastSeq);
    await waitFor(() => again.got.some((e) => e.kind === "claude" && e.payload.type === "result"));
    assert.equal(again.got[0].seq, lastSeq + 1);
    // The replay ends with word that it has caught up, so the tab can show it as history.
    await waitFor(() => again.caughtUp() !== undefined);
    assert.equal(again.got.at(again.caughtUp()! - 1)?.seq, s.got.at(-1)!.seq, "everything there was came before it");
    // Seqs count in a named buffer: the same name resumes as above, another (a server that has restarted since) starts over.
    assert.match(again.buffer() ?? "", /^[0-9a-f]{12}$/);
    assert.equal(again.buffer(), s.buffer());
    const same = await listen(id, lastSeq, again.buffer());
    await waitFor(() => same.caughtUp() !== undefined);
    assert.equal(same.got[0].seq, lastSeq + 1);
    same.sock.close();
    assert.equal(await (await listen(id, lastSeq, "0123456789ab")).closed, 4409);

    // /rename shows up as the session's title.
    await api(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text: "/rename fix-composer" }) });
    await waitFor(async () => (await session(id))?.title === "fix-composer");
    await waitFor(() => s.results().length === 6);
    const full = await listen(id);
    await waitFor(() => full.results().length === 6);
    // Only the message Stop cut short keeps its deltas; every finished one is replayed from its final form.
    const kept = new Set(full.got.flatMap((e) => (e.kind === "claude" && e.payload.type === "stream_event" ? [e.payload.api_message_id] : [])));
    assert.equal(kept.size, 1);
    assert.ok(full.got.some((e) => e.kind === "claude" && e.payload.type === "stream_event" && JSON.stringify(e.payload).includes('"text":"3 "')));
    again.sock.close();
    full.sock.close();

    // Removing the session ends Claude and closes its sockets.
    assert.equal((await api(`/api/sessions/${id}`, { method: "DELETE" })).status, 200);
    assert.equal(await s.closed, 4404);
    assert.equal(await session(id), undefined);
    assert.equal((await sandbox("one")).sessions, 0);
  });

  it("reports a crash as a failed session with the stderr tail", async () => {
    const id = await startSession("one", "crash");
    const s = await listen(id);
    await waitFor(() => s.got.some((e) => e.kind === "ended"));
    const err = s.got.find((e) => e.kind === "error");
    assert.ok(err?.kind === "error");
    assert.match(err.payload.message, /code 3/);
    assert.deepEqual(err.payload.stderr, ["Error: something broke inside Claude"]);
    assert.equal((await session(id))?.status, "failed");
    assert.equal((await api(`/api/sessions/${id}/prompt`, { method: "POST", body: '{"text":"x"}' })).status, 409);
    await api(`/api/sessions/${id}`, { method: "DELETE" });
  });

  it("puts a sandbox's sessions to sleep when it stops, wakes them when it starts, and runs several at once", async () => {
    await create("two");
    const a = await startSession("one", "first");
    const b = await startSession("two", "second");
    const c = await startSession("two", "third");
    const sb = await listen(b);
    await waitFor(async () => ((await json(await api("/api/sessions"))) as SessionInfo[]).every((x) => x.status === "idle") || undefined);
    assert.equal((await sandbox("two")).sessions, 2);

    const since = events.length;
    assert.equal((await api("/api/projects/two/stop", { method: "POST" })).status, 202);
    assert.equal((await finished("two", "stopping", since)).type, "done");
    const logs = events.slice(since).filter((e) => e.type === "log").map((e) => (e as { data: { text: string } }).data.text);
    assert.ok(logs.includes("Pausing 2 agent sessions…"));
    assert.deepEqual([(await session(b))?.status, (await session(c))?.status, (await session(a))?.status], ["ended", "ended", "idle"]);
    assert.deepEqual([(await session(b))?.asleep, (await session(c))?.asleep], [true, true]);
    assert.deepEqual(sb.got.at(-1)?.kind === "ended" && sb.got.at(-1)?.payload, { reason: "sandbox", code: 0, asleep: true });
    assert.equal((await sandbox("two")).sessions, 0);

    // Started from the project, not from their tabs, the sandbox wakes them, and Claude carries on.
    assert.equal((await api("/api/projects/two/start", { method: "POST" })).status, 202);
    for (const id of [b, c]) await waitFor(async () => { const i = await session(id); return (i?.status === "idle" && !i.asleep) || undefined; });
    await api(`/api/sessions/${b}/prompt`, { method: "POST", body: JSON.stringify({ text: "back?" }) });
    await waitFor(() => sb.got.some((e) => e.kind === "claude" && e.payload.type === "result" && e.payload.result === "You said: back?") || undefined);
    for (const id of [a, b, c]) await api(`/api/sessions/${id}`, { method: "DELETE" });
  });

  it("puts sessions to sleep when their sandbox stops outside Kumiko", async () => {
    await waitFor(async () => { const sb = await sandbox("two"); return (sb.status === "running" && !sb.busy) || undefined; });
    const id = await startSession("two", "hello");
    await waitFor(async () => (await session(id))?.status === "idle" || undefined);
    await writeFile(join(limaDir, "km-two.json"), JSON.stringify({ name: "km-two", status: "Stopped" }));
    await waitFor(async () => { const i = await session(id); return (i?.status === "ended" && i.asleep) || undefined; });
    await writeFile(join(limaDir, "km-two.json"), JSON.stringify({ name: "km-two", status: "Running" }));
    await waitFor(async () => { const i = await session(id); return (i?.status === "idle" && !i.asleep) || undefined; });
    await api(`/api/sessions/${id}`, { method: "DELETE" });
  });

  it("stays busy while a subagent works in the background, and keeps its task events when saved", async () => {
    const id = await startSession("one", "agents-bg");
    const s = await listen(id);
    // The turn is over at once, but the subagent works on: the session waits for a prompt, and is busy.
    const during = await waitFor(async () => { const i = await session(id); return i?.status === "idle" && i.agents === 1 ? i : undefined; });
    assert.ok(isBusy(during));
    assert.ok(!isWaiting(during), "the reply isn't the last word: Claude reports on the subagent once it's done");
    assert.deepEqual(server.working().map((x) => x.id), [id], "quitting would cut the subagent short");
    // Done, it reports to Claude, who takes a turn of its own to say so.
    await waitFor(() => s.results().length === 2);
    const done = await waitFor(async () => { const i = await session(id); return i?.status === "idle" && i.agents === undefined ? i : undefined; });
    assert.ok(!isBusy(done));
    // Saved with the turn's result, as the save is written.
    const saved = await waitFor(async () => {
      const stored = JSON.parse(await readFile(join(sessionsDir, `${id}.json`), "utf8").catch(() => "{}")) as Partial<StoredSession>;
      return stored.events?.filter((e) => e.kind === "claude" && e.payload.type === "result").length === 2 ? (stored as StoredSession) : undefined;
    });
    const tasks = saved.events.flatMap((e) => (e.kind === "claude" && e.payload.type === "system" ? [e.payload.subtype] : []));
    assert.deepEqual(tasks, ["task_started", "task_notification"], "the subagent's start and end, and no other system events");
    assert.ok(saved.events.some((e) => e.kind === "claude" && e.payload.type === "assistant" && e.payload.parent_tool_use_id), "and its messages");
    await api(`/api/sessions/${id}`, { method: "DELETE" });
  });

  describe("what Claude asks the user", () => {
    const COLOR = "Which color do you prefer?";
    const answer = (id: string, ask: string, body: unknown) => api(`/api/sessions/${id}/asks/${ask}`, { method: "POST", body: JSON.stringify(body) });
    const prompt = (id: string, text: string) => api(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text }) });
    const asks = (got: SessionEvent[]) => got.flatMap((e) => (e.kind === "ask" ? [e.payload] : []));
    const resultText = (got: SessionEvent[], n: number) => {
      const r = got.filter((e) => e.kind === "claude" && e.payload.type === "result")[n];
      return r?.kind === "claude" ? String(r.payload.result) : undefined;
    };

    it("waits on the user's answers, mid-turn, and takes them", async () => {
      const id = await startSession("one", "ask");
      const s = await listen(id);
      const ask = (await waitFor(() => asks(s.got)[0]))!;
      assert.equal(ask.kind, "questions");
      const waiting = await waitFor(async () => { const i = await session(id); return i?.asking ? i : undefined; });
      assert.equal(waiting.asking, "questions");
      assert.equal(waiting.status, "running", "the turn is still open");
      assert.ok(isWaiting(waiting) && !isBusy(waiting), "waiting on the user, not working");
      const saved = await waitFor(async () => {
        const stored = JSON.parse(await readFile(join(sessionsDir, `${id}.json`), "utf8").catch(() => "{}")) as Partial<StoredSession>;
        return stored.run?.asks?.length ? stored : undefined;
      });
      assert.equal(saved.run!.asks![0].ask.id, ask.id, "saved with the run, for the next server");

      assert.equal((await answer(id, ask.id, { kind: "nope" })).status, 400);
      assert.equal((await answer(id, ask.id, { kind: "approve" })).status, 409, "a plan's answer doesn't fit questions");
      assert.equal((await answer(id, ask.id, { kind: "answers", answers: { [COLOR]: ["Green"] } })).status, 200);
      await waitFor(() => s.results().length === 1);
      assert.match(resultText(s.got, 0)!, /"Green"/);
      assert.ok(s.got.some((e) => e.kind === "ask_answer" && e.payload.id === ask.id));
      const after = await waitFor(async () => { const i = await session(id); return i?.status === "idle" ? i : undefined; });
      assert.equal(after.asking, undefined);
      assert.equal((await answer(id, ask.id, { kind: "skip" })).status, 409, "answered already");
      await api(`/api/sessions/${id}`, { method: "DELETE" });
    });

    it("plans first when asked, and takes a plan back or approves it", async () => {
      const id = await startSession("one", "hello");
      const s = await listen(id);
      await waitFor(() => s.results().length === 1);
      assert.equal((await api(`/api/sessions/${id}/plan-mode`, { method: "POST", body: JSON.stringify({ plan: "yes" }) })).status, 400);
      assert.equal((await api(`/api/sessions/${id}/plan-mode`, { method: "POST", body: JSON.stringify({ plan: true }) })).status, 202);
      await waitFor(async () => (await session(id))?.planMode || undefined);

      await prompt(id, "plan");
      const plan = (await waitFor(() => asks(s.got)[0]))!;
      assert.equal(plan.kind === "plan" && plan.plan.split("\n")[0], "# Add a cache");
      assert.equal((await session(id))?.asking, "plan");
      assert.equal((await answer(id, plan.id, { kind: "feedback", text: "  " })).status, 400, "feedback needs words");
      assert.equal((await answer(id, plan.id, { kind: "feedback", text: "Use SQLite." })).status, 200);
      await waitFor(() => s.results().length === 2);
      assert.match(resultText(s.got, 1)!, /Use SQLite\.$/);
      assert.equal((await session(id))?.planMode, true, "still planning");

      await prompt(id, "plan");
      const again = (await waitFor(() => asks(s.got)[1]))!;
      assert.equal((await answer(id, again.id, { kind: "approve" })).status, 200);
      await waitFor(() => s.results().length === 3);
      const done = await waitFor(async () => { const i = await session(id); return i?.status === "idle" ? i : undefined; });
      assert.equal(done.planMode, undefined, "approving the plan ends plan mode");
      await api(`/api/sessions/${id}`, { method: "DELETE" });
    });

    it("takes a message sent while Claude waits as the answer, and sends it next", async () => {
      const id = await startSession("one", "ask");
      const s = await listen(id);
      const ask = (await waitFor(() => asks(s.got)[0]))!;
      await prompt(id, "never mind");
      await waitFor(() => s.results().length === 2);
      const answered = s.got.findIndex((e) => e.kind === "ask_answer");
      assert.deepEqual(s.got[answered].kind === "ask_answer" && s.got[answered].payload, { id: ask.id, answer: { kind: "message" } });
      assert.ok(answered < s.got.findIndex((e) => e.kind === "user_prompt" && e.payload.text === "never mind"));
      assert.match(resultText(s.got, 0)!, /sent a message instead/);
      assert.equal(resultText(s.got, 1), "You said: never mind");
      await api(`/api/sessions/${id}`, { method: "DELETE" });
    });

    it("stops waiting when the turn is stopped, and closes its tab at once", async () => {
      const id = await startSession("one", "ask");
      const s = await listen(id);
      const ask = (await waitFor(() => asks(s.got)[0]))!;
      await api(`/api/sessions/${id}/interrupt`, { method: "POST" });
      const closed = await waitFor(() => s.got.find((e) => e.kind === "ask_closed"));
      assert.deepEqual(closed.kind === "ask_closed" && closed.payload, { id: ask.id, reason: "interrupted" });
      await waitFor(async () => { const i = await session(id); return i?.status === "idle" && !i.asking ? i : undefined; });

      await prompt(id, "ask");
      await waitFor(() => asks(s.got)[1]);
      await waitFor(async () => (await session(id))?.asking || undefined);
      // Claude isn't working while it waits: there is nothing to let it finish.
      assert.equal((await api(`/api/sessions/${id}`, { method: "DELETE" })).status, 200);
      assert.equal(await session(id), undefined);
    });
  });

  it("resumes a closed session with its chat, and forks one", async () => {
    const id = await startSession("one", "remember me");
    const idle = (x: string) => waitFor(async () => { const i = await session(x); return i?.status === "idle" && i.claudeSessionId ? i : undefined; });
    const claudeId = (await idle(id)).claudeSessionId!;
    await api(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text: "second" }) });
    const first = await listen(id);
    await waitFor(() => first.results().length === 2);
    assert.equal((await api(`/api/sessions/${id}`, { method: "DELETE" })).status, 200);
    assert.equal(await session(id), undefined, "closing the tab forgets the session");

    const listed = (await json(await api("/api/sessions/resumable"))) as SessionInfo[];
    assert.equal(listed[0].id, id, "the most recent session comes first");
    assert.equal(listed[0].status, "ended");
    assert.equal(listed[0].claudeSessionId, claudeId);
    assert.deepEqual(listed.map((x) => x.updatedAt), listed.map((x) => x.updatedAt).sort().reverse());

    assert.equal((await api("/api/sessions/abc123/resume", { method: "POST" })).status, 404);
    // A saved session whose Claude id isn't one can't start, and leaves nothing behind.
    await mkdir(sessionsDir, { recursive: true });
    const info = { id: "badbad", sandbox: "one", workdir, status: "ended", prompt: "x", startedAt: new Date().toISOString(), claudeSessionId: "not-an-id" };
    await writeFile(join(sessionsDir, "badbad.json"), JSON.stringify({ info, events: [] }));
    assert.equal((await api("/api/sessions/badbad/resume", { method: "POST" })).status, 500);
    assert.equal(await session("badbad"), undefined);
    const res = await api(`/api/sessions/${id}/resume`, { method: "POST" });
    assert.equal(res.status, 201);
    assert.equal((await json(res)).id, id);
    assert.equal((await api(`/api/sessions/${id}/resume`, { method: "POST" })).status, 409, "an open session can't be resumed again");
    assert.ok(!((await json(await api("/api/sessions/resumable"))) as SessionInfo[]).some((x) => x.id === id));

    // The chat is back, without the streaming events; Claude is ready for a prompt at once.
    const resumed = await listen(id);
    const kinds = resumed.got.map((e) => e.kind === "claude" ? e.payload.type : e.kind);
    // The `user` entries are Claude's echoes of the prompts, which carry the ids a rewind goes by.
    assert.deepEqual(kinds, ["user_prompt", "user", "assistant", "result", "user_prompt", "user", "assistant", "result"]);
    assert.equal((await session(id))?.status, "idle");
    await api(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text: "third" }) });
    await waitFor(() => resumed.results().length === 3);
    assert.ok(resumed.got.some((e) => e.kind === "claude" && JSON.stringify(e.payload).includes("You said: third")));
    assert.equal((await idle(id)).claudeSessionId, claudeId, "resuming continues Claude's session");

    // A fork starts from a copy of the chat, under a new Claude session; the original carries on.
    const forked = await api(`/api/sessions/${id}/fork`, { method: "POST" });
    assert.equal(forked.status, 201);
    const forkId = (await json(forked)).id as string;
    assert.notEqual(forkId, id);
    const copy = await listen(forkId);
    assert.deepEqual(copy.got.map((e) => e.kind === "claude" ? e.payload.type : e.kind), [...kinds, "user_prompt", "user", "assistant", "result"]);
    await api(`/api/sessions/${forkId}/prompt`, { method: "POST", body: JSON.stringify({ text: "on a branch" }) });
    assert.notEqual((await idle(forkId)).claudeSessionId, claudeId);
    await waitFor(() => copy.results().length === 4);
    assert.equal((await session(id))?.claudeSessionId, claudeId);
    assert.equal((await api("/api/sessions/abc123/fork", { method: "POST" })).status, 404);

    // Forked from a message, the copy ends with that message's turn, and so does Claude's history.
    const second = resumed.got.find((e) => e.kind === "user_prompt" && e.payload.text === "second");
    const secondId = second?.kind === "user_prompt" ? second.payload.id : undefined;
    assert.ok(secondId);
    const fork = (prompt: string) => api(`/api/sessions/${id}/fork`, { method: "POST", body: JSON.stringify({ prompt }) });
    assert.equal((await fork("nope")).status, 409, "a prompt the session never sent");
    const atId = (await json(await fork(secondId))).id as string;
    const at = await listen(atId);
    assert.deepEqual(at.got.map((e) => e.kind === "claude" ? e.payload.type : e.kind), kinds);
    const secondReply = resumed.got.findLast((e) => e.kind === "claude" && e.payload.type === "assistant" && e.seq < (resumed.got.find((x) => x.kind === "user_prompt" && x.payload.text === "third")?.seq ?? 0));
    assert.ok(secondReply?.kind === "claude");
    await api(`/api/sessions/${atId}/prompt`, { method: "POST", body: JSON.stringify({ text: "where" }) });
    await waitFor(() => at.results().length === 3);
    assert.ok(at.got.some((e) => e.kind === "claude" && JSON.stringify(e.payload).includes(`resumed at ${secondReply.payload.uuid}`)));
    for (const x of [forkId, atId, id]) await api(`/api/sessions/${x}`, { method: "DELETE" });
  });

  it("rewinds in place to just before a prompt", async () => {
    const id = await startSession("one", "first");
    const idle = (x: string) => waitFor(async () => { const i = await session(x); return i?.status === "idle" && i.claudeSessionId ? i : undefined; });
    const claudeId = (await idle(id)).claudeSessionId!;
    const s = await listen(id);
    for (const [n, text] of ["second", "third"].entries()) {
      await api(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text }) });
      await waitFor(() => s.results().length === n + 2);
    }
    const prompts = s.got.flatMap((e) => (e.kind === "user_prompt" ? [e.payload] : []));
    assert.deepEqual(prompts.map((p) => p.text), ["first", "second", "third"]);
    assert.ok(prompts.every((p) => p.id), "every prompt is tagged with an id");
    const rewind = (body: object, from = id) => api(`/api/sessions/${from}/rewind`, { method: "POST", body: JSON.stringify(body) });
    const runOf = async (x: string): Promise<string | undefined> => (JSON.parse(await readFile(join(sessionsDir, `${x}.json`), "utf8")) as StoredSession).run?.id;
    const firstRun = await runOf(id);
    assert.match(firstRun ?? "", new RegExp(`^${id}-[0-9a-f]{8}$`));

    assert.equal((await rewind({})).status, 400);
    assert.equal((await rewind({ prompt: "nope" })).status, 409, "a prompt the session never sent");
    assert.equal((await rewind({ prompt: prompts[1].id }, "abc123")).status, 404);

    // Back to before "second": the session keeps its id, its chat is cut there, and open sockets are told to start over.
    const res = await rewind({ prompt: prompts[1].id, files: true });
    assert.equal(res.status, 200);
    assert.equal((await json(res)).text, "second");
    assert.equal(await s.closed, 4409);
    const cut = await listen(id);
    await waitFor(() => cut.caughtUp() !== undefined);
    assert.deepEqual(cut.got.slice(0, cut.caughtUp()).map((e) => (e.kind === "claude" ? e.payload.type : e.kind)), ["user_prompt", "user", "assistant", "result"]);
    // The rewritten buffer has a name of its own, so a tab that missed the 4409 can't resume in it from a stale seq.
    await waitFor(() => cut.buffer());
    assert.notEqual(cut.buffer(), s.buffer());
    const firstReply = s.got.find((e) => e.kind === "claude" && e.payload.type === "assistant");
    const firstReplyId = firstReply?.kind === "claude" ? String(firstReply.payload.uuid) : "";
    assert.ok(firstReplyId);
    const info = await session(id);
    assert.equal(info?.status, "idle");
    assert.equal(info?.claudeSessionId, claudeId, "Claude's new id only comes with the next turn");
    assert.equal(info?.resumeAt, firstReplyId);
    const rewoundRun = await waitFor(async () => { const r = await runOf(id); return r !== firstRun ? r : undefined; });
    // The new Claude has a run of its own; the old one goes with its Claude.
    await waitFor(() => existsSync(join(limaDir, "vm-home", RUNS_DIR, rewoundRun!)) || undefined);
    await waitFor(() => !existsSync(join(limaDir, "vm-home", RUNS_DIR, firstRun!)) || undefined);

    // Closed and resumed before that turn, it makes the same cut.
    await api(`/api/sessions/${id}`, { method: "DELETE" });
    assert.equal((await api(`/api/sessions/${id}/resume`, { method: "POST" })).status, 201);
    const back = await listen(id);
    await waitFor(() => back.caughtUp() !== undefined);
    assert.equal(back.caughtUp(), 4);
    await api(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text: "where" }) });
    await waitFor(() => back.results().length === 2);
    assert.ok(back.got.some((e) => e.kind === "claude" && JSON.stringify(e.payload).includes(`resumed at ${firstReplyId}`)), "Claude resumes at the last message of the first turn");
    const after = await idle(id);
    assert.notEqual(after.claudeSessionId, claudeId, "the cut history is its own Claude session");
    assert.equal(after.resumeAt, undefined);

    // Back to before the very first prompt: nothing to keep, so Claude starts afresh and nothing is left to resume.
    const firstAgain = back.got.find((e) => e.kind === "user_prompt");
    const fresh = await json(await rewind({ prompt: firstAgain?.kind === "user_prompt" ? firstAgain.payload.id : "" }));
    assert.equal(fresh.text, "first");
    assert.equal((await listen(id)).got.length, 0);
    assert.equal((await session(id))?.claudeSessionId, undefined);
    await waitFor(async () => !((await json(await api("/api/sessions/resumable"))) as SessionInfo[]).some((x) => x.id === id) || undefined);

    // Not while Claude is working.
    await api(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text: "slow" }) });
    const slow = await listen(id);
    const slowPrompt = slow.got.find((e) => e.kind === "user_prompt");
    assert.equal((await rewind({ prompt: slowPrompt?.kind === "user_prompt" ? slowPrompt.payload.id : "" })).status, 409);
    assert.deepEqual(server.working().map((x) => x.id), [id], "what quitting would cut short");
    await api(`/api/sessions/${id}/interrupt`, { method: "POST" });
    await waitFor(async () => (await session(id))?.status === "idle" || undefined);
    assert.deepEqual(server.working(), []);
    await api(`/api/sessions/${id}`, { method: "DELETE" });
  });

  it("deletes saved sessions by hand, and with their sandbox", async () => {
    const idle = (x: string) => waitFor(async () => { const i = await session(x); return i?.status === "idle" && i.claudeSessionId ? i : undefined; });
    const saved = async () => ((await json(await api("/api/sessions/resumable"))) as SessionInfo[]).map((x) => x.id);

    const id = await startSession("one", "delete me");
    await idle(id);
    assert.equal((await api(`/api/sessions/saved/${id}`, { method: "DELETE" })).status, 409, "an open session can't be deleted");
    await api(`/api/sessions/${id}`, { method: "DELETE" });
    assert.ok((await saved()).includes(id));
    assert.equal((await api(`/api/sessions/saved/${id}`, { method: "DELETE" })).status, 200);
    assert.ok(!(await saved()).includes(id));
    assert.equal((await api(`/api/sessions/saved/${id}`, { method: "DELETE" })).status, 404);
    // %2F decodes to "/" in route params; such an id must not reach the file system.
    assert.equal((await api("/api/sessions/saved/..%2Fsessions%2Fx", { method: "DELETE" })).status, 404);
    assert.equal((await api("/api/sessions/..%2Fx/resume", { method: "POST" })).status, 404);

    await create("doomed");
    const doomed = await startSession("doomed", "going away");
    await idle(doomed);
    const kept = await startSession("one", "stays");
    await idle(kept);
    await api(`/api/sessions/${kept}`, { method: "DELETE" });
    // Recreating keeps them: Claude's history is in the project's Claude home, on the host.
    let since = events.length;
    await api("/api/projects/doomed/recreate", { method: "POST" });
    assert.equal((await finished("doomed", "recreating", since)).type, "done");
    // Asleep while it is recreated, it continues in the new VM.
    await idle(doomed);
    assert.equal((await session(doomed))?.asleep, undefined);
    await api(`/api/sessions/${doomed}`, { method: "DELETE" });
    assert.ok((await saved()).includes(doomed), "a recreated project keeps its saved sessions");
    const last = await startSession("doomed", "the end");
    await idle(last);
    since = events.length;
    await api("/api/projects/doomed", { method: "DELETE" });
    assert.equal((await finished("doomed", "deleting", since)).type, "done");
    const gone = await session(last);
    assert.equal(gone?.status, "ended", "a deleted project's sessions end");
    assert.equal(gone?.asleep, undefined, "with no sandbox to wait for");
    await api(`/api/sessions/${last}`, { method: "DELETE" });
    const left = await saved();
    assert.ok(!left.includes(doomed), "a deleted project takes its saved sessions with it");
    assert.ok(left.includes(kept), "other projects keep theirs");
    await api(`/api/sessions/saved/${kept}`, { method: "DELETE" });
  });

  it("lets Claude finish its turn after the tab closes, and takes it back until then", async () => {
    const saved = async () => ((await json(await api("/api/sessions/resumable"))) as SessionInfo[]).map((x) => x.id);
    const id = await startSession("one", "slow");
    const chat = await listen(id);
    await waitFor(async () => (await session(id))?.status === "running");

    const res = await api(`/api/sessions/${id}?delete`, { method: "DELETE" });
    assert.equal(res.status, 202);
    assert.equal((await json(res)).finishing, true);
    assert.equal((await session(id))?.closing?.delete, true, "it is listed as closing, for tabs to leave out");
    assert.ok(!(await saved()).includes(id), "one to be deleted can't be resumed from the list");

    // Taken back: open again, Claude still working.
    assert.equal((await api(`/api/sessions/${id}/resume`, { method: "POST" })).status, 201);
    assert.equal((await session(id))?.closing, undefined);
    assert.equal((await session(id))?.status, "running");

    assert.equal((await api(`/api/sessions/${id}?delete`, { method: "DELETE" })).status, 202);
    await waitFor(async () => !(await session(id)), 20000);
    assert.equal(chat.results().length, 1, "the turn was finished, not cut short");
    assert.ok(!(await saved()).includes(id), "its saved chat is gone");
    assert.equal((await api(`/api/sessions/${id}/resume`, { method: "POST" })).status, 404);

    // Stopped instead, the turn is cut short at once.
    const stopped = await startSession("one", "slow");
    await waitFor(async () => (await session(stopped))?.status === "running");
    const r = await api(`/api/sessions/${stopped}?stop`, { method: "DELETE" });
    assert.equal(r.status, 200);
    assert.equal(await session(stopped), undefined);
    assert.ok((await saved()).includes(stopped), "closed, not deleted, it can be resumed");
    await api(`/api/sessions/saved/${stopped}`, { method: "DELETE" });
  });

  it("lists background shells, reads their output, stops one and keeps what it printed, over HTTP", async () => {
    const id = await startSession("one", "bg-shell");
    const chat = await listen(id);
    const shell = await waitFor(() => chat.got.find((e) => e.kind === "claude" && e.payload.subtype === "task_started"));
    const taskId = String(shell.kind === "claude" && shell.payload.task_id);
    const running = await waitFor(async () => { const i = await session(id); return i?.status === "idle" && i.shells === 1 ? i : undefined; });
    assert.ok(!isBusy(running), "a shell running on isn't work");
    assert.deepEqual(server.working(), [], "quitting wouldn't cut work short");
    const out = await waitFor(async () => { const o = await json(await api(`/api/sessions/${id}/tasks/${taskId}/output`)); return /line 2/.test(o.output) ? o : undefined; });
    assert.equal(out.truncated, false);
    assert.equal((await api(`/api/sessions/${id}/tasks/not%20an%20id/output`)).status, 400);

    assert.equal((await api(`/api/sessions/${id}/tasks/${taskId}/stop`, { method: "POST" })).status, 200);
    const kept = await waitFor(() => chat.got.find((e) => e.kind === "task_output"));
    assert.ok(kept.kind === "task_output" && /\[killed\]\n$/.test(kept.payload.output), "what it printed is kept");
    assert.ok(chat.got.findIndex((e) => e.kind === "task_stop") < chat.got.findIndex((e) => e.kind === "claude" && e.payload.subtype === "task_notification"), "who stopped it comes first");
    await waitFor(async () => (await session(id))?.shells === undefined);
    assert.equal(chat.results().length, 1, "Claude took no turn for the stop");

    // The Tasks pane opens beside the chat, and closes again.
    const opened = await json(await api(`/api/sessions/${id}/window/tasks`, { method: "POST", body: "{}" }));
    assert.equal(opened.widgets.tasks.kind, "tasks");
    assert.ok(Object.values(opened.panes).includes("tasks"));
    assert.ok(Object.values((await json(await api(`/api/sessions/${id}/window/tasks`, { method: "POST", body: JSON.stringify({ open: true }) }))).panes).includes("tasks"), "open leaves it open");
    assert.ok(!Object.values((await json(await api(`/api/sessions/${id}/window/tasks`, { method: "POST", body: "{}" }))).panes).includes("tasks"));
    await api(`/api/sessions/${id}?stop`, { method: "DELETE" });
  });

  it("reads all of what a task printed from Claude's file of it, while Claude keeps it", async () => {
    const id = await startSession("one", "bg-log 200");
    const chat = await listen(id);
    const kept = await waitFor(() => chat.got.find((e) => e.kind === "task_output"));
    assert.ok(kept.kind === "task_output" && kept.payload.truncated, "the end kept with the session is only the end");
    const task = kept.kind === "task_output" ? kept.payload.taskId : "";
    const res = await api(`/api/sessions/${id}/tasks/${task}/file`);
    assert.equal(res.status, 200);
    const all = await json(res);
    assert.match(all.output, /^log 1 x/);
    assert.match(all.output, /log 200 x+\n\n\[exited with code 0\]\n$/);
    assert.equal(all.totalBytes, Buffer.byteLength(all.output));
    assert.equal(all.truncated, false);
    assert.equal((await api(`/api/sessions/${id}/tasks/bnotatask/file`)).status, 404);

    // Once Claude's file is gone, it says so; what the session kept is still there.
    const done = chat.got.find((e) => e.kind === "claude" && e.payload.subtype === "task_notification")!;
    await rm(String(done.kind === "claude" && done.payload.output_file));
    assert.equal((await api(`/api/sessions/${id}/tasks/${task}/file`)).status, 410);
    await api(`/api/sessions/${id}?stop`, { method: "DELETE" });
  });

  it("says which line of a monitor woke Claude", async () => {
    const id = await startSession("one", "monitor 2");
    const chat = await listen(id);
    // Two lines, a turn each, then one more turn as the monitor ends.
    await waitFor(() => chat.results().length === 4);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(chat.got.flatMap((e) => (e.kind === "monitor_event" ? [e.payload.line] : [])), ["event 1", "event 2"]);
    await api(`/api/sessions/${id}?stop`, { method: "DELETE" });
  });

  it("lets subagents working in the background finish after the tab closes, and Claude report on them", async () => {
    const id = await startSession("one", "agents-bg");
    const chat = await listen(id);
    // Its turn is over, but the subagent works on.
    await waitFor(async () => { const i = await session(id); return i?.status === "idle" && i.agents === 1 ? i : undefined; });
    const res = await api(`/api/sessions/${id}`, { method: "DELETE" });
    assert.equal(res.status, 202);
    assert.equal((await json(res)).finishing, true);
    await waitFor(async () => !(await session(id)), 20000);
    assert.ok(chat.got.some((e) => e.kind === "claude" && e.payload.type === "system" && e.payload.subtype === "task_notification"), "the subagent was done, not cut short");
    assert.equal(chat.results().length, 2, "and Claude's turn reporting on it finished");
    await api(`/api/sessions/saved/${id}`, { method: "DELETE" });
  });

  it("logs Claude in from a session, then retries the prompt that failed", async () => {
    // The fake Claude reads its config from the fake sandbox's ~/.claude: logged out until it has credentials.
    const claudeHome = join(limaDir, "vm-home", ".claude");
    await mkdir(claudeHome, { recursive: true });
    await writeFile(join(claudeHome, ".require-login"), "");
    const post = (path: string, body?: object) => api(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });
    try {
      const id = await startSession("one", "hello while logged out");
      const s = await listen(id);
      const err = await waitFor(() => s.got.find((e) => e.kind === "error"));
      assert.ok(err.kind === "error" && err.payload.signedOut, "the error says Claude isn't logged in");
      await waitFor(async () => (await session(id))?.status === "idle" || undefined);
      const before = (await session(id))?.claudeSessionId;

      assert.deepEqual(await json(await api(`/api/sessions/${id}/login`)), {}, "not logged in, and asking starts nothing");
      // A login started twice is one login.
      const started = await json(await post(`/api/sessions/${id}/login`));
      assert.match(started.url, /^https:\/\/claude\.com\//);
      assert.equal((await json(await post(`/api/sessions/${id}/login`))).url, started.url);

      // A wrong code fails with Claude's own words, and ends that login.
      const bad = await post(`/api/sessions/${id}/login/code`, { code: "nope" });
      assert.equal(bad.status, 422);
      assert.match((await json(bad)).details.join("\n"), /Invalid code/);
      assert.equal((await post(`/api/sessions/${id}/login/code`, { code: "good-code" })).status, 422, "no login is waiting any more");
      assert.equal((await post(`/api/sessions/${id}/login/code`, { code: " " })).status, 400);

      await post(`/api/sessions/${id}/login`);
      const ok = await post(`/api/sessions/${id}/login/code`, { code: "good-code" });
      assert.equal(ok.status, 200);
      assert.deepEqual(await json(ok), { email: "you@example.com", plan: "max" });
      // Logged in now, for every session of the project.
      assert.deepEqual(await json(await api(`/api/sessions/${id}/login`)), { loggedIn: { email: "you@example.com", plan: "max" } });
      assert.deepEqual(await json(await post(`/api/sessions/${id}/login`)), { loggedIn: { email: "you@example.com", plan: "max" } });

      // Retry: a new Claude process (fresh, since no turn ever succeeded) and the failed prompt again.
      const runsBefore = (await readdir(join(limaDir, "vm-home", RUNS_DIR))).filter((r) => r.startsWith(`${id}-`));
      assert.equal(runsBefore.length, 1);
      assert.equal((await post(`/api/sessions/${id}/retry`)).status, 202);
      await waitFor(() => s.got.some((e) => e.kind === "claude" && JSON.stringify(e.payload).includes("You said: hello while logged out")));
      const after = await waitFor(async () => { const i = await session(id); return i?.status === "idle" && i.claudeSessionId ? i : undefined; });
      assert.notEqual(after.claudeSessionId, before);
      // The new Claude runs in a run of its own, and the old one goes.
      const runs = async () => (await readdir(join(limaDir, "vm-home", RUNS_DIR))).filter((r) => r.startsWith(`${id}-`));
      assert.notDeepEqual(await waitFor(async () => { const r = await runs(); return r.length === 1 ? r : undefined; }), runsBefore);
      assert.equal(s.got.filter((e) => e.kind === "ended").length, 0, "the swap doesn't end the session");

      // The turn reported the subscription's usage, which the title bar reads.
      const usage = await json(await api(`/api/sessions/${id}/usage`));
      assert.equal(usage.email, "you@example.com");
      assert.deepEqual(usage.windows.map((w: { id: string; usedPercent: number }) => [w.id, Math.round(w.usedPercent)]), [["five_hour", 7], ["seven_day", 42]]);
      await api(`/api/sessions/${id}`, { method: "DELETE" });
    } finally {
      await rm(join(claudeHome, ".require-login"), { force: true });
      await rm(join(claudeHome, ".credentials.json"), { force: true });
    }
  });

  it("sends files with prompts, keeps only their names, and sends them again on retry and after a rewind", async () => {
    const png = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.alloc(100, 7)]);
    const notes = Buffer.from("secret word: OCTOPUS\n");
    const res = await api("/api/sessions", { method: "POST", body: JSON.stringify({ sandbox: "one", prompt: "look", attachments: [{ name: "shot.png", data: png.toString("base64") }] }) });
    assert.equal(res.status, 201);
    const id = (await json(res)).id as string;
    const s = await listen(id);
    const said = (text: string) => waitFor(() => s.got.some((e) => e.kind === "claude" && e.payload.type === "result" && e.payload.result === text));
    await said("You said: look [with image/png (108 bytes)]");
    const idle = () => waitFor(async () => { const i = await session(id); return i?.status === "idle" && i.claudeSessionId ? i : undefined; });
    await idle();

    // The session names its files; their bytes are kept beside the saved sessions, once, under their hash.
    const first = s.got.find((e) => e.kind === "user_prompt");
    assert.ok(first?.kind === "user_prompt");
    const [shot] = first.payload.attachments ?? [];
    assert.deepEqual({ ...shot, hash: undefined }, { name: "shot.png", kind: "image", mediaType: "image/png", size: 108, hash: undefined });
    assert.deepEqual(await readFile(join(sessionsDir, "attachments", shot.hash)), png);
    assert.ok(!JSON.stringify(s.got).includes(png.toString("base64")), "Claude's echo of the prompt loses the bytes");

    // Files alone make a prompt.
    const prompt = (body: object) => api(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify(body) });
    assert.equal((await prompt({ text: "", attachments: [{ name: "notes.txt", data: notes.toString("base64") }] })).status, 202);
    await said("You said:  [with notes.txt (21 bytes)]");
    await idle();
    const saved = await waitFor(async () => { const f = await readFile(join(sessionsDir, `${id}.json`), "utf8"); return f.includes("notes.txt") ? f : undefined; });
    assert.ok(!saved.includes(notes.toString("base64")) && !saved.includes("OCTOPUS"), "the saved chat names the files only");

    // Files Claude can't read, too much at once, and files the server doesn't have are refused, and nothing is sent.
    const refused = async (attachments: object[], pattern: RegExp) => {
      const r = await prompt({ text: "no", attachments });
      assert.equal(r.status, 400);
      assert.match((await json(r)).error, pattern);
    };
    await refused([{ name: "app.bin", data: Buffer.from([0, 1, 2]).toString("base64") }], /app\.bin can't be attached/);
    await refused([{ name: "big.txt", data: Buffer.alloc(300 * 1024, 97).toString("base64") }], /big\.txt is too big/);
    await refused([{ name: "gone.png", hash: "0".repeat(64) }], /gone\.png is no longer on the server/);
    await refused([{ name: "x" }], /needs its data/);

    // A retry sends the last prompt again, with its files.
    assert.equal((await api(`/api/sessions/${id}/retry`, { method: "POST" })).status, 202);
    await waitFor(() => s.got.filter((e) => e.kind === "claude" && e.payload.type === "result" && e.payload.result === "You said:  [with notes.txt (21 bytes)]").length === 2);
    await idle();

    // A rewind hands the files back, and they can be sent again by hash alone.
    const rewound = await json(await api(`/api/sessions/${id}/rewind`, { method: "POST", body: JSON.stringify({ prompt: first.payload.id }) }));
    assert.deepEqual(rewound, { text: "look", attachments: [shot] });
    assert.equal((await prompt({ text: "look again", attachments: [{ name: shot.name, hash: shot.hash }] })).status, 202);
    const after = await listen(id);
    await waitFor(() => after.got.some((e) => e.kind === "claude" && e.payload.type === "result" && e.payload.result === "You said: look again [with image/png (108 bytes)]"));
    await api(`/api/sessions/${id}`, { method: "DELETE" });
  });

  describe("while the server is away", () => {
    const stored = async (id: string): Promise<StoredSession> => JSON.parse(await readFile(join(sessionsDir, `${id}.json`), "utf8"));
    /** A file of the session's current run, in the fake sandbox. */
    const runFile = async (id: string, file: string) => join(limaDir, "vm-home", RUNS_DIR, (await stored(id)).run!.id, file);
    const alive = async (id: string) => {
      try {
        process.kill(Number(await readFile(await runFile(id, "pid"), "utf8")), 0);
        return true;
      } catch {
        return false;
      }
    };
    const counting = Array.from({ length: 200 }, (_, i) => `${i + 1}`).join(" ");
    /** The text the "slow" turn has streamed so far, from its deltas. */
    const streamed = (got: SessionEvent[]) =>
      got.flatMap((e) => {
        const delta = e.kind === "claude" ? (e.payload.event as { delta?: { type?: string; text?: string } } | undefined)?.delta : undefined;
        return delta?.type === "text_delta" ? [delta.text ?? ""] : [];
      }).join("");

    it("keeps Claude working through a restart, and its tab gets the whole turn", async () => {
      const id = await startSession("one", "slow");
      const s = await listen(id);
      await waitFor(() => s.got.some((e) => e.kind === "claude" && JSON.stringify(e.payload).includes('"text":"3 "')));
      await restart();
      assert.equal(await s.closed, 1001);
      assert.ok(await alive(id), "closing the server leaves Claude running");

      // Open again, still working, in a buffer of its own: a tab that was open starts over.
      assert.equal((await session(id))?.status, "running");
      assert.equal(await (await listen(id, s.got.at(-1)!.seq, s.buffer())).closed, 4409);
      const back = await listen(id);
      await waitFor(() => back.results().length === 1, 20000);
      assert.equal(streamed(back.got), counting, "every delta of the turn, once");
      assert.deepEqual(back.got.filter((e) => e.kind === "user_prompt").map((e) => e.kind === "user_prompt" && e.payload.text), ["slow"]);
      const info = await waitFor(async () => { const x = await session(id); return x?.status === "idle" ? x : undefined; });
      assert.equal(info.unread, true);

      // The same Claude carries on.
      await api(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text: "still there?" }) });
      await waitFor(() => back.results().length === 2);
      assert.ok(back.got.some((e) => e.kind === "claude" && e.payload.type === "result" && e.payload.result === "You said: still there?"));
      await api(`/api/sessions/${id}`, { method: "DELETE" });
      await waitFor(async () => !(await alive(id)) || undefined);
    });

    it("keeps a question open through a restart, and takes the answer after", async () => {
      const id = await startSession("one", "ask");
      const s = await listen(id);
      const ask = await waitFor(() => s.got.find((e) => e.kind === "ask"));
      assert.ok(ask.kind === "ask");
      await waitFor(async () => ((await stored(id)).run?.asks?.length ? true : undefined));
      await restart();
      assert.equal((await session(id))?.asking, "questions", "still waiting on the user");
      const back = await listen(id);
      assert.equal(back.got.filter((e) => e.kind === "ask").length, 1, "the question is there once");
      const res = await api(`/api/sessions/${id}/asks/${ask.payload.id}`, { method: "POST", body: JSON.stringify({ kind: "answers", answers: { "Which color do you prefer?": ["Red"] } }) });
      assert.equal(res.status, 200);
      await waitFor(() => back.results().length === 1, 15000);
      assert.ok(back.got.some((e) => e.kind === "claude" && e.payload.type === "result" && String(e.payload.result).includes('"Red"')));
      await api(`/api/sessions/${id}`, { method: "DELETE" });
      await waitFor(async () => !(await alive(id)) || undefined);
    });

    it("brings back a turn that ended, and Claude exiting, while it was away", async () => {
      const done = await startSession("one", "hello");
      const crashed = await startSession("one", "hi");
      for (const id of [done, crashed]) await waitFor(async () => (await session(id))?.status === "idle" || undefined);
      for (const id of [done, crashed]) await api(`/api/sessions/${id}/seen`, { method: "POST" });
      await restart(undefined, async () => {
        // Prompts nobody but Claude sees, as from another server.
        await appendFile(await runFile(done, "in"), userMessage("while you were out"));
        await appendFile(await runFile(crashed, "in"), userMessage("crash"));
        await waitFor(async () => (await readFile(await runFile(done, "out"), "utf8")).includes("You said: while you were out") || undefined);
        await waitFor(async () => existsSync(await runFile(crashed, "exit")) || undefined);
      });

      // Idle before and after, and waiting on the user again once the turn it missed is replayed.
      const idle = await waitFor(async () => { const x = await session(done); return x?.unread ? x : undefined; });
      assert.equal(idle.status, "idle");
      assert.ok((await listen(done)).got.some((e) => e.kind === "claude" && e.payload.type === "result" && e.payload.result === "You said: while you were out"));

      const failed = await waitFor(async () => { const x = await session(crashed); return x?.status === "failed" ? x : undefined; });
      assert.equal(failed.unread, true);
      const s = await listen(crashed);
      const err = await waitFor(() => s.got.find((e) => e.kind === "error"));
      assert.ok(err.kind === "error");
      assert.deepEqual(err.payload.stderr, ["Error: something broke inside Claude"]);
      assert.deepEqual(s.got.at(-1)?.kind === "ended" && s.got.at(-1)?.payload, { reason: "exit", code: 3 });
      const saved = await waitFor(async () => { const x = await stored(crashed); return x.run?.live === false ? x : undefined; });
      await waitFor(() => !existsSync(join(limaDir, "vm-home", RUNS_DIR, saved.run!.id)) || undefined);
      for (const id of [done, crashed]) await api(`/api/sessions/${id}`, { method: "DELETE" });
    });

    it("attaches again when the connection to a run drops, losing and repeating nothing", async () => {
      const id = await startSession("one", "slow");
      const s = await listen(id);
      await waitFor(() => s.got.some((e) => e.kind === "claude" && JSON.stringify(e.payload).includes('"text":"3 "')));
      process.kill(Number(await readFile(await runFile(id, "attach.pid"), "utf8")), "SIGTERM");
      await waitFor(() => s.results().length === 1, 20000);
      assert.equal(streamed(s.got), counting);
      assert.equal((await session(id))?.status, "idle");
      await api(`/api/sessions/${id}`, { method: "DELETE" });
    });

    it("stops runs nobody will pick up, and leaves the sessions of stopped sandboxes to resume", async () => {
      const orphan = await startSession("one", "hello");
      const parked = await startSession("one", "hello");
      for (const id of [orphan, parked]) await waitFor(async () => (await session(id))?.status === "idle" || undefined);
      const orphanRun = join(limaDir, "vm-home", RUNS_DIR, (await stored(orphan)).run!.id);
      const orphanPid = Number(await readFile(join(orphanRun, "pid"), "utf8"));
      await restart(undefined, async () => {
        // As if the server had gone before it could save the session.
        await rm(join(sessionsDir, `${orphan}.json`));
        // And the other's run is lost, as when its VM restarts: no processes, no directory.
        const pids = await Promise.all(["pid", "hold.pid"].map(async (f) => Number(await readFile(await runFile(parked, f), "utf8"))));
        await rm(join(limaDir, "vm-home", RUNS_DIR, (await stored(parked)).run!.id), { recursive: true });
        for (const pid of pids) process.kill(pid);
      });
      assert.ok(!existsSync(orphanRun), "the orphan's run is gone");
      await waitFor(() => {
        try {
          process.kill(orphanPid, 0);
          return undefined;
        } catch {
          return true;
        }
      });
      assert.equal(await session(parked), undefined, "a session whose run is gone isn't open");
      assert.equal((await stored(parked)).run?.live, false);
      assert.ok(((await json(await api("/api/sessions/resumable"))) as SessionInfo[]).some((x) => x.id === parked), "it can be resumed");
      // Resuming it starts a Claude on its conversation, in a run of its own.
      assert.equal((await api(`/api/sessions/${parked}/resume`, { method: "POST" })).status, 201);
      assert.equal((await session(parked))?.status, "idle");
      await waitFor(async () => (await stored(parked)).run?.live || undefined);
      await api(`/api/sessions/${parked}`, { method: "DELETE" });
      await api(`/api/sessions/saved/${parked}`, { method: "DELETE" });
    });

    it("shares sandboxes with a server on another home, but not its home", async () => {
      const id = await startSession("one", "hello");
      await waitFor(async () => (await session(id))?.status === "idle" || undefined);
      await assert.rejects(startServer({ ...serverOpts, lockWaitMs: 100 }), /Another Kumiko server .* is using/);

      // Another home with the same project, on the same VM: its startup sweep leaves this home's Claude alone.
      const other = join(root, "other");
      await mkdir(join(other, "projects"), { recursive: true });
      await writeFile(join(other, "projects", "one.json"), await readFile(join(root, "data", "projects", "one.json")));
      const second = await startServer({ ...serverOpts, dataDir: other, sessionsDir: join(other, "sessions") });
      try {
        assert.ok(await alive(id), "the other server didn't stop it");
        const theirs = await json(await fetch(`${second.url}/api/sessions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${second.token}` }, body: JSON.stringify({ sandbox: "one", prompt: "hi" }) }));
        await waitFor(async () => ((await json(await fetch(`${second.url}/api/sessions`, { headers: { authorization: `Bearer ${second.token}` } }))) as SessionInfo[]).find((x) => x.id === theirs.id)?.status === "idle" || undefined);
        // And this one, restarting, leaves the other's alone.
        await restart();
        assert.equal(((await json(await fetch(`${second.url}/api/sessions`, { headers: { authorization: `Bearer ${second.token}` } }))) as SessionInfo[]).find((x) => x.id === theirs.id)?.status, "idle");
        assert.equal(await session(theirs.id), undefined);
        assert.equal((await session(id))?.status, "idle");
      } finally {
        await second.close({ endSessions: true });
      }
      await api(`/api/sessions/${id}`, { method: "DELETE" });
    });

    it("ends every live session when the server closes with endSessions", async () => {
      const id = await startSession("one", "hello");
      await waitFor(async () => (await session(id))?.status === "idle" || undefined);
      const s = await listen(id);
      const run = join(limaDir, "vm-home", RUNS_DIR, (await stored(id)).run!.id);
      await restart({ endSessions: true });
      assert.ok(s.got.some((e) => e.kind === "ended" && e.payload.reason === "quit"));
      assert.ok(!existsSync(run) || !(await alive(id)), "Claude has stopped");
      assert.equal(await session(id), undefined, "and isn't open again");
      assert.equal((await stored(id)).run?.live, false);
      await api(`/api/sessions/saved/${id}`, { method: "DELETE" });
    });
  });
});
