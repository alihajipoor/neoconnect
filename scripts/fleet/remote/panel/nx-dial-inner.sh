#!/bin/bash
# nx-dial-inner.sh <wireguard|openvpn|ikev2>
# Runs INSIDE the throwaway dial container that nx-dial.sh starts, never
# on a host. Brings the tunnel up with the real client, then proves it:
# where it exits, 256 KB down, 256 KB up. Everything it changes (routes,
# interfaces) is the container's own network namespace.
#
# /nx (read-only): the client's config, endpoint ("host:port"), body
# (256 KB to send). Env: NX_HEALTH (the panel API base), NX_EXPECT (the
# address the tunnel must exit on), NX_HOLD, NX_LABEL.
set -uo pipefail
K="${1:?kind}"
L="${NX_LABEL:-dial}"
H="${NX_HEALTH:?}"
HN=$(sed -E 's#^https?://([^/:]+).*#\1#' <<<"$H")
say() { echo "$L | $*"; }
fail() {
  say "$*"
  [ -f /tmp/client.log ] && grep -iE "error|fail|refus|timeout|denied|AUTH|no route|verif" /tmp/client.log | grep -viE "secret|password|key" | tail -4 | cut -c1-160
  echo "E2E-FAIL $L"
  exit 1
}
v4() { getent ahostsv4 "$1" | awk 'NR == 1 {print $1}'; }

# Before the tunnel: the panel's address (so no DNS is needed through it),
# the server's address, and the container's own gateway.
PIP=$(v4 "$HN")
[ -n "$PIP" ] || fail "cannot resolve the panel's name"
EP=$(cat /nx/endpoint)
EPH=${EP%:*}
EPIP=$(v4 "$EPH")
[ -n "$EPIP" ] || fail "cannot resolve the server's endpoint"
GW=$(ip -4 route show default | awk '{print $3; exit}')
[ -n "$GW" ] || fail "the container has no default route"
# The server stays reachable outside the tunnel; everything else goes in.
ip route add "$EPIP/32" via "$GW" || fail "cannot pin a route to the server"

up_wireguard() {
  # In the foreground, as a child of this script: daemonised, its UAPI
  # socket reset the first `wg setconf` (seen on the panel host).
  LOG_LEVEL=error WG_PROCESS_FOREGROUND=1 wireguard-go wg0 >/tmp/client.log 2>&1 &
  for _ in $(seq 1 20); do
    [ -S /run/wireguard/wg0.sock ] && break
    sleep 0.25
  done
  [ -S /run/wireguard/wg0.sock ] || fail "wireguard-go did not start"
  wg setconf wg0 /nx/wg.conf 2>>/tmp/client.log || fail "wg setconf refused the config"
  ip addr add "$(cat /nx/wg.addr)" dev wg0 && ip link set wg0 mtu 1420 up || fail "cannot bring wg0 up"
  ip route replace default dev wg0 || fail "cannot route through wg0"
  # A handshake, before any test: WireGuard is silent about a peer that
  # does not answer, so "no handshake in 20 s" is the failure to report.
  for _ in $(seq 1 40); do
    curl -s -o /dev/null --max-time 1 "http://$PIP/" 2>/dev/null || true
    hs=$(wg show wg0 latest-handshakes | awk '{print $2; exit}')
    [ "${hs:-0}" -gt 0 ] && return 0
    sleep 0.5
  done
  fail "no WireGuard handshake in 20 s"
}

up_openvpn() {
  openvpn --config /nx/client.ovpn --daemon --log /tmp/client.log --writepid /tmp/client.pid || fail "openvpn did not start"
  for _ in $(seq 1 60); do
    grep -q "Initialization Sequence Completed" /tmp/client.log 2>/dev/null && return 0
    grep -qE "AUTH_FAILED|TLS Error|Exiting due to fatal error" /tmp/client.log 2>/dev/null && fail "openvpn refused"
    sleep 0.5
  done
  fail "openvpn did not complete in 30 s"
}

