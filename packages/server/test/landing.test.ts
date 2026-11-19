import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { land, signingKey, signs, usableKey } from "../src/landing.js";
import { sh } from "./repo.js";
import { shortTmp } from "./tmp.js";

/** As the user's Mac may have it: GPG with a key for their email, and a git config that names no key. */
describe("signing with GPG's key for the user's email", () => {
  let root: string;
  let dir: string;
  const saved = { ...process.env };

  before(async () => {
    root = await shortTmp("kumiko-gpg-test-");
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
    // GitHub's branches where Kumiko's mirrors keep them, too.
    sh(dir, "fetch", "--quiet", github, "+refs/heads/*:refs/github/heads/*");
  });

  after(async () => {
    process.env = saved;
    await rm(root, { recursive: true, force: true });
  });

  it("signs when GPG has a key for the user's email, though their config names none", async () => {
    assert.equal(await signs(dir), true);
    const head = sh(dir, "rev-parse", "refs/heads/fix").trim();
    const landed = await land(dir, join(root, "github.git"), { branch: "fix", head, method: "merge", message: "Merge branch 'fix'\n", sign: await signingKey(dir), base: "main", fetch: async () => void sh(dir, "fetch", "--quiet", "origin", "+refs/heads/*:refs/github/heads/*") });
    assert.match(sh(join(root, "github.git"), "cat-file", "commit", landed.sha), /^gpgsig -----BEGIN PGP SIGNATURE-----/m);
  });

  it("signs with the key it found when the key's user ID doesn't match the user's name, where git's own lookup fails", async () => {
    execFileSync("gpg", ["--batch", "--quiet", "--passphrase", "", "--quick-gen-key", "Real Name (work) <work@example.com>", "ed25519", "sign", "never"], { stdio: "ignore" });
    await writeFile(join(root, "gitconfig"), "[user]\n\tname = Real\n\temail = work@example.com\n[commit]\n\tgpgsign = true\n");
    const key = await signingKey(dir);
    assert.match(key?.key ?? "", /^[0-9A-F]{40}$/);
    const head = sh(dir, "rev-parse", "refs/heads/fix").trim();
    const landed = await land(dir, join(root, "github.git"), { branch: "fix", head, method: "squash", message: "Fix\n", sign: key, base: "main", fetch: async () => void sh(dir, "fetch", "--quiet", "origin", "+refs/heads/*:refs/github/heads/*") });
    assert.match(sh(join(root, "github.git"), "cat-file", "commit", landed.sha), /^gpgsig -----BEGIN PGP SIGNATURE-----/m);
  });

  it("doesn't, when GPG has no usable key for the user's email, and then doesn't try, even with commit.gpgsign on", async () => {
    // Made in 2000, for a day: expired since.
    execFileSync("gpg", ["--batch", "--quiet", "--faked-system-time", "20000101T000000!", "--passphrase", "", "--quick-gen-key", "Old <old@example.com>", "ed25519", "sign", "1d"], { stdio: "ignore" });
    for (const email of ["other@example.com", "old@example.com"]) {
      await writeFile(join(root, "gitconfig"), `[user]\n\tname = Other\n\temail = ${email}\n[commit]\n\tgpgsign = true\n`);
      assert.equal(await signs(dir), false, email);
    }
    const head = sh(dir, "rev-parse", "refs/heads/fix").trim();
    const landed = await land(dir, join(root, "github.git"), { branch: "fix", head, method: "squash", message: "Fix, unsigned\n", sign: undefined, base: "main", fetch: async () => void sh(dir, "fetch", "--quiet", "origin", "+refs/heads/*:refs/github/heads/*") });
    assert.doesNotMatch(sh(join(root, "github.git"), "cat-file", "commit", landed.sha), /^gpgsig/m);
    assert.equal(landed.signed, false);
  });

  it("doesn't with SSH and no key named", async () => {
    await writeFile(join(root, "gitconfig"), "[user]\n\tname = Test\n\temail = test@example.com\n[gpg]\n\tformat = ssh\n");
    assert.equal(await signs(dir), false);
  });

  it("picks a secret key that can sign from GPG's listing", () => {
    const fpr = (f: string) => `fpr:::::::::${f}:`;
    assert.equal(usableKey(["sec:u:255:22:A:1::::::scESC:::+:::23::0:", fpr("AAAA"), "uid:u::::1::X::Me <me@x>::::::::::0:"].join("\n")), "AAAA");
    assert.equal(usableKey(["sec:e:255:22:B:1::::::sc:::+:::23::0:", fpr("BBBB"), "sec:u:255:22:C:1::::::scESC:::+:::23::0:", fpr("CCCC")].join("\n")), "CCCC", "an expired one is skipped");
    assert.equal(usableKey(["sec:u:255:22:D:1::::::scE:::+:::23::0:", fpr("DDDD")].join("\n")), undefined, "can't sign");
    assert.equal(usableKey(["sec:u:255:22:E:1::::::scESC:::#:::23::0:", fpr("EEEE")].join("\n")), undefined, "its secret part is elsewhere");
    assert.equal(usableKey(""), undefined);
  });
});
