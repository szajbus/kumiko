---
title: Sessions
description: Talking to the agent in tabs, and how sessions end and come back.
sidebar:
  order: 2
---

A session is one conversation with the agent, in one tab. The agent runs in the project's sandbox, starting in the
clone, and keeps running between your messages until you close the tab, even while Kumiko itself isn't running. <kbd>Cmd</kbd>+<kbd>T</kbd> opens a new one.

![A session: the first turn's tool calls folded into one line, the agent's reply, and the turn's time, cost and tokens.](../../../assets/screenshots/session.png)

## Subagents

When the agent hands work to subagents, each one's thinking, tool calls and messages show under the tool call that
started it, while it works. Once it's done they fold behind a line summing them up, as a turn's work does.

A subagent started in the background goes on after the turn is over. Until it's done, the turn's folded work says so,
a line below the turn says what it is doing, with **Show** to open it, and the tab says Working. When it's done, the
agent takes a turn of its own to report on it.

## Tabs

Each project's tabs sit together, behind a label with the project's name in a colour of its own, so a tab only needs
the session's name: the one given with `/rename`, or else the first words of your opening message. Hover a tab for its
project and state.

- Drag a tab to move it among its project's tabs, or drag the label to move the project's tabs together.
- Click the label to open the project.
- A New session tab sits with the project picked in it, and moves if you pick another.

## Sessions working together

A session's agent knows about the other sessions of its project, and no other project's:

- **It can list them**, by their names and descriptions, open ones and saved ones, to find work already under way.
- **It can ask to start a new one** when separate work comes up, such as a bug found along the way. The chat shows the
  opening prompt it wrote, and any artifacts it wants to give the new session, with **Start session** and **Decline**.
  Nothing starts until you accept; then the session opens in a tab of its own, in the clone, with that prompt and
  copies of those artifacts, and nothing else of the conversation. The agent isn't told what you chose.
- **It can share artifacts with another open session.** The other session gets copies, as they are then, in its window
  for you to show, and its chat says what came from where. Its agent is told with your next message there, by a note
  Kumiko adds to what the agent gets; your message stays as you wrote it. Each session changes its own copy, and
  sharing again replaces it.

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
