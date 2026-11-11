#!/bin/bash
# hop-server.sh <verb>   Runs on the exit server that carries the relay hop.
#
#   apply    load /dev/shm/nxf/chain-fw.nft.new as /etc/neoxify/chain-fw.nft
#            (backup first), with the unit that loads it at boot
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

case "$verb" in
  apply)
    [ -s "$NEW" ] || { echo "no new table to load"; exit 1; }
    grep -q '^table ip neoxify_chain {' "$NEW" && [ "$(grep -c '^table ' "$NEW")" = 2 ] && ! grep -q 'flush ruleset' "$NEW" ||
      { echo "REFUSED: the new file is not the hop table alone"; exit 1; }
    nft -c -f "$NEW" || { echo "REFUSED: nft does not accept the new table"; exit 1; }
    TS=$(date -u +%Y%m%dT%H%M%SZ)
    install -d -m 755 /etc/neoxify
    if [ -f "$F" ]; then
      cp -a "$F" "$F.bak-$TS"
      echo "backup $F.bak-$TS"
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
    # The hop forwards, so the kernel has to.
    if [ "$(cat /proc/sys/net/ipv4/ip_forward)" != 1 ]; then
      echo 'net.ipv4.ip_forward = 1' >/etc/sysctl.d/99-neoxify-chain.conf
      sysctl -q -p /etc/sysctl.d/99-neoxify-chain.conf
    fi
    systemctl enable neoxify-chain-fw >/dev/null 2>&1
    nft -f "$F" && systemctl start neoxify-chain-fw
    echo "hop table loaded: $(nft list table ip neoxify_chain | grep -c 'dnat to') exit(s); unit $(systemctl is-enabled neoxify-chain-fw)/$(systemctl is-active neoxify-chain-fw); forwarding $(cat /proc/sys/net/ipv4/ip_forward)"
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
    echo "usage: hop-server.sh apply|show|remove" >&2
    exit 2
    ;;
esac
