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
#
# A submission to App Store Connect also needs its signing and its
# numbers, all four together:
#   NEOXIFY_IOS_SIGNING=appstore APPLE_DEVELOPMENT_TEAM=<team id> \
#   NEOXIFY_IOS_MARKETING_VERSION=1.0.0 NEOXIFY_IOS_BUILD_NUMBER=<n> \
#   scripts/build-ios.sh
#
# NEOXIFY_IOS_SIGNING=cloud is the same store build for a machine with no
# certificate and no profile on it -- .github/workflows/release-ios.yml.
# It also needs an App Store Connect API key, under the names Tauri reads:
#   APPLE_API_KEY=<key id> APPLE_API_ISSUER=<issuer id>
#   APPLE_API_KEY_PATH=<path to AuthKey_<key id>.p8>
# See docs/ios-ci-release.md.
set -euo pipefail
cd "$(dirname "$0")/.."

args=()
if [ "${1:-}" = "--" ]; then shift; args=("$@"); fi

# A store build, checked before anything expensive.
#
# The numbers are the App Store's own, not tauri.conf.json's: its 1.0.x
# version record and a build number above every one already uploaded
# (1.0.0 (6) on 2026-09-30, from mobile 0.2.21). Uploading an IPA that
# carries Tauri's 0.2.x after that is refused, and the version is easy to
# forget because nothing else in a release needs it -- so a store build
# without both stops here rather than after an archive and an export.
# Record which mobile version each upload carries in docs/journal/log.md.
store=""
cloud=""
if [ "${NEOXIFY_IOS_SIGNING:-}" = "appstore" ] || [ "${NEOXIFY_IOS_SIGNING:-}" = "cloud" ]; then
  : "${APPLE_DEVELOPMENT_TEAM:?a store build needs APPLE_DEVELOPMENT_TEAM}"
  : "${NEOXIFY_IOS_MARKETING_VERSION:?a store build needs NEOXIFY_IOS_MARKETING_VERSION, the App Store version record (e.g. 1.0.0)}"
  : "${NEOXIFY_IOS_BUILD_NUMBER:?a store build needs NEOXIFY_IOS_BUILD_NUMBER, above every build already uploaded}"
  store=1
