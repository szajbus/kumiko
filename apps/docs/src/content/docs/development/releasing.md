---
title: Releasing
description: The unstable build of every commit on main, and how a tried build becomes a release.
sidebar:
  order: 7
---

## Unstable builds

When the Test workflow passes on a push to `main`, the Unstable workflow (`.github/workflows/unstable.yml`) builds the
app and replaces the **unstable** pre-release on GitHub with it:

- `Kumiko-unstable-arm64.dmg` and `Kumiko-unstable-x64.dmg`, and a `.zip` of each. The names stay the same from build
  to build, so download links keep working.
- A version such as `0.1.0-unstable.42`, which **About Kumiko** shows: the app's version and the workflow's run
  number.
- Notes that list the commit subjects since the last release.
- The `unstable` tag, moved to the build's commit.

A newer commit cancels a build still running.

## Cutting a release

A release is an unstable build that someone has tried.

1. **Try it.** Download the unstable `.dmg`, install it and use it.
2. **Write the changelog.** Add a `## <version>` heading at the top of `CHANGELOG.md`, and under it what changed for
   users. Take it from the unstable release's notes, and leave out docs, tests and fixes to things that never shipped.
   Commit it to `main`.
3. **Run the release script:**

   ```sh
   npm run release 0.2.0
   ```

   The script checks that you're on `main` with no changes, up to date with `origin`, and that `main` is the unstable
   build's commit, give or take `CHANGELOG.md`. It shows which build it is about to release and asks you to confirm.
   Then it dates the changelog heading, sets the version in `apps/desktop/package.json` and `package-lock.json`,
   commits "Release 0.2.0", tags `v0.2.0`, and pushes both.
4. **Publish the draft.** The tag starts the Release workflow (`.github/workflows/release.yml`). It checks that the tag
   matches the app's version, runs the tests, builds the `.dmg` and `.zip` for Apple silicon and Intel, and uploads
   them to a **draft** GitHub release. The draft's notes are the version's section of `CHANGELOG.md`. Check the draft
   and publish it.

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
