#!/bin/bash
# install-drive.sh <verb>   Runs on the box being built.
#
# The installer asks its questions one at a time, and it must be answered
# the same way: fed a prepared stream, answers land on the wrong prompts
# (it once wrote the wrong Xray template that way). So it runs in a tmux
# session, and this script reads the screen, waits for a prompt to stand
# still, finds that prompt in the answers table and types one answer.
#
#   start <answers file> <control target> <panel name>
#       starts the installer in tmux session "nx" and the driver beside it
#   status
#       RUNNING | DONE <exit code> | STUCK <the prompt nobody has an answer for>
#   screen     the last lines of the installer's screen
#   cleanup    unset the token in the session, close it
#
# The answers file has one "<regex><TAB><answer>" per line, first match
# wins. An answer of @BRACKET types whatever the prompt offers in its
# square brackets; @STOP stops and leaves the question to a person.
# A prompt with no row is never guessed at: the driver reports STUCK and
# the operator attaches (tmux attach -t nx), answers, and the driver
# carries on with the next prompt.
#
# The admin token is not typed and not in the answers: the session reads
# it from a file in RAM into its environment.
set -uo pipefail
S=nx
DIR=/root/nx-install
STATUS=$DIR/status
LOG=$DIR/drive.log
verb=${1:-}
shift || true

drive() {
  local answers="$1" pos="" lastpos="" line prev="" stable=0 stuck=0 rx ans cy
  echo RUNNING >"$STATUS"
  for _ in $(seq 1 1700); do
    sleep 0.5
    if ! tmux has-session -t "$S" 2>/dev/null; then
      echo "DONE 99 (session ended without a result)" >"$STATUS"
      return
    fi
    if tmux capture-pane -p -t "$S" -S -200 | grep -q '^NXF-INSTALL-EXIT='; then
      echo "DONE $(tmux capture-pane -p -t "$S" -S -200 | sed -n 's/^NXF-INSTALL-EXIT=//p' | tail -1)" >"$STATUS"
      return
    fi
    cy=$(tmux display-message -p -t "$S" '#{cursor_y}')
    line=$(tmux capture-pane -p -t "$S" -S "$cy" -E "$cy")
    pos="$(tmux display-message -p -t "$S" '#{history_size}'):$cy"
    if [ "$line" = "$prev" ]; then stable=$((stable + 1)); else stable=0; fi
    prev=$line
    # A prompt is a line the cursor sits on, unchanged for a second, that
    # ends like a question, and that has not been answered yet.
    [ "$stable" -ge 2 ] || continue
    [ "$pos" != "$lastpos" ] || continue
    grep -qE '(:|\]|\?)[[:space:]]*$' <<<"$line" || continue
    ans=""
    rx=""
    while IFS=$'\t' read -r rx ans; do
      [ -n "$rx" ] || continue
      if grep -qE -- "$rx" <<<"$line"; then break; fi
      rx=""
    done <"$answers"
    if [ -z "$rx" ] || [ "$ans" = "@STOP" ]; then
      stuck=$((stuck + 1))
      # Twenty seconds without anyone answering it.
      if [ "$stuck" -ge 40 ]; then echo "STUCK $line" >"$STATUS"; fi
      continue
    fi
    stuck=0
    if [ "$ans" = "@BRACKET" ]; then
      ans=$(sed -n 's/.*\[\([^]]*\)\][^]]*$/\1/p' <<<"$line")
      if [ -z "$ans" ] || [ "$ans" = "skip" ]; then
        echo "STUCK $line" >"$STATUS"
        continue
      fi
    fi
    echo "$(date -u +%H:%M:%S) $(sed -E 's/[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/<ip>/g' <<<"$line") => $(sed -E 's/[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/<ip>/g' <<<"$ans")" >>"$LOG"
    tmux send-keys -t "$S" -l -- "$ans"
    tmux send-keys -t "$S" Enter
    echo RUNNING >"$STATUS"
    lastpos=$pos
    stable=0
  done
  echo "STUCK (ran out of time: the admin token lasts 15 minutes)" >"$STATUS"
}

case "$verb" in
  start)
    ANS=${1:?answers file}
    GRPC=${2:?control target}
    PNAME=${3:?panel name}
    [ -s "$ANS" ] || { echo "no answers file"; exit 1; }
    [ -s /dev/shm/nxf/admin-token ] || { echo "no admin token on the box"; exit 1; }
    [ ! -f /etc/neoxify/agent.json ] || { echo "this box is already enrolled: not installing over it"; exit 1; }
    tmux has-session -t "$S" 2>/dev/null && { echo "an installer session is already open"; exit 1; }
    mkdir -p "$DIR"
    : >"$LOG"
    date -u '+%Y-%m-%d %H:%M:%S' >"$DIR/start.txt"
    # The default umask, set here on purpose: a session started under 077
    # left public files owner-only and the disguise pages answering 403.
    umask 022
    tmux new-session -d -s "$S" -x 220 -y 60
    tmux send-keys -t "$S" "umask 022; cd /root/neoxify-installer && export TMPDIR=/dev/shm NEOXIFY_GRPC_TARGET=$GRPC NEOXIFY_PANEL_ORIGIN=$PNAME && export NEOXIFY_ADMIN_TOKEN=\"\$(cat /dev/shm/nxf/admin-token)\" && ./install.sh; echo \"NXF-INSTALL-EXIT=\$?\"" Enter
    nohup setsid "$0" drive "$ANS" >/dev/null 2>&1 </dev/null &
    echo "installer started; driver pid $!"
    ;;
  drive)
    drive "${1:?answers}"
    date -u '+%Y-%m-%d %H:%M:%S' >"$DIR/end.txt"
    ;;
  status)
    cat "$STATUS" 2>/dev/null || echo "NOT-STARTED"
    ;;
  screen)
    tmux capture-pane -p -t "$S" -S -400 2>/dev/null | grep -v '^[[:space:]]*$' | tail -"${1:-25}" | sed -E 's/[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/<ip>/g'
    echo "--- answers given:"
    cat "$LOG" 2>/dev/null
    ;;
  cleanup)
    if tmux has-session -t "$S" 2>/dev/null; then
      tmux send-keys -t "$S" 'unset NEOXIFY_ADMIN_TOKEN; history -c' Enter
      sleep 1
      tmux kill-session -t "$S"
    fi
    shred -u /dev/shm/nxf/admin-token 2>/dev/null
    rm -f /dev/shm/nxf/admin-token
    [ ! -e /root/.nx_token ] && [ ! -e /dev/shm/nxf/admin-token ] && echo "token-gone"
    ;;
  *)
    echo "usage: install-drive.sh start|status|screen|cleanup" >&2
    exit 2
    ;;
esac
