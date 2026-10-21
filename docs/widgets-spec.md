# Widgets

## Goal
A tab becomes a **window**: a layout of panes, as in tmux. Each pane shows a **widget**, a small built-in app. Today's session page is one of them, the chat, and it is the only pane a window has until Claude adds more.

Claude places widgets itself, with tools. It can open a widget beside the chat or below it, change what it shows, and close it. The first widget is an **artifact**: a file Claude makes for the user to look at, and iterates on with its own file tools while the user reads it beside the conversation, as on claude.ai. Artifacts are Markdown so far; other types (HTML, SVG, diagrams, images, tables) are renderers to add, not new widgets. Later widgets (a diff viewer, an editor) and user actions that reach Claude (a comment on a paragraph, a choice in a form) fit the same design, but only the artifact is built now.

The user can rearrange the panes by dragging them, resize them, switch an artifact pane between artifacts, and close a pane. Only Claude opens new panes, apart from opening an artifact in a new pane from a pane's list.

## Why
A session's output today is a stream of chat. Anything Claude builds up over a conversation, such as a plan, a spec or a report, either scrolls away in the chat or goes into a file in the worktree, which the user has to open elsewhere and which pollutes the repo. A pane that Claude keeps up to date shows the current version next to the conversation, and the user can quote from it into the chat to steer the next edit.

## How it works today
- **Tabs.** `App.tsx` keeps the window's tabs: Projects, one per session (`session:<id>`) and New session tabs. `Body` renders a session's tab as `SessionView`, which owns the session's event stream (`useSessionEvents` in `api.ts`), folds it into chat items (`chat.ts`) and renders the head, the chat and the composer. The server keeps the tab list in `tabs.json` (`TabsStore`, `SavedTabs` in `shared`).
- **Claude.** `ClaudeDriver` (`packages/agent/src/claude.ts`) runs Claude in a detached run in the sandbox (`runs.ts`: a FIFO for stdin, a log for stdout) and attaches to it over SSH. It writes stream-json lines and control requests (`interrupt`, `rewind_files`), and reports each output line as a `message` event. Control responses to its own requests are consumed; everything else goes to the session.
- **Sessions.** `Sessions` (`packages/server/src/sessions.ts`) keeps each session's event buffer (`SessionEvent`, with `seq` numbers and a `buffer` name). Tabs replay it over a socket. `chatEvents` decides what is saved to `<KUMIKO_HOME>/sessions/<id>.json`. Rewind and fork cut and copy the buffer. On a server restart, a live session's run is saved with its offset, and the next server attaches from there (`detachAll`, pickup on startup).

## Design

### Words
- **Window**: what a tab shows. For now each window belongs to one session, and its tab id stays `session:<id>`.
- **Slot**: a leaf of the window's layout, a place that shows one widget. Internal only; users see panes.
- **Widget kind**: a kind of built-in app: `chat`, `artifact`. **Widget**: one instance of a kind, with its own state, for example one artifact. A widget lives in the window, not in a slot: closing its slot hides it, and Claude can show it again.

### The layout
A binary tree, as in tmux:

```ts
type Layout =
  | { kind: "slot"; id: SlotId }
  | { kind: "split"; dir: "row" | "column"; ratio: number; a: Layout; b: Layout };

interface WindowState {
  layout: Layout;
  /** Which widget each slot shows. */
  slots: Record<SlotId, WidgetId>;
  widgets: Record<WidgetId, { kind: WidgetKind; state: unknown }>;
}
```

The chat is the widget `chat` in the slot `chat`. It can't be closed, and a window has exactly one. A window that is only the chat is `{ kind: "slot", id: "chat" }`, which is every window today. The pure functions that change a window (`split`, `close`, `normalize`, `apply`) live in `@kumiko/shared`, so the server and the UI share them.

At most 4 slots in a window in v1. A split gives the new slot half of the one it splits, unless Claude asks for another `size` (between 20% and 80%).

### Widget kinds
Each kind is defined in three places:

