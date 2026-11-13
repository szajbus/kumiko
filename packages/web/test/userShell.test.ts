import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cutMiddle, keepEnds, SHELL_KEEP_HEAD, SHELL_PROMPT_CHARS, shellCommand, shellPrompt, type SessionEvent } from "@kumiko/shared";
import { applyEvent, emptyChat, type ChatState } from "../src/chat.ts";
import { applyShellEvent, historyStep, shellElapsed, shellNote, shellOutputParts, shellState, shellStatusText, type UserShells } from "../src/userShell.ts";

type NewEvent = SessionEvent extends infer E ? (E extends unknown ? Omit<E, "seq"> : never) : never;

const fold = <S>(apply: (s: S, e: SessionEvent) => S, from: S, events: NewEvent[]) => events.reduce((s, e, i) => apply(s, { ...e, seq: i + 1 } as SessionEvent), from);
const started: NewEvent = { kind: "user_shell", payload: { id: "aaaaaaaaaaaa", command: "npm test", cwd: "/work", startedAt: "2026-11-13T10:00:00.000Z" } };
const end = (payload: Partial<Extract<SessionEvent, { kind: "user_shell_end" }>["payload"]>): NewEvent => ({ kind: "user_shell_end", payload: { id: "aaaaaaaaaaaa", durationMs: 4100, output: [], cut: 0, ...payload } });

