#!/usr/bin/env bash
# Starts what vm-gui-proof.mjs drives: a virtual display, a session bus and
# tauri-driver, all inside one detached process group so `stop` can end them
# together. The app gets the session bus from dbus-run-session because single
# instance and notifications both talk over it, and without one they fail in
# ways a real desktop never would.
#
# The driver's log is kept for crash diagnosis only. WebKitWebDriver does not
# record the text typed into fields, but delete the log after a run anyway,
# since a sign-in passes through it.
#
# The helper serves the app only to the person at the computer's screen or
# to members of the neoxify group. A test VM driven over SSH has nobody at
# its screen, so the user running this must be in the group, from a login
# begun after joining it: sudo usermod -aG neoxify "$USER".
set -euo pipefail
LOG="${NX_GUI_LOG:-$HOME/gui-driver.log}"
case "${1:-start}" in
  start)
    if ! id -nG | tr ' ' '\n' | grep -qx neoxify; then
      echo "not in the neoxify group in this login; the helper would refuse the app (see the top of this file)" >&2
      exit 1
    fi
    pkill -x tauri-driver 2>/dev/null || true
    pkill -f 'Xvfb :99' 2>/dev/null || true
    setsid nohup bash -c '
      Xvfb :99 -screen 0 1280x900x24 -nolisten tcp &
      export DISPLAY=:99
      for _ in $(seq 50); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.1; done
      exec dbus-run-session -- tauri-driver --port 4444 --native-port 4445
    ' >"$LOG" 2>&1 </dev/null &
    for _ in $(seq 100); do
      curl -fsS http://127.0.0.1:4444/status >/dev/null 2>&1 && { echo "driver up"; exit 0; }
      sleep 0.1
    done
    echo "driver did not come up; see $LOG" >&2; exit 1 ;;
  stop)
    pkill -x neoxify 2>/dev/null || true
    pkill -x tauri-driver 2>/dev/null || true
    pkill -x WebKitWebDriver 2>/dev/null || true
    pkill -f 'Xvfb :99' 2>/dev/null || true
    echo "stopped" ;;
esac
