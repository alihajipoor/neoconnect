#!/usr/bin/env bash
# Stop a node's Xray from reaching websites over IPv6, without breaking
# Shadowsocks UDP on the way.
#
# Why (2026-10-11, docs/journal/log.md): with the node's own IPv6 in the
# path, a customer's traffic could leave over IPv6 on one node and IPv4 on
# the next, and on a node whose IPv6 is broken it simply hung. Customers
# now leave every exit node over IPv4 only. Brings an existing node to
# what installer/assets/xray-config.json.template (and the relay variant)
# write for a new one -- the same pieces, with the same comment texts, so
# a later re-run of install_xray finds nothing to report.
#
# Three pieces, each useless without the others:
#   1. "dns": {"queryStrategy": "UseIPv4"}. Routing's IPIfNonMatch resolves
#      a name to match it against ip rules, and an ip rule matches if ANY
#      answer is in range -- so with AAAA answers, piece 3 would block
#      every dual-stack site. No servers are added: Xray keeps using the
#      system resolver, as before.
#   2. freedom "direct": "domainStrategy": "ForceIPv4". A name is dialled
#      at one of its A records, and one with no A record fails instead of
#      being dialled by name (which the system dialer would do over IPv6).
#      UseIPv4 has exactly that fallback; ForceIPv4 does not.
#   3. A rule sending ::/0 to "block", right after the private-range rule.
#      An IPv6 destination is refused before anything is dialled.
#
# And one that exists only because of piece 2, on exit nodes only:
#   4. "uot-direct": a plain freedom outbound, and a rule sending the
#      Shadowsocks UDP-over-TCP magic names to it, right after the api
#      rule. The desktop and mobile clients carry ALL their UDP -- DNS
#      included -- over UoT, and Xray serves UoT only when freedom hands
#      the name sp.v2.udp-over-tcp.arpa on unresolved. ForceIPv4 resolves
#      it, finds no address, and every UoT flow died after ~1.3 s with
#      nothing sent back. That is what shipping pieces 1-3 alone did to
#      four live nodes on 2026-10-11, for about an hour.
#
# Piece 4 is the one rule here that sends traffic OUT instead of refusing
# it, and every rule in the file sits before the route rules the agent's
# CONFIGURE_ROUTE appends at runtime. On a node that is the Xray entry of
# a relay route on shadowsocks-in, it would serve that route's UoT from
# the entry instead of the exit. So the script reads the running Xray's
# outbounds and rules first and refuses a node that holds any route-*
# one; the relay template's layout (blackhole first, a tun inbound) gets
# pieces 1-3 only.
#
# Known gap, the same as with the private-range rule: freedom's UDP socket
# is dual-stack and only a session's first destination is routed, so a UDP
# session could still reach an IPv6 address on a node that has IPv6. Only
# a kernel rule closes that.
#
# The change needs an Xray restart to take effect, which drops every Xray
# connection on the node for a few seconds -- so this script never
# restarts anything. --apply backs the config up, writes it and tests the
# written file; it then prints the restart command, to run one node at a
# time when few people are connected.
#
# Usage:  ./xray-ipv4-only.sh root@<node> [ssh-key]           # dry run: show the change, test it
#         ./xray-ipv4-only.sh root@<node> [ssh-key] --apply   # back up, write and test it; no restart
#         ./xray-ipv4-only.sh --local [--apply]               # the same on this machine; CONFIG and XRAY
#                                                             # override the paths (scripts/test-xray-ipv4-only.sh)
set -euo pipefail

DEST="${1:?usage: xray-ipv4-only.sh <user@host>|--local [ssh-key] [--apply]}"
KEY=""
APPLY=0
for arg in "${@:2}"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    *) KEY="$arg" ;;
  esac
done

read -r -d '' REMOTE <<'REMOTE' || true
set -euo pipefail
CONFIG="${CONFIG:-/usr/local/etc/xray/config.json}"
XRAY="${XRAY:-$(command -v xray || echo /usr/local/bin/xray)}"
API="${XRAY_API:-127.0.0.1:10085}"
WORK=$(mktemp -d /tmp/xray-ipv4-only.XXXXXX)
trap 'rm -rf "$WORK"' EXIT
NEW="$WORK/config.json"

# What the running Xray holds that the file does not: the route rules and
# route outbounds CONFIGURE_ROUTE adds at runtime. Without RoutingService
# in the api block there can be none -- the agent could not add them.
RUNTIME="$WORK/runtime.json"
if python3 -c 'import json, sys; sys.exit(0 if "RoutingService" in (json.load(open(sys.argv[1])).get("api") or {}).get("services", []) else 1)' "$CONFIG" </dev/null; then
  if "$XRAY" api lsrules -s "$API" </dev/null >"$WORK/rules.json" 2>"$WORK/rules.err" &&
    "$XRAY" api lso -s "$API" </dev/null >"$WORK/outs.json" 2>"$WORK/outs.err"; then
    python3 - "$WORK/rules.json" "$WORK/outs.json" "$RUNTIME" <<'PY'
