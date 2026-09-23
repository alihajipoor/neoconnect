#!/usr/bin/env bash
# Builds xray-core into an iOS framework for the VPN plugin.
#
# The sibling of build-xray-aar.sh, from the same Go source. gomobile
# bind takes the target as an argument, so the engine itself needs no
# port -- what differs is on the Swift side, where iOS hands a packet
# tunnel a NEPacketTunnelFlow rather than the file descriptor the
# Android path passes to Start().
#
# Run before `tauri ios build` on a clean checkout: the output is
# gitignored, so the Xcode build will not find it otherwise.
#
# Needs Go, gomobile, and a full Xcode -- not Command Line Tools.
# `gomobile bind -target=ios` refuses outright without it, which is the
# single thing that cannot be worked around on a CLT-only machine.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$here/plugins/vpn/xray"
out_dir="$here/plugins/vpn/tunnel/Frameworks"
framework="$out_dir/NeoxifyXray.xcframework"

# Same commit as build-xray-aar.sh and as plugins/vpn/xray/go.mod. The
# reasoning is written out in full over there: the gomobile binary and
# the x/mobile bind runtime linked into the library are two different
# things from the same module, and letting them drift once put 15.4 MB
# of uncompressed DWARF into an Android release. Bump all three together
# or none.
GOMOBILE_VERSION="v0.0.0-20260803200217-62cee1672c8e"

if ! xcodebuild -version >/dev/null 2>&1; then
  echo "error: gomobile bind -target=ios needs a full Xcode." >&2
  echo "       xcode-select currently points at: $(xcode-select -p 2>/dev/null || echo '<unset>')" >&2
  echo "       Install Xcode, then: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer" >&2
  exit 1
fi

export PATH="$PATH:$(go env GOPATH)/bin"

# Installed unconditionally, for the reason build-xray-aar.sh gives: a
# gomobile already on PATH is at whatever version that machine happens
# to have, and `go install` is a no-op from the module cache when it
# already matches.
echo "installing gomobile $GOMOBILE_VERSION..."
go install "golang.org/x/mobile/cmd/gomobile@$GOMOBILE_VERSION"
go install "golang.org/x/mobile/cmd/gobind@$GOMOBILE_VERSION"
gomobile init

mkdir -p "$out_dir"
cd "$src"

# Device arm64 plus both simulator slices. The simulator ones are not
# optional convenience: without them the extension cannot be run in the
# simulator at all, and a packet tunnel is awkward enough to debug on
# device that losing the simulator would cost more than the build time.
target="${XRAY_IOS_TARGET:-ios,iossimulator}"

echo "building $framework for $target..."
gomobile bind -target="$target" -o "$framework" .

echo "built:"
du -sh "$framework" | sed 's/^/  /'
