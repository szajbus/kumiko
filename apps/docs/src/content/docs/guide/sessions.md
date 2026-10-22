---
title: Sessions
description: Talking to the agent in tabs, and how sessions end and come back.
sidebar:
  order: 2
---

A session is one conversation with the agent, in one tab. The agent runs in the project's sandbox, starting in the
clone, and keeps running between your messages until you close the tab, even while Kumiko itself isn't running. <kbd>Cmd</kbd>+<kbd>T</kbd> opens a new one.

![A session: the first turn's tool calls folded into one line, the agent's reply, and the turn's time, cost and tokens.](../../../assets/screenshots/session.png)

## Tabs

Each project's tabs sit together, behind a label with the project's name in a colour of its own, so a tab only needs
the session's name: the one given with `/rename`, or else the first words of your opening message. Hover a tab for its
project and state.

- Drag a tab to move it among its project's tabs, or drag the label to move the project's tabs together.
- Click the label to open the project.
- A New session tab sits with the project picked in it, and moves if you pick another.

## Closing and ending

- **Closing a tab closes the session.** It stays saved and can be resumed. If the agent is working, the tab closes at
  once and the agent finishes its turn out of sight, for up to 30 minutes; then the session ends.
- <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>W</kbd> closes the tab and deletes the saved session, after asking. If the agent
  is working, it can finish its turn first (**Delete when done**, the default) or stop now (**Stop and delete**).
- While the agent finishes, the Projects tab and the project's page list the session under **Finishing**, to **Open**
  again, the agent still working, or to **Stop now**. <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> brings it back too,
  even one being deleted, until the agent is done. Queued messages aren't sent: the turn under way is all it finishes.
- **Quitting the app** leaves the agent working. If it is working in any session, Kumiko says so, and offers **Stop
  Claude and Quit** instead, which ends every session at once. A session finishing after its tab closed goes on
  finishing when Kumiko is back. On macOS, closing the window leaves the app running.
- **Stopping, restarting, recreating or deleting the sandbox** ends its sessions. So does the sandbox stopping outside
  Kumiko.

An ended session's tab stays open, with its transcript, until you close it.

## When Kumiko goes away

The agent doesn't depend on Kumiko: it keeps working when you quit the app, when Kumiko's server restarts or crashes,
and when the connection to the sandbox drops (your Mac going to sleep, say). Nothing it does meanwhile is lost. When
Kumiko is back, each session is open again where the agent got to:

- a turn still going carries on in its tab, with what the agent wrote while Kumiko was away,
- a turn that finished meanwhile shows in full, and the session waits on you,
- an agent that exited meanwhile shows its session as ended, with the error if it failed.

A session whose sandbox stopped or restarted meanwhile isn't open again, but stays saved, to resume.

## Tabs across restarts

The open tabs and the active one are saved, and come back the next time the app starts. Their sessions are open again
as above, or resumed from the saved chat if their agent has gone. The same happens when Kumiko's server restarts under
an open window.
