#!/bin/bash
# uot-test.sh   Runs on an exit server. Read-only.
# Shadowsocks UDP through this server's own Xray, on loopback: a
# temporary client with UDP-over-TCP on asks 1.1.1.1 one DNS question.
#
# The apps send ALL their UDP, DNS included, over Shadowsocks this way,
# and Xray only serves it when its outbound dials the magic name
# unresolved. An IPv4-only config without that carve-out resolves the
# name, gets nothing, and every Shadowsocks UDP flow dies with no log
# line at warning level. It broke DNS on four servers for an hour and a
# half before anyone saw it, which is why this is checked on every build.
set -uo pipefail
umask 077

# How many lines of dig's +short output are answers: IPv4 addresses
# only. dig prints ";; connection timed out; no servers could be
# reached" on that same output when nothing answers, and counting every
# line made a dead Xray a PASS (2026-11-13).
uot_answers() { grep -cE '^([0-9]{1,3}\.){3}[0-9]{1,3}$' || true; }
[ "${1:-}" = --count-answers ] && { uot_answers; exit 0; }
C=/usr/local/etc/xray/config.json
D=$(mktemp -d /dev/shm/uot.XXXXXX)
XP=
cleanup() {
  [ -n "$XP" ] && kill "$XP" 2>/dev/null
  shred -u "$D/c.json" 2>/dev/null
  rm -rf "$D"
}
trap cleanup EXIT
jq '(.inbounds[] | select(.tag == "shadowsocks-in")) as $i
  | {log: {loglevel: "warning"},
     inbounds: [{listen: "127.0.0.1", port: 15399, protocol: "dokodemo-door", settings: {address: "1.1.1.1", port: 53, network: "udp"}}],
     outbounds: [{protocol: "shadowsocks", settings: {servers: [{address: "127.0.0.1", port: $i.port, method: $i.settings.method,
       password: ($i.settings.password + ":" + $i.settings.clients[0].password), uot: true}]}}]}' "$C" >"$D/c.json" 2>/dev/null
if [ ! -s "$D/c.json" ]; then
  echo "UOT-FAIL no shadowsocks-in inbound with a seed user in the config"
  exit 1
fi
# The server's own Xray must be running and listening on that port: this
# test talks to it, and on 2026-11-13 it "passed" with it dead.
SSP=$(jq -r '.inbounds[] | select(.tag == "shadowsocks-in") | .port' "$C")
if [ "$(systemctl is-active xray 2>/dev/null)" != active ]; then
  echo "UOT-FAIL the server's Xray is not running ($(systemctl is-active xray 2>&1 | head -1))"
  exit 1
fi
if [ -z "$(ss -Hltn "( sport = :$SSP )" 2>/dev/null)" ]; then
  echo "UOT-FAIL nothing listens on the Shadowsocks port $SSP"
  exit 1
fi
/usr/local/bin/xray run -c "$D/c.json" >"$D/log" 2>&1 &
XP=$!
sleep 2
out=$(dig +time=4 +tries=1 -p 15399 @127.0.0.1 www.example.com A +short 2>/dev/null)
n=$(printf '%s\n' "$out" | uot_answers)
if [ "$n" -ge 1 ]; then
  echo "UOT-PASS DNS over Shadowsocks UDP-over-TCP answered ($n address(es))"
else
  echo "UOT-FAIL no DNS answer over Shadowsocks UDP-over-TCP"
  exit 1
fi
