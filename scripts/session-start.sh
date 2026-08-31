#!/usr/bin/env bash
# Run this at the start of every session.
#
# One machine works this repo (a Mac, since 2026-08-30). There is no
# other session to sync with, but "am I behind?" and "what did I leave
# half-done?" still have to be answered before any change, not after a
# conflict.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "=== Pulling ==="
# Rebase so local work replays on top rather than creating a merge
# commit for what is usually a fast-forward. A branch with no upstream
# is the normal state for fresh work, not an error -- fetch so the
# comparison below is honest, and say plainly that nothing was pulled.
if git rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1; then
  git pull --rebase --autostash
else
  git fetch --quiet origin
  echo "No upstream for this branch -- fetched only, nothing pulled."
fi

echo
echo "=== Where you are ==="
printf 'branch : %s\n' "$(git rev-parse --abbrev-ref HEAD)"
printf 'commit : %s\n' "$(git log -1 --format='%h %s (%cr)')"

# Uncommitted work from a previous session is worth seeing before you
# start layering more on top of it. With one machine there is no second
# copy of anything uncommitted, so this is also the loss warning.
if [ -n "$(git status --porcelain)" ]; then
  echo
  echo "=== Uncommitted changes (nothing else holds a copy) ==="
  git status --short
fi

# Branches that exist locally but nowhere else are the exact shape of
# the loss that already cost this repo a finished branch.
unpushed=$(git for-each-ref --format='%(refname:short) %(upstream)' refs/heads \
  | awk '$2 == "" { print $1 }')
if [ -n "$unpushed" ]; then
  echo
  echo "=== Local branches with no remote (push these) ==="
  echo "$unpushed" | sed 's/^/  /'
fi

echo
echo "=== Toolchains ==="
# Environment facts changed with the machine; a missing toolchain should
# surface here rather than three commands into a task.
for t in node pnpm cargo go; do
  if command -v "$t" >/dev/null 2>&1; then
    printf '  %-6s %s\n' "$t" "$("$t" --version 2>&1 | head -1)"
  else
    printf '  %-6s MISSING\n' "$t"
  fi
done
echo "  (Windows desktop cannot be built here; iOS needs full Xcode."
echo "   Every release runs on a GitHub-hosted runner -- see CLAUDE.md.)"

echo
echo "=== Journal: standing decisions (shared.md) ==="
tail -n 30 docs/journal/shared.md

echo
echo "=== Journal: working log (log.md) ==="
tail -n 50 docs/journal/log.md

echo
echo "Full protocol: docs/journal/README.md"
echo "Long-form history: docs/journal/windows.md (archive, still the reference)"