```ts
// shared: state and how it changes; pure
interface WidgetKind<State, Op> {
  kind: string;
  /** One line for Claude: what the widget is for. */
  description: string;
  create(input: unknown): State;            // throws WidgetError on bad input
  apply(state: State, op: Op): State;       // throws WidgetError when the op doesn't fit the state
}
// server: what Claude can do with it
interface WidgetTools { tools: WidgetTool[] }   // each maps a tool call to an Op, or reads the state
// web: what it looks like
type WidgetView<State> = Component<{ widget: WidgetId; state: State; window: WindowApi }>;
```

Files: `packages/shared/src/widgets/<kind>.ts`, `packages/server/src/widgets/<kind>.ts`, `packages/web/src/widgets/<Kind>.tsx`, and a registry in each package. Every change to a widget's state is an op through `apply`. Today all ops come from Claude's tools. Later they also come from the user's actions (below), which is why ops come from one place whatever their source.

### State lives in the session's event log
Window changes are session events:

```ts
| { seq; kind: "window"; payload: { op: WindowOp; toolUseId?: string } }
```

`WindowOp` is one of `add` (a widget, not shown yet), `split`, `close`, `update` (an op for one widget, which its kind applies) and `sync` (the layout and the widgets that changed, as they are now). The UI and the server fold the events into the `WindowState` with `windowState(events)`. Keeping the state in the log means everything already built for the log works for windows too:
- **Replay and reconnect.** A tab rebuilds its window from the events it already streams. Buffer names, 4409 replays and pickup after a server restart need nothing new.
- **Saved and resumed.** `chatEvents` keeps `window` events, so widgets are saved with the session and come back when it is resumed.
- **Rewind and fork.** Rewinding to a prompt puts every widget and the layout back as they were at that prompt. A fork carries them over.
- **Kept small.** When a turn's `result` comes, the window events since each prompt are brought down to one `sync` with what they changed, in the place and with the `seq` of the last of them (`compactWindow`), as finished messages replace their deltas. Only what changed is in it, so an artifact the turn didn't touch isn't stored again. One per prompt, not one per session, so a rewind or a fork, which cut at prompts, still finds the window as it was there. A tab that replays from a `seq` inside the run still ends up right, since the `sync` comes last.

The window's state is also kept folded on the server (`Sessions` holds the latest `WindowState` per session) for the tools to work on.

### Claude's tools
**Transport.** Kumiko hosts the tools itself, as an MCP server that Claude reaches over the stream-json control protocol (the spike below proved it). Nothing is installed in the sandbox and nothing in the VM talks to the host over the network.
- Claude starts with `--mcp-config '{"mcpServers":{"kumiko":{"type":"sdk","name":"kumiko"}}}'`.
- Claude sends `control_request`s with `subtype: "mcp_message"` carrying MCP JSON-RPC: `initialize`, `notifications/initialized`, `tools/list`, `tools/call`, and `notifications/cancelled` when a call is interrupted. The driver answers each with a `control_response` (`response: { mcp_response: <JSON-RPC response> }`). These requests are consumed by the driver and never become session events.
- In `packages/agent`, `StartOptions` and `AttachOptions` get `tools?: ToolHost`, an agent-neutral interface: `list(): ToolSpec[]` and `call(name, args, { toolUseId, signal }): Promise<ToolResult>`. The driver speaks MCP; the session layer supplies the tools.

**Loading.** Every widget kind's tools are always registered, so the tool list never changes during a session: a changing list would invalidate the prompt cache. Claude Code's tool search does the loading on demand. A tool with `_meta: { "anthropic/alwaysLoad": true }` is in Claude's context from the start, and the rest are deferred, so Claude sees only their names until it loads one with `ToolSearch`. The window tools and each kind's `*_open` tool are always loaded; the others are deferred. If the deferral ever misbehaves, the fallback is our own `widget_use(kind)` tool plus `tools/list_changed`, which Claude Code also supports, without changing any widget.

**Tools** (Claude sees them as `mcp__kumiko__<name>`):

| Tool | Loaded | Does |
|---|---|---|
| `window_list()` | always | The layout, the widget in each slot, and widgets that aren't shown. This is how Claude learns that the user closed a pane. |
| `window_close({ slot })` | always | Closes a slot. Its widget stays and can be shown again. The chat's slot can't be closed. |
| `artifact_open({ path, title?, place? })` | always | Shows a markdown file in a new slot, or brings back the artifact widget already showing it. Returns `{ widget, slot }`. `title` defaults to the file's first heading, then its name. |