up_ikev2() {
  mkdir -p /tmp/sw/x509ca
  cp /nx/swanctl.conf /tmp/sw/swanctl.conf
  cp /usr/share/ca-certificates/mozilla/ISRG_Root_X*.crt /tmp/sw/x509ca/ 2>/dev/null
  # ESP in charon itself (kernel-libipsec, over its own TUN device): the
  # host kernel's IPsec is never used. Routes go in the main table of this
  # namespace, the server's own address pinned outside (above).
  cat >/tmp/sw/strongswan.conf <<'CONF'
charon {
  load = random nonce openssl pem pkcs1 x509 revocation constraints pubkey kernel-libipsec kernel-netlink socket-default eap-mschapv2 eap-identity vici updown
  install_routes = yes
  routing_table = 0
  install_virtual_ip = yes
  filelog {
    nx {
      path = /tmp/client.log
      default = 1
    }
  }
}
CONF
  STRONGSWAN_CONF=/tmp/sw/strongswan.conf /usr/lib/ipsec/charon >/dev/null 2>&1 &
  for _ in $(seq 1 20); do
    [ -S /run/charon.vici ] && break
    sleep 0.25
  done
  [ -S /run/charon.vici ] || fail "charon did not start"
  swanctl --load-all --file /tmp/sw/swanctl.conf >/dev/null 2>&1 || fail "swanctl refused the config"
  swanctl --initiate --child nx --timeout 30 >/dev/null 2>&1 || fail "IKEv2 did not establish"
  # libipsec's routes are in place once the CHILD_SA is; make the default
  # explicit in case the table option is ignored by this build (the
  # server itself stays on the route pinned above).
  dev=$(ip -o link show | awk -F': ' '/ipsec/ {print $2; exit}')
  [ -n "$dev" ] && ip route replace default dev "$dev" 2>/dev/null
  return 0
}

# Leave the way a real client leaves, so the server drops the session at
# once rather than holding it (and its pool address) until it times out.
teardown() {
  case "$K" in
    ikev2) swanctl --terminate --ike nx --timeout 5 >/dev/null 2>&1 ;;
    openvpn) [ -f /tmp/client.pid ] && kill -TERM "$(cat /tmp/client.pid)" 2>/dev/null && sleep 2 ;;
  esac
}
trap teardown EXIT

case "$K" in
  wireguard) up_wireguard ;;
  openvpn) up_openvpn ;;
  ikev2) up_ikev2 ;;
  *) fail "unknown kind $K" ;;
esac

S=(--resolve "$HN:443:$PIP" --connect-timeout 10 --max-time 25)
GOT=$(curl -s "${S[@]}" "$H/health/ip" | sed -nE 's/.*"ip" *: *"([^"]+)".*/\1/p')
if [ -z "$GOT" ]; then
  EX=EXIT-NONE
elif [ "$GOT" = "${NX_EXPECT:-}" ]; then
  EX=EXIT-MATCH
else
  EX=EXIT-MISMATCH
fi
DN=$(curl -s "${S[@]}" -o /dev/null -w '%{http_code} %{size_download}B %{time_total}s' "$H/health/bulk?bytes=262144")
UP=$(curl -s "${S[@]}" -o /dev/null -w '%{http_code} %{size_upload}B %{time_total}s' -H 'Content-Type: application/octet-stream' --data-binary @/nx/body "$H/health/bulk")
say "$EX | down $DN | up $UP"
case "$EX|$DN|$UP" in
  "EXIT-MATCH|200 262144B "*"|200 262144B "*) echo "E2E-PASS $L" ;;
  *) fail "the tunnel came up, but the proof did not pass" ;;
esac
if [ "${NX_HOLD:-0}" -gt 0 ]; then
  echo "HOLDING ${NX_HOLD}s"
  end=$(($(date +%s) + NX_HOLD))
  # Until the caller has read the server's own view and says so.
  while [ "$(date +%s)" -lt "$end" ] && [ ! -e /tmp/release ]; do
    sleep 1
  done
fi
exit 0
