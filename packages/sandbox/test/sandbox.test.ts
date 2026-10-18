import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { defaultGuestPath } from "@bentomo/shared";
import { execScript, mountsExpression, parseLimaList, provisionCommand, tidyLimaLine, validateSpec } from "../src/index.js";
import { fakeLima } from "./helpers.js";

const spec = (over = {}) => ({ name: "web", cpus: 4, memoryGiB: 4, diskGiB: 100, mounts: [], env: [], ...over });

describe("parsing", () => {
  it("reads limactl's one-object-per-line JSON and arrays", () => {
    const a = { name: "bm-a", status: "Running" }, b = { name: "wm-b", status: "Stopped" };
    assert.deepEqual(parseLimaList(`${JSON.stringify(a)}\n${JSON.stringify(b)}\n`), [a, b]);
    assert.deepEqual(parseLimaList(JSON.stringify([a, b])), [a, b]);
    assert.deepEqual(parseLimaList("\n"), []);
  });

  it("tidies logfmt lines", () => {
    assert.deepEqual(tidyLimaLine('time="x" level=info msg="Starting \\"bm-a\\""'), { text: 'Starting "bm-a"' });
    assert.deepEqual(tidyLimaLine('time="x" level=fatal msg="boom"'), { text: "error: boom", kind: "err" });
    assert.deepEqual(tidyLimaLine("plain"), { text: "plain" });
  });

  it("quotes forwarded values and skips unset ones", () => {
    const s = execScript("cat", ["A", "B"], { A: "it's $x" });
    assert.equal(s, "export A='it'\\''s $x'\nexec cat\n");
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
    assert.equal(defaultGuestPath("/a/b/c/d/"), "/workspace/d");
  });

  it("wraps a provisioning script so it can't be read from stdin", () => {
    const cmd = provisionCommand("echo hi");
    assert.match(cmd, /^bash -c "\$\(cat <<'BENTOMO_PROVISION_[0-9a-f]+'\n/);
    assert.match(cmd, /set -e\n/);
  });
});

describe("validateSpec", () => {
  it("accepts a minimal spec and normalizes it", async () => {
    const v = await validateSpec(spec({ template: " ", provision: "  " }));
    assert.deepEqual(v.errors, []);
    assert.equal(v.spec.template, undefined);
    assert.equal(v.spec.provision, undefined);
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
    for (const needle of ["Name", "CPUs", "Disk", "does not exist", "absolute", "relative/in/vm can't", "~ can't", "overlap in the VM"]) {
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
    assert.match(clash.errors.join(), /overlap in the VM/);
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
  it("lists only bm- instances", async () => {
    const { limaDir, provider } = await fakeLima();
    await writeFile(join(limaDir, "wm-other.json"), JSON.stringify({ name: "wm-other", status: "Running" }));
    await writeFile(join(limaDir, "bm-mine.json"), JSON.stringify({ name: "bm-mine", status: "Broken", cpus: 2, memory: 2 * 1024 ** 3 }));
    assert.deepEqual(await provider.list(), [
      { name: "mine", status: "broken", cpus: 2, memoryGiB: 2, diskGiB: undefined, meta: undefined },
    ]);
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
      "create", "--tty=false", "--name=bm-web", "--cpus=4", "--memory=4", "--disk=100",
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

  it("uses --mount-none when no mounts are selected", async () => {
    const { limaDir, provider, log } = await fakeLima();
    await provider.create(spec({ template: "template:debian-12" }), log);
    const create = (await readFile(join(limaDir, "calls.log"), "utf8")).split("\n").find((l) => l.includes('"create"'))!;
    assert.ok(create.includes('"--mount-none"'));
    assert.ok(create.includes('"template:debian-12"'));
  });

  it("keeps a sandbox whose provisioning failed, and re-runs it", async () => {
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

    await writeFile(marker, "");
    await provider.provision("web", log);
    [info] = await provider.list();
    assert.equal(info.meta?.setup, "ready");
    assert.equal(info.meta?.provisionExitCode, undefined);
  });

  it("refuses a name that is taken and removes metadata when limactl create fails", async () => {
    const { provider, log } = await fakeLima();
    await provider.create(spec(), log);
    const v = await provider.validate(spec());
    assert.match(v.errors.join(), /bm-web already exists/);

    process.env.FAKE_LIMA_FAIL_CREATE = "1";
    try {
      await assert.rejects(provider.create(spec({ name: "other" }), log), /simulated create failure/);
    } finally {
      delete process.env.FAKE_LIMA_FAIL_CREATE;
    }
    assert.equal(await provider.metadata.read("other"), undefined);
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
});
