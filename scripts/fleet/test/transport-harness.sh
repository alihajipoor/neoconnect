#!/usr/bin/env bash
# transport-harness.sh <bash code>
#
# The real lib/remote.sh, for real (not under --dry-run), against the
# loopback SSH server of transport.test.mjs, with the transport the test
# names (FLEET_SSH=hub or ssh). Only the address, the port, the key and
# the known_hosts file differ from a real run; every call goes through
# the same rsh, rpipe, rput, rget, rpushdir, rscript and q, and the run
# starts and stops its transport as `fleet` does (transport_start, then
# transport_stop on exit).
#
# What is set here is read by the files under lib/, hence:
# shellcheck disable=SC2034,SC1090,SC1091
set -uo pipefail
FLEET_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$FLEET_DIR/../.." && pwd)"
source "$FLEET_DIR/lib/engine.sh"
source "$FLEET_DIR/lib/remote.sh"

RUN_DIR="${T_RUN:?T_RUN, the run directory of this test}"
OPT_DRY=0
PANEL_HOST=127.0.0.1 NEW_IP="${T_NEW_IP:-127.0.0.1}" RELAY_HOST=127.0.0.1 SIGNIN_HOST=127.0.0.1
PANEL_KEY="$T_KEY" NODE_KEY="$T_KEY" INSIDE_KEY="$T_KEY"
REMOTE_DIR="$T_REMOTE"
PSQL_REMOTE="$T_REMOTE/psql.sh"
# ssh takes the first value of an option: these replace, not add.
SSH_BASE=("${SSH_BASE[@]/ServerAliveInterval=20/ServerAliveInterval=${T_ALIVE:-20}}")
SSH_BASE=("${SSH_BASE[@]/ConnectTimeout=15/ConnectTimeout=${T_CONNECT_TIMEOUT:-15}}")
SSH_BASE+=(-o "Port=$T_PORT" -o "UserKnownHostsFile=$T_KH" -o GlobalKnownHostsFile=/dev/null)
# shellcheck disable=SC2206
[[ -n "${T_SSH_EXTRA:-}" ]] && SSH_BASE+=($T_SSH_EXTRA)
st() { state_get "$@"; }

trap 'transport_stop' EXIT
transport_start
echo "TRANSPORT=$FLEET_TRANSPORT" >"$RUN_DIR/transport"
# rscript tars scripts from FLEET_DIR/remote: the test's own, if it has some.
[[ -n "${T_FLEET_DIR:-}" ]] && FLEET_DIR="$T_FLEET_DIR"
eval "$1"
