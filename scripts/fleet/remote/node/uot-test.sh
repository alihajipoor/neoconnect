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
/usr/local/bin/xray run -c "$D/c.json" >"$D/log" 2>&1 &
XP=$!
sleep 2
n=$(dig +time=4 +tries=1 -p 15399 @127.0.0.1 www.example.com A +short 2>/dev/null | grep -c .)
if [ "$n" -ge 1 ]; then
  echo "UOT-PASS DNS over Shadowsocks UDP-over-TCP answered ($n line(s))"
else
  echo "UOT-FAIL no DNS answer over Shadowsocks UDP-over-TCP"
  exit 1
fi
