---
title: HTTP and WebSocket API
description: How to authenticate to Kumiko's local server, its WebSocket channels, and its HTTP routes.
sidebar:
  order: 5
---

Kumiko's window is a page served by its local server, and everything the window does goes through this API. It is
for the UI, scripts on your Mac, and development. It isn't a stable public interface. Routes change with the UI.

The routes are in `packages/server/src/server.ts`, and the request and response types in `packages/shared/src`.

## Authentication

The server makes a new token each time it starts. Set `KUMIKO_TOKEN` to keep one across restarts, as
`npm run dev:desktop` does.

- **A browser** signs in by opening `/api/login?token=<token>`. The server sets the cookie `kumiko-<port>`, with
  `HttpOnly` and `SameSite=Strict`, and redirects to `/`. `npm run dev:server` prints this address.
- **A script** sends `Authorization: Bearer <token>`.

Every request under `/api/` also has to be local. The `Host` header must be `127.0.0.1`, `localhost` or `[::1]`. A
browser's `Origin`, when it sends one, must be the server's own origin. A request that fails a check gets `403`.
[Security model](/architecture/security/#the-local-server) explains why.

## Responses

The API answers JSON, errors included: `{ "error": "<message>", "details": [...] }`. `details` is there only when there
is more to say, such as a command's output. Errors map to statuses in one place, `app.onError`:

| Status | When |
| --- | --- |
| `400` | The request is malformed: a bad id, a body that isn't JSON, a field out of range. |
| `403` | Not local, or no token. |
| `404` | No such sandbox, session or mirror. |
| `409` | A conflict: an operation already runs on the sandbox, the session has ended, a rewind or answer comes too late. |
| `413` | The body is larger than about 33 MB, which is room for a prompt's attachments in base64. |
| `422` | A login code didn't take. The details hold Claude's output. |
| `502` | `gh` or a mirror's fetch from GitHub failed. |

Long actions on a sandbox, such as start, stop and rebuild, answer `202` at once. Their progress comes as events on
`/api/events`.

## WebSocket channels

Both channels use the same authentication. An upgrade that fails it gets `403`.

### `/api/events`

App-wide events. On connect, the server sends a `snapshot` with every sandbox, the operations' logs, every session and
the mirrors. Then it sends changes as they happen:

| `type` | Carries |
| --- | --- |
| `snapshot` | Everything, on connect. |
| `list` | The sandboxes, whenever their state changes. |
| `sessions` | Every session, whenever one starts, changes status or ends. |
| `state`, `log`, `done`, `error` | An operation on a sandbox: its state, a log line, its end, or its failure. |
| `mirrors` | The mirrors, whenever one is added, removed, or starts or ends a fetch. |
| `pane` | A request for the window showing a session to reload a pane or take a picture of it, for the agent. |

### `/api/sessions/:id/events`

One session's events. Pass `after=<n>` to replay from the event after `n`, and `buffer=<id>` to say which buffer `n`
counts in. The server replays, sends `{ "kind": "caught_up", "buffer": "<id>" }`, then streams new events.

It closes with code `4404` when there is no such session or it is removed, and `4409` when the session is rewound or
its buffer was replaced. Then reconnect from the start.

## Routes

`:name` is a sandbox's name, `:id` a session's id, and `:owner/:name` a repository on GitHub.

### Sandboxes

| Route | Does |
| --- | --- |
| `GET /api/sandboxes` | Every sandbox with its VM's state. |
| `POST /api/sandboxes` | Creates a sandbox from repos you picked. The VM and workspace disk are made in the background. |
| `PATCH /api/sandboxes/:name` | Changes resources, mounts, forwarded variables, the provisioning script or the repos. `?restart=1` stops, saves and starts it. `?recreate=1` rebuilds the VM from the changed settings. |
| `POST /api/sandboxes/:name/start` | Starts the VM. |
| `POST /api/sandboxes/:name/stop` | Stops the VM. Its sessions fall asleep. |
| `POST /api/sandboxes/:name/restart` | Stops and starts the VM. |
| `POST /api/sandboxes/:name/recreate` | Rebuilds the VM, keeping the workspace disk. `?wipe=1` deletes and makes the disk again too. |
| `DELETE /api/sandboxes/:name` | Deletes the VM, the workspace disk, the agent home and the saved sessions. |
| `GET /api/sandboxes/:name/unpushed` | Branches ahead of their upstream, worktrees with uncommitted changes, and stashes. The VM must be running. |
| `GET /api/sandboxes/:name/agent-setup` | The agent's setup scripts, and how each went when the VM was created. |
| `DELETE /api/sandboxes/:name/agent-setup` | Deletes the agent's setup scripts. |
| `GET /api/stats` | The latest CPU, memory and disk reading of each running VM. |
| `GET /api/templates` | The VM templates to create from. |
| `GET /api/defaults` | Your home folder, and where agent homes and Kumiko folders are kept. |
| `GET /api/env?names=…` | Which of the given variable names are set in Kumiko's environment. Never their values. |

### Sessions

| Route | Does |
| --- | --- |
| `GET /api/sessions` | The open sessions. |
| `POST /api/sessions` | Starts a session in a sandbox on a first prompt. |
| `GET /api/sessions/resumable` | Saved sessions that can be resumed, most recent first. |
| `POST /api/sessions/:id/resume` | Opens a saved session again. With `start: false`, one whose sandbox is stopped opens asleep. |
| `POST /api/sessions/:id/wake` | Starts the sandbox of a sleeping session, if it is stopped, and Claude on the session. |
| `DELETE /api/sessions/:id` | Closes the session once Claude finishes its turn. `?stop` closes it at once. `?delete` deletes its saved chat too. |
| `DELETE /api/sessions/saved/:id` | Deletes a saved session that isn't open. |
| `POST /api/sessions/:id/prompt` | Sends a prompt, with attachments. |
| `POST /api/sessions/:id/prompts/:prompt/withdraw` | Takes back a queued prompt before Claude reads it. |
| `POST /api/sessions/:id/interrupt` | Stops Claude's turn. |
| `POST /api/sessions/:id/plan-mode` | Turns plan mode on or off. |
| `POST /api/sessions/:id/rewind` | Rewinds the session in place to just before one of its prompts. |
| `POST /api/sessions/:id/fork` | Starts a new session from a copy of this one, whole or up to one prompt. |
| `POST /api/sessions/:id/restart` | Starts Claude again on the same conversation, to pick up Kumiko's current tools. |
| `POST /api/sessions/:id/seen` | Marks the session as seen, so it no longer waits on you. |
| `GET /api/sessions/:id/usage` | The sandbox's Claude account and how much of its subscription is used. |
| `GET /api/sessions/:id/disk` | What the session keeps on your Mac. |
| `POST /api/sessions/:id/reveal` | Shows a file the agent named in the Finder. |
| `POST /api/sessions/:id/shell` | Runs a `!` command in the sandbox. |
| `POST /api/sessions/:id/shell/:run/stop` | Stops that command. |

### Questions, cards and proposals

| Route | Does |
| --- | --- |
| `POST /api/sessions/:id/asks/:ask` | Answers Claude's question or plan. `409` once Claude isn't waiting for it. |
| `POST /api/sessions/:id/cards/:ask` | Decides an approval card: `approve`, `decline`, or `refresh` a stale one. |
| `GET /api/sessions/:id/cards/:ask/diff` | A deliver card's changes, file by file. |
| `GET /api/sessions/:id/cards/:ask/blob/:blob` | A file's content in the card's repository, for the review pane. |
| `POST /api/sessions/:id/proposals/:proposal` | Accepts or declines Claude's proposal to start a new session. |

### Login

| Route | Does |
| --- | --- |
| `GET /api/sessions/:id/login` | Whether the session's sandbox is logged in. |
| `POST /api/sessions/:id/login` | Starts a login: the sign-in URL, or who is logged in already. |
| `POST /api/sessions/:id/login/code` | Finishes the login with the code from the sign-in page. |
| `DELETE /api/sessions/:id/login` | Cancels the login in progress. |
| `POST /api/sessions/:id/retry` | Starts Claude again after a login, and sends the prompt that failed. |

### The window, artifacts and tasks

| Route | Does |
| --- | --- |
| `GET /api/tabs`, `PUT /api/tabs` | The window's open tabs. |
| `POST /api/sessions/:id/window/show` | Shows an artifact in a pane. |
| `POST /api/sessions/:id/window/close`, `move`, `resize`, `remove` | Closes, moves or resizes a pane, or takes an artifact out of the window. |
| `POST /api/sessions/:id/window/approve` | Allows or denies a website the agent opened. |
| `POST /api/sessions/:id/window/answer` | The window's answer to a `pane` request: a picture, or why it couldn't. |
| `POST /api/sessions/:id/window/review` | Opens or closes the review pane for a deliver card. |
| `POST /api/sessions/:id/window/tasks` | Opens or closes the Tasks pane. |
| `GET /api/artifacts/:hash` | A version of an artifact, as text or an image. Never as a page. |
| `GET /api/sessions/:id/tasks/:task/output` | A background task's output so far. |
| `GET /api/sessions/:id/tasks/:task/file` | All of an ended task's output, while Claude keeps its file. `410` once it's gone. |
| `POST /api/sessions/:id/tasks/:task/stop` | Stops a background task. |
| `POST /api/sessions/:id/tasks/background` | Moves a command Claude is waiting on to the background. |

### Repositories

| Route | Does |
| --- | --- |
| `GET /api/github/account` | Who `gh` is signed in as, or why it isn't. |
| `GET /api/github/repos` | The repositories gh's account can see. |
| `GET /api/mirrors` | The picked repositories and their mirrors. |
| `POST /api/mirrors` | Picks a repository and starts cloning its mirror. |
| `POST /api/mirrors/:owner/:name/fetch` | Fetches the mirror from GitHub. |
| `DELETE /api/mirrors/:owner/:name` | Unpicks the repository and deletes its mirror. |
