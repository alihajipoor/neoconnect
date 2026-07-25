#!/usr/bin/env bash
#
# Build the deployable zip.
#
# The archive contains the site's files at its ROOT -- no wrapper folder --
# so unzipping it inside public_html puts index.php exactly where it needs to
# be, with nothing to move afterwards.
#
# Usage, from anywhere:
#     bash website/make-zip.sh
#
# Output: website/build/neoxify-website.zip  (build/ is gitignored)

set -euo pipefail

SITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$SITE_DIR/build"
ARCHIVE="$BUILD_DIR/neoxify-website.zip"

if ! command -v zip >/dev/null 2>&1; then
    echo "error: 'zip' is not installed." >&2
    echo "  Debian/Ubuntu: sudo apt-get install zip" >&2
    exit 1
fi

mkdir -p "$BUILD_DIR"
rm -f "$ARCHIVE"

cd "$SITE_DIR"

# Excluded from the archive:
#   build/        the output directory itself
#   README.md     deploy instructions, not part of the site
#   make-zip.sh   this script
#   data/*        runtime submissions, the CSRF secret, rate-limit state.
#                 The directory and its .htaccess ARE included (so a fresh
#                 install is writable and protected from the first request),
#                 but never anyone's real submitted data.
zip -r -q "$ARCHIVE" . \
    -x 'build/*' \
    -x 'README.md' \
    -x 'make-zip.sh' \
    -x 'data/secret.php' \
    -x 'data/ratelimit.php' \
    -x 'data/submissions-*.php'

echo "Built: $ARCHIVE"
echo

# `unzip -l | head` would close the pipe early and, under `set -o pipefail`,
# make this script exit 141 on a perfectly successful build. Count instead.
FILE_COUNT=$(unzip -l "$ARCHIVE" | tail -1 | awk '{print $2}')
echo "$FILE_COUNT files. Top level:"
unzip -l "$ARCHIVE" \
    | awk 'NR > 3 && NF >= 4 {print $4}' \
    | grep -vE '^$|^-+$|^Name$|/.+' \
    | sort -u | sed 's/^/  /'

echo
echo "Deploy: upload this file to your host and unzip it inside public_html."
