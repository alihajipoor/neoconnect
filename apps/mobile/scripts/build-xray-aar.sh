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

# arm64 only by default, deliberately: it is every Android device sold
# for years, and each extra ABI adds ~46MB of compiled Go to the APK for
# hardware nobody is running this on.
#
# XRAY_AAR_TARGET overrides it. Originally for one reason -- an x86_64
# emulator, where without a matching build the APK has no libgojni.so,
# the class that loads it throws UnsatisfiedLinkError, and the app dies
# on the first Xray connect. That looks exactly like a real fault and is
# not one, which cost a full diagnosis cycle to tell apart.
#
# The release workflow now sets it too, to `android/arm64,android/arm`,
# because the Play bundle carries 32-bit as well. Play splits an AAB per
# ABI on delivery, so that costs a customer nothing; the universal APK
# has no such trick and pays the ~46MB in full, which is the tradeoff to
# revisit if the direct download gets uncomfortably large. Do not
# "simplify" this back to arm64 without checking the AAB still builds
# both -- a 64-bit-only bundle silently excludes every 32-bit handset
# from the store listing entirely.
target="${XRAY_AAR_TARGET:-android/arm64}"
echo "Building the Xray engine for $target"
gomobile bind -target="$target" -androidapi 24 -o "$aar" .

# Unpacked, because an Android *library* module cannot depend on a local
# .aar -- Gradle rejects it outright, since the nested .aar's classes and
# resources would not make it into the library's own .aar. Both pieces
# are supported separately: a plain .jar as a file dependency, and the
# native library through jniLibs, which a library module does package.
python "$here/scripts/unpack-xray-aar.py" "$aar" "$libs"

echo "built $aar"
