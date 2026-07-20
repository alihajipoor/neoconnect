#!/usr/bin/env bash
# Base OS package dependencies shared by every install path.
set -euo pipefail

install_base_deps() {
  echo "Installing base dependencies (curl, wget, jq, ca-certificates)..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl wget jq ca-certificates gnupg
}
