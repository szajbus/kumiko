---
title: Security model
description: What the sandbox protects, and the guards around the local server.
sidebar:
  order: 9
---

## The sandbox

The agent can reach only what the project's sandbox has: the clone and its worktrees, the agent home, extra mounts,
forwarded variables, and the network. It can't reach the rest of your files, your own agent configuration, other
projects, or your Mac's loopback (below). So mounts and forwarded variables are the security decision.

One thing to watch: the clone is writable, and that includes its git config, hooks and `.gitattributes`. These can
tell git to run commands (hooks, an fsmonitor, filters, a pager, an SSH command), and git on your Mac runs them,
whether you run it in a terminal or an editor such as VS Code runs it when you open the folder. Your global git config
doesn't override the clone's. Kumiko's own git on your Mac turns these off, so the worktree statuses it shows run
none of them.

The sandbox has no GitHub credentials. When the clone's `origin` is on GitHub, git in the VM reaches the repository
only through a socket Kumiko forwards in, which serves that one repository's [mirror](/guide/repos/#projects). Kumiko
decides each push there and pushes what it allows on to GitHub itself, with your `gh` login: the agent's own branches,
never the default branch, tags, or anyone else's branches. The default branch changes only when you approve a card to
[merge a branch into it](/guide/repos/#merging-into-the-default-branch), and Kumiko signs that on your Mac. Which repository a project reaches is read from `origin`
once and kept, so the agent can't point it elsewhere. Your `gh` login can bypass branch protections, so this check is
the one that holds.

Lima gives each VM an address (`host.lima.internal`, 192.168.5.2) that leads to your Mac's `127.0.0.1`. Through it the
agent could reach every service listening there, such as databases, dev servers and other apps' local APIs, and many
of those trust anything on localhost. Kumiko has Lima block this address, unless the project allows it (**This Mac's
localhost**).

The block needs Lima 2.3 or later and a `vz` VM (the default on macOS). Without them, the project page says the
sandbox can reach your loopback. Then run nothing there that you wouldn't let the agent use, or have it ask for a
password.

Recreating a sandbox doesn't undo everything the agent did. The agent home and the Kumiko folder survive, and with
them what the agent can run again in the new VM: its settings, hooks and
[setup scripts](/guide/projects/#the-agents-setup-scripts). All of these run only inside the VM. Kumiko reads the scripts on your Mac as text, and only plain files in their folder, not
links. **Delete scripts** on the project page clears them.

## The local server

Every request to the server's API must carry a secret the server makes each time it starts. The app's window gets it
in a cookie that only the server reads and only its own pages send; scripts send it in an `Authorization` header. A
sandbox that can reach your Mac's loopback can send any headers it likes, so without the secret the agent could drive
Kumiko: change its own mounts, forward your variables, or prompt other projects' sessions.

The server also:

- listens on `127.0.0.1` only,
- rejects requests whose `Host` isn't local, which blocks DNS rebinding,
- rejects browser requests whose `Origin` isn't its own, which blocks other sites in your browser and other pages
  served on your Mac, such as a project's dev server shown in a preview.

In development, the UI's Vite proxy passes on its own page's requests as coming from the server's origin, and no other
page's.

## Inputs

Ids from URLs and from the agent are checked against their expected shape before they name a file or reach a shell.
Forwarded values go over stdin, never in arguments.

## Artifacts

The agent names an [artifact](/guide/artifacts/) by its path in the sandbox, as it sees its own files, and Kumiko
finds the same file on your Mac through the Kumiko folder the sandbox shares with it. It reads only files in the
session's artifacts folder there, and doesn't follow links out of it. So the agent can't use an artifact to read a file
it couldn't already. Kumiko writes and deletes only artifacts in that folder: when a rewind puts them back, and when one
is deleted.

SVG artifacts and Mermaid diagrams are shown as images, so nothing in them runs or loads; Mermaid also draws in its
strict mode. The window gets an artifact's content from Kumiko's server as plain text, or as a picture for an image,
never as a page, so opening that address runs nothing.

Pages run code from the sandbox on your Mac, so they're contained:

- **HTML artifacts** render in a sandboxed frame with its own origin, so they can't reach the app, its storage or the
  server. A content security policy lets them load and fetch over HTTPS only. Plain HTTP, which is how they'd reach
  your Mac and your network, is blocked, and so are form submissions and base URLs.
- **Previews** show only pages on `localhost`, `127.0.0.1` or `[::1]`. In the app they run in a sandboxed `<webview>`
  with its own process and storage, and no preload or Node. Links and new windows to this machine's pages open in the
  pane; anything else is stopped, and the pane offers to open it in your browser. They load from this machine and the
  web, but not from private networks (the same check as for websites, below), and the server refuses their requests.
  Lima forwards the sandbox's ports to your Mac's loopback for previews, so on a port where nothing of yours listens,
  the agent can. A tool of yours that expects its own server there, Kumiko included, may reach the agent's instead.
- **Websites** load only after you allow them, per site and session, since the agent picks the URL. They run in a
  `<webview>` with in-memory storage of their own, apart from previews', with no permissions and no downloads. The app
  cancels their requests to loopback, private and link-local addresses, local names, and names that resolve to such
  addresses; otherwise a site could read your intranet for the agent through a picture of the pane. One gap: the check
  resolves a name itself and Chromium resolves it again to connect, so a name whose answer changes in between (DNS
  rebinding) isn't fully covered. Kumiko in a browser can't make this check, so there websites open only in a tab of
  their own.
- **Pictures of panes** for the agent are taken by the app's main process, and only of the app's own window or one of
  its previews. The agent's tools for this talk to Kumiko over the agent's own input and output, not the network.

## The window

The renderer is sandboxed, with no Node access. Only `http(s)` and `mailto` links open, in your browser, and only ones
you click in the app's own page. The app opens no windows, so a page framed in it, such as an HTML artifact, can't
open one by script. Navigating away from the app's origin is refused, and frames in it load over HTTPS only. All
pages, the app's own included, use WebRTC only through a proxy, so it can't get around the checks above. The packaged
app ignores `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and the inspector's options, so nothing else can start it to run
code as it.

Images in the agent's Markdown, in the chat and in artifacts, load only over HTTPS or from data in the text itself;
others show their description instead. Over plain HTTP they'd be fetched by your Mac, which can reach your network
where the sandbox can't.
