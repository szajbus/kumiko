import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAccount, parseRateLimit, UsageCache, type Account } from "../src/usage.js";

const account = `{"loggedIn":true,"email":"a@b.c","subscriptionType":"max"}`;

/** A `rate_limit_event`'s info, as Claude 2.1.304 sends it, with the 5-hour window `used` (a fraction) and resetting at `resetsAt`. */
const info = (used: number, resetsAt = 1792768800) => ({
  status: "allowed",
  resetsAt,
  rateLimitType: "five_hour",
  overageStatus: "rejected",
  isUsingOverage: false,
  unifiedWindows: { five_hour: { utilization: used, resetsAt }, seven_day: { utilization: 1.2 }, seven_day_opus: null },
});

const later = () => Math.floor(Date.now() / 1000) + 3600;

describe("parseAccount", () => {
  it("reads the email and plan", () => {
    assert.deepEqual(parseAccount(account), { email: "a@b.c", plan: "max" });
  });

  it("knows nothing when Claude isn't logged in", () => {
    assert.deepEqual(parseAccount(""), {});
  });
});

describe("parseRateLimit", () => {
  it("reads the windows as percentages, clamped to 100%, with when they reset", () => {
    const windows = parseRateLimit(info(0.07))!;
    assert.deepEqual(windows.map((w) => [w.id, Math.round(w.usedPercent)]), [["five_hour", 7], ["seven_day", 100]]);
    assert.equal(windows[0].resetsAt, "2026-10-23T15:20:00.000Z");
    assert.equal(windows[1].resetsAt, undefined);
  });

  it("finds nothing in info without windows", () => {
    assert.equal(parseRateLimit(undefined), undefined);
    assert.equal(parseRateLimit({ status: "allowed" }), undefined);
    assert.equal(parseRateLimit({ unifiedWindows: {} }), undefined);
  });
});

/** A source that answers with `accounts` and counts what it was asked. */
function source(accounts: Record<string, Account>) {
  const calls = { account: 0 };
  return { calls, account: async (sandbox: string) => (calls.account++, accounts[sandbox] ?? {}) };
}

const used = async (cache: UsageCache, sandbox: string) => (await cache.get(sandbox)).windows.map((w) => Math.round(w.usedPercent));

describe("UsageCache", () => {
  it("has no usage until Claude reports some", async () => {
    const cache = new UsageCache(source({ a: { email: "x@y.z", plan: "max" } }));
    assert.deepEqual(await cache.get("a"), { email: "x@y.z", plan: "max", windows: [] });
    await cache.record("a", { status: "allowed" });
    assert.deepEqual((await cache.get("a")).windows, []);
  });

  it("shares a report between sandboxes on the same account, and the latest wins", async () => {
    const s = source({ a: { email: "x@y.z" }, b: { email: "x@y.z" } });
    const cache = new UsageCache(s);
    await cache.record("a", info(0.07, later()));
    assert.deepEqual(await used(cache, "b"), [7, 100]);
    assert.ok((await cache.get("b")).fetchedAt);
    await cache.record("b", info(0.09, later()));
    assert.deepEqual(await used(cache, "a"), [9, 100]);
    assert.equal(s.calls.account, 2, "each sandbox's account is asked once");
  });

  it("keeps sandboxes on different accounts, or unknown ones, apart", async () => {
    const cache = new UsageCache(source({ a: { email: "1@y.z" }, b: { email: "2@y.z" } }));
    await cache.record("a", info(0.01, later()));
    await cache.record("b", info(0.02, later()));
    await cache.record("c", info(0.03, later()));
    assert.deepEqual(await used(cache, "a"), [1, 100]);
    assert.deepEqual(await used(cache, "b"), [2, 100]);
    assert.deepEqual(await used(cache, "c"), [3, 100]);
    assert.deepEqual(await used(cache, "d"), []);
  });

  it("shows a window that has reset since as unused", async () => {
    const cache = new UsageCache(source({ a: { email: "x@y.z" } }));
    await cache.record("a", info(0.5, Math.floor(Date.now() / 1000) - 60));
    const [five] = (await cache.get("a")).windows;
    assert.deepEqual(five, { id: "five_hour", label: "Session (5h)", usedPercent: 0 });
  });

  it("drops a sandbox's usage and account when its login is forgotten", async () => {
    const s = source({ a: { email: "x@y.z" } });
    const cache = new UsageCache(s);
    await cache.record("a", info(0.07, later()));
    cache.forget("a");
    assert.deepEqual(await used(cache, "a"), []);
    assert.equal(s.calls.account, 2);
  });
});
