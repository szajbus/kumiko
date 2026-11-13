---
title: Writing messages
description: The message box, files, pasted text, quotes, suggestions, slash commands and shell commands.
sidebar:
  order: 3
---

<kbd>Enter</kbd> sends, <kbd>Shift</kbd>+<kbd>Enter</kbd> starts a new line. What you've typed in a tab stays there
while you switch to others.

## Attaching files

Drop files on the box, paste them, or pick them with the paperclip. They are listed above the text and go to the agent
with the message, as content it reads directly rather than files in the sandbox.

| Kind | Up to |
| --- | --- |
| Images | 5 MB each, scaled down to 1568 px on the long edge first |
| PDFs | 20 MB each |
| Text (UTF-8) | 10 MB each |

All the files of one message can add up to 24 MB, which is as much as the model's API takes in one request once the
files are encoded. Kumiko tells the kind from the file's bytes, not its name. Anything else, or anything too big, is left
out with a reason. With Claude Code, every file goes to the API again with each later turn, so a session that has sent
large files can still go past the API's limit later on.

For anything bigger, or a kind the agent can't read directly, put it in the clone or an extra mount and point the agent
at it.

## Pasting long text

A paste of more than one line goes into the box as a label, such as `[Pasted text #1 +5 lines]`, and is sent as what
you pasted. Backspace or Delete next to a label removes it whole. Pasting the same text again right after the label
opens it up into the box.

## Quoting the chat

Select text in the chat, or in an [artifact](/guide/artifacts/), and press the **Quote** button that shows up, or
<kbd>Q</kbd>. It goes into the box as a Markdown quote; text from a code block keeps its fence and language.

## Suggestions

When the box is empty after a turn, the agent's guess at your next message shows dimmed in it. <kbd>Tab</kbd> takes it,
<kbd>Backspace</kbd> drops it.

## Slash commands

Typing `/` offers the commands the agent lists for the session. For Claude Code, that is its built-ins that work
headless (`/compact`, `/clear`, `/model`, `/context`, `/usage`, `/config`, `/mcp`, `/effort`, …), plus your custom
commands and skills. Arrow keys move
through them, <kbd>Tab</kbd> or <kbd>Enter</kbd> picks one, <kbd>Esc</kbd> closes the list. A command is sent as an
ordinary message.

Kumiko handles a few itself:

| Command | Does |
| --- | --- |
| `/login` | Opens the [login dialog](/guide/login/). Headless Claude Code can't run it itself. |
| `/fork` | Forks the whole conversation into a new tab. |
| `/rewind` | Asks to rewind to just before your last message. |

`/rename <title>` gives the tab a title in place of the opening message. Until you do, the agent names the session
itself, in a few words, once your messages make clear what it is about, and again if the subject changes. A name you
give with `/rename` stands: the agent can't change it. The agent also describes the session in a sentence, which the
list of sessions to resume shows under its name.

## Shell commands

A message that starts with `!` is a command to run in the sandbox, as with `!` in Claude Code's terminal. Typing `!` into
an empty box turns it into shell mode: the `!` becomes the box's marker, the box goes pink and monospaced, and the line
under it says where the command runs. <kbd>Backspace</kbd> at the start of the box takes the `!` away again, keeping
what you typed. To start a message with a real `!`, type `!`, then <kbd>Backspace</kbd>, then `!` again.

The command runs at once, in the session's working directory (the clone, or its worktree), as the same user and with the
same forwarded variables as the agent. It always starts there: a `cd` lasts for that one command, and doesn't follow
where the agent has gone. Its output shows in the chat as it comes, with **Stop** to interrupt it. Stop sends an
interrupt, as <kbd>Ctrl</kbd>+<kbd>C</kbd> would, then ends it if it's still running a few seconds later. Once the
command ends, so does anything it left running in the background. A command has no time limit, so a dev server or
`tail -f` keeps going until you stop it. It has no input either: one that asks for some reads the end of it, and
`sudo` or an editor won't work.

When it ends, the agent gets the command and its output, the way Claude Code gives it a `!` command, and replies to
it, so you can follow up with "fix that" without pasting anything. If the agent is working when the command ends, it
reads it at its next step, as with any message sent then. Long output is cut in the middle: Claude Code gets up to
30,000 characters, as much as it gets of one of its own commands, and the rest is in a log in the sandbox, at
`~/.cache/kumiko/shell/`, which the chat names. The chat keeps the first 32 KB and the last 224 KB.

In shell mode, <kbd>↑</kbd> and <kbd>↓</kbd> go through the commands you ran before, not the other messages, and a
command recalled in an ordinary message switches the box into shell mode. Slash commands aren't offered, nor are the
agent's suggestions, and files can't go with a command. A command can't be taken back once sent, since it has run.
Rewinding to a command takes the session back to before it, like rewinding to any message.
