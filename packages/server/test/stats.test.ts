import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it } from "node:test";
import { parseStats, statsScript, StatsCache } from "../src/stats.js";

/** A reading as `statsScript` prints it, with CPU counters whose busy and idle parts are `busy` and `idle`. */
const line = (busy: number, idle: number) => `${busy} 0 0 ${idle} 0 0 0 0|8000000 6000000|6000000 26000000|1.25`;

describe("parseStats", () => {
  it("reads memory, disk and load, in bytes", () => {
    assert.deepEqual(parseStats(line(100, 900))?.stats, {
      load: 1.25,
      memTotalBytes: 8000000 * 1024,
      memUsedBytes: 2000000 * 1024,
      diskUsedBytes: 6000000 * 1024,
      diskFreeBytes: 26000000 * 1024,
    });
  });

  it("tells how busy the CPUs were since the reading before, counting iowait as idle", () => {
    const first = parseStats(line(100, 900))!;
    assert.equal(first.stats.cpuPercent, undefined);
    assert.equal(parseStats(line(130, 970), first.cpu)?.stats.cpuPercent, 30);
    assert.equal(parseStats("400 0 0 900 100 0 0 0|8 6|6 26|0", parseStats("300 0 0 900 0 0 0 0|8 6|6 26|0")!.cpu)?.stats.cpuPercent, 50);
  });

  it("skips lines that aren't readings", () => {
    for (const bad of ["", "hello", "1 2 3|8 6|6 26|1", `${line(1, 1)}|extra`, line(1, 1).replace("1.25", "x")]) assert.equal(parseStats(bad), undefined, bad);
  });

  it("reads what the script prints on Linux", { skip: process.platform !== "linux" }, async () => {
    const child = spawn("bash", ["-c", statsScript(1)]);
    const first = await new Promise<string>((resolve) => child.stdout.setEncoding("utf8").once("data", resolve));
    child.kill();
    const stats = parseStats(first.trim())?.stats;
    assert.ok(stats && stats.memTotalBytes > 0 && stats.diskFreeBytes > 0, first);
  });
});

/** Runs each exec's command on this machine instead, printing `lines` and then waiting, and keeps what it started. */
function fakeExec(lines = [line(100, 900), line(150, 950)]) {
  const started: { name: string; child: ChildProcess }[] = [];
  const exec = (name: string) => {
    const child = spawn("bash", ["-c", `printf '%s\\n' ${lines.map((l) => `'${l}'`).join(" ")}; exec sleep 30`], { stdio: "pipe" });
    started.push({ name, child });
    return child;
  };
  return { exec, started };
}

const exited = (c: ChildProcess) => c.exitCode !== null || c.signalCode !== null;

describe("StatsCache", () => {
  it("keeps one sampler per running VM and answers with its latest reading", async () => {
    const { exec, started } = fakeExec();
    const cache = new StatsCache(exec);
    try {
      assert.deepEqual(cache.get(["a", "b"]), {}, "nothing is known before the first line");
      await sleep(300);
      const got = cache.get(["a", "b"]);
      assert.deepEqual(Object.keys(got).sort(), ["a", "b"]);
      assert.equal(got.a.cpuPercent, 50);
      assert.equal(started.length, 2, "asking again reuses the samplers");
    } finally {
      cache.stopAll();
    }
  });

  it("stops the sampler of a VM that is no longer running", async () => {
    const { exec, started } = fakeExec();
    const cache = new StatsCache(exec);
    try {
      cache.get(["a", "b"]);
      cache.get(["b"]);
      await sleep(100);
      assert.ok(exited(started[0].child), "a's sampler was stopped");
      assert.ok(!exited(started[1].child));
    } finally {
      cache.stopAll();
    }
  });

  it("stops a sampler nobody has asked for in a while", async () => {
    const { exec, started } = fakeExec();
    const cache = new StatsCache(exec, { idleMs: 150 });
    try {
      cache.get(["a"]);
      await sleep(100);
      cache.get(["a"]);
      await sleep(100);
      assert.ok(!exited(started[0].child), "asking keeps it going");
      await sleep(250);
      assert.ok(exited(started[0].child));
      cache.get(["a"]);
      assert.equal(started.length, 2, "asking again starts a new one");
    } finally {
      cache.stopAll();
    }
  });

  it("waits before starting again a sampler that ended by itself", async () => {
    let calls = 0;
    const exec = () => (calls++, spawn("bash", ["-c", "exit 255"], { stdio: "pipe" }));
    const cache = new StatsCache(exec, { retryMs: 200 });
    cache.get(["a"]);
    await sleep(100);
    assert.deepEqual(cache.get(["a"]), {});
    assert.equal(calls, 1, "not retried at once");
    await sleep(200);
    cache.get(["a"]);
    assert.equal(calls, 2);
    cache.stopAll();
  });
});
