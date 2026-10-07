#!/usr/bin/env bash
# Runs installer/lib/agent.sh's xray_test_config -- the `xray run -test`
# gate install_xray passes a new config through before restarting Xray --
# against a stand-in xray and systemctl.
#
# The stand-in fails a config with a tun inbound while "Xray is running",
# the way the real one did on ir1 on 2026-08-16 (docs/journal/windows.md):
# -test creates the tun device, and the running Xray already holds
# relay-tun, so it answers "device or resource busy" whatever the config
# says. Testing the whole file there refused every re-run of install_xray
# on a live relay. That is the behaviour being pinned down, not Xray's;
# nothing here runs a real xray.
#
# Needs jq, as the installer does.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/tmp"

cat >"$WORK/bin/systemctl" <<'SH'
#!/usr/bin/env bash
# `systemctl is-active --quiet xray` answers from FAKE_XRAY_RUNNING.
if [[ "${1:-}" == "is-active" ]]; then
  [[ "${FAKE_XRAY_RUNNING:-0}" == "1" ]]
  exit $?
fi
exit 0
SH

cat >"$WORK/bin/xray" <<'SH'
#!/usr/bin/env bash
# `xray run -test -config FILE`. Logs how many tun inbounds FILE has.
config=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-config" ]]; then
    config="$2"
    shift
  fi
  shift
done
tuns="$(jq '[.inbounds[]? | select(.protocol == "tun")] | length' "$config")"
echo "$tuns" >>"$FAKE_XRAY_LOG"
if [[ "$tuns" -gt 0 && "${FAKE_XRAY_RUNNING:-0}" == "1" ]]; then
  echo "Failed to start: device or resource busy"
  exit 23
fi
if jq -e '[.inbounds[]? | select(.tag == "broken")] | length > 0' "$config" >/dev/null; then
  echo "Failed to build inbound: broken"
  exit 23
fi
echo "Configuration OK."
SH
chmod +x "$WORK/bin/systemctl" "$WORK/bin/xray"

export PATH="$WORK/bin:$PATH"
export XRAY_BIN="$WORK/bin/xray"
export FAKE_XRAY_LOG="$WORK/xray.log"
export TMPDIR="$WORK/tmp"

# shellcheck source=../installer/lib/agent.sh
source "$ROOT/installer/lib/agent.sh"
# agent.sh sets an EXIT trap of its own, for a file under $TMPDIR; this
# one, set again, covers it.
trap 'rm -rf "$WORK"' EXIT

# The relay template as install_xray renders it, with placeholder values.
relay="$WORK/relay.json"
sed -e 's/__[A-Z_]*PORT__/1000/g' -e 's/__[A-Z0-9_]*__/x/g' \
  "$ROOT/installer/assets/xray-relay-config.json.template" >"$relay"
plain="$WORK/plain.json"
jq '.inbounds |= map(select(.protocol != "tun"))' "$relay" >"$plain"
broken="$WORK/broken.json"
jq '.inbounds += [{"tag": "broken", "protocol": "vless", "port": 1}]' "$relay" >"$broken"

failures=0
fail() {
  echo "FAIL: $*"
  failures=$((failures + 1))
}

# run_gate <running 0|1> <config>: sets rc, out and tested (the tun
# counts of what the stand-in was given).
run_gate() {
  : >"$FAKE_XRAY_LOG"
  rc=0
  out="$(
    export FAKE_XRAY_RUNNING="$1"
    xray_test_config "$2" 2>&1
  )" || rc=$?
  tested="$(sort -u "$FAKE_XRAY_LOG" | tr '\n' ' ')"
}

before="$(sha256sum "$relay")"

# A good relay config, Xray running: passes, tested without the tun
# inbound, the file itself untouched and no copy left behind.
run_gate 1 "$relay"
[[ "$rc" == 0 ]] || fail "a good relay config was refused while Xray runs (rc=$rc): $out"
[[ "$tested" == "0 " ]] || fail "expected only a copy without the tun inbound to be tested, tun counts: $tested"
[[ "$(sha256sum "$relay")" == "$before" ]] || fail "the config under test was modified"
[[ -z "$(ls -A "$TMPDIR")" ]] || fail "the tested copy was left behind: $(ls -A "$TMPDIR")"

# A broken relay config, Xray running: still refused, with Xray's reason.
run_gate 1 "$broken"
[[ "$rc" != 0 ]] || fail "a broken relay config passed while Xray runs"
[[ "$out" == *"Failed to build inbound: broken"* ]] || fail "Xray's reason was not shown: $out"
[[ -z "$(ls -A "$TMPDIR")" ]] || fail "the tested copy was left behind after a refusal"

# Xray stopped: nothing holds the device, so the whole file is tested.
run_gate 0 "$relay"
[[ "$rc" == 0 ]] || fail "a good relay config was refused with Xray stopped (rc=$rc): $out"
[[ "$tested" == "1 " ]] || fail "expected the whole file, tun inbound included, tun counts: $tested"
run_gate 0 "$broken"
[[ "$rc" != 0 ]] || fail "a broken relay config passed with Xray stopped"

# Not a relay, Xray running: the whole file, as before.
run_gate 1 "$plain"
[[ "$rc" == 0 ]] || fail "a good non-relay config was refused (rc=$rc): $out"
[[ "$tested" == "0 " ]] || fail "unexpected tun counts for a non-relay config: $tested"

if [[ "$failures" -gt 0 ]]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "xray_test_config: all checks passed"
