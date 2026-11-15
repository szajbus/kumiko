import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { land, signs } from "../src/landing.js";
import { sh } from "./repo.js";

/** As the user's Mac may have it: GPG with a key for their email, and a git config that names no key. */
describe("signing with GPG's key for the user's email", () => {
  let root: string;
  let dir: string;
  const saved = { ...process.env };

  before(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "kumiko-gpg-test-")));
    const gnupg = join(root, "gnupg");
    await mkdir(gnupg, { mode: 0o700 });
    process.env.GNUPGHOME = gnupg;
    execFileSync("gpg", ["--batch", "--quiet", "--passphrase", "", "--quick-gen-key", "Test <test@example.com>", "ed25519", "sign", "never"], { stdio: "ignore" });
    await writeFile(join(root, "gitconfig"), "[user]\n\tname = Test\n\temail = test@example.com\n[gpg]\n\tprogram = gpg\n");
    process.env.GIT_CONFIG_GLOBAL = join(root, "gitconfig");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    // A mirror to land in, and a "GitHub" it pushes to: a bare repository on disk is enough here, outside a hook.
    const github = join(root, "github.git");
    sh(root, "init", "--bare", "--quiet", "--initial-branch=main", github);
    const work = join(root, "work");
    sh(root, "clone", "--quiet", github, work);
    await writeFile(join(work, "a"), "a\n");
    sh(work, "add", "a");
    sh(work, "commit", "--quiet", "-m", "a");
    sh(work, "push", "--quiet", "origin", "main");
    sh(work, "checkout", "--quiet", "-b", "fix");
    await writeFile(join(work, "b"), "b\n");
    sh(work, "add", "b");
    sh(work, "commit", "--quiet", "-m", "b");
    sh(work, "push", "--quiet", "origin", "fix");
    dir = join(root, "mirror.git");
    sh(root, "clone", "--quiet", "--mirror", github, dir);
  });

  after(async () => {
    process.env = saved;
    await rm(root, { recursive: true, force: true });
  });

  it("signs when GPG has a key for the user's email, though their config names none", async () => {
    assert.equal(await signs(dir), true);
    const head = sh(dir, "rev-parse", "refs/heads/fix").trim();
    const landed = await land(dir, join(root, "github.git"), { branch: "fix", head, method: "merge", message: "Merge branch 'fix'\n", sign: true, fetch: async () => {} });
    assert.match(sh(join(root, "github.git"), "cat-file", "commit", landed.sha), /^gpgsig -----BEGIN PGP SIGNATURE-----/m);
  });

  it("doesn't, when GPG has no key for the user's email", async () => {
    await writeFile(join(root, "gitconfig"), "[user]\n\tname = Other\n\temail = other@example.com\n");
    assert.equal(await signs(dir), false);
  });
});
