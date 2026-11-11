#!/usr/bin/env bash
# Put the installer's log limits on a node that is already live, or say
# what a node has. See installer/lib/logs.sh for what they are and why:
# without them one node held 14 GB of logs on a 25 GB disk.
#
# New installs get this from the installer (install_log_limits). This
# runs the same functions over SSH, in two steps because the second one
# deletes history:
#
#   ./log-limits.sh root@<node> [ssh-key]                    # report only
#   ./log-limits.sh root@<node> [ssh-key] --apply            # hourly logrotate, the syslog rules
#   ./log-limits.sh root@<node> [ssh-key] --apply --journal  # and cap the journal at 500 MB
#
# --apply restarts rsyslog. --journal restarts journald, which then
# deletes its oldest entries down to the cap. Neither touches a VPN
# engine; the report prints their process ids before and after so that
# can be seen rather than taken on trust.
#
# The first rotation after --apply happens within the hour and compresses
# the old syslog files at the lowest priority; nothing needs forcing.
set -euo pipefail

DEST="${1:?usage: log-limits.sh root@<node> [ssh-key] [--apply] [--journal]}"
shift
KEY="" APPLY=0 JOURNAL=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --journal) JOURNAL=1 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) KEY="$arg" ;;
  esac
done
if [[ "$JOURNAL" == 1 && "$APPLY" != 1 ]]; then
  echo "--journal changes the node, so it needs --apply as well" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15)
[[ -n "$KEY" ]] && SSH_OPTS+=(-i "$KEY")

{
  cat "$SCRIPT_DIR/../lib/logs.sh"
  echo "APPLY=$APPLY JOURNAL=$JOURNAL"
  cat <<'REMOTE'
set -uo pipefail
engines() {
  local unit
  for unit in xray openvpn-server@server strongswan strongswan-starter nginx; do
    echo "  $unit pid=$(systemctl show -p MainPID --value "$unit" 2>/dev/null) since=$(systemctl show -p ActiveEnterTimestamp --value "$unit" 2>/dev/null)"
  done
}
report() {
  echo "  disk: $(df -h / | awk 'NR==2{print $3" used, "$4" free ("$5")"}')"
  echo "  journal: $(journalctl --disk-usage 2>/dev/null | grep -o '[0-9.]*[KMGT]' | head -1)"
  # shellcheck disable=SC2012 # sizes of a fixed, known set of names
  ls -l /var/log/syslog* 2>/dev/null | awk '{printf "  %s %.2f GB\n", $9, $5/1073741824}'
  local file
  for file in "$LOG_LIMITS_RULE" "$LOG_LIMITS_STANZA" "$LOG_LIMITS_TIMER" "$LOG_LIMITS_JOURNAL"; do
    if [[ -e "$file" ]]; then echo "  in place: $file"; else echo "  MISSING : $file"; fi
  done
}
echo "== before"; report
if [[ "$APPLY" == 1 ]]; then
  before="$(engines)"
  status=0
  log_limits_timer || status=1
  log_limits_syslog || status=1
  if [[ "$JOURNAL" == 1 ]]; then log_limits_journal || status=1; fi
  after="$(engines)"
  echo "== after"; report
  if [[ "$before" == "$after" ]]; then
    echo "== engines: process ids and start times unchanged"
  else
    echo "== ENGINES CHANGED -- before:"; echo "$before"; echo "after:"; echo "$after"
    status=1
  fi
  exit "$status"
fi
REMOTE
} | ssh "${SSH_OPTS[@]}" "$DEST" 'bash -s'
