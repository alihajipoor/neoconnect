#!/usr/bin/env bash
# Runs installer/maintenance/xray-ipv4-only.sh (--local) against configs
# rendered from the installer's templates, with stand-ins for xray and
# systemctl. Pins down:
#   - a node as it was before 2026-10-11 (the template minus the IPv4-only
#     pieces) comes out equal to what the template now writes for a new
#     node, comment texts included -- install_xray compares rules by
#     value, so a drifted comment would read as a rule "NOT carried over";
#   - a second run changes nothing, and a node already on the template
#     changes nothing;
#   - the relay layout gets the IPv4-only pieces and never uot-direct;
#   - it refuses, writing nothing, what it does not understand, and an
#     exit node whose running Xray holds relay routes (uot-direct would
#     sit in front of them and send relayed UDP out of the entry);
#   - --apply backs up and writes but never restarts Xray.
# Nothing here runs a real xray. Needs python3 (as the script does) and jq.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/installer/maintenance/xray-ipv4-only.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

cat >"$WORK/bin/systemctl" <<'SH'
#!/usr/bin/env bash
echo "$*" >>"$FAKE_SYSTEMCTL_LOG"
[[ "${1:-}" == "is-active" ]] && exit 3
exit 0
SH
cat >"$WORK/bin/xray" <<'SH'
#!/usr/bin/env bash
# `xray run -test -config FILE`: refuses a config with an inbound tagged
# "broken". `xray api lsrules|lso`: answers from FAKE_RUNTIME_DIR.
if [[ "${1:-}" == "api" ]]; then
  [[ -n "${FAKE_RUNTIME_DIR:-}" ]] || { echo "connection refused" >&2; exit 1; }
  case "${2:-}" in
    lsrules) cat "$FAKE_RUNTIME_DIR/rules.json" ;;
    lso) cat "$FAKE_RUNTIME_DIR/outs.json" ;;
    *) exit 1 ;;
  esac
  exit 0
fi
config=""
while [[ $# -gt 0 ]]; do
  [[ "$1" == "-config" ]] && { config="$2"; shift; }
  shift
done
if jq -e '[.inbounds[]? | select(.tag == "broken")] | length > 0' "$config" >/dev/null; then
  echo "Failed to build inbound: broken"
  exit 23
fi
echo "Configuration OK."
SH
chmod +x "$WORK/bin/systemctl" "$WORK/bin/xray"
export PATH="$WORK/bin:$PATH"
export XRAY="$WORK/bin/xray"
export FAKE_SYSTEMCTL_LOG="$WORK/systemctl.log"
: >"$FAKE_SYSTEMCTL_LOG"

render() { sed -e 's/__[A-Z_]*PORT__/1000/g' -e 's/__[A-Z0-9_]*__/x/g' "$1"; }
render "$ROOT/installer/assets/xray-config.json.template" >"$WORK/exit-new.json"
render "$ROOT/installer/assets/xray-relay-config.json.template" >"$WORK/relay-new.json"

# A node as it was before 2026-10-11: the template without the pieces.
strip_pieces() {
  python3 - "$1" "$2" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))
c.pop("dns", None)
c["routing"].pop("//ipv4-only", None)
c["outbounds"] = [o for o in c["outbounds"] if o.get("tag") != "uot-direct"]
for o in c["outbounds"]:
    if o.get("tag") == "direct":
        o.pop("settings", None)
c["routing"]["rules"] = [r for r in c["routing"]["rules"] if r.get("ruleTag") not in ("uot-direct", "block-ipv6-egress")]
json.dump(c, open(sys.argv[2], "w"), indent=2)
PY
}
strip_pieces "$WORK/exit-new.json" "$WORK/exit-old.json"
strip_pieces "$WORK/relay-new.json" "$WORK/relay-old.json"

# Equal as Xray reads them; the template's routing "//ipv4-only" note is
# the one thing the script does not write.
same() {
  python3 - "$1" "$2" <<'PY'
import json, sys
a, b = (json.load(open(p)) for p in sys.argv[1:3])
for c in (a, b):
    c.get("routing", {}).pop("//ipv4-only", None)
sys.exit(0 if a == b else 1)
PY
}

# A running Xray holding only the file's own rules, or relay routes too.
mkdir -p "$WORK/rt-plain" "$WORK/rt-routes"
echo '{"rules":[{"tag":"api"},{"tag":"block"}]}' >"$WORK/rt-plain/rules.json"
echo '{"outbounds":[{"tag":"direct"},{"tag":"block"}]}' >"$WORK/rt-plain/outs.json"
echo '{"rules":[{"tag":"api"},{"tag":"block"},{"ruleTag":"route-7-out","tag":"route-7-out"}]}' >"$WORK/rt-routes/rules.json"
echo '{"outbounds":[{"tag":"direct"},{"tag":"block"},{"tag":"route-7-out"}]}' >"$WORK/rt-routes/outs.json"

failures=0
fail() {
  echo "FAIL: $*"
  failures=$((failures + 1))
}

# run <config> [--apply]: sets rc and out.
run() {
  rc=0
  out="$(CONFIG="$1" "$SCRIPT" --local "${@:2}" 2>&1)" || rc=$?
}

export FAKE_RUNTIME_DIR="$WORK/rt-plain"

