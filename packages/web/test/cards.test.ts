import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ApprovalCard, DeliverCard, SessionEvent } from "@kumiko/shared";
import { approveLabel, cardClosed, cardTitle, effectLine } from "../src/cards.ts";
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
  it("says what each route and method does, and names the button after it", () => {
    assert.match(effectLine(deliver, "main", "merge"), /^Adds one merge commit signed by you on top of main, “Merge branch 'fix-x'”\. The 3 commits come along as they are\.$/);
    assert.match(effectLine(deliver, "main", "squash"), /^Adds one commit signed by you with all 2 files' changes/);
    assert.match(effectLine(deliver, "pr", "merge"), /^Opens a pull request as you/);
    assert.equal(approveLabel(deliver, "main", "merge"), "Sign and push to main");
    assert.equal(approveLabel(deliver, "main", "squash"), "Squash, sign and push to main");
    assert.equal(approveLabel(deliver, "pr", "merge"), "Open pull request");
    assert.equal(approveLabel({ ...deliver, signs: false }, "main", "merge"), "Push to main");
    assert.match(effectLine({ ...deliver, signs: false }, "main", "merge"), /not signed \(no signing key in your git config\)/);
    const pr = { ...deliver, pr: { number: 128, title: "Fix", url: "u" } };
    assert.equal(approveLabel(pr, "main", "merge"), "Sign and land #128");
    assert.match(effectLine(pr, "main", "merge"), /“Merge pull request #128 from acme\/fix-x”\. GitHub will show #128 as merged\./);
    assert.match(effectLine(pr, "main", "squash"), /#128 is closed with a comment/);
    assert.equal(cardTitle(deliver, "pr"), "Open a PR");
    assert.equal(cardTitle(deliver), "Deliver");
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
