#!/usr/bin/env bash
# The 2026-11-13 build (finland-4) came up with Xray dead from the install
# on: `xray run -test`, run as root, created /var/log/xray/access.log
# root:root 600, and Xray, as nobody, could not open it. Its IKEv2 loader
# unit was enabled and never started. This pins down the installer's
# answers, against stand-ins (no root, no real Xray or systemd):
#
#   - xray_prepare_logs creates the log files the config names, as the
#     user Xray runs as, and hands back any file another user made;
#   - install_xray calls it after the config test and before the
#     restart, and checks Xray is running after the restart;
#   - xray_started_ok fails, with Xray's last words, when it is not;
#   - the IKEv2 loader unit is started, not only enabled.
#
# Needs jq, as the installer does.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/tmp" "$WORK/log"

# install, chown and chmod as stand-ins: they record what they were asked
# (a plain user cannot hand a file to nobody), and install makes the file.
cat >"$WORK/bin/install" <<'SH'
#!/usr/bin/env bash
echo "install $*" >>"$FAKE_CALLS"
dst="${*: -1}"
: >"$dst"
SH
cat >"$WORK/bin/chown" <<'SH'
#!/usr/bin/env bash
echo "chown $*" >>"$FAKE_CALLS"
SH
cat >"$WORK/bin/chmod" <<'SH'
#!/usr/bin/env bash
echo "chmod $*" >>"$FAKE_CALLS"
SH
cat >"$WORK/bin/systemctl" <<'SH'
#!/usr/bin/env bash
[[ "${1:-}" == is-active ]] && { echo "${FAKE_XRAY_STATE:-active}"; [[ "${FAKE_XRAY_STATE:-active}" == active ]]; exit; }
exit 0
SH
cat >"$WORK/bin/journalctl" <<'SH'
#!/usr/bin/env bash
echo "Failed to start: failed to initialize access logger > open /var/log/xray/access.log: permission denied"
SH
cat >"$WORK/bin/sleep" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$WORK"/bin/*

export PATH="$WORK/bin:$PATH" TMPDIR="$WORK/tmp" FAKE_CALLS="$WORK/calls"
export XRAY_LOG_DIR="$WORK/log" XRAY_CONFIG_PATH="$WORK/config.json"
jq -n --arg a "$WORK/log/access.log" '{log: {loglevel: "warning", access: $a}, inbounds: []}' >"$XRAY_CONFIG_PATH"

# shellcheck source=../installer/lib/agent.sh
source "$ROOT/installer/lib/agent.sh"
trap 'rm -rf "$WORK"' EXIT

failures=0
fail() {
  echo "FAIL: $*"
  failures=$((failures + 1))
}

# 1. No log file yet: it is created, as nobody, mode 600.
: >"$FAKE_CALLS"
xray_prepare_logs
grep -qx "install -m 600 -o nobody -g nogroup /dev/null $WORK/log/access.log" "$FAKE_CALLS" ||
  fail "the access log was not created as nobody: $(cat "$FAKE_CALLS")"
[[ -e "$WORK/log/access.log" ]] || fail "the access log does not exist after xray_prepare_logs"

# 2. A file is already there (the root-run test made it): it is handed to
#    nobody, and not created a second time.
: >"$FAKE_CALLS"
xray_prepare_logs
grep -q "^install " "$FAKE_CALLS" && fail "an existing log file was created again"
grep -q "^chown nobody:nogroup $WORK/log/access.log" "$FAKE_CALLS" ||
  fail "an existing log file was not handed back to nobody: $(cat "$FAKE_CALLS")"

# 3. A log path outside the log directory is never created.
jq -n '{log: {access: "/etc/passwd"}}' >"$XRAY_CONFIG_PATH"
: >"$FAKE_CALLS"
xray_prepare_logs
grep -q "^install .*/etc/passwd" "$FAKE_CALLS" && fail "a log path outside the log directory was created"

# 4. xray_started_ok: passes while Xray runs, fails with its last words when not.
FAKE_XRAY_STATE=active xray_started_ok || fail "xray_started_ok failed with Xray running"
out="$(FAKE_XRAY_STATE=failed xray_started_ok 2>&1)" && fail "xray_started_ok passed with Xray not running"
[[ "$out" == *"permission denied"* ]] || fail "Xray's reason was not shown: $out"

# 5. Order inside install_xray: config test, then the logs handed back,
#    then the restart, then the running check.
body="$(declare -f install_xray)"
t=$(grep -n 'xray_test_config "$config_path"' <<<"$body" | head -1 | cut -d: -f1)
p=$(awk -v t="$t" 'NR > t && /xray_prepare_logs/ {print NR; exit}' <<<"$body")
r=$(awk -v t="${p:-0}" 'NR > t && /systemctl restart xray|neoxify-xray-restart/ {print NR; exit}' <<<"$body")
s=$(awk -v t="${r:-0}" 'NR > t && /xray_started_ok/ {print NR; exit}' <<<"$body")
[[ -n "$t" && -n "$p" && -n "$r" && -n "$s" ]] ||
  fail "install_xray must test the config, hand the logs back, restart, then check Xray runs (lines: test=$t logs=$p restart=$r check=$s)"

# 6. The IKEv2 loader is started, not only enabled.
grep -q 'systemctl restart neoxify-swanctl-load' "$ROOT/installer/lib/agent.sh" ||
  fail "the IKEv2 loader unit is enabled but never started"

if [[ $failures -gt 0 ]]; then
  echo "$failures failure(s)"
  exit 1
fi
echo "ok: Xray's log files are nobody's before it starts, its start is checked, and the IKEv2 loader is started"