fi
if [ "${NEOXIFY_IOS_SIGNING:-}" = "cloud" ]; then
  : "${APPLE_API_KEY:?a cloud-signed build needs APPLE_API_KEY, the App Store Connect key id}"
  : "${APPLE_API_ISSUER:?a cloud-signed build needs APPLE_API_ISSUER, the App Store Connect issuer id}"
  : "${APPLE_API_KEY_PATH:?a cloud-signed build needs APPLE_API_KEY_PATH, the .p8 file}"
  # Absolute, because this script has already changed directory and
  # Tauri and xcodebuild each resolve a relative path from somewhere else.
  case "$APPLE_API_KEY_PATH" in
    /*) ;;
    *) echo "error: APPLE_API_KEY_PATH must be an absolute path" >&2; exit 1 ;;
  esac
  if [ ! -s "$APPLE_API_KEY_PATH" ]; then
    echo "error: APPLE_API_KEY_PATH does not name a readable key file" >&2
    exit 1
  fi
  cloud=1
fi

# A cloud build's archive is unsigned: with an API key in the environment,
# Tauri archives with CODE_SIGNING_ALLOWED=NO and CODE_SIGN_ENTITLEMENTS=""
# and leaves the signing to the export. But `xcodebuild -exportArchive`
# keeps only the entitlements it finds in an existing signature, so an
# IPA exported straight from that archive carries the profiles' defaults
# and none of ours -- no packet-tunnel-provider, no app group. It would
# sign, upload and install, and never start a tunnel.
#
# So each executable that needs entitlements is first signed with them
# under a throwaway self-signed certificate, the extension before the app
# that contains it, and the export replaces every one of those signatures
# with Apple's. This is what Tauri itself does before its own export,
# except that @tauri-apps/cli 2.11.4 signs only the app and drops the
# extension's entitlements -- fixed upstream in tauri-apps/tauri#16312
# (2026-11-18), which is in no release this repo uses.
#
# For a throwaway machine. A failure part-way leaves the temporary
# keychain in the user's search list, which on a CI runner does not matter.
placeholder_sign() {
  local app="$1" apple="$2"
  local work pw sha kc legacy="" line
  work=$(mktemp -d)
  pw=$(/usr/bin/openssl rand -hex 16)
  kc="$work/placeholder.keychain-db"
  cat > "$work/req.cnf" <<'EOF'
[req]
distinguished_name = dn
prompt = no
x509_extensions = ext
[dn]
CN = Neoxify placeholder signature
[ext]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF
  /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 1 -config "$work/req.cnf" \
    -keyout "$work/key.pem" -out "$work/cert.pem" 2>/dev/null
  # OpenSSL 3 writes a PKCS#12 (AES, PBKDF2) that `security import` may
  # not read, so it is told to use 3DES and SHA-1 -- from its default
  # provider, unlike -legacy, which needs a module that is not always
  # installed. LibreSSL, which macOS ships as /usr/bin/openssl, writes
  # that format by default and does not take every one of those flags.
  case "$(/usr/bin/openssl version)" in
    *LibreSSL*) ;;
    *) legacy="-keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1" ;;
  esac
  /usr/bin/openssl pkcs12 -export $legacy -inkey "$work/key.pem" -in "$work/cert.pem" \
    -out "$work/id.p12" -passout "pass:$pw"
  sha=$(/usr/bin/openssl x509 -in "$work/cert.pem" -noout -fingerprint -sha1 | sed 's/.*=//; s/://g')

  local searched=()
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line#\"}"
    line="${line%\"}"
    if [ -n "$line" ]; then searched+=("$line"); fi
  done < <(security list-keychains -d user)

  security create-keychain -p "$pw" "$kc"
  security set-keychain-settings -t 3600 -u "$kc"
  security unlock-keychain -p "$pw" "$kc"
  security import "$work/id.p12" -k "$kc" -P "$pw" -T /usr/bin/codesign >/dev/null
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$pw" "$kc" >/dev/null
  security list-keychains -d user -s ${searched[@]+"${searched[@]}"} "$kc"

  local bundle entitlements exe
  for bundle in "$app/PlugIns/NeoxifyTunnel.appex" "$app"; do
    case "$bundle" in
      *.appex) entitlements="$apple/NeoxifyTunnel.entitlements" ;;
      *) entitlements="$apple/mobile_iOS/mobile_iOS.entitlements" ;;
    esac
    if ! grep -q "packet-tunnel-provider" "$entitlements" 2>/dev/null; then
      echo "error: $entitlements is missing or carries no packet-tunnel-provider" >&2
      exit 1
    fi
    exe="$bundle/$(plutil -extract CFBundleExecutable raw "$bundle/Info.plist")"
    codesign --force --timestamp=none --sign "$sha" --keychain "$kc" \
      --entitlements "$entitlements" "$exe"
  done

  security list-keychains -d user -s ${searched[@]+"${searched[@]}"}
  security delete-keychain "$kc"
  rm -rf "$work"
}

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
#
# `stale` is also read below: "debug" here means this is a release build.
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

# A release build must carry the endpoint seed, as the Android and
# Windows release workflows already insist. `tauri ios build` runs
# `pnpm build`, whose prebuild fetches the seed; without this set, a
# failed fetch there quietly bakes in the placeholder, and the IPA tries
# only the compiled-in addresses -- on a domain that is DNS-poisoned and
# SNI-blocked in Iran, with the HTTP permission refusing every other
# host. Nothing about such a build looks wrong until it is in a
# customer's hands.
#
# Release only: a --debug simulator build (CI's, or one made offline)
# has no customer. Set NEOXIFY_REQUIRE_SEED=0 to override deliberately.
if [ "$stale" = "debug" ]; then
  export NEOXIFY_REQUIRE_SEED="${NEOXIFY_REQUIRE_SEED:-1}"
fi

# bash 3.2 (what macOS ships) treats an empty array as unset under
# `set -u`, so the plain "${args[@]}" aborts a build invoked with no
# arguments at all -- which is every release build.
if [ -n "$store" ]; then
  # Archive only. Tauri's export cannot sign this app -- see
  # ExportOptions-appstore.plist in add-tunnel-extension.mjs -- and fails
  # with EXPORT FAILED after a perfectly good archive.
  pnpm exec tauri ios build --archive-only ${args[@]+"${args[@]}"}
else
  pnpm exec tauri ios build ${args[@]+"${args[@]}"}
fi

if [ -n "$store" ]; then
  apple=src-tauri/gen/apple
  archive=$apple/build/mobile_iOS.xcarchive
  out=$apple/build/arm64
  archived_app="$archive/Products/Applications/Neoxify.app"
  rm -f "$out/Neoxify.ipa"

  # A cloud build lets the export talk to Apple: create or refresh the two
  # App Store profiles, and sign with the team's cloud-held distribution
  # certificate. Both need the API key, and an Admin one (see
  # docs/ios-ci-release.md).
  export_auth=()
  if [ -n "$cloud" ]; then
    placeholder_sign "$archived_app" "$apple"
    export_auth=(-allowProvisioningUpdates
      -authenticationKeyPath "$APPLE_API_KEY_PATH"
      -authenticationKeyID "$APPLE_API_KEY"
      -authenticationKeyIssuerID "$APPLE_API_ISSUER")
  fi
  xcodebuild -exportArchive -archivePath "$archive" \
    -exportOptionsPlist "$apple/ExportOptions-appstore.plist" -exportPath "$out" \
    ${export_auth[@]+"${export_auth[@]}"}

  # Proof it took, read back from the products rather than the inputs:
  # the numbers on both bundles in the IPA, and signatures that verify on
  # the archive as well as the IPA. 1.0.0 (6) got exactly these wrong --
  # its numbers were patched in after signing, by hand, and its archive
  # no longer verifies.
  #
  # Not the archive of a cloud build: that one is unsigned by design but
  # for the placeholder signatures above, and only the IPA is signed.
  if [ -z "$cloud" ]; then
    codesign --verify --deep --strict "$archived_app"
  fi
  unpacked=$(mktemp -d)
  ditto -x -k "$out/Neoxify.ipa" "$unpacked"
  codesign --verify --deep --strict "$unpacked/Payload/Neoxify.app"

  # And the entitlements, read back from the IPA's own signatures. A
  # bundle that lost them still signs, verifies, installs and uploads; it
  # just cannot start a tunnel, and nothing later in a release says so.
  # get-task-allow is the mark of a development signature, which the App
  # Store refuses but only after the upload.
  for bundle in Neoxify.app Neoxify.app/PlugIns/NeoxifyTunnel.appex; do
    ents="$unpacked/$(basename "$bundle").entitlements.plist"
    if ! codesign -d --entitlements - --xml "$unpacked/Payload/$bundle" > "$ents" 2>/dev/null; then
      echo "error: cannot read the entitlements of $bundle in the IPA" >&2
      rm -rf "$unpacked"
      exit 1
    fi
    wanted="packet-tunnel-provider group.com.neoxify.mobile"
    if [ "$bundle" = Neoxify.app ]; then wanted="$wanted allow-vpn"; fi
    for want in $wanted; do
      if ! grep -q "$want" "$ents"; then
        echo "error: $bundle in the IPA is signed without $want" >&2
        rm -rf "$unpacked"
        exit 1
      fi
    done
    if [ "$(plutil -extract get-task-allow raw "$ents" 2>/dev/null || true)" = "true" ]; then
      echo "error: $bundle in the IPA carries get-task-allow, a development signature" >&2
      rm -rf "$unpacked"
      exit 1
    fi
  done
  want="$NEOXIFY_IOS_MARKETING_VERSION ($NEOXIFY_IOS_BUILD_NUMBER)"
  for bundle in Neoxify.app Neoxify.app/PlugIns/NeoxifyTunnel.appex; do
    plist="$unpacked/Payload/$bundle/Info.plist"
    got="$(plutil -extract CFBundleShortVersionString raw "$plist") ($(plutil -extract CFBundleVersion raw "$plist"))"
    if [ "$got" != "$want" ]; then
      echo "error: $bundle is $got in the IPA, not $want" >&2
      rm -rf "$unpacked"
      exit 1
    fi
  done
  rm -rf "$unpacked"
  echo "store IPA: $out/Neoxify.ipa, $want, signed and verified. Not uploaded."
fi

# After, not before: `tauri ios build` runs `pnpm build` itself, so
# dist/ is only the store bundle once that has finished. Checking first
# would pass on whatever the previous build happened to leave behind.
node scripts/assert-store-bundle.mjs dist
