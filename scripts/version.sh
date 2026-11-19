#!/usr/bin/env bash
# Versions come from git tags: a release is a vX.Y.Z tag, and nothing in the repository holds the version.
#   scripts/version.sh latest <commit>        the latest release tag in the commit's history, or nothing
#   scripts/version.sh next <commit> <bump>   the version after it, with the patch, minor or major part bumped
# Before the first release the latest version counts as 0.0.0, so a minor bump makes 0.1.0.
set -euo pipefail

latest() {
  git tag --merged "$1" --list 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n1 || true
}

case "${1:-}" in
  latest)
    latest "$2"
    ;;
  next)
    tag=$(latest "$2")
    IFS=. read -r major minor patch <<< "${tag:-v0.0.0}"
    major=${major#v}
    case "$3" in
      major) echo "$((major + 1)).0.0" ;;
      minor) echo "$major.$((minor + 1)).0" ;;
      patch) echo "$major.$minor.$((patch + 1))" ;;
      *) echo "Bump patch, minor or major, not '$3'" >&2; exit 1 ;;
    esac
    ;;
  *)
    echo "Usage: scripts/version.sh latest <commit> | next <commit> patch|minor|major" >&2
    exit 1
    ;;
esac
