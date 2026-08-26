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
# Five invariants, all offline, no network, no database. Each states not
# just what must be present but what shape it must have -- a presence check
# catches deletion and catches nothing else, which is how the API-boundary
# one below passed for a file whose second write path was uncoerced:
#
#   1. schema.prisma  -- prefixComplete defaults to false. An omitted value
#      must never read as "the list is whole".
#   2. gaming.service.ts -- BOTH write paths treat an absent field as "not
#      complete", proven by named cases in gaming.service.spec.ts, plus a
#      census so a third write path cannot appear without its own.
#   3. game-profiles.ts -- no seeded profile claims prefixComplete: true
#      while carrying an empty destinationCidrs, or no destinationAsn to
#      audit the list against.
#   4. game-apps.ts -- canRouteByDestination still requires BOTH
#      prefixComplete === true AND a non-empty destinationCidrs, and still
#      decides it in exactly one return with no alternative. This is the one
#      that actually runs on a customer's machine.
#   5. catalogue/index.ts -- the ~1,480 bulk rows still cannot claim
#      completeness: toSeedRow hard-codes false, validateCatalogue refuses an
#      entry that carries true.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

SCHEMA="apps/backend/prisma/schema.prisma"
SEED="apps/backend/prisma/game-profiles.ts"
SERVICE="apps/backend/src/modules/gaming/gaming.service.ts"
SERVICE_SPEC="apps/backend/src/modules/gaming/gaming.service.spec.ts"
BULK="apps/backend/prisma/catalogue/index.ts"
CLIENT_GATE="apps/desktop-windows/src/lib/game-apps.ts"

for f in "$SCHEMA" "$SEED" "$SERVICE" "$SERVICE_SPEC" "$BULK" "$CLIENT_GATE"; do
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

# This used to be `grep -c ... ; if [ "$coercions" -lt 1 ]`, and it was the
# weakest thing in this file. There are TWO write paths -- createProfile and
# updateProfile -- and a file-wide count of 1 is satisfied by either one of
# them alone. updateProfile was in fact the uncoerced one: it wrote
# `prefixComplete: dto.prefixComplete`, and an `undefined` in a Prisma
# `update` means "leave the column alone", so a PATCH that shortened
# destinationCidrs left a stale `true` standing over a list nobody had
# vouched for since. The guard's own error text forbade exactly that
# ("never 'unchanged'") while passing it. A count also cannot tell a live
# line from a commented-out one, and cannot see a third write path added
# later, because one surviving coercion satisfies it forever.
#
# What replaces it is a census plus a behavioural spec. The census fails
# when the number of writes to GameProfile changes, so a new write path
# cannot appear unnoticed; the spec proves what each existing path
# actually does with an absent claim, which no amount of grepping can.

writes=$(grep -cE 'gameProfile\.(create|update|upsert|createMany|updateMany)\(' "$SERVICE" || true)
if [ "$writes" -ne 2 ]; then
  echo "check-prefix-completeness: $SERVICE has $writes writes to GameProfile," >&2
  echo "  expected 2 (createProfile and updateProfile)." >&2
  echo "" >&2
  echo "  Every write is a place an absent prefixComplete can silently mean" >&2
  echo "  'complete'. A new one needs its own case in $SERVICE_SPEC before" >&2
  echo "  this number is updated -- the number is not the safeguard, the" >&2
  echo "  tests are; this is what stops a path being added without any." >&2
  echo "" >&2
  status=1
fi

# The behaviour itself, pinned by name so removing a case is as loud as
# breaking one. Names, not bodies: the bodies are jest's business.
for want in \
  "reads an absent claim on create as 'not complete'" \
  "drops the claim when a PATCH changes the prefix list without re-stating it" \
  "keeps the claim when a PATCH leaves the prefix list alone" \
  "refuses a complete claim with no prefixes on create"; do
  if ! grep -qF "$want" "$SERVICE_SPEC"; then
    echo "check-prefix-completeness: $SERVICE_SPEC no longer covers" >&2
    echo "  \"$want\"." >&2
    echo "" >&2
    echo "  That case is what actually holds the API boundary. This script" >&2
    echo "  can only see text; the spec runs the code." >&2
    echo "" >&2
    status=1
  fi
done

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
    # An array literal opens here and closes further down.
    if (line ~ /\[/) { cidrs = 0; in_cidrs = 1; next }
    # Anything else -- `destinationCidrs: WOW_PREFIXES,`, a call, a
    # spread from elsewhere -- is a value this parser cannot read. It
    # used to fall through to the multi-line branch and count the quotes
    # in whatever followed, which for the real file shape means
    # `canaryHostname` and `notes`: a profile with an identifier here and
    # prefixComplete: true reported TWO prefixes it does not have and
    # passed. Unknown must fail, not guess -- this check exists to refuse
    # an unverifiable completeness claim, so an unverifiable list is the
    # same answer.
    cidrs = "opaque"; next
  }
  in_cidrs == 1 {
    if ($0 ~ /\]/) { in_cidrs = 0; next }
    if ($0 ~ /"/) { cidrs++; next }
    # A blank line or a comment inside the literal is fine; anything else
    # is an entry this parser is not reading (a spread, an identifier, a
    # concat), so the count is not trustworthy.
    if ($0 ~ /^[[:space:]]*(\/\/|\/\*|\*|$)/) next
    cidrs = "opaque"
    next
  }
  END { if (slug != "") print slug "\t" complete "\t" cidrs "\t" asn }
' "$SEED")

