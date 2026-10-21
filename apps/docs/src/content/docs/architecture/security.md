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

The server listens on `127.0.0.1` and rejects any request whose `Host` or `Origin` isn't local, which blocks DNS
rebinding and other sites in your browser.

## Inputs

Ids from URLs and from the agent are checked against their expected shape before they name a file or reach a shell.
Forwarded values go over stdin, never in arguments.

## The window

The renderer is sandboxed with no Node access. Only `http(s)` and `mailto` links open, in your browser; navigation off
the app's origin is refused.
