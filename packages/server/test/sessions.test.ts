import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";
import type { SandboxView, ServerEvent, SessionEvent, SessionInfo } from "@bentomo/shared";
import { LimaProvider, MetadataStore, shellQuote } from "@bentomo/sandbox";
import { startServer, type RunningServer } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, "../../../sandbox/fixtures");
const fakeClaude = resolve(here, "../../../agent/fixtures/fake-claude.mjs");

describe("sessions", () => {
  let server: RunningServer;
  let limaDir: string;
  let workdir: string;
  let sessionsDir: string;
  const events: ServerEvent[] = [];
  let ws: WebSocket;

  const api = (path: string, init: RequestInit = {}) =>
    fetch(server.url + path, { ...init, headers: { "content-type": "application/json", ...init.headers } });
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
  const sandbox = async (name: string): Promise<SandboxView> => ((await json(await api("/api/sandboxes"))) as SandboxView[]).find((s) => s.name === name)!;

  /** A socket on a session's events, collecting them. */
  const listen = async (id: string, afterSeq = 0) => {
    const got: SessionEvent[] = [];
    const sock = new WebSocket(`${server.url.replace("http", "ws")}/api/sessions/${id}/events?after=${afterSeq}`);
    sock.on("message", (m) => got.push(JSON.parse(String(m))));
    const closed = new Promise<number>((r) => sock.once("close", (code) => r(code)));
    await new Promise((r) => sock.once("open", r));
    const results = () => got.filter((e) => e.kind === "claude" && e.payload.type === "result");
    return { got, sock, closed, results };
  };

  const create = async (name: string, spec: object = {}) => {
    const since = events.length;
    await api("/api/sandboxes", { method: "POST", body: JSON.stringify({ name, cpus: 1, memoryGiB: 1, diskGiB: 10, mounts: [], env: ["TOKEN"], workdir, ...spec }) });
    assert.equal((await finished(name, "creating", since)).type, "done");
  };

  const startSession = async (sandboxName: string, prompt: string): Promise<string> => {
    const res = await api("/api/sessions", { method: "POST", body: JSON.stringify({ sandbox: sandboxName, prompt }) });
    assert.equal(res.status, 201);
    return (await json(res)).id;
  };

  before(async () => {
    const root = await mkdtemp(join(tmpdir(), "bentomo-sessions-test-"));
    limaDir = join(root, "lima");
    workdir = join(root, "work");
    await mkdir(limaDir);
    await mkdir(workdir); // The fake sudo doesn't create it on start.
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
    server = await startServer({ provider, port: 0, refreshMs: 200, env, home: root, sessionsDir });
    ws = new WebSocket(`${server.url.replace("http", "ws")}/api/events`);
    ws.on("message", (m) => events.push(JSON.parse(String(m))));
    await new Promise((r) => ws.once("open", r));
    await create("one");
  });

  after(async () => {
    ws.close();
    await server.close();
  });

  it("refuses bad starts", async () => {
    const post = (body: object) => api("/api/sessions", { method: "POST", body: JSON.stringify(body) });
    assert.equal((await post({ sandbox: "one", prompt: "  " })).status, 400);
    assert.equal((await post({ sandbox: "nope", prompt: "hi" })).status, 404);
    assert.equal((await post({ sandbox: "Bad!", prompt: "hi" })).status, 400);
    await writeFile(join(limaDir, "bm-cold.json"), JSON.stringify({ name: "bm-cold", status: "Stopped" }));
    assert.equal((await post({ sandbox: "cold", prompt: "hi" })).status, 409);
    assert.equal((await api("/api/sessions/abc123/prompt", { method: "POST", body: '{"text":"x"}' })).status, 404);
  });

  it("holds a conversation, streams it and replays it", async () => {
    const id = await startSession("one", "hello there");
    const s = await listen(id);
    await waitFor(() => s.results().length === 1);
    assert.deepEqual(s.got[0], { seq: 1, kind: "user_prompt", payload: { text: "hello there", id: (s.got[0] as { payload: { id?: string } }).payload.id } });
    assert.match((s.got[0] as { payload: { id?: string } }).payload.id ?? "", /^[0-9a-f-]{36}$/, "the prompt is tagged with an id");
    const init = s.got.find((e) => e.kind === "claude" && e.payload.subtype === "init");
    assert.equal(init?.kind === "claude" && init.payload.cwd, workdir, "Claude starts in the sandbox's working directory");
    assert.ok(s.got.some((e) => e.kind === "claude" && e.payload.type === "stream_event"), "deltas stream live");

    const info = await waitFor(async () => {
      const x = await session(id);
      return x?.status === "idle" ? x : undefined;
    });
    assert.equal(info?.sandbox, "one");
    assert.equal(info?.model, "claude-sonnet-5-5");
    assert.deepEqual(info?.commands, ["compact", "model", "context"], "the slash commands from init are kept on the session");
    assert.ok(info?.claudeSessionId);
    assert.equal((await sandbox("one")).sessions, 1);
    assert.ok(events.some((e) => e.type === "sessions" && e.sessions.some((x) => x.id === id)));

    // A forwarded variable reaches Claude's tools.
    assert.equal((await api(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text: "env TOKEN" }) })).status, 202);
    await waitFor(() => s.results().length === 2);
    assert.ok(s.got.some((e) => e.kind === "claude" && e.payload.type === "user" && JSON.stringify(e.payload).includes("forwarded-value")));

    // Stop ends the turn, not the session.
    await api(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text: "slow" }) });
    await waitFor(() => s.got.some((e) => e.kind === "claude" && JSON.stringify(e.payload).includes('"text":"3 "')));
    assert.equal((await api(`/api/sessions/${id}/interrupt`, { method: "POST" })).status, 202);
    await waitFor(() => s.results().length === 3);
    const interrupted = s.results()[2];
    assert.equal(interrupted.kind === "claude" && interrupted.payload.subtype, "error_during_execution");
    assert.ok(s.got.some((e) => e.kind === "interrupt"));
    assert.equal((await session(id))?.status, "idle");

    // A reconnecting tab replays from its last seq; finished turns no longer carry their deltas.
    const lastSeq = s.got.at(-1)!.seq;
    await api(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text: "/model haiku" }) });
    await waitFor(() => s.results().length === 4);
    // The picker follows /model at once, without waiting for the next reply to name the model.
    assert.equal((await session(id))?.model, "haiku");
    const again = await listen(id, lastSeq);
    await waitFor(() => again.got.some((e) => e.kind === "claude" && e.payload.type === "result"));
    assert.equal(again.got[0].seq, lastSeq + 1);

    // /rename shows up as the session's title.
    await api(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text: "/rename fix-composer" }) });
    await waitFor(async () => (await session(id))?.title === "fix-composer");
    await waitFor(() => s.results().length === 5);
    const full = await listen(id);
    await waitFor(() => full.results().length === 5);
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

  it("ends a sandbox's sessions when it stops, and runs several at once", async () => {
    await create("two");
    const a = await startSession("one", "first");
    const b = await startSession("two", "second");
    const c = await startSession("two", "third");
    const sb = await listen(b);
    await waitFor(async () => ((await json(await api("/api/sessions"))) as SessionInfo[]).every((x) => x.status === "idle") || undefined);
    assert.equal((await sandbox("two")).sessions, 2);

    const since = events.length;
    assert.equal((await api("/api/sandboxes/two/stop", { method: "POST" })).status, 202);
    assert.equal((await finished("two", "stopping", since)).type, "done");
    const logs = events.slice(since).filter((e) => e.type === "log").map((e) => (e as { data: { text: string } }).data.text);
    assert.ok(logs.includes("Ending 2 agent sessions…"));
    assert.deepEqual([(await session(b))?.status, (await session(c))?.status, (await session(a))?.status], ["ended", "ended", "idle"]);
    assert.deepEqual(sb.got.at(-1)?.kind === "ended" && sb.got.at(-1)?.payload, { reason: "sandbox", code: 0 });
    assert.equal((await sandbox("two")).sessions, 0);
  });

  it("ends sessions whose sandbox stops outside Bentomo", async () => {
    await api("/api/sandboxes/two/start", { method: "POST" });
    await waitFor(async () => { const sb = await sandbox("two"); return (sb.status === "running" && !sb.busy) || undefined; });
    const id = await startSession("two", "hello");
    await waitFor(async () => (await session(id))?.status === "idle" || undefined);
    await writeFile(join(limaDir, "bm-two.json"), JSON.stringify({ name: "bm-two", status: "Stopped" }));
    await waitFor(async () => (await session(id))?.status === "ended" || undefined);
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
    await api(`/api/sessions/${forkId}`, { method: "DELETE" });
    await api(`/api/sessions/${id}`, { method: "DELETE" });
  });

  it("rewinds to just before a prompt, in a new session", async () => {
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

    assert.equal((await rewind({})).status, 400);
    assert.equal((await rewind({ prompt: "nope" })).status, 409, "a prompt the session never sent");
    assert.equal((await rewind({ prompt: prompts[1].id }, "abc123")).status, 404);

    // Back to before "second": the new session has the chat up to there, and Claude's history is cut after the
    // last message of the first turn.
    const res = await rewind({ prompt: prompts[1].id, files: true });
    assert.equal(res.status, 201);
    const { id: branchId, text } = await json(res);
    assert.equal(text, "second");
    const branch = await listen(branchId);
    assert.deepEqual(branch.got.map((e) => (e.kind === "claude" ? e.payload.type : e.kind)), ["user_prompt", "user", "assistant", "result"]);
    await api(`/api/sessions/${branchId}/prompt`, { method: "POST", body: JSON.stringify({ text: "where" }) });
    await waitFor(() => branch.results().length === 2);
    const firstReply = s.got.find((e) => e.kind === "claude" && e.payload.type === "assistant");
    const firstReplyId = firstReply?.kind === "claude" ? String(firstReply.payload.uuid) : "";
    assert.ok(firstReplyId);
    assert.ok(branch.got.some((e) => e.kind === "claude" && JSON.stringify(e.payload).includes(`resumed at ${firstReplyId}`)), "Claude resumes at the last message of the first turn");
    assert.notEqual((await idle(branchId)).claudeSessionId, claudeId, "the branch is its own Claude session");
    assert.equal((await session(id))?.claudeSessionId, claudeId, "the original is left as it was");

    // Back to before the very first prompt: nothing to keep, so a fresh session.
    const fresh = await json(await rewind({ prompt: prompts[0].id }));
    assert.equal(fresh.text, "first");
    assert.equal((await listen(fresh.id)).got.length, 0);

    // Not while Claude is working.
    await api(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text: "slow" }) });
    assert.equal((await rewind({ prompt: prompts[1].id })).status, 409);
    await api(`/api/sessions/${id}/interrupt`, { method: "POST" });
    for (const x of [id, branchId, fresh.id]) await api(`/api/sessions/${x}`, { method: "DELETE" });
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
    const since = events.length;
    await api("/api/sandboxes/doomed", { method: "DELETE" });
    assert.equal((await finished("doomed", "deleting", since)).type, "done");
    await api(`/api/sessions/${doomed}`, { method: "DELETE" });
    const left = await saved();
    assert.ok(!left.includes(doomed), "a deleted sandbox takes its saved sessions with it");
    assert.ok(left.includes(kept), "other sandboxes keep theirs");
    await api(`/api/sessions/saved/${kept}`, { method: "DELETE" });
  });

  it("ends every live session when the server closes", async () => {
    const live = ((await json(await api("/api/sessions"))) as SessionInfo[]).filter((s) => s.status === "idle");
    assert.ok(live.length > 0);
    const s = await listen(live[0].id);
    await server.close();
    await waitFor(() => s.got.some((e) => e.kind === "ended" && e.payload.reason === "quit"));
    // `after` closes again; make that harmless.
    server = { ...server, close: async () => {} };
  });
});
