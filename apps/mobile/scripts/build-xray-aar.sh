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

# Pinned, and pinned to the SAME x/mobile commit that go.mod already
# resolves for the bind runtime compiled into the AAR. Those are two
# different things that both come from x/mobile -- the `gomobile` binary
# that drives the build, and the `golang.org/x/mobile/bind` package
# linked into libgojni.so -- and only the second one was ever pinned.
#
# This was not hypothetical. android-v0.2.15 grew the direct APK by
# 15.4 MB against 0.2.14 with no repository change beyond version
# strings. Measured against the published artifacts, every byte of it
# was in lib/armeabi-v7a/libgojni.so, and every byte of THAT was DWARF
# that stopped being stored zlib-compressed: .text, .gopclntab and
# .noptrbss were byte-for-byte identical between the two builds, both
# reported go1.26.5 and clang/LLD 19.0.1, and the uncompressed sizes of
# all twelve .debug_* sections matched exactly. Same compiler, same
# code, same debug info -- only the link line differed, and the link
# line is gomobile's to construct.
#
# Keep this in step with the x/mobile version in
# plugins/vpn/xray/go.mod. If you bump one, bump the other.
GOMOBILE_VERSION="v0.0.0-20260803200217-62cee1672c8e"

export PATH="$PATH:$(go env GOPATH)/bin"
# Installed unconditionally rather than behind `command -v gomobile`.
# The old guard meant any machine with a gomobile already on PATH --
# every developer box that had ever built this once -- silently used
# that one instead, at whatever version it happened to be, while CI on a
# cold runner fetched @latest. Two builders, two compilers, no record of
# either. `go install` is a no-op from the module cache when the version
# already matches, so this costs nothing on a warm machine.
echo "installing gomobile $GOMOBILE_VERSION..."
go install "golang.org/x/mobile/cmd/gomobile@$GOMOBILE_VERSION"
go install "golang.org/x/mobile/cmd/gobind@$GOMOBILE_VERSION"
gomobile init

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

# -ldflags="-s -w" strips the Go symbol table and the DWARF debug info
# from libgojni.so. Measured on android-v0.2.15's own artifacts, that is
# 28.8 MB on armeabi-v7a and 13.5 MB on arm64 -- 42.3 MB of the 141 MB
# APK, being shipped to people downloading over censored, metered
# connections so that a debugger nobody attaches could have symbols.
#
# It does NOT cost us crash triage. Go stack traces are built from
# .gopclntab, which the runtime requires and the linker therefore always
# keeps; -s and -w do not touch it. A panic inside xray-core still
# arrives with fully named frames. DWARF only matters for attaching a
# native debugger to a running process, which has never been part of how
# anything here is diagnosed.
#
# -trimpath removes the absolute build paths baked into the binary. It
# is a reproducibility fix rather than a size one: without it the .so
# differs between two otherwise identical builds purely by the checkout
# directory, which makes "did this change?" unanswerable by comparison.
gomobile bind \
  -target="$target" \
  -androidapi 24 \
  -trimpath \
  -ldflags="-s -w" \
  -o "$aar" .

# Unpacked, because an Android *library* module cannot depend on a local
# .aar -- Gradle rejects it outright, since the nested .aar's classes and
# resources would not make it into the library's own .aar. Both pieces
# are supported separately: a plain .jar as a file dependency, and the
# native library through jniLibs, which a library module does package.
python "$here/scripts/unpack-xray-aar.py" "$aar" "$libs"

echo "built $aar"
