// Checks the workspace disk against real Lima (2.3 or later): created with the sandbox and mounted at /workspace,
// grown while stopped, kept through a recreate with everything on it, and deleted with the sandbox.
//
//   node packages/sandbox/dist/scripts/workspace-disk.js [--name wsdisk] [--template template:debian-12] [--keep]
//
// What goes on the disk is what a recreate must keep: a file, a commit, a stash and an uncommitted change.
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { workspaceDiskName } from "@kumiko/shared";
import { exitCode, LimaProvider, type Log } from "../src/index.js";

const { values } = parseArgs({
  options: {
    name: { type: "string", default: "wsdisk" },
    template: { type: "string", default: "template:debian-12" },
    keep: { type: "boolean", default: false },
  },
});

const name = values.name!;
const disk = workspaceDiskName(name);
const provider = new LimaProvider();
const log: Log = (line, kind) => console.log(`${kind ? `[${kind}] ` : ""}${line}`);
const step = (s: string) => console.log(`\n=== ${s} ===`);
const check = (ok: boolean, what: string, detail = "") => {
  if (!ok) throw new Error(`${what} ✗ ${detail}`);
  console.log(`${what} ✓`);
};

/** Runs a script in the VM, from /workspace, and returns its output; fails on a non-zero exit. */
async function vm(script: string): Promise<string> {
  const child = provider.exec(name, `bash -c ${JSON.stringify(`set -e\n${script}`)}`, [], { cwd: "/workspace" });
  child.stdin!.end();
  let out = "";
  child.stdout!.on("data", (c) => (out += c));
  child.stderr!.on("data", (c) => (out += c));
  const code = await exitCode(child);
  if (code !== 0) throw new Error(`exit ${code} in the VM:\n${out}`);
  return out.trim();
}

const limaDisks = () => execFileSync(process.env.KUMIKO_LIMACTL ?? "limactl", ["disk", "ls", "--json"], { encoding: "utf8" });
const spec = (workspaceGiB: number) => ({
  name,
  template: values.template,
  cpus: 2,
  memoryGiB: 2,
  diskGiB: 10,
  workspaceGiB,
  mounts: [],
  env: [],
});

let ok = false;
try {
  step(`create km-${name} with a 2 GiB workspace disk`);
  await provider.create(spec(2), log);
  check((await vm("findmnt -no TARGET /workspace")) === "/workspace", "the disk is mounted at /workspace");
  check((await vm(`stat -c %U /workspace`)) === (await vm("id -un")), "/workspace belongs to the VM user");
  check((await vm("pwd")) === "/workspace", "commands start in /workspace");
  await vm(`
    echo kept > marker
    git init -q repo && cd repo
    git -c user.name=t -c user.email=t@t.invalid commit -q --allow-empty -m first
    echo stashed > s && git add s && git stash -q
    echo uncommitted > u
    sync`);

  step("grow it to 3 GiB while stopped");
  await provider.stop(name, log);
  await provider.edit(name, { workspaceGiB: 3 }, log);
  await provider.start(name, log);
  const size = Number(await vm("df -B1 --output=size /workspace | tail -1"));
  check(size > 2.5 * 1024 ** 3, "the filesystem grew", `${size} bytes`);

  step("recreate: delete the VM, keep the disk, create it again");
  await provider.delete(name, log, { keepWorkspace: true });
  check(limaDisks().includes(`"${disk}"`), "the disk outlived the VM");
  await provider.create(spec(3), log);
  check((await vm("cat marker")) === "kept", "the file is there");
  check((await vm("git -C repo log --format=%s")) === "first", "the commit is there");
  check((await vm("git -C repo stash list | wc -l")) === "1", "the stash is there");
  check((await vm("cat repo/u")) === "uncommitted", "the uncommitted change is there");
  check((await vm(`stat -c %U /workspace`)) === (await vm("id -un")), "/workspace still belongs to the VM user");
  ok = true;
} finally {
  if (!values.keep) {
    step("delete the sandbox and its disk");
    await provider.delete(name, log).catch((e) => console.error(String(e)));
    if (limaDisks().includes(`"${disk}"`)) {
      console.error(`${disk} is still there`);
      ok = false;
    }
  }
}
console.log(ok ? "\nworkspace disk OK" : "\nworkspace disk FAILED");
process.exit(ok ? 0 : 1);
