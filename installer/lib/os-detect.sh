#!/usr/bin/env bash
# Detects the host OS/version and exits with a clear error on anything
# outside the supported matrix (Ubuntu 20.04-26.04, Debian 11-12).
set -euo pipefail

detect_os() {
  if [[ ! -f /etc/os-release ]]; then
    echo "ERROR: /etc/os-release not found — unsupported or unrecognized OS." >&2
    exit 1
  fi

  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID="${ID:-unknown}"
  OS_VERSION="${VERSION_ID:-unknown}"

  case "$OS_ID" in
    ubuntu)
      case "$OS_VERSION" in
        20.04|22.04|24.04|26.04) ;;
        *)
          echo "ERROR: Ubuntu $OS_VERSION is not in the supported matrix (20.04, 22.04, 24.04, 26.04)." >&2
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
      echo "ERROR: Unsupported OS '$OS_ID'. Neoxify agent supports Ubuntu 20.04-26.04 and Debian 11-12." >&2
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
