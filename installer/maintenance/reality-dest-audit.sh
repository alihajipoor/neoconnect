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
#   reality-dest-audit.sh --self-test-local   # only the part that needs no network
#
# Each name gets one line: OK, WEAK (works, poor disguise) or BAD (REALITY
# cannot work through it), then the reasons. scripts/fleet reads that
# first word before it builds a server on a dest.
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

# The control case for the key-exchange check, with no network at all.
#
# probe_reality_dest once passed a dest that refuses X25519, and REALITY
# on that node carried nothing until the dest was changed. The check that
# would have caught it (reality_x25519_only) is a handshake, so it is
# proven here against two TLS servers started on loopback: one that
# offers only P-256, as that site did, and one that offers X25519. It has
# to fail the first and pass the second, with whatever openssl this box
# has -- which is the point, because the old check depended on what one
# release of openssl printed.
#
# The group reader (reality_negotiated_group) is checked twice: against
# what this openssl prints for those two servers, and against the lines
# other releases print. Of the fixed lines, "Peer Temp Key" and "<NULL>"
# were captured from OpenSSL 3.5.8; "Negotiated TLS1.3 group" for a
# completed handshake is as reported from the OpenSSL 4.0 of an Ubuntu
# 26.10 build, not captured here.
SELF_TEST_PIDS=()
SELF_TEST_PORT=""

# self_test_serve <dir> <groups>: a TLS 1.3 server on loopback that
# offers only those groups. Sets SELF_TEST_PORT; fails if none came up.
self_test_serve() {
  local dir="$1" groups="$2" port out starts=0 waits
  SELF_TEST_PORT=""
  while [[ "$starts" -lt 5 ]]; do
    starts=$((starts + 1))
    port=$((20000 + RANDOM % 20000))
    openssl s_server -accept "127.0.0.1:$port" -cert "$dir/cert.pem" -key "$dir/key.pem" \
      -tls1_3 -groups "$groups" -www -quiet >/dev/null 2>&1 </dev/null &
    SELF_TEST_PIDS+=("$!")
    waits=0
    while [[ "$waits" -lt 10 ]]; do
      waits=$((waits + 1))
      out="$(timeout 5 openssl s_client -connect "127.0.0.1:$port" -groups "$groups" </dev/null 2>/dev/null | tr -d '\0')"
      if [[ "$out" =~ New,[[:space:]]*TLSv1\.3 ]]; then
        SELF_TEST_PORT="$port"
        return 0
      fi
      sleep 0.3
    done
  done
  return 1
}

# self_test_group <port> <what the group must be: x25519 | other>
self_test_group() {
  local out got
  out="$(timeout 5 openssl s_client -connect "127.0.0.1:$1" </dev/null 2>/dev/null | tr -d '\0')"
  got="$(reality_negotiated_group "$out")"
  if [[ -z "$got" ]]; then
    echo "NOTE  this openssl does not name the group it negotiated, so the check on a dest that"
    echo "      moves the key exchange elsewhere is off here. The X25519-only handshake still decides."
    return 0
  fi
  if [[ "${got^^}" =~ ^X25519(MLKEM768)?$ ]]; then
    [[ "$2" == x25519 ]] && { echo "PASS  the negotiated group is read from this openssl's output ($got)"; return 0; }
  else
    [[ "$2" == other ]] && { echo "PASS  a group that is not X25519 is read from this openssl's output ($got)"; return 0; }
  fi
  echo "FAIL  the group read from this openssl's output is '$got', and the server offered ${2}" >&2
  return 1
}

self_test_x25519() {
  local dir fail=0 pid line want got
  echo "Control case: a dest that refuses X25519 must be refused. Two throwaway TLS servers on loopback."
  echo "  $(openssl version 2>/dev/null || echo 'openssl: not found')"
  echo
  dir="$(mktemp -d)" || { echo "FAIL  no temporary directory" >&2; return 1; }
  if ! openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 \
    -keyout "$dir/key.pem" -out "$dir/cert.pem" -subj "/CN=control.invalid" >/dev/null 2>&1; then
    echo "FAIL  could not make a throwaway certificate for the control servers" >&2
    rm -rf "$dir"
    return 1
  fi

  if self_test_serve "$dir" P-256; then
    if reality_x25519_only 127.0.0.1 "$SELF_TEST_PORT" control.invalid; then
      echo "FAIL  a server that offers only P-256 passed the X25519-only handshake. The check that keeps" >&2
      echo "      REALITY off a dest it cannot work with is not working." >&2
      fail=1
    else
      echo "PASS  a dest that refuses X25519 is caught: the X25519-only handshake fails against a P-256-only server"
    fi
    self_test_group "$SELF_TEST_PORT" other || fail=1
  else
    echo "FAIL  could not start the P-256-only control server (openssl s_server on loopback)" >&2
    fail=1
  fi

  if self_test_serve "$dir" X25519; then
    if reality_x25519_only 127.0.0.1 "$SELF_TEST_PORT" control.invalid; then
      echo "PASS  a dest that speaks X25519 passes the same handshake"
    else
      echo "FAIL  a server that offers X25519 failed the X25519-only handshake: every dest would be refused" >&2
      fail=1
    fi
    self_test_group "$SELF_TEST_PORT" x25519 || fail=1
  else
    echo "FAIL  could not start the X25519 control server (openssl s_server on loopback)" >&2
    fail=1
  fi

  for pid in "${SELF_TEST_PIDS[@]}"; do
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
  done
  SELF_TEST_PIDS=()
  rm -rf "$dir"

  # What other releases of openssl print, line for line.
  while IFS='|' read -r line want; do
    [[ -n "$line" ]] || continue
    got="$(reality_negotiated_group "$line")"
    if [[ "$got" != "$want" ]]; then
      echo "FAIL  '$line' was read as '${got}', expected '${want}'" >&2
      fail=1
    fi
  done <<'LINES'
Server Temp Key: X25519, 253 bits|X25519
Server Temp Key: ECDH, prime256v1, 256 bits|prime256v1
Server Temp Key: DH, 2048 bits|DH
Peer Temp Key: X25519, 253 bits|X25519
Peer Temp Key: ECDH, prime256v1, 256 bits|prime256v1
Negotiated TLS1.3 group: X25519MLKEM768|X25519MLKEM768
Negotiated TLS1.3 group: X25519|X25519
Negotiated TLS1.3 group: secp256r1|secp256r1
Negotiated TLS1.3 group: <NULL>|
New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384|
LINES
  if [[ "$fail" == 0 ]]; then
    echo "PASS  the negotiated group is read from the lines OpenSSL 3 and 4 print"
  fi
  return "$fail"
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
  if [[ "${1:-}" == "--self-test-local" ]]; then
    self_test_x25519
    return $?
  fi
  if [[ "${1:-}" == "--self-test" ]]; then
    local failed=0
    self_test_x25519 || failed=1
    echo
    self_test || failed=1
    return "$failed"
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
