import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";
import type { ProjectView, ServerEvent, WorktreesResponse } from "@kumiko/shared";
import { LimaProvider, MetadataStore } from "@kumiko/sandbox";
import { startServer, type RunningServer } from "../src/index.js";
import { makeClone, sh } from "./repo.js";

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

  before(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "kumiko-server-test-")));
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
  const projects = async (): Promise<ProjectView[]> => json(await api("/api/projects"));
  const project = async (id: string) => (await projects()).find((p) => p.name === id);
  const exists = (p: string) => stat(p).then(() => true, () => false);
  const post = (path: string, body: object) => api(path, { method: "POST", body: JSON.stringify(body) });
  const spec = (over: object = {}) => ({ cpus: 1, memoryGiB: 1, diskGiB: 10, mounts: [], env: [], ...over });

  /** Creates a project from a fresh clone and waits for its VM. */
  const create = async (id: string, over: object = {}) => {
    const clone = await makeClone(root, `repo-${id}`);
    const since = events.length;
    const res = await post("/api/projects", spec({ name: id, clonePath: clone, ...over }));
    assert.equal(res.status, 202, JSON.stringify(await res.clone().json()));
    const done = await finished(id, "creating", since);
    return { clone, done };
  };

  const remove = async (id: string) => {
    const since = events.length;
    assert.equal((await api(`/api/projects/${id}`, { method: "DELETE" })).status, 202);
    assert.equal((await finished(id, "deleting", since)).type, "done");
  };

  it("sends a snapshot first and lists only projects", async () => {
    await waitFor(() => events[0]);
    assert.equal(events[0].type, "snapshot");
    assert.deepEqual(await projects(), []);
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
    const tabs = { sessions: ["ab12", "../x", 3, "cd34"], newSessions: ["web", "", "../x", 3], active: "session:ab12", order: ["new-session:0", 3, "session:cd34", "session:ab12"] };
    assert.equal((await api("/api/tabs", { method: "PUT", body: JSON.stringify(tabs) })).status, 200);
    const kept = { sessions: ["ab12", "cd34"], newSessions: ["web", "", ""], active: "session:ab12", order: ["new-session:0", "session:cd34", "session:ab12"] };
    assert.deepEqual(await json(await api("/api/tabs")), kept);
    assert.deepEqual(JSON.parse(await readFile(join(dataDir, "tabs.json"), "utf8")), kept);
    for (const bad of ["nope", JSON.stringify({ sessions: "ab12", active: "projects" }), JSON.stringify({ sessions: [] })]) {
      assert.equal((await api("/api/tabs", { method: "PUT", body: bad })).status, 400);
    }
    assert.deepEqual(await json(await api("/api/tabs")), kept);
    // Saved before there could be more than one New session tab.
    const single = { sessions: [], newSession: true, active: "projects" };
    assert.equal((await api("/api/tabs", { method: "PUT", body: JSON.stringify(single) })).status, 200);
    assert.deepEqual(await json(await api("/api/tabs")), { sessions: [], newSessions: [""], active: "projects", order: [] });
  });

  it("refuses what can't be a project's clone, leaving nothing behind", async () => {
    const clone = await makeClone(root, "refused");
    const refuse = async (body: object, why: RegExp) => {
      const res = await post("/api/projects", spec(body));
      assert.equal(res.status, 400);
      assert.match((await json(res)).details.join("\n"), why);
    };
    await refuse({ name: "-x", clonePath: clone }, /Name/);
    await refuse({ name: "x", clonePath: mountDir }, /not a git repository/);
    await refuse({ name: "x", clonePath: join(root, "nope") }, /does not exist/);
    await refuse({ name: "x", clonePath: "relative/path" }, /absolute/);
    await refuse({ name: "x", clonePath: join(clone, "sub") }, /does not exist/);
    await mkdir(join(clone, "sub"));
    await refuse({ name: "x", clonePath: join(clone, "sub") }, /pick its top folder/);
    sh(clone, "worktree", "add", "--quiet", join(root, "linked"), "-b", "linked");
    await refuse({ name: "x", clonePath: join(root, "linked") }, /worktree of another clone/);
    await refuse({ name: "x", clonePath: clone, cpus: 0 }, /CPUs/);
    await writeFile(clone + "__worktrees", "in the way");
    await refuse({ name: "x", clonePath: clone }, /isn't a folder/);
    await rm(clone + "__worktrees");
    // An extra mount that can't be checked until the project's own mounts exist: everything made is undone.
    await refuse({ name: "x", clonePath: clone, mounts: [{ hostPath: mountDir, guestPath: "~/.claude", writable: false }] }, /overlap/);
    assert.equal(await exists(clone + "__worktrees"), false, "the worktrees folder Kumiko made is gone again");
    assert.equal(await exists(join(dataDir, "claude", "x")), false);
    assert.deepEqual(await projects(), []);
  });

  it("creates a project: worktrees folder, seeded Claude home, same-path mounts, work in the clone", async () => {
    const since = events.length;
    const { clone, done } = await create("web", {
      mounts: [{ hostPath: mountDir, writable: true }],
      env: ["TOKEN", "MISSING"],
      provision: `pwd > ${mountDir}/where; echo "token=$TOKEN" > ${mountDir}/out`,
    });
    assert.equal(done.type, "done");

    // A creating project shows up before Lima knows its VM, marked busy.
    const listed = events.slice(since).find((e): e is Extract<ServerEvent, { type: "list" }> => e.type === "list" && e.projects.some((s) => s.name === "web" && s.busy));
    assert.equal(listed?.projects.find((s) => s.name === "web")!.operation?.op, "creating");

    const p = (await project("web"))!;
    assert.deepEqual([p.status, p.meta?.setup, p.vm, p.project.clonePath, p.project.worktreesPath], ["running", "ready", "km-web", clone, clone + "__worktrees"]);
    assert.ok((await stat(clone + "__worktrees")).isDirectory());

    // The clone and its worktrees at the same paths in the VM, the Claude home at ~/.claude, the Kumiko folder at
    // ~/.kumiko/shared, then the extra mount.
    const claudeHome = join(dataDir, "claude", "web");
    const kumikoHome = join(dataDir, "sandbox", "web");
    const createCall = (await readFile(join(limaDir, "calls.log"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]).find((a) => a[0] === "create" && a.includes("--name=km-web"))!;
    const mounts = JSON.parse(createCall.find((a) => a.startsWith("--set=.mounts = "))!.slice("--set=.mounts = ".length));
    assert.deepEqual(mounts, [
      { location: clone, mountPoint: clone, writable: true },
      { location: clone + "__worktrees", mountPoint: clone + "__worktrees", writable: true },
      { location: claudeHome, mountPoint: "{{.Home}}/.claude", writable: true },
      { location: kumikoHome, mountPoint: "{{.Home}}/.kumiko/shared", writable: true },
      { location: mountDir, mountPoint: mountDir, writable: true },
    ]);
    assert.equal(p.meta?.spec.workdir, clone, "provisioning and sessions start in the clone");
    assert.equal((await readFile(join(mountDir, "where"), "utf8")).trim(), clone);
    assert.equal((await readFile(join(mountDir, "out"), "utf8")).trim(), "token=abc");

    // The Claude home: the user's CLAUDE.md from the app-level template, importing Kumiko's own file.
    assert.match(await readFile(join(claudeHome, "CLAUDE.md"), "utf8"), /^@kumiko\.md\n/);
    assert.match(await readFile(join(dataDir, "claude-template", "CLAUDE.md"), "utf8"), /^@kumiko\.md\n/);
    const managed = await readFile(join(claudeHome, "kumiko.md"), "utf8");
    assert.ok(managed.includes(`git worktree add "${clone}__worktrees/<branch>" -b <branch>`), managed);

    // The same clone can't be a second project, nor the same name.
    const again = await post("/api/projects", spec({ name: "other", clonePath: clone }));
    assert.match((await json(again)).details.join(), /already the project web/);
    const taken = await post("/api/projects", spec({ name: "web", clonePath: await makeClone(root, "another") }));
    assert.match((await json(taken)).details.join(), /already a project called web/);

    // Stopped, a new client gets the last operation's log in its snapshot.
    let s2 = events.length;
    assert.equal((await api("/api/projects/web/stop", { method: "POST" })).status, 202);
    assert.equal((await finished("web", "stopping", s2)).type, "done");
    assert.equal((await project("web"))?.status, "stopped");
    const ws2 = new WebSocket(`${server.url.replace("http", "ws")}/api/events`, { headers: { authorization: `Bearer ${server.token}` } });
    const snap = await new Promise<ServerEvent>((r) => ws2.once("message", (m) => r(JSON.parse(String(m)))));
    ws2.close();
    assert.ok(snap.type === "snapshot" && snap.logs.web.some((l) => l.text === "Stopped."));

    // Kumiko's file is rewritten on start; the user's CLAUDE.md is theirs.
    await writeFile(join(claudeHome, "CLAUDE.md"), "mine\n");
    await writeFile(join(claudeHome, "kumiko.md"), "stale\n");
    s2 = events.length;
    assert.equal((await api("/api/projects/web/start", { method: "POST" })).status, 202);
    assert.equal((await finished("web", "starting", s2)).type, "done");
    assert.equal(await readFile(join(claudeHome, "kumiko.md"), "utf8"), managed);
    assert.equal(await readFile(join(claudeHome, "CLAUDE.md"), "utf8"), "mine\n");

    // Deleting removes the VM, the Claude home and the Kumiko folder; the clone and its worktrees stay.
    await remove("web");
    assert.deepEqual(await projects(), []);
    assert.equal(await exists(claudeHome), false);
    assert.equal(await exists(kumikoHome), false);
    assert.ok(await exists(join(clone, "README")));
    assert.ok(await exists(clone + "__worktrees"));
  });

  it("gives a VM made before the Kumiko folder its mount when it starts", async () => {
    await create("old");
    const stop = events.length;
    assert.equal((await api("/api/projects/old/stop", { method: "POST" })).status, 202);
    assert.equal((await finished("old", "stopping", stop)).type, "done");
    // As Kumiko recorded a VM it made with only the clone, the worktrees and the Claude home.
    const metadata = new MetadataStore(join(dataDir, "sandboxes"));
    const was = (await metadata.read("old"))!.spec;
    await metadata.update("old", { spec: { ...was, mounts: was.mounts.filter((m) => m.guestPath !== "~/.kumiko/shared") } });
    const before = (await readFile(join(limaDir, "calls.log"), "utf8")).split("\n").length;

    const since = events.length;
    assert.equal((await api("/api/projects/old/start", { method: "POST" })).status, 202);
    assert.equal((await finished("old", "starting", since)).type, "done");
    assert.deepEqual((await project("old"))!.meta?.spec.mounts.map((m) => m.guestPath), [was.mounts[0].hostPath, was.mounts[1].hostPath, "~/.claude", "~/.kumiko/shared"]);
    const calls = (await readFile(join(limaDir, "calls.log"), "utf8")).split("\n").slice(before - 1).filter(Boolean).map((l) => JSON.parse(l) as string[]);
    const edit = calls.findIndex((a) => a[0] === "edit" && a.includes("km-old"));
    assert.ok(edit >= 0 && edit < calls.findIndex((a) => a[0] === "start" && a.includes("km-old")), "Lima gets the mount before the VM starts");
    assert.ok(calls[edit].some((a) => a.includes(`"location":"${join(dataDir, "sandbox", "old")}","mountPoint":"{{.Home}}/.kumiko/shared"`)));

    await remove("old");
  });

  it("reports provisioning failures and recreates with a fixed script", async () => {
    const marker = join(mountDir, "ok");
    const { done } = await create("bad", { provision: `test -f ${marker} || exit 3` });
    assert.equal(done.type, "error");
    let p = (await project("bad"))!;
    assert.deepEqual([p.meta?.setup, p.meta?.provisionExitCode, p.operation?.result], ["provision_failed", 3, "error"]);

    // A running VM can't take new resources in place, but a recreate can.
    const patch = JSON.stringify({ cpus: 2, provision: "echo fixed" });
    assert.equal((await api("/api/projects/bad", { method: "PATCH", body: patch })).status, 400);
    let since = events.length;
    assert.equal((await api("/api/projects/bad?recreate=1", { method: "PATCH", body: patch })).status, 202);
    assert.equal((await finished("bad", "recreating", since)).type, "done");
    p = (await project("bad"))!;
    assert.deepEqual([p.meta?.setup, p.cpus, p.meta?.spec.provision, p.meta?.spec.mounts.length], ["ready", 2, "echo fixed", 4]);

    since = events.length;
    assert.equal((await api("/api/projects/bad/recreate", { method: "POST" })).status, 202);
    assert.equal((await finished("bad", "recreating", since)).type, "done");
    await remove("bad");
  });

  it("recreates a VM with the agent's setup scripts from its Kumiko folder", async () => {
    await create("agent");
    const dir = join(dataDir, "sandbox", "agent", "provision.d");
    const marker = join(mountDir, "agent-ran");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "10-a.sh"), `echo a >> ${marker}\n`);
    await writeFile(join(dir, "20-b.sh"), "exit 7\n");
    let setup = await json(await api("/api/projects/agent/agent-setup"));
    assert.deepEqual(setup.scripts.map((s: { file: string; exitCode?: number }) => [s.file, s.exitCode]), [["10-a.sh", undefined], ["20-b.sh", undefined]]);

    let since = events.length;
    assert.equal((await api("/api/projects/agent/recreate", { method: "POST" })).status, 202);
    assert.equal((await finished("agent", "recreating", since)).type, "done", "a failed agent script doesn't fail the recreate");
    assert.equal(await readFile(marker, "utf8"), "a\n");
    const p = (await project("agent"))!;
    assert.equal(p.meta?.setup, "ready");
    assert.deepEqual(p.meta?.agentSetup?.scripts.map((s) => [s.file, s.exitCode]), [["10-a.sh", 0], ["20-b.sh", 7]]);

    await writeFile(join(dir, "20-b.sh"), "true\n");
    setup = await json(await api("/api/projects/agent/agent-setup"));
    assert.deepEqual(setup.scripts.map((s: { exitCode?: number }) => s.exitCode), [0, undefined], "a script changed since hasn't run in this VM");

    since = events.length;
    assert.equal((await api("/api/projects/agent?recreate=1", { method: "PATCH", body: JSON.stringify({ cpus: 2 }) })).status, 202);
    assert.equal((await finished("agent", "recreating", since)).type, "done");
    assert.equal(await readFile(marker, "utf8"), "a\na\n");
    assert.deepEqual((await project("agent"))!.meta?.agentSetup?.scripts.map((s) => s.exitCode), [0, 0]);

    // Deleting them leaves the next VM with the user's setup only.
    assert.equal((await api("/api/projects/agent/agent-setup", { method: "DELETE" })).status, 200);
    assert.equal(await exists(dir), false);
    assert.deepEqual(await json(await api("/api/projects/agent/agent-setup")), { scripts: [], ignored: [] });
    since = events.length;
    assert.equal((await api("/api/projects/agent/recreate", { method: "POST" })).status, 202);
    assert.equal((await finished("agent", "recreating", since)).type, "done");
    assert.equal(await readFile(marker, "utf8"), "a\na\n");
    assert.equal((await project("agent"))!.meta?.agentSetup, undefined);
    await remove("agent");
  });

  it("edits a project's VM: variables while running, resources and extra mounts once stopped", async () => {
    const { clone } = await create("ed");
    const running = await api("/api/projects/ed", { method: "PATCH", body: JSON.stringify({ cpus: 2 }) });
    assert.equal(running.status, 400);
    assert.match((await json(running)).details.join(), /Stop km-ed/);

    let since = events.length;
    assert.equal((await api("/api/projects/ed", { method: "PATCH", body: JSON.stringify({ env: ["TOKEN"], workdir: "/elsewhere" }) })).status, 202);
    assert.equal((await finished("ed", "editing", since)).type, "done");
    assert.equal((await project("ed"))?.meta?.spec.workdir, clone, "the working directory stays the clone");

    since = events.length;
    await api("/api/projects/ed/stop", { method: "POST" });
    await finished("ed", "stopping", since);
    since = events.length;
    const extra = { hostPath: mountDir, guestPath: "/data", writable: false };
    assert.equal((await api("/api/projects/ed", { method: "PATCH", body: JSON.stringify({ cpus: 3, diskGiB: 12, mounts: [extra] }) })).status, 202);
    assert.equal((await finished("ed", "editing", since)).type, "done");
    const p = (await project("ed"))!;
    assert.deepEqual([p.cpus, p.diskGiB, p.meta?.spec.env], [3, 12, ["TOKEN"]]);
    // Only extra mounts are the user's: the project's own come back whatever is sent.
    assert.deepEqual(p.meta?.spec.mounts.map((m) => m.guestPath), [clone, clone + "__worktrees", "~/.claude", "~/.kumiko/shared", "/data"]);

    assert.equal((await api("/api/projects/nope", { method: "PATCH", body: "{}" })).status, 404);
    await remove("ed");
  });

  it("restarts a project's VM, saving resources and mounts while it is down", async () => {
    await create("rs");
    let since = events.length;
    assert.equal((await api("/api/projects/rs/restart", { method: "POST" })).status, 202);
    assert.equal((await finished("rs", "restarting", since)).type, "done");
    assert.equal((await project("rs"))?.status, "running");

    // A running VM can't take new resources in place, but a restart can, and it comes back running with them.
    since = events.length;
    const patch = JSON.stringify({ cpus: 3, mounts: [{ hostPath: mountDir, guestPath: "/data", writable: false }] });
    assert.equal((await api("/api/projects/rs?restart=1", { method: "PATCH", body: patch })).status, 202);
    assert.equal((await finished("rs", "restarting", since)).type, "done");
    const p = (await project("rs"))!;
    assert.deepEqual([p.status, p.cpus, p.meta?.spec.mounts.at(-1)?.guestPath], ["running", 3, "/data"]);
    // Disk still can't shrink.
    assert.equal((await api("/api/projects/rs?restart=1", { method: "PATCH", body: JSON.stringify({ diskGiB: 1 }) })).status, 400);
    await remove("rs");
  });

  it("shows a project whose VM is missing, and recreates it", async () => {
    process.env.FAKE_LIMA_FAIL_CREATE = "1";
    let created;
    try {
      created = await create("gone");
    } finally {
      delete process.env.FAKE_LIMA_FAIL_CREATE;
    }
    assert.equal(created.done.type, "error");
    assert.equal((await project("gone"))?.status, "absent");
    assert.equal((await api("/api/projects/gone/start", { method: "POST" })).status, 409);
    // Nor is it built again while its clone is away, either way of asking.
    await rename(created.clone, created.clone + "-moved");
    assert.equal((await api("/api/projects/gone/recreate", { method: "POST" })).status, 409);
    assert.equal((await api("/api/projects/gone?recreate=1", { method: "PATCH", body: JSON.stringify({ cpus: 2 }) })).status, 409);
    await rename(created.clone + "-moved", created.clone);
    const since = events.length;
    assert.equal((await api("/api/projects/gone/recreate", { method: "POST" })).status, 202);
    assert.equal((await finished("gone", "recreating", since)).type, "done");
    assert.equal((await project("gone"))?.status, "running");

    // A clone that went away is reported, and the VM won't start without it.
    await api("/api/projects/gone/stop", { method: "POST" });
    await waitFor(() => events.find((e) => "sandbox" in e && e.sandbox === "gone" && e.op === "stopping" && e.type === "done"));
    await rename(created.clone, created.clone + "-moved");
    assert.match((await project("gone"))?.problem ?? "", /is gone/);
    assert.equal((await api("/api/projects/gone/start", { method: "POST" })).status, 409);
    await rename(created.clone + "-moved", created.clone);
    await remove("gone");
  });

  it("lists worktrees with what needs attention, from git on the host", async () => {
    const { clone } = await create("wt");
    const wt = (b: string) => join(clone + "__worktrees", b);
    // Dirty: an untracked file. Unpushed: a commit on a branch with no upstream. Merged: pushed into origin/main.
    sh(clone, "worktree", "add", "--quiet", wt("dirty"), "-b", "dirty");
    await writeFile(join(wt("dirty"), "new.txt"), "x");
    sh(clone, "worktree", "add", "--quiet", wt("ahead"), "-b", "ahead");
    await writeFile(join(wt("ahead"), "a.txt"), "a");
    sh(wt("ahead"), "add", "a.txt");
    sh(wt("ahead"), "commit", "--quiet", "-m", "ahead");
    sh(clone, "worktree", "add", "--quiet", wt("feature/done"), "-b", "feature/done");
    await writeFile(join(wt("feature/done"), "d.txt"), "d");
    sh(wt("feature/done"), "add", "d.txt");
    sh(wt("feature/done"), "commit", "--quiet", "-m", "done");
    sh(wt("feature/done"), "push", "--quiet", "origin", "feature/done:main");
    sh(clone, "fetch", "--quiet");

    const res = (await json(await api("/api/projects/wt/worktrees"))) as WorktreesResponse;
    assert.equal(res.defaultBranch, "origin/main");
    const by = new Map(res.worktrees.map((w) => [w.branch, w]));
    assert.equal(res.worktrees[0].path, clone);
    assert.equal(res.worktrees[0].main, true);
    assert.deepEqual([by.get("dirty")?.dirty, by.get("dirty")?.unpushed, by.get("dirty")?.merged], [true, 0, false], "just made, so not merged");
    assert.deepEqual([by.get("ahead")?.dirty, by.get("ahead")?.unpushed, by.get("ahead")?.merged], [false, 1, false]);
    assert.deepEqual([by.get("feature/done")?.unpushed, by.get("feature/done")?.merged, by.get("feature/done")?.path], [0, true, wt("feature/done")]);
    assert.equal(by.get("main")?.merged, false, "the default branch isn't merged into itself");

    // A worktree whose folder went away is listed as git sees it: prunable.
    await rm(wt("ahead"), { recursive: true });
    const after = (await json(await api("/api/projects/wt/worktrees"))) as WorktreesResponse;
    assert.equal(after.worktrees.find((w) => w.branch === "ahead")?.prunable, true);
    await remove("wt");
  });

  it("lets only one of two creates racing for a name through", async () => {
    const [a, b] = await Promise.all([makeClone(root, "race-a"), makeClone(root, "race-b")]);
    const since = events.length;
    const results = await Promise.all([a, b].map((clonePath) => post("/api/projects", spec({ name: "race", clonePath }))));
    assert.ok(results.some((r) => r.status === 202) && results.some((r) => r.status === 400 || r.status === 409), results.map((r) => r.status).join());
    await finished("race", "creating", since);
    const winner = (await project("race"))!.project.clonePath;
    const loser = winner === a ? b : a;
    assert.equal(await exists(loser + "__worktrees"), false, "the loser left nothing behind");
    assert.ok(await exists(join(dataDir, "claude", "race")), "and didn't take the winner's Claude home with it");
    await remove("race");
  });

  it("reports a project record it can't read instead of hiding it", async () => {
    const file = join(dataDir, "projects", "broken.json");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "{ not json");
    const since = events.length;
    const listed = await waitFor(() => events.slice(since).find((e) => e.type === "list" && e.unreadable.length > 0));
    assert.ok(listed.type === "list");
    assert.match(listed.unreadable.join("\n"), /broken\.json, can't be read \(not valid JSON\)/);
    assert.ok(!(await projects()).some((p) => p.name === "broken"));
    // It still holds the name, and asking for it says why it can't be used.
    const res = await api("/api/projects/broken/worktrees");
    assert.equal(res.status, 409);
    assert.match((await json(res)).error, /not valid JSON/);
    const clone = await makeClone(root, "broken");
    const taken = await post("/api/projects", spec({ name: "broken", clonePath: clone }));
    assert.match((await json(taken)).details.join(), /already a project called broken/);
    await rm(file);
    await waitFor(() => events.slice(since).find((e) => e.type === "list" && e.unreadable.length === 0));
  });

  it("404s unknown projects and 400s bad ids", async () => {
    assert.equal((await api("/api/projects/nope/start", { method: "POST" })).status, 404);
    assert.equal((await api("/api/projects/nope/worktrees")).status, 404);
    assert.equal((await api("/api/projects/foreign", { method: "DELETE" })).status, 404);
    assert.equal((await api("/api/projects/Bad!/start", { method: "POST" })).status, 400);
  });

  it("refuses requests from other origins", async () => {
    const res = await api("/api/projects", { headers: { origin: "https://evil.example" } });
    assert.equal(res.status, 403);
    const bad = new WebSocket(`${server.url.replace("http", "ws")}/api/events`, { headers: { authorization: `Bearer ${server.token}` }, origin: "https://evil.example" });
    await new Promise<void>((r) => bad.once("error", () => r()));

    // Pages served from this machine on another port, such as a project's dev server in a preview pane, too.
    const port = new URL(server.url).port;
    assert.equal((await api("/api/projects", { headers: { origin: "http://localhost:5173" } })).status, 403);
    assert.equal((await api("/api/projects", { headers: { origin: "http://127.0.0.1:5173" } })).status, 403);
    assert.equal((await api("/api/projects", { headers: { origin: "null" } })).status, 403);
    const local = new WebSocket(`${server.url.replace("http", "ws")}/api/events`, { headers: { authorization: `Bearer ${server.token}` }, origin: "http://localhost:5173" });
    await new Promise<void>((r) => local.once("error", () => r()));
    // Its own pages, from either name for this machine.
    assert.equal((await api("/api/projects", { headers: { origin: `http://localhost:${port}` } })).status, 200);
    assert.equal((await api("/api/projects", { headers: { origin: `http://127.0.0.1:${port}` } })).status, 200);
  });

  it("refuses requests without the server's token, which a sandbox can't learn", async () => {
    // What an agent in a VM can send through Lima's host address: local Host, no Origin.
    const bare = (headers: Record<string, string> = {}) => fetch(`${server.url}/api/projects`, { headers });
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

  it("notices a project's VM changing outside Kumiko, and ignores VMs that aren't projects'", async () => {
    await create("outside");
    await writeFile(join(limaDir, "km-stray.json"), JSON.stringify({ name: "km-stray", status: "Running" }));
    const since = events.length;
    await writeFile(join(limaDir, "km-outside.json"), JSON.stringify({ name: "km-outside", status: "Stopped" }));
    await waitFor(() => events.slice(since).find((e) => e.type === "list" && e.projects.some((s) => s.name === "outside" && s.status === "stopped")));
    assert.ok(!(await projects()).some((p) => p.name === "stray"));
    await remove("outside");
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

      const bad = await fetch(`${server.url}/api/projects`, { method: "POST", headers: { authorization: `Bearer ${server.token}` }, body: "{nope" });
      assert.equal(bad.status, 400);
      assert.match((await json(bad)).error, /Body must be JSON/);

      // A body bigger than any request needs isn't read at all.
      const huge = await fetch(`${server.url}/api/projects`, { method: "POST", headers: { authorization: `Bearer ${server.token}` }, body: JSON.stringify({ name: "x".repeat(40 * 1024 * 1024) }) });
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
