#!/bin/bash
# <{"c": config row, "u": {"credentials": ..}} on stdin> | nx-e2e-pipe.sh <xray binary> <label>
# Runs on the panel host. For a tunnel the panel's database does not know
# yet: the trial REALITY inbound a box gets before the installer runs
# (remote/node/reality-trial.sh). Builds the client with the same program
# every other proof uses (nx-e2e-client.jq), so the handshake is the one
# the apps make, and hands it to nx-e2e-run.sh: exit address, 256 KB both
# ways, E2E-PASS or E2E-FAIL.
#
# WHAT COMES IN HOLDS A CREDENTIAL, throwaway as it is: only ever a pipe.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
X=${1:?xray binary}
L=${2:?label}
jq '.c as $c | .u as $u | '"$(cat "$HERE/nx-e2e-client.jq")" | "$HERE/nx-e2e-run.sh" "$X" "$L"
