#!/bin/bash
# nx-plan-run.sh <label> <wait seconds> <planId> '<add>' '<remove>' [defaultRouteId]
# Runs on the panel host. One plan edit in the background with its own
# log, then waits for it. The edit re-provisions every subscription on
# the plan, and an SSH session that drops must not take it down halfway,
# so it is detached and this script only watches.
#
# Run again with the same label while an edit is still going and it
# watches that edit instead of starting a second one.
# Exit: 0 the edit finished and the backend's answer matches; 2 still
# running after the wait; 1 anything else.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
L=${1:?label}
WAIT=${2:?seconds}
shift 2
[[ "$L" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "bad label"; exit 1; }
CUR=/dev/shm/nxf/plan-run-$L.current
mkdir -p /root/db-backups /dev/shm/nxf
pid=""
LOG=""
if [ -s "$CUR" ]; then read -r pid LOG <"$CUR"; fi
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
  echo "an edit with this label is still running (pid $pid): watching it"
else
  LOG=/root/db-backups/plan-edit-$L-$(date -u +%Y%m%dT%H%M%SZ).log
  export NX_TOKEN_FILE=${NX_TOKEN_FILE:-/dev/shm/nxf/admin-token}
  # shellcheck disable=SC2016
  nohup setsid bash -c '
    "$0/nx-mint.sh" "$NX_TOKEN_FILE" || exit 1
    echo "start $(date -u +%H:%M:%SZ)"
    "$0/nx-plan-edit.sh" "$@"; rc=$?
    echo "end $(date -u +%H:%M:%SZ) rc=$rc"; exit $rc' "$HERE" "$@" >"$LOG" 2>&1 </dev/null &
  pid=$!
  echo "$pid $LOG" >"$CUR"
fi
timeout "$WAIT" tail --pid="$pid" -f /dev/null
if kill -0 "$pid" 2>/dev/null; then
  cat "$LOG"
  echo "STILL RUNNING (log $LOG)"
  exit 2
fi
cat "$LOG"
echo "log: $LOG"
grep -q '^PLAN-EDIT-OK$' "$LOG" && grep -q 'rc=0$' "$LOG"
