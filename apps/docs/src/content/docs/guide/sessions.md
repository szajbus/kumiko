---
title: Sessions
description: Talking to the agent in tabs, and how sessions end and come back.
sidebar:
  order: 2
---

A session is one conversation with the agent, in one tab. The agent runs in the project's sandbox, starting in the
clone, and keeps running between your messages until you close the tab. <kbd>Cmd</kbd>+<kbd>T</kbd> opens a new one.

![A session: the first turn's tool calls folded into one line, the agent's reply, and the turn's time, cost and tokens.](../../../assets/screenshots/session.png)

## Closing and ending

- **Closing a tab closes the session.** It stays saved and can be resumed. If the agent is working, Kumiko asks first,
  since the turn stops and the reply in progress is lost.
- <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>W</kbd> closes the tab and deletes the saved session, after asking.
- **Quitting the app** asks the same when the agent is working in any session. On macOS, closing the window leaves the
  app, and the agent, running.
- **Stopping the sandbox** ends its sessions. So does the sandbox stopping outside Kumiko.

An ended session's tab stays open, with its transcript, until you close it.

## Tabs across restarts

The open tabs and the active one are saved, and come back the next time the app starts, with their sessions resumed.
The same happens when Kumiko's server restarts under an open window.
