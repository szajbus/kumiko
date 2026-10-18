import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";
import type { SandboxView, ServerEvent } from "@bentomo/shared";
import { LimaProvider, MetadataStore } from "@bentomo/sandbox";
import { startServer, type RunningServer } from "../src/index.js";

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), "../../../sandbox/fixtures");

describe("server", () => {
  let server: RunningServer;
  let limaDir: string;
  let mountDir: string;
  const events: ServerEvent[] = [];
  let ws: WebSocket;

  before(async () => {
    const root = await mkdtemp(join(tmpdir(), "bentomo-server-test-"));
    limaDir = join(root, "lima");
    mountDir = join(root, "mount");
    await mkdir(limaDir);
    await mkdir(mountDir);
    await writeFile(join(limaDir, "wm-foreign.json"), JSON.stringify({ name: "wm-foreign", status: "Running" }));
    process.env.FAKE_LIMA_DIR = limaDir;
    process.env.FAKE_LIMA_DELAY = "150";
    const env = () => ({ TOKEN: "abc" });
    const provider = new LimaProvider({
      limactl: join(fixtures, "fake-limactl.mjs"),
      ssh: join(fixtures, "fake-ssh.sh"),
      metadata: new MetadataStore(join(root, "sandboxes")),
      env,
    });
    server = await startServer({ provider, port: 0, refreshMs: 200, env });
    ws = new WebSocket(`${server.url.replace("http", "ws")}/api/events`);
    ws.on("message", (m) => events.push(JSON.parse(String(m))));
    await new Promise((r) => ws.once("open", r));
  });

  after(async () => {
    ws.close();
    await server.close();
  });

  const api = (path: string, init: RequestInit = {}) =>
    fetch(server.url + path, { ...init, headers: { "content-type": "application/json", ...init.headers } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = (r: Response): Promise<any> => r.json();
  const waitFor = async <T>(fn: () => T | undefined, ms = 10000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const finished = (name: string, op: string, since: number) =>
    waitFor(() => events.slice(since).find((e) => "sandbox" in e && e.sandbox === name && e.op === op && (e.type === "done" || e.type === "error")));

  it("sends a snapshot first and never lists foreign instances", async () => {
    await waitFor(() => events[0]);
    assert.equal(events[0].type, "snapshot");
    const res = await api("/api/sandboxes");
    assert.deepEqual(await json(res), []);
  });

  it("serves templates and env presence without values", async () => {
    const t = await json(await api("/api/templates"));
    assert.equal(t.preferred, "template:debian-12");
    const env = await json(await api("/api/env?names=TOKEN,NOPE,bad-name"));
    assert.deepEqual(env, { TOKEN: true, NOPE: false });
  });

  it("rejects invalid specs with 400", async () => {
    const res = await api("/api/sandboxes", { method: "POST", body: JSON.stringify({ name: "-x", cpus: 1, memoryGiB: 1, diskGiB: 10, mounts: [], env: [] }) });
    assert.equal(res.status, 400);
    const body = await json(res);
    assert.match(body.details.join(), /Name/);
  });

  it("runs a full lifecycle with streamed logs and 409 while busy", async () => {
    const since = events.length;
    const res = await api("/api/sandboxes", {
      method: "POST",
      body: JSON.stringify({
        name: "web", cpus: 2, memoryGiB: 2, diskGiB: 20,
        mounts: [{ hostPath: mountDir, writable: true }],
        env: ["TOKEN", "MISSING"],
        provision: `echo "token=$TOKEN" > ${mountDir}/out`,
      }),
    });
    assert.equal(res.status, 202);
    assert.deepEqual((await json(res)).warnings.length, 1);

    // A creating sandbox shows up before Lima knows it, marked busy.
    const listed = await waitFor(() =>
      events.slice(since).find((e): e is Extract<ServerEvent, { type: "list" }> => e.type === "list" && e.sandboxes.some((s) => s.name === "web" && s.busy)));
    assert.equal(listed.sandboxes.find((s) => s.name === "web")!.operation?.op, "creating");

    const busy = await api("/api/sandboxes/web/stop", { method: "POST" });
    assert.equal(busy.status, 409);

    const done = await finished("web", "creating", since);
    assert.equal(done.type, "done");
    const logs = events.slice(since).filter((e) => e.type === "log").map((e) => (e as { data: { text: string } }).data.text);
    assert.ok(logs.some((l) => l.startsWith("$ limactl create --tty=false --name=bm-web")));
    assert.ok(logs.includes("Provisioning finished."));

    let [sb] = (await json(await api("/api/sandboxes"))) as SandboxView[];
    assert.equal(sb.status, "running");
    assert.equal(sb.meta?.setup, "ready");
    assert.equal(sb.vm, "bm-web");

    let s2 = events.length;
    assert.equal((await api("/api/sandboxes/web/stop", { method: "POST" })).status, 202);
    assert.equal((await finished("web", "stopping", s2)).type, "done");
    [sb] = await json(await api("/api/sandboxes"));
    assert.equal(sb.status, "stopped");

    // A new client gets the last operation's log in its snapshot.
    const ws2 = new WebSocket(`${server.url.replace("http", "ws")}/api/events`);
    const snap = await new Promise<ServerEvent>((r) => ws2.once("message", (m) => r(JSON.parse(String(m)))));
    ws2.close();
    assert.equal(snap.type, "snapshot");
    if (snap.type === "snapshot") assert.ok(snap.logs.web.some((l) => l.text === "Stopped."));

    s2 = events.length;
    assert.equal((await api("/api/sandboxes/web", { method: "DELETE" })).status, 202);
    assert.equal((await finished("web", "deleting", s2)).type, "done");
    assert.deepEqual(await json(await api("/api/sandboxes")), []);
  });

  it("reports provisioning failures and re-runs them", async () => {
    const marker = join(mountDir, "ok");
    let since = events.length;
    await api("/api/sandboxes", {
      method: "POST",
      body: JSON.stringify({ name: "bad", cpus: 1, memoryGiB: 1, diskGiB: 10, mounts: [], env: [], provision: `test -f ${marker} || exit 3` }),
    });
    const err = await finished("bad", "creating", since);
    assert.equal(err.type, "error");
    let [sb] = (await json(await api("/api/sandboxes"))) as SandboxView[];
    assert.equal(sb.meta?.setup, "provision_failed");
    assert.equal(sb.meta?.provisionExitCode, 3);
    assert.equal(sb.operation?.result, "error");

    await writeFile(marker, "");
    since = events.length;
    assert.equal((await api("/api/sandboxes/bad/provision", { method: "POST" })).status, 202);
    assert.equal((await finished("bad", "provisioning", since)).type, "done");
    [sb] = await json(await api("/api/sandboxes"));
    assert.equal(sb.meta?.setup, "ready");

    since = events.length;
    assert.equal((await api("/api/sandboxes/bad/recreate", { method: "POST" })).status, 202);
    assert.equal((await finished("bad", "recreating", since)).type, "done");
    since = events.length;
    await api("/api/sandboxes/bad", { method: "DELETE" });
    await finished("bad", "deleting", since);
  });

  it("404s unknown sandboxes and ignores foreign ones", async () => {
    assert.equal((await api("/api/sandboxes/nope/start", { method: "POST" })).status, 404);
    // "foreign" would be bm-foreign; wm-foreign can't be addressed at all.
    assert.equal((await api("/api/sandboxes/foreign", { method: "DELETE" })).status, 404);
    assert.equal((await api("/api/sandboxes/Bad!/start", { method: "POST" })).status, 400);
  });

  it("refuses requests from other origins", async () => {
    const res = await api("/api/sandboxes", { headers: { origin: "https://evil.example" } });
    assert.equal(res.status, 403);
    const bad = new WebSocket(`${server.url.replace("http", "ws")}/api/events`, { origin: "https://evil.example" });
    await new Promise<void>((r) => bad.once("error", () => r()));
  });

  it("notices VMs changed outside Bentomo", async () => {
    const since = events.length;
    await writeFile(join(limaDir, "bm-outside.json"), JSON.stringify({ name: "bm-outside", status: "Running" }));
    await waitFor(() => events.slice(since).find((e) => e.type === "list" && e.sandboxes.some((s) => s.name === "outside")));
  });
});
