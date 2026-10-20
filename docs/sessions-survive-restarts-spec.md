# Sessions that survive the server

## Goal
A session's Claude keeps working when Kumiko's server goes away, and the server picks it up again when it comes back. That covers a restart in `npm run dev:desktop`, quitting and reopening the app, a crash, and an SSH connection that drops (the Mac sleeping, say). Nothing Claude does in the meantime is lost: when the server is back, each session's tab shows the whole turn, including the part that happened while the server was away.

Only stopping, recreating or deleting the project's sandbox ends its sessions, because the sandbox is where Claude runs. Closing a session's tab still ends it, as now.

## Why
Today a server restart stops every Claude it started. A turn in progress is cut short wherever it is: files it already changed stay changed, the rest don't, a file can be half written, and a shell command (a `git rebase`, a migration, `npm install`) can be stopped halfway. Since the dev mode (`npm run dev:desktop`) restarts the server on every save of its code, and the user often has several sessions working at once, a restart can damage several projects' work at a time. Waiting until all sessions are idle before restarting doesn't help much with several busy sessions, so the fix is for Claude not to depend on the server at all.

## How it works today
Read these before changing anything; this section says where each part is.

- **Starting Claude.** `LimaProvider.exec` (`packages/sandbox/src/lima.ts`) spawns `ssh -F <LIMA_HOME>/km-<id>/ssh.config -T lima-km-<id> bash -s` and writes a script to its stdin (`execScript`: PATH, `CLAUDE_CONFIG_DIR`, forwarded variables, `cd <workdir>`, then `exec <cmd>`). Whatever is written to stdin afterwards reaches the command. `ClaudeDriver.start` (`packages/agent/src/claude.ts`) runs `claudeCommand(...)` (`claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --replay-user-messages --prompt-suggestions --permission-mode bypassPermissions`, plus `--resume`, `--fork-session`, `--resume-session-at`, `--model`) that way.
- **Talking to it.** The driver writes stream-json lines to the SSH process's stdin: prompts (`userMessage`, with attachments inline as base64 content blocks), and control requests (`interrupt`, `rewind_files`, which waits for a `control_response` with its `request_id`). It parses stdout line by line into `message` events, keeps a 20-line stderr tail, and turns the process's exit into an `exit` event (with an `error` event and an `exitHint` before it unless the stop was requested). The interface is `AgentDriver` in `packages/agent/src/driver.ts`; the session layer talks only to it.
- **Stopping it.** `ClaudeDriver.stop` closes stdin (Claude exits at EOF), waits 5 s (`graceMs`), then SIGTERMs and SIGKILLs the SSH process. Killing the SSH process is what kills Claude in the sandbox.
- **Sessions.** `Sessions` (`packages/server/src/sessions.ts`) keeps every session in memory: `info` (`SessionInfo` in `packages/shared/src/index.ts`), its driver, its event buffer with `seq` numbers, and its subscribers (tabs). `attach` makes a driver and maps its events into the buffer; `onMessage` derives status (`running` on `system/init`, `idle` on `result`), the Claude session id, model, title and so on. `relaunch` (after a login), `rewind` and `fork` start new Claude processes. `end` and `endSandbox` stop drivers; `endAll("quit")` stops them all.
- **Saving.** `SessionStore` (`packages/server/src/store.ts`) writes `<KUMIKO_HOME>/sessions/<id>.json` with `info` and `chatEvents(events)` (prompts, finished messages, results; no deltas). `Sessions.save` runs when Claude first reports a session id, at the end of every turn, and on exit. Nothing of a turn in progress is on disk until it ends.
- **Resuming.** `POST /api/sessions/:id/resume` (which, like starting one, starts a stopped sandbox first: `startedProject`) reads the stored session and starts `claude --resume <claudeSessionId>` under the same Kumiko id, seeding the buffer with the stored chat (renumbered). The window resumes its saved tabs' sessions at launch, and also when it reconnects to a restarted server (`App.tsx`, the `snapshots` counter in `LiveState`).
- **Tabs replaying.** A tab's socket (`/api/sessions/:id/events?after=<seq>&buffer=<name>`, `useSessionEvents` in `packages/web/src/api.ts`, `streamSession` in `packages/server/src/server.ts`) replays the buffer after `seq`, sends `caught_up` with the buffer's name, then streams. A tab whose buffer has been replaced (a rewind, or a restart and a resume) is closed with 4409 and replays from the start.
- **Shutting down.** `RunningServer.close()` runs `sessions.endAll("quit")`, flushes the store and closes sockets with 1001. The desktop app (`apps/desktop/src/main.ts`) asks before quitting when `server.working()` isn't empty ("Quitting stops it…"). Under `npm run dev:desktop` (`apps/desktop/dev.mjs`), `node --watch` restarts the server process on every rebuild, which runs the same `close()` through `main.ts`'s SIGTERM handler.
- **Sandboxes stopping.** Stop, recreate and delete call `endSessions` in `server.ts`, and `endOrphanedSessions` ends sessions whose VM the list no longer shows running.
- **Tests.** `packages/server/test/sessions.test.ts` runs the real server against `packages/sandbox/fixtures/fake-limactl.mjs` and `fake-ssh.sh` (which runs the remote command on the host, with `HOME` at `$FAKE_LIMA_DIR/vm-home`) and `packages/agent/fixtures/fake-claude.mjs` (a stand-in for Claude's stream-json mode; "slow" streams for about 10 s, "crash" exits 3, and so on). `npm run drive` exercises the real driver against a real sandbox.

## Design

### Claude runs detached, in a run directory in the sandbox
Each Claude process gets a **run**: a directory in the sandbox, `~/.kumiko/runs/<run id>/`, on the sandbox's own disk. Not on a mount: FIFOs don't cross virtiofs, and nothing here needs to reach the host. A run id is new for every Claude process, so a rewind or relaunch, which swap the process under the same Kumiko session, get runs of their own. Something like `<kumiko session id>-<n>`.

| File | What it is |
|---|---|
| `in` | A FIFO, Claude's stdin. |
| `out` | Claude's stdout, appended to (`>>`), one stream-json object per line. |
| `err` | Claude's stderr. |
| `pid` | Claude's pid. |
| `hold.pid` | The pid of the process that holds `in` open for writing (below). |
| `exit` | Claude's exit code, written once it has exited. |

A launcher started through `exec` creates the run and starts Claude in a new session (`setsid`), with no ties to the SSH connection, then returns:
- A **holder** (`sleep infinity > in &`) keeps a writer on the FIFO, so Claude doesn't read EOF when an attached writer goes away.
- Claude runs with `< in >> out 2>> err`, under a wrapper that, once Claude exits, writes the code to `exit` and appends one last line to `out`, `{"type":"kumiko_exit","code":<n>}`, so whoever follows `out` learns of the exit in order. A `type` Claude never sends, so nothing mistakes it for Claude's.
- The script is sent each time, not provisioned, so sandboxes made before this change need nothing new.

### The server attaches to a run
Attaching is one SSH process per run, as now:
- **stdin:** `cat > in`. The driver's writes go to Claude as they do today.
- **stdout:** `tail -c +<offset + 1> -F out`, Claude's output from where the server had got to.

The driver counts the bytes of `out` it has consumed: the **offset**. A `kumiko_exit` line becomes the driver's `exit` event. The stderr tail for the error event and `exitHint` is read from `err` with a short `exec` (`tail -n 20 err`), and the run's directory is removed once the exit is recorded.

Only one attachment may write at a time: lines longer than `PIPE_BUF` aren't atomic in a FIFO, and attachments carry base64 files. An attachment records its pid in the run (`attach.pid`) and kills the one it replaces.

**If the attachment's SSH process dies without a `kumiko_exit`** (the connection dropped, or the server's process is going away), the driver checks the run: Claude's pid alive, or `exit` there. If Claude is alive it reattaches from its offset, with backoff, and the session stays live. If the sandbox is gone, the session ends with reason `sandbox`.

