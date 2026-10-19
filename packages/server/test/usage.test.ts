import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AccountUsage } from "@bentomo/shared";
import { parseProbe, UsageCache } from "../src/usage.js";

const now = new Date("2026-10-19T12:00:00Z");
const account = `{"loggedIn":true,"email":"a@b.c","subscriptionType":"max"}`;
const usage = `{"five_hour":{"utilization":7.0,"resets_at":"2026-10-19T17:09:59+00:00"},"seven_day":{"utilization":120},"seven_day_opus":null}`;

describe("parseProbe", () => {
  it("reads the account and the usage windows, clamped to 100%", () => {
    const u = parseProbe(`---account---\n${account}\n---usage---\n${usage}\n`, now);
    assert.equal(u.email, "a@b.c");
    assert.equal(u.plan, "max");
    assert.deepEqual(u.windows.map((w) => [w.id, w.usedPercent]), [["five_hour", 7], ["seven_day", 100]]);
    assert.equal(u.windows[0].resetsAt, "2026-10-19T17:09:59+00:00");
    assert.equal(u.error, undefined);
  });

  it("keeps the account when there is no token to read usage with", () => {
    const u = parseProbe(`---account---\n${account}\n---usage---\n`, now);
    assert.equal(u.email, "a@b.c");
    assert.deepEqual(u.windows, []);
    assert.match(u.error!, /no subscription login/);
  });

  it("reports usage it can't read", () => {
    assert.match(parseProbe(`---account---\n---usage---\n<html>`, now).error!, /format/);
  });
});

describe("UsageCache", () => {
  it("shares a probe in flight and remembers the answer until it expires", async () => {
    let calls = 0;
    const value: AccountUsage = { windows: [], fetchedAt: "" };
    const cache = new UsageCache(async () => (calls++, value), 20);
    await Promise.all([cache.get("a"), cache.get("a")]);
    await cache.get("a");
    assert.equal(calls, 1);
    await new Promise((r) => setTimeout(r, 30));
    await cache.get("a");
    assert.equal(calls, 2);
  });
});
