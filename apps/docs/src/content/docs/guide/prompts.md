---
title: Write messages
description: Send messages and files, paste, quote and copy text, use slash commands and suggestions, and run shell commands.
sidebar:
  order: 6
---

<kbd>Enter</kbd> sends a message and <kbd>Shift</kbd>+<kbd>Enter</kbd> starts a new line. What you type in a tab
stays there while you switch to other tabs.

## Send while the agent works

A message you send while the agent is working waits as **Queued**. The agent reads it at its next step.
<kbd>↑</kbd> at the start of the box takes the queued message back to edit.

<kbd>Esc</kbd> stops the turn the agent is working on.

## Attach files

Drop files on the box, paste them, or pick them with the paperclip. They're listed above the text and go to the
agent with the message, as content it reads directly, not as files in the sandbox.

| Kind | Up to |
| --- | --- |
| Images | 5 MB each, scaled down to 1568 px on the long edge first |
| PDFs | 20 MB each |
| Text in UTF-8 | 10 MB each |

All the files of one message can add up to 24 MB, which is what the model's API takes in one request once the files
are encoded. Kumiko tells a file's kind from its bytes, not its name. It leaves out anything else, or anything too
big, and says why.

Claude Code sends every file to the API again with each later turn. A session that has sent large files can go past
the API's limit later on. For a big file, or a kind the agent can't read directly, put it in an
[extra mount](/guide/sandboxes/#mounts) and point the agent at it.

## Paste long text

A paste of more than one line goes into the box as a label, such as `[Pasted text #1 +5 lines]`, and is sent as the
text you pasted. <kbd>Backspace</kbd> or <kbd>Delete</kbd> next to a label removes it whole. Pasting the same text
again right after the label opens it up into the box.

## Quote the chat

Select text in the chat or in an [artifact](/guide/artifacts/), then press <kbd>Q</kbd> or the **Quote** button that
appears. The text goes into the box as a Markdown quote. Text from a code block keeps its fence and language. A quote
from an artifact comes with a line naming the artifact.

## Copy the chat as Markdown

Select text in the chat, then press <kbd>C</kbd> or the **Copy** button next to **Quote**. The clipboard gets the
text as Markdown, with its headings, lists, links, tables and code fences. Text selected inside a code block is copied
as a fenced block. <kbd>Cmd</kbd>+<kbd>C</kbd> still copies plain text.

## Take a suggestion

When the box is empty after a turn, the agent's guess at your next message shows dimmed in it. <kbd>Tab</kbd> takes
it, and <kbd>Backspace</kbd> drops it.

## Use slash commands

Typing `/` lists the commands the agent offers for the session. For Claude Code, that's its built-in commands that
work without a terminal, such as `/compact`, `/clear`, `/model`, `/context`, `/usage`, `/config`, `/mcp` and
`/effort`, plus your custom commands and skills. <kbd>↑</kbd> and <kbd>↓</kbd> move through them, <kbd>Tab</kbd> or
<kbd>Enter</kbd> picks one, and <kbd>Esc</kbd> closes the list. A command is sent as an ordinary message.

Kumiko handles some commands itself:

| Command | Does |
| --- | --- |
| `/login` | Opens the [login dialog](/guide/login/). Claude Code can't run it without a terminal. |
| `/fork` | Forks the whole conversation into a new tab. |
| `/rewind` | Asks to rewind to just before your last message. |

`/rename <title>` names the session, and the agent can't change a name you give. To rewind or fork from any message, see [Rewind or fork](/guide/sessions/#rewind-or-fork).

## Change the model or mode

The footer below the box has the model the session runs on: `default`, `opus`, `sonnet` or `haiku`. It also has the
mode: **Bypass permissions**, or **Plan first** to have the agent [plan before it changes
anything](/guide/sessions/#answer-the-agents-questions).

## Run a shell command

A message that starts with `!` is a command to run in the sandbox, as with `!` in Claude Code's terminal. Type `!`
into an empty box to switch to shell mode. The `!` becomes the box's marker, the box turns pink and monospaced, and
the line under it says where the command runs. <kbd>Backspace</kbd> at the start of the box leaves shell mode and
keeps what you typed. To start an ordinary message with `!`, type `!`, then <kbd>Backspace</kbd>, then `!` again.

The command runs at once in `/workspace`, as the agent's user, with the same forwarded variables as the agent. A `cd`
lasts for that one command. Its output shows in the chat as it comes. **Stop** sends an interrupt, as
<kbd>Ctrl</kbd>+<kbd>C</kbd> would, and ends the command if it's still running a few seconds later. When the command
ends, anything it left running in the background ends too.

A command has no time limit, so a dev server or `tail -f` runs until you stop it. It has no input either, so `sudo`
or an editor won't work.

When the command ends, the agent gets the command and its output and replies, so you can follow up with "fix that".
If the agent is working, it reads them at its next step. If it's waiting on your answer to a question, it gets them
once you've answered.

Long output is cut in the middle. The agent gets up to 30,000 characters, as Claude Code gives it of its own
commands. The whole output is in a log in the sandbox, in `~/.cache/kumiko/shell/`, which the chat names. The chat
keeps the first 32 KB and the last 224 KB.

In shell mode, <kbd>↑</kbd> and <kbd>↓</kbd> go through the commands you ran before. A command recalled in an
ordinary message switches the box to shell mode. Shell mode offers no slash commands or suggestions, and takes no
files. A command can't be taken back once sent, since it has run. Rewinding to a command takes the session back to
before it.