describe("shell commands, as Claude gets them", () => {
  it("takes a message starting with ! as a command", () => {
    assert.equal(shellCommand("!ls -la "), "ls -la");
    assert.equal(shellCommand("! git status"), "git status");
    assert.equal(shellCommand("ls"), undefined);
    assert.equal(shellCommand(" !ls"), undefined);
  });

  it("gives Claude the command and its output in Claude Code's tags, escaped", () => {
    const text = shellPrompt("cat a <b> && echo", [{ stream: "out", text: "x < y\n" }, { stream: "err", text: "warn & more\n" }], { code: 2, durationMs: 10 });
    assert.equal(text, "<bash-input>cat a &lt;b&gt; &amp;&amp; echo</bash-input><bash-stdout>x &lt; y</bash-stdout><bash-stderr>warn &amp; more</bash-stderr><bash-exit-code>2</bash-exit-code>");
    // Exit 0 isn't said, as Claude Code doesn't say it.
    assert.equal(shellPrompt("true", [], { code: 0, durationMs: 1 }), "<bash-input>true</bash-input><bash-stdout></bash-stdout><bash-stderr></bash-stderr>");
  });

  it("says when a command was stopped, or couldn't run", () => {
    assert.match(shellPrompt("npm run dev", [{ stream: "out", text: "ready\n" }], { stopped: "user", durationMs: 192_000 }), /<bash-stdout>ready<\/bash-stdout><bash-stderr>Stopped by the user after 3m 12s\.<\/bash-stderr>$/);
    assert.match(shellPrompt("ls", [], { error: "ssh: connect refused", durationMs: 5 }), /<bash-stderr>Command failed: ssh: connect refused<\/bash-stderr>$/);
  });

  it("cuts long output in the middle, keeping more of its end, and names the log with all of it", () => {
    const lines = Array.from({ length: 10_000 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const text = shellPrompt("seq", [{ stream: "out", text: lines }, { stream: "err", text: "boom\n" }], { code: 1, durationMs: 1 }, "/home/u/.cache/kumiko/shell/aaaaaaaaaaaa.log");
    assert.ok(text.length < SHELL_PROMPT_CHARS + 200, `${text.length}`);
    assert.match(text, /<bash-stdout>line 1\nline 2\n/);
    assert.match(text, /\[… [\d,]+ lines cut; all of the output is in \/home\/u\/\.cache\/kumiko\/shell\/aaaaaaaaaaaa\.log\]\nline \d+\n/);
    assert.match(text, /line 10000<\/bash-stdout><bash-stderr>boom<\/bash-stderr>/);
    const [head, tail] = text.split("[…");
    assert.ok(tail!.length > head!.length * 5, "the end gets most of the room");
  });

  it("cuts at line ends, and within a line only when it is one long line", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const cut = cutMiddle(text, 100, (n) => `[${n} cut]`);
    const lines = cut.split("\n").filter(Boolean);
    assert.equal(lines[0], "line 1");
    assert.match(lines[1]!, /^\[\d+ cut\]$/);
    assert.ok(lines.slice(2).every((l) => /^line \d+$/.test(l)), cut);
    assert.equal(lines.at(-1), "line 100");
    assert.equal(100 - (lines.length - 1), Number(/\[(\d+) cut\]/.exec(cut)![1]), "the count is of the lines taken out");
    assert.equal(cutMiddle("x".repeat(200), 100, () => "[cut]"), `${"x".repeat(10)}[cut]\n${"x".repeat(90)}`);
    assert.equal(cutMiddle("short", 20, () => "x"), "short");
  });

  it("keeps the start and end of output, in order, with its streams", () => {
    const kept = keepEnds([{ stream: "out", text: "abc" }, { stream: "out", text: "def" }, { stream: "err", text: "ghij" }], 2, 3);
    assert.deepEqual(kept, { chunks: [{ stream: "out", text: "ab" }, { stream: "err", text: "hij" }], cut: 5 });
  });
});

describe("shell commands in the chat", () => {
  it("follows a command from its output streaming in to its end", () => {
    let s = fold(applyShellEvent, {} as UserShells, [started, { kind: "user_shell_output", payload: { id: "aaaaaaaaaaaa", chunk: { stream: "out", text: "a" } } }, { kind: "user_shell_output", payload: { id: "aaaaaaaaaaaa", chunk: { stream: "out", text: "b" } } }]);
    const shell = s.aaaaaaaaaaaa!;
    assert.deepEqual(shell.output, [{ stream: "out", text: "ab" }]);
    assert.equal(shellState(shell), "running");
    assert.equal(shellElapsed(shell, Date.parse("2026-11-13T10:00:12.000Z")), "12.0s");
    s = fold(applyShellEvent, s, [end({ code: 1, output: [{ stream: "err", text: "nope\n" }] })]);
    const done = s.aaaaaaaaaaaa!;
    assert.deepEqual(done.output, [{ stream: "err", text: "nope\n" }]);
    assert.equal(shellState(done), "failed");
    assert.equal(shellStatusText(done), "exit 1");
    assert.equal(shellElapsed(done), "4.1s");
  });

  it("says how a command ended, and what Claude got of it", () => {
    const of = (e: NewEvent) => fold(applyShellEvent, {} as UserShells, [started, e]).aaaaaaaaaaaa!;
    assert.equal(shellState(of(end({ code: 0 }))), "ok");
    assert.equal(shellStatusText(of(end({ code: 0 }))), undefined);
    assert.equal(shellStatusText(of(end({ stopped: "user" }))), "Stopped");
    assert.equal(shellStatusText(of(end({ stopped: "lost" }))), "Stopped: Kumiko restarted");
    assert.equal(shellStatusText(of(end({ error: "no ssh" }))), "Couldn't run");
    assert.equal(shellState(of(end({ error: "no ssh" }))), "failed");
    assert.equal(shellNote(of(end({ code: 0 })), true), undefined);
    assert.match(shellNote(of(end({ code: 0, log: "/h/x.log" })), true)!, /all of it is in \/h\/x\.log/);
    assert.match(shellNote(of(end({ stopped: "ended" })), false)!, /Claude didn't get this: the session ended/);
    assert.match(shellNote(of(end({ stopped: "lost" })), false)!, /Kumiko restarted/);
  });

  it("shows where the chat left out the middle of long output", () => {
    const shell = fold(applyShellEvent, {} as UserShells, [started, end({ code: 0, cut: 99, output: [{ stream: "out", text: "x".repeat(SHELL_KEEP_HEAD + 5) }] })]).aaaaaaaaaaaa!;
    const parts = shellOutputParts(shell);
    assert.equal(parts.cut, 99);
    assert.equal(parts.head[0]!.text.length, SHELL_KEEP_HEAD);
    assert.deepEqual(parts.tail, [{ stream: "out", text: "xxxxx" }]);
  });

  it("shows the prompt that gave Claude a command as that command, where Claude read it", () => {
    const prompt: NewEvent = { kind: "user_prompt", payload: { text: "!npm test", id: "p1", shell: "aaaaaaaaaaaa" } };
    const idle = fold(applyEvent, emptyChat(), [started, end({ code: 0 }), prompt]);
    assert.deepEqual(idle.items.map((i) => (i.type === "user" ? [i.type, i.shell] : [i.type])), [["user", "aaaaaaaaaaaa"]]);
    // Sent while Claude works, it waits, as any message does.
    const busy: ChatState = { ...emptyChat(), inTurn: true };
    const queued = fold(applyEvent, busy, [started, end({ code: 0 }), prompt]);
    assert.equal(queued.queued[0]?.shell, "aaaaaaaaaaaa");
  });

  it("keeps a command that never went to Claude in the chat where it ended", () => {
    for (const stopped of ["ended", "lost"] as const) {
      const chat = fold(applyEvent, emptyChat(), [started, end({ stopped })]);
      assert.deepEqual(chat.items, [{ type: "shell", key: "2", id: "aaaaaaaaaaaa" }]);
    }
    // One the user stopped still goes to Claude, as a prompt.
    assert.deepEqual(fold(applyEvent, emptyChat(), [started, end({ stopped: "user" })]).items, []);
  });
});

describe("history in shell mode", () => {
  const history = ["fix the tests", "!npm test", "why?", "!git status"];
  it("steps through everything sent, as a message", () => {
    assert.equal(historyStep(history, 4, true, false), 3);
    assert.equal(historyStep(history, 3, true, false), 2);
    assert.equal(historyStep(history, 0, true, false), undefined);
    assert.equal(historyStep(history, 3, false, false), 4);
    assert.equal(historyStep(history, 4, false, false), undefined);
  });
  it("steps through the commands only, as a command", () => {
    assert.equal(historyStep(history, 4, true, true), 3);
    assert.equal(historyStep(history, 3, true, true), 1);
    assert.equal(historyStep(history, 1, true, true), undefined);
    assert.equal(historyStep(history, 1, false, true), 3);
    assert.equal(historyStep(history, 3, false, true), 4);
  });
});
