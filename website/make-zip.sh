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

# `zip` is the preferred builder, but it is not on a stock Windows dev box,
# so fall back to Python's zipfile.
#
# What is NOT an acceptable fallback: PowerShell's Compress-Archive. It writes
# entry names with BACKSLASH separators, which unpack correctly on Windows and
# produce a flat pile of files literally named "incootstrap.php" on the
# Linux host this site runs on. That has bitten this project before. Python's
# zipfile always writes forward slashes, as the ZIP spec requires.
if ! command -v zip >/dev/null 2>&1; then
    # Probe each candidate by actually RUNNING it, not just by whether the
    # name resolves. On Windows, `python3` resolves to a Microsoft Store stub
    # that exists on PATH, satisfies `command -v`, and then prints "Python was
    # not found" and exits non-zero the moment you use it.
    PY=""
    for candidate in python3 python py; do
        if command -v "$candidate" >/dev/null 2>&1            && "$candidate" -c 'import sys, zipfile' >/dev/null 2>&1; then
            PY="$candidate"
            break
        fi
    done

    if [ -z "$PY" ]; then
        echo "error: neither 'zip' nor Python is installed." >&2
        echo "  Debian/Ubuntu: sudo apt-get install zip" >&2
        echo "  Windows:       install Python, or run this under WSL" >&2
        exit 1
    fi

    echo "note: 'zip' not found, building with $PY instead." >&2
    "$PY" "$SITE_DIR/scripts/make-zip.py" "$SITE_DIR" "$ARCHIVE" || exit 1

    echo
    echo "Deploy: upload this file to your host and unzip it inside public_html."
    exit 0
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
#   .gitignore    repository bookkeeping, no business being on a webserver
#   *.zip         a previous archive left in the docroot
#   scripts/      development tooling: the pre-deploy check and the router
#                 for the built-in server. The server config denies /scripts/
#                 too, but a file that is never uploaded cannot be served.
#   nginx-*.example
#                 the server configuration. Nothing rewrites it, so inside the
#                 docroot it is served as PLAIN TEXT at
#                 /nginx-website.conf.example -- handing over the CSP, the
#                 fastcgi socket path and the document root to anyone who asks.
#                 It belongs in the server's own config directory, not here.
zip -r -q "$ARCHIVE" . \
    -x 'build/*' \
    -x 'README.md' \
    -x 'make-zip.sh' \
    -x 'scripts/*' \
    -x 'nginx-website.conf.example' \
    -x '.gitignore' \
    -x '*/.gitignore' \
    -x '*.zip' \
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
