import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ApprovalCard, DeliverCard, SessionEvent } from "@kumiko/shared";
import { approveLabel, cardAction, cardClosed, cardVerb, deliverChoices, deliverDecision, initialChoice, unsignedWarning } from "../src/cards.ts";
import { applyEvent, emptyChat, type ChatItem } from "../src/chat.ts";

const deliver: DeliverCard = {
  kind: "deliver",
  repo: "acme/widget",
  branch: "fix-x",
  base: "main",
  head: "2052d49aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  commits: [1, 2, 3].map((n) => ({ sha: `${n}`.repeat(40), subject: `c${n}`, author: "A", email: "a@x", claude: true })),
  files: [{ path: "a.ts", added: 1, deleted: 0 }, { path: "b.ts", added: 2, deleted: 1 }],
  added: 3,
  deleted: 1,
  flags: [],
  title: "Fix x",
  body: "b",
  squashBody: "* c1",
  trailers: [],
  route: "main",
  method: "merge",
  signs: true,
};

describe("approval cards' wording", () => {
  it("offers merge, squash and a PR, each said the way GitHub says it, and starts at the last pick", () => {
    assert.deepEqual(deliverChoices(deliver), [
      { choice: "merge", label: "Merge and push", description: "All 3 commits from this branch will be added to main via a merge commit." },
      { choice: "squash", label: "Squash and push", description: "The 3 commits from this branch will be combined into one commit in main." },
      { choice: "pr", label: "Push and open pull request", description: "A pull request will be opened from this branch." },
    ]);
    const one = { ...deliver, commits: deliver.commits.slice(0, 1) };
    assert.equal(deliverChoices(one)[0].description, "The commit from this branch will be added to main via a merge commit.");
    assert.equal(initialChoice(deliver), "merge");
    assert.equal(initialChoice({ ...deliver, method: "squash" }), "squash");
    assert.equal(initialChoice({ ...deliver, route: "pr" }), "pr");
  });

  it("offers no PR for a branch that has one, and says what happens to it", () => {
    const pr = { ...deliver, route: "pr" as const, pr: { number: 128, title: "Fix", url: "u" } };
    assert.deepEqual(deliverChoices(pr).map((c) => c.choice), ["merge", "squash"]);
    assert.match(deliverChoices(pr)[0].description, /, and #128 will show as merged\.$/);
    assert.match(deliverChoices(pr)[1].description, /, and #128 will be closed\.$/);
    assert.equal(initialChoice(pr), "merge", "a PR can't be the start when one is open");
  });

  it("sends what the choice means, and the PR's text only for a PR", () => {
    const text = { title: " Fix x ", body: "b" };
    assert.deepEqual(deliverDecision("merge", text), { kind: "deliver", route: "main", method: "merge" });
    assert.deepEqual(deliverDecision("squash", text), { kind: "deliver", route: "main", method: "squash", title: "Fix x" }, "a title the user changed");
    assert.deepEqual(deliverDecision("squash", { ...text, original: "Fix x" }), { kind: "deliver", route: "main", method: "squash" }, "Claude's, unchanged");
    assert.deepEqual(deliverDecision("pr", text), { kind: "deliver", route: "pr", method: "merge", title: "Fix x", body: "b" });
    assert.equal(deliverDecision("pr", { ...text, title: "  " }), undefined, "no PR without a title");
  });

  it("warns only when a commit Kumiko lands won't be signed", () => {
    assert.equal(unsignedWarning(deliver, "merge"), undefined);
    assert.equal(unsignedWarning({ ...deliver, signs: false }, "merge"), "Won't be signed: there's no signing key in your git config.");
    assert.equal(unsignedWarning({ ...deliver, signs: false }, "squash"), "Won't be signed: there's no signing key in your git config.");
    assert.equal(unsignedWarning({ ...deliver, signs: false }, "pr"), undefined, "a PR lands nothing yet");
  });

  it("names the card and its button after what happens", () => {
    assert.equal(cardVerb(deliver, "merge"), "Merge");
    assert.equal(cardVerb(deliver, "pr"), "Open a PR");
    assert.equal(cardVerb(deliver, "squash"), "Squash");
    assert.equal(approveLabel(deliver, "squash"), "Squash and push");
    assert.equal(approveLabel(deliver, "pr"), "Push and open pull request");
    const card = (decision?: ApprovalCard["decision"]): ApprovalCard => ({ id: "a", at: "", state: "declined", card: deliver, ...(decision ? { decision } : {}) });
    assert.equal(cardAction(card()), "merge fix-x into main");
    assert.equal(cardAction({ ...card(), card: { ...deliver, route: "pr" } }), "open a PR for fix-x", "declined, it names what the card offered");
    assert.equal(cardAction(card({ kind: "deliver", route: "main", method: "squash" })), "squash fix-x into main");
    assert.equal(cardAction(card({ kind: "deliver", route: "pr", method: "merge" })), "open a PR for fix-x");
  });

  it("says why a card ended without being decided", () => {
    const card = { state: "open" } as ApprovalCard;
    assert.equal(cardClosed(card, undefined, undefined), undefined);
    assert.match(cardClosed(card, undefined, "interrupted")!, /Claude stopped waiting/);
    assert.match(cardClosed(card, { kind: "message" }, undefined)!, /You sent a message instead/);
    assert.equal(cardClosed({ state: "done" } as ApprovalCard, { kind: "allow" }, "interrupted"), undefined, "done is done");
  });

  it("puts each card on the ask it answers, as it changes", () => {
    const ask = { kind: "approval" as const, id: "a1", tool: "deliver", input: {} };
    const card: ApprovalCard = { id: "a1", at: "", state: "open", card: deliver };
    let s = applyEvent(emptyChat(), { seq: 1, kind: "ask", payload: ask } as SessionEvent);
    s = applyEvent(s, { seq: 2, kind: "card", payload: card } as SessionEvent);
    s = applyEvent(s, { seq: 3, kind: "card", payload: { ...card, state: "done" } } as SessionEvent);
    const item = s.items.find((i): i is Extract<ChatItem, { type: "ask" }> => i.type === "ask")!;
    assert.equal(item.card?.state, "done");
    assert.equal(applyEvent(s, { seq: 4, kind: "card", payload: { ...card, id: "other" } } as SessionEvent), s, "a card for no ask changes nothing");
  });
});
