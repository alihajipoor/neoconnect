#!/usr/bin/env bash
# Drives the app on a connected iPhone, reading a script on stdin.
#
#   printf 'text\nscreenshot now\n' | scripts/drive-device.sh
#
# Verbs: tap <label>, waitfor <label> [secs], wait <secs>,
#        assert <label>, text, dump, screenshot [name]
#
# XCUITest is the only way to touch a physical device -- devicectl
# installs, launches and screenshots but has no tap API, because Apple
# does not expose one. And the tunnel cannot be exercised anywhere but
# a device: the simulator does not run a Network Extension.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${APPLE_DEVELOPMENT_TEAM:?set APPLE_DEVELOPMENT_TEAM}"

udid=$(xcrun devicectl list devices --json-output /dev/stdout 2>/dev/null | python3 -c '
import json, sys
try: data = json.load(sys.stdin)
except Exception: sys.exit(0)
for d in data.get("result", {}).get("devices", []):
    hw = d.get("hardwareProperties", {})
    if hw.get("platform") == "iOS" and hw.get("reality") != "simulated":
        print(hw.get("udid") or d.get("identifier", "")); break
')
[ -n "$udid" ] || { echo "no iPhone connected" >&2; exit 1; }

script=$(cat)
echo "device: $udid"

# TEST_RUNNER_ is how xcodebuild passes an environment variable through
# to the test runner process; setting NEOXIFY_SCRIPT directly here would
# reach xcodebuild and stop there.
xcodebuild test \
  -project src-tauri/gen/apple/mobile.xcodeproj \
  -scheme NeoxifyUITests \
  -destination "platform=iOS,id=$udid" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$APPLE_DEVELOPMENT_TEAM" \
  TEST_RUNNER_NEOXIFY_SCRIPT="$script" 2>&1 \
  | grep -E "NEOXIFY-|Test Case|error:|\*\* TEST" || true
