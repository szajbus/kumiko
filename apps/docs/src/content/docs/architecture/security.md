---
title: Security model
description: What the sandbox protects, and the guards around the local server.
sidebar:
  order: 9
---

## The sandbox

The agent can reach what the project's sandbox has: the clone and its worktrees, the agent home, extra mounts,
forwarded variables, and the network. Not the rest of your machine, your own agent configuration or other projects.

So mounts and variables are the security decision. Note that a writable clone includes its git hooks, which git on the
host runs.

## The local server

The server listens on `127.0.0.1` and rejects any request whose `Host` isn't local, which blocks DNS rebinding, and any
browser request whose `Origin` isn't the server's own, which blocks other sites in your browser and other pages served
on your Mac, such as a project's dev server shown in a preview. In development, the UI's Vite proxy passes its own
page's requests on as the server's origin, and no other page's.

## Inputs

Ids from URLs and from the agent are checked against their expected shape before they name a file or reach a shell.
Forwarded values go over stdin, never in arguments.

## Artifacts

The agent asks Kumiko to show [artifacts](/guide/artifacts/) by their path in the sandbox, and Kumiko reads them on
your Mac. It only reads files in the session's artifacts folder, in the agent home the sandbox shares with your Mac
anyway, and doesn't follow a link that leads out of it, so the agent can't use an artifact to read a file it couldn't
already. Kumiko writes and deletes only artifacts in that folder: when a rewind puts them back, and when one is
deleted. SVG
artifacts and Mermaid diagrams are shown as images, so nothing in them runs or loads, and Mermaid draws in its strict
mode.

Pages run code from the sandbox on your Mac, so they're contained:

- **HTML artifacts** render in a sandboxed frame with an origin of its own, so they can't reach the app, its storage
  or the server. A content security policy put first in the page lets it load and fetch over HTTPS only: nothing over
  plain HTTP, which is how it would reach your Mac and your network, no form submissions, no base URL.
- **Previews** only show pages on `localhost`, `127.0.0.1` or `[::1]`. In the app they're in a `<webview>`: a process
  and storage of their own, no preload or Node, sandboxed, with links elsewhere opened in your browser. The server
  refuses their requests, as above.
- **Websites** load only once you allow them, per site and session: the agent picks the URL, so it doesn't get to
  load a site without you. They run in a `<webview>` with storage of their own, apart from previews', in memory only,
  with no permissions and no downloads. They can't reach your Mac or your networks: the app cancels their requests to
  loopback, private and link-local addresses and local names, and to names that resolve to such addresses. Without
  that, a site could read your intranet for the agent through a picture of the pane. The check resolves names itself
  and Chromium resolves them again to connect, so a name that changes its answer in between (DNS rebinding) isn't
  fully covered. Kumiko in a browser can't check this, so there websites only open in a tab of their own.
- **Pictures of panes** for the agent are taken by the app's main process, of the app's own window or of one of its
  previews only. The agent's tools
for this reach Kumiko over the agent's own input and output, not the network.

## The window

The renderer is sandboxed with no Node access. Only `http(s)` and `mailto` links open, in your browser; navigation off
the app's origin is refused.
