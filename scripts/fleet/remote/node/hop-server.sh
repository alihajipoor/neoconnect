#!/bin/bash
# hop-server.sh <verb>   Runs on the exit server that carries the relay hop.
#
#   apply    load /dev/shm/nxf/chain-fw.nft.new as /etc/neoxify/chain-fw.nft
#            (backup first), with the unit that loads it at boot. Exits
#            non-zero, with the old file back in place, when the table
#            did not load.
#   check <count|-> [has|lacks <exit address>]
#            read-only, PASS or FAIL per line, non-zero on any FAIL: the
#            table is loaded and is the file's, it serves <count> exits
#            (- for any number), it does or does not forward to that
#            exit, the unit that loads it at boot is enabled, and the
#            kernel forwards now and after a reboot
#   show     where the file is and how many exits it serves (no addresses)
#   remove   take the table and its unit off this server
#
# The file holds one table of its own and starts by deleting it, so
# loading it is atomic and touches nothing else on the box. Connections
# already going through keep their conntrack entry. That is the opposite
# of the relay box's file, which is never loaded at all.
set -uo pipefail
F=/etc/neoxify/chain-fw.nft
NEW=/dev/shm/nxf/chain-fw.nft.new
UNIT=/etc/systemd/system/neoxify-chain-fw.service
verb=${1:-}

