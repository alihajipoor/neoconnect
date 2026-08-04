#!/usr/bin/env bash
# Base OS package dependencies shared by every install path.
set -euo pipefail

install_base_deps() {
  echo "Installing base dependencies (curl, wget, jq, ca-certificates)..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  # iproute2 carries `tc`, which the agent uses to enforce a plan's
  # per-user speed caps. Present by default on the supported
  # distributions, but named explicitly so a minimal image cannot
  # silently produce a node where every plan is uncapped.
  apt-get install -y -qq curl wget jq ca-certificates gnupg iproute2
}
