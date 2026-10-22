---
title: Artifacts
description: Plans, diagrams, drawings and charts the agent keeps up to date in a pane next to the conversation.
sidebar:
  order: 4
---

The agent can open an **artifact** in a pane beside the chat: a file it makes and keeps changing while you look at it,
such as a plan it iterates on with you. Ask for one ("draft the plan in an artifact"), or the agent opens one itself
when it fits.

![A session with the agent's checkout plan open beside the chat.](../../../assets/screenshots/artifacts.png)

An artifact can be Markdown, a Mermaid diagram, SVG, an image (up to 2 MB), an HTML page, a **live preview** of a page
the agent serves in the sandbox (your dev server, Storybook), or a **website**, which loads once you allow its site.

## Pages and previews

The agent can see what it made: it takes a picture of a pane as you see it, and can reload a page first. It needs the
session's tab open in the Kumiko app for that.

For a preview to show, the dev server has to listen on `127.0.0.1` or `0.0.0.0` (with Vite, `--host 127.0.0.1`). HTML
pages and websites can't reach your Mac or your network; see [Security model](/architecture/security/#artifacts).

## Easy to miss

- Select text in an artifact and press <kbd>Q</kbd> to quote it in your message, with a line naming the artifact.
- <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd> opens the list of the session's artifacts, to show or hide them.
- Drag a pane by its handle (⠿) right to the window's edge to have it span that whole side. Click the handle for a
  menu that moves it from the keyboard.
- Edit an artifact in your own editor and the pane follows. The agent isn't told, so ask it to read the file again.

## Where artifacts are

In a folder of the session's own, `~/.kumiko/sandbox/<project>/artifacts/<session>/`, not in your worktree.
**Rewind** puts them back as they were at that message, **fork** gives the new session its own copy, and deleting a
saved session deletes them.
