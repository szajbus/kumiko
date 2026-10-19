#!/bin/sh
# A stand-in for `ssh -F <config> -T <host> bash -s`: runs the remote command locally, with a no-op sudo,
# a fake curl, and a home of its own so nothing is installed into the real one.
PATH="$(dirname "$0")/fake-bin:$PATH"
HOME="${FAKE_LIMA_DIR:-/tmp/fake-lima}/vm-home"
mkdir -p "$HOME"
export PATH HOME
while [ $# -gt 0 ] && [ "$1" != "bash" ]; do shift; done
exec "$@"
