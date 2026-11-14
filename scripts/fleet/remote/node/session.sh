#!/bin/bash
# session.sh <wireguard|openvpn|ikev2> <id>   Runs on an exit server. Read-only.
#
# The server's own view of one client's session, for the tool's
# WireGuard, OpenVPN and IKEv2 proofs: one line,
#   SESSION <kind> found rx=<bytes> tx=<bytes> age=<seconds>
#   SESSION <kind> absent (<why>)
# rx is what the server received from that client, tx what it sent it.
# age is the WireGuard handshake's age, or how old the OpenVPN status
# file is, or how long ago the IKEv2 SA was established (the youngest
# of that user's; "sas=" says how many it has).
#
# <id> is the credential's externalUserId: the peer's PUBLIC key for
# WireGuard, the certificate's common name for OpenVPN, the EAP user name
# for IKEv2. Nothing secret is read or printed, and no address is printed.
set -uo pipefail
K="${1:?kind}"
ID="${2:?id}"
NOW=$(date +%s)

case "$K" in
  wireguard)
    command -v wg >/dev/null || { echo "SESSION wireguard absent (no wg tool)"; exit 1; }
    wg show all dump 2>/dev/null | awk -v id="$ID" -v now="$NOW" '
      NF >= 9 && $2 == id { found = 1; age = ($6 > 0 ? now - $6 : -1); rx = $7; tx = $8 }
      END {
        if (!found) { print "SESSION wireguard absent (no such peer)"; exit 1 }
        if (age < 0) { print "SESSION wireguard absent (peer never shook hands) rx=" rx " tx=" tx; exit 1 }
        printf "SESSION wireguard found rx=%s tx=%s age=%d\n", rx, tx, age
      }'
    ;;
  openvpn)
    best=""
    # The unit's own --status file and the one server.conf names (NX_OVPN_STATUS: others, for the tests).
    for f in ${NX_OVPN_STATUS:-/run/openvpn-server/status-server.log /var/log/openvpn-status.log /etc/openvpn/server/openvpn-status.log}; do
      [ -f "$f" ] || continue
      age=$((NOW - $(stat -c %Y "$f")))
      line=$(awk -v id="$ID" '
        # status-version 2 and 3: a HEADER line names the columns.
        { n = split($0, a, /[,\t]/) }
        a[1] == "HEADER" && a[2] == "CLIENT_LIST" { for (i = 3; i <= n; i++) { if (a[i] == "Bytes Received") r = i - 1; if (a[i] == "Bytes Sent") s = i - 1 } next }
        a[1] == "CLIENT_LIST" && a[2] == id && r { print a[r], a[s]; exit }
        # status-version 1: CN,Real Address,Bytes Received,Bytes Sent,Connected Since
        a[1] == id && n >= 5 && a[3] ~ /^[0-9]+$/ { print a[3], a[4]; exit }' "$f")
      [ -n "$line" ] || continue
      # shellcheck disable=SC2086
      set -- $line
      if [ -z "$best" ] || [ "$1" -gt "${best%% *}" ]; then best="$1 $2 $age"; fi
    done
    if [ -z "$best" ]; then
      echo "SESSION openvpn absent (not in any status file)"
      exit 1
    fi
    # shellcheck disable=SC2086
    set -- $best
    echo "SESSION openvpn found rx=$1 tx=$2 age=$3"
    ;;
  ikev2)
    command -v swanctl >/dev/null || { echo "SESSION ikev2 absent (no swanctl)"; exit 1; }
    swanctl --list-sas 2>/dev/null | awk -v id="$ID" '
      # One IKE SA per block; the youngest of this user'\''s is the session
      # (a client that went away without a word can leave an older one).
      /^[^ \t]/ { b++ }
      /^[ \t]+remote / && (index($0, "EAP: '\''" id "'\''") || index($0, "remote '\''" id "'\''")) { m[b] = 1 }
      /^[ \t]+established [0-9]+s ago/ { est[b] = $2 + 0 }
      /^[ \t]+in +[0-9a-f]+/ { if (match($0, /[0-9]+ bytes/)) rx[b] += substr($0, RSTART, RLENGTH - 6) }
      /^[ \t]+out +[0-9a-f]+/ { if (match($0, /[0-9]+ bytes/)) tx[b] += substr($0, RSTART, RLENGTH - 6) }
      END {
        best = 0; n = 0
        for (i = 1; i <= b; i++) if (m[i]) { n++; if (!best || est[i] < est[best]) best = i }
        if (!best) { print "SESSION ikev2 absent (no SA for that user)"; exit 1 }
        printf "SESSION ikev2 found rx=%d tx=%d age=%d sas=%d\n", rx[best], tx[best], est[best], n
      }'
    ;;
  *)
    echo "SESSION $K absent (unknown kind)"
    exit 2
    ;;
esac