`place` is the same for every kind: `{ split: "right" | "below", of?: SlotId, size?: number }`, by default to the right of the chat. `"right"` and `"below"` rather than horizontal and vertical, which people read both ways.

### Artifacts are files
An artifact widget shows a markdown file, and Claude writes and changes it with its own Write and Edit tools, which it is best practised with. There are no tools to write, edit or read an artifact: Kumiko only shows the file. The text still goes through Claude's output once, as the input of its Write or Edit call, as it would with a tool of ours.

**Where the file is.**
- **By default** it lives in a folder Kumiko owns, outside the repo: `~/.claude/kumiko/artifacts/<session id>/` in the VM. The project's Claude home is already mounted there, so this needs no new mount and no sandbox restart. Kumiko reads the file on the host, from `<claude home>/kumiko/artifacts/<session id>/`, without SSH. Kumiko makes the folder when the session starts and names it in the system prompt and in `artifact_open`'s description.
- **Only there.** `artifact_open` refuses any other path, the repository's included, telling Claude to write the file in the folder: artifacts are the session's own, and the repository's files will get a file browser of their own.

**Knowing when it changed.** The widget's state is the file's text as Kumiko last read it. Kumiko reads each shown artifact's file again (a stat first, so an unchanged one costs nothing):
- after every tool result in the session's stream, which catches Write and Edit as well as a Bash `cat >`;
- when a turn ends;
- when a host `fs.watch` on the file fires, which catches the user editing it in their own editor between turns.

A changed text is recorded as an `update` op with the new text. It is brought down with the turn's other ops like any of them, so replay, resume and pickup after a restart show the artifact as it was last read, even before the file is read again.

**Streaming.** While Claude's Write to a shown artifact's path is still streaming (its `input_json_delta`s), the widget shows the text as it comes. It shows what is on disk again once the tool result arrives.

**Rewind and fork.**
- **Rewind:** the widget's snapshot goes back to the prompt rewound to. For an artifact in Kumiko's folder, Kumiko also writes that snapshot back to the file, so the file and the pane agree whatever the user chose about restoring files. An artifact in the worktree follows the user's choice, like every other file there, and is read again afterwards.
- **Fork:** the new session gets a copy of the original's Kumiko folder, and its widgets point at the copies, so the two sessions don't edit one file. Artifacts in the worktree are shared, like the rest of the worktree.
- **Delete:** deleting a session deletes its Kumiko folder. Deleting a project deletes its Claude home with everything in it.

**Results and errors.** A tool returns a short text result naming the ids, for example `Showing ~/.claude/kumiko/artifacts/3fa2c1/plan.md as w2 in slot s2, right of the chat.`. A refused call is an MCP tool error with a reason Claude can act on, for example `There is no file ~/.claude/kumiko/artifacts/3fa2c1/plna.md. Write it first, then open it.`. Input is checked before anything changes, and these are the limits:
- 4 slots per window.
- 20 artifacts per window.
- 200 characters per title.
- **256 KB per artifact's text.** This is a safety limit on what the pane renders and the session stores, not a limit on what Claude may write. A longer file shows its first 256 KB with a note, and `artifact_open` says so, suggesting the file is split into several.

**Stored once.** Claude's Write calls carry the whole text in their input, and the window's snapshot has it again. In the stored chat, the `content` of a Write to a shown artifact's path is cut down to its size, since the snapshot has the text. The same goes for Edit's strings past 64 KB.

**Telling Claude about it.** The tool descriptions do most of it. `--append-system-prompt` adds three sentences:
- that the session runs in Kumiko, which shows the chat in a window;
- that Claude can show markdown files beside the chat with `artifact_open`, for artifacts the user will want to read as they change;
- the session's folder for them.

