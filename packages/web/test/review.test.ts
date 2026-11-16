import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ReviewFile } from "@kumiko/shared";
import { byFolder, changesReason, restamp, reviewRows, splitRows, viewedCount, viewedState, type Review, type ReviewNote } from "../src/review.ts";

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

  it("tells Claude the user's words, then each note with its line, in file order", () => {
    const notes: ReviewNote[] = [
      { id: "2", path: "z.ts", side: "new", line: 9, quote: "  return x;", text: "Return y." },
      { id: "1", path: "a.ts", side: "old", line: 3, quote: "old()", text: "Keep this." },
    ];
    assert.equal(
      changesReason({ branch: "fix", head: "abcdef123" }, notes, " Close, but: "),
      "Close, but:\n\nNotes on fix at abcdef1:\n\na.ts, line 3 before the change\n> old()\nKeep this.\n\nz.ts:9\n> return x;\nReturn y.",
    );
    assert.equal(changesReason({ branch: "fix", head: "abc" }, [], "  "), "");
  });

  it("groups files by folder, folders in order", () => {
    assert.deepEqual(byFolder([{ path: "b/x" }, { path: "top" }, { path: "a/y" }, { path: "b/z" }]).map(([d, fs]) => [d, fs.map((f) => f.path)]), [["", ["top"]], ["a", ["a/y"]], ["b", ["b/x", "b/z"]]]);
  });
});
