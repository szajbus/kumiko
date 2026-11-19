---
title: Releasing
description: Versions from git tags, the unstable build of every commit on main, and how a tried build becomes a release.
sidebar:
  order: 7
---

## Versions

Git tags hold the version, and nothing in the repository does. A release is a `vX.Y.Z` tag on `main`.
`scripts/version.sh` finds the latest release tag in a commit's history and works out the next version from it. The
version in `apps/desktop/package.json` stays `0.0.0`. The workflows pass the real version to electron-builder, which
writes it into the app, so **About Kumiko** shows it. An app built on your machine shows `0.0.0`.

## Unstable builds

When the Test workflow passes on a push to `main`, the Unstable workflow (`.github/workflows/unstable.yml`) builds the
app and replaces the **unstable** pre-release on GitHub with it:

- `Kumiko-unstable-arm64.dmg` and `Kumiko-unstable-x64.dmg`, and a `.zip` of each. The names stay the same from build
  to build, so download links keep working.
- A version such as `0.1.1-unstable.42`: the next patch release after the latest tag, and the workflow's run number.
- Notes that list the commit subjects since the last release, without merge commits.
- The `unstable` tag, moved to the build's commit.

A newer commit cancels a build still running.

## Cutting a release

A release is an unstable build that someone has tried.

1. **Try it.** Download the unstable `.dmg`, install it and use it.
2. **Run the Release workflow.** On GitHub, open **Actions**, then **Release**, then **Run workflow** on `main`. Pick
   which part of the version to bump: `patch`, `minor` or `major`. Before the first release the latest version counts
   as `0.0.0`, so `minor` makes `0.1.0`.

   The workflow (`.github/workflows/release.yml`) takes the commit of the `unstable` tag, not the newest commit on
   `main`, so the release is the build you tried. It stops if that commit is already released. It doesn't run the
   tests again, because the Unstable workflow builds only commits that passed them. It builds the `.dmg` and `.zip` for
   Apple silicon and Intel with the new version, tags the commit `vX.Y.Z`, and uploads the app to a **draft** GitHub
   release. Each tag has its build, because the tag comes last.
3. **Publish the draft.** Its notes list the commit subjects since the last release. Rewrite them for the people who
   install it: leave out docs, tests and fixes to things that never shipped. Then publish it.

If a run fails after it tags the commit, run the workflow again. It finds the tag without a release and finishes that
version.

To start over, delete the draft release and the tag:

```sh
git push --delete origin v0.2.0
git tag -d v0.2.0
```

## Signing

The app isn't signed or notarized. When these repository secrets are set, the Release workflow signs and notarizes it
with no other change:

| Secret | Is |
| --- | --- |
| `CSC_LINK`, `CSC_KEY_PASSWORD` | The Developer ID certificate and its password. With these, electron-builder signs the app. |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | The Apple account to notarize with. With these too, electron-builder notarizes it. |

Once releases are signed, take the **Open Anyway** step out of the [quick start](/guide/quick-start/). Unstable builds
stay unsigned.
