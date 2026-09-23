#!/usr/bin/env bash
# Builds, installs and launches the app on a real iPhone.
#
# The simulator cannot answer anything that matters about this client:
# Network Extensions do not run there and NEVPNManager cannot dial from
# one, so no tunnel has ever carried a packet. Everything this script
# exists for is on the far side of a USB cable.
#
# Needs, once, before this works at all:
#   - the phone plugged in, unlocked, and trusted ("Trust This Computer")
#   - Developer Mode on the phone: Settings > Privacy & Security >
#     Developer Mode, then a restart. The item only appears after a Mac
#     with Xcode has connected once, so it cannot be done in advance.
#   - an Apple ID added in Xcode > Settings > Accounts
#   - APPLE_DEVELOPMENT_TEAM set to the 10-character team id
#
# The App IDs com.neoxify.mobile and com.neoxify.mobile.tunnel must carry
# Network Extensions, Personal VPN and App Groups. Automatic signing
# creates them when the account has the rights; otherwise see
# docs/ios-submission.md, because an entitlement the profile does not
# grant fails at signing with an error that names the profile and not the
# entitlement.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${APPLE_DEVELOPMENT_TEAM:?set APPLE_DEVELOPMENT_TEAM to the 10-character team id}"

# Physical devices only. `devicectl list devices` includes every
# simulator, and installing to one of those would look like success and
# prove nothing -- which is the whole failure this script exists to
# avoid.
device=$(xcrun devicectl list devices --json-output /dev/stdout 2>/dev/null \
  | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for d in data.get("result", {}).get("devices", []):
    props = d.get("deviceProperties", {})
    hw = d.get("hardwareProperties", {})
    if hw.get("platform") != "iOS":
        continue
    # `reality` is the field that separates a phone from a simulator.
    # Filtering on platform alone picks up every booted simulator, which
    # would install happily and prove nothing -- the exact false success
    # this script exists to avoid.
    if hw.get("reality") != "physical":
        continue
    print(d.get("identifier", ""), props.get("name", "?"), sep="\t")
' | head -1)

if [ -z "$device" ]; then
  echo "No iPhone is connected." >&2
  echo "Plug it in, unlock it, and tap Trust This Computer. Then:" >&2
  echo "  xcrun devicectl list devices" >&2
  exit 1
fi
udid=${device%%$'\t'*}
name=${device##*$'\t'}
echo "device: $name"

# Through build-ios.sh, so a device build is the store flavour and is
# asserted to carry no purchase surface, exactly like every other build.
# `aarch64` is the device target; aarch64-sim is the simulator.
bash scripts/build-ios.sh -- --target aarch64

app=$(find src-tauri/gen/apple/build -maxdepth 3 -name "Neoxify.app" -not -path "*simulator*" 2>/dev/null | head -1)
[ -n "$app" ] || { echo "no device .app was produced" >&2; exit 1; }
echo "installing $app"

xcrun devicectl device install app --device "$udid" "$app"
xcrun devicectl device process launch --device "$udid" --start-stopped=false com.neoxify.mobile

cat <<'NEXT'

Launched. What to watch for, and what each failure looks like:

  Stream the tunnel's own log:
    xcrun devicectl device console --device <udid> | grep -i neoxify

  The extension being killed for memory does not look like a crash. It
  looks like the tunnel dropping with nothing logged after it -- the
  ~50MB ceiling is the first suspect, and the Xray engine is the thing
  most likely to cross it.

  A second VPN permission prompt part-way down the connect ladder means
  iOS treats consent as per-configuration rather than per-app. IKEv2
  lives in the personal-VPN slot; the other two do not.

  IKEv2 failing with an authentication error, rather than a timeout,
  points at the keychain: the VPN daemon reads the password out of
  process, and if it cannot reach the item the failure arrives as a
  rejected credential.

  Connects, then stalls on anything large: MTU. The tunnel interface and
  the engine's own tun have to agree, and they did not until today.
NEXT