### When the server isn't there
Claude runs detached, so it can call a tool while no server is attached.
- **Claude waits.** The spike answered a call 150 s late and Claude carried on, sending a `tool_progress` heartbeat every 30 s in the meantime. Calls have a hard time limit, `MCP_TOOL_TIMEOUT` or the server's `timeout` in `--mcp-config`. Kumiko sets the server's to 60 s. Its tools answer at once, or within half a minute at most (a capture after a reload), and a restart hands calls over in seconds. An hour, as it first was, turned a lost answer into a long hang ("Looked at the panes" for minutes). Past the limit, Claude is told the tool timed out and can retry or carry on. Tools that wait for the user on purpose would go on a second server (`kumiko-ask`) with a longer limit, since the limit is per server.
- **The next server answers.** A call that arrives while no server is attached is in the run's `out` after the saved offset, so the next server sees it when it attaches and answers it then.
- **A call that is pending when a server detaches** has already been read, so the offset is past it. `detachAll` saves the session's pending calls with its run (`StoredRun.pending`: request id and MCP message), once it has let go. The next server answers them after attaching, before anything else.
- **Letting go is a drain, so the handover is exact.** `detach` stops reading Claude's output, so the position stands and everything after it, new calls included, is the next server's to read and answer. It lets the calls under way finish (up to 5 s; those still running stay pending), closes Claude's input, and waits for the attachment to exit, which says every answer written reached Claude's input pipe. Then `detachAll` saves, with the final position and the pending calls. Saving before detaching left a gap: a call read and answered in between, as the app quit, was past the saved position and no longer pending, and its answer was lost, so Claude waited until the tool's timeout. This happened in use. Only if the attachment has to be killed, or there is none, are the answers written during the drain handed on too, to be answered again.
- **Duplicate answers.** If a crash loses the save, a call can be answered twice: once by the old server, once by the new one after replaying it. Claude ignores the second answer (spike). The new server's state is the saved one, which doesn't have the op, so applying it again is right.

### The UI
- **`Window.tsx`** places each slot where the layout puts it, absolutely and as siblings under their own keys (`slotRects`), with a 1 px divider, so a split doesn't remount the chat. It owns the session's event stream, which moves up from `SessionView`, folds the window's state from it, and gives the widgets a `WindowContext` (the window, show, close, quote).
- **`SessionView`** becomes the chat widget. Its 860 px column and `.app:has(> .session)` assumptions are loosened so it works in a narrower pane. In a single-slot window it looks as it does today.
- **The artifact widget** has:
  - A title bar with the title and the file's path, "updated just now" (with a pulse while Claude is writing to it this turn), copy as markdown, and close.
  - A body that renders with the existing `Markdown` component and keeps its scroll position when the text changes.
  - Quoting into the composer for text selected in it, as in the chat (the button by the selection, or Q).
- **In the chat,** a call to a widget tool, and a Write or Edit to an artifact's file, show as a compact line, for example "Edited *Plan*", with **Show** when the artifact isn't shown (`POST /api/sessions/:id/window/show`). A turn's tool lines are folded away once it ends, so a closed artifact needs another way back; where it goes is still to be decided.
- **Closing a pane** is `POST /api/sessions/:id/window/close` with the slot id. It records a `window` event like Claude's. It works on a live session only, like a prompt.
- A window too narrow for its splits (less than about 360 px per slot) stacks them instead, and they can't be rearranged while stacked.

### Artifact types
An artifact's state has a `type`, from its file's extension (`artifactTypeOf`), and the widget renders it by type:

| Type | Files | Shown as |
|---|---|---|
| `markdown` | `.md`, `.markdown` | Markdown; ```` ```mermaid ```` blocks drawn as diagrams (in artifacts only, not the chat, where they would redraw at every delta) |
| `mermaid` | `.mmd`, `.mermaid` | The diagram; one that doesn't parse shows its source and Mermaid's error |
| `svg` | `.svg` | An `<img>` of it, on a white card, as most SVG is drawn for a white page |
| `image` | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` | An `<img>`; the server keeps the bytes in base64, whole, up to 2 MB (`MAX_IMAGE_BYTES`), and none of a larger one |

