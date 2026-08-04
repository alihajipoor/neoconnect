#!/usr/bin/env bash
# Builds xray-core into an Android library for the VPN plugin.
#
# Run before `tauri android build` on a clean checkout -- the output is
# gitignored, so the Gradle build will not find it otherwise. The release
# workflow runs this too, which is the point: a build step nobody
# exercises is a build step that is quietly broken.
#
# Needs Go, the Android NDK, and gomobile. The first run installs
# gomobile and takes several minutes; later ones are cached by Go.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$here/plugins/vpn/xray"
libs="$here/plugins/vpn/android/libs"
aar="$libs/neoxify-xray.aar"

: "${ANDROID_NDK_HOME:?set ANDROID_NDK_HOME to the NDK directory}"

export PATH="$PATH:$(go env GOPATH)/bin"
if ! command -v gomobile >/dev/null 2>&1; then
  echo "installing gomobile..."
  go install golang.org/x/mobile/cmd/gomobile@latest
  go install golang.org/x/mobile/cmd/gobind@latest
  gomobile init
fi

mkdir -p "$libs"
cd "$src"

# arm64 only, deliberately. It is every Android device sold for years,
# and each extra ABI adds ~46MB of compiled Go to the APK for hardware
# nobody is running this on.
gomobile bind -target=android/arm64 -androidapi 24 -o "$aar" .

# Unpacked, because an Android *library* module cannot depend on a local
# .aar -- Gradle rejects it outright, since the nested .aar's classes and
# resources would not make it into the library's own .aar. Both pieces
# are supported separately: a plain .jar as a file dependency, and the
# native library through jniLibs, which a library module does package.
python "$here/scripts/unpack-xray-aar.py" "$aar" "$libs"

echo "built $aar"
