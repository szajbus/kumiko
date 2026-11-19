import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";
import type { SandboxView, ServerEvent, UnpushedResponse } from "@kumiko/shared";
import { LimaProvider, MetadataStore } from "@kumiko/sandbox";
import { startServer, type RunningServer } from "../src/index.js";
import { sh } from "./repo.js";
import { fakeGitHub, type FakeGitHub } from "./github.js";
import { shortTmp } from "./tmp.js";

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), "../../../sandbox/fixtures");

describe("server", () => {
  let server: RunningServer;
  let root: string;
  let limaDir: string;
  let dataDir: string;
  let mountDir: string;
  let home: string;
  const events: ServerEvent[] = [];
  let ws: WebSocket;
  let github: FakeGitHub;

  before(async () => {
    root = await shortTmp("kumiko-server-test-");
    limaDir = join(root, "lima");
    mountDir = join(root, "mount");
    dataDir = join(root, "data");
    await mkdir(limaDir);
    await mkdir(mountDir);
    home = join(root, "home");
    await mkdir(home);
    await writeFile(join(limaDir, "wm-foreign.json"), JSON.stringify({ name: "wm-foreign", status: "Running" }));
    process.env.FAKE_LIMA_DIR = limaDir;
    process.env.FAKE_LIMA_DELAY = "150";
    github = await fakeGitHub(root);
    await github.repo("acme/widget");
    await github.repo("acme/other");
    process.env.KUMIKO_GITHUB_URL = github.url;
    const env = () => ({ TOKEN: "abc" });
    const provider = new LimaProvider({
      limactl: join(fixtures, "fake-limactl.mjs"),
      ssh: join(fixtures, "fake-ssh.sh"),
      metadata: new MetadataStore(join(dataDir, "sandboxes")),
      env,
    });
    server = await startServer({ provider, port: 0, refreshMs: 200, env, home, dataDir, sessionsDir: join(dataDir, "sessions") });
    ws = new WebSocket(`${server.url.replace("http", "ws")}/api/events`, { headers: { authorization: `Bearer ${server.token}` } });
    ws.on("message", (m) => events.push(JSON.parse(String(m))));
    await new Promise((r) => ws.once("open", r));
  });

  after(async () => {
    ws.close();
    await server.close();
    github.close();
    delete process.env.KUMIKO_GITHUB_URL;
  });

  const api = (path: string, init: RequestInit = {}) =>
    fetch(server.url + path, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${server.token}`, ...init.headers } });
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
  const sandboxList = async (): Promise<SandboxView[]> => json(await api("/api/sandboxes"));
  const sandbox = async (name: string) => (await sandboxList()).find((p) => p.name === name);
  const exists = (p: string) => stat(p).then(() => true, () => false);
  const post = (path: string, body: object) => api(path, { method: "POST", body: JSON.stringify(body) });
  const spec = (over: object = {}) => ({ repos: [], cpus: 1, memoryGiB: 1, diskGiB: 10, workspaceGiB: 1, mounts: [], env: [], ...over });
  const calls = async () => (await readFile(join(limaDir, "calls.log"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);

  /** Creates a sandbox and waits for its VM. */
  const create = async (name: string, over: object = {}) => {
    const since = events.length;
    const res = await post("/api/sandboxes", spec({ name, ...over }));
    assert.equal(res.status, 202, JSON.stringify(await res.clone().json()));
    const done = await finished(name, "creating", since);
    return { done };
  };

  const remove = async (name: string) => {
    const since = events.length;
    assert.equal((await api(`/api/sandboxes/${name}`, { method: "DELETE" })).status, 202);
    assert.equal((await finished(name, "deleting", since)).type, "done");
  };

  it("sends a snapshot first and lists only sandboxes", async () => {
    await waitFor(() => events[0]);
    assert.equal(events[0].type, "snapshot");
    assert.deepEqual(await sandboxList(), []);
  });

  it("serves templates, env presence without values, and the host's home", async () => {
    const t = await json(await api("/api/templates"));
    assert.equal(t.preferred, "template:debian-12");
    const env = await json(await api("/api/env?names=TOKEN,NOPE,bad-name"));
    assert.deepEqual(env, { TOKEN: true, NOPE: false });
    assert.deepEqual(await json(await api("/api/defaults")), { home, claudeHomes: join(dataDir, "claude"), kumikoHomes: join(dataDir, "sandbox") });
  });

  it("keeps the window's tabs in Kumiko's home, refusing what isn't tabs", async () => {
    assert.equal(await json(await api("/api/tabs")), null);
    const tabs = { sessions: ["ab12", "../x", 3, "cd34"], newSessions: ["web", "", "../x", 3], active: "session:ab12", order: ["new-session:0", 3, "session:cd34", "session:ab12"], collapsed: ["web", "../x", 3] };
    assert.equal((await api("/api/tabs", { method: "PUT", body: JSON.stringify(tabs) })).status, 200);
    const kept = { sessions: ["ab12", "cd34"], newSessions: ["web", "", ""], active: "session:ab12", order: ["new-session:0", "session:cd34", "session:ab12"], collapsed: ["web"] };
    assert.deepEqual(await json(await api("/api/tabs")), kept);
    assert.deepEqual(JSON.parse(await readFile(join(dataDir, "tabs.json"), "utf8")), kept);
    for (const bad of ["nope", JSON.stringify({ sessions: "ab12", active: "sandboxes" }), JSON.stringify({ sessions: [] }), JSON.stringify({ sessions: [], active: "sandboxes", order: [] })]) {
      assert.equal((await api("/api/tabs", { method: "PUT", body: bad })).status, 400);
    }
    assert.deepEqual(await json(await api("/api/tabs")), kept);
    // Tabs saved before sandboxes could collapse them come back with none collapsed.
    const { collapsed: _, ...older } = kept;
    assert.equal((await api("/api/tabs", { method: "PUT", body: JSON.stringify(older) })).status, 200);
    assert.deepEqual(await json(await api("/api/tabs")), { ...older, collapsed: [] });
  });

  it("refuses a sandbox it can't create, leaving nothing behind", async () => {
    const refuse = async (body: object, why: RegExp) => {
      const res = await post("/api/sandboxes", spec(body));
      assert.equal(res.status, 400);
      assert.match((await json(res)).details.join("\n"), why);
    };
    await refuse({ name: "-x" }, /Name/);
    await refuse({ name: "x", repos: ["acme/nowhere"] }, /acme\/nowhere has no mirror\. Add it on the Repos page first/);
    await refuse({ name: "x", repos: "acme/widget" }, /must be a list/);
    await refuse({ name: "x", cpus: 0 }, /CPUs/);
    await refuse({ name: "x", workspaceGiB: 0 }, /Workspace disk/);
    await refuse({ name: "x", mounts: [{ hostPath: mountDir, guestPath: "/workspace/data", writable: false }] }, /\/workspace\/data can't be a mount: \/workspace is the sandbox's workspace disk/);
    // The Claude home's place is taken by the sandbox's own mount.
    await refuse({ name: "x", mounts: [{ hostPath: mountDir, guestPath: "~/.claude", writable: false }] }, /overlap/);
    assert.equal(await exists(join(dataDir, "claude", "x")), false, "no Claude home is left behind");
    assert.deepEqual(await sandboxList(), []);
  });

  it("creates a sandbox: seeded Claude home, a workspace disk at /workspace, extra mounts, work in /workspace", async () => {
    const since = events.length;
    const { done } = await create("web", {
      workspaceGiB: 20,
      mounts: [{ hostPath: mountDir, writable: true }],
      env: ["TOKEN", "MISSING"],
      provision: `echo "token=$TOKEN" > ${mountDir}/out`,
    });
    assert.equal(done.type, "done");

    // A creating sandbox shows up before Lima knows its VM, marked busy.
    const listed = events.slice(since).find((e): e is Extract<ServerEvent, { type: "list" }> => e.type === "list" && e.sandboxes.some((s) => s.name === "web" && s.busy));
    assert.equal(listed?.sandboxes.find((s) => s.name === "web")!.operation?.op, "creating");

    const p = (await sandbox("web"))!;
    assert.deepEqual([p.status, p.meta?.setup, p.vm, p.workspaceGiB, p.sandbox.repos, p.repos], ["running", "ready", "kumiko-web", 20, [], []]);

    // The Claude home at ~/.claude, the Kumiko folder at its own path (and ~/.kumiko/shared), then the extra mount; the
    // workspace disk at /workspace.
    const claudeHome = join(dataDir, "claude", "web");
    const kumikoHome = join(dataDir, "sandbox", "web");
    const createCall = (await calls()).find((a) => a[0] === "create" && a.includes("--name=kumiko-web"))!;
    const [mountsSet, disksSet] = createCall.find((a) => a.startsWith("--set="))!.slice("--set=".length).split(" | ");
    assert.deepEqual(JSON.parse(mountsSet.slice(".mounts = ".length)), [
      { location: claudeHome, mountPoint: "{{.Home}}/.claude", writable: true },
      { location: kumikoHome, mountPoint: kumikoHome, writable: true },
      { location: mountDir, mountPoint: mountDir, writable: true },
    ]);
    assert.deepEqual(p.meta?.spec.mounts[1], { hostPath: kumikoHome, guestPath: kumikoHome, writable: true, alias: "~/.kumiko/shared" });
    assert.ok(p.shared?.includes(kumikoHome) && p.shared.includes("~/.kumiko/shared"), "the UI can reveal files from there");
    assert.equal(disksSet, `.additionalDisks = [{"name":"kumiko-web-workspace","format":true,"fsType":"ext4","mountPoint":"/workspace"}]`);
    assert.equal(p.meta?.spec.workdir, "/workspace", "provisioning and sessions start in /workspace");
    assert.equal((await readFile(join(mountDir, "out"), "utf8")).trim(), "token=abc");

    // The Claude home: the user's CLAUDE.md from the app-level template, importing Kumiko's own file.
    assert.match(await readFile(join(claudeHome, "CLAUDE.md"), "utf8"), /^@kumiko\.md\n/);
    assert.match(await readFile(join(dataDir, "claude-template", "CLAUDE.md"), "utf8"), /^@kumiko\.md\n/);
    const managed = await readFile(join(claudeHome, "kumiko.md"), "utf8");
    assert.match(managed, /This is the sandbox web\. Sessions start in `\/workspace`/);
    assert.ok(managed.includes(`\`${mountDir}\``), "the extra mount is named as shared with the user");

    const taken = await post("/api/sandboxes", spec({ name: "web" }));
    assert.match((await json(taken)).details.join(), /already a sandbox called web/);

    // Stopped, a new client gets the last operation's log in its snapshot.
    let s2 = events.length;
    assert.equal((await api("/api/sandboxes/web/stop", { method: "POST" })).status, 202);
    assert.equal((await finished("web", "stopping", s2)).type, "done");
    assert.equal((await sandbox("web"))?.status, "stopped");
    const ws2 = new WebSocket(`${server.url.replace("http", "ws")}/api/events`, { headers: { authorization: `Bearer ${server.token}` } });
    const snap = await new Promise<ServerEvent>((r) => ws2.once("message", (m) => r(JSON.parse(String(m)))));
    ws2.close();
    assert.ok(snap.type === "snapshot" && snap.logs.web.some((l) => l.text === "Stopped."));

    // Kumiko's file is rewritten on start; the user's CLAUDE.md is theirs.
    await writeFile(join(claudeHome, "CLAUDE.md"), "mine\n");
    await writeFile(join(claudeHome, "kumiko.md"), "stale\n");
    s2 = events.length;
    assert.equal((await api("/api/sandboxes/web/start", { method: "POST" })).status, 202);
    assert.equal((await finished("web", "starting", s2)).type, "done");
    assert.equal(await readFile(join(claudeHome, "kumiko.md"), "utf8"), managed);
    assert.equal(await readFile(join(claudeHome, "CLAUDE.md"), "utf8"), "mine\n");

    // Deleting removes the VM, its workspace disk, the Claude home and the Kumiko folder.
    await remove("web");
    assert.deepEqual(await sandboxList(), []);
    assert.equal(await exists(claudeHome), false);
    assert.equal(await exists(kumikoHome), false);
    assert.deepEqual((await calls()).filter((c) => c[0] === "disk" && c[1] === "delete").at(-1), ["disk", "delete", "kumiko-web-workspace"]);
  });

  it("reports provisioning failures and rebuilds with a fixed script, keeping the workspace disk", async () => {
    const marker = join(mountDir, "ok");
    const { done } = await create("bad", { provision: `test -f ${marker} || exit 3` });
    assert.equal(done.type, "error");
    let p = (await sandbox("bad"))!;
    assert.deepEqual([p.meta?.setup, p.meta?.provisionExitCode, p.operation?.result], ["provision_failed", 3, "error"]);

    // A running VM can't take new resources in place, but a rebuild can.
    const patch = JSON.stringify({ cpus: 2, provision: "echo fixed" });
    assert.equal((await api("/api/sandboxes/bad", { method: "PATCH", body: patch })).status, 400);
    let since = events.length;
    assert.equal((await api("/api/sandboxes/bad?recreate=1", { method: "PATCH", body: patch })).status, 202);
    assert.equal((await finished("bad", "recreating", since)).type, "done");
    p = (await sandbox("bad"))!;
    assert.deepEqual([p.meta?.setup, p.cpus, p.meta?.spec.provision, p.meta?.spec.mounts.length, p.workspaceGiB], ["ready", 2, "echo fixed", 2, 1]);

    since = events.length;
    assert.equal((await api("/api/sandboxes/bad/recreate", { method: "POST" })).status, 202);
    assert.equal((await finished("bad", "recreating", since)).type, "done");
    const disks = (await calls()).filter((c) => c[0] === "disk" && c[2] === "kumiko-bad-workspace").map((c) => c[1]);
    assert.deepEqual(disks, ["create"], "the disk was made once and kept through both rebuilds");
    await remove("bad");
  });

  it("rebuilds from scratch: the workspace disk goes, and a new one is made", async () => {
    await create("fresh");
    const since = events.length;
    assert.equal((await api("/api/sandboxes/fresh/recreate?wipe=1", { method: "POST" })).status, 202);
    assert.equal((await finished("fresh", "recreating", since)).type, "done");
    const disks = (await calls()).filter((c) => c[0] === "disk" && c[2] === "kumiko-fresh-workspace").map((c) => c[1]);
    assert.deepEqual(disks, ["create", "delete", "create"]);
    assert.equal((await sandbox("fresh"))?.status, "running");
    await remove("fresh");
  });

  it("recreates a VM with the agent's setup scripts from its Kumiko folder", async () => {
    await create("agent");
    const dir = join(dataDir, "sandbox", "agent", "provision.d");
    const marker = join(mountDir, "agent-ran");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "10-a.sh"), `echo a >> ${marker}\n`);
    await writeFile(join(dir, "20-b.sh"), "exit 7\n");
    let setup = await json(await api("/api/sandboxes/agent/agent-setup"));
    assert.deepEqual(setup.scripts.map((s: { file: string; exitCode?: number }) => [s.file, s.exitCode]), [["10-a.sh", undefined], ["20-b.sh", undefined]]);

    let since = events.length;
    assert.equal((await api("/api/sandboxes/agent/recreate", { method: "POST" })).status, 202);
    assert.equal((await finished("agent", "recreating", since)).type, "done", "a failed agent script doesn't fail the recreate");
    assert.equal(await readFile(marker, "utf8"), "a\n");
    const p = (await sandbox("agent"))!;
    assert.equal(p.meta?.setup, "ready");
    assert.deepEqual(p.meta?.agentSetup?.scripts.map((s) => [s.file, s.exitCode]), [["10-a.sh", 0], ["20-b.sh", 7]]);

    await writeFile(join(dir, "20-b.sh"), "true\n");
    setup = await json(await api("/api/sandboxes/agent/agent-setup"));
    assert.deepEqual(setup.scripts.map((s: { exitCode?: number }) => s.exitCode), [0, undefined], "a script changed since hasn't run in this VM");

    since = events.length;
    assert.equal((await api("/api/sandboxes/agent?recreate=1", { method: "PATCH", body: JSON.stringify({ cpus: 2 }) })).status, 202);
    assert.equal((await finished("agent", "recreating", since)).type, "done");
    assert.equal(await readFile(marker, "utf8"), "a\na\n");
    assert.deepEqual((await sandbox("agent"))!.meta?.agentSetup?.scripts.map((s) => s.exitCode), [0, 0]);

    // Deleting them leaves the next VM with the user's setup only.
    assert.equal((await api("/api/sandboxes/agent/agent-setup", { method: "DELETE" })).status, 200);
    assert.equal(await exists(dir), false);
    assert.deepEqual(await json(await api("/api/sandboxes/agent/agent-setup")), { scripts: [], ignored: [] });
    since = events.length;
    assert.equal((await api("/api/sandboxes/agent/recreate", { method: "POST" })).status, 202);
    assert.equal((await finished("agent", "recreating", since)).type, "done");
    assert.equal(await readFile(marker, "utf8"), "a\na\n");
    assert.equal((await sandbox("agent"))!.meta?.agentSetup, undefined);
    await remove("agent");
  });

  it("edits a sandbox's VM: variables while running, resources, the workspace disk and extra mounts once stopped", async () => {
    await create("ed");
    const running = await api("/api/sandboxes/ed", { method: "PATCH", body: JSON.stringify({ cpus: 2 }) });
    assert.equal(running.status, 400);
    assert.match((await json(running)).details.join(), /Stop kumiko-ed/);

    let since = events.length;
    assert.equal((await api("/api/sandboxes/ed", { method: "PATCH", body: JSON.stringify({ env: ["TOKEN"], workdir: "/elsewhere" }) })).status, 202);
    assert.equal((await finished("ed", "editing", since)).type, "done");
    assert.equal((await sandbox("ed"))?.meta?.spec.workdir, "/workspace", "the working directory stays /workspace");

    since = events.length;
    await api("/api/sandboxes/ed/stop", { method: "POST" });
    await finished("ed", "stopping", since);
    since = events.length;
    const extra = { hostPath: mountDir, guestPath: "/data", writable: false };
    assert.equal((await api("/api/sandboxes/ed", { method: "PATCH", body: JSON.stringify({ cpus: 3, diskGiB: 12, workspaceGiB: 4, mounts: [extra] }) })).status, 202);
    assert.equal((await finished("ed", "editing", since)).type, "done");
    const p = (await sandbox("ed"))!;
    assert.deepEqual([p.cpus, p.diskGiB, p.workspaceGiB, p.meta?.spec.env], [3, 12, 4, ["TOKEN"]]);
    // Only extra mounts are the user's: the sandbox's own come back whatever is sent.
    assert.deepEqual(p.meta?.spec.mounts.map((m) => m.guestPath), ["~/.claude", join(dataDir, "sandbox", "ed"), "/data"]);
    const shrink = await api("/api/sandboxes/ed", { method: "PATCH", body: JSON.stringify({ workspaceGiB: 2 }) });
    assert.match((await json(shrink)).details.join(), /The workspace disk can only grow; it is 4 GiB now/);

    assert.equal((await api("/api/sandboxes/nope", { method: "PATCH", body: "{}" })).status, 404);
    await remove("ed");
  });

  it("moves the Kumiko folder of a VM made before to its own path when it starts, unless a mount is in the way", async () => {
    await create("old");
    let since = events.length;
    await api("/api/sandboxes/old/stop", { method: "POST" });
    await finished("old", "stopping", since);
    // As Kumiko recorded a sandbox before: the Kumiko folder at ~/.kumiko/shared.
    const kumikoHome = join(dataDir, "sandbox", "old");
    const file = join(dataDir, "sandboxes", "old.json");
    const meta = JSON.parse(await readFile(file, "utf8"));
    meta.spec.mounts[1] = { hostPath: kumikoHome, guestPath: "~/.kumiko/shared", writable: true };
    await writeFile(file, JSON.stringify(meta));
    since = events.length;
    await api("/api/sandboxes/old/start", { method: "POST" });
    assert.equal((await finished("old", "starting", since)).type, "done");
    const edit = (await calls()).findLast((a) => a[0] === "edit" && a.includes("kumiko-old"));
    assert.ok(edit?.some((a) => a.includes(`"mountPoint":${JSON.stringify(kumikoHome)}`)), JSON.stringify(edit));
    assert.deepEqual((await sandbox("old"))?.meta?.spec.mounts[1], { hostPath: kumikoHome, guestPath: kumikoHome, writable: true, alias: "~/.kumiko/shared" });
    const managed = await readFile(join(dataDir, "claude", "old", "kumiko.md"), "utf8");
    assert.ok(managed.includes(`setup script in \`${kumikoHome}/provision.d/\``), "the agent is told the new path");

    // A mount of a folder holding it, at its own path, is in the way: the Kumiko folder stays at ~/.kumiko/shared,
    // and the agent is told so.
    since = events.length;
    await api("/api/sandboxes/old/stop", { method: "POST" });
    await finished("old", "stopping", since);
    since = events.length;
    const holding = { hostPath: dataDir, writable: false };
    assert.equal((await api("/api/sandboxes/old", { method: "PATCH", body: JSON.stringify({ mounts: [holding] }) })).status, 202);
    assert.equal((await finished("old", "editing", since)).type, "done");
    assert.deepEqual((await sandbox("old"))?.meta?.spec.mounts.map((m) => m.guestPath), ["~/.claude", "~/.kumiko/shared", dataDir]);
    await remove("old");
  });

  it("restarts a sandbox's VM, saving resources and mounts while it is down", async () => {
    await create("rs");
    let since = events.length;
    assert.equal((await api("/api/sandboxes/rs/restart", { method: "POST" })).status, 202);
    assert.equal((await finished("rs", "restarting", since)).type, "done");
    assert.equal((await sandbox("rs"))?.status, "running");

    // A running VM can't take new resources in place, but a restart can, and it comes back running with them.
    since = events.length;
    const patch = JSON.stringify({ cpus: 3, mounts: [{ hostPath: mountDir, guestPath: "/data", writable: false }] });
    assert.equal((await api("/api/sandboxes/rs?restart=1", { method: "PATCH", body: patch })).status, 202);
    assert.equal((await finished("rs", "restarting", since)).type, "done");
    const p = (await sandbox("rs"))!;
    assert.deepEqual([p.status, p.cpus, p.meta?.spec.mounts.at(-1)?.guestPath], ["running", 3, "/data"]);
    // Disk still can't shrink.
    assert.equal((await api("/api/sandboxes/rs?restart=1", { method: "PATCH", body: JSON.stringify({ diskGiB: 1 }) })).status, 400);
    await remove("rs");
  });

  it("shows a sandbox whose VM is missing, and rebuilds it", async () => {
    process.env.FAKE_LIMA_FAIL_CREATE = "1";
    let created;
    try {
      created = await create("gone");
    } finally {
      delete process.env.FAKE_LIMA_FAIL_CREATE;
    }
    assert.equal(created.done.type, "error");
    assert.equal((await sandbox("gone"))?.status, "absent");
    assert.equal((await api("/api/sandboxes/gone/start", { method: "POST" })).status, 409);
    const since = events.length;
    assert.equal((await api("/api/sandboxes/gone/recreate", { method: "POST" })).status, 202);
    assert.equal((await finished("gone", "recreating", since)).type, "done");
    assert.equal((await sandbox("gone"))?.status, "running");
    await remove("gone");
  });

  it("lets only one of two creates racing for a name through", async () => {
    const since = events.length;
    const results = await Promise.all([1, 2].map((cpus) => post("/api/sandboxes", spec({ name: "race", cpus }))));
    assert.ok(results.some((r) => r.status === 202) && results.some((r) => r.status === 400 || r.status === 409), results.map((r) => r.status).join());
    await finished("race", "creating", since);
    assert.ok(await exists(join(dataDir, "claude", "race")), "the loser didn't take the winner's Claude home with it");
    await remove("race");
  });

  it("reports a sandbox record it can't read instead of hiding it", async () => {
    const file = join(dataDir, "workspaces", "broken.json");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "{ not json");
    const since = events.length;
    const listed = await waitFor(() => events.slice(since).find((e) => e.type === "list" && e.unreadable.length > 0));
    assert.ok(listed.type === "list");
    assert.match(listed.unreadable.join("\n"), /broken\.json, can't be read \(not valid JSON\)/);
    assert.ok(!(await sandboxList()).some((p) => p.name === "broken"));
    // It still holds the name, and asking for it says why it can't be used.
    const res = await api("/api/sandboxes/broken/agent-setup");
    assert.equal(res.status, 409);
    assert.match((await json(res)).error, /not valid JSON/);
    const taken = await post("/api/sandboxes", spec({ name: "broken" }));
    assert.match((await json(taken)).details.join(), /already a sandbox called broken/);
    await rm(file);
    await waitFor(() => events.slice(since).find((e) => e.type === "list" && e.unreadable.length === 0));
  });

  it("404s unknown sandboxes and 400s bad names", async () => {
    assert.equal((await api("/api/sandboxes/nope/start", { method: "POST" })).status, 404);
    assert.equal((await api("/api/sandboxes/nope/agent-setup")).status, 404);
    assert.equal((await api("/api/sandboxes/foreign", { method: "DELETE" })).status, 404);
    assert.equal((await api("/api/sandboxes/Bad!/start", { method: "POST" })).status, 400);
  });

  it("refuses requests from other origins", async () => {
    const res = await api("/api/sandboxes", { headers: { origin: "https://evil.example" } });
    assert.equal(res.status, 403);
    const bad = new WebSocket(`${server.url.replace("http", "ws")}/api/events`, { headers: { authorization: `Bearer ${server.token}` }, origin: "https://evil.example" });
    await new Promise<void>((r) => bad.once("error", () => r()));

    // Pages served from this machine on another port, such as a sandbox's dev server in a preview pane, too.
    const port = new URL(server.url).port;
    assert.equal((await api("/api/sandboxes", { headers: { origin: "http://localhost:5173" } })).status, 403);
    assert.equal((await api("/api/sandboxes", { headers: { origin: "http://127.0.0.1:5173" } })).status, 403);
    assert.equal((await api("/api/sandboxes", { headers: { origin: "null" } })).status, 403);
    const local = new WebSocket(`${server.url.replace("http", "ws")}/api/events`, { headers: { authorization: `Bearer ${server.token}` }, origin: "http://localhost:5173" });
    await new Promise<void>((r) => local.once("error", () => r()));
    // Its own pages, from either name for this machine.
    assert.equal((await api("/api/sandboxes", { headers: { origin: `http://localhost:${port}` } })).status, 200);
    assert.equal((await api("/api/sandboxes", { headers: { origin: `http://127.0.0.1:${port}` } })).status, 200);
  });

  it("refuses requests without the server's token, which a sandbox can't learn", async () => {
    // What an agent in a VM can send through Lima's host address: local Host, no Origin.
    const bare = (headers: Record<string, string> = {}) => fetch(`${server.url}/api/sandboxes`, { headers });
    assert.equal((await bare()).status, 403);
    assert.equal((await bare({ authorization: "Bearer nope" })).status, 403);
    assert.equal((await bare({ authorization: `Bearer ${server.token}x` })).status, 403);
    assert.equal((await bare({ cookie: `kumiko-${server.port}=nope` })).status, 403);
    const sock = new WebSocket(`${server.url.replace("http", "ws")}/api/events`);
    await new Promise<void>((r) => sock.once("error", () => r()));

    // Signing in sets the cookie and leaves the token's address behind; a wrong token doesn't.
    assert.equal((await fetch(`${server.url}/api/login?token=nope`, { redirect: "manual" })).status, 403);
    const login = await fetch(server.loginUrl, { redirect: "manual" });
    assert.equal(login.status, 302);
    assert.equal(login.headers.get("location"), "/");
    const cookie = login.headers.get("set-cookie") ?? "";
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.equal((await bare({ cookie: `other=1; ${cookie.split(";")[0]}` })).status, 200);
    const signedIn = new WebSocket(`${server.url.replace("http", "ws")}/api/events`, { headers: { cookie: cookie.split(";")[0] } });
    await new Promise<void>((r, j) => (signedIn.once("open", () => r()), signedIn.once("error", j)));
    signedIn.close();
  });

  it("notices a sandbox's VM changing outside Kumiko, and ignores VMs that aren't sandboxes'", async () => {
    await create("outside");
    await writeFile(join(limaDir, "kumiko-stray.json"), JSON.stringify({ name: "kumiko-stray", status: "Running" }));
    const since = events.length;
    await writeFile(join(limaDir, "kumiko-outside.json"), JSON.stringify({ name: "kumiko-outside", status: "Stopped" }));
    await waitFor(() => events.slice(since).find((e) => e.type === "list" && e.sandboxes.some((s) => s.name === "outside" && s.status === "stopped")));
    assert.ok(!(await sandboxList()).some((p) => p.name === "stray"));
    await remove("outside");
  });

  const waitAsync = async (fn: () => Promise<unknown>, ms = 10000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  it("clones a sandbox's repos in the VM through the relay, into their folders, with origin on GitHub", async () => {
    for (const repo of ["acme/widget", "acme/other"]) assert.equal((await post("/api/mirrors", { repo })).status, 201);
    await waitAsync(async () => ((await json(await api("/api/mirrors"))).mirrors as { state: string }[]).every((m) => m.state === "ready") || undefined, 20_000);
    await create("gh", { repos: ["acme/widget"] });
    const cloned = await waitAsync(async () => (await sandbox("gh"))?.repos[0]?.state === "cloned" || undefined, 30_000).catch(() => undefined);
    assert.ok(cloned, JSON.stringify((await sandbox("gh"))?.repos));
    assert.deepEqual((await sandbox("gh"))!.repos, [{ repo: "acme/widget", folder: "widget", state: "cloned" }]);
    // The fake VM's /workspace.
    const workspace = join(limaDir, "workspace");
    assert.equal(sh(join(workspace, "widget"), "remote", "get-url", "origin").trim(), "git@github.com:acme/widget.git", "origin keeps GitHub's URL");
    assert.ok(await exists(join(workspace, "widget", "README")), "the code came from the mirror");
    assert.ok((await stat(join(workspace, "widget__worktrees"))).isDirectory());

    // Adding a repo while it runs: kumiko.md lists it, the relay serves its mirror too, and it is cloned.
    const res = await api("/api/sandboxes/gh", { method: "PATCH", body: JSON.stringify({ repos: ["acme/widget", "acme/other"] }) });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    assert.match(await readFile(join(dataDir, "claude", "gh", "kumiko.md"), "utf8"), /`\/workspace\/other`: `acme\/other` on GitHub/);
    await waitAsync(async () => (await sandbox("gh"))?.repos.every((r) => r.state === "cloned") || undefined, 30_000);
    assert.ok(await exists(join(workspace, "other", "README")));

    // What isn't pushed is found in the VM: a branch on no remote, and a change in a worktree.
    sh(join(workspace, "other"), "checkout", "--quiet", "-b", "spike");
    await writeFile(join(workspace, "other", "new.txt"), "x");
    const unpushed = (await json(await api("/api/sandboxes/gh/unpushed"))) as UnpushedResponse;
    const other = unpushed.repos.find((r) => r.repo === "acme/other")!;
    assert.deepEqual(other.dirty.map((d) => d.files), [1]);
    assert.deepEqual(unpushed.repos.find((r) => r.repo === "acme/widget")!.dirty, []);

    // A repo the sandbox has stays editable after its mirror is removed: only a newcomer needs a mirror.
    assert.equal((await api("/api/mirrors/acme/other", { method: "DELETE" })).status, 200);
    const keeping = await api("/api/sandboxes/gh", { method: "PATCH", body: JSON.stringify({ repos: ["acme/widget", "acme/other"] }) });
    assert.equal(keeping.status, 200, JSON.stringify(await keeping.clone().json()));

    // Taking one out while it runs deletes its folders at once, and its mirror isn't served any more.
    const removing = await api("/api/sandboxes/gh", { method: "PATCH", body: JSON.stringify({ repos: ["acme/widget"] }) });
    assert.equal(removing.status, 200, JSON.stringify(await removing.clone().json()));
    assert.equal(await exists(join(workspace, "other")), false);
    assert.equal(await exists(join(workspace, "other__worktrees")), false);
    assert.deepEqual((await sandbox("gh"))!.sandbox.repos, [{ repo: "acme/widget", folder: "widget" }]);
    assert.equal((await sandbox("gh"))!.sandbox.dropped, undefined);
    assert.doesNotMatch(await readFile(join(dataDir, "claude", "gh", "kumiko.md"), "utf8"), /acme\/other/);

    // Stopped, nothing is known of its clones until it runs again, and the VM can't be asked what isn't pushed.
    let at = events.length;
    assert.equal((await api("/api/sandboxes/gh/stop", { method: "POST" })).status, 202);
    await finished("gh", "stopping", at);
    await waitAsync(async () => (await sandbox("gh"))?.repos.every((r) => r.state === "pending") || undefined);
    assert.match((await json(await api("/api/sandboxes/gh/unpushed"))).error, /not running, so Kumiko can't see what isn't pushed/);

    // Taken out while stopped, a repo's folder goes when the sandbox next starts, and no new repo gets its name meanwhile.
    assert.equal((await api("/api/sandboxes/gh", { method: "PATCH", body: JSON.stringify({ repos: [] }) })).status, 200);
    assert.deepEqual((await sandbox("gh"))!.sandbox.dropped, ["widget"]);
    assert.ok(await exists(join(workspace, "widget")));
    at = events.length;
    assert.equal((await api("/api/sandboxes/gh/start", { method: "POST" })).status, 202);
    assert.equal((await finished("gh", "starting", at)).type, "done");
    assert.equal(await exists(join(workspace, "widget")), false);
    assert.equal((await sandbox("gh"))!.sandbox.dropped, undefined);

    // Taken out while stopped and rebuilt, it goes once the new VM is up: a rebuild runs the VM without a start.
    assert.equal((await api("/api/sandboxes/gh", { method: "PATCH", body: JSON.stringify({ repos: ["acme/widget"] }) })).status, 200);
    await waitAsync(async () => (await sandbox("gh"))?.repos.every((r) => r.state === "cloned") || undefined, 30_000);
    at = events.length;
    assert.equal((await api("/api/sandboxes/gh/stop", { method: "POST" })).status, 202);
    await finished("gh", "stopping", at);
    at = events.length;
    assert.equal((await api("/api/sandboxes/gh?recreate=1", { method: "PATCH", body: JSON.stringify({ repos: [] }) })).status, 202);
    assert.equal((await finished("gh", "recreating", at)).type, "done");
    assert.equal(await exists(join(workspace, "widget")), false);
    assert.equal((await sandbox("gh"))!.sandbox.dropped, undefined);
    await remove("gh");
    await rm(workspace, { recursive: true, force: true });
  });

  it("says why a repo couldn't be cloned, and leaves the folder in the way alone", async () => {
    const workspace = join(limaDir, "workspace");
    await mkdir(join(workspace, "widget"), { recursive: true });
    await writeFile(join(workspace, "widget", "mine.txt"), "keep");
    await create("clash", { repos: ["acme/widget"] });
    const failed = await waitAsync(async () => {
      const r = (await sandbox("clash"))?.repos[0];
      return r?.state === "failed" ? r : undefined;
    }, 30_000);
    assert.match((failed as { error: string }).error, /\/workspace\/widget is there already, and isn't a git clone/);
    assert.equal(await readFile(join(workspace, "widget", "mine.txt"), "utf8"), "keep");
    await remove("clash");
    await rm(workspace, { recursive: true, force: true });
  });
});

