---
title: Sessions
description: Talking to the agent in tabs, and how sessions end and come back.
sidebar:
  order: 2
---

A session is one conversation with the agent, in one tab. The agent runs in the project's sandbox, starting in the
clone, and keeps running between your messages until you close the tab, even while Kumiko itself isn't running. <kbd>Cmd</kbd>+<kbd>T</kbd> opens a new one.

![A session: the first turn's tool calls folded into one line, the agent's reply, and the turn's time, cost and tokens.](../../../assets/screenshots/session.png)

## File edits

When the agent edits or writes a file, its tool line names the file, relative to the project's folder, and how many
lines it added and removed, e.g. `src/app.py +12 −3`. A new file says so, and a failed edit says why. Open the line to
see the change as a diff, with line numbers and a few lines around it; a long one shows its first 30 lines, with
**Show all** for the rest. A turn's folded work says how many files it changed, its subagents' included.

A subagent's edits, and those of sessions from before Kumiko kept them, have no line numbers: Claude Code only says
where in the file an edit was for the main agent's own.

## Subagents

When the agent hands work to subagents, each one's thinking, tool calls and messages show under the tool call that
started it, while it works. Once it's done they fold behind a line summing them up, as a turn's work does.

A subagent started in the background goes on after the turn is over. Until it's done, the turn's folded work says so,
a line below the turn says what it is doing, with **Show** to open it, and the tab says Working. When it's done, the
agent takes a turn of its own to report on it, which starts with a line saying what finished, in place of a message.

## Background tasks

The agent can leave commands running in the background: a dev server, a build, a test run it moved there, or a
**Monitor** watching a log. Their tool call says **background** (or **watching**) while they run, with **Show**.

**Tasks** by the message box, or **Cmd+Shift+B**, opens the Tasks pane beside the chat. It lists what runs in the
background, subagents too, with the shells a subagent started under it, then what has ended. Pick one to see its
command, how long it has run, when the agent will stop it (30 minutes by default), and its output as it comes. **Stop**
stops it; the agent hears of it with your next message. Reading the output costs no tokens. Ended tasks stay listed, with
the end of their output, until you **Clear ended**. When that end isn't all of it, **Show all** reads the whole output
(up to 1 MB) from the agent's own file of it, for as long as the agent keeps that file; a restart of the sandbox
removes it.

When a command ends by itself, the agent takes a turn to report on it, which starts with a line saying how it ended,
with **Output**. A command you stop gets that line, and no turn. A Monitor wakes the agent each time it prints a line,
and that turn starts with the line; when the agent had nothing to say but a short reply, those turns fold into one line
per monitor, which opens to show each line and the reply to it.

While the agent waits on a long command, **Move to background** on its line, or **Ctrl+B**, lets it go on while the
command runs, as Ctrl+B does in Claude Code.

Commands in the background don't make the tab say Working: a server left running isn't work. The tab shows how many
tasks run in the background, and closing it asks first, as that stops them. Stopping a turn leaves them running; they end with
the agent, or when the subagent that started them is done.

## When the agent asks you something

The agent works without asking for permission, but it can stop in the middle of a turn to ask you something. It waits
for your answer for as long as it takes, even while Kumiko isn't running. Meanwhile its tab says **Has a question for
you** or **Plan to review**, and counts as waiting on you.

- **Questions.** It asks one to four questions, each with options to pick from: one, or any number where it says
  **Pick any**. You can answer in your own words in the box below the options, which picks it. The number keys pick
  options while a question has the focus. **Send answers** sends what you picked, and the agent carries on with it;
  **Skip** tells it you didn't want to answer.
- **Plans.** With **Plan first** chosen in the footer, below the message box, the agent explores and writes a plan
  before it changes anything, then shows it to you. **Approve** lets it carry on, and the footer goes back to
  **Bypass permissions**. **Keep planning…** sends the plan back with what you want changed, and the agent asks again
  with a new plan. The agent can switch to planning by itself, too, and the footer shows it.
- **A message instead.** Sending a message while the agent waits answers it: the agent is told you replied with a
  message instead, and reads the message next.
- **Stop** ends the turn, and the agent stops waiting.

Once answered, the card stays in the chat, with your answers.

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
  once and the agent finishes its turn out of sight, for up to 30 minutes; then the session ends. Subagents it started
  in the background count as working: the session ends once they are done and the agent has reported on them.
- <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>W</kbd> closes the tab and deletes the saved session, after asking. If the agent
  is working, it can finish its turn first (**Delete when done**, the default) or stop now (**Stop and delete**).
- While the agent finishes, the Projects tab and the project's page list the session under **Finishing**, to **Open**
  again, the agent still working, or to **Stop now**. <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> brings it back too,
  even one being deleted, until the agent is done. Queued messages aren't sent: the turn under way is all it finishes.
  If the agent asks you something meanwhile, the session says **Needs attention**: **Open** it to answer, or it is
  stopped when its time is up.
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
