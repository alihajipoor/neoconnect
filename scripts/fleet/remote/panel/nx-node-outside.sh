#!/bin/bash
# nx-node-outside.sh <nodeName> <name1> <name2> [tcp|udp-send]
# Runs on the panel host. What a new exit looks like from outside itself,
# with its address read from the database and never printed. One line per
# check, PASS or FAIL, non-zero exit on any FAIL.
#
#   mirrors      /api/health/ip through the node on 2053, 8443 and 2096,
#                over HTTP/1.1 and HTTP/2: 200, and the address reported
#                is THIS host's own. A mirror that reports the node's
#                address looks like a working tunnel to an app with none.
#   certificates verify for the names on 2053, 8443 and 2096; on 443 the
#                REALITY port shows the disguise site's real certificate
#   disguise     an ordinary page on 80, 2053, 2096 and 8443
#   ports        every TCP port the panel publishes for the node is open
#
# With "udp-send" it instead sends two datagrams to each UDP port
# (WireGuard, OpenVPN, 500, 4500), for a capture on the node to count.
# That shows a provider firewall is not in the way. It is not a handshake.
set -uo pipefail
PG=${NX_PG:-neoxify-postgres-1}
H=${NX_HEALTH:?NX_HEALTH is not set}
NODE=${1:?node}
L1=${2:?first name}
L2=${3:?second name}
WHAT=${4:-tcp}
[[ "$NODE" =~ ^[a-z0-9-]{2,40}$ ]] || { echo "bad node name"; exit 2; }
# shellcheck disable=SC2016
sql() { docker exec -i "$PG" sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB" -XtAq -F " " -v ON_ERROR_STOP=1'; }
N=$(sql <<<"SELECT \"publicIp\" FROM nodes WHERE name = '$NODE';")
[[ "$N" =~ ^[0-9.]+$ ]] || { echo "FAIL node address not found"; exit 1; }
DEST=$(sql <<<"SELECT split_part(\"realityDest\", ':', 1) FROM nodes WHERE name = '$NODE';")
PORTS=$(sql <<<"SELECT pc.protocol::text, pc.\"listenPort\" FROM protocol_configs pc JOIN nodes n ON n.id = pc.\"nodeId\" WHERE n.name = '$NODE' AND pc.\"isEnabled\";")
fail=0
pass() { echo "PASS $1"; }
nope() {
  echo "FAIL $1"
  fail=1
}

if [ "$WHAT" = udp-send ]; then
  for p in $(awk '$1 == "WIREGUARD" || $1 == "OPENVPN" {print $2}' <<<"$PORTS") 500 4500; do
    for _ in 1 2; do
      python3 -c 'import socket,sys; s=socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.sendto(b"nxf-probe", (sys.argv[1], int(sys.argv[2])))' "$N" "$p"
    done
    echo "sent 2 datagrams to udp $p"
  done
  exit 0
fi

ME=$(curl -s4 --max-time 8 "$H/health/ip" | jq -r '.ip // empty' 2>/dev/null)
[ -n "$ME" ] || nope "this host could not learn its own address from the panel"
O=$(mktemp /dev/shm/nxo.XXXXXX)
trap 'rm -f "$O"' EXIT
for t in "$L1:2053" "$L1:8443" "$L2:2096"; do
  h=${t%:*}
  p=${t#*:}
  for v in --http1.1 --http2; do
    code=$(curl -s $v --max-time 10 --resolve "$h:$p:$N" -o "$O" -w '%{http_code}' "https://$h:$p/api/health/ip")
    ip=$(jq -r '.ip // empty' "$O" 2>/dev/null)
    if [ "$code" = 200 ] && [ -n "$ME" ] && [ "$ip" = "$ME" ]; then
      pass "mirror $p $v: 200, reports the caller's own address"
    else
      nope "mirror $p $v: status $code, caller address $([ "$ip" = "$ME" ] && echo right || echo WRONG)"
    fi
  done
  r=$(echo | timeout 8 openssl s_client -connect "$N:$p" -servername "$h" -verify_return_error -verify_hostname "$h" 2>&1 | grep -m1 'Verify return code')
  grep -q 'Verify return code: 0 ' <<<"$r" && pass "certificate on $p verifies for its name" || nope "certificate on $p: ${r:-no answer}"
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 --resolve "$h:$p:$N" "https://$h:$p/")
  [ "$code" = 200 ] && pass "disguise page on $p" || nope "disguise page on $p: $code"
done
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://$N/")
[ "$code" = 200 ] && pass "disguise page on 80" || nope "disguise page on 80: $code"
curl -sI --max-time 8 "http://$N/" | grep -qi '^server: nginx/[0-9]' && nope "nginx shows its version on 80" || pass "nginx hides its version"
if [ -n "$DEST" ]; then
  r=$(echo | timeout 8 openssl s_client -connect "$N:443" -servername "$DEST" -verify_return_error -verify_hostname "$DEST" 2>&1 | grep -m1 'Verify return code')
  grep -q 'Verify return code: 0 ' <<<"$r" && pass "443 shows the disguise site's real certificate" || nope "443 disguise certificate: ${r:-no answer}"
fi
for p in 22 80 2096 $(awk '$1 ~ /^(XRAY|SHADOWSOCKS)/ {print $2}' <<<"$PORTS" | sort -un); do
  timeout 4 bash -c "</dev/tcp/$N/$p" 2>/dev/null && pass "tcp $p open" || nope "tcp $p CLOSED (a provider firewall?)"
done
exit $fail
