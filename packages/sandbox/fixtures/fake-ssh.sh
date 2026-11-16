#!/bin/sh
# A stand-in for `ssh -F <config> -T <host> bash -s`: runs the remote command locally, with a no-op sudo,
# a fake curl, a home of its own so nothing is installed into the real one, and /workspace in the fake's state.
PATH="$(dirname "$0")/fake-bin:$PATH"
HOME="${FAKE_LIMA_DIR:-/tmp/fake-lima}/vm-home"
FAKE_WORKSPACE="${FAKE_LIMA_DIR:-/tmp/fake-lima}/workspace"
BASH_ENV="$(dirname "$0")/fake-vm-env.sh"
mkdir -p "$HOME" "$FAKE_WORKSPACE"
export PATH HOME FAKE_WORKSPACE BASH_ENV
# A reverse socket forward (`-N -R guest:host`) has no command: the fake holds it with a small forwarder instead.
case " $* " in *" -R "*) exec node "$(dirname "$0")/fake-forward.mjs" "$@" ;; esac
while [ $# -gt 0 ] && [ "$1" != "bash" ]; do shift; done
exec "$@"