# Is forwarding written down, so that it is still on after a reboot?
forward_persisted() {
  grep -qsE '^[[:space:]]*net\.ipv4\.ip_forward[[:space:]]*=[[:space:]]*1' /etc/sysctl.conf /etc/sysctl.d/*.conf
}

case "$verb" in
  apply)
    [ -s "$NEW" ] || { echo "no new table to load"; exit 1; }
    grep -q '^table ip neoxify_chain {' "$NEW" && [ "$(grep -c '^table ' "$NEW")" = 2 ] && ! grep -q 'flush ruleset' "$NEW" ||
      { echo "REFUSED: the new file is not the hop table alone"; exit 1; }
    nft -c -f "$NEW" || { echo "REFUSED: nft does not accept the new table"; exit 1; }
    TS=$(date -u +%Y%m%dT%H%M%SZ)
    BAK=""
    install -d -m 755 /etc/neoxify
    if [ -f "$F" ]; then
      BAK="$F.bak-$TS"
      cp -a "$F" "$BAK"
      echo "backup $BAK"
    fi
    install -m 755 "$NEW" "$F"
    shred -u "$NEW" 2>/dev/null
    if [ ! -f "$UNIT" ]; then
      cat >"$UNIT" <<'U'
[Unit]
Description=Relay chaining NAT (one nftables table of its own)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/neoxify/chain-fw.nft
ExecStop=/usr/sbin/nft delete table ip neoxify_chain

[Install]
WantedBy=multi-user.target
U
      systemctl daemon-reload
    fi
    # The hop forwards, so the kernel has to: now, and after a reboot.
    if [ "$(cat /proc/sys/net/ipv4/ip_forward)" != 1 ] || ! forward_persisted; then
      echo 'net.ipv4.ip_forward = 1' >/etc/sysctl.d/99-neoxify-chain.conf
      sysctl -q -p /etc/sysctl.d/99-neoxify-chain.conf
    fi
    systemctl enable neoxify-chain-fw >/dev/null 2>&1
    if ! nft -f "$F"; then
      # The file passed the check and still did not load. The table that
      # was there before is still the one in the kernel (the load is
      # atomic), so the file goes back to match it.
      if [ -n "$BAK" ]; then
        cp -a "$BAK" "$F"
        echo "FAILED: nft did not load the new table; the previous file is back in place and the previous table still runs"
      else
        rm -f "$F"
        echo "FAILED: nft did not load the new table; there was none before, and there is none now"
      fi
      exit 1
    fi
    systemctl start neoxify-chain-fw
    echo "hop table loaded: $(nft list table ip neoxify_chain | grep -c 'dnat to') exit(s); unit $(systemctl is-enabled neoxify-chain-fw 2>&1 | head -1)/$(systemctl is-active neoxify-chain-fw 2>&1 | head -1); forwarding $(cat /proc/sys/net/ipv4/ip_forward)"
    [ "$(systemctl is-enabled neoxify-chain-fw 2>/dev/null)" = enabled ] && [ "$(systemctl is-active neoxify-chain-fw 2>/dev/null)" = active ] ||
      { echo "FAILED: the table is loaded now, but the unit that loads it at boot is not enabled and active"; exit 1; }
    ;;
  check)
    WANT=${2:--}
    HOW=${3:-}
    A=${4:-}
    fail=0
    pass() { echo "PASS hop server: $1"; }
    nope() {
      echo "FAIL hop server: $1"
      fail=1
    }
    T=$(nft list table ip neoxify_chain 2>/dev/null) || T=""
    if [ -n "$T" ]; then
      live=$(grep -c 'dnat to' <<<"$T")
      pass "table loaded ($live exit(s))"
      infile=$(grep -v '^[[:space:]]*#' "$F" 2>/dev/null | grep -c 'dnat to')
      [ "${infile:-x}" = "$live" ] && pass "the file loaded at boot holds the same $live exit(s)" || nope "the file holds ${infile:-no} exit(s), the loaded table $live: a reboot would change the hop"
      if [ "$WANT" != - ]; then
        [ "$live" = "$WANT" ] && pass "serves the $WANT exit(s) expected" || nope "serves $live exit(s), expected $WANT"
      fi
      if [ -n "$HOW" ]; then
        [[ "$A" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "bad exit address"; exit 2; }
        # -F, and the ":443" that follows: an address is not a pattern,
        # and one that merely starts the same must not match.
        n=$(grep -cF "dnat to $A:443" <<<"$T")
        m=$(grep 'masquerade' <<<"$T" | grep -cE "[{ ,]${A//./\.}[ ,}]")
        case "$HOW" in
          has) [ "$n" = 1 ] && [ "$m" = 1 ] && pass "forwards one port to that exit, and masquerades to it" || nope "does not forward to that exit (forward rules $n, in the masquerade rule $m)" ;;
          lacks) [ "$n" = 0 ] && [ "$m" = 0 ] && pass "no longer forwards to that exit" || nope "still forwards to that exit (forward rules $n, in the masquerade rule $m)" ;;
          *) echo "has or lacks"; exit 2 ;;
        esac
      fi
    else
      nope "table not loaded"
    fi
    [ "$(systemctl is-enabled neoxify-chain-fw 2>/dev/null)" = enabled ] && [ "$(systemctl is-active neoxify-chain-fw 2>/dev/null)" = active ] &&
      pass "unit enabled and active (the table is loaded again at boot)" ||
      nope "unit $(systemctl is-enabled neoxify-chain-fw 2>&1 | head -1)/$(systemctl is-active neoxify-chain-fw 2>&1 | head -1): the table would not survive a reboot"
    [ "$(cat /proc/sys/net/ipv4/ip_forward)" = 1 ] && pass "forwarding on" || nope "forwarding off: the hop forwards nothing"
    forward_persisted && pass "forwarding written down for the next boot" || nope "forwarding is not in any sysctl file: off again after a reboot"
    exit $fail
    ;;
  show)
    if [ -f "$F" ]; then
      echo "hop table file present, $(grep -c 'dnat to' "$F") exit(s); loaded: $(nft list table ip neoxify_chain >/dev/null 2>&1 && echo yes || echo no)"
    else
      echo "no hop table on this server"
    fi
    ;;
  remove)
    systemctl disable --now neoxify-chain-fw >/dev/null 2>&1
    nft delete table ip neoxify_chain 2>/dev/null
    [ -f "$F" ] && mv "$F" "$F.removed-$(date -u +%Y%m%dT%H%M%SZ)"
    rm -f "$UNIT"
    systemctl daemon-reload
    echo "hop table removed"
    ;;
  *)
    echo "usage: hop-server.sh apply|check|show|remove" >&2
    exit 2
    ;;
esac
