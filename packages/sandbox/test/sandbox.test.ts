import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { execScript, exitCode, mountsExpression, parseLimaList, provisionCommand, tidyLimaLine, validateSpec } from "../src/index.js";
import { fakeLima } from "./helpers.js";

const spec = (over = {}) => ({ name: "web", cpus: 4, memoryGiB: 4, diskGiB: 100, mounts: [], env: [], ...over });

describe("parsing", () => {
  it("reads limactl's one-object-per-line JSON and arrays", () => {
    const a = { name: "km-a", status: "Running" }, b = { name: "wm-b", status: "Stopped" };
    assert.deepEqual(parseLimaList(`${JSON.stringify(a)}\n${JSON.stringify(b)}\n`), [a, b]);
    assert.deepEqual(parseLimaList(JSON.stringify([a, b])), [a, b]);
    assert.deepEqual(parseLimaList("\n"), []);
  });

  it("tidies logfmt lines", () => {
    assert.deepEqual(tidyLimaLine('time="x" level=info msg="Starting \\"km-a\\""'), { text: 'Starting "km-a"' });
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

describe("validateSpec", () => {
  it("accepts a minimal spec and normalizes it", async () => {
    const v = await validateSpec(spec({ template: " ", provision: "  " }));
    assert.deepEqual(v.errors, []);
    assert.equal(v.spec.template, undefined);
    assert.equal(v.spec.provision, undefined);
    assert.equal(v.spec.workdir, "/workspace");
  });

  it("rejects a template limactl would take for an option", async () => {
    for (const template of ["--set=.mounts=[{location:\"~\",writable:true}]", "-h", "template:debian 12"]) {
      assert.match((await validateSpec(spec({ template }))).errors.join(), /isn't a template/, template);
    }
    assert.deepEqual((await validateSpec(spec({ template: "template:debian-12" }))).errors, []);
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

  it("warns, not fails, on unset variables", async () => {
    const v = await validateSpec(spec({ env: ["SET_ONE", "UNSET_ONE", "SET_ONE"] }), { SET_ONE: "1" });
    assert.deepEqual(v.errors, []);
    assert.deepEqual(v.spec.env, ["SET_ONE", "UNSET_ONE"]);
    assert.equal(v.warnings.length, 1);
    assert.match(v.warnings[0], /UNSET_ONE/);
  });
});

describe("LimaProvider against a fake limactl", () => {
  it("lists only km- instances", async () => {
    const { limaDir, provider } = await fakeLima();
    await writeFile(join(limaDir, "wm-other.json"), JSON.stringify({ name: "wm-other", status: "Running" }));
    await writeFile(join(limaDir, "km-mine.json"), JSON.stringify({ name: "km-mine", status: "Broken", cpus: 2, memory: 2 * 1024 ** 3 }));
    assert.deepEqual(await provider.list(), [
      { name: "mine", status: "broken", cpus: 2, memoryGiB: 2, diskGiB: undefined, meta: undefined },
    ]);
  });

  it("reports a record it can't read instead of treating the VM as foreign", async () => {
    const { root, limaDir, provider, log, lines } = await fakeLima();
    await writeFile(join(limaDir, "km-mine.json"), JSON.stringify({ name: "km-mine", status: "Stopped" }));
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
      "create", "--tty=false", "--name=km-web", "--cpus=4", "--memory=4", "--disk=100",
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

  it("refuses a name that is taken, and keeps the record to recreate from when limactl create fails", async () => {
    const { provider, log } = await fakeLima();
    await provider.create(spec(), log);
    const v = await provider.validate(spec());
    assert.match(v.errors.join(), /km-web already exists/);

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
    assert.match(v.errors.join(), /Stop km-web to change its resources or mounts/);

    await provider.stop("web", log);
    v = await provider.validateEdit("web", { diskGiB: 10 });
    assert.match(v.errors.join(), /Disk can only grow; it is 20 GiB now/);

    lines.length = 0;
    await provider.edit("web", { cpus: 4, memoryGiB: 6, diskGiB: 40, mounts: [{ hostPath: mountDir, writable: true, guestPath: "/workspace/m" }] }, log);
    const edit = (await readFile(join(limaDir, "calls.log"), "utf8")).trim().split("\n").map((l) => JSON.parse(l)).filter((c) => c[0] === "edit").pop();
    assert.deepEqual(edit, [
      "edit", "--tty=false", "km-web", "--cpus=4", "--memory=6", "--disk=40",
      `--set=.mounts = [{"location":"${mountDir}","mountPoint":"/workspace/m","writable":true}]`,
    ]);
    [info] = await provider.list();
    assert.deepEqual([info.cpus, info.memoryGiB, info.diskGiB], [4, 6, 40]);
    assert.equal(info.meta?.spec.mounts[0].guestPath, "/workspace/m");
    assert.equal(info.meta?.spec.provision, "echo hi", "fields left out of the patch are kept");

    // Nothing Lima-related changed: no limactl edit at all, and clearing the script works.
    const before = (await readFile(join(limaDir, "calls.log"), "utf8")).split("\n").length;
    await provider.edit("web", { provision: "" }, log);
    assert.equal((await readFile(join(limaDir, "calls.log"), "utf8")).split("\n").filter((l) => l.includes('"edit"')).length, 1);
    assert.ok(before > 0);
    [info] = await provider.list();
    assert.equal(info.meta?.spec.provision, undefined);
  });

  it("refuses to edit VMs Kumiko didn't create", async () => {
    const { limaDir, provider } = await fakeLima();
    await writeFile(join(limaDir, "km-alien.json"), JSON.stringify({ name: "km-alien", status: "Stopped" }));
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
