#!/bin/bash
# nx-xray-get.sh <version> [output path]   (default /dev/shm/nxf/xray)
# Runs on the panel host, and on a box being built (for its trial
# REALITY inbound). The Xray binary the test clients use: the
# fleet's pinned version, downloaded from the project's own release page
# and checked against the SHA2-256 in that release's .dgst file. Kept in
# RAM. Does nothing when the right version is already there.
set -euo pipefail
V=${1:?version, e.g. v26.3.27}
OUT=${2:-/dev/shm/nxf/xray}
[[ "$V" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "bad version"; exit 2; }
if [ -x "$OUT" ] && "$OUT" version 2>/dev/null | head -1 | grep -q " ${V#v} "; then
  echo "xray $V already in place"
  exit 0
fi
case "$(uname -m)" in
  x86_64) ASSET=Xray-linux-64.zip ;;
  aarch64) ASSET=Xray-linux-arm64-v8a.zip ;;
  *) echo "no Xray build named for $(uname -m)"; exit 1 ;;
esac
D=$(mktemp -d /dev/shm/xget.XXXXXX)
trap 'rm -rf "$D"' EXIT
BASE=https://github.com/XTLS/Xray-core/releases/download/$V
curl -fsSL -o "$D/x.zip" "$BASE/$ASSET"
curl -fsSL -o "$D/x.dgst" "$BASE/$ASSET.dgst"
want=$(grep -i 'SHA2-256' "$D/x.dgst" | awk '{print $NF}')
got=$(sha256sum "$D/x.zip" | awk '{print $1}')
[ -n "$want" ] && [ "$want" = "$got" ] || { echo "xray zip checksum mismatch"; exit 1; }
python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extract("xray", sys.argv[2])' "$D/x.zip" "$D"
mkdir -p "$(dirname "$OUT")"
install -m 700 "$D/xray" "$OUT"
"$OUT" version | head -1