import json, sys
rules = json.load(open(sys.argv[1])).get("rules", [])
outs = json.load(open(sys.argv[2])).get("outbounds", [])
json.dump({"rules": [r.get("ruleTag") or "" for r in rules], "outbounds": [o.get("tag") or "" for o in outs]}, open(sys.argv[3], "w"))
PY
  else
    echo "unreadable" >"$RUNTIME"
  fi
else
  echo "no-routing-service" >"$RUNTIME"
fi

set +e
python3 - "$CONFIG" "$NEW" "$RUNTIME" <<'PY'
import json, sys

src, dst, runtime_path = sys.argv[1], sys.argv[2], sys.argv[3]

# The texts are the templates' own, character for character: install_xray
# compares a node's rules with the template's by value, and a rule that
# differs only in its comment would be reported as "NOT carried over".
DNS_COMMENT = "queryStrategy UseIPv4 is load-bearing (2026-10-11): routing's IPIfNonMatch resolves names for its ip rules, and with AAAA answers the block-ipv6-egress rule would block every dual-stack site. A per-server queryStrategy cannot undo it."
IPV6_RULE = {
    "//": "No IPv6 egress (2026-10-11): an IPv6 destination is refused here instead of dialled. Needs dns.queryStrategy UseIPv4 (else every dual-stack domain matches this rule) and freedom domainStrategy ForceIPv4 (else a name with no A record is dialled over IPv6). Gap: freedom's UDP socket is dual-stack and later packets of an already-routed UDP session are not re-routed, so only a kernel rule makes this absolute.",
    "type": "field",
    "ruleTag": "block-ipv6-egress",
    "ip": ["::/0"],
    "outboundTag": "block",
}
UOT_OUTBOUND = {
    "//": "UoT carve-out (2026-10-11). Shadowsocks UDP-over-TCP, which the desktop and mobile clients use for all UDP including DNS, is served by Xray's outbound handler only when freedom passes the magic name sp.v2.udp-over-tcp.arpa through unresolved. 'direct' is ForceIPv4, which resolves it, finds no A record and drops the flow. No domainStrategy here, deliberately; only the rule tagged uot-direct reaches this outbound. Known gap: the UoT socket is dual-stack and its inner UDP destinations are never routed, so on a node with IPv6 a client could still send UDP to an IPv6 literal through it (and to private ranges -- as before 2026-10-11); only a kernel rule closes that.",
    "tag": "uot-direct",
    "protocol": "freedom",
    "settings": {},
}
UOT_RULE = {
    "//": "First, before IPIfNonMatch resolves anything: the UoT magic names never resolve, and must reach uot-direct unresolved.",
    "type": "field",
    "ruleTag": "uot-direct",
    "domain": ["full:sp.v2.udp-over-tcp.arpa", "full:sp.udp-over-tcp.arpa"],
    "outboundTag": "uot-direct",
}
PRIVATE = [
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
    "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16",
    "::1/128", "fc00::/7", "fe80::/10",
]


def refuse(why):
    print("REFUSED: " + why + " -- nothing written")
    sys.exit(2)


def no_duplicates(pairs):
    keys = [k for k, _ in pairs]
    dup = sorted({k for k in keys if keys.count(k) > 1})
    if dup:
        refuse("duplicate JSON keys %s: Xray and this script would read different configs" % dup)
    return dict(pairs)


try:
    c = json.load(open(src), object_pairs_hook=no_duplicates)
except ValueError as e:
    refuse("not plain JSON (%s)" % e)
if not isinstance(c, dict):
    refuse("the config is not a JSON object")

inbounds = c.get("inbounds") or []
outs = c.get("outbounds")
if not isinstance(outs, list) or not outs or not all(isinstance(o, dict) for o in outs):
    refuse("outbounds is not a list of objects")
directs = [o for o in outs if isinstance(o, dict) and o.get("tag") == "direct"]
if len(directs) != 1 or directs[0].get("protocol") != "freedom":
    refuse("expected exactly one outbound tagged 'direct', a freedom")
direct = directs[0]
if not any(isinstance(o, dict) and o.get("tag") == "block" and o.get("protocol") == "blackhole" for o in outs):
    refuse("no blackhole outbound tagged 'block' (run block-private-egress.sh first)")
relay = outs[0].get("tag") == "block" or any(
    isinstance(i, dict) and (i.get("protocol") == "tun" or str(i.get("tag", "")).startswith("relay")) for i in inbounds)
