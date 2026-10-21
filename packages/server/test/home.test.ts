import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { homeId, HomeLocked, lockHome } from "../src/home.js";

const fresh = () => mkdtemp(join(tmpdir(), "kumiko-home-test-"));

describe("the Kumiko home", () => {
  it("is used by one server at a time", async () => {
    const home = await fresh();
    const lock = await lockHome(home);
    await assert.rejects(lockHome(home, { waitMs: 100 }), HomeLocked, "a second server in the same process");
    await lock.setPort(4317);
    const record = JSON.parse(await readFile(join(home, "server.lock"), "utf8"));
    assert.deepEqual([record.pid, record.port], [process.pid, 4317]);
    await lock.release();
    assert.ok(!existsSync(join(home, "server.lock")));
    await (await lockHome(home)).release();
  });

  it("waits for a server that is letting go of it", async () => {
    const home = await fresh();
    const first = await lockHome(home);
    setTimeout(() => void first.release(), 200);
    await (await lockHome(home, { waitMs: 3000 })).release();
  });

  it("refuses a live server in another process, naming it", async () => {
    const home = await fresh();
    // The parent (the test runner) is live, and its command line is as recorded.
    const command = execFileSync("ps", ["-o", "command=", "-p", String(process.ppid)], { encoding: "utf8" }).trim();
    await writeFile(join(home, "server.lock"), JSON.stringify({ pid: process.ppid, port: 4999, command }));
    await assert.rejects(lockHome(home, { waitMs: 100 }), (err: Error) => err instanceof HomeLocked && /pid \d+, port 4999/.test(err.message));
  });

  it("takes over a lock whose server has gone, or whose pid is someone else's now", async () => {
    const home = await fresh();
    await writeFile(join(home, "server.lock"), JSON.stringify({ pid: 2 ** 22 + 12345, command: "node server" }));
    await (await lockHome(home, { waitMs: 100 })).release();
    await writeFile(join(home, "server.lock"), JSON.stringify({ pid: process.ppid, command: "not what runs under that pid" }));
    await (await lockHome(home, { waitMs: 100 })).release();
  });

  it("has an id of its own, which stays", async () => {
    const [a, b] = [await fresh(), await fresh()];
    const id = await homeId(a);
    assert.match(id, /^[0-9a-f]{16}$/);
    assert.equal(await homeId(a), id);
    assert.notEqual(await homeId(b), id);
  });
});