- **Safety:** SVG and diagrams are shown as images (data URLs in `<img>`), so nothing in them runs or loads; Mermaid runs in `strict` mode with its labels as SVG text. A script in an SVG artifact doesn't run (checked).
- **Mermaid** is loaded on demand, in its own chunk (about 680 KB), the first time a diagram is drawn. It was in the lockfile already, for the docs site.
- **While Claude writes** a diagram or SVG, its source shows; it is drawn once written. A Markdown artifact's diagrams wait the same way.
- `artifact_open` refuses other files, naming the extensions it shows. A new type is an extension in `artifactTypeOf` and a renderer in `ArtifactView`. HTML would render in a sandboxed iframe, which is also where artifacts Claude writes as small apps would go, with their actions through the same channel as the user's.
- Artifacts are what Claude makes; the diff viewer and the editor, which work on the worktree, stay widgets of their own kinds.

The tool descriptions and the system prompt say that the artifact is the file and the tool takes its path, since Claude may know artifacts as content it passes inline.

### Pages: HTML artifacts and live previews
- **HTML artifacts** (`.html`, type `html`) render in an `<iframe srcdoc>` with `sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals"`, without `allow-same-origin`, so the page has an opaque origin: no access to the app, and the server refuses `Origin: null`. A content security policy is put first in the page (`htmlPolicy.ts`; after a doctype, or the page renders in quirks mode). It allows `https:`, `data:` and `blob:` for loading and `https:` for fetching, and nothing over plain `http:`, which is how a page would reach this machine and its network. CDNs (Tailwind, fonts, chart libraries) work. The cost is that a page can send data to any HTTPS server, which Claude can do from the sandbox anyway. The title comes from `<title>`. While Claude writes the file, its source shows, as a page re-rendered at every delta would reload.
- **Previews** (type `preview`, `artifact_open({ url })`) show a page the sandbox serves, such as a dev server or Storybook. Lima forwards the sandbox's ports bound to `127.0.0.1` or `0.0.0.0` to the same ports on the host. Only `localhost`, `127.0.0.1` and `[::1]` URLs (`isPreviewUrl`), checked to answer first; Claude is told what to do when nothing does. The state's `path` is the URL; nothing is read or watched, and the dev server's own reload keeps the page current. In the app, a `<webview>` (`webviewTag`). The main process locks each one down as it attaches (no preload, no Node, sandboxed, partition `km-preview`, preview URLs only), and sends links elsewhere and new windows to the browser. In a browser, an iframe on the page's own origin.
- **The server's origin check** (`guard.ts`) accepts browser requests from its own origin only, not from any localhost port, since a preview runs the sandbox's code in this machine's browser. The dev UI's Vite proxy rewrites the Origin of its own page's requests, and only those.
- **Pane controls:** a width to show the page at (full, 1280, 768, 390), Reload, and for a preview Open (in the browser).
- **Asking the window, for Claude:** a `pane` server event (`{ session, slot, request, reload, capture, wait }`) asks the window showing the session to load the page in a slot again and wait for it to load (a `<webview>` reloads itself; a frame gets its source again; at most 10 s), then, `wait` ms later, to take a picture of the pane. The window answers `POST /api/sessions/:id/window/answer` with the picture, nothing, or the reason it can't; the server waits up to 20 s. Only the active tab's window is mounted, so another tab's session gets no answer, and Claude is told why.
- **Tools:** `artifact_capture({ artifact?, reload?, wait? })`, always loaded, returns the picture as an MCP image. `wait` (0 to 10 000 ms; by default 300 after a reload, else 0) is for pages that animate or load data late: a Chart.js chart captured 300 ms after loading was caught mid-animation. A preview's comes from its `<webview>` (`captureWebview`); anything else from the pane's body in the window (`capture`). The main process takes both and scales them to at most 1600 px wide. `artifact_reload({ artifact? })`, deferred, loads a page again: for a dev server without live reload, or a stuck page. `artifact_open` on a preview that is shown already reloads it. All the artifact tools find an artifact by its id, its file's path (as given or resolved) or a preview's URL. `artifact_remove` says whether the file is still there, was gone already, or (for a preview) says nothing of one.
- **Untested here:** the `<webview>`, captures and the main process's checks run only in Electron, which this machine can't run; the browser paths and the server are tested.

