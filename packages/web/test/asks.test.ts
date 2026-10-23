import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentQuestion } from "@kumiko/shared";
import { answersOf, askOutcome, noPicks, pick, pickOwn, planTitle, splitAnswer, typeOwn } from "../src/asks.ts";

const one: AgentQuestion = { question: "Storage?", options: [{ label: "Redis" }, { label: "SQLite" }] };
const any: AgentQuestion = { question: "When?", multiSelect: true, options: [{ label: "TTL" }, { label: "Deploy" }, { label: "Webhook" }] };

describe("asks", () => {
  it("picks one option of a single choice, or the user's own answer instead", () => {
    let p = pick(one, noPicks(), "Redis");
    p = pick(one, p, "SQLite");
    assert.deepEqual(answersOf([one], [p]), { "Storage?": ["SQLite"] });
    p = typeOwn(one, p, "Postgres ");
    assert.deepEqual(answersOf([one], [p]), { "Storage?": ["Postgres"] }, "typing picks the own answer, dropping the option");
    p = pick(one, p, "Redis");
    assert.deepEqual(answersOf([one], [p]), { "Storage?": ["Redis"] }, "an option drops the own answer, which keeps its text");
    assert.equal(p.own, "Postgres ");
    assert.deepEqual(answersOf([one], [pickOwn(one, p)]), { "Storage?": ["Postgres"] });
    assert.deepEqual(answersOf([one], [typeOwn(one, p, "  ")]), { "Storage?": ["Redis"] }, "emptied, the own answer isn't picked");
  });

  it("picks any number of a multi-select's options, in the options' order, then the own answer", () => {
    let p = pick(any, noPicks(), "Webhook");
    p = pick(any, p, "TTL");
    p = typeOwn(any, p, "on currency change");
    assert.deepEqual(answersOf([any], [p]), { "When?": ["TTL", "Webhook", "on currency change"] });
    p = pick(any, pickOwn(any, p), "TTL");
    assert.deepEqual(answersOf([any], [p]), { "When?": ["Webhook"] }, "picking again unpicks");
  });

  it("leaves out questions not answered", () => {
    assert.deepEqual(answersOf([one, any], [noPicks(), pick(any, noPicks(), "Deploy")]), { "When?": ["Deploy"] });
    assert.deepEqual(answersOf([one], [typeOwn(one, noPicks(), "")]), {});
  });

  it("tells options picked from answers in the user's own words", () => {
    assert.deepEqual(splitAnswer(any, ["TTL", "on currency change"]), { labels: ["TTL"], own: ["on currency change"] });
    assert.deepEqual(splitAnswer(any), { labels: [], own: [] });
  });

  it("says how an ask ended", () => {
    assert.equal(askOutcome("questions", { kind: "answers", answers: {} }, undefined), undefined);
    assert.equal(askOutcome("questions", { kind: "skip" }, undefined), "Skipped.");
    assert.equal(askOutcome("questions", { kind: "message" }, undefined), "You answered with a message instead.");
    assert.equal(askOutcome("plan", { kind: "approve" }, undefined), "Approved.");
    assert.equal(askOutcome("plan", { kind: "feedback", text: "x" }, undefined), "Sent back:");
    assert.equal(askOutcome("questions", undefined, "interrupted"), "Stopped before you answered.");
    assert.equal(askOutcome("plan", undefined, "exited"), "Claude stopped before you approved it.");
    assert.equal(askOutcome("plan", undefined, undefined), undefined, "still waiting");
  });

  it("names a plan by its first heading, or its first line", () => {
    assert.equal(planTitle("Context first.\n\n## Move auth to JWT\n\n1. Do it."), "Move auth to JWT");
    assert.equal(planTitle("\n  Just do it.\nThen test."), "Just do it.");
    assert.equal(planTitle(""), "");
  });
});
