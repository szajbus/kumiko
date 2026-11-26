import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ReviewFile } from "@kumiko/shared";
import type { ReviewThread } from "@kumiko/shared";
import { byFolder, changesReason, initialScope, newCommits, noteComment, noteFits, prUpdate, restamp, reviewRows, splitRows, threadCounts, threadState, touched, unreadOrder, viewedCount, viewedMarks, viewedState, type Review, type ReviewNote } from "../src/review.ts";

const file = (hunks: ReviewFile["hunks"], status: ReviewFile["status"] = "modified") => ({ hunks, status });
const short = (rows: ReturnType<typeof reviewRows>) => rows.map((r) => (r.kind === "gap" ? `gap ${r.skipped ?? "?"}` : `${r.kind[0]} ${r.old ?? "-"} ${r.new ?? "-"} ${r.text}`));

describe("a file's rows", () => {
  const f = file([
    { oldStart: 3, oldLines: 2, newStart: 3, newLines: 2, lines: [" c", "-d", "+D"] },
    { oldStart: 10, oldLines: 1, newStart: 10, newLines: 2, lines: [" j", "+k"] },
  ]);

  it("has a gap before, between and after its hunks, the last of a length not known yet", () => {
    assert.deepEqual(short(reviewRows(f)), ["gap 2", "c 3 3 c", "r 4 - d", "a - 4 D", "gap 5", "c 10 10 j", "a - 11 k", "gap ?"]);
  });

  it("shows a gap's lines once it is opened and the file's content is known", () => {
    const lines = ["a", "b", "c", "D", "e", "f", "g", "h", "i", "j", "k", "l", "m"];
    const rows = reviewRows(f, lines, new Set([0, 2]));
    assert.deepEqual(short(rows).slice(0, 3), ["c 1 1 a", "c 2 2 b", "c 3 3 c"]);
    assert.deepEqual(short(rows).slice(-3), ["a - 11 k", "c 11 12 l", "c 12 13 m"]);
    assert.equal(rows.find((r) => r.kind === "gap")?.skipped, 5, "the one left closed stays a gap");
  });

  it("leaves no gap for a whole new file, nor after a hunk that removes the start", () => {
    assert.deepEqual(short(reviewRows(file([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ["+x"] }], "added"))), ["a - 1 x"]);
    assert.deepEqual(short(reviewRows(file([{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ["-x"] }]), ["y"])), ["r 1 - x", "gap 1"]);
  });

  it("marks what changed within a changed line", () => {
    const rows = reviewRows(file([{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-const a = 1;", "+const a = 2;"] }]));
    assert.deepEqual(rows.filter((r) => r.kind !== "gap").map((r) => r.mark), [[10, 11], [10, 11]]);
  });

  it("pairs removals with the additions after them, side by side", () => {
    const pairs = splitRows(reviewRows(f)).map((s) => (s.gap ? "gap" : `${s.left?.text ?? "_"}|${s.right?.text ?? "_"}`));
    assert.deepEqual(pairs, ["gap", "c|c", "d|D", "gap", "j|j", "_|k", "gap"]);
  });
});

describe("a review's marks and notes", () => {
  const a = { path: "src/a.ts", newBlob: "a2", oldBlob: "a1", hunks: [], status: "modified" } as ReviewFile;
  const review: Review = { viewed: { "src/a.ts": { blob: "a2", head: "h1" }, "b.ts": { blob: "b1", head: "h1" } }, notes: [], seen: [] };

  it("knows a file viewed as it is now from one that changed since", () => {
    assert.equal(viewedState(review, a), "yes");
    assert.equal(viewedState(review, { ...a, newBlob: "a3" }), "changed");
    assert.equal(viewedState(review, { ...a, path: "c.ts" }), "no");
  });

  it("carries a mark over to a new head only for a file that didn't change", () => {
    const b = { ...a, path: "b.ts", newBlob: "b2" };
    const next = restamp(review, "h2", [a, b]);
    assert.equal(next.viewed["src/a.ts"].head, "h2");
    assert.equal(next.viewed["b.ts"].head, "h1");
    assert.equal(viewedCount(next, { head: "h2", files: [{ path: "src/a.ts" }, { path: "b.ts" }] }), 1);
    assert.equal(restamp(next, "h2", [a]), next, "nothing to change gives the same review back");
  });

  it("marks a renamed file's old path with it, as the card lists both", () => {
    const f = { path: "new.ts", oldPath: "old.ts", status: "renamed" as const, newBlob: "n", oldBlob: "o" };
    assert.deepEqual(viewedMarks(f, "h"), { "new.ts": { blob: "n", head: "h" }, "old.ts": { blob: "o", head: "h" } });
    const r: Review = { viewed: viewedMarks(f, "h"), notes: [], seen: [] };
    assert.equal(viewedCount(r, { head: "h", files: [{ path: "old.ts" }, { path: "new.ts" }] }), 2);
    assert.equal(restamp(r, "h2", [{ ...f, hunks: [] }]).viewed["old.ts"].head, "h2");
  });

  it("tells Claude the user's words, then each thread it said it would change, with its conversation", () => {
    const m = (by: "user" | "claude", text: string) => ({ id: text, by, text, at: "" });
    const threads: ReviewThread[] = [
      { id: "t1", review: "r", ask: "a", head: "abcdef123", anchor: { kind: "line", path: "z.ts", side: "new", line: 9, quote: "  return x;" }, messages: [m("user", "Return y."), m("claude", "Will do.")], willChange: true },
      { id: "t2", review: "r", ask: "a", head: "abcdef123", anchor: { kind: "change" }, messages: [m("user", "Why?"), m("claude", "Because.")] },
      { id: "t5", review: "r", ask: "a", head: "abcdef123", anchor: { kind: "change" }, messages: [m("user", "Tests?"), m("claude", "Adding one.")], willChange: true },
      { id: "t3", review: "r", ask: "a", head: "0123456789", anchor: { kind: "file", path: "b.ts" }, messages: [m("user", "Split it."), m("claude", "OK.")], willChange: true },
      { id: "t4", review: "r", ask: "a", head: "abcdef123", anchor: { kind: "commit", sha: "c".repeat(40) }, messages: [m("user", "Reword."), m("claude", "Sure.")], willChange: true, resolved: true },
    ];
    assert.equal(
      changesReason({ branch: "fix", head: "abcdef123" }, threads, " Close, but: "),
      "Close, but:\n\nWhat you said you'd change, in the review of fix:\n\nz.ts:9, thread t1\n> return x;\nUser: Return y.\n\nYou: Will do." +
        "\n\nThe whole change, thread t5\nUser: Tests?\n\nYou: Adding one." +
        "\n\nb.ts (at 0123456, an earlier commit of the branch), thread t3\nUser: Split it.\n\nYou: OK.",
    );
    assert.equal(changesReason({ branch: "fix", head: "abc" }, [], "  "), "");
    assert.deepEqual(threads.map(threadState), ["will-change", "answered", "will-change", "will-change", "resolved"]);
    assert.deepEqual(threadCounts(threads), { open: 4, willChange: 3, unread: 5 });
  });

  it("goes through unread replies in the order the pane shows them", () => {
    const t = (id: string, anchor: ReviewThread["anchor"], read = false): ReviewThread => ({ id, review: "r", ask: "a", head: "h", anchor, messages: [{ id: "u", by: "user", text: "?", at: "" }, { id: "c", by: "claude", text: "!", at: "" }], ...(read ? { readTo: "c" } : {}) });
    const threads = [
      t("b9", { kind: "line", path: "b.ts", side: "new", line: 9, quote: "" }),
      t("a", { kind: "file", path: "a.ts" }),
      t("b2", { kind: "line", path: "b.ts", side: "new", line: 2, quote: "" }),
      t("read", { kind: "file", path: "a.ts" }, true),
      t("all", { kind: "change" }),
      t("c2", { kind: "commit", sha: "2" }),
      t("c1", { kind: "commit", sha: "1" }),
    ];
    assert.deepEqual(unreadOrder(threads, ["a.ts", "b.ts"], ["1", "2"]).map((x) => x.id), ["all", "c1", "c2", "a", "b2", "b9"]);
  });

  it("says whether a thread's line changed since its commit", () => {
    const t = (anchor: ReviewThread["anchor"]): ReviewThread => ({ id: "t", review: "r", ask: "a", head: "h", anchor, messages: [] });
    const hunks = [{ oldStart: 10, oldLines: 3, newStart: 10, newLines: 1, lines: [] }];
    const line = (n: number, side: "old" | "new" = "new") => t({ kind: "line", path: "a", side, line: n, quote: "" });
    assert.equal(touched(line(11), { hunks }), true);
    assert.equal(touched(line(13), { hunks }), false);
    assert.equal(touched(line(9), { hunks }), false);
    assert.equal(touched(line(1, "old"), { hunks }), true, "a removed line's thread counts the file changing");
    assert.equal(touched(t({ kind: "file", path: "a" }), { hunks }), true);
    assert.equal(touched(line(11), undefined), false, "the file didn't change");
    assert.equal(touched(line(5), { hunks: [{ oldStart: 4, oldLines: 0, newStart: 5, newLines: 2, lines: [] }] }), true, "lines added right after it");
  });

  it("sends a note from before threads on its line, or on its file if it was at another commit", () => {
    const n: ReviewNote = { id: "1", path: "a.ts", side: "new", line: 4, quote: "x()", text: "Why?", head: "h" };
    assert.deepEqual(noteComment(n, "h"), { anchor: { kind: "line", path: "a.ts", side: "new", line: 4, quote: "x()" }, text: "Why?" });
    assert.deepEqual(noteComment({ ...n, head: "abcdef123" }, "h"), { anchor: { kind: "file", path: "a.ts" }, text: "On line 4 at abcdef1 (“x()”): Why?" });
  });

  it("groups files by folder, folders in order", () => {
    assert.deepEqual(byFolder([{ path: "b/x" }, { path: "top" }, { path: "a/y" }, { path: "b/z" }]).map(([d, fs]) => [d, fs.map((f) => f.path)]), [["", ["top"]], ["a", ["a/y"]], ["b", ["b/x", "b/z"]]]);
  });
});

describe("a card that adds to an open PR", () => {
  const commit = (sha: string, onGithub?: boolean) => ({ sha, subject: sha, author: "a", email: "e", claude: true, ...(onGithub ? { onGithub } : {}) });
  const pr = { number: 7, title: "t", url: "u" };
  const card = { pr, github: "g", head: "h", commits: [commit("a", true), commit("b"), commit("c")] };

  it("compares with the PR's head on GitHub and marks the commits it doesn't show", () => {
    const u = prUpdate(card)!;
    assert.deepEqual([u.number, u.from, [...u.fresh]], [7, "g", ["b", "c"]]);
    assert.deepEqual([...newCommits(card)!], ["b", "c"]);
  });

  it("has nothing new without a PR, or at the PR's own head", () => {
    assert.equal(prUpdate({ ...card, pr: undefined }), undefined);
    assert.equal(prUpdate({ ...card, github: "h" }), undefined);
    assert.equal(prUpdate({ ...card, github: undefined }), undefined);
  });

  it("marks no commit new when the PR has none of them, as after a rewrite", () => {
    const rewritten = { ...card, commits: [commit("b"), commit("c")] };
    assert.ok(prUpdate(rewritten));
    assert.equal(newCommits(rewritten), undefined);
  });

  it("opens on what's new, unless the PR has none of the commits or there is no PR", () => {
    assert.deepEqual(initialScope(card), { kind: "since", sha: "g" });
    assert.deepEqual(initialScope({ ...card, commits: [commit("b")] }), { kind: "all" });
    assert.deepEqual(initialScope({ ...card, pr: undefined }), { kind: "all" });
  });

  it("puts a note on a removed line only in the view it was left in", () => {
    const note = { head: "h", side: "old" as const, from: "g" };
    assert.equal(noteFits(note, "h", "g"), true);
    assert.equal(noteFits(note, "h", undefined), false, "not in all changes, where old lines are the base's");
    assert.equal(noteFits({ head: "h", side: "old" }, "h", undefined), true);
    assert.equal(noteFits({ head: "h", side: "new", from: undefined }, "h", "g"), true, "new lines are the card's commit's in either");
    assert.equal(noteFits({ ...note, head: "x" }, "h", "g"), false);
  });

});
