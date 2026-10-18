#!/bin/sh
# A stand-in for `ssh -F <config> -T <host> bash -s`: runs the remote command locally.
while [ $# -gt 0 ] && [ "$1" != "bash" ]; do shift; done
exec "$@"