if not relay and outs[0] is not direct:
    refuse("the first (default) outbound is neither freedom 'direct' nor a relay's blackhole -- an unknown layout")

routing = c.get("routing")
if not isinstance(routing, dict) or routing.get("domainStrategy") != "IPIfNonMatch":
    refuse("routing.domainStrategy is not IPIfNonMatch (run block-private-egress.sh first)")
rules = routing.get("rules")
if not isinstance(rules, list) or not rules or not isinstance(rules[0], dict) or rules[0].get("inboundTag") != ["api-in"]:
    refuse("routing.rules[0] is not the api-in rule")
private_at = [i for i, r in enumerate(rules) if isinstance(r, dict) and r.get("outboundTag") == "block" and r.get("ip") == PRIVATE]
if len(private_at) != 1:
    refuse("the private-range rule is missing (run block-private-egress.sh first)")
for i, r in enumerate(rules):
    if i == 0 or i == private_at[0]:
        continue
    if not isinstance(r, dict) or r.get("ruleTag") not in ("uot-direct", "block-ipv6-egress"):
        refuse("routing.rules[%d] is a rule this script does not know -- a hand-edited routing block, not in scope" % i)

dns = c.get("dns")
if dns is not None and not isinstance(dns, dict):
    refuse("dns is present but not an object")
if dns is not None and dns.get("queryStrategy", "UseIPv4") != "UseIPv4":
    refuse("dns.queryStrategy is already %r" % dns.get("queryStrategy"))
settings = direct.get("settings")
if settings is not None and not isinstance(settings, dict):
    refuse("freedom 'direct' settings is not an object")
settings = settings or {}
if settings.get("targetStrategy") not in (None, "ForceIPv4"):
    refuse("freedom 'direct' has targetStrategy %r, which overrides domainStrategy" % settings.get("targetStrategy"))
if settings.get("domainStrategy", "AsIs") not in ("AsIs", "ForceIPv4"):
    refuse("freedom 'direct' domainStrategy is already %r" % settings.get("domainStrategy"))

have_uot_out = [o for o in outs if isinstance(o, dict) and o.get("tag") == "uot-direct"]
have_uot_rule = [r for r in rules if isinstance(r, dict) and r.get("ruleTag") == "uot-direct"]
if relay and (have_uot_out or have_uot_rule):
    refuse("a relay carries a uot-direct piece: it would send relayed Shadowsocks UDP out of the relay itself")
for o in have_uot_out:
    if o.get("protocol") != "freedom" or (o.get("settings") or {}).get("domainStrategy", "AsIs") != "AsIs":
        refuse("an outbound tagged uot-direct exists and is not a plain freedom")
for r in have_uot_rule:
    if r.get("outboundTag") != "uot-direct" or r.get("domain") != UOT_RULE["domain"]:
        refuse("a rule tagged uot-direct exists with a different shape")
have_v6_rule = [r for r in rules if isinstance(r, dict) and r.get("ruleTag") == "block-ipv6-egress"]
for r in have_v6_rule:
    if r.get("outboundTag") != "block" or r.get("ip") != ["::/0"]:
        refuse("a rule tagged block-ipv6-egress exists with a different shape")

if not relay:
    rt = open(runtime_path).read().strip()
    if rt == "unreadable":
        refuse("could not read the running Xray's routes over its API (is xray running?), so it cannot tell whether this node is a relay entry")
    if rt != "no-routing-service":
        held = json.loads(rt)
        routes = sorted({t for t in held["rules"] + held["outbounds"] if t.startswith("route-")})
        if routes:
            refuse("the running Xray holds relay routes %s: this node is the entry of a relay route, and the uot-direct "
                   "rule would sit in front of them and send that route's Shadowsocks UDP out of this node instead of "
                   "the exit -- not in scope, see the header" % routes)

changes = []
if dns is None:
    out = {}
    for k, v in c.items():
        if k == "routing":
            out["dns"] = {"//": DNS_COMMENT, "queryStrategy": "UseIPv4"}
        out[k] = v
    c = out
    changes.append("dns: add {queryStrategy: UseIPv4} (no servers: the system resolver, as now)")
elif "queryStrategy" not in dns:
    dns["queryStrategy"] = "UseIPv4"
    changes.append("dns: add queryStrategy UseIPv4 to the existing dns block")
if settings.get("domainStrategy") != "ForceIPv4":
    s = direct.get("settings")
    if not isinstance(s, dict):
        s = direct["settings"] = {}
    s["domainStrategy"] = "ForceIPv4"
    changes.append("freedom 'direct': domainStrategy ForceIPv4")
