#!/usr/bin/env bash
# Stop a node's Xray from opening connections to the node's own address.
#
# A client reconnect bug once had a customer's tunnel dial the server it
# was already inside. The node connected to itself 22,437 times before
# anyone looked: each loop a new connection carrying the previous one,
# until the box had nothing left for real traffic. The client was fixed;
# this is the node refusing to take part in the next bug of that shape.
#
# Two rules at the top of OUTPUT, matched on the uid Xray runs as
# (nobody), for NEW connections to this node's own public IPv4: TCP is
# reset, UDP gets port-unreachable. Root still reaches the node's own
# ports (health checks, certificate renewal), and Xray still reaches
# everything else. Nothing restarts and no tunnel drops.
#
# New installs get this from the installer (install_self_loop_guard).
# This puts it on a node that is already live, and is how to check one:
# the dry run says whether the rules are there, live and saved.
#
# Not for a relay node: its firewall is nftables with a NAT hop of its
# own in the output path, and it is changed by hand.
#
# Usage:  ./no-self-loop.sh root@<node> [ssh-key]           # dry run: say what is there
#         ./no-self-loop.sh root@<node> [ssh-key] --apply   # put the rules in and save them
set -euo pipefail

DEST="${1:?usage: no-self-loop.sh <user@host> [ssh-key] [--apply]}"
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

# shellcheck disable=SC2029
ssh "${SSH_OPTS[@]}" "$DEST" APPLY="$APPLY" bash -s <<'REMOTE'
set -euo pipefail
C=neoxify-no-self-loop
F=/etc/iptables/rules.v4

if jq -e '[.inbounds[]? | select(.protocol == "tun")] | length > 0' /usr/local/etc/xray/config.json >/dev/null 2>&1; then
  echo "this is a relay node -- not touched"
  exit 0
fi

# The address this node accepts connections on.
IP="$(ip route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)"
[[ "$IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || { echo "could not tell this node's own IPv4 address"; exit 1; }

live="$(iptables -S OUTPUT | grep -c -- "$C" || true)"
forip="$(iptables -S OUTPUT | grep -- "$C" | grep -c -- "-d $IP/32" || true)"
saved=0
[[ -f "$F" ]] && saved="$(grep -c -- "$C" "$F" || true)"

if [[ "$live" == 2 && "$forip" == 2 && "$saved" == 2 ]]; then
  echo "Nothing to do."
  echo "  present: 2 live rules for this node's address, 2 saved"
  exit 0
fi

echo "live rules: $live of 2 (for this node's current address: $forip); saved rules: $saved of 2"
if [[ "$APPLY" != 1 ]]; then
  echo "  would insert  OUTPUT 1: tcp, uid nobody, NEW, to this node's own address -> REJECT tcp-reset"
  echo "  would insert  OUTPUT 2: udp, uid nobody, NEW, to this node's own address -> REJECT port-unreachable"
  echo "dry run: nothing changed (pass --apply to do it)"
  exit 0
fi

[[ -f "$F" ]] && cp -a "$F" "$F.bak-pre-selfloop-$(date -u +%Y%m%dT%H%M%SZ)"
# An older copy first, so a changed address does not leave stale rules.
while read -r rule; do
  [[ -n "$rule" ]] || continue
  # shellcheck disable=SC2086
  iptables ${rule/-A /-D }
done < <(iptables -S OUTPUT | grep -- "$C" || true)
iptables -I OUTPUT 1 -d "$IP/32" -p tcp -m owner --uid-owner nobody -m conntrack --ctstate NEW \
  -m comment --comment "$C" -j REJECT --reject-with tcp-reset
iptables -I OUTPUT 2 -d "$IP/32" -p udp -m owner --uid-owner nobody -m conntrack --ctstate NEW \
  -m comment --comment "$C" -j REJECT --reject-with icmp-port-unreachable
if command -v netfilter-persistent >/dev/null 2>&1; then
  netfilter-persistent save >/dev/null
  echo "saved with netfilter-persistent"
else
  echo "WARNING: netfilter-persistent is not installed -- the rules are live but will not survive a reboot"
fi

# Proof, not just presence.
if runuser -u nobody -- timeout 3 bash -c "</dev/tcp/$IP/443" 2>/dev/null; then
  echo "FAILED: nobody can still connect to this node's own address"
  exit 1
fi
echo "nobody -> this node: refused"
timeout 3 bash -c "</dev/tcp/$IP/443" 2>/dev/null && echo "root -> this node: open" || echo "root -> this node: nothing listens on 443 (not a fault of this rule)"
runuser -u nobody -- timeout 5 bash -c "</dev/tcp/1.1.1.1/443" 2>/dev/null && echo "nobody -> internet: open" || { echo "FAILED: nobody cannot reach the internet"; exit 1; }
REMOTE