### External websites
- **Type `web`:** `artifact_open({ url })` with a public `http(s)` URL (`isExternalUrl`: not loopback, private, shared or link-local ranges, nor local names such as `*.local`, `*.internal` or dotless hosts, per `isPrivateHost`). The server refuses private URLs outright.
- **Approval:** a site Claude opens loads only once the user allows it. The pane shows the URL with Allow and Deny (`POST /api/sessions/:id/window/approve`). Allowing approves the site's origin for the session: other pages of it that Claude opens load at once, and those waiting are approved too. Denying removes the artifact, as if it never opened: its pane goes back to what it showed before, or closes. `artifact_capture` and `artifact_reload` refuse a site not allowed yet, and `window_list` says it is waiting. Approval is stored as `approved` in the artifact's state, so it replays, rewinds and forks with the window.
- **Containment, in the main process:** the webview's partition is set from its URL, whatever the page asked for: `km-preview` for this machine's pages, `km-web` for sites, both in memory only. Both deny every permission and block downloads. For `km-web`, `webRequest.onBeforeRequest` cancels requests to private addresses and to names that resolve to them (looked up with `dns.lookup`, remembered for a minute), and anything but `http(s)`, `ws(s)`, `data:`, `blob:` and `about:`. Navigation stays on external sites; other links and new windows go to the browser. The lookup and Chromium's own resolution are separate, so DNS rebinding between them isn't fully covered.
- **Why:** previews run pages the user runs; here Claude picks the URL, and the page runs from the host's network position, where `artifact_capture` would let it read what the sandbox can't reach (an intranet, a router). Hence the approval, and the private-network block without which this shouldn't ship.
- **In a browser** (`npm run dev:web`), the block isn't possible, so an allowed site only offers to open in a tab of its own.

### Many artifacts, one pane
An artifact pane shows one artifact at a time and switches between all of the window's artifacts:
- **The `show` op** shows a widget in a slot in place of what the slot showed, which stays in the window. A widget shown in another slot swaps with it, so a widget is never in two slots.
- **`active`** in the window's state is the slot last split off or shown into, like tmux's active pane. It goes into each turn's `sync`, since the ops that set it are compacted away.
- **`artifact_open` reuses the pane.** Without `place`, it shows the file in the active slot if that shows an artifact, else in any slot that does, and splits only when none does. `place: { split }` asks for a new pane; `place: { in: slot }` names one.
- **The pane's title is a switcher** listing this pane's artifact and those no pane shows (one shown in another pane is there already), by title, each with an icon for its type: Markdown a page, Mermaid a diagram, SVG and images a picture (to the user both are pictures), HTML `</>`, a preview a screen, a website a globe. Each has an open-in-new button that opens it in a new pane split off this one, beside it if the pane is wider than tall, else below, and an × that removes it from the list. `POST /api/sessions/:id/window/show` takes the slot, and `split` for a new one.
- **Unread:** an artifact that changed while no pane showed it has a dot, in the list and on the title, until a pane shows it. Changes in the history replayed on opening the tab don't count. For this, Kumiko reads every artifact's file again, shown or not, and watches all their folders.

### What a pane showed before
`under` in the window's state records, for a widget `show`n in place of another, the one it replaced (a swap records nothing: both stay shown). Removing an artifact (`removeArtifact`) puts that one back in its pane, if it's still in the window and not shown elsewhere; failing that, the user's × and `artifact_remove` show the artifact added last of those not shown, and Deny closes the pane. `under` is carried by `sync`, and a removed widget leaves it.

### Pages that don't load
- **Blocked pages are announced by the main process.** A main-frame request the guard cancels makes Electron drop the navigation without a word: `did-start-navigation`, then `did-stop-loading`, no failure event, no URL (checked with a diagnostic in the app). So the main process sends the embedder `kumiko:page-blocked` with the `<webview>`'s web contents id, and its pane shows "This page didn't load — Blocked: it points to the user's machine or a private network…".
- **Other failures:** the pane also listens for `did-fail-load` and `did-fail-provisional-load` on the main frame (ignoring loads replaced by another), and counts a load that stops with no page committed as "Nothing loaded from …". The reason stays in `data-load-error` until a page really loads (`did-navigate` with an HTTP response), not merely when a load starts: putting up Chromium's own error page after a failure counts as one.
- **Pictures:** a pane request captures a page that didn't load from the pane's area of the window, rather than from the `<webview>`, which has nothing to show (`UnknownVizError`, or a capture that never returns). It answers with a `note` that `artifact_capture` and `artifact_reload` pass on to Claude. The main process captures the whole window and crops it to the pane's rectangle itself, as Electron's own rectangle option returned the whole window, other tabs' titles and all. A picture never shows more than its pane. The `<webview>`'s capture gets 3 s and the pane's area 5 s, so the window always answers.
- **Reloading a page that never loaded:** its `<webview>` can't `reload()`, which threw and left the window silent, so it is given its address again. Any error in answering a request is answered with, never swallowed.

