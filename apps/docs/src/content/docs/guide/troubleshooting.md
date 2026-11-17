---
title: Troubleshooting
description: What Kumiko's error messages mean, and how to fix each one.
sidebar:
  order: 9
---

Each entry starts with what you see, then says what to do. Messages in quotes are what Kumiko shows.

## Installing and starting

**macOS says it can't check Kumiko for malicious software.** Apple hasn't signed Kumiko yet. Choose **Done**, then
**Open Anyway** in **System Settings**, under **Privacy & Security**. See
[Install and first session](/guide/quick-start/).

**"Kumiko couldn't start its server", because another Kumiko server is using the home.** Only one Kumiko server runs
per home. Quit the other one. To run a second Kumiko, such as a development build, give it its own home with
`KUMIKO_HOME`. If no Kumiko is running, delete the `server.lock` file the message names.

**"Lost connection to the Kumiko server. Reconnecting…"** The window lost its connection to the server. Kumiko
reconnects by itself. The agents keep working meanwhile.

**Kumiko can't find `limactl`, `gh` or your variables.** An app opened from the Dock gets a bare environment. Kumiko
reads your login shell's environment when it starts, and adds `/opt/homebrew/bin` and `/usr/local/bin` to `PATH`. If
a tool or variable is still missing, export it in your shell profile and restart Kumiko.

## GitHub and mirrors

**"The GitHub CLI, gh, isn't installed."** Run `brew install gh`, then `gh auth login`, then choose **Check again**
on the **Repos** page.

**"Not signed in".** Run `gh auth login` in Terminal, then choose **Check again**.

**"Fetch failed" under a repository.** Git's message says why. A private repository fails to fetch when `gh` is
signed out. Sign it in again and choose **Fetch now**. The mirror keeps what it had.

**In the sandbox, git says "the link to the mirrors on the user's computer is down".** Kumiko lost its SSH
connection to the sandbox, which carries git's traffic to the mirrors. Kumiko reconnects by itself and then clones
any repo still missing. Try again in a minute.

## Sandboxes

**"A workspace disk needs Lima 2.3 or later".** Upgrade Lima with `brew upgrade lima`, then create or rebuild the
sandbox.

**"This sandbox can reach services on your Mac's localhost."** Kumiko can't block the sandbox from your Mac's
`127.0.0.1`. That needs Lima 2.3 or later and a `vz` VM. Until then, run nothing on your Mac's localhost that you
wouldn't let the agent use, or protect it with a password.

**"Provisioning failed".** Claude Code's install or your provisioning script failed. The log on the sandbox page
shows the failing command. Fix the script in **Edit** and choose **Save and rebuild sandbox**.

**"Running · agent setup failed".** One of the agent's setup scripts failed. The sandbox works, but may lack a tool.
Ask the agent to fix its script, or choose **Delete scripts** on the sandbox page and rebuild.

**"Clone failed" or "Not cloned yet" on a repo.** Git's message, or the reason shown, says why. A folder in the way
that isn't a git clone stays as it is, and blocks the clone. Move it, then restart the sandbox. If git can't reach
the mirrors, see the entry above.

**"Can't read Lima's instances." or a record that is unreadable.** Kumiko couldn't read Lima's list of VMs or one of
its own files. The message names the file and the reason. Only that sandbox is affected.

**"The sandbox is stopped, so Kumiko can't see what isn't pushed."** Before Rebuild from scratch or Delete, choose
**Start it and check** to see what would be lost, or go on without checking.

## Logging in

**The login dialog shows an error after you paste the code.** The code was wrong or expired. Choose **Try again**
for a fresh sign-in link.

**The login dialog closed, or you chose Cancel.** The dialog waits 10 minutes for a code. Start again with **Log in**
on the card, or type `/login`.

**"Claude isn't logged in."** The sandbox has no login yet, or it expired. Log in from the card. See
[Log in and use your subscription](/guide/login/).

## Sessions

**"Lost connection to the session. Reconnecting…"** The tab lost its connection to the session. It reconnects by
itself.

**"This session is no longer on the server."** The session ended or was deleted while the tab was open. Resume it
from the New session tab if it's still saved.

**"Start the sandbox to resume this session."** The session's sandbox is stopped. Choose **Start sandbox**.

**"Claude needs a restart for Kumiko's new tools."** Kumiko updated the agent's tools. Choose **Restart Claude** when
the agent is idle.

**A message with large files fails, or later turns fail.** One message's files can add up to 24 MB, and Claude Code
sends every file again with each later turn. Start a new session, or put big files in an
[extra mount](/guide/sandboxes/#mounts) and point the agent at them.

**You can't rewind or fork to a message.** The message is before the last compaction, and Claude Code can't go back
there. Rewind to the first message to start afresh, or fork from a later message.

## Artifacts

**A preview stays blank.** The dev server in the sandbox has to listen on `127.0.0.1` or `0.0.0.0`. With Vite, start
it with `--host 127.0.0.1`.

**The agent says no window answered when it tried to see a pane.** The agent can take pictures only of a tab that is
open and on screen in the Kumiko app. Switch to the session's tab.

**An image in a Markdown artifact doesn't show.** Markdown artifacts load images only from `https` addresses. Ask the
agent to open the image as an artifact of its own.

## Shipping

**The card says "Review again".** The branch moved after the card was made. Choose **Review again** to see its new
state.

**The card warns that the commit won't be signed.** Kumiko found no key. Set `user.signingkey` in your global git
config, or make a GPG key for your `user.email`. See [Signing](/guide/shipping/#signing).

**The agent says git has no name and email to write the commit as.** Set them on your Mac, then ask the agent to
deliver again:

```sh
git config --global user.name "Your Name"
git config --global user.email you@example.com
```

**"GitHub refused" a push.** GitHub's message says why, often a branch protection rule or a missing permission. Fix
it on GitHub and ask the agent to deliver again.
