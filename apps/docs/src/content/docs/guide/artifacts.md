---
title: Artifacts beside the chat
description: Plans, diagrams, drawings and charts the agent keeps up to date in a pane next to the conversation.
sidebar:
  order: 4
---

A session's tab is a window, and the chat is one pane of it. The agent can open an **artifact** in another pane: a
file it makes and keeps changing while you look at it beside the conversation, such as a plan it iterates on with you.
Ask for one ("draft the plan in an artifact"), or the agent opens one itself when it fits.

An artifact can be:

- **Markdown** (`.md`): plans, specs, reports. Code blocks in it marked `mermaid` are drawn as diagrams.
- **A Mermaid diagram** (`.mmd`): flowcharts, sequence diagrams and the like. One that doesn't parse shows its source
  and the error.
- **SVG** (`.svg`): drawings, shown on a white card, as most are drawn for one.
- **An image** (`.png`, `.jpg`, `.gif`, `.webp`, up to 2 MB), such as a chart the agent generates with a script.
- **An HTML page** (`.html`), such as a mock-up of a design, or an interactive chart or report. It runs in a sandbox:
  it can load from HTTPS (CDNs, web fonts) but can't reach your Mac, your network or Kumiko.
- **A live preview** of a page the agent serves in the sandbox, such as your project's dev server or Storybook, for
  working on components. The agent starts the server and opens its address, such as `http://localhost:5173`; Lima
  makes the sandbox's ports available on your Mac. The dev server's own reload keeps it current.
- **A website**, such as your deployed site or a reference page. The first time the agent opens a page of a site in a
  session, the pane asks you first: **Allow** loads it and lets the agent open other pages of that site, **Deny**
  takes it away, and the pane goes back to what it showed before. A site runs with nothing of yours (no logins or cookies) and can't reach your Mac or your networks.

## Pages, previews and websites

An HTML page, a preview or a website fills its pane. Its header has the width to show it at (full, desktop, tablet or phone),
**Reload**, and for a preview **Open**, which opens it in your browser.

The agent can **see** what it made: it takes a picture of an artifact's pane, as you see it, while it iterates on how
something looks. It can also load a page again, as **Reload** does, when a dev server doesn't reload by itself. That needs the session's tab open and on screen in the Kumiko app; it doesn't work with Kumiko in a
browser.

A page that doesn't load says why in its pane, such as a website pointing at your own machine, which Kumiko blocks.

For a preview to show up, the dev server in the sandbox has to listen on `127.0.0.1` or `0.0.0.0` (with Vite,
`--host 127.0.0.1`), and its port mustn't be taken on your Mac already. The agent is told so when nothing answers.

## What you see

- The pane follows the file. While the agent writes it, the text comes in as it is written, and **Claude is writing**
  shows in the pane's header. **Updated** shows for a moment after it changes.
- The chat sums up what the agent did with it, such as "Opened *Plan*" or "Edited *Plan*".
- A pane shows one artifact at a time. When the agent opens another, it takes the place of the one in the pane, which
  stays in the session. Click the pane's title to switch it to another of the session's artifacts: the list has
  this pane's and those no pane shows, by title, each with an icon for its kind. A dot marks those the agent changed
  while no pane showed them. The open-in-new button beside one opens it in a new pane, split off this one: beside a
  wide pane, below a tall one.
- **Copy** puts the artifact's Markdown, or the source of a diagram or SVG, on the clipboard.
- Select text in an artifact and press the button beside it, or <kbd>Q</kbd>, to quote it in your message, as in the
  chat. That is the quickest way to ask for a change to one part.
- The trash beside an artifact in that list deletes it, when it's finished with or was opened by mistake: an
  artifact is the session's own, so its file goes too. A preview or a website just leaves the list (the **×**). A pane
  showing it goes back to what it showed before. The agent can delete artifacts too, and rewinding the session to
  before brings them back.
- **×** in the pane's header closes the pane. Its artifacts stay, and the agent can open them again. To show one
  yourself, use **Artifacts** under the message box, which lists all of the session's artifacts and shows the one you
  pick beside the chat, or <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd>, which brings back the last one (and, with an
  artifact pane open, closes it). In the chat, the line for a tool call on an artifact no pane shows has **Show** too.
- In a narrow window, the panes stack one above the other.

The agent opens a second artifact pane only to show two artifacts side by side. A window has at most four panes.

## Arranging panes

With more than one pane open, each has a handle (⠿) in its top-left corner: in an artifact's header, and floating in
the chat's corner. Drag a pane by it onto another:

- **Near an edge** of the other pane, it goes beside it on that side, and the two share its room. Its old place goes
  to the pane beside it.
- **In the middle**, the two swap places.
- **Back over itself**, the whole pane is highlighted, and letting go there leaves it where it was.
- **At the window's own edge**, within a finger's width of it, it goes along the whole of that side: under all the
  others, say, across the window's full width.

While you drag, the place it would land is highlighted. <kbd>Esc</kbd> cancels. Drag the line between two panes to
resize them; a pane doesn't get narrower than about 240 pixels. When the window is too narrow for its panes side by
side, they stack one above the other and can't be rearranged until it is wider again.

## Where artifacts are

Artifacts live in a folder of the session's own, in the project's agent home
(`~/.kumiko/claude/<project>/kumiko/artifacts/<session>/` on your Mac), so they don't land in your worktree. Only files
there are artifacts: files in your repository aren't.

Edit the file in your own editor and the pane follows that too. The agent doesn't hear about your edits, so tell it if
it should read the file again.

- **Rewind** puts the session's artifacts back as they were at that message, files included.
- **Fork** gives the new session its own copy of the artifacts.
- **Deleting** a saved session deletes its artifacts.

A pane shows up to 256 KB of a text artifact; a longer file shows its start, with a note. An image over 2 MB isn't
shown. While the agent writes a diagram or an SVG, its source shows, and it is drawn once written.

## After updating Kumiko

The agent gets its tools for artifacts when its session starts, and keeps those. A session that was running while you
updated Kumiko carries on with the old ones, so the chat says so and offers **Restart Claude**, which starts the agent
again on the same conversation with the new tools.