### Removing artifacts
- **The `remove` op** takes a widget out of the window for good, closing its slot if one shows it; the chat stays. A `sync` lists the widgets `removed` in its run, so compaction keeps removals.
- **`artifact_remove({ artifact })`**, deferred, takes an artifact by its id or its file's path, and the switcher has an × on each entry (`POST /api/sessions/:id/window/remove`). Both go through `Widgets.remove`: `removeArtifact`'s ops (see "What a pane showed before"), then the file is deleted, as an artifact is the session's own and only files in its folder are artifacts. A preview or a website has no file and only leaves the window. Rewinding to before the removal brings the artifact back, file and all: the write-back after a rewind writes an image's bytes, not the base64 the window keeps it in. In the switcher a file artifact has a trash icon ("Delete"), a page an ×.
- **The tool names the session's folder.** `artifact_open`'s description says where this session's artifacts go (`toolsFor(folder)`), so Claude doesn't depend on the system prompt for it; a session resumed after an upgrade showed it may not see the prompt's line.

### Arranging panes by hand
- **Ops:** `move { slot, to, side }` takes a slot out of the layout (its sibling takes its room) and splits `to` in halves with it on `side` (`left`, `right`, `above`, `below`); `side: "swap"` trades the two slots' places in the tree. Slots keep their ids and widgets, so nothing remounts, and the chat moves like any other. `resize { path, ratio }` sets the share of the first side of the split at `path` (`a`/`b` steps from the root). `split` takes all four sides too, `left` and `above` putting the new slot first.
- **Handles:** each pane has one when the window has more than one pane, the session is live and the panes aren't stacked: in an artifact's header, and floating in the chat's top-left corner, clearer on hover.
- **Dropping:** the window hit-tests the pointer against the slots' rectangles. In a pane, the middle third each way swaps; elsewhere the nearest edge wins, which cuts the pane along its diagonals, so the zones never overlap. The preview is where the pane will land: the half on that side, or the whole pane for a swap. Over itself, the dragged pane is a whole target too, and a drop there does nothing. A transparent overlay covers the window while dragging, so no pane (or iframe, later) takes the pointer. Escape cancels; a layout that changes mid-drag ends it.
- **Dividers:** a 6 px strip along each split's boundary. Dragging follows the pointer locally and sends one `resize` when let go. Each side keeps 240 px (120 px tall) per pane across it.
- **Routes:** `POST /api/sessions/:id/window/move` and `/window/resize`.
- **Pages keep their scroll:** slots are rendered in their own order, not the layout's, so a move doesn't move a pane in the page.
- **Later:** dropping on the window's outer edges to span its whole width or height, and a menu on the handle (move left/right/up/down, swap with…) for the keyboard.

### Later, designed for but not built
- **User actions.** A widget kind declares the actions its view can send. Each goes through `apply` as an op (with `source: "user"`) and reaches Claude in one of three ways:
  - **Notify:** recorded, shown as a chip in the chat, and sent along with the next prompt and in the next widget tool result. It never starts a turn.
  - **Prompt:** sent as a user message, which starts a turn or queues behind the current one.
  - **Answer:** completes a tool call that waits for the user, for example a form, with the per-server `timeout` and `notifications/cancelled` to cover Stop and pane closes.
- **More kinds:**
  - The **diff viewer**, the first widget whose state is a reference (`{ base, paths }`) to the worktree, read from host git, rather than content. Rewind doesn't apply to it.
  - The **editor**, on worktree files.
  - **HTML artifacts**, in a sandboxed iframe: a type of artifact (see "Artifact types"), including small apps Claude writes, their actions through the same channel as plain serializable messages.
