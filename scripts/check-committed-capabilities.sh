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
  # The staged blob, not the working copy and not HEAD.
  #
  # Not the working copy, because a local build or `pnpm test` patches it
  # legitimately and constantly -- flagging that would train everyone to
  # ignore this.
  #
  # Not HEAD, which is what this read before, because as a pre-commit
  # hook that inspects the *parent* commit: a staged bad file passed the
  # hook, got committed, and was only caught by CI afterwards -- by which
  # point it had been pushed to a public repository. That is not a
  # hypothetical; it is how run 35818935669 came to exist.
  #
  # The index is exactly the thing being committed, and staging a patched
  # working copy is the failure this guard was written for, both times it
  # has happened.
  content=$(git show ":$f" 2>/dev/null) || { echo "  $f: not tracked, skipped"; continue; }
  bad=$(printf '%s' "$content" \
        | grep -oE '"url"[[:space:]]*:[[:space:]]*"[^"]+"' \
        | sed -E 's/.*"url"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' \
        | grep -vE "$allowed_host_re" || true)
  if [ -n "$bad" ]; then
    # Counted, never printed. This guard fires exactly when a build-patched
    # capability file has been staged, so `$bad` is a list of live panel
    # alternates and node mirrors -- and it runs in CI on a public
    # repository, where its own output is published. It has already done
    # that once: run 35818935669 put eight hosts into a public Actions log
    # while reporting that they must not be committed.
    #
    # The count and the file are enough to act on: regenerate the file, or
    # `git checkout --` it. Which hosts they are is exactly what the person
    # reading the failure already has in front of them.
    n=$(printf '%s\n' "$bad" | grep -c .)
    echo "  $f: committed with $n generated entr(y/ies) -- run 'git checkout -- $f'"
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
