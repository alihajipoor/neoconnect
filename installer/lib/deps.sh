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
  #
  # bind9-dnsutils carries `dig`, which is NOT on a stock Ubuntu and is
  # how probe_reality_dest finds out who owns the address a camouflage
  # domain resolves to. Without it the CNAME and AS-ownership checks
  # cannot run, and a CDN-fronted dest -- the thing that check exists to
  # catch -- goes through as if it were fine. The probe degrades to
  # saying so out loud rather than pretending, but a node that has the
  # package never reaches that path.
  apt-get install -y -qq curl wget jq ca-certificates gnupg iproute2 bind9-dnsutils
}
