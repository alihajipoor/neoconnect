#!/usr/bin/env bash
# The only supported way to build the iOS app.
#
# iOS has exactly one distribution channel. Unlike Android, where the
# direct APK is downloaded from the website by people whose app stores
# are unreachable, there is no sideloading path here -- an iPhone build
# either goes through the App Store or it goes nowhere. So the store
# flavour is not a choice this script offers; it sets it and then proves
# it took, because a flag that has to be remembered is a flag that gets
# forgotten on the one release that matters.
#
# Everything after `--` is handed to `tauri ios build`, so:
#   scripts/build-ios.sh -- --target aarch64-sim --debug
set -euo pipefail
cd "$(dirname "$0")/.."

args=()
if [ "${1:-}" = "--" ]; then shift; args=("$@"); fi

# Tauri moves the archived .app to build/<target>/ with a plain
# rename and does not clear the destination first, so the *second* and
# every later build dies with "Directory not empty (os error 66)" --
# naming the archive path, which is not where the problem is. Clearing
# the previous output is the whole fix. Left in the script rather than
# reported as a quirk because it otherwise fails every rebuild on a
# developer machine and every CI rerun that restores a cache.
rm -rf src-tauri/gen/apple/build/*/Neoxify.app
rm -rf src-tauri/gen/apple/build/mobile_iOS.xcarchive

# The Rust staticlib for the configuration we are NOT building.
#
# Tauri copies libapp.a into Externals/<arch>/<configuration>/, and the
# Xcode target copies the whole Externals folder into the bundle. Once
# both a debug and a release copy exist for the same arch, two copy
# commands target the same path and the build fails outright:
#
#   error: Multiple commands produce '.../Neoxify.app/libapp.a'
#
# Nothing says the second one is stale, and the error names Xcode's
# DerivedData rather than the directory to clear. One debug build left
# behind by a manual xcodebuild invocation was enough to break every
# release build after it.
if printf '%s\n' "${args[@]:-}" | grep -q -- "--debug"; then
  stale=release
else
  stale=debug
fi
rm -rf src-tauri/gen/apple/Externals/*/"$stale"

# Regenerated every time, because the Xcode project is generated and a
# new Swift file added to the extension is otherwise simply not in it.
# That failure reads as "cannot find type X in scope", which looks like
# a typo rather than a stale project. Safe to repeat: the patcher strips
# its own previous edits before reapplying.
node scripts/add-tunnel-extension.mjs

# Before anything expensive: a manifest that is invalid XML is rejected
# only after a full build, a sign and an upload.
./scripts/assert-privacy-manifests.sh

# The app icon, applied after the project is generated.
#
# `tauri ios init` writes Tauri's own placeholder icons into
# gen/apple/Assets.xcassets and does NOT copy src-tauri/icons/ios, so
# the committed set never reaches the build on its own -- the phone shows
# Tauri's rings on the home screen. release-android.yml has had the
# equivalent step since android-v0.1.0 shipped exactly that way; iOS
# never got one.
#
# After the regeneration above, not before: that step rewrites the
# project and would undo this.
cp src-tauri/icons/ios/*.png src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/

export VITE_DISTRIBUTION=store
# bash 3.2 (what macOS ships) treats an empty array as unset under
# `set -u`, so the plain "${args[@]}" aborts a build invoked with no
# arguments at all -- which is every release build.
pnpm exec tauri ios build ${args[@]+"${args[@]}"}

# After, not before: `tauri ios build` runs `pnpm build` itself, so
# dist/ is only the store bundle once that has finished. Checking first
# would pass on whatever the previous build happened to leave behind.
node scripts/assert-store-bundle.mjs dist
