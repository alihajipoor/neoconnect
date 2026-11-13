#!/usr/bin/env bash
# Runs a command against xray-core with this repo's patches applied:
#
#   scripts/xray-core-patch.sh gomobile bind -target=ios ...
#   scripts/xray-core-patch.sh go test -run TestEngineMemory ...
#
# The command runs in plugins/vpn/xray. The patches are
# plugins/vpn/xray/patches/*.patch, applied to a copy of the exact
# xray-core version go.mod pins, which go.mod is pointed at (a `replace`)
# for the length of the command and then put back. Nothing is forked: the
# patch is the whole of the difference, and it is checked against every
# version bump here, loudly.
#
# Used by build-xray-xcframework.sh, so the iOS engine always carries it,
# and NOT by build-xray-aar.sh: Android runs the engine in the app's own
# process, with no 50 MB ceiling over it, and keeps upstream's buffers.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$here/plugins/vpn/xray"
patches="$src/patches"
module="github.com/xtls/xray-core"
work="$src/.xray-core-patched"

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 2
fi

cd "$src"
# A replace already there is a run that was killed before it could put
# go.mod back (SIGKILL, a cancelled CI job). Refused, not built over:
# restoring would keep it, and it must not be committed.
if grep -q "^replace $module " go.mod || grep -q "^[[:space:]]*$module .*=>" go.mod; then
  echo "error: go.mod already replaces $module; a killed run left it. Undo it: git checkout -- go.mod" >&2
  exit 1
fi
if ! command -v patch >/dev/null; then
  echo "error: 'patch' is not installed" >&2
  exit 1
fi

version="$(go list -m -f '{{.Version}}' "$module")"
go mod download "$module@$version"
origin="$(go list -m -f '{{.Dir}}' "$module@$version")"
if [ -z "$origin" ] || [ ! -d "$origin" ]; then
  echo "error: xray-core $version is not in the module cache" >&2
  exit 1
fi

rm -rf "$work"
cp -R "$origin" "$work"
chmod -R u+w "$work"

shopt -s nullglob
applied=0
for p in "$patches"/*.patch; do
  # --dry-run first: a patch that no longer fits this version fails here,
  # by name, rather than half-applying or building an unpatched engine
  # that only shows its difference on a phone.
  if ! patch -d "$work" -p1 --forward --dry-run --silent < "$p" >/dev/null; then
    echo "error: $(basename "$p") no longer applies to xray-core $version." >&2
    echo "       Re-make it against that version (see the header in the patch)," >&2
    echo "       or the iOS engine loses what it carries." >&2
    exit 1
  fi
  patch -d "$work" -p1 --forward --silent < "$p"
  # Every patch carries this marker in what it adds; its absence after
  # applying means the patch applied to something else.
  if ! grep -rq "neoxify-patch: $(basename "$p" .patch)" "$work"; then
    echo "error: $(basename "$p") applied but its marker is missing" >&2
    exit 1
  fi
  echo "xray-core $version: applied $(basename "$p")" >&2
  applied=$((applied + 1))
done
if [ "$applied" -eq 0 ]; then
  echo "error: no patches in $patches" >&2
  exit 1
fi

cp go.mod "$work.go.mod.orig"
cp go.sum "$work.go.sum.orig"
restore() {
  mv -f "$work.go.mod.orig" go.mod
  mv -f "$work.go.sum.orig" go.sum
}
trap restore EXIT
go mod edit -replace="$module=./.xray-core-patched"

"$@"
