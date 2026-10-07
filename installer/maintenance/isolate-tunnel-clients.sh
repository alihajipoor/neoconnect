#!/usr/bin/env bash
# Stop VPN customers reaching each other's devices, and the provider's
# private network and metadata service, through a node.
#
# Found by the 2026-10-06 review: nothing filtered FORWARD, so a
# WireGuard, OpenVPN or IKEv2 customer could reach every other customer's
# device on the node (the tunnel subnets are routed locally), and
# 169.254.169.254 and the provider's private ranges, MASQUERADEd to the
# node's own address -- the provider answered the node. The Xray half is
# the private-address rule block-private-egress.sh adds.
#
# New installs get this from the installer (isolate_client_subnet, and
# wg0's hooks). This puts it on a live node. It only inserts DROP rules
# at the top of FORWARD, matched on the tunnel subnet as source, so
# nothing restarts and no tunnel drops; replies to clients and relayed
# traffic are untouched. Persisted the way the node already persists:
# netfilter-persistent where it is installed (OpenVPN/IKEv2 nodes), and
# PostUp/PostDown hooks appended to wg0.conf, which take effect on wg0's
# next start (the live rules are inserted now).
#
# The subnets are read from the node's own configs: wg0's Address, the
# OpenVPN `server` line, the IKEv2 pool.
#
# Usage:  ./isolate-tunnel-clients.sh root@<node> [ssh-key]           # dry run: show what it would do
#         ./isolate-tunnel-clients.sh root@<node> [ssh-key] --apply   # do it
set -euo pipefail

DEST="${1:?usage: isolate-tunnel-clients.sh <user@host> [ssh-key] [--apply]}"
KEY=""
APPLY=0
for arg in "${@:2}"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    *) KEY="$arg" ;;
  esac
done
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=20)
[[ -n "$KEY" ]] && SSH_OPTS+=(-i "$KEY")

ssh "${SSH_OPTS[@]}" "$DEST" APPLY="$APPLY" bash -s <<'REMOTE'
set -euo pipefail
# Must match TUNNEL_ISOLATION_RANGES in installer/lib/agent.sh.
RANGES="10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16"

subnets=""
wg_subnet=""
if [[ -f /etc/wireguard/wg0.conf ]]; then
  addr="$(sed -n 's/^Address *= *//p' /etc/wireguard/wg0.conf | head -n1)"
  if [[ -n "$addr" ]]; then
    wg_subnet="${addr%.*}.0/24"
    subnets="$subnets $wg_subnet"
  fi
fi
if [[ -f /etc/openvpn/server/server.conf ]]; then
  read -r net mask < <(awk '$1 == "server" {print $2, $3; exit}' /etc/openvpn/server/server.conf) || true
  if [[ "${mask:-}" == "255.255.255.0" ]]; then
    subnets="$subnets $net/24"
  elif [[ -n "${net:-}" ]]; then
    echo "OpenVPN's server line has mask ${mask:-?}, not /24 -- add its subnet by hand." >&2
  fi
fi
if [[ -f /etc/swanctl/conf.d/neoxify.conf ]]; then
  pool="$(awk '$1 == "addrs" {print $3; exit}' /etc/swanctl/conf.d/neoxify.conf)"
  [[ -n "$pool" ]] && subnets="$subnets $pool"
fi

if [[ -z "${subnets// /}" ]]; then
  echo "no WireGuard, OpenVPN or IKEv2 subnet on this node -- nothing to do"
  exit 0
fi
echo "tunnel subnets:$subnets"

for s in $subnets; do
  for r in $RANGES; do
    if iptables -C FORWARD -s "$s" -d "$r" -j DROP 2>/dev/null; then
      echo "  present       -s $s -d $r -j DROP"
    elif [[ "$APPLY" == "1" ]]; then
      iptables -I FORWARD -s "$s" -d "$r" -j DROP
      echo "  inserted      -s $s -d $r -j DROP"
    else
      echo "  would insert  -s $s -d $r -j DROP"
    fi
  done
done

if [[ -n "$wg_subnet" ]]; then
  if grep -qF -- "-s $wg_subnet -d 169.254.0.0/16 -j DROP" /etc/wireguard/wg0.conf; then
    echo "wg0.conf already carries the hooks"
  elif grep -q '^\[Peer\]' /etc/wireguard/wg0.conf; then
    # Peers are hot-added by the agent and never written here; a [Peer]
    # section means someone edited this by hand, and appending would put
    # the hooks inside it.
    echo "wg0.conf has a [Peer] section -- add the PostUp/PostDown hooks to [Interface] by hand" >&2
  elif [[ "$APPLY" == "1" ]]; then
    cp -a /etc/wireguard/wg0.conf "/etc/wireguard/wg0.conf.bak-$(date +%Y%m%d-%H%M%S)"
    for r in $RANGES; do
      echo "PostUp = iptables -C FORWARD -s $wg_subnet -d $r -j DROP 2>/dev/null || iptables -I FORWARD -s $wg_subnet -d $r -j DROP"
      echo "PostDown = iptables -D FORWARD -s $wg_subnet -d $r -j DROP 2>/dev/null || true"
    done >> /etc/wireguard/wg0.conf
    echo "wg0.conf: hooks appended (backup kept beside it); they apply from wg0's next start"
  else
    echo "would append the PostUp/PostDown hooks to wg0.conf"
  fi
fi

if [[ "$APPLY" != "1" ]]; then
  echo "dry run: nothing changed (pass --apply to do it)"
  exit 0
fi
if command -v netfilter-persistent >/dev/null 2>&1; then
  netfilter-persistent save >/dev/null
  echo "saved with netfilter-persistent"
fi
REMOTE
