import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";
import { SHELL_PROMPT_CHARS, type ServerEvent, type SessionEvent, type SessionInfo, type SessionStreamMessage } from "@kumiko/shared";
import { LimaProvider, MetadataStore, shellQuote } from "@kumiko/sandbox";
import { startServer, type RunningServer, type ServerOptions } from "../src/index.js";
import { ShellOutput } from "../src/userShells.js";
import { makeClone } from "./repo.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, "../../../sandbox/fixtures");
const fakeClaude = resolve(here, "../../../agent/fixtures/fake-claude.mjs");

type Ended = Extract<SessionEvent, { kind: "user_shell_end" }>;
type Prompted = Extract<SessionEvent, { kind: "user_prompt" }>;

describe("commands the user runs", () => {
  let server: RunningServer;
  let root: string;
  let limaDir: string;
  let workdir: string;
  let serverOpts: ServerOptions;
  const events: ServerEvent[] = [];
  let ws: WebSocket;

  const boot = async () => {
    server = await startServer(serverOpts);
    ws = new WebSocket(`${server.url.replace("http", "ws")}/api/events`, { headers: { authorization: `Bearer ${server.token}` } });
    ws.on("message", (m) => events.push(JSON.parse(String(m))));
    await new Promise((r) => ws.once("open", r));
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
  const session = async (id: string): Promise<SessionInfo | undefined> => ((await json(await api("/api/sessions"))) as SessionInfo[]).find((s) => s.id === id);

  const listen = async (id: string) => {
    const got: SessionEvent[] = [];
    const sock = new WebSocket(`${server.url.replace("http", "ws")}/api/sessions/${id}/events?after=0`, { headers: { authorization: `Bearer ${server.token}` } });
    sock.on("message", (m) => {
      const msg = JSON.parse(String(m)) as SessionStreamMessage;
      if (msg.kind !== "caught_up") got.push(msg);
    });
    await new Promise((r) => sock.once("open", r));
    return { got, sock };
  };

  /** A session whose first turn is over. */
  const idleSession = async (): Promise<string> => {
    const res = await api("/api/sessions", { method: "POST", body: JSON.stringify({ sandbox: "one", prompt: "hello" }) });
    assert.equal(res.status, 201);
    const { id } = await json(res);
    await waitFor(async () => (await session(id))?.status === "idle");
    return id;
  };
  const run = async (id: string, command: string): Promise<string> => {
    const res = await api(`/api/sessions/${id}/shell`, { method: "POST", body: JSON.stringify({ command }) });
    assert.equal(res.status, 202, await res.clone().text());
    return (await json(res)).id;
  };
  const endOf = (got: SessionEvent[], run: string) => waitFor(() => got.find((e): e is Ended => e.kind === "user_shell_end" && e.payload.id === run));
  const text = (e: Ended) => e.payload.output.map((c) => c.text).join("");
  /** What Claude replied to the prompt that gave it the command: the fake echoes what it got. */
  const reply = (got: SessionEvent[]) =>
    waitFor(() => {
      const r = got.find((e) => e.kind === "claude" && e.payload.type === "result" && String(e.payload.result).includes("bash-input"));
      return r?.kind === "claude" ? String(r.payload.result) : undefined;
    });

  before(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "kumiko-shell-test-")));
    limaDir = join(root, "lima");
    await mkdir(limaDir);
    process.env.FAKE_LIMA_DIR = limaDir;
    const bin = join(limaDir, "vm-home", ".local", "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "claude"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fakeClaude)} "$@"\n`);
    await chmod(join(bin, "claude"), 0o755);
    const env = () => ({ TOKEN: "forwarded-value" });
    const provider = new LimaProvider({ limactl: join(fixtures, "fake-limactl.mjs"), ssh: join(fixtures, "fake-ssh.sh"), metadata: new MetadataStore(join(root, "sandboxes")), env });
    serverOpts = { provider, port: 0, refreshMs: 200, env, home: root, dataDir: join(root, "data"), sessionsDir: join(root, "sessions") };
    await boot();
    workdir = await makeClone(root, "one");
    const since = events.length;
    const res = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: "one", clonePath: workdir, cpus: 1, memoryGiB: 1, diskGiB: 10, mounts: [], env: ["TOKEN"] }) });
    assert.equal(res.status, 202);
    await waitFor(() => events.slice(since).find((e) => "sandbox" in e && e.op === "creating" && e.type === "done"), 30000);
  });

  after(async () => {
    ws.close();
    await server.close({ endSessions: true });
  });

  it("runs a command in the working directory with the forwarded variables, and gives Claude its output", async () => {
    const id = await idleSession();
    const { got, sock } = await listen(id);
    const r = await run(id, 'pwd; echo "token=$TOKEN"; echo oops >&2; exit 3');
    const started = got.find((e) => e.kind === "user_shell");
    assert.ok(started?.kind === "user_shell");
    const { startedAt, ...payload } = started.payload;
    assert.deepEqual(payload, { id: r, command: 'pwd; echo "token=$TOKEN"; echo oops >&2; exit 3', cwd: workdir });
    assert.ok(Math.abs(Date.parse(startedAt) - Date.now()) < 10_000);
    const end = await endOf(got, r);
    assert.equal(end.payload.code, 3);
    assert.equal(end.payload.stopped, undefined);
    assert.equal(end.payload.cut, 0);
    assert.deepEqual(end.payload.output.filter((c) => c.stream === "err"), [{ stream: "err", text: "oops\n" }]);
    assert.match(text(end), new RegExp(`^${workdir}\\ntoken=forwarded-value\\n`));
    // The prompt shows as the command, and gives Claude the command and its output in Claude Code's own tags.
    const prompt = await waitFor(() => got.find((e): e is Prompted => e.kind === "user_prompt" && e.payload.shell === r));
    assert.equal(prompt.payload.text, '!pwd; echo "token=$TOKEN"; echo oops >&2; exit 3');
    const said = await reply(got);
    assert.match(said, /<bash-input>pwd; echo "token=\$TOKEN"; echo oops &gt;&amp;2; exit 3<\/bash-input>/);
    assert.match(said, /<bash-stdout>[^<]*token=forwarded-value<\/bash-stdout><bash-stderr>oops<\/bash-stderr><bash-exit-code>3<\/bash-exit-code>/);
    // What streamed in is dropped once the end keeps it.
    sock.close();
    const again = await listen(id);
    await waitFor(() => again.got.some((e) => e.kind === "user_shell_end"));
    assert.equal(again.got.filter((e) => e.kind === "user_shell_output").length, 0);
    again.sock.close();
  });

  it("streams output as the command runs", async () => {
    const id = await idleSession();
    const { got, sock } = await listen(id);
    const r = await run(id, "echo first; sleep 1; echo second");
    await waitFor(() => got.some((e) => e.kind === "user_shell_output" && e.payload.chunk.text.includes("first")));
    assert.ok(!got.some((e) => e.kind === "user_shell_end"), "output came before the end");
    assert.equal(text(await endOf(got, r)), "first\nsecond\n");
    sock.close();
  });

  it("gives a command no input", async () => {
    const id = await idleSession();
    const { got, sock } = await listen(id);
    const end = await endOf(got, await run(id, 'read line; echo "read=$?"'));
    assert.equal(text(end), "read=1\n");
    sock.close();
  });

  it("stops a command that runs until stopped, with everything it started, and tells Claude", async () => {
    const id = await idleSession();
    const { got, sock } = await listen(id);
    const marker = join(root, "child-alive");
    // A child of the command's that ignores nothing: it goes with the command's process group.
    const r = await run(id, `(while :; do touch ${shellQuote(marker)}; sleep 0.1; done) & echo started; wait`);
    await waitFor(() => got.some((e) => e.kind === "user_shell_output" && e.payload.chunk.text.includes("started")));
    const res = await api(`/api/sessions/${id}/shell/${r}/stop`, { method: "POST" });
    assert.equal(res.status, 200);
    const end = await endOf(got, r);
    assert.equal(end.payload.stopped, "user");
    assert.equal(end.payload.code, undefined);
    assert.ok(end.payload.durationMs < 3000, `stopped by the interrupt, not the kill: ${end.payload.durationMs}ms`);
    assert.match(await reply(got), /<bash-stdout>started<\/bash-stdout><bash-stderr>Stopped by the user after \d+\.\ds\.<\/bash-stderr>/);
    // Nothing of it is left running.
    await new Promise((r) => setTimeout(r, 300));
    const { mtimeMs } = await import("node:fs/promises").then((fs) => fs.stat(marker));
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await import("node:fs/promises").then((fs) => fs.stat(marker))).mtimeMs, mtimeMs);
    assert.equal((await api(`/api/sessions/${id}/shell/${r}/stop`, { method: "POST" })).status, 409);
    sock.close();
  });

  it("cuts long output for Claude, which can read all of it in a log", async () => {
    const id = await idleSession();
    const { got, sock } = await listen(id);
    const end = await endOf(got, await run(id, "seq 1 20000"));
    assert.ok(end.payload.log, "a log was written");
    assert.equal(await readFile(end.payload.log!, "utf8"), Array.from({ length: 20000 }, (_, i) => `${i + 1}\n`).join(""));
    const said = await reply(got);
    assert.ok(said.length < SHELL_PROMPT_CHARS + 1000, `Claude got ${said.length} characters`);
    assert.match(said, /<bash-stdout>1\n2\n/);
    assert.match(said, new RegExp(`\\[… [\\d,]+ lines cut; all of the output is in ${end.payload.log!.replace(/[.]/g, "\\.")}\\]`));
    assert.match(said, /19999\n20000<\/bash-stdout>/);
    sock.close();
  });

  it("gives Claude a command that ends while it works at once, in the turn it is taking", async () => {
    const id = await idleSession();
    const { got, sock } = await listen(id);
    const res = await api(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text: "slow" }) });
    assert.equal(res.status, 202);
    await waitFor(async () => (await session(id))?.status === "running");
    const r = await run(id, "echo meanwhile");
    await endOf(got, r);
    // Sent as soon as it ended, while the turn still runs: Claude reads it at its next step, as any message sent then.
    const prompt = await waitFor(() => got.find((e): e is Prompted => e.kind === "user_prompt" && e.payload.shell === r));
    const turnOver = got.findIndex((e) => e.kind === "claude" && e.payload.type === "result" && got.indexOf(e) > got.indexOf(prompt));
    assert.equal(turnOver, -1, "the prompt went before the turn was over");
    assert.equal((await session(id))?.status, "running");
    await api(`/api/sessions/${id}/interrupt`, { method: "POST" });
    assert.match(await reply(got), /<bash-stdout>meanwhile<\/bash-stdout>/);
    sock.close();
  });

  it("refuses a rewind while a command runs", async () => {
    const id = await idleSession();
    const { got, sock } = await listen(id);
    const first = got.find((e): e is Prompted => e.kind === "user_prompt")!;
    const r = await run(id, "sleep 5");
    const res = await api(`/api/sessions/${id}/rewind`, { method: "POST", body: JSON.stringify({ prompt: first.payload.id }) });
    assert.equal(res.status, 409);
    assert.match((await json(res)).error, /your command/);
    await api(`/api/sessions/${id}/shell/${r}/stop`, { method: "POST" });
    await endOf(got, r);
    sock.close();
  });

  it("refuses an empty command and one in a session that isn't there", async () => {
    const id = await idleSession();
    assert.equal((await api(`/api/sessions/${id}/shell`, { method: "POST", body: JSON.stringify({ command: "  " }) })).status, 400);
    assert.equal((await api(`/api/sessions/abc123/shell`, { method: "POST", body: JSON.stringify({ command: "ls" }) })).status, 404);
    assert.equal((await api(`/api/sessions/${id}/shell/nope/stop`, { method: "POST" })).status, 400);
  });

  it("marks a command running when the server went away as stopped, keeping what it printed", async () => {
    const id = await idleSession();
    const { got, sock } = await listen(id);
    const r = await run(id, "echo before; sleep 30");
    await waitFor(() => got.some((e) => e.kind === "user_shell_output" && e.payload.chunk.text.includes("before")));
    sock.close();
    ws.close();
    await server.close();
    await boot();
    await waitFor(async () => (await session(id)) !== undefined);
    const after = await listen(id);
    const end = await endOf(after.got, r);
    assert.equal(end.payload.stopped, "lost");
    assert.equal(text(end), "before\n");
    after.sock.close();
    // The server that went away stopped it: nothing of the run is left in the sandbox.
    await waitFor(() => !existsSync(join(limaDir, "vm-home", ".cache", "kumiko", "shell", `${r}.pid`)), 15000);
  });
});

describe("ShellOutput", () => {
  it("keeps the start and the end of long output, and counts what it left out", () => {
    const out = new ShellOutput(5, 6);
    out.add({ stream: "out", text: "abcdefgh" });
    out.add({ stream: "err", text: "ijklmnop" });
    assert.equal(out.length, 16);
    assert.equal(out.cut, 5);
    assert.deepEqual(out.chunks(), [
      { stream: "out", text: "abcde" },
      { stream: "err", text: "\n[… 5 characters not kept]\n" },
      { stream: "err", text: "klmnop" },
    ]);
  });
});
