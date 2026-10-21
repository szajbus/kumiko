// Cuts a release: dates the version's changelog section, sets the app's version, commits and tags that, and pushes
// both. The tag starts the release workflow, which builds the app into a draft GitHub release.
//   npm run release 0.2.0
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

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
run("git", "fetch", "--tags", "origin", "main");
try {
  git("merge-base", "--is-ancestor", "origin/main", "HEAD");
} catch {
  fail("main is behind origin/main. Pull first.");
}
if (git("tag", "--list", tag)) fail(`${tag} already exists.`);

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
