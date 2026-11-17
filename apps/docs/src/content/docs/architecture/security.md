---
title: Security model
description: What the sandbox keeps from the agent, and the guards around the local server, artifacts, previews and the window.
sidebar:
  order: 4
---

The agent runs with permissions bypassed. So the boundary isn't what the agent asks. It is what the sandbox lets it
reach, and what Kumiko's server and window let a page or a request do.

## The sandbox

The agent can reach only what its sandbox has:

- the workspace disk, with the repos and their worktrees,
- the sandbox's agent home and Kumiko folder,
- the extra mounts you gave it,
- the variables you forward,
- the network.

It can't reach the rest of your files, your own agent configuration, other sandboxes, or your Mac's loopback. So
mounts and forwarded variables are the security decision, and you make it once, when you set up the sandbox.

### Git

The repos live on the sandbox's own disk, not in a folder shared with your Mac. Nothing on your Mac opens that disk.
The clones' git config, hooks and `.gitattributes` can tell git to run commands, and the agent can write them. They
never reach a git on your Mac. Code reaches your Mac only as objects pushed to a mirror, which checks them. Kumiko runs
git on your Mac only in the mirrors, whose config it writes itself.

An extra mount that is a git clone on your Mac is different. It is shared like any folder, and git there runs what
the agent writes into its config.

The sandbox has no GitHub credentials. Git in the VM reaches only the mirrors of the sandbox's repos, through a socket
Kumiko forwards in. The agent's pushes stop at the mirror, and the default branch and tags are refused. Nothing
reaches GitHub until you approve a card, and then Kumiko sends it from your Mac, with your gh login. Your gh login can
bypass branch protections, so the card is the check that holds. [How code reaches GitHub](/architecture/github/)
describes each step.

Text that GitHub tools return to the agent, such as issues, comments and CI logs, is marked as data. On a public
repository anyone can write an issue that is really an instruction to the agent.

### Your Mac's loopback

Lima gives each VM an address, `host.lima.internal` or `192.168.5.2`, that leads to your Mac's `127.0.0.1`. Through it
the agent could reach every service listening there: databases, dev servers, other apps' local APIs. Many of those
trust anything on localhost. Kumiko has Lima block this address unless the sandbox allows it with **This Mac's
localhost**.

The block needs Lima 2.3 or later and a `vz` VM, the default on macOS. Without them, the sandbox page says the sandbox
can reach your loopback. Then run nothing there that you wouldn't let the agent use, or protect it with a password.

### Rebuilding

Rebuilding a sandbox doesn't undo everything the agent did. The workspace disk, the agent home and the Kumiko folder
survive. With them survives what the agent can run again in the new VM: whatever it left in `/workspace`, its
settings, its hooks and its [setup scripts](/guide/sandboxes/#the-agents-setup-scripts). All of these run only inside
the VM. Kumiko reads the setup scripts on your Mac as text, and only plain files in their folder, not links.

**Delete scripts** on the sandbox page clears the setup scripts. **Rebuild from scratch** deletes the workspace disk
too, so only what is pushed comes back. Before it, Kumiko lists what would be lost: branches that aren't pushed,
worktrees with uncommitted changes, and stashes. It finds them with git in the VM, never with git on your Mac.

## The local server

Every request to the server's API must carry a token the server makes each time it starts. The app's window gets it
in a cookie. `HttpOnly` means only the server reads it, and `SameSite=Strict` means only the server's own pages
send it. Scripts send it
in an `Authorization: Bearer` header. Without the token, a sandbox that can reach your Mac's loopback could drive
Kumiko: change its own mounts, forward your variables, or prompt other sandboxes' sessions. The agent can send any
header it likes, but it can't learn the token.

The server also:

- listens on `127.0.0.1` only,
- rejects requests whose `Host` isn't local, which blocks DNS rebinding,
- rejects browser requests whose `Origin` isn't its own, which blocks other sites in your browser and other pages
  served on your Mac, such as a sandbox's dev server shown in a preview.

In development, the UI's Vite proxy passes on its own page's requests as coming from the server's origin, and no
other page's. [HTTP and WebSocket API](/reference/api/#authentication) shows how to sign in.

## Inputs

Ids from URLs and from the agent are checked against their expected shape before they name a file or reach a shell.
Values that go into a shell command are quoted. Forwarded values go over stdin, never in arguments.

## Artifacts

The agent names an [artifact](/guide/artifacts/) by its path in the sandbox. Kumiko finds the same file on your Mac
through the Kumiko folder the sandbox shares with it. It reads only files in the session's artifacts folder there,
and doesn't follow links out of it. So the agent can't use an artifact to read a file it couldn't already read.
Kumiko writes and deletes artifacts only in that folder: when a rewind puts them back, and when you delete one.

**Reveal** asks Kumiko to show a file in the Finder by its path in the sandbox. Kumiko shows only a file in a folder
your Mac shares with the sandbox, found through the sandbox's mounts. It shows the file and never opens it.

SVG artifacts and Mermaid diagrams are shown as images, so nothing in them runs or loads. Mermaid also draws in its
strict mode. The window gets an artifact's content from the server as plain text, or as a picture for an image, never
as a page. So opening that address runs nothing.

Pages run code from the sandbox on your Mac, so each kind is contained:

- **HTML artifacts** render in a sandboxed frame with an origin of its own, so they can't reach the app, its storage
  or the server. A content security policy lets them load and fetch over HTTPS only. Plain HTTP is blocked, because
  that is how they would reach your Mac and your network. Form submissions and base URLs are blocked too.
- **Previews** show only pages on `localhost`, `127.0.0.1` or `[::1]`. In the app they run in a sandboxed `<webview>`
  with a process and storage of their own, and no preload or Node. Links and new windows to this machine's pages open
  in the pane. Anything else is stopped, and the pane offers to open it in your browser. Previews load from this
  machine and the web, but not from private networks, and the server refuses their requests. Lima forwards the
  sandbox's ports to your Mac's loopback, so on a port where nothing of yours listens, the agent's server can. A tool
  of yours that expects its own server on that port, Kumiko included, may reach the agent's instead.
- **Websites** load only after you allow them, per site and session, because the agent picks the URL. They run in a
  `<webview>` with in-memory storage of their own, apart from previews', with no permissions and no downloads. The app
  cancels their requests to loopback, private and link-local addresses, to local names, and to names that resolve to
  such addresses. Otherwise a site could read your intranet for the agent, through a picture of the pane. One gap
  remains. The app resolves a name itself and Chromium resolves it again to connect, so a name whose answer changes in
  between isn't fully covered. Kumiko in a browser can't make this check, so there websites open only in a tab of
  their own.
- **Pictures of panes** for the agent are taken by the app's main process, and only of the app's own window or one of
  its previews. A picture is cropped to the pane it is of. The agent's tools for this talk to Kumiko over the agent's
  own input and output, not the network.

## The window

The renderer is sandboxed, with no Node access. Only `http(s)` and `mailto` links open, in your browser, and only ones
you click in the app's own page. The app opens no windows, so a page framed in it, such as an HTML artifact, can't
open one by script. Navigating away from the app's origin is refused, and frames in it load over HTTPS only. All
pages, the app's own included, use WebRTC only through a proxy, so WebRTC can't get around the checks above.

The packaged app ignores `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and the inspector's options, so no other program can
start it to run code as Kumiko.

Images in the agent's Markdown, in the chat and in artifacts, load only over HTTPS or from data in the text itself.
Others show their description instead. Over plain HTTP your Mac would fetch them, and your Mac can reach your network
where the sandbox can't.
