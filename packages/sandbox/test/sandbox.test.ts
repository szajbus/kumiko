import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { execScript, exitCode, LimaProvider, mountsExpression, parseLimaList, parseLimaVersion, provisionCommand, tidyLimaLine, validateSpec } from "../src/index.js";
import { FAKE_LIMACTL, FAKE_SSH, fakeLima } from "./helpers.js";

const spec = (over = {}) => ({ name: "web", cpus: 4, memoryGiB: 4, diskGiB: 100, mounts: [], env: [], ...over });

describe("parsing", () => {
  it("reads limactl's one-object-per-line JSON and arrays", () => {
    const a = { name: "kumiko-a", status: "Running" }, b = { name: "wm-b", status: "Stopped" };
    assert.deepEqual(parseLimaList(`${JSON.stringify(a)}\n${JSON.stringify(b)}\n`), [a, b]);
    assert.deepEqual(parseLimaList(JSON.stringify([a, b])), [a, b]);
    assert.deepEqual(parseLimaList("\n"), []);
  });

  it("tidies logfmt lines", () => {
    assert.deepEqual(tidyLimaLine('time="x" level=info msg="Starting \\"kumiko-a\\""'), { text: 'Starting "kumiko-a"' });
    assert.deepEqual(tidyLimaLine('time="x" level=fatal msg="boom"'), { text: "error: boom", kind: "err" });
    assert.deepEqual(tidyLimaLine("plain"), { text: "plain" });
  });

  it("quotes forwarded values and skips unset ones", () => {
    const s = execScript("cat", ["A", "B"], { A: "it's $x" });
    assert.equal(s, `case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac\nexport CLAUDE_CONFIG_DIR="$HOME"/.claude\nexport A='it'\\''s $x'\nexec cat\n`);
  });

  it("changes into the working directory, leaving ~ to the VM's shell", () => {
    const path = `case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac\nexport CLAUDE_CONFIG_DIR="$HOME"/.claude\n`;
    assert.equal(execScript("cat", [], {}, "/workspace"), `${path}cd '/workspace' 2>/dev/null || true\nexec cat\n`);
    assert.equal(execScript("cat", [], {}, "~/my dir"), `${path}cd "$HOME"/'my dir' 2>/dev/null || true\nexec cat\n`);
  });

  it("builds the mounts expression with VM paths and ~ as Lima's {{.Home}}", () => {
    assert.equal(
      mountsExpression([
        { hostPath: "/a/b,c", writable: true, guestPath: "/workspace/b,c" },
        { hostPath: "/Users/me/.claude", writable: false, guestPath: "~/.claude" },
        { hostPath: "/same", writable: false },
      ]),
      '.mounts = [{"location":"/a/b,c","mountPoint":"/workspace/b,c","writable":true},' +
        '{"location":"/Users/me/.claude","mountPoint":"{{.Home}}/.claude","writable":false},' +
        '{"location":"/same","mountPoint":"/same","writable":false}]',
    );
  });

  it("wraps a provisioning script so it can't be read from stdin", () => {
    const cmd = provisionCommand("echo hi");
    assert.match(cmd, /^bash -c "\$\(cat <<'KUMIKO_PROVISION_[0-9a-f]+'\n/);
    assert.match(cmd, /set -e\n/);
  });
});

describe("parseLimaVersion", () => {
  it("reads limactl --version, pre-releases as their release, and nothing from a build without one", () => {
    assert.deepEqual(parseLimaVersion("limactl version 2.2.1\n"), [2, 2, 1]);
    assert.deepEqual(parseLimaVersion("limactl version 2.3.0-rc.1"), [2, 3, 0]);
    assert.equal(parseLimaVersion("limactl version HEAD-284b991"), undefined);
  });
});

describe("validateSpec", () => {
  it("accepts a minimal spec and normalizes it", async () => {
    const v = await validateSpec(spec({ template: " ", provision: "  " }));
    assert.deepEqual(v.errors, []);
    assert.equal(v.spec.template, undefined);
    assert.equal(v.spec.provision, undefined);
    assert.equal(v.spec.workdir, "/workspace");
  });

  it("rejects a template limactl would take for an option", async () => {
    for (const template of ["--set=.mounts=[{location:\"~\",writable:true}]", "-h", "template:x\n--tty"]) {
      assert.match((await validateSpec(spec({ template }))).errors.join(), /isn't a template/, template);
    }
    // Names, and files and URLs, spaces and all.
    for (const template of ["template:debian-12", "/Users/you/My Templates/dev.yaml", "https://example.com/t.yaml"]) {
      assert.deepEqual((await validateSpec(spec({ template }))).errors, [], template);
    }
  });

  it("normalizes the working directory and rejects / and relative paths", async () => {
    assert.equal((await validateSpec(spec({ workdir: "~/code/" }))).spec.workdir, "~/code");
    for (const workdir of ["/", "~", "code"]) assert.match((await validateSpec(spec({ workdir }))).errors.join(), /can't be the working directory/);
  });

  it("rejects bad names, resources and mounts", async () => {
    const { mountDir } = await fakeLima();
    const v = await validateSpec(
      spec({
        name: "Bad_Name",
        cpus: 0,
        diskGiB: 5,
        mounts: [
          { hostPath: mountDir, writable: true },
          { hostPath: join(mountDir, "sub"), writable: false },
          { hostPath: "/does/not/exist", writable: false },
          { hostPath: "relative", writable: false },
          { hostPath: mountDir, writable: false, guestPath: "relative/in/vm" },
          { hostPath: mountDir, writable: false, guestPath: "~" },
        ],
      }),
    );
    const text = v.errors.join("\n");
    for (const needle of ["Name", "CPUs", "Disk", "does not exist", "absolute", "relative/in/vm can't", "~ can't", "overlap in the sandbox"]) {
      assert.ok(text.includes(needle), `expected an error about ${needle}:\n${text}`);
    }
  });

  it("defaults the VM path to the host path and normalizes VM paths", async () => {
    const { mountDir } = await fakeLima();
    const v = await validateSpec(
      spec({
        mounts: [
          { hostPath: mountDir, writable: true },
          { hostPath: mountDir, writable: false, guestPath: "/workspace/d/" },
          { hostPath: mountDir, writable: false, guestPath: "~/.claude" },
        ],
      }),
    );
    assert.deepEqual(v.errors, []);
    assert.deepEqual(v.spec.mounts.map((m) => m.guestPath), [mountDir, "/workspace/d", "~/.claude"]);
    const clash = await validateSpec(spec({ mounts: [{ hostPath: mountDir, writable: false, guestPath: "/workspace" }, { hostPath: mountDir, writable: false, guestPath: "/workspace/d" }] }));
    assert.match(clash.errors.join(), /overlap in the sandbox/);
  });

  it("takes a whole workspace disk size, and keeps mounts out of /workspace only when there is one", async () => {
    const { mountDir } = await fakeLima();
    assert.deepEqual((await validateSpec(spec({ workspaceGiB: 50 }))).spec.workspaceGiB, 50);
    assert.equal((await validateSpec(spec())).spec.workspaceGiB, undefined);
    assert.match((await validateSpec(spec({ workspaceGiB: 0 }))).errors.join(), /Workspace disk must be a number of at least 1/);
    assert.match((await validateSpec(spec({ workspaceGiB: 2.5 }))).errors.join(), /whole number of GiB/);
    const at = (guestPath: string, workspaceGiB?: number) => validateSpec(spec({ workspaceGiB, mounts: [{ hostPath: mountDir, writable: true, guestPath }] }));
    for (const g of ["/workspace", "/workspace/data", "/workspace/a/b/"]) {
      assert.match((await at(g, 10)).errors.join(), /is the sandbox's workspace disk/, g);
      assert.deepEqual((await at(g)).errors, [], `${g} without a workspace disk`);
    }
    assert.deepEqual((await at("/workspaces", 10)).errors, []);
    assert.deepEqual((await at("~/workspace", 10)).errors, []);
  });

  it("warns, not fails, on unset variables", async () => {
    const v = await validateSpec(spec({ env: ["SET_ONE", "UNSET_ONE", "SET_ONE"] }), { SET_ONE: "1" });
    assert.deepEqual(v.errors, []);
    assert.deepEqual(v.spec.env, ["SET_ONE", "UNSET_ONE"]);
    assert.equal(v.warnings.length, 1);
    assert.match(v.warnings[0], /UNSET_ONE/);
  });
});

describe("LimaProvider against a fake limactl", () => {
  it("lists only kumiko- instances", async () => {
    const { limaDir, provider } = await fakeLima();
    await writeFile(join(limaDir, "wm-other.json"), JSON.stringify({ name: "wm-other", status: "Running" }));
    await writeFile(join(limaDir, "kumiko-mine.json"), JSON.stringify({ name: "kumiko-mine", status: "Broken", cpus: 2, memory: 2 * 1024 ** 3 }));
    assert.deepEqual(await provider.list(), [
      { name: "mine", status: "broken", cpus: 2, memoryGiB: 2, diskGiB: undefined, meta: undefined },
    ]);
  });

  it("reports a record it can't read instead of treating the VM as foreign", async () => {
    const { root, limaDir, provider, log, lines } = await fakeLima();
    await writeFile(join(limaDir, "kumiko-mine.json"), JSON.stringify({ name: "kumiko-mine", status: "Stopped" }));
    await mkdir(join(root, "sandboxes"), { recursive: true });
    await writeFile(join(root, "sandboxes", "mine.json"), "{ not json");

    const [info] = await provider.list();
    assert.equal(info.meta, undefined);
    assert.match(info.metaError!, /mine\.json, can't be read/);
    assert.match((await provider.validateEdit("mine", { cpus: 2 })).errors.join(), /can't be read/);
    // It still starts, set up as a VM Kumiko didn't create.
    await provider.start("mine", log);
    assert.ok(lines.some((l) => l.startsWith("warning: Kumiko's record")));
  });

  it("reports a record whose spec has no working directory as one it can't read", async () => {
    const { root, limaDir, provider } = await fakeLima();
    await writeFile(join(limaDir, "kumiko-mine.json"), JSON.stringify({ name: "kumiko-mine", status: "Stopped" }));
    await mkdir(join(root, "sandboxes"), { recursive: true });
    const meta = { spec: { name: "mine", cpus: 2, memoryGiB: 4, diskGiB: 20, mounts: [], env: [] }, provider: "lima", createdAt: "2026-01-01T00:00:00Z", setup: "ready" };
    await writeFile(join(root, "sandboxes", "mine.json"), JSON.stringify(meta));
    const [info] = await provider.list();
    assert.equal(info.meta, undefined);
    assert.match(info.metaError!, /mine\.json, can't be read \(it has no valid spec\)/);
  });

  it("creates, provisions once with forwarded variables, stops, starts and deletes", async () => {
    const { limaDir, mountDir, provider, log, lines } = await fakeLima({ TOKEN: "s3cr3t 'quoted'" });
    await provider.create(
      spec({
        mounts: [{ hostPath: mountDir, writable: true }],
        env: ["TOKEN"],
        provision: `printf '%s' "$TOKEN" > ${mountDir}/token\necho line >> ${mountDir}/runs`,
      }),
      log,
    );
    assert.equal(await readFile(join(mountDir, "token"), "utf8"), "s3cr3t 'quoted'");
    const calls = (await readFile(join(limaDir, "calls.log"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const create = calls.find((c) => c[0] === "create");
    assert.deepEqual(create, [
      "create", "--tty=false", "--name=kumiko-web", "--cpus=4", "--memory=4", "--disk=100",
      `--set=.mounts = [{"location":"${mountDir}","mountPoint":"${mountDir}","writable":true}]`,
      "template:default",
    ]);
    assert.ok(lines.some((l) => l.includes('+ printf \'%s\' "$TOKEN"')), "trace shows the command unexpanded");
    assert.ok(!lines.some((l) => l.includes("s3cr3t")), "the value never reaches the log");

    let [info] = await provider.list();
    assert.equal(info.status, "running");
    assert.equal(info.meta?.setup, "ready");
    assert.deepEqual(info.meta?.spec.env, ["TOKEN"]);
    assert.ok(!JSON.stringify(info.meta).includes("s3cr3t"), "metadata holds names only");

    await provider.stop("web", log);
    await provider.start("web", log);
    assert.equal(await readFile(join(mountDir, "runs"), "utf8"), "line\n", "provisioning ran exactly once");

    await provider.delete("web", log);
    assert.deepEqual(await provider.list(), []);
    assert.equal(await provider.metadata.read("web"), undefined);
  });

  it("prepares the working directory on start and provisions inside it", async () => {
    const { mountDir, provider, log, lines } = await fakeLima();
    await provider.create(spec({ workdir: mountDir, provision: "pwd > here" }), log);
    assert.equal((await readFile(join(mountDir, "here"), "utf8")).trim(), mountDir);
    assert.ok(!lines.some((l) => l.includes("couldn't prepare")), "an existing, writable directory needs nothing");
  });

  it("points interactive shells that land in ~ at the working directory, once per .bashrc", async () => {
    const { limaDir, mountDir, provider, log } = await fakeLima();
    await provider.create(spec({ workdir: "~/code dir" }), log);
    await provider.stop("web", log);
    await provider.start("web", log);
    const home = join(limaDir, "vm-home");
    const bashrc = await readFile(join(home, ".bashrc"), "utf8");
    assert.equal(bashrc.split(".config/kumiko/shell.sh ]").length - 1, 1, "sourced from .bashrc exactly once");
    assert.ok(bashrc.startsWith("# Added by Kumiko\n[ -f ~/.config/kumiko/env.sh ]"), "PATH comes first in .bashrc");
    assert.equal(bashrc.split(".config/kumiko/env.sh ]").length - 1, 1);
    const profile = await readFile(join(home, ".profile"), "utf8");
    assert.equal(profile.split(".config/kumiko/env.sh ]").length - 1, 1, "and from .profile once");
    const rc = await readFile(join(home, ".config/kumiko/shell.sh"), "utf8");
    assert.ok(rc.includes(`cd "$HOME"/'code dir'`), rc);

    // An interactive shell starting in ~ ends up in the working directory; one started elsewhere stays put.
    await mkdir(join(home, "code dir")); // the fake sudo doesn't really mkdir
    const { execFileSync } = await import("node:child_process");
    const env = { ...process.env, HOME: home };
    const pwd = (cwd: string) => execFileSync("bash", ["-ic", "pwd"], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    assert.equal(pwd(home), join(home, "code dir"));
    assert.equal(pwd(mountDir), mountDir);

    // Every kind of shell has ~/.local/bin on PATH, once.
    const bin = join(home, ".local/bin");
    for (const flags of ["-ic", "-lc"]) {
      const path = execFileSync("bash", [flags, "echo $PATH"], { cwd: home, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      assert.equal(path.split(":").filter((x) => x === bin).length, 1, `${flags}: ${path}`);
      // And Claude reads its config from the project's Claude home, so a login in a shell is the one sessions use.
      const config = execFileSync("bash", [flags, "echo $CLAUDE_CONFIG_DIR"], { cwd: home, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      assert.equal(config, join(home, ".claude"), flags);
    }
  });

  it("installs Claude Code before the script, links it onto PATH, and only once", async () => {
    const { limaDir, provider, log, lines } = await fakeLima();
    await provider.create(spec({ provision: "claude --version > ~/seen" }), log);
    const at = (t: string) => lines.findIndex((l) => l.includes(t));
    assert.ok(at("— installing Claude Code —") >= 0 && at("— installing Claude Code —") < at("— provisioning"), "Claude Code comes first");
    assert.ok(lines.includes("+ sudo ln -sf \"$HOME/.local/bin/claude\" /usr/local/bin/claude"));
    assert.equal((await readFile(join(limaDir, "vm-home", "seen"), "utf8")).trim(), "2.0.0 (Claude Code)", "the script finds claude on PATH");
    assert.equal((await readFile(join(limaDir, "curl.log"), "utf8")).trim().split("\n").length, 1);

    await provider.stop("web", log);
    await provider.start("web", log);
    assert.equal((await readFile(join(limaDir, "curl.log"), "utf8")).trim().split("\n").length, 1, "an installed claude isn't downloaded again");
  });

  it("fails provisioning when Claude Code can't be installed", async () => {
    const { provider, log } = await fakeLima();
    process.env.FAKE_CURL_FAIL = "1";
    try {
      await assert.rejects(provider.create(spec({ provision: "echo never" }), log), /Installing Claude Code failed with exit code 6/);
    } finally {
      delete process.env.FAKE_CURL_FAIL;
    }
    const [info] = await provider.list();
    assert.deepEqual([info.meta?.setup, info.meta?.provisionExitCode], ["provision_failed", 6]);
  });

  it("uses --mount-none when no mounts are selected", async () => {
    const { limaDir, provider, log } = await fakeLima();
    await provider.create(spec({ template: "template:debian-12" }), log);
    const create = (await readFile(join(limaDir, "calls.log"), "utf8")).split("\n").find((l) => l.includes('"create"'))!;
    assert.ok(create.includes('"--mount-none"'));
    assert.ok(create.includes('"template:debian-12"'));
  });

  it("keeps a sandbox whose provisioning failed, and recreates it with a fixed script", async () => {
    const { mountDir, provider, log, lines } = await fakeLima();
    const marker = join(mountDir, "fixed");
    await assert.rejects(
      provider.create(spec({ provision: `test -f ${marker} || exit 6\necho ok` }), log),
      /Provisioning failed with exit code 6/,
    );
    let [info] = await provider.list();
    assert.equal(info.meta?.setup, "provision_failed");
    assert.equal(info.meta?.provisionExitCode, 6);
    assert.ok(lines.includes("Provisioning failed with exit code 6."));

    const v = await provider.validateEdit("web", { cpus: 1, provision: "echo fixed" }, { recreate: true });
    assert.deepEqual(v.errors, []); // running, yet resources may change because the VM is rebuilt
    await provider.delete("web", log);
    await provider.create(v.spec, log);
    [info] = await provider.list();
    assert.equal(info.meta?.spec.provision, "echo fixed");
    assert.equal(info.meta?.setup, "ready");
    assert.equal(info.meta?.provisionExitCode, undefined);
  });

  it("runs the agent's setup scripts after the user's, each on its own, and records how each went", async () => {
    const { mountDir, provider, log, lines } = await fakeLima({ TOKEN: "abc" });
    const order = join(mountDir, "order");
    await provider.create(
      spec({ env: ["TOKEN"], workdir: mountDir, provision: `echo user >> ${order}` }),
      log,
      {
        scripts: [
          { file: "10-a.sh", script: `echo "a $TOKEN $PWD" >> ${order}` },
          { file: "20-b.sh", script: `false\necho never >> ${order}` },
          { file: "30-c.sh", script: `echo c >> ${order}` },
        ],
      },
    );
    assert.equal(await readFile(order, "utf8"), `user\na abc ${mountDir}\nc\n`, "after the user's script, in order, with variables, in the working directory; a failure stops only its own script");
    const [info] = await provider.list();
    assert.equal(info.meta?.setup, "ready", "a failed agent script leaves the sandbox usable");
    assert.deepEqual(info.meta?.agentSetup?.scripts.map((s) => [s.file, s.exitCode]), [["10-a.sh", 0], ["20-b.sh", 1], ["30-c.sh", 0]]);
    assert.ok(lines.includes("— agent setup: 20-b.sh —"));
    assert.ok(lines.some((l) => l.startsWith("warning: the agent's setup script 20-b.sh (exit 1) failed")));
  });

  it("doesn't run the agent's setup scripts after the user's script fails", async () => {
    const { mountDir, provider, log } = await fakeLima();
    const ran = join(mountDir, "ran");
    const agent = { scripts: [{ file: "10-a.sh", script: `touch ${ran}` }] };
    await assert.rejects(provider.create(spec({ provision: "exit 4" }), log, agent), /Provisioning failed with exit code 4/);
    assert.equal(await readFile(ran).then(() => true, () => false), false);
    assert.equal((await provider.list())[0].meta?.agentSetup?.scripts[0].exitCode, undefined);
  });

  it("refuses a name that is taken, and keeps the record to recreate from when limactl create fails", async () => {
    const { provider, log } = await fakeLima();
    await provider.create(spec(), log);
    const v = await provider.validate(spec());
    assert.match(v.errors.join(), /kumiko-web already exists/);

    process.env.FAKE_LIMA_FAIL_CREATE = "1";
    try {
      await assert.rejects(provider.create(spec({ name: "other" }), log), /simulated create failure/);
    } finally {
      delete process.env.FAKE_LIMA_FAIL_CREATE;
    }
    assert.equal((await provider.metadata.read("other"))?.setup, "creating");
    assert.equal((await provider.list()).find((i) => i.name === "other")?.status, "absent", "listed as absent, to recreate");
    // Deleting a VM that never came to be only drops the record.
    await provider.delete("other", log);
    assert.equal(await provider.metadata.read("other"), undefined);
  });

  it("edits resources and mounts only while stopped, and variables anytime", async () => {
    const { limaDir, mountDir, provider, log, lines } = await fakeLima({ A: "1" });
    await provider.create(spec({ cpus: 2, memoryGiB: 2, diskGiB: 20 }), log);

    // Running: variables and the script are fine, resources and mounts are not.
    let v = await provider.validateEdit("web", { env: ["A"], provision: "echo hi" });
    assert.deepEqual(v.errors, []);
    await provider.edit("web", { env: ["A"], provision: "echo hi" }, log);
    let [info] = await provider.list();
    assert.deepEqual(info.meta?.spec.env, ["A"]);
    assert.equal(info.meta?.spec.provision, "echo hi");
    assert.equal(info.meta?.setup, "ready", "editing doesn't change the setup state");
    v = await provider.validateEdit("web", { cpus: 4 });
    assert.match(v.errors.join(), /Stop kumiko-web to change its resources, mounts or access to your Mac.s localhost/);

    await provider.stop("web", log);
    v = await provider.validateEdit("web", { diskGiB: 10 });
    assert.match(v.errors.join(), /Disk can only grow; it is 20 GiB now/);

    lines.length = 0;
    await provider.edit("web", { cpus: 4, memoryGiB: 6, diskGiB: 40, mounts: [{ hostPath: mountDir, writable: true, guestPath: "/workspace/m" }] }, log);
    const edit = (await readFile(join(limaDir, "calls.log"), "utf8")).trim().split("\n").map((l) => JSON.parse(l)).filter((c) => c[0] === "edit").pop();
    assert.deepEqual(edit, [
      "edit", "--tty=false", "kumiko-web", "--cpus=4", "--memory=6", "--disk=40",
      `--set=.mounts = [{"location":"${mountDir}","mountPoint":"/workspace/m","writable":true}]`,
    ]);
    [info] = await provider.list();
    assert.deepEqual([info.cpus, info.memoryGiB, info.diskGiB], [4, 6, 40]);
    assert.equal(info.meta?.spec.mounts[0].guestPath, "/workspace/m");
    assert.equal(info.meta?.spec.provision, "echo hi", "fields left out of the patch are kept");

    // Nothing Lima-related changed: no limactl edit at all, and clearing the script works.
    const edits = async () => (await readFile(join(limaDir, "calls.log"), "utf8")).split("\n").filter((l) => l.includes('"edit"')).length;
    const before = await edits();
    await provider.edit("web", { provision: "" }, log);
    assert.equal(await edits(), before);
    [info] = await provider.list();
    assert.equal(info.meta?.spec.provision, undefined);
  });

  describe("the workspace disk", () => {
    const callsOf = async (limaDir: string) => (await readFile(join(limaDir, "calls.log"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as string[]);
    const disks = async (limaDir: string) => (await callsOf(limaDir)).filter((c) => c[0] === "disk" && c[1] !== "ls");

    it("is created before the VM, attached at /workspace, and listed with its size", async () => {
      const { limaDir, provider, log } = await fakeLima();
      await provider.create(spec({ workspaceGiB: 50 }), log);
      const calls = await callsOf(limaDir);
      assert.deepEqual(await disks(limaDir), [["disk", "create", "kumiko-web-workspace", "--size=50GiB", "--format=raw"]]);
      assert.ok(calls.findIndex((c) => c[0] === "disk") < calls.findIndex((c) => c[0] === "create"), "the disk exists before the VM that uses it");
      assert.deepEqual(calls.find((c) => c[0] === "create"), [
        "create", "--tty=false", "--name=kumiko-web", "--cpus=4", "--memory=4", "--disk=100", "--mount-none",
        `--set=.additionalDisks = [{"name":"kumiko-web-workspace","format":true,"fsType":"ext4","mountPoint":"/workspace"}]`,
        "template:default",
      ]);
      const [info] = await provider.list();
      assert.equal(info.workspaceGiB, 50);
      assert.equal(info.meta?.spec.workspaceGiB, 50);
    });

    it("joins the mounts in one --set", async () => {
      const { limaDir, mountDir, provider, log } = await fakeLima();
      await provider.create(spec({ workspaceGiB: 5, mounts: [{ hostPath: mountDir, writable: false }] }), log);
      const create = (await callsOf(limaDir)).find((c) => c[0] === "create")!;
      assert.deepEqual(create.filter((a) => a.startsWith("--set=")), [
        `--set=.mounts = [{"location":"${mountDir}","mountPoint":"${mountDir}","writable":false}] | .additionalDisks = [{"name":"kumiko-web-workspace","format":true,"fsType":"ext4","mountPoint":"/workspace"}]`,
      ]);
      assert.ok(!create.includes("--mount-none"));
    });

    it("outlives a recreate, which attaches it again as it is, and goes with the sandbox", async () => {
      const { limaDir, provider, log, lines } = await fakeLima();
      await provider.create(spec({ workspaceGiB: 20 }), log);
      await provider.delete("web", log, { keepWorkspace: true });
      assert.ok(lines.includes("Deleted. The workspace disk kumiko-web-workspace is kept."));
      let [info] = await provider.list();
      assert.equal(info, undefined, "the VM and its record are gone");

      await provider.create(spec({ workspaceGiB: 20, cpus: 2 }), log);
      assert.deepEqual((await disks(limaDir)).map((c) => c.slice(0, 2)), [["disk", "create"]], "not created again");
      assert.ok(lines.includes("Using the workspace disk kumiko-web-workspace, kept from before (20 GiB)."));
      [info] = await provider.list();
      assert.deepEqual([info.status, info.cpus, info.workspaceGiB], ["running", 2, 20]);

      await provider.delete("web", log);
      assert.deepEqual((await disks(limaDir)).at(-1), ["disk", "delete", "kumiko-web-workspace"]);
      assert.deepEqual(await provider.list(), []);
    });

    it("is grown on a recreate that asks for more", async () => {
      const { limaDir, provider, log } = await fakeLima();
      await provider.create(spec({ workspaceGiB: 20 }), log);
      await provider.delete("web", log, { keepWorkspace: true });
      await provider.create(spec({ workspaceGiB: 30 }), log);
      assert.deepEqual((await disks(limaDir)).at(-1), ["disk", "resize", "kumiko-web-workspace", "--size=30GiB"]);
      assert.equal((await provider.list())[0].workspaceGiB, 30);
    });

    it("is deleted with a VM that is already gone", async () => {
      const { limaDir, provider, log } = await fakeLima();
      await provider.create(spec({ workspaceGiB: 5 }), log);
      execFileSync(FAKE_LIMACTL, ["delete", "kumiko-web"], { env: { ...process.env, FAKE_LIMA_DIR: limaDir } });
      assert.equal((await provider.list())[0].status, "absent");
      assert.equal((await provider.list())[0].workspaceGiB, 5, "an absent sandbox's disk is still listed");
      await provider.delete("web", log);
      assert.deepEqual((await disks(limaDir)).at(-1), ["disk", "delete", "kumiko-web-workspace"]);
    });

    it("grows only while the VM is stopped, and never shrinks", async () => {
      const { limaDir, provider, log } = await fakeLima();
      await provider.create(spec({ workspaceGiB: 20 }), log);
      assert.match((await provider.validateEdit("web", { workspaceGiB: 40 })).errors.join(), /Stop kumiko-web to change/);
      assert.deepEqual((await provider.validateEdit("web", { workspaceGiB: 40 }, { restart: true })).errors, []);
      await provider.stop("web", log);
      assert.match((await provider.validateEdit("web", { workspaceGiB: 10 })).errors.join(), /can only grow; it is 20 GiB now/);
      const before = (await callsOf(limaDir)).length;
      await provider.edit("web", { workspaceGiB: 40 }, log);
      assert.deepEqual((await disks(limaDir)).at(-1), ["disk", "resize", "kumiko-web-workspace", "--size=40GiB"]);
      assert.ok(!(await callsOf(limaDir)).slice(before).some((c) => c[0] === "edit"), "nothing for limactl edit");
      const [info] = await provider.list();
      assert.deepEqual([info.workspaceGiB, info.meta?.spec.workspaceGiB], [40, 40]);
    });

    it("can't be added to a VM without one, short of a recreate", async () => {
      const { provider, log } = await fakeLima();
      await provider.create(spec(), log);
      await provider.stop("web", log);
      assert.match((await provider.validateEdit("web", { workspaceGiB: 10 })).errors.join(), /no workspace disk. Recreate it to add one/);
      assert.deepEqual((await provider.validateEdit("web", { workspaceGiB: 10 }, { recreate: true })).errors, []);
    });

    it("needs Lima 2.3, and says so before creating anything", async () => {
      const { limaDir, provider, log } = await fakeLima();
      process.env.FAKE_LIMA_VERSION = "2.2.1";
      try {
        await assert.rejects(provider.create(spec({ workspaceGiB: 5 }), log), /needs Lima 2.3.0 or later; this is Lima 2.2.1. Upgrade Lima first/);
      } finally {
        delete process.env.FAKE_LIMA_VERSION;
      }
      assert.deepEqual(await disks(limaDir), []);
      assert.ok(!(await callsOf(limaDir)).some((c) => c[0] === "create"));
    });

    it("refuses a new sandbox whose disk an earlier one of the same name left behind", async () => {
      const { limaDir, provider } = await fakeLima();
      assert.deepEqual((await provider.validate(spec({ workspaceGiB: 5 }), { newSandbox: true })).errors, []);
      execFileSync(FAKE_LIMACTL, ["disk", "create", "kumiko-web-workspace", "--size=5GiB"], { env: { ...process.env, FAKE_LIMA_DIR: limaDir } });
      assert.match(
        (await provider.validate(spec({ workspaceGiB: 5 }), { newSandbox: true })).errors.join(),
        /The workspace disk kumiko-web-workspace is left from an earlier sandbox called web\. Delete it with `limactl disk delete kumiko-web-workspace` first/,
      );
      // A rebuild attaches it, as it should.
      assert.deepEqual((await provider.validate(spec({ workspaceGiB: 5 }))).errors, []);
    });

    it("refuses a disk another VM uses", async () => {
      const { limaDir, provider, log } = await fakeLima();
      const env = { ...process.env, FAKE_LIMA_DIR: limaDir };
      execFileSync(FAKE_LIMACTL, ["disk", "create", "kumiko-web-workspace", "--size=5GiB"], { env });
      execFileSync(FAKE_LIMACTL, ["create", "--name=kumiko-other", `--set=.additionalDisks = [{"name":"kumiko-web-workspace"}]`, "template:default"], { env });
      await assert.rejects(provider.create(spec({ workspaceGiB: 5 }), log), /The workspace disk kumiko-web-workspace is in use by kumiko-other/);
    });
  });

  describe("the Mac's localhost", () => {
    const callsOf = async (limaDir: string) => (await readFile(join(limaDir, "calls.log"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as string[]);
    const loopbackEdits = async (limaDir: string) => (await callsOf(limaDir)).filter((c) => c[0] === "edit" && c.some((a) => a.includes(".networkOpts.hostLoopback")));
    /** Runs `fn` with the fake limactl being another version or making another type of VM. */
    const as = async <T>(env: { FAKE_LIMA_VERSION?: string; FAKE_LIMA_VMTYPE?: string }, fn: () => Promise<T>): Promise<T> => {
      Object.assign(process.env, env);
      try {
        return await fn();
      } finally {
        for (const k of Object.keys(env)) delete process.env[k];
      }
    };

    it("is out of a new sandbox's reach where Lima can block it, from its first start", async () => {
      const { limaDir, provider, log } = await fakeLima();
      await provider.create(spec(), log);
      const calls = await callsOf(limaDir);
      const edit = calls.findIndex((c) => c[0] === "edit");
      assert.deepEqual(calls[edit], ["edit", "--tty=false", "kumiko-web", "--set=.networkOpts.hostLoopback = false"]);
      assert.ok(edit < calls.findIndex((c) => c[0] === "start"), "before the VM first starts");
      const [info] = await provider.list();
      assert.equal(info.hostLoopbackOpen, undefined);
    });

    it("stays in reach of a sandbox allowed it, and can be allowed or blocked again while stopped", async () => {
      const { limaDir, provider, log } = await fakeLima();
      await provider.create(spec({ hostLoopback: true }), log);
      assert.deepEqual(await loopbackEdits(limaDir), []);
      assert.equal((await provider.list())[0].meta?.spec.hostLoopback, true);

      assert.match((await provider.validateEdit("web", { hostLoopback: false })).errors.join(), /Stop kumiko-web to change/);
      await provider.stop("web", log);
      await provider.edit("web", { hostLoopback: false }, log);
      assert.deepEqual((await loopbackEdits(limaDir)).pop()?.at(-1), "--set=.networkOpts.hostLoopback = false");
      assert.equal((await provider.list())[0].meta?.spec.hostLoopback, undefined);
      // With a mounts change too, one --set does both.
      await provider.edit("web", { hostLoopback: true, mounts: [] }, log);
      assert.deepEqual((await loopbackEdits(limaDir)).pop()?.slice(3), ["--set=.networkOpts.hostLoopback = true"]);
    });

    it("says why where Lima can't block it, and blocks it once Lima can", async () => {
      const { limaDir, provider, log, lines } = await fakeLima();
      await as({ FAKE_LIMA_VERSION: "2.2.1" }, async () => {
        await provider.create(spec(), log);
        assert.equal((await provider.list())[0].hostLoopbackOpen, "Kumiko can block it if you want, but your current Lima version (2.2.1) does not support it. You need to upgrade to 2.3 or later first.");
      });
      assert.deepEqual(await loopbackEdits(limaDir), []);
      assert.ok(lines.some((l) => /warning: this sandbox can reach services on your Mac's localhost \(127\.0\.0\.1\)\. Kumiko can block it if you want, but your current Lima version \(2\.2\.1\)/.test(l)), lines.join("\n"));

      // Lima is upgraded. Kumiko asks its version again after a while; a new provider on the same VMs asks at once.
      const upgraded = new LimaProvider({ limactl: FAKE_LIMACTL, ssh: FAKE_SSH, metadata: provider.metadata });
      assert.equal((await upgraded.list())[0].hostLoopbackOpen, "Restart the sandbox to block it.");
      await upgraded.stop("web", log);
      await upgraded.start("web", log);
      assert.equal((await loopbackEdits(limaDir)).length, 1);
      assert.equal((await upgraded.list())[0].hostLoopbackOpen, undefined);
    });

    it("says why on a VM type that can't block it", async () => {
      const { limaDir, provider, log } = await fakeLima();
      await as({ FAKE_LIMA_VMTYPE: "qemu" }, () => provider.create(spec(), log));
      assert.deepEqual(await loopbackEdits(limaDir), []);
      assert.match((await provider.list())[0].hostLoopbackOpen ?? "", /Lima only supports it in vz VMs, and this one is qemu\. You need to recreate the sandbox/);
    });
  });

  it("refuses to edit VMs Kumiko didn't create", async () => {
    const { limaDir, provider } = await fakeLima();
    await writeFile(join(limaDir, "kumiko-alien.json"), JSON.stringify({ name: "kumiko-alien", status: "Stopped" }));
    const v = await provider.validateEdit("alien", { cpus: 2 });
    assert.match(v.errors.join(), /was not created by Kumiko/);
  });

  it("offers templates with a Debian one preferred", async () => {
    const { provider } = await fakeLima();
    const t = await provider.templates();
    assert.equal(t.preferred, "template:debian-12");
    assert.ok(t.templates.includes("template:default"));
  });

  it("pipes stdin after the preamble to the command", async () => {
    const { provider } = await fakeLima({ GREETING: "hello" });
    const child = provider.exec("web", 'sh -c \'read x; echo "$GREETING $x"\'', ["GREETING"]);
    let out = "";
    child.stdout!.on("data", (c) => (out += c));
    child.stdin!.end("world\n");
    await new Promise((r) => child.on("close", r));
    assert.equal(out, "hello world\n");
  });

  it("survives writing to a command that has stopped reading", async () => {
    const { provider } = await fakeLima();
    const child = provider.exec("web", "sh -c 'exec 0<&-; sleep 0.2'", []);
    child.stdout!.resume();
    await new Promise((r) => setTimeout(r, 100));
    // Without a handler on stdin this EPIPE is an uncaught error that ends the process.
    child.stdin!.write("x".repeat(1 << 20));
    child.stdin!.end();
    assert.equal(await exitCode(child), 0);
  });
});

describe("out of file descriptors", () => {
  // Spawning then fails with EMFILE (ENFILE when the whole system is out) before the child's pipes exist, and says so
  // only by an "error" event a tick later: unheard, it ended the app. Run in a process of its own that uses up its fds.
  it("reports it as a spawn error instead of crashing", () => {
    const script = `
      const { openSync } = await import("node:fs");
      const { run } = await import(${JSON.stringify(new URL("../src/proc.js", import.meta.url).href)});
      const { exitCode } = await import(${JSON.stringify(new URL("../src/index.js", import.meta.url).href)});
      const { fakeLima } = await import(${JSON.stringify(new URL("./helpers.js", import.meta.url).href)});
      const { provider } = await fakeLima();
      const fds = [];
      try { for (;;) fds.push(openSync("/dev/null", "r")); } catch {}
      const ran = await run("true", []).then(() => "ran", (e) => e.code);
      const child = provider.exec("web", "true", []);
      child.stdin.end();
      child.stdout.resume();
      const exec = await exitCode(child).then(() => "ran", (e) => e.code);
      console.log(JSON.stringify({ ran, exec }));
    `;
    const out = execFileSync("sh", ["-c", 'ulimit -n 64 && exec "$0" --input-type=module -e "$1"', process.execPath, script], { encoding: "utf8" });
    assert.deepEqual(JSON.parse(out), { ran: "EMFILE", exec: "EMFILE" });
  });
});
