#!/bin/bash
# engines.sh check|fix   Runs on an exit server.
#
# Is every engine on this server actually running AND listening? One
# line per engine, "ok engine ..." or "DOWN engine ...", and a non-zero
# exit if any is down.
#
# A unit that is enabled is not an engine that runs. On 2026-11-13 a new
# server's Xray had died one second after the installer started it (its
# access log had been created root-owned, and Xray runs as nobody), and
# the build's checks said "ok" until the renewal dry run four steps later.
# Its IKEv2 loader was enabled and had never been started. Both are
# caught here, at the first check after the install.
#
# fix: starts what is down. Xray is restarted only when it is not
# running, which drops nobody (a dead Xray carries no one); any other
# unit is started, never restarted. Then it checks again.
set -uo pipefail
MODE=${1:-check}
C=${NX_XRAY_CONFIG:-/usr/local/etc/xray/config.json}
OVPN=${NX_OVPN_CONF:-/etc/openvpn/server/server.conf}
down=0

loaded() { [ "$(systemctl show -p LoadState --value "$1" 2>/dev/null)" = loaded ] && [ -n "$(systemctl show -p FragmentPath --value "$1" 2>/dev/null)" ]; }
active() { [ "$(systemctl is-active "$1" 2>/dev/null)" = active ]; }
tcp_listens() { [ -n "$(ss -Hltn "( sport = :$1 )" 2>/dev/null)" ]; }
udp_listens() { [ -n "$(ss -Hlun "( sport = :$1 )" 2>/dev/null)" ]; }
ok() { echo "ok engine $1"; }
bad() {
  echo "DOWN engine $1"
  down=1
}

ike_unit() {
  local u
  for u in strongswan strongswan-starter; do
    loaded "$u.service" && { echo "$u"; return 0; }
  done
  return 1
}

# The units this server has, in the order they depend on each other.
units() {
  local u ike
  for u in xray nginx wg-quick@wg0 openvpn-server@server; do
    loaded "$u.service" && echo "$u"
  done
  ike=$(ike_unit) && echo "$ike"
  loaded neoxify-swanctl-load.service && echo neoxify-swanctl-load
  loaded neoxify-agentd.service && echo neoxify-agentd
}

repair() {
  local u
  for u in $(units); do
    active "$u" && continue
    if [ "$u" = xray ]; then
      # Not running, so nobody is on it: a restart costs nothing.
      systemctl restart xray && echo "started xray (it was not running)"
    else
      systemctl start "$u" && echo "started $u (it was not running)"
    fi
  done
  sleep 3
}

check() {
  local u p ports wgp op
  down=0
  for u in $(units); do
    if active "$u"; then ok "unit $u running"; else bad "unit $u: $(systemctl is-active "$u" 2>&1 | head -1), not running"; fi
  done
  if loaded xray.service; then
    # Every inbound with a port of its own, the API on loopback included.
    ports=$(jq -r '.inbounds[]? | select(.port | type == "number") | .port' "$C" 2>/dev/null | sort -un)
    [ -n "$ports" ] || bad "xray: no inbound port in $C"
    for p in $ports; do
      if tcp_listens "$p"; then ok "xray listens on tcp $p"; else bad "xray does not listen on tcp $p"; fi
    done
  fi
  if loaded nginx.service; then
    if tcp_listens 80; then ok "nginx listens on tcp 80"; else bad "nginx does not listen on tcp 80 (certificate renewal goes through it)"; fi
  fi
  if loaded wg-quick@wg0.service; then
    wgp=$(wg show wg0 listen-port 2>/dev/null)
    if [ -n "$wgp" ] && udp_listens "$wgp"; then ok "wireguard listens on udp $wgp"; else bad "wireguard does not listen (wg0 port '${wgp:-none}')"; fi
  fi
  if loaded openvpn-server@server.service; then
    op=$(awk '$1 == "port" {print $2; exit}' "$OVPN" 2>/dev/null)
    if grep -qE '^proto +tcp' "$OVPN" 2>/dev/null; then
      if [ -n "$op" ] && tcp_listens "$op"; then ok "openvpn listens on tcp $op"; else bad "openvpn does not listen on tcp ${op:-?}"; fi
    else
      if [ -n "$op" ] && udp_listens "$op"; then ok "openvpn listens on udp $op"; else bad "openvpn does not listen on udp ${op:-?}"; fi
    fi
  fi
  if ike_unit >/dev/null; then
    for p in 500 4500; do
      if udp_listens "$p"; then ok "ikev2 listens on udp $p"; else bad "ikev2 does not listen on udp $p"; fi
    done
    if loaded neoxify-swanctl-load.service; then
      # Running and listening is not enough for IKEv2: with nothing loaded
      # it accepts nobody (the loader's whole reason to exist).
      if [ "$(swanctl --list-conns 2>/dev/null | grep -c ':.*IKEv')" -ge 1 ]; then ok "ikev2 has its connections loaded"; else bad "ikev2 has no connection loaded (swanctl --load-all)"; fi
    fi
  fi
}

case "$MODE" in
  check) check ;;
  fix)
    check >/dev/null
    if [ "$down" = 1 ]; then repair; fi
    check
    ;;
  *)
    echo "usage: engines.sh check|fix" >&2
    exit 2
    ;;
esac
exit "$down"
