---
title: Security model
description: What the sandbox protects, and the guards around the local server.
sidebar:
  order: 9
---

## The sandbox

The agent can reach what the project's sandbox has: the clone and its worktrees, the agent home, extra mounts,
forwarded variables, and the network, but not your Mac's loopback (below). Not the rest of your files, your own agent
configuration or other projects.

So mounts and variables are the security decision. Note that a writable clone includes its git config, hooks and
`.gitattributes`, which can name commands for git to run: hooks, an fsmonitor, filters, a pager or an SSH command. Git
on your Mac runs them, whether you run it in a terminal or an editor runs it for you when you open the folder, as VS
Code and other git apps do. Your global config doesn't stop them, since the clone's own wins. Kumiko's own git on the
host turns these off, so the worktree statuses it shows run none of them. Run git on the clone from inside the VM when
you can, or read `.git/config` before running git on your Mac.

Lima gives a VM a host address (`host.lima.internal`, 192.168.5.2) that leads to your Mac's `127.0.0.1`, where the
agent could reach every service listening, such as databases, dev servers and other apps' local APIs, many of which
trust anything on localhost. Kumiko has Lima block that address for each sandbox, unless its project allows it (**This
Mac's localhost**). The agent has `sudo` in its VM, so a firewall there wouldn't hold; Lima's block is outside it.

Lima can only block it from version 2.3, and only for `vz` VMs (the default on macOS). Where it can't, the project
says so, and the sandbox can reach your loopback: run nothing there that you wouldn't let the agent use, or have it
ask for a password. Either way, a service on your Mac that listens on all interfaces, not just `127.0.0.1`, is
reachable at your Mac's network address, as from anywhere on your network. A proxy on your Mac's loopback, set for the
sandbox, isn't reachable once it's blocked.

Recreating a sandbox doesn't wipe everything the agent did. The agent home and the Kumiko folder survive it, and with
them what the agent can make run again in the new VM: its settings and hooks, and its [setup scripts](/guide/projects/#the-agents-setup-scripts),
which run when the VM is created (**Delete scripts** on the project page clears them). All of it runs inside the VM only. Kumiko reads the scripts on your Mac as text, only
as plain files in their folder, not through links.

## The local server

Every request to the server's API carries a secret it makes each time it starts: the app's window gets it in a cookie
that only the server reads and only its own pages send, and scripts in an `Authorization` header. A sandbox reaches
your Mac's loopback through Lima's host address, and the agent in it can send any headers it likes, so without the
secret it could drive Kumiko: change its own mounts, forward your variables, or prompt other projects' sessions.

The server also listens on `127.0.0.1` only and rejects any request whose `Host` isn't local, which blocks DNS
rebinding, and any browser request whose `Origin` isn't the server's own, which blocks other sites in your browser and
other pages served on your Mac, such as a project's dev server shown in a preview. In development, the UI's Vite proxy
passes its own page's requests on as the server's origin, and no other page's.

## Inputs

Ids from URLs and from the agent are checked against their expected shape before they name a file or reach a shell.
Forwarded values go over stdin, never in arguments.

## Artifacts

The agent asks Kumiko to show [artifacts](/guide/artifacts/) by their path in the sandbox, and Kumiko reads them on
your Mac. It only reads files in the session's artifacts folder, in the Kumiko folder the sandbox shares with your Mac
anyway, and doesn't follow a link that leads out of it, so the agent can't use an artifact to read a file it couldn't
already. Kumiko writes and deletes only artifacts in that folder: when a rewind puts them back, and when one is
deleted. SVG artifacts and Mermaid diagrams are shown as images, so nothing in them runs or loads, and Mermaid draws in
its strict mode. The window gets an artifact's content from Kumiko's server as plain text, or as a picture for an
image: never as a page, so opening that address runs nothing.

Pages run code from the sandbox on your Mac, so they're contained:

- **HTML artifacts** render in a sandboxed frame with an origin of its own, so they can't reach the app, its storage
  or the server. A content security policy put first in the page lets it load and fetch over HTTPS only: nothing over
  plain HTTP, which is how it would reach your Mac and your network, no form submissions, no base URL.
- **Previews** only show pages on `localhost`, `127.0.0.1` or `[::1]`. In the app they're in a `<webview>`: a process
  and storage of their own, no preload or Node, sandboxed. Links and new windows to this machine's pages open in the
  pane itself; going anywhere else, by a link or by script, is stopped, and the pane offers to open it in your browser
  instead. They load from this machine and the web, not from private networks, by the same check as websites below.
  The server refuses their requests, as above. Lima forwards the sandbox's ports to your Mac's loopback for them, so
  while nothing of yours listens on a port, the agent can: a tool of yours that expects its own server there, Kumiko's
  included, may reach the agent's instead.
- **Websites** load only once you allow them, per site and session: the agent picks the URL, so it doesn't get to
  load a site without you. They run in a `<webview>` with storage of their own, apart from previews', in memory only,
  with no permissions and no downloads. They can't reach your Mac or your networks: the app cancels their requests to
  loopback, private and link-local addresses and local names, and to names that resolve to such addresses. Without
  that, a site could read your intranet for the agent through a picture of the pane. The check resolves names itself
  and Chromium resolves them again to connect, so a name that changes its answer in between (DNS rebinding) isn't
  fully covered. Kumiko in a browser can't check this, so there websites only open in a tab of their own.
- **Pictures of panes** for the agent are taken by the app's main process, of the app's own window or of one of its
  previews only. The agent's tools for this reach Kumiko over the agent's own input and output, not the network.

## The window

The renderer is sandboxed with no Node access. Only `http(s)` and `mailto` links open, in your browser, and only ones
you click in the app's own page: it opens no windows, so a page framed in it, such as an HTML artifact, can't open one
by script. Navigation off the app's origin is refused, and frames in it go over HTTPS only. Pages, the app's own
included, use WebRTC only through a proxy, so it can't reach around the checks above. The packaged app ignores
`ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and the inspector's options, so nothing else can start it to run code as it.

Images in the agent's Markdown, in the chat and in artifacts, load only over HTTPS or from the text itself; others
show their description. Over plain HTTP they would come from your Mac, which reaches your network where the sandbox
can't.
