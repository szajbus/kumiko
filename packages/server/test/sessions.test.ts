import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";
import type { ProjectView, ServerEvent, SessionEvent, SessionInfo, SessionStreamMessage } from "@bentomo/shared";
import { LimaProvider, MetadataStore, shellQuote } from "@bentomo/sandbox";
import { startServer, type RunningServer } from "../src/index.js";
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
  const sandbox = async (name: string): Promise<ProjectView> => ((await json(await api("/api/projects"))) as ProjectView[]).find((s) => s.name === name)!;

  /** A socket on a session's events, collecting them; `caughtUp` is how many had come when the replay was done. */
  const listen = async (id: string, afterSeq = 0) => {
    const got: SessionEvent[] = [];
    let caughtUp: number | undefined;
    const sock = new WebSocket(`${server.url.replace("http", "ws")}/api/sessions/${id}/events?after=${afterSeq}`);
    sock.on("message", (m) => {
      const msg = JSON.parse(String(m)) as SessionStreamMessage;
      if (msg.kind === "caught_up") caughtUp ??= got.length;
      else got.push(msg);
    });
    const closed = new Promise<number>((r) => sock.once("close", (code) => r(code)));
    await new Promise((r) => sock.once("open", r));
    const results = () => got.filter((e) => e.kind === "claude" && e.payload.type === "result");
    return { got, sock, closed, results, caughtUp: () => caughtUp };
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
    root = await realpath(await mkdtemp(join(tmpdir(), "bentomo-sessions-test-")));
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
    server = await startServer({ provider, port: 0, refreshMs: 200, env, home: root, dataDir: join(root, "data"), sessionsDir });
    ws = new WebSocket(`${server.url.replace("http", "ws")}/api/events`);
    ws.on("message", (m) => events.push(JSON.parse(String(m))));
    await new Promise((r) => ws.once("open", r));
    workdir = await create("one");
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
    // A VM that isn't a project's can't host a session; a project's stopped VM can't either, until it starts.
    await writeFile(join(limaDir, "bm-stray.json"), JSON.stringify({ name: "bm-stray", status: "Running" }));
    assert.equal((await post({ sandbox: "stray", prompt: "hi" })).status, 404);
    await create("cold");
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

  it("ends a sandbox's sessions when it stops, and runs several at once", async () => {
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
    assert.ok(logs.includes("Ending 2 agent sessions…"));
    assert.deepEqual([(await session(b))?.status, (await session(c))?.status, (await session(a))?.status], ["ended", "ended", "idle"]);
    assert.deepEqual(sb.got.at(-1)?.kind === "ended" && sb.got.at(-1)?.payload, { reason: "sandbox", code: 0 });
    assert.equal((await sandbox("two")).sessions, 0);
  });

  it("ends sessions whose sandbox stops outside Bentomo", async () => {
    await api("/api/projects/two/start", { method: "POST" });
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

    assert.equal((await rewind({})).status, 400);
    assert.equal((await rewind({ prompt: "nope" })).status, 409, "a prompt the session never sent");
    assert.equal((await rewind({ prompt: prompts[1].id }, "abc123")).status, 404);

    // Back to before "second": the session keeps its id, its chat is cut there, and open sockets are told to start over.
    const res = await rewind({ prompt: prompts[1].id, files: true });
    assert.equal(res.status, 200);
    assert.equal((await json(res)).text, "second");
    assert.equal(await s.closed, 4409);
    const cut = await listen(id);
    assert.deepEqual(cut.got.map((e) => (e.kind === "claude" ? e.payload.type : e.kind)), ["user_prompt", "user", "assistant", "result"]);
    const firstReply = s.got.find((e) => e.kind === "claude" && e.payload.type === "assistant");
    const firstReplyId = firstReply?.kind === "claude" ? String(firstReply.payload.uuid) : "";
    assert.ok(firstReplyId);
    const info = await session(id);
    assert.equal(info?.status, "idle");
    assert.equal(info?.claudeSessionId, claudeId, "Claude's new id only comes with the next turn");
    assert.equal(info?.resumeAt, firstReplyId);

    // Closed and resumed before that turn, it makes the same cut.
    await api(`/api/sessions/${id}`, { method: "DELETE" });
    assert.equal((await api(`/api/sessions/${id}/resume`, { method: "POST" })).status, 201);
    const back = await listen(id);
    assert.equal(back.got.length, 4);
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
    assert.equal((await session(doomed))?.status, "ended");
    await api(`/api/sessions/${doomed}`, { method: "DELETE" });
    assert.ok((await saved()).includes(doomed), "a recreated project keeps its saved sessions");
    since = events.length;
    await api("/api/projects/doomed", { method: "DELETE" });
    assert.equal((await finished("doomed", "deleting", since)).type, "done");
    const left = await saved();
    assert.ok(!left.includes(doomed), "a deleted project takes its saved sessions with it");
    assert.ok(left.includes(kept), "other projects keep theirs");
    await api(`/api/sessions/saved/${kept}`, { method: "DELETE" });
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
      assert.equal((await post(`/api/sessions/${id}/retry`)).status, 202);
      await waitFor(() => s.got.some((e) => e.kind === "claude" && JSON.stringify(e.payload).includes("You said: hello while logged out")));
      const after = await waitFor(async () => { const i = await session(id); return i?.status === "idle" && i.claudeSessionId ? i : undefined; });
      assert.notEqual(after.claudeSessionId, before);
      assert.equal(s.got.filter((e) => e.kind === "ended").length, 0, "the swap doesn't end the session");
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
