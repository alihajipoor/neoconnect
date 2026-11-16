#!/usr/bin/env bash
# Builds the .deb and .rpm: the Xray engine, the helper, then the app and
# its bundles.
#
# Modes are set explicitly first. The rpm bundler copies each file's mode
# from the build tree, so a machine whose umask is 0002 (an Ubuntu desktop
# user's default) produced root-owned, group-writable files in the package,
# the unit file among them.
set -euo pipefail
umask 022
cd "$(dirname "$0")/.."
chmod 0644 packaging/neoxify-helper.service packaging/neoxify.desktop src-tauri/icons/*.png
chmod 0755 packaging/deb/postinst packaging/deb/prerm packaging/deb/postrm

pnpm fetch-binaries
pnpm build:helper
chmod 0755 src-tauri/resources/xray src-tauri/resources/neoxify-helper
# A binary linked earlier under a looser umask keeps its mode; removing it
# makes cargo link it again, under this one.
rm -f "${CARGO_TARGET_DIR:-src-tauri/target}/release/neoxify"
pnpm tauri build --bundles deb,rpm "$@"
