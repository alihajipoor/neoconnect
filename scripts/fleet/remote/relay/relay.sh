#!/bin/bash
# relay.sh <verb> ...   Runs on the relay box inside the watched country.
#
# This box is the one inside entry the relay plan has, and its Xray holds
# routes and users that exist only in the running process. So nothing
# here restarts Xray, nothing here loads the nftables file (it starts
# with `flush ruleset`, which would also wipe fail2ban's table and reset
# the sign-in relay's quota), and nothing here touches sshd. Changes are
# one rule at a time, by handle, and the file is edited by line and only
# CHECKED.
#
#   state [routeId...]   read-only: Xray pid and restart count, agent, and
#                        per route id how many rules and outbounds exist
#   hop-list             the live hop rules, with handles, to
#                        /dev/shm/nxf/hop-live.txt (addresses: fetched,
#                        never printed)
#   hop-backup <label>   copies of the nftables file and the live ruleset
#   hop-del <handle> <exit address>
#   hop-set <handle>     replace that rule with /dev/shm/nxf/hop-rule.txt
#   hop-add              add /dev/shm/nxf/hop-rule.txt
#   hop-file-swap        put /dev/shm/nxf/nftables.conf.new in place, after
#                        checking that it parses and that nothing but hop
#                        lines differs from the file it replaces
#   control-name         can the agent's control connection get through
#                        from here with the name it uses? (a name that is
#                        reset from inside leaves the agent offline after
#                        every backend deploy)
#   adu / rmu            temporary test users: `adu` reads the file on
#                        stdin, `rmu <tag> <email>` removes one
set -uo pipefail
X=/usr/local/bin/xray
API=127.0.0.1:10085
F=/etc/nftables.conf
CHAIN="ip neoxify_relay_chain output"
W=/dev/shm/nxf
verb=${1:-}
shift || true
xstate() { echo "xray pid $(systemctl show xray -p MainPID --value), restarts $(systemctl show xray -p NRestarts --value)"; }

case "$verb" in
  state)
    xstate
    echo "agent $(systemctl is-active neoxify-agentd), $(/usr/local/bin/agentd --version 2>&1 | head -1)"
    R=$("$X" api lsrules -s "$API" 2>&1)
    O=$("$X" api lso -s "$API" 2>&1)
    echo "route rules $(grep -c 'route-' <<<"$R"), route outbounds $(grep -c 'route-' <<<"$O")"
    for id in "$@"; do
      [[ "$id" =~ ^[0-9a-f-]{36}$ ]] || continue
      echo "$id rules=$(grep -c "route-$id-out" <<<"$R") outbounds=$(grep -c "route-$id-out" <<<"$O")"
    done
    ;;
  hop-list)
    umask 077
    mkdir -p "$W"
    # Captured first, then counted: `nft | grep -q` under pipefail fails
    # falsely here when grep closes the pipe early.
    L=$(nft -a list chain $CHAIN) || { echo "no hop chain on this box"; exit 1; }
    printf '%s\n' "$L" >"$W/hop-live.txt"
    echo "hop rules live: $(grep -c 'dnat to' <<<"$L")"
    ;;
  hop-backup)
    L=${1:?label}
    [[ "$L" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "bad label"; exit 2; }
    TS=$(date -u +%Y%m%dT%H%M%SZ)
    cp -a "$F" "$F.bak-pre-$L-$TS" && nft list ruleset >"/root/nft-live.bak-pre-$L-$TS" && chmod 600 "/root/nft-live.bak-pre-$L-$TS"
    echo "backups: $F.bak-pre-$L-$TS and /root/nft-live.bak-pre-$L-$TS"
    xstate
    ;;
  hop-del)
    H=${1:?handle}
    A=${2:?exit address}
    [[ "$H" =~ ^[0-9]+$ ]] || { echo "bad handle"; exit 2; }
    L=$(nft -a list chain $CHAIN)
    grep -q "ip daddr $A tcp dport 443 .*# handle $H\$" <<<"$L" || { echo "REFUSED: handle $H is not the rule for that exit any more"; exit 1; }
    nft delete rule $CHAIN handle "$H" && echo "live rule deleted"
    xstate
    ;;
  hop-set | hop-add)
    [ -s "$W/hop-rule.txt" ] || { echo "no rule text"; exit 1; }
    RULE=$(cat "$W/hop-rule.txt")
    grep -qE '^ip daddr [0-9.]+ tcp dport 443 counter dnat to [0-9.]+:[0-9]+ comment "[a-z0-9 -]+"$' <<<"$RULE" || { echo "REFUSED: not a hop rule"; exit 1; }
    if [ "$verb" = hop-set ]; then
      H=${1:?handle}
      [[ "$H" =~ ^[0-9]+$ ]] || { echo "bad handle"; exit 2; }
      EXITA=$(awk '{print $3}' <<<"$RULE")
      L=$(nft -a list chain $CHAIN)
      grep -q "ip daddr $EXITA tcp dport 443 .*# handle $H\$" <<<"$L" || { echo "REFUSED: handle $H is not the rule for that exit any more"; exit 1; }
      # One argument, so the quotes around the comment reach nft.
      nft "replace rule $CHAIN handle $H $RULE" && echo "live rule replaced"
    else
      nft "add rule $CHAIN $RULE" && echo "live rule added"
    fi
    shred -u "$W/hop-rule.txt" 2>/dev/null
    xstate
    ;;
  hop-file-swap)
    NEW=$W/nftables.conf.new
    [ -s "$NEW" ] || { echo "no new file"; exit 1; }
    # Everything that is not a hop line must be byte for byte what it was.
    if ! diff <(grep -v 'dnat to [0-9.]*:[0-9]* comment' "$F") <(grep -v 'dnat to [0-9.]*:[0-9]* comment' "$NEW") >/dev/null; then
      echo "REFUSED: the new file differs from the old one outside the hop lines"
      exit 1
    fi
    nft -c -f "$NEW" || { echo "REFUSED: nft does not accept the new file (checked only, nothing loaded)"; exit 1; }
    install -m "$(stat -c %a "$F")" -o root -g root "$NEW" "$F.new" && mv "$F.new" "$F"
    shred -u "$NEW" 2>/dev/null
    echo "file updated and checked (never loaded): hop lines in file $(grep -c 'dnat to [0-9.]*:[0-9]* comment' "$F")"
    xstate
    ;;
  control-name)
    T=$(jq -r '.grpcTarget // empty' /etc/neoxify/agent.json)
    N=$(jq -r '.tlsServerName // empty' /etc/neoxify/agent.json)
    [ -n "$T" ] && [ -n "$N" ] || { echo "control-name-unknown (agent.json has no target or no name)"; exit 1; }
    if echo | timeout 8 openssl s_client -connect "$T" -servername "$N" 2>/dev/null | grep -q 'BEGIN CERTIFICATE'; then
      echo "control-name-ok; agent $(systemctl is-active neoxify-agentd)"
    else
      echo "control-name-reset: the name the agent uses does not get through from here"
      exit 1
    fi
    ;;
  adu)
    umask 077
    mkdir -p "$W"
    cat >"$W/adu.json"
    "$X" api adu -s "$API" "$W/adu.json" 2>&1 | tail -1
    shred -u "$W/adu.json"
    xstate
    ;;
  rmu)
    "$X" api rmu -s "$API" -tag="${1:?tag}" "${2:?email}" 2>&1 | tail -1
    ;;
  *)
    echo "usage: relay.sh state|hop-list|hop-backup|hop-del|hop-set|hop-add|hop-file-swap|control-name|adu|rmu" >&2
    exit 2
    ;;
esac
