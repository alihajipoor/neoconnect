#!/usr/bin/env bash
# Fails if a build-generated capability allowlist has been committed.
#
# The capability files are patched at build time with the replacement
# domains from the signed bundle (see apply-capability-scope.mjs). Those
# names must never be committed -- docs/node-address-hygiene.md explains
# why, and it has now been breached twice, both times by staging a
# working copy a local test run had already patched.
#
# Written as a positive allowlist rather than a search for the domains:
# a grep for the names would have to contain the names, which is the
# leak it is meant to prevent.
set -euo pipefail

allowed_host_re='^https://(\*\.neoxify\.site(:\*)?|localhost:[0-9]+)(/\*)?$|^http://localhost:[0-9]+/\*$'
status=0

for f in apps/desktop-windows/src-tauri/capabilities/default.json \
         apps/mobile/src-tauri/capabilities/default.json; do
  # Read the committed blob, not the working copy, which a local build
  # or `pnpm test` will legitimately have patched.
  content=$(git show "HEAD:$f" 2>/dev/null) || { echo "  $f: not tracked, skipped"; continue; }
  bad=$(printf '%s' "$content" \
        | grep -oE '"url"[[:space:]]*:[[:space:]]*"[^"]+"' \
        | sed -E 's/.*"url"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' \
        | grep -vE "$allowed_host_re" || true)
  if [ -n "$bad" ]; then
    echo "  $f: committed with generated entries:"
    printf '%s\n' "$bad" | sed 's/^/      /'
    status=1
  else
    echo "  $f: clean"
  fi
done

if [ "$status" -ne 0 ]; then
  echo
  echo "A build-time capability file was committed. Revert it:"
  echo "  git checkout -- <file>"
  echo "The release build regenerates it; see docs/node-address-hygiene.md."
fi
exit "$status"