# An exit node from before: dry run writes nothing; --apply brings it to
# the template.
cp "$WORK/exit-old.json" "$WORK/exit.json"
before="$(sha256sum <"$WORK/exit.json")"
run "$WORK/exit.json"
[[ "$rc" == 0 ]] || fail "dry run on an old exit config (rc=$rc): $out"
[[ "$out" == *"dry run: nothing written"* ]] || fail "dry run did not say so: $out"
[[ "$(sha256sum <"$WORK/exit.json")" == "$before" ]] || fail "a dry run modified the config"
run "$WORK/exit.json" --apply
[[ "$rc" == 0 ]] || fail "--apply on an old exit config (rc=$rc): $out"
same "$WORK/exit.json" "$WORK/exit-new.json" || fail "the patched exit config differs from what the template writes"
ls "$WORK"/exit.json.bak-* >/dev/null 2>&1 || fail "no backup was written"
cmp -s "$(ls "$WORK"/exit.json.bak-* | head -1)" "$WORK/exit-old.json" || fail "the backup is not the original"
[[ "$out" == *"systemctl restart xray"* || "$out" == *"neoxify-xray-restart"* ]] || fail "the restart command was not printed: $out"
grep -q restart "$FAKE_SYSTEMCTL_LOG" && fail "xray was restarted: $(cat "$FAKE_SYSTEMCTL_LOG")"
[[ "$(jq -r '.routing.rules | map(.ruleTag // .outboundTag) | join(",")' "$WORK/exit.json")" == "api,uot-direct,block,block-ipv6-egress" ]] ||
  fail "unexpected rule order: $(jq -c '.routing.rules | map(.ruleTag // .outboundTag)' "$WORK/exit.json")"

# Idempotent: a second run, and a node on the template, change nothing.
after="$(sha256sum <"$WORK/exit.json")"
run "$WORK/exit.json" --apply
[[ "$rc" == 0 && "$out" == *"Nothing to do."* ]] || fail "second run was not a no-op (rc=$rc): $out"
[[ "$(sha256sum <"$WORK/exit.json")" == "$after" ]] || fail "a second run modified the config"
cp "$WORK/exit-new.json" "$WORK/fresh.json"
run "$WORK/fresh.json"
[[ "$rc" == 0 && "$out" == *"Nothing to do."* ]] || fail "a node on the new template was not left alone (rc=$rc): $out"

# A relay: the IPv4-only pieces, no uot-direct, and no runtime check (its
# default is block, so nothing here can send relayed traffic out).
cp "$WORK/relay-old.json" "$WORK/relay.json"
FAKE_RUNTIME_DIR="" run "$WORK/relay.json" --apply
[[ "$rc" == 0 ]] || fail "--apply on an old relay config (rc=$rc): $out"
same "$WORK/relay.json" "$WORK/relay-new.json" || fail "the patched relay config differs from what the relay template writes"
jq -e '[.outbounds[] | select(.tag == "uot-direct")] + [.routing.rules[] | select(.ruleTag == "uot-direct")] | length == 0' "$WORK/relay.json" >/dev/null ||
  fail "a relay was given uot-direct"

# Refusals: exit 2 and the file untouched.
refused() {  # <label> <config> [expected text]
  local sum
  sum="$(sha256sum <"$2")"
  run "$2" --apply
  [[ "$rc" == 2 ]] || fail "$1: expected a refusal (exit 2), got rc=$rc: $out"
  [[ -z "${3:-}" || "$out" == *"$3"* ]] || fail "$1: the reason was not given: $out"
  [[ "$(sha256sum <"$2")" == "$sum" ]] || fail "$1: the config was modified"
}
cp "$WORK/exit-old.json" "$WORK/r1.json"
FAKE_RUNTIME_DIR="$WORK/rt-routes" refused "exit node holding relay routes" "$WORK/r1.json" "route-7-out"
FAKE_RUNTIME_DIR="" refused "exit node whose Xray API cannot be read" "$WORK/r1.json" "is xray running"
jq '.routing.domainStrategy = "AsIs"' "$WORK/exit-old.json" >"$WORK/r2.json"
refused "routing not IPIfNonMatch" "$WORK/r2.json" "block-private-egress.sh"
jq '.routing.rules |= map(select(.ip == null or (.ip | index("::1/128")) == null))' "$WORK/exit-old.json" >"$WORK/r3.json"
refused "private-range rule missing" "$WORK/r3.json" "private-range"
jq '.dns = {"queryStrategy": "UseIP"}' "$WORK/exit-old.json" >"$WORK/r4.json"
refused "dns.queryStrategy UseIP" "$WORK/r4.json" "queryStrategy"
jq '(.outbounds[] | select(.tag == "direct")).settings = {"domainStrategy": "UseIP"}' "$WORK/exit-old.json" >"$WORK/r5.json"
refused "freedom domainStrategy UseIP" "$WORK/r5.json" "domainStrategy"
jq '.routing.rules += [{"type": "field", "port": "25", "outboundTag": "block"}]' "$WORK/exit-old.json" >"$WORK/r6.json"
refused "an unknown extra rule" "$WORK/r6.json" "does not know"
jq '.outbounds += [{"tag": "uot-direct", "protocol": "freedom"}]' "$WORK/relay-old.json" >"$WORK/r7.json"
refused "a relay carrying uot-direct" "$WORK/r7.json" "relay"
printf '{"routing": {}, "routing": {}}' >"$WORK/r8.json"
refused "duplicate keys" "$WORK/r8.json" "duplicate"

# Xray refusing the result: nothing written.
jq '.inbounds += [{"tag": "broken", "protocol": "vless", "port": 1}]' "$WORK/exit-old.json" >"$WORK/r9.json"
sum="$(sha256sum <"$WORK/r9.json")"
run "$WORK/r9.json" --apply
[[ "$rc" != 0 && "$out" == *"nothing written"* ]] || fail "a config Xray refuses was not stopped (rc=$rc): $out"
[[ "$(sha256sum <"$WORK/r9.json")" == "$sum" ]] || fail "a config Xray refuses was written"

if [[ "$failures" -gt 0 ]]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "xray-ipv4-only.sh: all checks passed"
