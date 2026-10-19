# Bentomo

A desktop app that creates, starts, stops and deletes Lima VMs ("sandboxes"), the same shape as workmux's Lima sandboxes, and runs Claude Code sessions inside them.

Bentomo only touches Lima instances named `bm-…`. Every other instance, workmux's `wm-…` VMs included, is never listed, started, stopped or deleted.

## Requirements

- Node 24+
- [Lima](https://lima-vm.io) (`brew install lima`), with `limactl` on your `PATH`

## Run it

```sh
npm install
npm run desktop          # build everything and launch the Electron app
```

Package a macOS app (on a Mac):

```sh
npm run build && npm run dist:mac -w @bentomo/desktop   # → apps/desktop/release/
```

When the app is launched from the Dock, it reads your login shell's environment once at startup. That puts Homebrew's `limactl` on `PATH` and makes the variables you export in your shell profile available for forwarding. If you rotate a token in your profile, restart the app.

### Develop the UI in a browser

```sh
npm run dev:server       # API on http://127.0.0.1:4317
npm run dev:web          # Vite on http://localhost:5173, proxying /api
```

Without Electron, the folder picker becomes a text field for the host path.

To work without real VMs, point the server at the fake `limactl` used by the tests:

```sh
FAKE_LIMA_DIR=/tmp/fake-lima FAKE_LIMA_DELAY=1500 \
BENTOMO_LIMACTL=$PWD/packages/sandbox/fixtures/fake-limactl.mjs \
BENTOMO_SSH=$PWD/packages/sandbox/fixtures/fake-ssh.sh \
BENTOMO_HOME=/tmp/fake-bentomo \
npm run dev:server
```

## Scripts

| Script | Does |
| --- | --- |
| `npm run build` | Type-checks and builds every package, including the web UI. |
| `npm test` | Builds, then runs the adapter and server tests against the fake `limactl`, and the web UI's chat tests. |
| `npm run roundtrip` | Build step 1's check against **real Lima**: creates `bm-roundtrip` (Debian 12, writable mount), provisions it with a forwarded variable, then checks exec stdin, stop, start (no re-provisioning) and delete. |
| `npm run drive -- --sandbox <name>` | Sessions step 1's check against a **running sandbox**: starts Claude, sends two prompts (one reads a forwarded variable), interrupts a third mid-tool-call and sends a fourth, printing every event. `--local` runs `claude` on this machine instead, for trying it from inside a VM. |
| `npm run server` | Runs the server alone and serves the built UI. |
| `npm run desktop` | Builds and launches the Electron app. |

## Layout

```
apps/desktop/          Electron main + preload (bundled with the server by esbuild)
packages/server/       HTTP + WS (Hono, ws), operations, list refresh, agent sessions
packages/agent/        AgentDriver interface, Claude Code stream-json driver, a fake claude for tests
packages/sandbox/      SandboxProvider interface, Lima adapter, metadata files
packages/web/          React + Vite UI
packages/shared/       API and event types
```

State: Lima owns the VMs (`~/.lima/bm-*`). Bentomo keeps one JSON file per sandbox in `~/.bentomo/sandboxes/<name>.json`, holding the spec with variable names only, never values. Operation logs and live agent sessions live in server memory; Claude keeps its transcripts in the VM. Each session that has talked to Claude is also saved in `~/.bentomo/sessions/<id>.json` (its info and chat), so it can be resumed. `BENTOMO_HOME` and `LIMA_HOME` override the locations.

If a sandbox's JSON file exists but can't be read (edited by hand, not JSON), the sandbox shows "Record unreadable", its page says which file and why, and Edit and Recreate refuse until the file is fixed or deleted. It still starts. A deleted file makes the VM one Bentomo didn't create.

## Notes on the implementation

Checked against Lima 2.2.1 (the spec's open questions):

- `limactl list --format json` prints one JSON object per line, with `name`, `status`, `cpus`, `memory` and `disk` (bytes) and `sshConfigFile`.
- `--mount-only` repeats, but it splits its values on commas and can't set a path in the VM. Bentomo passes mounts with `--set '.mounts = […]'` instead.
- The remote `bash -s` hands the rest of stdin to the command after `exec`. Forwarded values containing quotes, `$` and newlines arrive intact.

Beyond the spec:

- **Working directory** (`workdir` in the spec, default `/workspace`, `~/…` allowed). Provisioning runs in it, and `exec` takes it as `cwd` for sessions.
  - Every start creates it if it's missing, and hands it to the VM user if they can't write to it; Lima creates `/workspace` as root when mounting under it. It can change in place, even while the VM runs.
  - Interactive shells start there too. Without `--workdir`, `limactl shell` tries the host's current directory and home, which rarely exist in the VM, and falls back to `~`. Each start writes `~/.config/bentomo/shell.sh`, sourced at the end of `~/.bashrc`, which moves a shell that lands in `~` to the working directory. A shell sent anywhere else stays there.
- **Mounts land in the working directory by default.** This replaces the spec's same-path rule.
  - A host folder `/a/b/c/d` is offered at `/workspace/d` in the VM (or `<working directory>/d`), with a `-2` suffix if that path is taken. The user can override it.
  - `~/…` in the VM path means the VM user's home; it becomes Lima's `{{.Home}}`.
  - When the host has `~/.claude`, the form starts with it mounted writable at `~/.claude` in the VM (`GET /api/defaults`).
  - VM paths can't be `/` or `~` and can't overlap.
  - Mounts saved without a VM path keep the host path.

- **`SandboxProvider`** has more methods: `validate` and `validateEdit` (so the server can answer `400` before going async), `edit` and `templates`. There is no separate "re-run provisioning": a sandbox is provisioned once, and a changed or fixed script runs by recreating it.
- **Claude Code is always installed**, as the first provisioning step before the user's script.
  - It uses the official native installer (`curl -fsSL https://claude.ai/install.sh | bash`), which puts it in `~/.local/bin` and needs no Node. curl is installed with apt if missing.
  - It is linked to `/usr/local/bin/claude`, so every shell finds it: login, non-login and `limactl shell`. Every start also puts `~/.local/bin` on `PATH` for every shell, as Claude Code's own checks expect: `~/.config/bentomo/env.sh`, sourced from the top of `~/.bashrc` (so commands run over ssh get it too) and from `~/.profile`. `exec` sets it as well.
  - If the install fails, provisioning fails (`provision_failed`), as for the script.
  - Every later start checks for it and reinstalls only if it is missing. A failure there is a warning.
  - With `~/.claude` mounted (the default), it uses the host's login and settings.
- **Provisioning output:**
  - The script runs with `set -e`.
  - Each command is echoed before it runs via a `DEBUG` trap, not `set -x`, so `$GITHUB_TOKEN` shows in the log as written, never its value.
  - stderr is merged into stdout, so the log keeps its order.
  - The script reaches `bash -c` through a quoted heredoc, so commands that read stdin (`apt`, `curl | sh`) can't consume the rest of the script.
- **If the first start fails** during create, provisioning runs on the next successful start. A sandbox counts as set up only once provisioning has run.
- **Sandbox page** (`#/sandbox/<name>`) in place of the spec's log drawer. Clicking a row opens it, and so does creating a sandbox. It shows status and actions, resources, template, setup state, creation time, mounts, forwarded variables, the provisioning script, and the log at full width.
- **Editing after creation** (`PATCH /api/sandboxes/:name`, **Edit** on the sandbox page). Name and template are fixed. The form has two ways to save:
  - **Save and recreate** (the default, `?recreate=1`) deletes the VM and creates it again from the changed spec, provisioning included. It works whether the VM runs or not, and the disk can shrink.
  - **Save** keeps the VM. CPUs, memory, disk and mounts go through `limactl edit`; they need the VM stopped, apply on its next start, and the disk can only grow. Forwarded variables and the provisioning script live only in Bentomo's metadata, so they can change while the VM runs, but a new script only runs on a recreate.
- **Recreate** (in the design's row menu) deletes a sandbox and creates it again from its stored spec: `POST /api/sandboxes/:name/recreate`.
- **`GET /api/env?names=A,B`** backs the form's "set on host" dots. It answers `true`/`false`, never values.
- **Request guard:** the server listens on `127.0.0.1` only. It also refuses requests whose `Host` or `Origin` isn't local, so a web page open in your browser can't drive it (DNS rebinding, CSRF). Session ids from URLs must be Bentomo's own hex ids before they name a file or a socket, since route parameters decode `%2F`.
- **Errors are JSON** (`{ error, details? }`) with a fitting status, including unexpected ones (500), so the UI can always show the message.
- **limactl runs in the temp directory**, because `limactl edit` saves a config it rejects as `lima.REJECTED.yaml` in the current one.
- **Links in the desktop app:** only `http(s)` and `mailto` links open in the browser; chat text comes from Claude, and a `file:` or custom-scheme link could open or run things on the host. Anything else is ignored.

## Notes on agent sessions

Checked against Claude Code 2.1.303 (the sessions spec's open question):

- The stdin message shape and the interrupt control request work as written. An interrupt answers with a `control_response`, ends the turn with a `result` of subtype `error_during_execution`, and leaves the process ready for the next prompt, so there is no kill fallback.
- `--include-partial-messages` streams `text_delta`, `thinking_delta` and `input_json_delta` in this mode. Thinking deltas arrive empty (only `estimated_tokens`), so the thinking block usually says Claude didn't share it.
- `/model <name>` sent as a message switches the model from the next turn. It answers with a synthetic assistant message and a `result` with `num_turns: 0`.
- `system/init` comes at the start of every turn, not once. `assistant` messages arrive one content block at a time, several per message id. `total_cost_usd` is the session's running total, so a turn's cost is the difference.

Beyond the spec:

- **Ended sessions stay listed** (status `ended` or `failed`) until their tab is closed, so the transcript survives a reload. `DELETE /api/sessions/:id`, sent when a tab closes, ends a live session and forgets it either way.
- **Event kinds** are `claude` (a raw stream-json line), `user_prompt`, `error`, plus `interrupt` (Stop was pressed, so the next error result shows as "Interrupted", not red) and `ended` (`reason`: `user`, `sandbox`, `quit` or `exit`).
- **Deltas are pruned** when a turn ends, for every message whose blocks all finished; the final `assistant` messages carry the same content. A message cut short by Stop keeps its deltas, since they are all there is of it.
- **Large tool output is cut** to 64 KB per tool result, with a note saying how much went, and `tool_use_result` (the same output again, structured) is dropped. Claude's transcript in the VM keeps everything. The session header shows how much memory the session's buffer takes, as of the last finished turn.
- **Session status changes** go out on `/api/events` as `{ type: "sessions", sessions }`, and the snapshot carries them, so tab dots stay current. Sandbox views carry a live `sessions` count.
- **Stop asks first** when the sandbox has live sessions (it didn't ask at all before). Delete, Recreate and Save and recreate say how many sessions will end. Sessions also end when the list notices their sandbox stopped outside Bentomo.
- **Subagent messages** (`parent_tool_use_id` set) are kept in the buffer but not shown; the subagent's own tool call shows as one line.
- An unknown session's socket is accepted and closed with code `4404`, which a browser can see, rather than refused with an HTTP 404.

### Resuming and forking

- **Closing a tab closes the session** (there is no End session button). It stays on disk and can be resumed.
- **The New session tab lists saved sessions**, most recent first (20 shown), under the opening-prompt form. Resume needs the session's sandbox to be running. It starts `claude … --resume <claude session id>` under the same Bentomo session id, and `GET /api/sessions/resumable` and `POST /api/sessions/:id/resume` back it.
- **Only the chat is saved**: prompts, finished assistant messages, tool results, turn footers and Stop. Deltas, `system` messages, errors and the end marker are dropped, so a resumed tab shows the conversation and nothing else. The session is `idle` at once, since Claude sends `system/init` only with the next prompt.
- **Cost footers** after a resume: the running `total_cost_usd` starts over, and the UI treats a drop as a new total.
- **Saved sessions are deleted** with the trash icon on a row of the New session tab (`DELETE /api/sessions/saved/:id`; 409 while the session is open), and automatically when their sandbox is deleted or recreated, since Claude's transcripts lived on its disk. Stopping a sandbox keeps them.
- **Fork** (top right of a session, `POST /api/sessions/:id/fork`) opens a new tab with a copy of the chat, continuing from the same Claude session with `--fork-session`. The original is untouched. It needs the first turn to have finished, and is disabled while a turn runs.
- **Rewind** (the arrow beside a message you sent, `POST /api/sessions/:id/rewind`) opens a new tab with the conversation as it was before that message, and puts the message back in the box to edit. The original is untouched. It starts `claude … --resume <id> --fork-session --resume-session-at <last message before the prompt>`; rewinding to the first message starts a fresh session. The checkbox "also put back the files" asks the original session's Claude to restore its file checkpoints (`rewind_files`) first, and nothing starts if it can't. Only messages Claude has echoed back can be rewound to (`--replay-user-messages`; Bentomo tags each prompt with its own `uuid`), so slash commands that make no history, like `/model`, have no arrow. It is disabled while a turn runs.
- Claude session and message ids are checked against the UUID shape before they reach the shell command.

### Slash commands

Typing `/` in a prompt offers the commands Claude lists in `system/init` (`slash_commands`), kept on the session, so custom commands and skills show up too. Choosing one sends it as an ordinary prompt: in headless mode Claude runs custom commands, skills and many built-ins (`/compact`, `/clear`, `/model`, `/context`, `/usage`, `/config`, `/mcp`, `/effort`…). Ones it can't run headless (`/help`, `/rewind`…) aren't in the list. `/rewind` is replaced by the arrow beside each message.
