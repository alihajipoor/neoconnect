#!/usr/bin/env bash
# Detects the host OS/version and exits with a clear error on anything
# outside the supported matrix (Ubuntu 20.04-26.10, Debian 11-12).
#
# The matrix is a list of releases a node has actually been built on, not
# a range: a release nobody has installed on is refused, because what it
# changed is not known until somebody has. Ubuntu 26.10 was added after
# two nodes were built on it in November 2026 with this check patched on
# the box. OS_VERSION is read nowhere else in the installer, so adding a
# release here is the whole change; what the release itself changed is
# written down in docs/installer-os-support.md.
set -euo pipefail

detect_os() {
  # NEOXIFY_OS_RELEASE exists for the test that holds this matrix still
  # (scripts/fleet/test/image.test.mjs); a box always reads its own file.
  local os_release="${NEOXIFY_OS_RELEASE:-/etc/os-release}"
  if [[ ! -f "$os_release" ]]; then
    echo "ERROR: $os_release not found — unsupported or unrecognized OS." >&2
    exit 1
  fi

  # shellcheck disable=SC1090,SC1091
  . "$os_release"
  OS_ID="${ID:-unknown}"
  OS_VERSION="${VERSION_ID:-unknown}"

  case "$OS_ID" in
    ubuntu)
      case "$OS_VERSION" in
        20.04|22.04|24.04|26.04|26.10) ;;
        *)
          echo "ERROR: Ubuntu $OS_VERSION is not in the supported matrix (20.04, 22.04, 24.04, 26.04, 26.10)." >&2
          exit 1
          ;;
      esac
      ;;
    debian)
      case "$OS_VERSION" in
        11|12) ;;
        *)
          echo "ERROR: Debian $OS_VERSION is not in the supported matrix (11, 12)." >&2
          exit 1
          ;;
      esac
      ;;
    *)
      echo "ERROR: Unsupported OS '$OS_ID'. Neoxify agent supports Ubuntu 20.04-26.10 and Debian 11-12." >&2
      exit 1
      ;;
  esac

  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64) AGENT_ARCH="amd64" ;;
    aarch64) AGENT_ARCH="arm64" ;;
    *)
      echo "ERROR: Unsupported architecture '$ARCH'." >&2
      exit 1
      ;;
  esac

  export OS_ID OS_VERSION AGENT_ARCH
}

require_root() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    echo "ERROR: this script must be run as root (try: sudo bash install.sh)." >&2
    exit 1
  fi
}