- Focusing a pane from the keyboard, and more than one chat in a window.

## Spike (phase 0): what was found
Run on 2026-10-21 against Claude Code 2.1.304 on this machine (`claude -p` in stream-json mode, local, not over SSH to a sandbox; the runs layer is plain stdio, so the transport is the same):
- `--mcp-config` with `"type": "sdk"` works with no `initialize` control request from our side. Claude does the MCP handshake (`initialize`, `notifications/initialized`, `tools/list`) as soon as it starts, before `system/init`, then calls `tools/call` with `_meta: { "claudecode/toolUseId": "toolu_…" }`. That id links the call to the `tool_use` in the chat.
- The tool shows up as `mcp__kumiko__echo`, and the result comes back as a normal `tool_result`.
- **Deferral:**
  - Without `anthropic/alwaysLoad`, the tool was deferred: Claude ran `ToolSearch` with `select:mcp__kumiko__echo` first, then called it.
  - With `alwaysLoad: true`, Claude called the tool directly.
  - Tool search was on by itself here. In a sandbox with fewer tools it might not be; phase 3's check covers that, and `ENABLE_TOOL_SEARCH=true` forces it.
- **Late answers:** an answer 150 s late was accepted. There was a `tool_progress` heartbeat (`heartbeat: true`) every 30 s while Claude waited.
- **Duplicate answers:** a second `control_response` for an answered request was ignored.
- **Interrupt** during a pending call sends `notifications/cancelled` with the JSON-RPC id, and Claude records the call as rejected. A later answer to the cancelled call is ignored.

`npm run widgets-check` (phase 3) runs the driver's own tool hosting against a real Claude, through a run (its FIFO and log). On 2026-10-21, with `--local` on this machine (no Lima here), every check passed:
- An always-loaded tool was called directly.
- A deferred tool was loaded with `ToolSearch` first, then called.
- A call under way when the driver detached was left pending, and the next driver answered it after attaching.
- A file under `~/.claude` that Claude changed with Write was put back by `rewind_files`, so Claude's checkpoints cover the Claude home.

Still to run: the same with `--sandbox <name>` against a project's sandbox, over SSH.

## Phases
One PR each.

1. **Window shell, no visible change.**
   - Shared types and layout functions.
   - `Window.tsx` with the chat as its only widget, the event stream moved up, and the CSS so the chat works in a pane.
   - Tests: the layout functions; the existing web tests still pass.
2. **Window state in the log.**
   - `window` events, `windowState`, one `sync` per prompt (`compactWindow`), and `chatEvents` keeping them.
   - Rewind and fork carry them, and the server keeps the folded state.
   - The close route.
   - Tests: folding; compacting; rewind and fork restoring the right state; resume after a restart.
3. **Tools.**
   - `ToolHost` in the driver (the MCP handshake, calls, cancellation, pending calls saved across a detach).
   - The widget registry, the window tools and `artifact_open` with its limits.
   - Artifacts as files: the session's folder, reading files again, storing each text once, and writing back on rewind and copying on fork.
   - The system-prompt lines.
   - The fake claude learns to make MCP calls ("widget …" prompts), for tests.
   - `npm run widgets-check` against a real sandbox.
4. **The artifact widget in the UI.** The widget, streaming a Write into it, the compact tool lines in the chat, closing, quoting from an artifact, and stacking when narrow. Then try it for real: have Claude draft a plan in a pane and iterate on it.

## Open questions
- **Name of the slot ids** Claude sees (`s2`) and widget ids (`w2`): short and per window, or something more readable like the artifact's title as a slug? Short ids are unambiguous; titles change.
- **Saving an artifact to the worktree:** a copy of the file, since an artifact is one. Left out of v1; the repository's files will have a browser of their own.
- **Claude's file checkpointing covers its Claude home** (checked in phase 3), so a rewind with files restored puts back an artifact Claude changed with Write or Edit. Kumiko writing the text back covers the rest: a rewind without files restored, and changes Claude made by Bash or the user made by hand.
- **Artifacts Claude writes by Bash** (`cat > plan.md <<EOF`) don't stream into the pane; they show once the command's result arrives. That's fine unless Claude often writes artifacts that way.
