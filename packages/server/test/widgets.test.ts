import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";
import { artifactsOf, paneIds, windowState, type ArtifactState, type ServerEvent, type SessionEvent, type SessionInfo, type SessionStreamMessage } from "@kumiko/shared";
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
  let serverOpts: ServerOptions;
  /** What the window shows of an artifact, as the server keeps it. */
  const textOf = (a: ArtifactState | undefined) => (a?.content ? readFileSync(join(root, "sessions", "artifacts", a.content), "utf8") : "");
  const events: ServerEvent[] = [];
  let ws: WebSocket;

  const boot = async () => {
    server = await startServer(serverOpts);
    ws = new WebSocket(`${server.url.replace("http", "ws")}/api/events`);
    ws.on("message", (m) => events.push(JSON.parse(String(m))));
    await new Promise((r) => ws.once("open", r));
  };
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
  const session = async (id: string): Promise<SessionInfo | undefined> => ((await json(await api("/api/sessions"))) as SessionInfo[]).find((s) => s.id === id);

  /** A session's events, as a tab gets them, and its window folded from them. */
  const listen = async (id: string) => {
    let got: SessionEvent[] = [];
    const sock = new WebSocket(`${server.url.replace("http", "ws")}/api/sessions/${id}/events?after=0`);
    sock.on("message", (m) => {
      const msg = JSON.parse(String(m)) as SessionStreamMessage;
      if (msg.kind !== "caught_up") got.push(msg);
    });
    sock.on("close", () => (got = []));
    await new Promise((r) => sock.once("open", r));
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
  const docPath = (id: string, name = "plan.md") => `${vmHome}/.claude/kumiko/artifacts/${id}/${name}`;
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
    // The fake VM is this machine: its ~/.claude is the project's Claude home, as Lima's mount makes it.
    claudeHome = join(root, "data", "claude", "one");
    await mkdir(claudeHome, { recursive: true });
    await rm(join(vmHome, ".claude"), { recursive: true, force: true });
    await symlink(claudeHome, join(vmHome, ".claude"));
  });

  after(async () => {
    ws.close();
    await server.close({ endSessions: true });
  });

  it("tells Claude where its artifacts go, and gives it the tools", async () => {
    const { id, s } = await start();
    assert.ok(existsSync(join(claudeHome, "kumiko", "artifacts", id)), "the session's folder is made");
    assert.match(await ask(s, id, "system prompt"), new RegExp(`${vmHome}/\\.claude/kumiko/artifacts/${id}/`));
    const tools = JSON.parse(await ask(s, id, "tools")) as { name: string; description: string }[];
    assert.deepEqual(tools.map((t) => t.name).sort(), ["artifact_capture", "artifact_open", "artifact_reload", "artifact_remove", "window_close", "window_list"]);
    // The tool names the session's folder itself, so Claude needn't find it in its instructions.
    assert.ok(tools.find((t) => t.name === "artifact_open")?.description.includes(`${vmHome}/.claude/kumiko/artifacts/${id}/`));
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
    await writeFile(join(claudeHome, "kumiko", "artifacts", id, "plan.md"), "# The plan\n\nEdited by hand.\n");
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
    assert.equal(existsSync(join(claudeHome, "kumiko", "artifacts", id, removedPath.path.split("/").pop()!)), false, "an artifact's file goes with it");
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
      const sock = new WebSocket(`${server.url.replace("http", "ws")}/api/events`);
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
    assert.equal(existsSync(join(claudeHome, "kumiko", "artifacts", id, "mock.html")), false);
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
    s.close();
  });

  it("shows only files in the session's folder, of the types it knows", async () => {
    const { id, s } = await start();
    const dir = join(claudeHome, "kumiko", "artifacts", id);
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
    const dir = join(claudeHome, "kumiko", "artifacts", id);
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
    assert.equal(await readFile(join(claudeHome, "kumiko", "artifacts", fork.id, "plan.md"), "utf8"), "# V2\n");
    f.close();

    // Back to before the second write: the window and the file in the session's folder are as they were then.
    const prompts = s.events().flatMap((e) => (e.kind === "user_prompt" && e.payload.id ? [e.payload] : []));
    const second = prompts.find((p) => p.text.includes("# V2"))!;
    assert.equal((await api(`/api/sessions/${id}/rewind`, { method: "POST", body: JSON.stringify({ prompt: second.id }) })).status, 200);
    const r = await listen(id);
    await waitFor(() => textOf(artifactsOf(r.window())[0]?.[1]) === "# V1\n" || undefined);
    await waitFor(async () => (await readFile(join(claudeHome, "kumiko", "artifacts", id, "plan.md"), "utf8")) === "# V1\n" || undefined);
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
});
