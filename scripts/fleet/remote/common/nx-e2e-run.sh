#!/bin/bash
# <envelope on stdin> | nx-e2e-run.sh <xray binary> <label>
# Runs on the panel host, or on the relay box for the proof from inside.
# Starts a temporary Xray client from the envelope nx-e2e-build.sh or
# nx-e2e-temp.sh made, and proves the tunnel three ways:
#
#   - where it exits: the address the panel's /health/ip sees, compared
#     here with the envelope's nxExpectIp. Prints EXIT-MATCH,
#     EXIT-MISMATCH or EXIT-NONE, never an address;
#   - 256 KB down and 256 KB up through /health/bulk, with status, byte
#     count and time. A tunnel that connects and moves nothing is the
#     failure this exists for;
#   - for Shadowsocks, one UDP DNS query over UDP-over-TCP.
#
# NX_HEALTH is the panel API base the checks go to (https://<name>/api).
# The client is a separate process on a free local port: it never touches
# an Xray service. The config is shredded on exit.
set -uo pipefail
X="${1:?xray binary}"
L="${2:?label}"
H="${NX_HEALTH:?NX_HEALTH is not set}"
umask 077
[ -x "$X" ] || { echo "$L | xray binary not executable"; exit 1; }
D=$(mktemp -d /dev/shm/e2e.XXXXXX)
XP=
cleanup() {
  if [ -n "$XP" ]; then
    kill "$XP" 2>/dev/null
    wait "$XP" 2>/dev/null
  fi
  shred -u "$D"/in.json "$D"/c.json 2>/dev/null
  rm -rf "$D"
}
trap cleanup EXIT
cat >"$D/in.json"
EXPECT=$(jq -r '.nxExpectIp // empty' "$D/in.json" 2>/dev/null)
exec 8>/dev/shm/nx-e2e-port.lock
flock -w 60 8 # held until the client listens: two runs never pick one port
SP=0
DP=0
for i in 0 1 2 3 4 5 6 7 8 9; do
  SP=$((18990 + i))
  DP=$((15353 + i))
  ss -ltnH | awk '{print $4}' | grep -q ":$SP\$" && continue
  ss -lunH | awk '{print $4}' | grep -q ":$DP\$" && continue
  break
done
if ss -ltnH | awk '{print $4}' | grep -q ":$SP\$"; then
  echo "$L | no free local port in 18990-18999"
  exit 1
fi
jq --argjson sp "$SP" --argjson dp "$DP" '.config
  | .inbounds |= map(if .protocol == "socks" then .port = $sp elif .protocol == "dokodemo-door" then .port = $dp else . end)' \
  "$D/in.json" >"$D/c.json" || { echo "$L | bad envelope on stdin"; exit 1; }
shred -u "$D/in.json" 2>/dev/null
HASDNS=$(jq -r '[.inbounds[] | select(.protocol == "dokodemo-door")] | length' "$D/c.json")
head -c 262144 /dev/urandom >"$D/body"
"$X" run -c "$D/c.json" >"$D/log" 2>&1 &
XP=$!
for _ in $(seq 1 20); do
  ss -ltnH | grep -q "127.0.0.1:$SP " && break
  sleep 0.25
done
flock -u 8
S=(--socks5-hostname "127.0.0.1:$SP" --connect-timeout 10 --max-time 25)
GOT=$(curl -s "${S[@]}" "$H/health/ip" | jq -r '.ip // empty' 2>/dev/null)
if [ -z "$GOT" ]; then
  EX=EXIT-NONE
elif [ -z "$EXPECT" ]; then
  EX="EXIT-UNCHECKED (no expected address given)"
elif [ "$GOT" = "$EXPECT" ]; then
  EX=EXIT-MATCH
else
  EX=EXIT-MISMATCH
fi
DN=$(curl -s "${S[@]}" -o /dev/null -w '%{http_code} %{size_download}B %{time_total}s' "$H/health/bulk?bytes=262144")
UP=$(curl -s "${S[@]}" -o /dev/null -w '%{http_code} %{size_upload}B %{time_total}s' -H 'Content-Type: application/octet-stream' --data-binary @"$D/body" "$H/health/bulk")
DNS=
if [ "$HASDNS" -gt 0 ]; then
  DNS=" | DNS over UoT: $(
    NX_DP=$DP python3 - <<'PY'
import os, socket, struct
q = struct.pack(">HHHHHH", 0x4e58, 0x0100, 1, 0, 0, 0) + b"".join(bytes([len(p)]) + p.encode() for p in "example.com".split(".")) + b"\0" + struct.pack(">HH", 1, 1)
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(8)
try:
    s.sendto(q, ("127.0.0.1", int(os.environ["NX_DP"]))); r, _ = s.recvfrom(2048)
    print("answered, %d answer(s), rcode %d" % (struct.unpack(">H", r[6:8])[0], r[3] & 15))
except Exception as e:
    print("NO ANSWER (%s)" % type(e).__name__)
PY
  )"
fi
echo "$L | $EX | down $DN | up $UP$DNS"
kill "$XP" 2>/dev/null
wait "$XP" 2>/dev/null
XP=
grep -iE "error|fail" "$D/log" | sed -E 's/[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/<ip>/g' | head -3 | cut -c1-160
# One line a caller can test: every leg, or not.
case "$EX|$DN|$UP" in
  "EXIT-MATCH|200 262144B "*"|200 262144B "*)
    if [ "$HASDNS" -gt 0 ] && ! grep -q "answered" <<<"$DNS"; then echo "E2E-FAIL $L"; exit 1; fi
    echo "E2E-PASS $L"
    ;;
  *)
    echo "E2E-FAIL $L"
    exit 1
    ;;
esac
