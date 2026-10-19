# Projects as the primary entity

## Goal
Make the **project** the first thing a user creates. VMs, sessions and worktrees all hang off it. A project is a local git clone; work happens in git worktrees; everything durable lives on the host so a VM can be thrown away.

## Model
- **Project**: a local clone path + exactly one VM + one app-owned Claude home. All config lives in the app; nothing is written into the repo.
- **Worktrees**: not stored by the app. Discovered with `git worktree list --porcelain`. Created on demand by the agent (`git worktree add`). Located in `<repo>__worktrees/<branch>`, a sibling of the clone, created by the app if missing.
- **Sessions**: belong to a project. A session may use no worktree (questions), one, or several. There is no stored or inferred session-to-worktree link.

## Project creation
1. User picks an existing local clone (v1: no clone-from-URL).
2. App validates it is a git repo, derives `<repo>__worktrees`, and creates it if absent. Fail clearly if the name exists as a non-directory or the parent is not writable.
3. App creates the project's Claude home in app data, seeded from the app-level template.
4. App creates the VM for the project.

## VM mounts
| Host | In VM | Notes |
|---|---|---|
| clone path | same absolute path | always, not configurable |
| `<repo>__worktrees` | same absolute path | always, not configurable |
| project Claude home | `CLAUDE_CONFIG_DIR` (VM user's `~/.claude`) | per project, app-owned |
| extra mounts | as specified | optional, chosen at VM creation |

**Same-path is mandatory.** A worktree's `.git` file stores an absolute path to the main repo. If the VM sees a different path than the host, git fails with "not a git repository", and `git worktree repair` only moves the breakage to the other side. Mount at the literal host path, never an alias such as `/workspace/...`. Do not rely on `~`, since the VM user's home differs.

## Claude home
- Lives in app data, keyed by project id, mounted into the VM. The VM sets `CLAUDE_CONFIG_DIR` to the mount point so `.claude.json` stays inside the directory (otherwise it lands beside `~/.claude` and is lost on VM recreation).
- Never the host's real `~/.claude`: that exposes credentials, hooks and settings to the agent and breaks the VM as a sandbox.
- Seeded once from an app-level template `CLAUDE.md` that carries the worktree convention, then allowed to diverge. The app-managed text lives in a separate file imported by `CLAUDE.md` so user edits do not collide.
- Session history is keyed by working directory, which is stable because paths are identical on host and VM.
- Deleted only when the project is deleted, after confirmation (it holds history).
- **Auth, v1:** log in per project. Later: app-level credentials with multiple subscriptions.

## Worktree convention (in the template)
Worktrees go in `<repo>__worktrees/<branch>`. Create one when the task changes code; skip it for questions and read-only exploration. This is a prompt convention, not enforced.

## Sessions
Started in the context of a project, with the clone as the working directory. The user may ask for a worktree in the prompt; otherwise the agent decides by the convention above.

## Project view
Answers one question in three seconds: **what needs my attention?**
- Sessions waiting on the user (permission prompt, question).
- Per worktree, from git: dirty, unpushed commits, branch merged into the remote's default branch (ready to clean up).
- Sessions and worktrees are two independent lists.

## Validated by experiment
- Worktrees on virtiofs in the sibling directory: create, commit, concurrent use, and `worktree list --porcelain` all work (git 2.39.5).
- Path mismatch breaks git, as described above. Relative worktree paths need a newer git than this VM has.
- A fresh `CLAUDE_CONFIG_DIR` is self-contained and starts logged out.

## Not validated
- That the host sees VM-created worktrees at identical paths (needs a host-side test). `npm run projects-check` checks it, and the reverse, against real Lima.
- git-on-virtiofs performance for large repos. Worktree status runs with git on the host, so the project view doesn't depend on it; the agent's own git in the VM still does.
- That the `@bentomo.md` import in the Claude home's `CLAUDE.md` is followed by headless Claude. `npm run projects-check -- --keep` leaves a VM to try it in.

## Out of scope for v1
Multiple VMs per project, clone from URL, app-level credentials, session-to-worktree linking, per-worktree bootstrap hooks, enforced read-only question sessions, migration of existing sessions and VMs (no backward compatibility).

## Resolved
- "Waiting on me": Claude runs with permissions bypassed, so it never waits on a permission prompt. It waits when a turn ends. A session is waiting when its turn ended (or it stopped by itself) and the user hasn't looked at it since. No hooks needed.
