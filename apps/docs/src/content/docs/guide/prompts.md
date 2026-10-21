---
title: Writing messages
description: The message box, files, pasted text, quotes, suggestions and slash commands.
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
| PDFs | 10 MB each |
| Text (UTF-8) | 256 KB each |

All the files of one message can add up to 20 MB. Kumiko tells the kind from the file's bytes, not its name. Anything
else, or anything too big, is left out with a reason. With Claude Code, every file goes to the model's API again with each later
turn, which is why the limits are well under the API's own.

For anything bigger, or a kind the agent can't read directly, put it in the clone or an extra mount and point the agent
at it.

## Pasting long text

A paste of more than one line goes into the box as a label, such as `[Pasted text #1 +5 lines]`, and is sent as what
you pasted. Backspace or Delete next to a label removes it whole. Pasting the same text again right after the label
opens it up into the box.

## Quoting the chat

Select text in the chat and press the button that appears beside it, or <kbd>Q</kbd>. It goes into the box as a
Markdown quote; text from a code block keeps its fence and language.

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

`/rename <title>` gives the tab a title in place of the opening message.