### Stopping, detaching
- **`stop()`** (closing a tab, stopping the sandbox, a rewind or relaunch swapping the process) ends Claude as today, gracefully: kill the holder and the attachment's `cat`, so Claude reads EOF and exits after its turn. After the grace period, SIGTERM and then SIGKILL Claude's pid in the sandbox, not the SSH process. Then the run is removed.
- **`detach()`**, new: ends the attachment and leaves Claude running. `RunningServer.close()` detaches every live session instead of ending it. It saves each one first, below, so the next server can pick it up. A session that hasn't started Claude yet (`starting`) detaches too.

`AgentDriver` grows what this needs, kept agent-neutral: a way to start a run and a way to attach to an existing one from an offset (`start` could return the run's handle, and `attach(handle, offset)` could be the other way in), `detach()`, and the current offset. The fake in the tests and the real Claude driver both implement it.

### What is saved, and picking sessions up again
`StoredSession` gains the session's **run**, saved while it's live: the run id, the offset the saved chat goes up to, and `live: true`. To make the offset mean something, a save records the offset of the last byte of `out` the saved events came from. `Sessions.save` already runs at init, at each turn's end and on exit; `detach()` adds one more.

On startup, after its first `refresh()`, the server looks at every stored session with a live run:
- **Its sandbox is running and Claude's pid is alive:** reopen it. Seed the buffer with the stored chat, attach from the saved offset, and replay what follows through `onMessage` as if live. The turn in progress, deltas included, comes back with its status (`running` if it hasn't reached its `result`). It's an open session again, listed in the snapshot. The window's tabs find it open, so they neither resume it nor lose it. A tab that was open has another buffer name now and replays from the start (the 4409 path).
- **Claude has exited since** (`exit` is there): replay `out` up to `kumiko_exit` the same way, so the session's end is in the chat, then mark it ended, as an exit would. Its stored copy stays resumable.
- **The sandbox isn't running, or the run is gone** (the VM restarted: processes don't survive, the directory may): mark the run dead and leave the session saved and resumable, as today after a quit.

