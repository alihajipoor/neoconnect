#!/usr/bin/env bash
# Run this at the start of every session, on either machine.
#
# Two machines share this repo and cannot see each other: Windows does
# the desktop client, backend, panel and Android; the MacBook does iOS,
# which cannot be built anywhere else. GitHub is the only channel
# between them, so "am I behind?" has to be answered before any change,
# not after a conflict.
#
# Works on macOS and in Git Bash on Windows.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "=== Pulling ==="
# Rebase so local work replays on top rather than creating a merge
# commit for what is usually a fast-forward.
git pull --rebase --autostash

echo
echo "=== Where you are ==="
printf 'branch : %s\n' "$(git rev-parse --abbrev-ref HEAD)"
printf 'commit : %s\n' "$(git log -1 --format='%h %s (%cr)')"

# Uncommitted work from a previous session is worth seeing before you
# start layering more on top of it.
if [ -n "$(git status --porcelain)" ]; then
  echo
  echo "=== Uncommitted changes ==="
  git status --short
fi

echo
echo "=== Journal: shared ==="
tail -n 40 docs/journal/shared.md

# Show the *other* machine's log -- your own is the one you already
# know. Detected from the OS so neither session has to be told which it
# is.
case "$(uname -s)" in
  Darwin) other=windows ;;
  *)      other=macos ;;
esac

echo
echo "=== Journal: $other (the other machine) ==="
tail -n 45 "docs/journal/$other.md"

echo
echo "Full protocol: docs/journal/README.md"
echo "Before touching apps/mobile/src or plugins/vpn/src, check the entries above."
