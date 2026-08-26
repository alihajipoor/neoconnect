#!/usr/bin/env bash
# Fails when the rule that stops Neoxify manufacturing an account-sharing
# ban stops being enforced.
#
# The rule, stated once: a game routed by destination prefix must have its
# WHOLE prefix set or none of it. World of Warcraft holds its Home and its
# World connection open at the same instant. Route one and not the other and
# the account presents from two source addresses simultaneously -- which is
# the account-sharing signature publishers look for. A partial list does not
# degrade gracefully; it actively creates a ban risk that not routing at all
# would not. See docs/design/ban-safety.md, "The two-source-IP split".
#
# `prefixComplete` is the gate. It is a boolean the operator sets, defaulting
# to false, and the client refuses to activate a per-game private exit when
# it is false. That is the entire safety mechanism, and until this script
# existed it was held together by four separate pieces of prose in four
# files and nothing at all that would fail if one of them changed.
#
# This is the same failure shape as check-protocol-drift.sh and
# check-feature-drift.sh: nothing errors, nothing goes red, and the absence
# of a safeguard looks exactly like a decision not to need one. The
# difference is that those two cost a customer a feature. This one costs a
# customer their account, and the owner has been explicit that a Gaming Mode
# which gets players banned is worse than no Gaming Mode at all.
#
# Four invariants, all offline, no network, no database:
#
#   1. schema.prisma  -- prefixComplete defaults to false. An omitted value
#      must never read as "the list is whole".
#   2. gaming.service.ts -- create/update coerce an absent field with
#      `?? false`, for the same reason at the API boundary.
#   3. game-profiles.ts -- no seeded profile claims prefixComplete: true
#      while carrying an empty destinationCidrs, or no destinationAsn to
#      audit the list against.
#   4. game-apps.ts -- canRouteByDestination still requires BOTH
#      prefixComplete === true AND a non-empty destinationCidrs. This is the
#      one that actually runs on a customer's machine.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

SCHEMA="apps/backend/prisma/schema.prisma"
SEED="apps/backend/prisma/game-profiles.ts"
SERVICE="apps/backend/src/modules/gaming/gaming.service.ts"
CLIENT_GATE="apps/desktop-windows/src/lib/game-apps.ts"

for f in "$SCHEMA" "$SEED" "$SERVICE" "$CLIENT_GATE"; do
  [ -f "$f" ] || { echo "check-prefix-completeness: missing $f" >&2; exit 1; }
done

status=0

# --- 1. the schema default -------------------------------------------------

if ! grep -qE '^\s*prefixComplete\s+Boolean\s+@default\(false\)' "$SCHEMA"; then
  echo "check-prefix-completeness: $SCHEMA no longer declares" >&2
  echo "  prefixComplete Boolean @default(false)" >&2
  echo "" >&2
  echo "  The default must be false. A row created without the column set" >&2
  echo "  would otherwise claim a complete prefix list nobody wrote." >&2
  echo "" >&2
  status=1
fi

# --- 2. the API boundary ---------------------------------------------------

coercions=$(grep -cE 'prefixComplete:\s*(dto|input)?\.?prefixComplete\s*\?\?\s*false' "$SERVICE" || true)
if [ "$coercions" -lt 1 ]; then
  echo "check-prefix-completeness: $SERVICE no longer coerces an absent" >&2
  echo "  prefixComplete to false (expected 'dto.prefixComplete ?? false')." >&2
  echo "" >&2
  echo "  An admin payload that omits the field must mean 'not complete'," >&2
  echo "  never 'unchanged' and never 'true'." >&2
  echo "" >&2
  status=1
fi

# --- 3. the seeded profiles ------------------------------------------------
#
# Walk the file remembering the last slug seen, and record what that profile
# declares. destinationCidrs may be written inline (`[] as string[]`) or as a
# multi-line array literal, so count entries until the closing bracket.

