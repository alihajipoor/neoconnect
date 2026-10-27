#!/usr/bin/env bash
# Neoxify data check, run on a box inside the watched country.
#
# Installed as /usr/local/bin/neoxify-inside-probe and run only as the
# forced command of one SSH key, which the panel host's collector uses
# (collect.sh). It reads "nodeId ipv4 port" lines on stdin and prints one
# JSON object per line: 256 KB down and 256 KB up through each node's own
# address, timed. It holds nothing: no credentials, no token, no list of
# nodes, no log -- the box may be seized, so nothing on it should matter.
#
# How it reaches anything: a TLS connection to the node's VLESS-TLS or
# Trojan port, under a neutral name and without checking the certificate.
# What arrives is not VLESS, so Xray hands it to the node's fallback site,
# whose /api/ is the API mirror -- and /api/health/bulk is what the apps'
# own data check uses. Every byte goes to and from the node's address, so
# a hold on that address shows, as it did in October 2026 (upload held to
# about 0.1 Mbps after the first 63-95 KB). What this cannot see: blocks
# on a protocol's own handshake (WireGuard's) or on our server names.
set -u

SNI="${NEOXIFY_PROBE_SNI:-www.bing.com}"
BYTES=262144
LEG_SECONDS=8
MAX_TARGETS=64

body="$(mktemp)"
trap 'rm -f "$body"' EXIT
head -c "$BYTES" /dev/urandom >"$body"

# Seconds as curl prints them, in whole milliseconds.
ms() { awk -v s="$1" 'BEGIN { printf "%d", s * 1000 }'; }

# One leg: "status bytes connect_seconds total_seconds" from curl, which
# prints its write-out on failure too (status 000).
leg() {
  local to="$1" url="$2"
  shift 2
  curl -sk --http1.1 -o /dev/null --connect-timeout 5 --max-time "$LEG_SECONDS" \
    --connect-to "$to" "$@" -w '%{http_code} %{size_download} %{size_upload} %{time_connect} %{time_total}' \
    "$url" 2>/dev/null || true
}

count=0
while read -r node ip port _; do
  [[ "$node" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || continue
  [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || continue
  [[ "$port" =~ ^[0-9]{1,5}$ ]] || continue
  count=$((count + 1))
  [ "$count" -le "$MAX_TARGETS" ] || break

  to="$SNI:$port:$ip:$port"
  url="https://$SNI:$port/api/health/bulk"
  read -r d_status d_bytes _ d_connect d_total <<<"$(leg "$to" "$url?bytes=$BYTES")"
  read -r u_status _ u_bytes u_connect u_total <<<"$(leg "$to" "$url" \
    -H 'Content-Type: application/octet-stream' --data-binary @"$body")"

  connect="null"
  for c in "${d_connect:-0}" "${u_connect:-0}"; do
    if [ "$(ms "$c")" -gt 0 ]; then connect="$(ms "$c")"; break; fi
  done
  # curl counts what it sent, not what arrived: an upload that ran out of
  # time is reported with no answer (status 0), which is what is judged.
  printf '{"nodeId":"%s","port":%d,"connectMs":%s,"down":{"status":%d,"bytes":%d,"ms":%d},"up":{"status":%d,"bytes":%d,"ms":%d}}\n' \
    "$node" "$port" "$connect" \
    "$((10#${d_status:-0}))" "${d_bytes:-0}" "$(ms "${d_total:-0}")" \
    "$((10#${u_status:-0}))" "${u_bytes:-0}" "$(ms "${u_total:-0}")"
done