describe("server errors", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = (r: Response): Promise<any> => r.json();
  it("answers in JSON when a route fails unexpectedly or gets a bad body", async () => {
    const root = await mkdtemp(join(tmpdir(), "kumiko-server-errors-"));
    const provider = new LimaProvider({ limactl: join(fixtures, "fake-limactl.mjs"), metadata: new MetadataStore(join(root, "sandboxes")) });
    provider.templates = async () => {
      throw new Error("limactl exploded");
    };
    process.env.FAKE_LIMA_DIR = join(root, "lima");
    await mkdir(process.env.FAKE_LIMA_DIR);
    const server = await startServer({ provider, port: 0, dataDir: root, sessionsDir: join(root, "sessions") });
    try {
      const templates = await fetch(`${server.url}/api/templates`, { headers: { authorization: `Bearer ${server.token}` } });
      assert.equal(templates.status, 500);
      assert.deepEqual(await json(templates), { error: "limactl exploded" });

      const bad = await fetch(`${server.url}/api/sandboxes`, { method: "POST", headers: { authorization: `Bearer ${server.token}` }, body: "{nope" });
      assert.equal(bad.status, 400);
      assert.match((await json(bad)).error, /Body must be JSON/);

      // A body bigger than any request needs isn't read at all.
      const huge = await fetch(`${server.url}/api/sandboxes`, { method: "POST", headers: { authorization: `Bearer ${server.token}` }, body: JSON.stringify({ name: "x".repeat(40 * 1024 * 1024) }) });
      assert.equal(huge.status, 413);
      assert.match((await json(huge)).error, /Too big/);
    } finally {
      await server.close();
    }
  });
});

describe("web UI", () => {
  it("serves files, falls back to index.html, and 404s malformed paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "kumiko-web-"));
    const web = join(root, "web");
    await mkdir(join(web, "assets"), { recursive: true });
    await writeFile(join(web, "index.html"), "<p>app</p>");
    await writeFile(join(web, "assets", "a.js"), "1");
    process.env.FAKE_LIMA_DIR = join(root, "lima");
    await mkdir(process.env.FAKE_LIMA_DIR);
    const provider = new LimaProvider({ limactl: join(fixtures, "fake-limactl.mjs"), metadata: new MetadataStore(join(root, "sandboxes")) });
    const server = await startServer({ provider, port: 0, webDir: web, dataDir: root, sessionsDir: join(root, "sessions") });
    try {
      const asset = await fetch(`${server.url}/assets/a.js`);
      assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
      assert.equal(await asset.text(), "1");
      assert.equal(await (await fetch(`${server.url}/sandbox/x`)).text(), "<p>app</p>");
      assert.equal((await fetch(`${server.url}/%E0%A4%A`)).status, 404);
    } finally {
      await server.close();
    }
  });

});