**Unknown runs.** Runs in a sandbox that no stored session points at are orphans, from a crash between starting a run and saving it, say. To close that gap, the session is saved, with its run, as soon as the run starts, before the first `system/init`. Orphans are stopped and removed when the server starts and finds them, and when a sandbox starts (`prepareShells`).

### The window and the app
- **Quitting** no longer stops Claude. Proposed dialog when Claude is working: "Claude keeps working in the background. Reopen Kumiko to see it." with **Quit** (the default), **Stop Claude and quit** and **Cancel**. **Stop Claude and quit** ends the sessions as today. No dialog when nothing is working. See the open questions.
- **Closing a tab** ends the session as today, including the dialog when Claude is working.
- **The project's live session count** (`sessions` in `SandboxView`) and the "waiting on you" counts work unchanged, since reopened sessions are ordinary live sessions.
- **Stop sandbox** and the others still say how many sessions will end.

### Housekeeping
- **Disk.** `out` grows with every delta (`--include-partial-messages` is chatty). A run's directory goes when its Claude exits. There's no rotation in v1, but the spike below measures how big `out` gets for a long turn and a long session. If it's too big, the fix is rotation at a turn's end, when the server has saved: a new `out.<n>`, with the offset counting across files.
- **Turn in progress during a server outage.** Claude keeps going and can finish. Its `result` makes the session `idle` and `unread` when the server replays it, so the dot and the "waiting on you" count show it.
- **Requests in flight** when the server goes (a `rewind_files`, an `interrupt`) are lost with the HTTP request that sent them. Their `control_response` lines in `out` are ignored, as unknown request ids are now.

## Spike first: settle these against a real sandbox
Before building, a script like `npm run drive` (`packages/agent/scripts/drive.ts`), against a running project's sandbox:
1. Claude in `-p --input-format stream-json` mode reads prompts from a FIFO with a holder, answers, and exits at EOF when the holder and writers go.
2. A process started with `setsid` through `ssh -T … bash -s` survives the SSH process being killed, on the sandboxes' Debian with Lima's defaults. Check that systemd-logind doesn't kill it with the session (`KillUserProcesses`). If it does, `systemd-run --user` with lingering is the fallback.
3. `tail -c +N -F out` over SSH: latency of deltas, compared with today's pipe.
4. The size of `out` for a long turn with tool calls, and for an hour of work.
5. A file attachment of a few MB written through `cat > in` arrives whole.
6. macOS: `setsid` isn't on the Mac, but the fake SSH runs the launcher on the host in tests. Add a shim to `packages/sandbox/fixtures/fake-bin` (where the fake `sudo` and `curl` are), or start the detached process another way that works on both.

Record what is found under "Validated by experiment", as in `docs/projects-spec.md`.

## Tests
In `packages/server/test/sessions.test.ts`, with the fakes:
- A "slow" turn keeps going while the server is closed and started again on the same data directory. The reopened session's tab gets the whole turn, and the session ends `idle` with its result.
- A session that idles while the server is away comes back `idle` and unread.
- Claude exiting ("crash") while the server is away comes back as `failed`, with the stderr tail.
- Closing the server leaves the Claude processes running. Stopping a session, its sandbox, or the server with "stop" (the Stop Claude and quit path) ends them.
- A dropped attachment (kill the SSH process) reattaches without losing or repeating an event.
- Orphan runs are cleaned up at startup.
- Rewind, relaunch (after a login) and fork still work, each with runs of their own.
- The existing tests keep passing; "ends every live session when the server closes" becomes "detaches…", plus one for stopping on quit.

## Docs
Update the README's "Notes on agent sessions" (closing a tab, quitting, resuming), and the dev mode paragraph under "Develop in the desktop app", which currently warns that a server restart stops Claude. Add a "The spec's model, as built" section like the projects one, for what came out differently.

## Open questions
- **Quitting:** keep Claude working by default, as proposed, or ask every time? Should the window's close on macOS (which already leaves the app running) stay as it is?
- **The dev instance:** a separate `dev:desktop` instance (its own `KUMIKO_HOME` and `LIMA_HOME`, and its own Electron data folder, since the single-instance lock is per folder) was discussed and parked in favour of this. With this feature, server restarts are harmless, so it only matters for keeping test projects apart.
- **Two servers on one Kumiko home** (the regular app and a dev one on the same `~/.kumiko`) would both try to attach to the same runs. Out of scope, but the attachment's `attach.pid` takeover should at least not corrupt anything.

## Out of scope
Claude surviving a sandbox restart, several servers attached to one session, sandboxes on other machines.

## Where it starts
Everything it builds on is in `main`: the dev mode (`npm run dev:desktop`), tabs coming back after a server restart, buffer names, and the New session page starting a stopped sandbox (`startedProject` in `server.ts`).

**Careful when testing with the dev mode.** A server restart stops every Claude the server runs, including a session that's doing this work in Kumiko, until this spec is built. Don't run `dev:desktop` from the worktree being changed; run it from another checkout, or test with the fakes.