if [ -z "$profiles" ]; then
  echo "check-prefix-completeness: found no game profiles in $SEED." >&2
  echo "  The parser is wrong, not the code. Fix this script before trusting it." >&2
  exit 1
fi

# The record anchor is a literal `slug: "`. A profile written
# `slug: SLUGS.newGame,` never starts a record, so its fields merge into the
# PREVIOUS profile's -- which both hides it and misattributes its
# prefixComplete to a profile that may legitimately carry one. Counting the
# slug lines both ways is what makes that visible instead of silent.
declared=$(grep -cE '^[[:space:]]*slug:' "$SEED" || true)
parsed=$(printf '%s\n' "$profiles" | grep -c . || true)
if [ "$declared" -ne "$parsed" ]; then
  echo "check-prefix-completeness: $SEED declares $declared slug lines but this" >&2
  echo "  check parsed $parsed profiles." >&2
  echo "" >&2
  echo "  A slug that is not a literal string does not start a record here," >&2
  echo "  so its fields are read as part of the profile above it and its own" >&2
  echo "  prefixComplete is never checked. Write slugs as literals, or fix" >&2
  echo "  this parser -- do not leave it silently reading the wrong rows." >&2
  echo "" >&2
  status=1
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
  if [ "$complete" = "true" ] && [ "$cidrs" = "opaque" ]; then
    echo "check-prefix-completeness: profile '$slug' in $SEED claims" >&2
    echo "  prefixComplete: true with a destinationCidrs this check cannot" >&2
    echo "  read -- an identifier, a spread or a call rather than a literal." >&2
    echo "" >&2
    echo "  The claim is then unverifiable from the seed, which is the same" >&2
    echo "  as unverified. Write the prefixes as a literal array here, or" >&2
    echo "  set prefixComplete back to false." >&2
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

# --- 5. the OTHER seed source ----------------------------------------------
#
# Invariant 3 reads game-profiles.ts, which is where the hand-researched
# profiles live -- three of them. But that file also calls seedCatalogue(),
# which upserts ~1,480 bulk rows built by toSeedRow() in catalogue/index.ts,
# and this script never opened that file. The bulk rows are ~500x the
# surface of the ones it did check.
#
# Two things hold them: toSeedRow hard-codes prefixComplete false rather
# than reading it from the entry, and validateCatalogue refuses an entry
# that smuggled the field in through hand-edited JSON. Both are one line.

if ! grep -qE '^\s*prefixComplete:\s*false,' "$BULK"; then
  echo "check-prefix-completeness: toSeedRow in $BULK no longer hard-codes" >&2
  echo "  prefixComplete: false." >&2
  echo "" >&2
  echo "  A bulk entry is not entitled to claim a complete prefix list: it" >&2
  echo "  was never researched, and there are ~1,480 of them. Reading the" >&2
  echo "  value from the entry instead would let a hand-edited curated.json" >&2
  echo "  set it on any row, which is the same account-sharing split arriving" >&2
  echo "  at scale rather than one game at a time." >&2
  echo "" >&2
  status=1
fi

if ! grep -q 'extra.prefixComplete === true' "$BULK"; then
  echo "check-prefix-completeness: validateCatalogue in $BULK no longer" >&2
  echo "  refuses a bulk entry that carries prefixComplete: true." >&2
  echo "" >&2
  echo "  CatalogueEntry deliberately does not declare the field, so the" >&2
  echo "  check is deliberately made through a cast -- the point is to catch" >&2
  echo "  one a hand-edited JSON file smuggled past the type. Losing it" >&2
  echo "  means the type is the only defence, and the type is not in the" >&2
  echo "  file the data comes from." >&2
  echo "" >&2
  status=1
fi

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

  # The two checks above ask whether some text is PRESENT in the function.
  # Presence is not control flow, and the difference is the whole gap: an
  # early return added above the real one --
  #
  #     if (profile.trusted) return true;
  #     return profile.prefixComplete === true && ...;
  #
  # leaves both strings exactly where they were and bypasses the gate
  # entirely. So the shape is checked too: this function decides one
  # thing, and it decides it in one place.
  returns=$(grep -c 'return' <<< "$(grep -vE '^\s*(\*|/\*|//)' <<< "$gate")")
  if [ "$returns" -ne 1 ]; then
    echo "check-prefix-completeness: canRouteByDestination in $CLIENT_GATE has" >&2
    echo "  $returns return statements. It must have exactly one." >&2
    echo "" >&2
    echo "  A second return is a second answer, and the checks above cannot" >&2
    echo "  see it: they ask whether the required conditions appear in the" >&2
    echo "  text, not whether every path goes through them. An early" >&2
    echo "  'if (...) return true' passes them and routes a partial prefix" >&2
    echo "  list, which is the one outcome this file exists to prevent." >&2
    echo "" >&2
    status=1
  fi
  if grep -qE '\|\|' <<< "$gate"; then
    echo "check-prefix-completeness: canRouteByDestination in $CLIENT_GATE" >&2
    echo "  contains an alternative ('||')." >&2
    echo "" >&2
    echo "  Both conditions are required, so the gate is a conjunction all" >&2
    echo "  the way through. An '|| profile.override' leaves both required" >&2
    echo "  substrings in place and makes neither of them decisive." >&2
    echo "" >&2
    status=1
  fi
fi

if [ "$status" -eq 0 ]; then
  count=$(printf '%s\n' "$profiles" | grep -c . || true)
  echo "check-prefix-completeness: ok -- $count game profile(s), the destination-routing gate is intact."
fi

exit "$status"