if not relay and not have_uot_out:
    outs.append(dict(UOT_OUTBOUND))
    changes.append("outbound uot-direct: a plain freedom for Shadowsocks UDP-over-TCP")
if not relay and not have_uot_rule:
    rules.insert(1, dict(UOT_RULE))
    changes.append("rule uot-direct: the UoT magic names -> uot-direct, right after the api rule")
if not have_v6_rule:
    at = [i for i, r in enumerate(rules) if r.get("outboundTag") == "block" and r.get("ip") == PRIVATE][0]
    rules.insert(at + 1, dict(IPV6_RULE))
    changes.append("rule block-ipv6-egress: ::/0 -> block, right after the private-range rule")

print("layout: %s" % ("relay (blackhole default, no uot-direct)" if relay else "exit (freedom 'direct' default)"))
if not changes:
    print("already applied: nothing to change")
    sys.exit(3)
for line in changes:
    print("  " + line)
print("rules now: %s" % [r.get("ruleTag") or ("api" if r.get("inboundTag") == ["api-in"] else r.get("outboundTag")) for r in rules])
with open(dst, "w") as f:
    json.dump(c, f, indent=2)
    f.write("\n")
PY
rc=$?
set -e
if [[ "$rc" == 3 ]]; then
  echo "Nothing to do."
  exit 0
fi
[[ "$rc" == 0 ]] || exit "$rc"

# xray_test_config (installer/lib/agent.sh) in miniature: on a relay with
# Xray running, -test would try to create the tun device the running Xray
# holds and fail whatever the config says, so a copy without it is tested.
xray_test() {
  local tested="$1"
  if systemctl is-active --quiet xray 2>/dev/null && python3 - "$1" "$WORK/notun.json" <<'PY'
import json, sys
j = json.load(open(sys.argv[1]))
kept = [i for i in j.get("inbounds", []) if i.get("protocol") != "tun"]
if len(kept) == len(j.get("inbounds", [])):
    sys.exit(1)
j["inbounds"] = kept
json.dump(j, open(sys.argv[2], "w"), indent=2)
PY
  then
    tested="$WORK/notun.json"
    echo "(Xray is running and holds the relay's tun device, so the copy tested leaves the tun inbound out)"
  fi
  if ! "$XRAY" run -test -config "$tested" </dev/null >"$WORK/test.out" 2>&1; then
    tail -5 "$WORK/test.out"
    return 1
  fi
  grep -v -i deprecated "$WORK/test.out" | tail -1
}

echo "--- testing the new config"
if ! xray_test "$NEW"; then
  echo "Xray refuses the new config; nothing written."
  exit 1
fi

if [[ "$APPLY" != "1" ]]; then
  echo "dry run: nothing written (pass --apply to back up and write it; it never restarts xray)"
  exit 0
fi

BACKUP="$CONFIG.bak-$(date -u +%Y%m%dT%H%M%SZ)"
cp -a "$CONFIG" "$BACKUP"
cmp -s "$CONFIG" "$BACKUP" || { echo "the backup does not match the config; nothing written"; exit 1; }
echo "backup: $BACKUP"
# Replaced in one rename, keeping the file's owner and mode.
TMP="$(mktemp "$(dirname "$CONFIG")/.xray-ipv4-only.XXXXXX")"
cat "$NEW" >"$TMP"
chmod --reference="$CONFIG" "$TMP"
chown --reference="$CONFIG" "$TMP" 2>/dev/null || true
mv -f "$TMP" "$CONFIG"
if ! xray_test "$CONFIG"; then
  cp -a "$BACKUP" "$CONFIG"
  echo "Xray refuses the written file; the backup is back in place. Xray was not restarted."
  exit 1
fi
echo "written. Xray still runs the previous config until it restarts."
if [[ -x /usr/local/bin/neoxify-xray-restart ]]; then
  RESTART=/usr/local/bin/neoxify-xray-restart
else
  RESTART="systemctl restart xray"
fi
echo "To load it -- this drops every Xray connection on this node for a few seconds, so one node at a time and"
echo "when few are connected (established now: $(ss -Htn state established 2>/dev/null | wc -l) TCP sessions on the whole box):"
echo "  $RESTART"
echo "Undo before restarting: cp -a $BACKUP $CONFIG"
REMOTE

if [[ "$DEST" == "--local" ]]; then
  APPLY="$APPLY" bash -c "$REMOTE"
  exit $?
fi

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=20)
[[ -n "$KEY" ]] && SSH_OPTS+=(-i "$KEY")
# shellcheck disable=SC2029 # APPLY is meant to expand here, on this side.
ssh "${SSH_OPTS[@]}" "$DEST" "APPLY=$APPLY bash -s" <<<"$REMOTE"
