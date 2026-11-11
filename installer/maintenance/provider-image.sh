#!/usr/bin/env bash
# Looks at what this box's image brought along, and repairs it on request.
#
# A provider's image is not always bare. The one two nodes were built on
# in November 2026 came with ufw active on DROP policies, a hostname taken
# from the dashboard label (and put back by cloud-init on every boot), a
# swap file of the provider's own size, and a firmware timer that fails
# on a virtual machine. Each was found and repaired by hand, the hostname
# only after a reboot showed it had come back. installer/lib/image.sh is
# those repairs; this is the way to run them, or just to look.
#
# Runs ON the box, as root. A fresh install runs the same repairs itself
# (prepare_provider_image), so this is for looking at a box before it is
# built on, and for a node built before the installer knew any of this.
#
# Usage:
#   provider-image.sh                  # say what is there, change nothing
#   provider-image.sh --apply          # repair what is found, then say what is there
#   provider-image.sh --apply --live   # the same on a box that is already a node
#
# One line per item: "ok", "REPAIR" (found; --apply changes it) or "LOOK"
# (found; a person has to decide, nothing here changes it). Exit status
# is the worst line: 0, 1 for REPAIR, 2 for LOOK.
#
# --live exists because two of the repairs are not free on a node with
# customers: taking ufw away changes what reaches the box, and replacing
# the swap file turns swap off for a moment. Neither restarts an engine.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/image.sh
. "$SCRIPT_DIR/../lib/image.sh"
# image.sh runs under `set -e`; a report wants every line, not the first
# one that is not "ok".
set +e

APPLY=0
LIVE=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --live) LIVE=1 ;;
    *)
      echo "usage: provider-image.sh [--apply [--live]]" >&2
      exit 64
      ;;
  esac
done

if [[ "$APPLY" == 1 ]]; then
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    echo "ERROR: --apply must be run as root." >&2
    exit 64
  fi
  if [[ -f /etc/neoxify/agent.json && "$LIVE" != 1 ]]; then
    echo "This box is already a node, so nothing is changed without --live. What is there:"
  else
    image_repair
  fi
fi

image_report
