// Cuts a release of the unstable build that was tried: dates the version's changelog section, sets the app's version,
// commits and tags that, and pushes both. The tag starts the release workflow, which builds the app into a draft
// GitHub release.
//   npm run release 0.2.0
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const version = process.argv[2];
const tag = `v${version}`;

function fail(message) {
  console.error(message);
  process.exit(1);
}
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const run = (cmd, ...args) => execFileSync(cmd, args, { stdio: "inherit" });

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? "")) fail("Usage: npm run release <version>, e.g. 0.2.0");
if (git("branch", "--show-current") !== "main") fail("Release from main.");
if (git("status", "--porcelain")) fail("Commit or stash your changes first.");
try {
  git("remote", "get-url", "origin");
} catch {
  fail("There's no origin remote to push the release to.");
}
// --force, because the unstable tag moves with every build.
run("git", "fetch", "--tags", "--force", "origin", "main");
try {
  git("merge-base", "--is-ancestor", "origin/main", "HEAD");
} catch {
  fail("main is behind origin/main. Pull first.");
}
if (git("tag", "--list", tag)) fail(`${tag} already exists.`);

// Release what was tried: the unstable build's commit, plus at most the changelog written after trying it.
if (!git("tag", "--list", "unstable")) fail("There's no unstable build yet. Push to main and try the build first.");
const unstable = git("rev-parse", "unstable^{commit}");
try {
  git("merge-base", "--is-ancestor", unstable, "HEAD");
} catch {
  fail("The unstable build isn't from main's history. Wait for the build of main, and try that.");
}
const since = git("diff", "--name-only", unstable, "HEAD").split("\n").filter((f) => f && f !== "CHANGELOG.md");
if (since.length) fail(`main has changes the unstable build doesn't, in ${since.join(", ")}. Wait for its build, and try that.`);
const build = git("tag", "--list", "--format=%(contents:subject)", "unstable");
const subject = git("log", "-1", "--format=%h %s", unstable);
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question(`Release ${build} (${subject}) as ${version}? [y/N] `);
rl.close();
if (answer.trim().toLowerCase() !== "y") fail("Not released.");

// The section is written as "## 0.2.0" and dated here, so the date is the day it ships.
const changelog = readFileSync("CHANGELOG.md", "utf8");
const heading = new RegExp(`^## ${version.replaceAll(".", "\\.")}(?: — \\d{4}-\\d{2}-\\d{2})?$`, "m");
if (!heading.test(changelog)) fail(`Write a "## ${version}" section in CHANGELOG.md first.`);
const today = new Date().toISOString().slice(0, 10);
writeFileSync("CHANGELOG.md", changelog.replace(heading, `## ${version} — ${today}`));

// Set by hand: npm version would reformat package.json and drop its one-line arrays.
const pkg = readFileSync("apps/desktop/package.json", "utf8");
writeFileSync("apps/desktop/package.json", pkg.replace(/^(  "version": )"[^"]*"/m, `$1"${version}"`));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
lock.packages["apps/desktop"].version = version;
writeFileSync("package-lock.json", `${JSON.stringify(lock, null, 2)}\n`);
run("git", "add", "CHANGELOG.md", "apps/desktop/package.json", "package-lock.json");
run("git", "commit", "--allow-empty", "-m", `Release ${version}`);
run("git", "tag", "-a", tag, "-m", `Kumiko ${version}`);
run("git", "push", "--atomic", "origin", "main", tag);
console.log(`\nPushed ${tag}. The Release workflow builds it into a draft release on GitHub; try the app, then publish it.`);
