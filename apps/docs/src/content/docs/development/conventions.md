---
title: Conventions
description: The rules the code follows, and the reason for each.
sidebar:
  order: 3
---

## Code

**Types the server and UI share go in `packages/shared`.** The UI imports nothing else of the server's, so the two
can't drift apart on an API shape.

**Touch the sandbox only through `SandboxProvider`, and run the agent only through `AgentDriver`.** These two
interfaces are where another provider or agent fits in. Login (`logins.ts`) and the account check (`usage.ts`) still
run `claude` directly. Don't add more of that. See [Adding a sandbox provider or agent](/development/extending/).

**Put UI logic worth testing in a plain module** in `packages/web/src`, with a test in `packages/web/test`. A plain
module runs under Node's test runner without a browser.

**Write strict ESM TypeScript** (`NodeNext`). Relative imports end in `.js`, and type-only imports use `import type`.
Node runs the compiled output as it is, with no bundler in between.

**Errors are typed classes.** One place, `app.onError`, maps each class to an HTTP status. The API always answers
JSON, so the UI reads every error the same way.

**Check input before it reaches a shell or a file.** Check ids against their shape, shell-quote values, and send
secrets on stdin. Ids come from URLs and from the agent, and either can be hostile.

**Kumiko touches only its own sandboxes, and never writes into a project's repository.** Its Lima instances are named
`kumiko-<name>`, and it leaves every other instance alone. Code reaches the host only through git, into the mirrors.
See [Security model](/architecture/security/).

**Comments say why**, in full sentences, and above all behind a workaround. A comment that repeats the code goes
out of date and says nothing the code doesn't.

## Tests

**Tests use the fakes, not mocks.** A fake is a real process that copies what the real tool does, so the code under
test runs as it does in the app. See [Testing](/development/testing/).

**A bug fix comes with a test that fails without it.**

## UI copy

**Keep UI copy short and plain.** Say what happened or what will happen. When something can't be read, name the file
and the reason. Ask before anything that loses work.

## Commits

**Commit subjects say what changes for the user**, in the imperative, without a prefix:

```text
Rewind sessions in place, and fork from a message or with /fork
```

The body says what was wrong and what happens now. The unstable build's release notes are the commit subjects, so
they're written for the people who try it.

**Update the docs in the same commit as the change.** See [Writing docs](/development/writing-docs/).
