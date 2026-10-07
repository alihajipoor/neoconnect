#!/usr/bin/env bash
# Stop customers reaching a node's own loopback and private addresses
# through their Xray tunnel.
#
# Found by the 2026-10-06 review: every customer inbound went out through
# the `freedom` outbound with no rule for private destinations, so any
# customer -- a trial is enough -- could point a dokodemo-door of their own
# at 127.0.0.1:10085 and talk to the Xray API (HandlerService: every
# customer's credentials; StatsService: everyone's counters, and -reset
# drains them), or at 127.0.0.1:7505, OpenVPN's unauthenticated
# management port, which lists every OpenVPN customer's real address.
#
# The fix is a routing rule, so it lives in the config file and needs an
# Xray restart, which drops every Xray connection on the node for a
# moment. That is why it is a separate, explicit step (--apply) and is
# run one node at a time.
#
# `IPIfNonMatch` matters as much as the rule: an IP rule never sees a
# domain target, and any name that resolves to 127.0.0.1 would walk past
# it. With IPIfNonMatch, a target no rule matched by name is resolved and
# matched again by address. Rules that match by inbound tag -- the api
# rule, and the relay rules CONFIGURE_ROUTE adds at runtime -- match in
# the first pass and are unaffected.
#
# Usage:  ./block-private-egress.sh root@<node> [ssh-key]           # dry run: show the change, test it
#         ./block-private-egress.sh root@<node> [ssh-key] --apply   # write it and restart xray
set -euo pipefail

DEST="${1:?usage: block-private-egress.sh <user@host> [ssh-key] [--apply]}"
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
CONFIG=/usr/local/etc/xray/config.json
XRAY=$(command -v xray || echo /usr/local/bin/xray)
NEW=$(mktemp /tmp/xray-config.XXXXXX.json)
trap 'rm -f "$NEW" "$NEW.notun.json" "$NEW.out"' EXIT

python3 - "$CONFIG" "$NEW" <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
j = json.load(open(src))
PRIVATE = [
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
    "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16",
    "::1/128", "fc00::/7", "fe80::/10",
]
outbounds = j.setdefault("outbounds", [])
if not any(o.get("tag") == "block" for o in outbounds):
    outbounds.append({"protocol": "blackhole", "tag": "block"})
routing = j.setdefault("routing", {})
routing["domainStrategy"] = "IPIfNonMatch"
rules = routing.setdefault("rules", [])
rule = {"type": "field", "ip": PRIVATE, "outboundTag": "block"}
if not any(r.get("outboundTag") == "block" and r.get("ip") == PRIVATE for r in rules):
    # Straight after the api-in rule: the API's own traffic must still
    # reach it, and nothing a customer sends may come before the block.
    at = next((i + 1 for i, r in enumerate(rules) if r.get("inboundTag") == ["api-in"]), 0)
    rules.insert(at, rule)
json.dump(j, open(dst, "w"), indent=2)
print("rules now:")
for r in rules:
    print("  ", json.dumps(r))
print("domainStrategy:", routing["domainStrategy"])
PY

echo "--- testing the new config"
# On a relay with Xray running, a copy without the tun inbound is tested:
# -test creates the tun device, which the running Xray holds, and fails
# with "device or resource busy" whatever the config says (ir1,
# 2026-08-16, docs/journal/windows.md). Under pipefail that stopped this
# script on ir1 every time. install_xray's xray_test_config does the same.
TESTED="$NEW"
if systemctl is-active --quiet xray && python3 - "$NEW" "$NEW.notun.json" <<'PY'
import json, sys
j = json.load(open(sys.argv[1]))
inbounds = j.get("inbounds", [])
kept = [i for i in inbounds if i.get("protocol") != "tun"]
if len(kept) == len(inbounds):
    sys.exit(1)
j["inbounds"] = kept
json.dump(j, open(sys.argv[2], "w"), indent=2)
PY
then
  TESTED="$NEW.notun.json"
  echo "(Xray is running and holds the relay's tun device, so the copy tested leaves the tun inbound out)"
fi
if ! "$XRAY" run -test -config "$TESTED" >"$NEW.out" 2>&1; then
  tail -5 "$NEW.out"
  echo "Xray refuses the new config; nothing written."
  exit 1
fi
tail -1 "$NEW.out"

if [[ "$APPLY" != "1" ]]; then
  echo "dry run: nothing written (pass --apply to write it and restart xray)"
  exit 0
fi

cp -a "$CONFIG" "$CONFIG.bak-$(date +%Y%m%d-%H%M%S)"
install -m 644 "$NEW" "$CONFIG"
systemctl restart xray
sleep 3
echo "xray: $(systemctl is-active xray)"
ss -ltn | grep -c -E ':(443|2053|8443) ' | sed 's/^/public listeners up: /'
REMOTE
