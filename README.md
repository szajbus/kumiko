# Bentomo

A desktop app for running Claude Code on your git projects, each in a Lima sandbox of its own. A **project** is a local clone: Bentomo gives it a sandbox (`bm-<project>`) and a Claude home, and Claude works in the clone and in git worktrees beside it. Everything durable lives on the host, so a sandbox can be thrown away. See [docs/projects-spec.md](docs/projects-spec.md).

Bentomo only touches Lima instances named `bm-…`. Every other instance, workmux's `wm-…` sandboxes included, is never listed, started, stopped or deleted.

## Requirements

- Node 24+
- [Lima](https://lima-vm.io) (`brew install lima`), with `limactl` on your `PATH`
- git on the host: worktree status is read with it

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

Without Electron, the folder pickers become text fields for host paths.

To work without real sandboxes, point the server at the fake `limactl` used by the tests:

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
| `npm test` | Builds, then runs the adapter and server tests against the fake `limactl`, and the web UI's tests of its chat, text and project helpers. |
| `npm run roundtrip` | Build step 1's check against **real Lima**: creates `bm-roundtrip` (Debian 12, writable mount), provisions it with a forwarded variable, then checks exec stdin, stop, start (no re-provisioning) and delete. |
| `npm run projects-check` | The projects spec's check against **real Lima**: a throwaway clone with same-path mounts, a worktree made in the sandbox that git on the host reads (and the reverse), and `CLAUDE_CONFIG_DIR` writing into the project's Claude home. `--keep` leaves it for checking the Claude login by hand. |
| `npm run drive -- --sandbox <name>` | Sessions step 1's check against a **running project's sandbox** (`<name>` is the project's): starts Claude, sends two prompts (one reads a forwarded variable), interrupts a third mid-tool-call and sends a fourth, printing every event. `--local` runs `claude` on this machine instead, for trying it from inside a sandbox. |
| `npm run server` | Runs the server alone and serves the built UI. |
| `npm run desktop` | Builds and launches the Electron app. |

## Layout

```
apps/desktop/          Electron main + preload (bundled with the server by esbuild)
packages/server/       HTTP + WS (Hono, ws), projects, host git, operations, list refresh, agent sessions
packages/agent/        AgentDriver interface, Claude Code stream-json driver, a fake claude for tests
packages/sandbox/      SandboxProvider interface, Lima adapter, metadata files
packages/web/          React + Vite UI
packages/shared/       API and event types, and the project helpers server and UI share
```

State, all under `~/.bentomo` (`BENTOMO_HOME` overrides it; `LIMA_HOME` moves Lima's):

| Where | What |
| --- | --- |
| `projects/<id>.json` | The project: clone path, worktrees path, creation time. Nothing is written into the repo. |
| `sandboxes/<id>.json` | Its sandbox's spec (resources, mounts, variable names but never values, provisioning script) and setup state. |
| `claude/<id>/` | The project's Claude home, mounted into its sandbox: login, settings, Claude's session history. |
| `claude-template/` | What a new Claude home starts as. Made on first use with a `CLAUDE.md`; edit it, or add settings or commands, to change what new projects get. |
| `sessions/<id>.json` | Each session that has talked to Claude (its info and chat), so it can be resumed. |

Lima owns the sandboxes (`~/.lima/bm-*`). Operation logs and live agent sessions live in server memory.

If a sandbox's JSON file exists but can't be read (edited by hand, not JSON), the project shows "Record unreadable", its page says which file and why, and Edit and Recreate refuse until the file is fixed or deleted. It still starts.

If a project's own file can't be used (not JSON, an `id` that isn't its file name, no clone or worktrees path), the project isn't listed. The Projects page says which file and why in a banner, requests for the project answer 409 with the same reason, and its name stays taken. Fix the file, or delete it to drop the project.

There is no migration from the sandboxes of earlier versions: `bm-` sandboxes without a project aren't listed. Delete them with `limactl delete`.

## Notes on projects

The spec's model, as built:

- **Creating a project** (`POST /api/projects`, the **New project** form) takes a **host directory** (the clone) and a name, defaulting to the folder's name. The rest of the form, under **Sandbox**, is the sandbox's settings, the same as before: template, resources, extra mounts, variables and the provisioning script.
  - Bentomo checks the clone with git on the host. It must be the top folder of a non-bare repository's main working tree: not a subfolder, not a linked worktree. It must not already be a project, and the name must be free: of two creates racing for one name, the loser gets a 409. Its real path is used (`/tmp` on macOS is `/private/tmp`), since a worktree's `.git` file holds real paths.
  - Then it creates `<clone>__worktrees` if it's missing, seeds the Claude home and writes the project, all before the sandbox is created. If something fails at that point (a name or mount the sandbox can't take, an unwritable parent folder), everything made so far is undone. The worktrees folder is only removed if Bentomo made it and it is still empty.
  - The sandbox is then created in the background, as before.
- **Mounts**: the clone and its worktrees folder at the **same absolute paths** as on the host, writable, and the Claude home at `~/.claude`. These three are always there: the form lists them under **Default mounts** but can't change them. **Extra mounts** default to the same path too. The sandbox works in the clone: provisioning, sessions and interactive shells start there.
- **Claude home**:
  - `CLAUDE_CONFIG_DIR` is set to `~/.claude` for every command Bentomo runs in the sandbox, and in every shell (`~/.config/bentomo/env.sh`). That keeps `.claude.json` inside the mount; otherwise it lands beside it, on the sandbox's disk.
  - The home is never the host's `~/.claude`.
  - Its `CLAUDE.md` is copied from the template once, then it's yours. It imports `bentomo.md`, which Bentomo rewrites on every sandbox start and session start with the worktree convention and the project's real paths.
  - Login is per project, and done from a session. When Claude answers that it isn't logged in, that turn shows as one card, "Claude isn't logged in", in place of Claude's reply and the failed turn. If the prompt was sent while the tab was open, the login dialog opens straight away; otherwise the card has **Log in**. Typing `/login`, which headless Claude can't run itself, opens it too. Once logged in, the card turns green and says who as.
    - Only the last of these cards shows. Before it does, Bentomo asks whether the project is logged in now (`GET /api/sessions/:id/login`, `claude auth status`, given 30 seconds): if it was logged in since, from another session or before a reload, the card is green straight away. Earlier cards, and one a working turn has answered, are hidden.
    - Bentomo runs `claude auth login` in the sandbox (`POST /api/sessions/:id/login`). It prints a sign-in link and waits for the code the sign-in page shows. The dialog opens the link and takes the code (`POST …/login/code`), which goes to the waiting login on stdin. A wrong code shows Claude's own output. A login waits 10 minutes for its code, closing the dialog cancels it, and one runs per project: a second session joins it, or hears who the project is logged in as already.
    - The login lands in the project's Claude home, so every session of the project has it, and it survives recreating the sandbox.
    - Then the card offers **Retry** (`POST /api/sessions/:id/retry`): the session's Claude is started again, since a process that started logged out stays that way, and the failed prompt is sent again. It continues Claude's session if a turn ever worked in it, and starts afresh otherwise. The session keeps its tab and chat.
    - Logging in from a shell in the sandbox (`limactl shell bm-<id>`, then `claude`) works too. The usage strip reads the credentials from the Claude home.
- **Worktrees** are never stored by Bentomo.
  - `GET /api/projects/:id/worktrees` runs `git worktree list --porcelain -z` on the host, then, per worktree, `status` (uncommitted changes, untracked files included) and the commits not on its upstream (or on no remote, without one).
  - A worktree also shows whether it is merged into the remote's default branch: `origin/HEAD`, else `origin/main` or `origin/master`. That is as of the last fetch; Bentomo never fetches. A branch still at the commit it was created from isn't counted as merged, since it has nothing in it yet; the branch's reflog says where that was.
  - Squash-merged branches don't show as merged.
  - git runs with `GIT_OPTIONAL_LOCKS=0`, so reading status never takes the index lock from under an agent committing in the sandbox.
  - The project page reads worktrees every 10 seconds while it is open and the window is visible. That reads the project's file and runs git, without asking Lima.
- **Waiting on you**:
  - A session waits on the user when Claude has finished a turn, or the session stopped by itself, and nobody has looked at it since (`unread` on the session).
  - Claude runs with permissions bypassed, so there are no permission prompts to wait on; a finished turn is how it asks for an answer.
  - Opening the session's tab, with the window visible, clears it (`POST /api/sessions/:id/seen`). Projects carry a `waiting` count. Tabs show waiting sessions in amber.
- **Missing sandbox**: a project whose sandbox doesn't exist (`limactl create` failed, or it was deleted outside Bentomo) shows as "No sandbox" and can be recreated from its stored spec, or from the defaults if there is none. A failed create now keeps the stored spec for that.
- **Missing folders**: if the clone or the worktrees folder is gone, the project says so, and Start, Recreate and Save and recreate refuse until it's back. Lima's own error would be cryptic.
- **Deleting a project** removes its sandbox, its Claude home and its saved sessions, after confirmation. The clone and its worktrees are never touched.

## Notes on the implementation

Checked against Lima 2.2.1 (the spec's open questions):

- `limactl list --format json` prints one JSON object per line, with `name`, `status`, `cpus`, `memory` and `disk` (bytes) and `sshConfigFile`.
- `--mount-only` repeats, but it splits its values on commas and can't set a path in the sandbox. Bentomo passes mounts with `--set '.mounts = […]'` instead.
- The remote `bash -s` hands the rest of stdin to the command after `exec`. Forwarded values containing quotes, `$` and newlines arrive intact.

Beyond the spec:

- **Working directory** (`workdir` in the sandbox's spec): a project's is its clone. Provisioning runs in it, and `exec` takes it as `cwd` for sessions.
  - Every start creates it if it's missing, and hands it to the sandbox user if they can't write to it.
  - Interactive shells start there too. Without `--workdir`, `limactl shell` tries the host's current directory and home, which rarely exist in the sandbox, and falls back to `~`. Each start writes `~/.config/bentomo/shell.sh`, sourced at the end of `~/.bashrc`, which moves a shell that lands in `~` to the working directory. A shell sent anywhere else stays there.
- **Mount paths in the sandbox:** `~/…` means the sandbox user's home; it becomes Lima's `{{.Home}}`. Sandbox paths can't be `/` or `~` and can't overlap. Mounts saved without a sandbox path keep the host path.
- **`SandboxProvider`** has more methods: `validate` and `validateEdit` (so the server can answer `400` before going async), `edit` and `templates`. There is no separate "re-run provisioning": a sandbox is provisioned once, and a changed or fixed script runs by recreating it.
- **Claude Code is always installed**, as the first provisioning step before the user's script.
  - It uses the official native installer (`curl -fsSL https://claude.ai/install.sh | bash`), which puts it in `~/.local/bin` and needs no Node. curl is installed with apt if missing.
  - It is linked to `/usr/local/bin/claude`, so every shell finds it: login, non-login and `limactl shell`. Every start also puts `~/.local/bin` on `PATH` for every shell, as Claude Code's own checks expect: `~/.config/bentomo/env.sh`, sourced from the top of `~/.bashrc` (so commands run over ssh get it too) and from `~/.profile`. `exec` sets it as well.
  - If the install fails, provisioning fails (`provision_failed`), as for the script.
  - Every later start checks for it and reinstalls only if it is missing. A failure there is a warning.
- **Provisioning output:**
  - The script runs with `set -e`.
  - Each command is echoed before it runs via a `DEBUG` trap, not `set -x`, so `$GITHUB_TOKEN` shows in the log as written, never its value.
  - stderr is merged into stdout, so the log keeps its order.
  - The script reaches `bash -c` through a quoted heredoc, so commands that read stdin (`apt`, `curl | sh`) can't consume the rest of the script.
- **If the first start fails** during create, provisioning runs on the next successful start. A sandbox counts as set up only once provisioning has run.
- **Project page** (`#/project/<id>`). Clicking a row opens it, and so does creating a project. It shows the sandbox's status and actions, a **New session** button, the project's sessions (waiting ones first) and worktrees side by side, then resources, template, setup state, creation time, mounts, forwarded variables, the provisioning script, and the sandbox's log at full width.
- **Editing after creation** (`PATCH /api/projects/:id`, **Edit** on the project page). Clone, name and template are fixed, and so are the project's own mounts: `mounts` in the request are the extra ones. The form has two ways to save:
  - **Save and recreate sandbox** (the default, `?recreate=1`) deletes the sandbox and creates it again from the changed spec, provisioning included. It works whether the sandbox runs or not, and the disk can shrink.
  - **Save** keeps the sandbox. CPUs, memory, disk and mounts go through `limactl edit`; they need the sandbox stopped, apply on its next start, and the disk can only grow. Forwarded variables and the provisioning script live only in Bentomo's metadata, so they can change while the sandbox runs, but a new script only runs on a recreate.
- **Recreate sandbox** (in the row menu) deletes the sandbox and creates it again from its stored spec: `POST /api/projects/:id/recreate`. The Claude home and saved sessions stay.
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
- **Large tool output is cut** to 64 KB per tool result, with a note saying how much went, and `tool_use_result` (the same output again, structured) is dropped. Claude's transcript in the project's Claude home keeps everything. The session header shows how much memory the session's buffer takes, as of the last finished turn.
- **Session status changes** go out on `/api/events` as `{ type: "sessions", sessions }`, and the snapshot carries them, so tab dots stay current. Project views carry a live `sessions` count and a `waiting` count.
- **Stop asks first** when the project has live sessions. Delete project, Recreate sandbox and Save and recreate sandbox say how many sessions will end. Sessions also end when the list notices their sandbox stopped outside Bentomo.
- **Subagent messages** (`parent_tool_use_id` set) are kept in the buffer but not shown; the subagent's own tool call shows as one line.
- An unknown session's socket is accepted and closed with code `4404`, which a browser can see, rather than refused with an HTTP 404.

### Resuming and forking

- **Closing a tab closes the session** (there is no End session button). It stays on disk and can be resumed.
- **The New session tab lists saved sessions**, most recent first (20 shown), under the opening-prompt form. Resume needs the session's project's sandbox to be running. It starts `claude … --resume <claude session id>` under the same Bentomo session id, and `GET /api/sessions/resumable` and `POST /api/sessions/:id/resume` back it.
- **Only the chat is saved**: prompts, finished assistant messages, tool results, turn footers and Stop. Deltas, `system` messages, errors and the end marker are dropped, so a resumed tab shows the conversation and nothing else. The session is `idle` at once, since Claude sends `system/init` only with the next prompt.
- **Cost footers** after a resume: the running `total_cost_usd` starts over, and the UI treats a drop as a new total.
- **Saved sessions are deleted** with the trash icon on a row of the New session tab (`DELETE /api/sessions/saved/:id`; 409 while the session is open), and automatically when their project is deleted. Recreating or stopping the sandbox keeps them, since Claude's transcripts are in the project's Claude home on the host.
- **Fork** (top right of a session, `POST /api/sessions/:id/fork`) opens a new tab with a copy of the chat, continuing from the same Claude session with `--fork-session`. The original is untouched. It needs the first turn to have finished, and is disabled while a turn runs.
- **Rewind** (the arrow beside a message you sent, `POST /api/sessions/:id/rewind`) opens a new tab with the conversation as it was before that message, and puts the message back in the box to edit. The original is untouched. It starts `claude … --resume <id> --fork-session --resume-session-at <last message before the prompt>`; rewinding to the first message starts a fresh session. The checkbox "also put back the files" asks the original session's Claude to restore its file checkpoints (`rewind_files`) first, and nothing starts if it can't. Only messages Claude has echoed back can be rewound to (`--replay-user-messages`; Bentomo tags each prompt with its own `uuid`), so slash commands that make no history, like `/model`, have no arrow. It is disabled while a turn runs.
- Claude session and message ids are checked against the UUID shape before they reach the shell command.

### Slash commands

Typing `/` in a prompt offers the commands Claude lists in `system/init` (`slash_commands`), kept on the session, so custom commands and skills show up too. Choosing one sends it as an ordinary prompt: in headless mode Claude runs custom commands, skills and many built-ins (`/compact`, `/clear`, `/model`, `/context`, `/usage`, `/config`, `/mcp`, `/effort`…). Ones it can't run headless (`/help`, `/rewind`…) aren't in the list. `/rewind` is replaced by the arrow beside each message.
