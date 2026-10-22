import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addWidget, applyWindowOp, artifactTypeOf, imageTypeOf, isExternalUrl, isPrivateHost, urlHost, urlOrigin, CHAT, chatWindow, close, move, remove, resize, show, compactWindow, nextId, paneIds, paneOf, split, windowState, WINDOW, MAX_PANES, WindowError, type SessionEvent, type WindowOp, type WindowState } from "@kumiko/shared";

/** A window with an artifact widget per id, none shown. */
const withDocs = (...ids: string[]): WindowState => ids.reduce((w, id) => addWidget(w, id, { kind: "artifact" }), chatWindow());

describe("windows", () => {
  it("starts with the chat alone", () => {
    const w = chatWindow();
    assert.deepEqual(w.layout, { kind: "pane", id: CHAT });
    assert.deepEqual(paneIds(w.layout), [CHAT]);
    assert.equal(paneOf(w, CHAT), CHAT);
  });

  it("splits the chat to the right by default, in halves", () => {
    const w = split(withDocs("w2"), { split: "right" }, "p2", "w2");
    assert.deepEqual(w.layout, { kind: "split", dir: "row", ratio: 0.5, a: { kind: "pane", id: CHAT }, b: { kind: "pane", id: "p2" } });
    assert.equal(w.panes.p2, "w2");
    assert.equal(paneOf(w, "w2"), "p2");
  });

  it("splits any pane, below it, giving the new pane the size asked for", () => {
    let w = split(withDocs("w2", "w3"), { split: "right" }, "p2", "w2");
    w = split(w, { split: "below", of: "p2", size: 0.3 }, "p3", "w3");
    assert.deepEqual(paneIds(w.layout), [CHAT, "p2", "p3"]);
    const right = w.layout.kind === "split" ? w.layout.b : undefined;
    assert.equal(right?.kind, "split");
    if (right?.kind !== "split") return;
    assert.equal(right.dir, "column");
    assert.ok(Math.abs(right.ratio - 0.7) < 1e-9);
  });

  it("refuses splits that don't fit", () => {
    const w = split(withDocs("w2", "w3", "w4", "w5"), { split: "right" }, "p2", "w2");
    assert.throws(() => split(w, { split: "right" }, "p3", "w9"), WindowError, "an unknown widget");
    assert.throws(() => split(w, { split: "right" }, "p3", "w2"), WindowError, "a widget shown already");
    assert.throws(() => split(w, { split: "right" }, "p2", "w3"), WindowError, "a pane id taken");
    assert.throws(() => split(w, { split: "right", of: "p9" }, "p3", "w3"), WindowError, "an unknown pane");
    assert.throws(() => split(w, { split: "right", size: 0.9 }, "p3", "w3"), WindowError, "too big");
    assert.throws(() => split(w, { split: "right", size: 0.1 }, "p3", "w3"), WindowError, "too small");
    // Up to MAX_PANES, then no more.
    let full = w;
    for (let n = 3; n <= MAX_PANES; n++) full = split(addWidget(full, `w${n}x`, { kind: "artifact" }), { split: "below", of: "p2" }, `p${n}`, `w${n}x`);
    assert.equal(paneIds(full.layout).length, MAX_PANES);
    assert.throws(() => split(addWidget(full, "wmore", { kind: "artifact" }), { split: "right" }, "pmore", "wmore"), new RegExp(`at most ${MAX_PANES}`));
  });

  it("closes a pane, giving its room to its sibling and keeping its widget", () => {
    let w = split(withDocs("w2", "w3"), { split: "right" }, "p2", "w2");
    w = split(w, { split: "below", of: "p2" }, "p3", "w3");
    const closed = close(w, "p2");
    assert.deepEqual(closed.layout, { kind: "split", dir: "row", ratio: 0.5, a: { kind: "pane", id: CHAT }, b: { kind: "pane", id: "p3" } });
    assert.equal(closed.panes.p2, undefined);
    assert.ok(closed.widgets.w2);
    assert.equal(paneOf(closed, "w2"), undefined);
    assert.deepEqual(close(closed, "p3").layout, chatWindow().layout);
  });

  it("shows another widget in a pane, swapping with the pane that had it", () => {
    let w = split(withDocs("w2", "w3", "w4"), { split: "right" }, "p2", "w2");
    w = split(w, { split: "below", of: "p2" }, "p3", "w3");
    const switched = show(w, "p2", "w4");
    assert.equal(switched.panes.p2, "w4");
    assert.equal(paneOf(switched, "w2"), undefined, "the widget it showed stays, hidden");
    assert.ok(switched.widgets.w2);
    const swapped = show(w, "p2", "w3");
    assert.deepEqual([swapped.panes.p2, swapped.panes.p3], ["w3", "w2"]);
    assert.equal(show(w, "p2", "w2").panes, w.panes);
    assert.equal(w.active, "p3", "a split makes its new pane the active one");
    assert.equal(show(w, "p2", "w2").active, "p2", "and so does showing something in one");
    assert.equal(close(w, "p3").active, undefined, "closing the active pane leaves none");
    assert.equal(close(w, "p2").active, "p3");
    assert.throws(() => show(w, CHAT, "w4"), /stays in its own pane/);
    assert.throws(() => show(w, "p2", CHAT), /stays in its own pane/);
    assert.throws(() => show(w, "p9", "w4"), /no pane/);
    assert.throws(() => show(w, "p2", "w9"), /no widget/);
  });

  it("splits to the left and above too, putting the new pane first", () => {
    const w = split(withDocs("w2"), { split: "left", size: 0.3 }, "p2", "w2");
    assert.deepEqual(w.layout, { kind: "split", dir: "row", ratio: 0.3, a: { kind: "pane", id: "p2" }, b: { kind: "pane", id: CHAT } });
    const above = split(withDocs("w2"), { split: "above" }, "p2", "w2");
    assert.deepEqual(paneIds(above.layout), ["p2", CHAT]);
    assert.equal(above.layout.kind === "split" && above.layout.dir, "column");
  });

  it("moves a pane to a side of another, which it splits in halves", () => {
    // chat | (p2 / p3)
    let w = split(withDocs("w2", "w3"), { split: "right" }, "p2", "w2");
    w = split(w, { split: "below", of: "p2" }, "p3", "w3");
    // p3 to the left of the chat: p2 takes the whole right side.
    const moved = move(w, "p3", CHAT, "left");
    assert.deepEqual(moved.layout, {
      kind: "split", dir: "row", ratio: 0.5,
      a: { kind: "split", dir: "row", ratio: 0.5, a: { kind: "pane", id: "p3" }, b: { kind: "pane", id: CHAT } },
      b: { kind: "pane", id: "p2" },
    });
    assert.equal(moved.panes.p3, "w3", "it keeps what it shows");
    // Beside its own sibling: it comes out, then goes back in on the other side.
    assert.deepEqual(paneIds(move(w, "p3", "p2", "above").layout), [CHAT, "p3", "p2"]);
    // The chat moves too.
    assert.deepEqual(paneIds(move(w, CHAT, "p3", "below").layout), ["p2", "p3", CHAT]);
    assert.equal(move(w, "p2", "p2", "left"), w);
    assert.throws(() => move(w, "p9", CHAT, "left"), WindowError);
  });

  it("moves a pane to a side of the window, along the whole of it", () => {
    // chat | (p2 / p3)
    let w = split(withDocs("w2", "w3"), { split: "right" }, "p2", "w2");
    w = split(w, { split: "below", of: "p2" }, "p3", "w3");
    // p3 under both: a third of the window's height, as each of three would have.
    const moved = move(w, "p3", WINDOW, "below");
    assert.deepEqual(moved.layout, {
      kind: "split", dir: "column", ratio: 1 - 1 / 3,
      a: { kind: "split", dir: "row", ratio: 0.5, a: { kind: "pane", id: CHAT }, b: { kind: "pane", id: "p2" } },
      b: { kind: "pane", id: "p3" },
    });
    // The chat along the whole left side.
    const left = move(w, CHAT, WINDOW, "left").layout;
    assert.deepEqual(left.kind === "split" && left.a, { kind: "pane", id: CHAT });
    assert.throws(() => move(w, "p3", WINDOW, "swap"), WindowError);
    assert.throws(() => move(w, "p9", WINDOW, "left"), WindowError);
    // Two panes: half each.
    const two = split(withDocs("w2"), { split: "right" }, "p2", "w2");
    assert.deepEqual(move(two, "p2", WINDOW, "above").layout, { kind: "split", dir: "column", ratio: 0.5, a: { kind: "pane", id: "p2" }, b: { kind: "pane", id: CHAT } });
  });

  it("keeps two panes' sizes when the two sides of one split change places", () => {
    // chat (70%) | p2 (30%): the user made the artifact narrower.
    const w = resize(split(withDocs("w2"), { split: "right" }, "p2", "w2"), "", 0.7);
    const narrowLeft = { kind: "split", dir: "row", ratio: 1 - 0.7, a: { kind: "pane", id: "p2" }, b: { kind: "pane", id: CHAT } };
    assert.deepEqual(move(w, "p2", CHAT, "left").layout, narrowLeft);
    assert.deepEqual(move(w, CHAT, "p2", "swap").layout, narrowLeft);
    assert.deepEqual(move(w, "p2", WINDOW, "left").layout, narrowLeft);
    // Where it is already: nothing changes.
    assert.equal(move(w, "p2", WINDOW, "right"), w);
    // Across the split's way, it goes above in halves as before.
    assert.deepEqual(move(w, "p2", CHAT, "above").layout, { kind: "split", dir: "column", ratio: 0.5, a: { kind: "pane", id: "p2" }, b: { kind: "pane", id: CHAT } });
  });

  it("swaps two panes' places", () => {
    let w = split(withDocs("w2", "w3"), { split: "right" }, "p2", "w2");
    w = split(w, { split: "below", of: "p2" }, "p3", "w3");
    const swapped = move(w, CHAT, "p3", "swap");
    assert.deepEqual(paneIds(swapped.layout), ["p3", "p2", CHAT]);
    assert.deepEqual(swapped.panes, w.panes);
  });

  it("resizes a split by its path", () => {
    let w = split(withDocs("w2", "w3"), { split: "right" }, "p2", "w2");
    w = split(w, { split: "below", of: "p2" }, "p3", "w3");
    const wider = resize(w, "", 0.7);
    assert.equal(wider.layout.kind === "split" && wider.layout.ratio, 0.7);
    const lower = resize(w, "b", 0.25);
    assert.equal(lower.layout.kind === "split" && lower.layout.b.kind === "split" && lower.layout.b.ratio, 0.25);
    assert.throws(() => resize(w, "a", 0.5), /no split at a/);
    assert.throws(() => resize(w, "", 0.95), /between/);
    assert.throws(() => resize(w, "x", 0.5), /Not a split's path/);
  });

  it("remembers what a pane showed before, and forgets a widget removed", () => {
    let w = split(withDocs("w2", "w3", "w4"), { split: "right" }, "p2", "w2");
    w = show(w, "p2", "w3");
    assert.deepEqual(w.under, { w3: "w2" });
    w = show(w, "p2", "w4");
    assert.deepEqual(w.under, { w3: "w2", w4: "w3" });
    assert.equal(remove(w, "w3").under, undefined, "neither what w3 replaced nor what replaced it");
    // Through a turn's sync too.
    const events = log("one", add("w2"), add("w3"), right("p2", "w2"), { type: "show", pane: "p2", widget: "w3" });
    assert.deepEqual(windowState(compactWindow(events)).under, { w3: "w2" });
  });

  it("removes a widget for good, closing its pane", () => {
    const w = split(withDocs("w2", "w3"), { split: "right" }, "p2", "w2");
    const gone = remove(w, "w2");
    assert.equal(gone.widgets.w2, undefined);
    assert.deepEqual(gone.layout, chatWindow().layout);
    assert.equal(remove(w, "w3").widgets.w3, undefined, "a hidden one too");
    assert.equal(remove(w, "w3").layout, w.layout);
    assert.throws(() => remove(w, CHAT), /stays/);
    assert.throws(() => remove(w, "w9"), /no widget/);
  });

  it("refuses to close the chat or a pane that isn't there", () => {
    const w = split(withDocs("w2"), { split: "right" }, "p2", "w2");
    assert.throws(() => close(w, CHAT), /can't be closed/);
    assert.throws(() => close(w, "p9"), WindowError);
    assert.deepEqual(close(w, "p2").layout, chatWindow().layout);
  });

  it("makes up ids the window doesn't use", () => {
    let w = withDocs("w2");
    assert.equal(nextId(w, "w"), "w3");
    assert.equal(nextId(w, "p"), "p2");
    w = split(w, { split: "right" }, nextId(w, "p"), "w2");
    assert.equal(nextId(w, "p"), "p3");
  });
});

/** A log of events: prompts by text, window ops as they are; numbered from 1. */
const log = (...items: (string | WindowOp | "reply")[]): SessionEvent[] =>
  items.map((x, i): SessionEvent => {
    const seq = i + 1;
    if (x === "reply") return { seq, kind: "claude", payload: { type: "assistant", message: {} } };
    if (typeof x === "string") return { seq, kind: "user_prompt", payload: { text: x } };
    return { seq, kind: "window", payload: { op: x } };
  });

const add = (widget: string): WindowOp => ({ type: "add", widget, kind: "chat" });
const right = (pane: string, widget: string): WindowOp => ({ type: "split", place: { split: "right" }, pane, widget });

describe("window ops", () => {
  it("apply as the functions they name", () => {
    let w = applyWindowOp(chatWindow(), add("w2"));
    w = applyWindowOp(w, right("p2", "w2"));
    assert.deepEqual(paneIds(w.layout), [CHAT, "p2"]);
    w = applyWindowOp(w, { type: "close", pane: "p2" });
    assert.deepEqual(paneIds(w.layout), [CHAT]);
    assert.throws(() => applyWindowOp(w, { type: "add", widget: "w3", kind: "nope" }), WindowError);
    assert.throws(() => applyWindowOp(w, { type: "update", widget: "w2", op: {} }), /takes no changes/);
  });

  it("sync sets what it names and keeps the rest", () => {
    const w = applyWindowOp(chatWindow(), add("w2"));
    const synced = applyWindowOp(w, { type: "sync", widgets: { w3: { kind: "chat" } } });
    assert.deepEqual(Object.keys(synced.widgets).sort(), [CHAT, "w2", "w3"]);
    assert.equal(synced.layout, w.layout);
  });

  it("fold from a log, skipping ops that don't fit", () => {
    const w = windowState(log("hi", add("w2"), right("p2", "w2"), right("p3", "w9"), "reply"));
    assert.deepEqual(paneIds(w.layout), [CHAT, "p2"]);
    assert.equal(w.panes.p2, "w2");
  });
});

describe("a window saved in an older shape", () => {
  it("comes back with its artifacts, and the chat alone on screen", () => {
    const state = { path: "/a/plan.md", type: "markdown", title: "Plan", content: "0".repeat(64) };
    // As this branch saved windows before panes were called panes.
    const events = [
      { seq: 1, kind: "window", payload: { op: { type: "add", widget: "w2", kind: "artifact", state } } },
      { seq: 2, kind: "window", payload: { op: { type: "split", place: { split: "right" }, slot: "s2", widget: "w2" } } },
      { seq: 3, kind: "window", payload: { op: { type: "sync", layout: { kind: "split", dir: "row", ratio: 0.5, a: { kind: "slot", id: "chat" }, b: { kind: "slot", id: "s2" } }, slots: { chat: "chat", s2: "w2" }, active: "s2" } } },
      { seq: 4, kind: "window", payload: { op: { type: "show", slot: "s2", widget: "w2" } } },
    ] as unknown as SessionEvent[];
    const w = windowState(events);
    assert.deepEqual(paneIds(w.layout), [CHAT]);
    assert.deepEqual(Object.keys(w.panes), [CHAT]);
    assert.equal(w.active, undefined);
    assert.equal(w.widgets.w2?.kind, "artifact");
  });
});

describe("compacting a window's log", () => {
  it("brings the ops between two prompts down to one sync, where the last of them was", () => {
    const events = log("one", add("w2"), "reply", right("p2", "w2"), "reply", "two", add("w3"), right("p3", "w3"), "reply");
    const compact = compactWindow(events);
    assert.deepEqual(
      compact.map((e) => `${e.seq}:${e.kind === "window" ? e.payload.op.type : e.kind}`),
      ["1:user_prompt", "3:claude", "4:sync", "5:claude", "6:user_prompt", "8:sync", "9:claude"],
    );
    assert.deepEqual(windowState(compact), windowState(events));
    // Cut at the second prompt, as a rewind does, the window is as it was there.
    assert.deepEqual(windowState(compact.filter((e) => e.seq < 6)), windowState(events.filter((e) => e.seq < 6)));
  });

  it("syncs only what changed", () => {
    const compact = compactWindow(log("one", add("w2"), right("p2", "w2"), "two", add("w3"), add("w4")));
    const second = compact.at(-1)!;
    assert.equal(second.kind, "window");
    if (second.kind !== "window" || second.payload.op.type !== "sync") return;
    assert.equal(second.payload.op.layout, undefined);
    assert.deepEqual(Object.keys(second.payload.op.widgets ?? {}).sort(), ["w3", "w4"]);
  });

  it("leaves a lone op as it is, and drops a run that changed nothing", () => {
    const lone = log("one", add("w2"), "reply");
    assert.deepEqual(compactWindow(lone), lone);
    const undone = compactWindow(log("one", add("w2"), right("p2", "w2"), { type: "close", pane: "p2" }, "reply"));
    // The widget stays (closing only hides it), so the sync has it, and no layout.
    assert.deepEqual(undone.map((e) => e.kind), ["user_prompt", "window", "claude"]);
    const w = undone[1];
    assert.ok(w.kind === "window" && w.payload.op.type === "sync" && !w.payload.op.layout);
    const nothing = compactWindow(log("one", { type: "close", pane: "p9" }, { type: "close", pane: "p8" }));
    assert.deepEqual(nothing.map((e) => e.kind), ["user_prompt"]);
  });

  it("keeps a removal through a sync", () => {
    const events = log("one", add("w2"), right("p2", "w2"), "two", add("w3"), { type: "remove", widget: "w2" });
    const compact = compactWindow(events);
    assert.deepEqual(windowState(compact), windowState(events));
    assert.equal(windowState(compact).widgets.w2, undefined);
  });

  it("is done again without changing anything", () => {
    const once = compactWindow(log("one", add("w2"), right("p2", "w2"), "two", add("w3"), add("w4")));
    assert.deepEqual(compactWindow(once), once);
  });
});

describe("artifact types", () => {
  it("come from the file's extension", () => {
    assert.equal(artifactTypeOf("/a/plan.md"), "markdown");
    assert.equal(artifactTypeOf("/a/Plan.MARKDOWN"), "markdown");
    assert.equal(artifactTypeOf("/a/flow.svg"), "svg");
    assert.equal(artifactTypeOf("/a/flow.mmd"), "mermaid");
    assert.equal(artifactTypeOf("/a/chart.PNG"), "image");
    assert.equal(imageTypeOf("/a/chart.jpg"), "image/jpeg");
    assert.equal(artifactTypeOf("/a/data.json"), undefined);
    assert.equal(artifactTypeOf("/a/README"), undefined);
  });
});

describe("external sites", () => {
  it("are told apart from this machine and private networks", () => {
    for (const host of ["localhost", "foo.localhost", "127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.100.1.1", "0.0.0.0", "[::1]", "[fd12::1]", "[fe80::1]", "[::ffff:192.168.0.1]", "[::ffff:7f00:1]", "[::ffff:a00:1]", "[::ffff:c0a8:1]", "[::7f00:1]", "::ffff:127.0.0.1", "printer.local", "router.lan", "intranet", "db.internal"]) {
      assert.equal(isPrivateHost(host), true, host);
    }
    for (const host of ["example.com", "8.8.8.8", "172.32.0.1", "100.128.0.1", "[2606:4700::1111]", "[::ffff:808:808]", "docs.github.com"]) {
      assert.equal(isPrivateHost(host), false, host);
    }
  });

  it("are http(s) URLs to public hosts", () => {
    assert.equal(isExternalUrl("https://example.com/docs?a=1"), true);
    assert.equal(isExternalUrl("http://example.com"), true);
    assert.equal(isExternalUrl("https://user:pw@example.com/"), true);
    assert.equal(isExternalUrl("http://localhost:5173/"), false);
    assert.equal(isExternalUrl("https://192.168.1.1/"), false);
    assert.equal(isExternalUrl(new URL("http://[::ffff:127.0.0.1]:4317/").href), false);
    assert.equal(isExternalUrl("https://intranet/wiki"), false);
    assert.equal(isExternalUrl("file:///etc/passwd"), false);
    assert.equal(isExternalUrl("javascript:alert(1)"), false);
    assert.equal(urlOrigin("https://User:pw@Example.com:8443/x"), "https://example.com:8443");
    assert.equal(urlHost("https://[2606:4700::1111]/"), "[2606:4700::1111]");
  });
});
