#!/usr/bin/env bash
# Audits REALITY camouflage destinations with the same probe the installer
# uses, and can prove that probe still works.
#
# Why this exists as a separate entry point: the check that matters most
# -- who owns the address a decoy resolves to -- is not a property of the
# name, it is a property of today. www.asus.com and www.leboncoin.fr were
# both sound decoys when they were chosen and both had moved into AWS
# CloudFront by the time anyone looked again. Nothing failed, nothing
# logged, and they went on being offered as the default.
#
# So the answer is not a better list, it is a way to re-ask. Run this
# against a node's current dest whenever you want to know whether it has
# rotted, and against a shortlist when you need a new one.
#
# Read-only. It resolves names, opens TLS connections and makes one HTTPS
# request per name. It touches nothing on this machine and nothing on any
# node -- run it from wherever you like, but remember that DNS answers are
# a function of where you ask from, so the verdict that counts is the one
# taken on the node itself.
#
# Usage:
#   reality-dest-audit.sh                 # the installer's own candidate lists
#   reality-dest-audit.sh NAME [NAME...]  # specific names
#   reality-dest-audit.sh --self-test     # prove the probe still discriminates
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/agent.sh
. "$SCRIPT_DIR/../lib/agent.sh"
# agent.sh runs under `set -e`; an audit wants to see every verdict, not
# stop at the first non-zero one.
set +e

audit_one() {
  local host="$1" reason rc
  reason="$(probe_reality_dest "$host" 443)" && rc=0 || rc=$?
  case "$rc" in
    0) printf 'OK    %-26s %s\n' "$host" "${reason:-TLS 1.3, h2, X25519, certificate for that name, not fronted}" ;;
    2) printf 'WEAK  %-26s %s\n' "$host" "$reason" ;;
    *) printf 'BAD   %-26s %s\n' "$host" "$reason" ;;
  esac
  return "$rc"
}

# The control case for the ownership check.
#
# One name that is genuinely hosted by the organisation it belongs to,
# and one that is CDN-fronted. Before this probe learned to look at who
# owns the address, BOTH of these passed -- identically, with TLS 1.3,
# h2, X25519 and a verified certificate -- which is exactly how a rotted
# decoy stayed in the installer's default list.
#
# www.asus.com is the fronted one on purpose rather than a synthetic
# example: it is one of the two entries that actually rotted, so this
# test fails the day the check stops working AND stays honest about what
# it is checking. If ASUS ever leaves CloudFront this will start
# reporting a false alarm -- that is the intended failure direction,
# because a self-test that quietly stops testing anything is worse.
self_test() {
  local good="www.torob.com" fronted="www.asus.com" rc_good rc_fronted fail=0

  echo "Control case: the ownership check must separate these two."
  echo
  audit_one "$good"; rc_good=$?
  audit_one "$fronted"; rc_fronted=$?
  echo

  if [[ "$rc_good" == 0 ]]; then
    echo "PASS  a self-hosted dest is accepted ($good)"
  else
    echo "FAIL  $good was not accepted (rc=$rc_good). Either it has moved" >&2
    echo "      hosting, or this vantage point cannot reach it." >&2
    fail=1
  fi

  if [[ "$rc_fronted" == 2 ]]; then
    echo "PASS  a CloudFront-fronted dest is refused ($fronted): never offered"
    echo "      as a candidate, never the default, and only usable by typing"
    echo "      it and confirming the warning."
  elif [[ "$rc_fronted" == 0 ]]; then
    echo "FAIL  $fronted was accepted. The ownership check is not running --" >&2
    echo "      most likely dig is missing (apt-get install bind9-dnsutils)." >&2
    fail=1
  else
    echo "NOTE  $fronted was refused outright (rc=$rc_fronted) rather than as"
    echo "      a weak disguise. Still refused, but for a different reason --"
    echo "      read the line above before trusting this run as evidence."
  fi
  return "$fail"
}

main() {
  if [[ "${1:-}" == "--self-test" ]]; then
    self_test
    return $?
  fi

  local -a names=()
  if [[ $# -gt 0 ]]; then
    names=("$@")
  else
    names=("${REALITY_DEST_CANDIDATES_IR[@]}" "${REALITY_DEST_CANDIDATES_ABROAD[@]}")
    echo "Auditing the installer's own candidate lists."
    echo "DNS answers depend on where you ask from; run this on the node when"
    echo "the answer has to be the node's."
    echo
  fi

  local host worst=0 rc
  for host in "${names[@]}"; do
    audit_one "$host"; rc=$?
    [[ "$rc" -gt "$worst" ]] && worst="$rc"
  done
  return 0
}

main "$@"
