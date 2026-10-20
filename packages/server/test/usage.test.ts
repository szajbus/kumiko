import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAccount, parseUsage, UsageCache, type Account, type UsageReading } from "../src/usage.js";

const account = `{"loggedIn":true,"email":"a@b.c","subscriptionType":"max"}`;
const usage = `{"five_hour":{"utilization":7.0,"resets_at":"2026-10-19T17:09:59+00:00"},"seven_day":{"utilization":120},"seven_day_opus":null}`;

describe("parseAccount", () => {
  it("reads the email and plan", () => {
    assert.deepEqual(parseAccount(account), { email: "a@b.c", plan: "max" });
  });

  it("knows nothing when Claude isn't logged in", () => {
    assert.deepEqual(parseAccount(""), {});
  });
});

describe("parseUsage", () => {
  it("reads the usage windows, clamped to 100%", () => {
    const u = parseUsage(`${usage}\n---status---200\n`);
    assert.ok("windows" in u);
    assert.deepEqual(u.windows.map((w) => [w.id, w.usedPercent]), [["five_hour", 7], ["seven_day", 100]]);
    assert.equal(u.windows[0].resetsAt, "2026-10-19T17:09:59+00:00");
  });

  it("tells a missing login from a rate limit, an expired token and a network failure", () => {
    const error = (out: string, failure?: string) => (parseUsage(out, failure) as { error: string }).error;
    assert.match(error("---no-token---"), /no subscription login/);
    assert.match(error(`{"error":{"type":"rate_limit_error"}}\n---status---429`), /limiting/);
    assert.match(error(`{}\n---status---401`), /expired/);
    assert.match(error(`\n---status---000`, "curl: (6) Could not resolve host"), /Could not resolve host/);
    assert.match(error(`<html>\n---status---200`), /format/);
  });
});

/** A source that answers from `readings` in turn and counts what it was asked. */
function source(accounts: Record<string, Account>, readings: UsageReading[]) {
  const calls = { account: 0, usage: [] as string[] };
  return {
    calls,
    account: async (sandbox: string) => (calls.account++, accounts[sandbox] ?? {}),
    usage: async (sandbox: string) => (calls.usage.push(sandbox), readings.shift() ?? { error: "no more readings" }),
  };
}

const win = (usedPercent: number) => ({ windows: [{ id: "five_hour", label: "Session (5h)", usedPercent }] });

describe("UsageCache", () => {
  it("reads usage once for sandboxes on the same account", async () => {
    const s = source({ a: { email: "x@y.z" }, b: { email: "x@y.z" } }, [win(7)]);
    const cache = new UsageCache(s);
    const [a, b] = await Promise.all([cache.get("a"), cache.get("b")]);
    await cache.get("a");
    assert.deepEqual(s.calls.usage, ["a"]);
    assert.equal(a.windows[0].usedPercent, 7);
    assert.deepEqual(b.windows, a.windows);
    assert.equal(s.calls.account, 2);
  });

  it("keeps sandboxes on different accounts apart", async () => {
    const s = source({ a: { email: "1@y.z" }, b: { email: "2@y.z" } }, [win(1), win(2)]);
    const cache = new UsageCache(s);
    assert.equal((await cache.get("a")).windows[0].usedPercent, 1);
    assert.equal((await cache.get("b")).windows[0].usedPercent, 2);
  });

  it("keeps the last windows after a failed reading, with the reason, and reads again once it expires", async () => {
    const s = source({ a: { email: "x@y.z" } }, [win(7), { error: "rate limited" }, win(9)]);
    const cache = new UsageCache(s, { usageTtlMs: 10, retryMs: 10 });
    const first = await cache.get("a");
    await new Promise((r) => setTimeout(r, 20));
    const stale = await cache.get("a");
    assert.equal(stale.error, "rate limited");
    assert.equal(stale.windows[0].usedPercent, 7);
    assert.equal(stale.fetchedAt, first.fetchedAt);
    assert.equal((await cache.get("a")).error, "rate limited", "waits before retrying");
    await new Promise((r) => setTimeout(r, 20));
    const fresh = await cache.get("a");
    assert.equal(fresh.error, undefined);
    assert.equal(fresh.windows[0].usedPercent, 9);
  });

  it("reads again after forgetting a sandbox's login", async () => {
    const s = source({ a: { email: "x@y.z" } }, [win(7), win(8)]);
    const cache = new UsageCache(s);
    await cache.get("a");
    cache.forget("a");
    assert.equal((await cache.get("a")).windows[0].usedPercent, 8);
    assert.equal(s.calls.account, 2);
  });
});
