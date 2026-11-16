#!/usr/bin/env bash
# Puts the Xray engine the Linux package ships into src-tauri/resources.
#
# Only Xray is bundled. WireGuard is the kernel's and OpenVPN is the
# distribution's, both declared as package dependencies, so neither is
# fetched here.
#
# The same release the Windows client ships (see the Windows
# fetch-binaries.ps1 for why v26.6.27 and not an earlier one: the TUN
# inbound panic fixed in it). Pinned by hash as well as by tag, because a
# tag can be moved and a prerelease is the kind most likely to be. The hash
# is GitHub's digest of the release asset; a download that does not match
# stops the build rather than shipping something nobody checked.
set -euo pipefail

XRAY_VERSION="v26.6.27"
XRAY_SHA256="b3e5902d06d6282fe53cfa2fc426058b9aeaa429b2c812e20887cd47f26d08bf"
XRAY_URL="https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/Xray-linux-64.zip"

here="$(cd "$(dirname "$0")" && pwd)"
resources="$here/../src-tauri/resources"
mkdir -p "$resources"

# Kept when it is already the pinned build, so a rebuild needs no network.
# Checked by its recorded zip hash, since the binary alone has no digest
# published to compare against.
stamp="$resources/.xray-zip-sha256"
if [ -x "$resources/xray" ] && [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$XRAY_SHA256" ]; then
  echo "xray $XRAY_VERSION already in place"
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "Downloading $XRAY_URL ..."
curl -fsSL --retry 3 -o "$work/xray.zip" "$XRAY_URL"

actual="$(sha256sum "$work/xray.zip" | cut -d' ' -f1)"
if [ "$actual" != "$XRAY_SHA256" ]; then
  echo "Xray $XRAY_VERSION zip has SHA-256 $actual, expected $XRAY_SHA256 -- not using it." >&2
  exit 1
fi

# Only the binary: the client config uses no geo rules, so geoip.dat and
# geosite.dat would be dead weight in the package.
unzip -q -o "$work/xray.zip" xray -d "$work/extract"
install -m 0755 "$work/extract/xray" "$resources/xray"
echo "$XRAY_SHA256" > "$stamp"
echo "  xray $XRAY_VERSION -> src-tauri/resources/xray"