profiles=$(awk '
  /^[[:space:]]*slug:[[:space:]]*"/ {
    if (slug != "") print slug "\t" complete "\t" cidrs "\t" asn
    slug = $0
    sub(/^[[:space:]]*slug:[[:space:]]*"/, "", slug)
    sub(/".*$/, "", slug)
    complete = "unset"; cidrs = 0; asn = "unset"; in_cidrs = 0
    next
  }
  /^[[:space:]]*destinationAsn:/ { asn = "set"; next }
  /^[[:space:]]*prefixComplete:[[:space:]]*true/  { complete = "true";  next }
  /^[[:space:]]*prefixComplete:[[:space:]]*false/ { complete = "false"; next }
  /^[[:space:]]*destinationCidrs:/ {
    line = $0
    # inline empty array, with or without an `as string[]` assertion
    if (line ~ /\[[[:space:]]*\]/) { cidrs = 0; next }
    # inline populated array
    if (line ~ /\[.*\]/) { n = gsub(/"/, "\"", line); cidrs = n / 2; next }
    in_cidrs = 1; next
  }
  in_cidrs == 1 {
    if ($0 ~ /\]/) { in_cidrs = 0; next }
    if ($0 ~ /"/) cidrs++
    next
  }
  END { if (slug != "") print slug "\t" complete "\t" cidrs "\t" asn }
' "$SEED")

if [ -z "$profiles" ]; then
  echo "check-prefix-completeness: found no game profiles in $SEED." >&2
  echo "  The parser is wrong, not the code. Fix this script before trusting it." >&2
  exit 1
fi

while IFS=$'\t' read -r slug complete cidrs asn; do
  [ -n "$slug" ] || continue
  if [ "$complete" = "unset" ]; then
    echo "check-prefix-completeness: profile '$slug' in $SEED declares no" >&2
    echo "  prefixComplete at all. State it explicitly -- the safety of this" >&2
    echo "  gate is that somebody had to decide, not that a default applied." >&2
    echo "" >&2
    status=1
    continue
  fi
  if [ "$complete" = "true" ] && [ "$cidrs" -eq 0 ]; then
    echo "check-prefix-completeness: profile '$slug' in $SEED claims" >&2
    echo "  prefixComplete: true with an EMPTY destinationCidrs." >&2
    echo "" >&2
    echo "  That is the worst of both states: the client will accept the" >&2
    echo "  profile for destination routing and then have nothing to route," >&2
    echo "  or route a fragment. Either write the whole prefix set or set" >&2
    echo "  prefixComplete back to false." >&2
    echo "" >&2
    status=1
  fi
  if [ "$complete" = "true" ] && [ "$asn" = "unset" ]; then
    echo "check-prefix-completeness: profile '$slug' in $SEED claims" >&2
    echo "  prefixComplete: true without a destinationAsn." >&2
    echo "" >&2
    echo "  The ASN is what makes the claim auditable: without it nobody can" >&2
    echo "  re-derive the prefix set and check the claim is still true. A" >&2
    echo "  completeness claim that cannot be re-checked is a completeness" >&2
    echo "  claim that will silently rot." >&2
    echo "" >&2
    status=1
  fi
done <<< "$profiles"

# --- 4. the gate that actually runs on a customer's machine ----------------

gate=$(sed -n '/export function canRouteByDestination/,/^}/p' "$CLIENT_GATE")
if [ -z "$gate" ]; then
  echo "check-prefix-completeness: canRouteByDestination is gone from $CLIENT_GATE." >&2
  echo "  That function is the only thing standing between a partial prefix" >&2
  echo "  list and a customer's account. If it moved, point this check at it." >&2
  echo "" >&2
  status=1
else
  if ! grep -q 'prefixComplete === true' <<< "$gate"; then
    echo "check-prefix-completeness: canRouteByDestination in $CLIENT_GATE" >&2
    echo "  no longer requires 'prefixComplete === true'." >&2
    echo "" >&2
    status=1
  fi
  if ! grep -qE 'destinationCidrs\??\.length.*>\s*0' <<< "$gate"; then
    echo "check-prefix-completeness: canRouteByDestination in $CLIENT_GATE" >&2
    echo "  no longer requires a non-empty destinationCidrs." >&2
    echo "" >&2
    echo "  prefixComplete: true with an empty list must not route. The flag" >&2
    echo "  is a claim; the list is the thing." >&2
    echo "" >&2
    status=1
  fi
fi

if [ "$status" -eq 0 ]; then
  count=$(printf '%s\n' "$profiles" | grep -c . || true)
  echo "check-prefix-completeness: ok -- $count game profile(s), the destination-routing gate is intact."
fi

exit "$status"
