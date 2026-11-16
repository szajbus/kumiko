# Read by every bash the fake ssh starts (BASH_ENV): the fake VM's /workspace is a folder in the fake's state, as the
# host has no /workspace of its own, so `cd` there goes to $FAKE_WORKSPACE instead.
cd() {
  case "$1" in
    /workspace | /workspace/*) builtin cd "$FAKE_WORKSPACE${1#/workspace}" ;;
    *) builtin cd "$@" ;;
  esac
}
