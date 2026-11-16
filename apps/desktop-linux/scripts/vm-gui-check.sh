#!/usr/bin/env bash
# The machine-side half of the GUI proof: what the helper and the network
# say while vm-gui-proof.mjs drives the app. It never prints an address; the
# exit check answers only whether the address the internet sees is the one
# the tunnel's engine is talking to.
set -uo pipefail
H=/usr/lib/neoxify/neoxify-helper
BASE="$HOME/.nx-gui-baseline"

net_state() {
  { ip -4 route show table all; ip -6 route show table all; ip rule; ip -6 rule; ip -br link; } 2>/dev/null \
    | grep -v -E 'linkdown|^(local|broadcast|multicast) ' \
    | sed -E 's/ expires [0-9]+sec//' | sort
}

case "${1:-}" in
  baseline)
    net_state >"$BASE"; echo "baseline saved" ;;
  status)
    sudo "$H" ctl '{"type":"status"}' | python3 -c '
import json, sys
d = json.load(sys.stdin)
keep = ("connected", "protocol", "ipv6_blocked", "ipv4_confined", "split_tunnel_active", "tunnel_dns_unprotected")
out = {k: d.get(k) for k in keep}
out["health"] = (d.get("health") or {}).get("state")
print(json.dumps(out))' ;;
  exit)
    # The engine's peer: established sockets of the engines, and WireGuard's
    # endpoint. The address seen from outside must be one of them.
    exit_ip=$(curl -4 -s -m 10 https://1.1.1.1/cdn-cgi/trace 2>/dev/null | sed -n 's/^ip=//p')
    [ -n "$exit_ip" ] || exit_ip=$(curl -4 -s -m 10 https://api.ipify.org 2>/dev/null)
    peers=$( { sudo ss -Htunp state established 2>/dev/null | grep -E 'xray|openvpn' | awk '{print $5}';
               sudo ss -Hunp 2>/dev/null | grep -E 'xray|openvpn' | awk '{print $5}';
               sudo wg show all endpoints 2>/dev/null | awk '{print $3}';
               # OpenVPN over UDP sends from an unconnected socket, so ss
               # shows no peer; the helper's host route to the server does.
               diff <(cat "$BASE") <(net_state) | sed -n 's/^> \([0-9.]*\) via .*/\1/p'; } \
             | sed -E 's/:[0-9]+$//; s/^\[|\]$//g' | sort -u)
    page=$(curl -s -m 10 -o /dev/null -w '%{http_code}' https://example.com/ 2>/dev/null)
    # The address the app shows as "Your IP" arrives on stdin, if given.
    ui_ip=$(timeout 1 cat 2>/dev/null | grep -oE '([0-9]+\.){3}[0-9]+' | head -1)
    ui=""; [ -n "$ui_ip" ] && { [ "$ui_ip" = "$exit_ip" ] && ui=" app_shows_same=yes" || ui=" app_shows_same=no"; }
    if [ -z "$exit_ip" ]; then echo "page=$page exit=unreachable$ui"
    elif grep -qxF "$exit_ip" <<<"$peers"; then echo "page=$page exit_is_server=yes$ui"
    else echo "page=$page exit_is_server=no$ui"; fi ;;
  clean)
    # After a disconnect the routes, rules and links must be what they were
    # before the first connect.
    if diff <(cat "$BASE") <(net_state) >/dev/null; then echo "routes=as-before"
    else echo "routes=CHANGED"; diff <(cat "$BASE") <(net_state) | grep '^[<>]' | sed -E 's/[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/<addr>/g'; fi
    sudo nft list table inet neoxify >/dev/null 2>&1 && echo "nft=table-present" || echo "nft=none" ;;
  *) echo "usage: baseline | status | exit | clean"; exit 2 ;;
esac
