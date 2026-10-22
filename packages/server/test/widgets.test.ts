import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";
import { artifactsOf, paneIds, paneOf, windowState, type ArtifactState, type ServerEvent, type SessionEvent, type SessionInfo, type SessionStreamMessage } from "@kumiko/shared";
import { LimaProvider, MetadataStore, shellQuote } from "@kumiko/sandbox";
import { startServer, type RunningServer, type ServerOptions } from "../src/index.js";
import { makeClone } from "./repo.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, "../../../sandbox/fixtures");
const fakeClaude = resolve(here, "../../../agent/fixtures/fake-claude.mjs");

describe("widgets", () => {
  let server: RunningServer;
  let root: string;
  let limaDir: string;
  let vmHome: string;
  let clone: string;
  /** Project "one"'s Claude home on the host, which the fake VM sees as ~/.claude. */
  let claudeHome: string;
  /** Project "one"'s Kumiko folder on the host, which the fake VM sees as ~/.kumiko/shared. */
  let kumikoHome: string;
  let serverOpts: ServerOptions;
  /** What the window shows of an artifact, as the server keeps it. */
  const textOf = (a: ArtifactState | undefined) => (a?.content ? readFileSync(join(root, "sessions", "artifacts", a.content), "utf8") : "");
  const events: ServerEvent[] = [];
  let ws: WebSocket;

  const boot = async () => {
    server = await startServer(serverOpts);
    ws = new WebSocket(`${server.url.replace("http", "ws")}/api/events`, { headers: { authorization: `Bearer ${server.token}` } });
    ws.on("message", (m) => {
      const ev = JSON.parse(String(m)) as ServerEvent;
      events.push(ev);
      // A page that doesn't show the session says so, as every page does.
      if (ev.type === "pane") void api(`/api/sessions/${ev.session}/window/answer`, { method: "POST", body: JSON.stringify({ request: ev.request, error: "The session isn't on screen.", fallback: true }) });
    });
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
  const pick = (i: SessionInfo | undefined) => ({ title: i?.title, titleBy: i?.titleBy, ...(i?.description !== undefined && { description: i.description }) });
  const session = async (id: string): Promise<SessionInfo | undefined> => ((await json(await api("/api/sessions"))) as SessionInfo[]).find((s) => s.id === id);

  /** A session's events, as a tab gets them, and its window folded from them. */
  const listen = async (id: string) => {
    let got: SessionEvent[] = [];
    const sock = new WebSocket(`${server.url.replace("http", "ws")}/api/sessions/${id}/events?after=0`, { headers: { authorization: `Bearer ${server.token}` } });
    // Ready once the events so far have come, so a result from before doesn't pass for the next prompt's.
    let ready!: () => void;
    const caughtUp = new Promise<void>((r) => (ready = r));
    sock.on("message", (m) => {
      const msg = JSON.parse(String(m)) as SessionStreamMessage;
      if (msg.kind !== "caught_up") got.push(msg);
      else ready();
    });
    sock.on("close", () => ((got = []), ready()));
    await caughtUp;
    const results = () => got.filter((e) => e.kind === "claude" && e.payload.type === "result");
    return { events: () => got, window: () => windowState(got), results, close: () => sock.close() };
  };

  /** Sends a prompt and waits for its turn's result text. */
  const ask = async (s: Awaited<ReturnType<typeof listen>>, id: string, text: string): Promise<string> => {
    const before = s.results().length;
    assert.equal((await api(`/api/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text }) })).status, 202);
    const r = await waitFor(() => s.results()[before]);
    return String(r.kind === "claude" && r.payload.result);
  };
  const start = async () => {
    const res = await api("/api/sessions", { method: "POST", body: JSON.stringify({ sandbox: "one", prompt: "hi" }) });
    const { id } = await json(res);
    await waitFor(async () => (await session(id))?.status === "idle");
    return { id: id as string, s: await listen(id) };
  };
  const docPath = (id: string, name = "plan.md") => `${vmHome}/.kumiko/shared/artifacts/${id}/${name}`;
  const write = (path: string, content: string) => `write ${JSON.stringify({ file_path: path, content })}`;
  const widget = (name: string, args: object) => `widget ${name} ${JSON.stringify(args)}`;

  before(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "kumiko-widgets-test-")));
    limaDir = join(root, "lima");
    vmHome = join(limaDir, "vm-home");
    process.env.FAKE_LIMA_DIR = limaDir;
    const bin = join(vmHome, ".local", "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "claude"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fakeClaude)} "$@"\n`);
    await chmod(join(bin, "claude"), 0o755);
    const env = () => ({});
    const provider = new LimaProvider({ limactl: join(fixtures, "fake-limactl.mjs"), ssh: join(fixtures, "fake-ssh.sh"), metadata: new MetadataStore(join(root, "sandboxes")), env });
    serverOpts = { provider, port: 0, refreshMs: 200, env, home: root, dataDir: join(root, "data"), sessionsDir: join(root, "sessions") };
    await boot();
    clone = await makeClone(root, "one");
    const since = events.length;
    await api("/api/projects", { method: "POST", body: JSON.stringify({ name: "one", clonePath: clone, cpus: 1, memoryGiB: 1, diskGiB: 10, mounts: [], env: [] }) });
    await waitFor(() => events.slice(since).find((e) => "sandbox" in e && e.sandbox === "one" && e.op === "creating" && e.type === "done"));
    // The fake VM is this machine: its ~/.claude is the project's Claude home, and its ~/.kumiko/shared the project's
    // Kumiko folder, as Lima's mounts make them.
    claudeHome = join(root, "data", "claude", "one");
    kumikoHome = join(root, "data", "sandbox", "one");
    for (const [host, vm] of [[claudeHome, ".claude"], [kumikoHome, ".kumiko/shared"]]) {
      await mkdir(host, { recursive: true });
      await rm(join(vmHome, vm), { recursive: true, force: true });
      await mkdir(dirname(join(vmHome, vm)), { recursive: true });
      await symlink(host, join(vmHome, vm));
    }
  });

  after(async () => {
    ws.close();
    await server.close({ endSessions: true });
  });

  it("tells Claude where its artifacts go, and gives it the tools", async () => {
    const { id, s } = await start();
    assert.ok(existsSync(join(kumikoHome, "artifacts", id)), "the session's folder is made");
    assert.match(await ask(s, id, "system prompt"), new RegExp(`${vmHome}/\\.kumiko/shared/artifacts/${id}/`));
    const tools = JSON.parse(await ask(s, id, "tools")) as { name: string; description: string }[];
    assert.deepEqual(tools.map((t) => t.name).sort(), ["artifact_capture", "artifact_open", "artifact_reload", "artifact_remove", "artifact_share", "session_list", "session_rename", "session_start", "window_close", "window_list"]);
    // The tool names the session's folder itself, so Claude needn't find it in its instructions.
    assert.ok(tools.find((t) => t.name === "artifact_open")?.description.includes(`${vmHome}/.kumiko/shared/artifacts/${id}/`));
    s.close();
  });

  it("lets Claude name the session, until the user names it with /rename", async () => {
    const { id, s } = await start();
    assert.match(await ask(s, id, "system prompt"), /name it with the mcp__kumiko__session_rename tool/);
    const rename = (title: string) => ask(s, id, widget("session_rename", { title }));
    assert.match(await rename("  Fix   composer "), /^Named the session "Fix composer"/);
    assert.deepEqual(pick(await session(id)), { title: "Fix composer", titleBy: "agent" });
    assert.match(await rename("Fix composer"), /named "Fix composer" already/);
    assert.match(await rename("A name much too long to fit in a tab"), /is 36 characters; the tab has room for 32/);
    assert.match(await rename("   "), /Give the session a name/);
    assert.equal((await session(id))?.title, "Fix composer", "a refused name changes nothing");
    // Claude may name it again, as the subject changes.
    assert.match(await rename("Paste handling"), /^Named the session "Paste handling"/);
    assert.match(await rename("Paste images and files in prompt"), /^Named the session "Paste images and files in prompt"/);
    // The user's name wins, and stays.
    await ask(s, id, "/rename my-name");
    assert.deepEqual(pick(await session(id)), { title: "my-name", titleBy: "user" });
    assert.match(await rename("Something else"), /The user named this session "my-name" with \/rename, and their name stands/);
    assert.equal((await session(id))?.title, "my-name");
    s.close();
  });

  it("lets Claude describe the session, even once the user has named it", async () => {
    const { id, s } = await start();
    const rename = (title: string, description?: string) => ask(s, id, widget("session_rename", { title, description }));
    assert.match(await rename("Fix composer", "  Pasting an   image attaches it. "), /^Named the session "Fix composer"\. Its tab shows it\. Its description is saved/);
    assert.deepEqual(pick(await session(id)), { title: "Fix composer", titleBy: "agent", description: "Pasting an image attaches it." });
    assert.match(await rename("Fix composer", "Pasting an image attaches it."), /named "Fix composer" already, with that description/);
    assert.match(await rename("Fix composer", "Paste images and files."), /^The session's description is saved/);
    assert.match(await rename("Fix composer", "x".repeat(161)), /is 161 characters; the list has room for 160/);
    // Renamed without one, the description stays.
    await rename("Paste handling");
    assert.equal((await session(id))?.description, "Paste images and files.");
    await ask(s, id, "/rename my-name");
    assert.match(await rename("Other", "Something else entirely."), /their name stands; its description is saved/);
    assert.deepEqual(pick(await session(id)), { title: "my-name", titleBy: "user", description: "Something else entirely." });
    s.close();
  });

  it("lets Claude ask to start a new session, which starts only once the user accepts", async () => {
    const { id, s } = await start();
    const propose = (args: object) => ask(s, id, widget("session_start", args));
    const proposals = () => s.events().flatMap((e) => (e.kind === "proposal" ? [e.payload] : []));
    const answer = (proposal: string, accept: boolean) => api(`/api/sessions/${id}/proposals/${proposal}`, { method: "POST", body: JSON.stringify({ accept }) });
    const before = ((await json(await api("/api/sessions"))) as SessionInfo[]).length;

    assert.match(await propose({ prompt: "  " }), /Give the new session a prompt/);
    assert.match(await propose({ prompt: "Fix it", title: "A name much too long to fit in a tab" }), /is 36 characters; the tab has room for 32/);
    assert.equal(proposals().length, 0, "a refused ask asks nothing");
    assert.match(await propose({ prompt: " Fix the flaky upload test. ", title: "Flaky upload" }), /^Asked the user to start the session/);
    const [asked] = proposals();
    assert.deepEqual({ prompt: asked.prompt, title: asked.title }, { prompt: "Fix the flaky upload test.", title: "Flaky upload" });
    assert.match(String(asked.toolUseId), /^toolu_/);
    assert.equal(((await json(await api("/api/sessions"))) as SessionInfo[]).length, before, "nothing starts on Claude's say-so");

    // Accepted, it starts on the prompt, named as Claude asked, and can't be accepted twice.
    const res = await answer(asked.id, true);
    assert.equal(res.status, 201);
    const { id: started } = await json(res);
    assert.deepEqual(pick(await session(started)), { title: "Flaky upload", titleBy: "agent" });
    assert.equal((await session(started))?.prompt, "Fix the flaky upload test.");
    assert.deepEqual(s.events().findLast((e) => e.kind === "proposal_answer")?.payload, { id: asked.id, accepted: true, session: started });
    assert.equal((await answer(asked.id, true)).status, 409);
    assert.equal((await answer(asked.id, false)).status, 409);

    // Declined, nothing starts.
    await propose({ prompt: "Something else." });
    const other = proposals()[1];
    const count = ((await json(await api("/api/sessions"))) as SessionInfo[]).length;
    assert.equal((await answer(other.id, false)).status, 200);
    assert.deepEqual(s.events().findLast((e) => e.kind === "proposal_answer")?.payload, { id: other.id, accepted: false });
    assert.equal(((await json(await api("/api/sessions"))) as SessionInfo[]).length, count);
    assert.equal((await answer("nope", true)).status, 409);
    await api(`/api/sessions/${started}`, { method: "DELETE" });
    s.close();
  });

  it("lists the project's sessions for Claude, by their names and descriptions", async () => {
    const a = await start();
    const b = await start();
    await ask(b.s, b.id, widget("session_rename", { title: "Flaky upload", description: "Why the upload test fails one run in five." }));
    const listed = await ask(a.s, a.id, widget("session_list", {}));
    assert.match(listed, new RegExp(`- ${a.id} \\(this session\\): "hi", open, working`));
    assert.match(listed, new RegExp(`- ${b.id}: "Flaky upload", open, (idle|waiting for the user), started .* UTC\\. Why the upload test fails one run in five\\.`));
    a.s.close();
    b.s.close();
  });

  it("shares artifacts with another open session of the project, as copies", async () => {
    const a = await start();
    const b = await start();
    const share = (args: object) => ask(a.s, a.id, widget("artifact_share", args));
    await ask(a.s, a.id, write(docPath(a.id), "# The plan\n\nStep one.\n"));
    await ask(a.s, a.id, widget("artifact_open", { path: docPath(a.id) }));
    assert.match(await share({ session: a.id, artifacts: ["w2"] }), /That is this session/);
    assert.match(await share({ session: "nope", artifacts: ["w2"] }), /There is no session nope in this project/);
    assert.match(await share({ session: b.id, artifacts: ["w9"] }), /There is no artifact w9/);

    assert.match(await share({ session: b.id, artifacts: ["w2"] }), new RegExp(`^Copied "The plan" to ${docPath(b.id)} in session ${b.id}`));
    assert.equal(readFileSync(join(kumikoHome, "artifacts", b.id, "plan.md"), "utf8"), "# The plan\n\nStep one.\n");
    const [[widgetB, copy]] = artifactsOf(b.s.window());
    assert.deepEqual({ path: copy.path, title: copy.title, text: textOf(copy) }, { path: docPath(b.id), title: "The plan", text: "# The plan\n\nStep one.\n" });
    assert.equal(paneOf(b.s.window(), widgetB), undefined, "it is in the window, not shown");

    // The other session's Claude hears of it with the user's next message there, once, and not with a command.
    assert.deepEqual(b.s.events().findLast((e) => e.kind === "shared")?.payload, { from: a.id, name: "hi", artifacts: [{ path: docPath(b.id), title: "The plan" }] });
    await ask(b.s, b.id, "/model opus");
    const told = await ask(b.s, b.id, "Carry on.");
    assert.equal(told, `You said: Carry on.\n\n(From Kumiko: since your last message, session "hi" (${a.id}) shared "The plan", now at ${docPath(b.id)}. These are copies in your artifacts folder, and your window has them.)`);
    assert.equal(b.s.events().findLast((e) => e.kind === "user_prompt")?.payload.text, "Carry on.", "the chat keeps the message as the user wrote it");
    assert.equal(await ask(b.s, b.id, "And again."), "You said: And again.");

    // Shared again, the copy is replaced; one of the other session's own files by that name isn't.
    await ask(a.s, a.id, write(docPath(a.id), "# The plan\n\nStep two.\n"));
    await share({ session: b.id, artifacts: [docPath(a.id)] });
    await waitFor(() => textOf(artifactsOf(b.s.window())[0][1]).includes("Step two."));
    assert.equal(artifactsOf(b.s.window()).length, 1);
    await ask(a.s, a.id, write(docPath(a.id, "notes.md"), "mine"));
    await ask(a.s, a.id, widget("artifact_open", { path: docPath(a.id, "notes.md") }));
    // Told of the second share first, so the fake Claude's write command has nothing after it.
    assert.match(await ask(b.s, b.id, "Thanks."), /shared "The plan", now at/);
    await ask(b.s, b.id, write(docPath(b.id, "notes.md"), "theirs"));
    assert.match(await share({ session: b.id, artifacts: ["w3"] }), new RegExp(`Session ${b.id} has a file notes.md of its own already`));
    assert.equal(readFileSync(join(kumikoHome, "artifacts", b.id, "notes.md"), "utf8"), "theirs");
    a.s.close();
    b.s.close();
  });

  it("starts a session Claude asked for with copies of the artifacts it named", async () => {
    const { id, s } = await start();
    await ask(s, id, write(docPath(id), "# The plan\n"));
    await ask(s, id, widget("artifact_open", { path: docPath(id) }));
    assert.match(await ask(s, id, widget("session_start", { prompt: "Do it.", artifacts: ["https://example.com/"] })), /There is no artifact/);
    assert.match(await ask(s, id, widget("session_start", { prompt: "Do it.", artifacts: ["w2"] })), /It gets copies of w2 "The plan"/);
    const asked = s.events().findLast((e) => e.kind === "proposal");
    assert.deepEqual(asked?.kind === "proposal" && asked.payload.artifacts, [docPath(id)]);
    const res = await api(`/api/sessions/${id}/proposals/${asked?.kind === "proposal" && asked.payload.id}`, { method: "POST", body: JSON.stringify({ accept: true }) });
    const { id: started } = await json(res);
    assert.equal(readFileSync(join(kumikoHome, "artifacts", started, "plan.md"), "utf8"), "# The plan\n");
    assert.match(String((await session(started))?.prompt), new RegExp(`^Do it\\.\\n\\nCopies of artifacts from the session that asked for this one are in your artifacts folder, and your window shows them: ${docPath(started)} \\("The plan"\\)\\.$`));
    const t = await listen(started);
    const [[widget2, copy]] = artifactsOf(t.window());
    assert.equal(textOf(copy), "# The plan\n");
    assert.ok(paneOf(t.window(), widget2), "its window shows it");
    t.close();
    await api(`/api/sessions/${started}`, { method: "DELETE" });
    s.close();
  });

  it("finds an artifact Claude names in its old folder under ~/.claude in the Kumiko folder", async () => {
    const { id, s } = await start();
    // Sessions from before the move name their artifacts there; the files have moved to ~/.kumiko/shared.
    await writeFile(join(kumikoHome, "artifacts", id, "moved.md"), "# Moved\n");
    const opened = await ask(s, id, widget("artifact_open", { path: `${vmHome}/.claude/kumiko/artifacts/${id}/moved.md` }));
    assert.match(opened, /^Showing .*moved\.md as artifact/);
    assert.equal(artifactsOf(s.window())[0][1].path, docPath(id, "moved.md"), "the window names it where it is now");
    assert.equal(textOf(artifactsOf(s.window())[0][1]), "# Moved\n");
    await writeFile(join(kumikoHome, "artifacts", id, "moved.md"), "# Moved\n\nAnd changed.\n");
    await waitFor(() => textOf(artifactsOf(s.window())[0][1]).includes("And changed."));
    s.close();
  });

  it("shows an artifact Claude wrote, and follows the file as it changes", async () => {
    const { id, s } = await start();
    const path = docPath(id);
    await ask(s, id, write(path, "# The plan\n\nStep one.\n"));
    const opened = await ask(s, id, widget("artifact_open", { path }));
    assert.match(opened, /^Showing .*plan\.md as artifact w2 in a new pane p2, right of the chat/);
    const w = s.window();
    assert.deepEqual(paneIds(w.layout), ["chat", "p2"]);
    const [[, doc]] = artifactsOf(w);
    assert.equal(doc.title, "The plan");
    assert.equal(textOf(doc), "# The plan\n\nStep one.\n");
    assert.equal(doc.text, undefined, "the window names the content, rather than having it");
    // The window fetches it, as text, whatever the file.
    const served = await api(`/api/artifacts/${doc.content}`);
    assert.equal(served.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(await served.text(), "# The plan\n\nStep one.\n");
    assert.equal((await api(`/api/artifacts/${doc.content}?as=text/html`)).headers.get("content-type"), "text/plain; charset=utf-8");
    const call = s.events().find((e) => e.kind === "window");
    assert.match(String(call?.kind === "window" && call.payload.toolUseId), /^toolu_/, "the op names the tool call that made it");

    // Claude edits it: the pane follows once the tool has run, and the chat doesn't keep the text again.
    await ask(s, id, write(path, "# The plan\n\nStep one.\nStep two.\n"));
    await waitFor(() => textOf(artifactsOf(s.window())[0][1]).includes("Step two."));
    const writes = s.events().filter((e) => e.kind === "claude" && e.payload.type === "assistant" && JSON.stringify(e.payload).includes('"Write"'));
    assert.ok(JSON.stringify(writes.at(-1)).includes("bytes, shown in the artifact's pane"));
    assert.ok(JSON.stringify(writes[0]).includes("Step one."), "a Write before the artifact was shown is kept as it was");

    // The user edits it on the host, between turns.
    await writeFile(join(kumikoHome, "artifacts", id, "plan.md"), "# The plan\n\nEdited by hand.\n");
    await waitFor(() => textOf(artifactsOf(s.window())[0][1]).includes("Edited by hand."));

    assert.match(await ask(s, id, widget("window_list", {})), /side by side: \[chat \(the chat\), p2 \(artifact w2 "The plan"/);
    s.close();
  });

  it("closes a pane for the user or Claude, and shows its artifact again", async () => {
    const { id, s } = await start();
    const path = docPath(id);
    await ask(s, id, write(path, "# Notes\n"));
    await ask(s, id, widget("artifact_open", { path }));
    const closed = await api(`/api/sessions/${id}/window/close`, { method: "POST", body: JSON.stringify({ pane: "p2" }) });
    assert.equal(closed.status, 200);
    assert.deepEqual(paneIds((await json(closed)).layout), ["chat"]);
    assert.match(await ask(s, id, widget("window_list", {})), /Not shown: artifact w2 "Notes"/);
    // The user shows it again, and hides it again for Claude to show.
    const show = (w: string) => api(`/api/sessions/${id}/window/show`, { method: "POST", body: JSON.stringify({ widget: w }) });
    assert.deepEqual(paneIds((await json(await show("w2"))).layout), ["chat", "p2"]);
    assert.deepEqual(paneIds((await json(await show("w2"))).layout), ["chat", "p2"], "showing a shown widget changes nothing");
    assert.equal((await show("w9")).status, 400);
    assert.equal((await api(`/api/sessions/${id}/window/close`, { method: "POST", body: JSON.stringify({ pane: "p2" }) })).status, 200);
    assert.match(await ask(s, id, widget("artifact_open", { path, place: { split: "below" } })), /as artifact w2 in a new pane p2, below the chat/);
    assert.equal(artifactsOf(s.window()).length, 1, "the same artifact, not another");
    assert.match(await ask(s, id, widget("artifact_open", { path })), /is shown already, as artifact w2 in pane p2/);
    // The user rearranges it: the chat goes right of the artifact, then the split is resized.
    const post = (what: string, body: object) => api(`/api/sessions/${id}/window/${what}`, { method: "POST", body: JSON.stringify(body) });
    const moved = await json(await post("move", { pane: "chat", to: "p2", side: "right" }));
    assert.deepEqual(paneIds(moved.layout), ["p2", "chat"]);
    assert.equal((await json(await post("move", { pane: "p2", to: "chat", side: "swap" }))).layout.a.id, "chat");
    assert.equal((await json(await post("resize", { path: "", ratio: 0.65 }))).layout.ratio, 0.65);
    assert.equal((await post("move", { pane: "p2", to: "chat", side: "middle" })).status, 400);
    assert.equal((await post("move", { pane: "p9", to: "chat", side: "left" })).status, 400);
    assert.equal((await post("resize", { path: "", ratio: 2 })).status, 400);
    assert.equal((await post("resize", { path: "a", ratio: 0.5 })).status, 400);
    assert.match(await ask(s, id, widget("window_close", { pane: "p2" })), /^Closed pane p2/);
    assert.match(await ask(s, id, widget("window_close", { pane: "chat" })), /can't be closed/);
    s.close();
  });

  it("shows one artifact after another in the same pane, and lets the user switch it", async () => {
    const { id, s } = await start();
    const [a, b, c] = ["a.md", "b.md", "c.md"].map((n) => docPath(id, n));
    for (const [p, t] of [[a, "A"], [b, "B"], [c, "C"]]) await ask(s, id, write(p, `# ${t}\n`));
    await ask(s, id, widget("artifact_open", { path: a }));
    // The next one takes the pane the last one was in, which stays in the window.
    assert.match(await ask(s, id, widget("artifact_open", { path: b })), /as artifact w3 in pane p2 in place of "A", which stays in the window/);
    assert.deepEqual(paneIds(s.window().layout), ["chat", "p2"]);
    assert.match(await ask(s, id, widget("window_list", {})), /Not shown: artifact w2 "A".*The user can switch an artifact pane/);
    // Asked for, a second pane; then an artifact goes where one was put last.
    assert.match(await ask(s, id, widget("artifact_open", { path: c, place: { split: "below", of: "p2" } })), /in a new pane p3, below pane p2/);
    assert.match(await ask(s, id, widget("artifact_open", { path: a })), /as artifact w2 in pane p3 in place of "C"/);
    assert.match(await ask(s, id, widget("artifact_open", { path: b, place: { in: "p3" } })), /in pane p3 in place of "A"/);
    assert.deepEqual([s.window().panes.p2, s.window().panes.p3], ["w2", "w3"], "the two swapped");

    // Removing: Claude by path, the user by id. A pane showing the one removed shows another instead.
    const before = s.window();
    const shownInS2 = before.panes.p2;
    const removedPath = before.widgets[shownInS2].state as { path: string };
    assert.match(await ask(s, id, widget("artifact_remove", { artifact: shownInS2 })), new RegExp(`Removed artifact ${shownInS2} .* and deleted its file`));
    assert.equal(s.window().widgets[shownInS2], undefined);
    assert.equal(existsSync(join(kumikoHome, "artifacts", id, removedPath.path.split("/").pop()!)), false, "an artifact's file goes with it");
    for (const [p, t] of [[a, "A"], [b, "B"], [c, "C"]]) await ask(s, id, write(p, `# ${t}\n`));
    assert.ok(s.window().panes.p2, "the pane stays, showing another");
    assert.match(await ask(s, id, widget("artifact_remove", { artifact: "w99" })), /There is no artifact w99/);
    await ask(s, id, widget("artifact_open", { path: c }));
    await ask(s, id, widget("artifact_open", { path: b }));
    await ask(s, id, widget("artifact_open", { path: a }));

    // The user switches a pane: to a hidden artifact, or to the other pane's, which swaps them.
    const show = (widget: string, pane?: string) => api(`/api/sessions/${id}/window/show`, { method: "POST", body: JSON.stringify({ widget, pane }) });
    assert.equal((await json(await show("w4", "p2"))).panes.p2, "w4");
    const swapped = await json(await show("w3", "p2"));
    assert.deepEqual([swapped.panes.p2, swapped.panes.p3], ["w3", "w4"]);
    assert.equal((await show("w2", "chat")).status, 400);
    // Or opens one in a new pane split off the one it's in.
    const split = (widget: string, pane: string, how: string) => api(`/api/sessions/${id}/window/show`, { method: "POST", body: JSON.stringify({ widget, pane, split: how }) });
    const three = await json(await split("w2", "p3", "below"));
    // p2 and p3 were one above the other right of the chat; p4 is split off below p3.
    assert.deepEqual(paneIds(three.layout), ["chat", "p2", "p3", "p4"]);
    assert.equal(three.panes.p4, "w2");
    assert.equal(three.active, "p4");
    assert.equal((await split("w3", "p2", "sideways")).status, 400);
    const removed = await json(await api(`/api/sessions/${id}/window/remove`, { method: "POST", body: JSON.stringify({ widget: "w2" }) }));
    assert.equal(removed.widgets.w2, undefined);
    assert.equal((await api(`/api/sessions/${id}/window/remove`, { method: "POST", body: JSON.stringify({ widget: "chat" }) })).status, 400);
    assert.equal((await api(`/api/sessions/${id}/window/remove`, { method: "POST", body: JSON.stringify({ widget: "w99" }) })).status, 400);
    s.close();
  });

  it("shows HTML pages and live previews, and captures a pane for Claude", async () => {
    const { id, s } = await start();
    const page = docPath(id, "mock.html");
    await ask(s, id, write(page, "<!doctype html><html><head><title>Pricing mock-up</title></head><body><h1>Plans</h1></body></html>"));
    assert.match(await ask(s, id, widget("artifact_open", { path: page })), /as artifact w2 in a new pane p2/);
    const [[, html]] = artifactsOf(s.window());
    assert.deepEqual([html.type, html.title], ["html", "Pricing mock-up"]);

    // A dev server in the sandbox, which is this machine here.
    const dev = createServer((_req, res) => res.end("<h1>dev</h1>"));
    await new Promise<void>((r) => dev.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(dev.address() as AddressInfo).port}/components`;
    assert.match(await ask(s, id, widget("artifact_open", { url, place: { split: "below", of: "p2" } })), /Previewing .*\/components as artifact w3 in pane p3/);
    assert.deepEqual(
      artifactsOf(s.window()).map(([, a]) => [a.type, a.title]),
      [["html", "Pricing mock-up"], ["preview", `Preview of 127.0.0.1:${(dev.address() as AddressInfo).port}/components`]],
    );
    assert.match(await ask(s, id, widget("artifact_open", { url: "http://127.0.0.1:9/" })), /Nothing answers at http:\/\/127\.0\.0\.1:9\//);
    assert.match(await ask(s, id, widget("artifact_open", { url: "https://192.168.0.1/" })), /not a private network's/);
    assert.match(await ask(s, id, widget("artifact_open", { path: page, url })), /either path .* or url/);

    // Claude asks for a picture; a window showing the session sends one, or says why it can't.
    const answer = (picture: (req: { session: string; pane: string; request: string; reload: boolean; capture: boolean; wait: number }) => object) => {
      const sock = new WebSocket(`${server.url.replace("http", "ws")}/api/events`, { headers: { authorization: `Bearer ${server.token}` } });
      sock.on("message", (m) => {
        const ev = JSON.parse(String(m)) as ServerEvent;
        if (ev.type !== "pane") return;
        void api(`/api/sessions/${ev.session}/window/answer`, { method: "POST", body: JSON.stringify({ request: ev.request, ...picture(ev) }) });
        sock.close();
      });
      return new Promise((r) => sock.once("open", r));
    };
    let asked: { pane: string; reload: boolean; capture: boolean; wait: number } | undefined;
    await answer((req) => ((asked = req), { data: Buffer.from("png bytes").toString("base64"), mimeType: "image/png" }));
    assert.match(await ask(s, id, widget("artifact_capture", { artifact: "w2" })), /^Artifact w2 "Pricing mock-up" in pane p2, as the user sees it now\. \[image image\/png, 9 bytes\]/);
    assert.equal(asked?.pane, "p2");
    await answer(() => ({ error: "Capturing needs the Kumiko app; the user has Kumiko open in a browser." }));
    assert.match(await ask(s, id, widget("artifact_capture", {})), /needs the Kumiko app/);
    // A browser that can't take the picture doesn't fail it for the app, which answers after it.
    await answer(() => ({ error: "Capturing needs the Kumiko app; the user has Kumiko open in a browser.", fallback: true }));
    const late = new WebSocket(`${server.url.replace("http", "ws")}/api/events`, { headers: { authorization: `Bearer ${server.token}` } });
    late.on("message", (m) => {
      const ev = JSON.parse(String(m)) as ServerEvent;
      if (ev.type !== "pane") return;
      setTimeout(() => void api(`/api/sessions/${ev.session}/window/answer`, { method: "POST", body: JSON.stringify({ request: ev.request, data: Buffer.from("app").toString("base64"), mimeType: "image/png" }) }).then(() => late.close()), 200);
    });
    await new Promise((r) => late.once("open", r));
    assert.match(await ask(s, id, widget("artifact_capture", { artifact: "w2" })), /as the user sees it now\. \[image image\/png, 3 bytes\]/);
    assert.match(await ask(s, id, widget("artifact_capture", { artifact: "w9" })), /There is no artifact w9/);
    // A page that didn't load: the window says why, with the picture or without.
    const blocked = "The page didn't load: Blocked: it points to the user's machine or a private network.";
    await answer(() => ({ data: Buffer.from("png").toString("base64"), mimeType: "image/png", note: blocked }));
    assert.match(await ask(s, id, widget("artifact_capture", { artifact: "w2" })), /as the user sees it now\. The page didn't load: Blocked: .* \[image image\/png, 3 bytes\]/);

    // Loading a page again: alone, or before the picture; opening a preview shown already does it too.
    await answer((req) => ((asked = req), {}));
    assert.match(await ask(s, id, widget("artifact_reload", { artifact: url })), /^Artifact w3 .* in pane p3 has loaded again/);
    assert.deepEqual([asked?.pane, asked?.reload, asked?.capture], ["p3", true, false]);
    await answer((req) => ((asked = req), { data: Buffer.from("png").toString("base64"), mimeType: "image/png" }));
    assert.match(await ask(s, id, widget("artifact_capture", { artifact: "w3", reload: true })), /loaded again, as the user sees it now\. \[image image\/png, 3 bytes\]/);
    assert.deepEqual([asked?.reload, asked?.capture, asked?.wait], [true, true, 300]);
    await answer((req) => ((asked = req), { data: Buffer.from("png").toString("base64"), mimeType: "image/png" }));
    await ask(s, id, widget("artifact_capture", { artifact: "w3", wait: 1500 }));
    assert.deepEqual([asked?.reload, asked?.wait], [false, 1500]);
    assert.match(await ask(s, id, widget("artifact_capture", { artifact: "w3", wait: 60000 })), /wait is a number of milliseconds, from 0 to 10000/);
    await answer((req) => ((asked = req), {}));
    assert.match(await ask(s, id, widget("artifact_open", { url })), /is shown already, as artifact w3 in pane p3; it has loaded again/);
    await answer(() => ({}));
    assert.match(await ask(s, id, widget("artifact_reload", { artifact: "w2" })), /^Artifact w2 "Pricing mock-up" in pane p2 has loaded again/);
    await answer(() => ({ note: "The page didn't load: net::ERR_CONNECTION_REFUSED (http://127.0.0.1:1/)" }));
    assert.match(await ask(s, id, widget("artifact_reload", { artifact: "w2" })), /^Artifact w2 "Pricing mock-up" in pane p2 was loaded again, but the page didn't load: net::ERR_CONNECTION_REFUSED/);

    dev.close();

    // Removing says what became of the file: none for a preview, there or gone for a file.
    assert.match(await ask(s, id, widget("artifact_remove", { artifact: url })), /^Removed artifact w3 "Preview of [^"]+" from the window\. /);
    assert.match(await ask(s, id, widget("artifact_remove", { artifact: page })), /from the window, and deleted its file\./);
    assert.equal(existsSync(join(kumikoHome, "artifacts", id, "mock.html")), false);
    s.close();
  });

  it("opens external sites once the user allows them, and never private networks", async () => {
    const { id, s } = await start();
    const approve = (widget: string, allow: boolean) => api(`/api/sessions/${id}/window/approve`, { method: "POST", body: JSON.stringify({ widget, allow }) });
    assert.match(await ask(s, id, widget("artifact_open", { url: "https://example.com/docs" })), /^Asked the user to allow https:\/\/example\.com in pane p2 \(artifact w2\)/);
    let [[, site]] = artifactsOf(s.window());
    assert.deepEqual([site.type, site.title, site.approved], ["web", "example.com", false]);
    assert.match(await ask(s, id, widget("window_list", {})), /waiting for the user to allow it/);
    assert.match(await ask(s, id, widget("artifact_capture", { artifact: "w2" })), /hasn't allowed https:\/\/example\.com yet/);

    // Allowed: it loads, and other pages of the site needn't be asked for again.
    assert.equal((await approve("w2", true)).status, 200);
    [[, site]] = artifactsOf(s.window());
    assert.equal(site.approved, true);
    assert.match(await ask(s, id, widget("artifact_open", { url: "https://example.com/pricing" })), /^Showing https:\/\/example\.com\/pricing as artifact w3 in pane p2; the user allowed https:\/\/example\.com in this session already/);

    // Another site asks again; denied, it goes.
    await ask(s, id, widget("artifact_open", { url: "https://other.example/" }));
    assert.equal(artifactsOf(s.window()).find(([w]) => w === "w4")?.[1].approved, false);
    assert.equal(s.window().panes.p2, "w4");
    assert.equal((await approve("w4", false)).status, 200);
    assert.equal(s.window().widgets.w4, undefined);
    assert.equal(s.window().panes.p2, "w3", "denied, the pane goes back to what it showed");
    // Opened in a pane of its own and denied, the pane closes.
    await ask(s, id, widget("artifact_open", { url: "https://third.example/", place: { split: "below", of: "p2" } }));
    assert.deepEqual(paneIds(s.window().layout), ["chat", "p2", "p3"]);
    const third = artifactsOf(s.window()).find(([, a]) => a.path === "https://third.example/")![0];
    assert.equal((await approve(third, false)).status, 200);
    assert.deepEqual(paneIds(s.window().layout), ["chat", "p2"]);

    // This machine and private networks aren't external sites.
    for (const url of ["https://192.168.1.1/", "http://10.0.0.5/admin", "https://intranet/wiki", "https://printer.local/", "http://169.254.169.254/latest/meta-data"]) {
      assert.match(await ask(s, id, widget("artifact_open", { url })), /not a private network's/, url);
    }
    assert.equal((await approve("w9", true)).status, 400);
    assert.equal((await approve("chat", true)).status, 400);

    // A URL a browser reads as another site isn't taken for the allowed one: "\\" ends the host, so this is evil.example.
    assert.match(await ask(s, id, widget("artifact_open", { url: "https://evil.example\\@example.com/" })), /^Asked the user to allow https:\/\/evil\.example /);
    assert.equal(artifactsOf(s.window()).find(([, a]) => a.path.startsWith("https://evil.example"))?.[1].approved, false);
    s.close();
  });

  it("shows only files in the session's folder, of the types it knows", async () => {
    const { id, s } = await start();
    const dir = join(kumikoHome, "artifacts", id);
    assert.match(await ask(s, id, widget("artifact_open", { path: docPath(id, "nope.md") })), /There is no file .*nope\.md\. Write it first/);
    // The repository's files, and anything else outside the folder, aren't artifacts.
    await writeFile(join(clone, "README.md"), "# Readme\n");
    for (const path of ["/etc/hosts", "README.md", `${clone}/README.md`, `${vmHome}/.claude/settings.json`]) {
      assert.match(await ask(s, id, widget("artifact_open", { path })), /Artifacts live in this session's folder, .*: write the file there/, path);
    }
    await writeFile(join(dir, "data.json"), "{}");
    assert.match(await ask(s, id, widget("artifact_open", { path: docPath(id, "data.json") })), /can't show data\.json as an artifact\. It shows \.md, .*\.svg.*\.png/);
    // In the folder, but a link to a file outside it.
    const secret = join(root, "secret.md");
    await writeFile(secret, "top secret");
    await symlink(secret, join(dir, "link.md"));
    assert.match(await ask(s, id, widget("artifact_open", { path: docPath(id, "link.md") })), /links to a file outside/);
    // Or to another file under ~/.claude.
    await writeFile(join(claudeHome, "credentials.md"), "token");
    await symlink(join(claudeHome, "credentials.md"), join(dir, "creds.md"));
    assert.match(await ask(s, id, widget("artifact_open", { path: docPath(id, "creds.md") })), /links to a file outside this session's folder/);
    // Other types: an image is kept whole; one over 2 MB isn't kept at all.
    const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
    await writeFile(join(dir, "chart.png"), png);
    await writeFile(join(dir, "flow.mmd"), "graph TD\n  A --> B\n");
    await writeFile(join(dir, "big.png"), Buffer.alloc(3 * 1024 * 1024));
    await ask(s, id, widget("artifact_open", { path: docPath(id, "chart.png"), place: { split: "below" } }));
    await ask(s, id, widget("artifact_open", { path: docPath(id, "flow.mmd") }));
    assert.match(await ask(s, id, widget("artifact_open", { path: docPath(id, "big.png") })), /larger than 2 MB, so it isn't shown/);
    const byPath = new Map(artifactsOf(s.window()).map(([, a]) => [a.path.split("/").pop(), a]));
    assert.equal(byPath.get("chart.png")?.type, "image");
    const image = await api(`/api/artifacts/${byPath.get("chart.png")?.content}?as=image/png`);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.ok(Buffer.from(await image.arrayBuffer()).equals(png));
    assert.deepEqual([byPath.get("flow.mmd")?.type, byPath.get("flow.mmd")?.title], ["mermaid", "flow.mmd"]);
    assert.deepEqual([byPath.get("big.png")?.content, byPath.get("big.png")?.truncated], [undefined, true]);
    assert.match(await ask(s, id, widget("artifact_open", { path: docPath(id, "flow.mmd"), place: { split: "sideways" } })), /place\.split must be/);
    s.close();
  });

  it("brings a deleted artifact back, file and all, when rewound to before", async () => {
    const { id, s } = await start();
    const dir = join(kumikoHome, "artifacts", id);
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    await writeFile(join(dir, "chart.png"), png);
    await ask(s, id, widget("artifact_open", { path: docPath(id, "chart.png") }));
    await ask(s, id, widget("artifact_remove", { artifact: "w2" }));
    assert.equal(existsSync(join(dir, "chart.png")), false);
    const prompt = s.events().flatMap((e) => (e.kind === "user_prompt" && e.payload.text.includes("artifact_remove") ? [e.payload.id!] : []))[0];
    assert.equal((await api(`/api/sessions/${id}/rewind`, { method: "POST", body: JSON.stringify({ prompt }) })).status, 200);
    await waitFor(async () => existsSync(join(dir, "chart.png")) && (await readFile(join(dir, "chart.png"))).equals(png) || undefined);
    s.close();
  });

  it("neither deletes nor writes through links Claude swaps in for an artifact or its folder", async () => {
    const { id, s } = await start();
    const dir = join(kumikoHome, "artifacts", id);
    const outside = join(root, `outside-${id}`);
    await mkdir(join(dir, "sub"), { recursive: true });
    await mkdir(outside);
    await writeFile(join(dir, "sub", "notes.md"), "# Notes\n");
    await writeFile(join(outside, "notes.md"), "keep me");
    await ask(s, id, widget("artifact_open", { path: docPath(id, "sub/notes.md") }));
    // The folder becomes a link out of the session's folder: removing the artifact doesn't delete what it points to.
    await rm(join(dir, "sub"), { recursive: true });
    await symlink(outside, join(dir, "sub"));
    assert.match(await ask(s, id, widget("artifact_remove", { artifact: "w2" })), /its file was gone already/);
    assert.equal(await readFile(join(outside, "notes.md"), "utf8"), "keep me");

    // The file becomes a link before a rewind: putting it back doesn't write through it.
    const victim = join(outside, "victim.md");
    await writeFile(victim, "untouched");
    await ask(s, id, write(docPath(id, "x.md"), "# X1\n"));
    await ask(s, id, write(docPath(id, "y.md"), "# Y1\n"));
    await ask(s, id, widget("artifact_open", { path: docPath(id, "x.md") }));
    await ask(s, id, widget("artifact_open", { path: docPath(id, "y.md") }));
    await ask(s, id, write(docPath(id, "y.md"), "# Y2\n"));
    await ask(s, id, write(docPath(id, "x.md"), "# X2\n"));
    await waitFor(() => artifactsOf(s.window()).every(([, a]) => textOf(a).includes("2")) || undefined);
    await rm(join(dir, "x.md"));
    await symlink(victim, join(dir, "x.md"));
    const prompt = s.events().flatMap((e) => (e.kind === "user_prompt" && e.payload.text.includes("# Y2") ? [e.payload.id!] : []))[0];
    assert.equal((await api(`/api/sessions/${id}/rewind`, { method: "POST", body: JSON.stringify({ prompt }) })).status, 200);
    await waitFor(async () => (await readFile(join(dir, "y.md"), "utf8")) === "# Y1\n" || undefined);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await readFile(victim, "utf8"), "untouched");
    s.close();
  });

  it("reads, writes, deletes and copies nothing through a session's folder Claude swapped for a link", async () => {
    const { id, s } = await start();
    const dir = join(kumikoHome, "artifacts", id);
    await ask(s, id, write(docPath(id, "x.md"), "# X1\n"));
    await ask(s, id, widget("artifact_open", { path: docPath(id, "x.md") }));
    await ask(s, id, write(docPath(id, "x.md"), "# X2\n"));
    await waitFor(() => textOf(artifactsOf(s.window())[0][1]) === "# X2\n" || undefined);

    // The whole folder becomes a link to one on the host, as `ln -s /Users/you ~/.kumiko/shared/artifacts/<id>` makes it.
    const outside = join(root, `host-${id}`);
    await mkdir(outside);
    await writeFile(join(outside, "secret.md"), "# Secret\n");
    await writeFile(join(outside, "x.md"), "keep me");
    await rm(dir, { recursive: true });
    await symlink(outside, dir);

    assert.match(await ask(s, id, widget("artifact_open", { path: docPath(id, "secret.md") })), /links somewhere else/);
    assert.ok(!artifactsOf(s.window()).some(([, a]) => a.path.endsWith("secret.md")));
    await ask(s, id, widget("artifact_remove", { artifact: "w2" }));
    assert.equal(await readFile(join(outside, "x.md"), "utf8"), "keep me", "removing doesn't delete through it");

    const prompt = s.events().flatMap((e) => (e.kind === "user_prompt" && e.payload.text.includes("# X2") ? [e.payload.id!] : []))[0];
    assert.equal((await api(`/api/sessions/${id}/rewind`, { method: "POST", body: JSON.stringify({ prompt }) })).status, 200);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await readFile(join(outside, "x.md"), "utf8"), "keep me", "a rewind doesn't write through it");

    const fork = await json(await api(`/api/sessions/${id}/fork`, { method: "POST", body: "{}" }));
    assert.equal(existsSync(join(kumikoHome, "artifacts", fork.id, "secret.md")), false, "a fork doesn't copy what it points to");

    assert.equal((await api(`/api/sessions/${id}`, { method: "DELETE" })).status, 200);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await readFile(join(outside, "secret.md"), "utf8"), "# Secret\n", "deleting the session leaves what it points to");
    s.close();
  });

  it("never reads a file Claude swaps in for an artifact between Kumiko's check and its read", async () => {
    const { id, s } = await start();
    const dir = join(kumikoHome, "artifacts", id);
    const secret = join(root, `secret-${id}.md`);
    await writeFile(secret, `# SECRET ${id}\n`);
    await writeFile(join(dir, "a.md"), "# Fine\n");
    await ask(s, id, widget("artifact_open", { path: docPath(id, "a.md") }));
    // a.md keeps turning from the file into a link to one outside and back, each time all at once, by a rename.
    let flipping = true;
    const flipper = (async () => {
      for (let n = 0; flipping; n++) {
        const tmp = join(dir, `.swap-${n}`);
        if (n % 2) await symlink(secret, tmp);
        else await writeFile(tmp, "# Fine\n");
        await rename(tmp, join(dir, "a.md"));
      }
    })();
    for (let i = 0; i < 40; i++) await ask(s, id, widget("artifact_reload", { artifact: "w2" }));
    flipping = false;
    await flipper;
    // Everything Kumiko read of an artifact is kept here, for the window.
    const kept = readdirSync(join(root, "sessions", "artifacts")).map((f) => readFileSync(join(root, "sessions", "artifacts", f), "utf8"));
    assert.ok(!kept.some((t) => t.includes(`SECRET ${id}`)), "the file outside was read");
    s.close();
  });

  it("forks the artifacts with the window, and rewinds them with it", async () => {
    const { id, s } = await start();
    const path = docPath(id);
    await ask(s, id, write(path, "# V1\n"));
    await ask(s, id, widget("artifact_open", { path }));
    await ask(s, id, write(path, "# V2\n"));
    await waitFor(() => textOf(artifactsOf(s.window())[0][1]) === "# V2\n");

    const fork = await json(await api(`/api/sessions/${id}/fork`, { method: "POST", body: "{}" }));
    const f = await listen(fork.id);
    await waitFor(() => artifactsOf(f.window()).length === 1 || undefined);
    const [[, copy]] = artifactsOf(f.window());
    assert.equal(copy.path, docPath(fork.id), "the fork's window names its own copy");
    assert.equal(await readFile(join(kumikoHome, "artifacts", fork.id, "plan.md"), "utf8"), "# V2\n");
    f.close();

    // Back to before the second write: the window and the file in the session's folder are as they were then.
    const prompts = s.events().flatMap((e) => (e.kind === "user_prompt" && e.payload.id ? [e.payload] : []));
    const second = prompts.find((p) => p.text.includes("# V2"))!;
    assert.equal((await api(`/api/sessions/${id}/rewind`, { method: "POST", body: JSON.stringify({ prompt: second.id }) })).status, 200);
    const r = await listen(id);
    await waitFor(() => textOf(artifactsOf(r.window())[0]?.[1]) === "# V1\n" || undefined);
    await waitFor(async () => (await readFile(join(kumikoHome, "artifacts", id, "plan.md"), "utf8")) === "# V1\n" || undefined);
    r.close();
  });

  it("restarts an idle session's Claude on its own when Kumiko's tools changed while it ran", async () => {
    const { id, s } = await start();
    const current = (await json(await api("/api/sessions"))).find((x: SessionInfo) => x.id === id).toolsVersion;
    s.close();
    ws.close();
    await server.close();
    // As a Kumiko with other tools left it.
    const file = join(root, "sessions", `${id}.json`);
    const saved = JSON.parse(await readFile(file, "utf8"));
    saved.info.toolsVersion = "older";
    await writeFile(file, JSON.stringify(saved));
    await boot();
    const info = await waitFor(async () => {
      const x = (await json(await api("/api/sessions"))).find((y: SessionInfo) => y.id === id) as SessionInfo | undefined;
      return x && !x.toolsOutdated && x.toolsVersion === current && x.status === "idle" ? x : undefined;
    });
    assert.equal(info.toolsVersion, current);
    // The new Claude carries on the conversation, with the tools.
    const again = await listen(id);
    assert.match(await ask(again, id, widget("window_list", {})), /chat \(the chat\)/);
    again.close();
  });

  it("keeps the window across a server restart", async () => {
    const { id, s } = await start();
    const path = docPath(id);
    await ask(s, id, write(path, "# Kept\n"));
    await ask(s, id, widget("artifact_open", { path }));
    s.close();
    ws.close();
    await server.close();
    await boot();
    const again = await listen(id);
    await waitFor(() => artifactsOf(again.window()).length === 1 || undefined);
    assert.deepEqual(paneIds(again.window().layout), ["chat", "p2"]);
    // Its Claude has the tools this Kumiko has: nothing to restart it for.
    assert.equal((await json(await api("/api/sessions"))).find((x: SessionInfo) => x.id === id).toolsOutdated, undefined);
    // What it showed is still there, as the window's saved events name it.
    assert.equal(textOf(artifactsOf(again.window())[0][1]), "# Kept\n");
    // Its Claude was picked up, tools and all.
    assert.match(await ask(again, id, widget("window_list", {})), /p2 \(artifact w2 "Kept"/);
    again.close();
  });

  it("follows an artifact a saved window names in its old folder under ~/.claude", async () => {
    const { id, s } = await start();
    const path = docPath(id);
    await ask(s, id, write(path, "# Old\n"));
    await ask(s, id, widget("artifact_open", { path }));
    s.close();
    ws.close();
    await server.close();
    // As a window saved before the move names it.
    const saved = join(root, "sessions", `${id}.json`);
    await writeFile(saved, (await readFile(saved, "utf8")).split(`${vmHome}/.kumiko/shared/artifacts/`).join(`${vmHome}/.claude/kumiko/artifacts/`));
    await boot();
    const again = await listen(id);
    await waitFor(() => artifactsOf(again.window()).length === 1 || undefined);
    assert.equal(artifactsOf(again.window())[0][1].path, `${vmHome}/.claude/kumiko/artifacts/${id}/plan.md`);
    await writeFile(join(kumikoHome, "artifacts", id, "plan.md"), "# Old\n\nChanged where it is now.\n");
    // A turn ending reads the window's artifacts again.
    await ask(again, id, widget("window_list", {}));
    await waitFor(() => textOf(artifactsOf(again.window())[0][1]).includes("Changed where it is now."));
    again.close();
  });
});
