// The projects spec's checks against real Lima: same-path mounts of a clone and its worktrees folder, a worktree made
// in the VM that git on the host can read (the spec's "not validated" item), and the Claude home behind CLAUDE_CONFIG_DIR.
//
//   node packages/server/dist/scripts/projects-check.js [--name projcheck] [--template template:debian-12] [--keep]
//
// It makes a throwaway clone (with a bare "origin") and Bentomo data under the temp folder, so nothing of yours is touched.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { eachLine, exitCode, LimaProvider, MetadataStore, shellQuote, type Log } from "@bentomo/sandbox";
import { worktreeStatuses } from "../src/git.js";
import { ProjectStore } from "../src/projects.js";

const { values } = parseArgs({
  options: {
    name: { type: "string", default: "projcheck" },
    template: { type: "string", default: "template:debian-12" },
    keep: { type: "boolean", default: false },
  },
});
const name = values.name!;
const step = (s: string) => console.log(`\n=== ${s} ===`);
const log: Log = (line, kind) => console.log(`${kind ? `[${kind}] ` : ""}${line}`);
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Bentomo", GIT_AUTHOR_EMAIL: "check@bentomo", GIT_COMMITTER_NAME: "Bentomo", GIT_COMMITTER_EMAIL: "check@bentomo" },
  });

const root = await realpath(await mkdtemp(join(tmpdir(), "bentomo-projects-check-")));
const data = join(root, "bentomo");
const provider = new LimaProvider({ metadata: new MetadataStore(join(data, "sandboxes")) });
const projects = new ProjectStore(data);

/** Runs a script in the VM; resolves with its output, rejects when it fails. */
const vm = async (script: string): Promise<string> => {
  const child = provider.exec(name, `bash -c ${shellQuote(`set -e\n${script}`)}`, []);
  child.stdin!.end();
  const out: string[] = [];
  eachLine(child.stdout!, (l) => out.push(l));
  eachLine(child.stderr!, (l) => out.push(l));
  const code = await exitCode(child);
  if (code !== 0) throw new Error(`exit ${code} in the VM:\n${out.join("\n")}`);
  return out.join("\n");
};

let ok = false;
try {
  step(`a clone at ${root}/repo`);
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", "origin.git");
  git(root, "clone", "--quiet", join(root, "origin.git"), "repo");
  const clone = join(root, "repo");
  await writeFile(join(clone, "README"), "check\n");
  git(clone, "add", "README");
  git(clone, "commit", "--quiet", "-m", "first");
  git(clone, "push", "--quiet", "-u", "origin", "main");

  step(`project ${name}: check, create the worktrees folder and Claude home, create the VM`);
  const checked = await projects.check(name, clone);
  if (checked.errors.length) throw new Error(checked.errors.join("\n"));
  const { project } = await projects.create(name, checked.clonePath!, checked.worktreesPath!);
  const spec = projects.spec(project, { template: values.template, cpus: 2, memoryGiB: 2, diskGiB: 10, mounts: [], env: [] });
  await provider.create(spec, log);

  step("same paths in the VM: the clone is a git repository there too");
  console.log(await vm(`cd ${shellQuote(project.clonePath)}; pwd; git --version; git status --short --branch`));
  console.log("clone at the same path ✓");

  step("a worktree made in the VM, with a commit");
  const wt = join(project.worktreesPath, "from-vm");
  console.log(
    await vm(
      [
        `cd ${shellQuote(project.clonePath)}`,
        `git worktree add ${shellQuote(wt)} -b from-vm`,
        `cd ${shellQuote(wt)}`,
        `echo made in the VM > vm.txt`,
        `git add vm.txt`,
        `git -c user.name=Bentomo -c user.email=check@bentomo commit -q -m "from the VM"`,
        `git worktree list --porcelain`,
      ].join("\n"),
    ),
  );

  step("git on the host reads that worktree");
  console.log(git(wt, "status", "--short", "--branch"));
  console.log(git(wt, "log", "--oneline", "-1"));
  const status = await worktreeStatuses(project.clonePath);
  const seen = status.worktrees.find((w) => w.branch === "from-vm");
  console.log(JSON.stringify(status, null, 2));
  if (!seen || seen.path !== wt || seen.unpushed !== 1 || seen.error || seen.prunable) throw new Error("the host doesn't see the VM's worktree as expected");
  console.log("host sees the VM-created worktree at the same path ✓");

  step("and the other way: a worktree made on the host works in the VM");
  const hostWt = join(project.worktreesPath, "from-host");
  git(project.clonePath, "worktree", "add", "--quiet", hostWt, "-b", "from-host");
  console.log(await vm(`cd ${shellQuote(hostWt)}; git status --short --branch; git -C ${shellQuote(project.clonePath)} worktree list`));
  console.log("VM sees the host-created worktree ✓");

  step("CLAUDE_CONFIG_DIR is the mounted Claude home");
  const probe = await vm(`echo "$CLAUDE_CONFIG_DIR"; ls -a "$CLAUDE_CONFIG_DIR"; echo probe > "$CLAUDE_CONFIG_DIR/probe"; claude --version`);
  console.log(probe);
  if ((await readFile(join(projects.claudeHome(name), "probe"), "utf8")).trim() !== "probe") throw new Error("the Claude home isn't the mounted folder");
  console.log("the VM writes into the project's Claude home on the host ✓");

  ok = true;
  console.log(`\nAll checks passed.`);
  console.log(`Still to check by hand: run \`limactl shell bm-${name}\`, then \`claude\` in ${project.clonePath}, log in, and ask what it`);
  console.log(`was told about worktrees: that shows the @bentomo.md import in ${projects.claudeHome(name)}/CLAUDE.md works,`);
  console.log(`and ${projects.claudeHome(name)}/.claude.json should appear (not on the VM's disk). Run with --keep for that.`);
} finally {
  if (!values.keep) {
    step("delete");
    await provider.delete(name, log).catch((err) => console.error(`couldn't delete bm-${name}: ${err instanceof Error ? err.message : err}`));
    await projects.remove(name);
  } else {
    console.log(`\nKept bm-${name} and ${root}. Delete them with: limactl delete --force bm-${name}; rm -rf ${root}`);
  }
}
process.exit(ok ? 0 : 1);
