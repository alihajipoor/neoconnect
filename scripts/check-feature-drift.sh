#!/usr/bin/env bash
# Fails when a plan feature exists in the database schema but not in the panel
# that has to grant it.
#
# The sibling of check-protocol-drift.sh, and it exists for the same reason
# that one does. SHADOWSOCKS and IKEV2 were deployed to real nodes and dialled
# by real customers while the panel could not select either -- so a plan
# created there could not grant them, and nothing failed. No error, no
# warning, no red build. The absence of an option looks exactly like a
# decision not to offer it, which is why it survived long enough to be found
# by eye while filling in a form.
#
# Plan features are more exposed to that than protocols are, not less. A
# feature is granted by ticking a box; if the box does not exist, the
# capability is simply unreachable and the only symptom is a customer who
# does not have something nobody realised they were not being given.
#
# The panel keeps its own hand-written copy of the union because it is a
# separate build with no import path to Prisma. Record<PlanFeatureKey, true>
# inside the panel makes an omission *there* a compile error; nothing but this
# can catch the panel's union drifting from the schema itself.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

SCHEMA="apps/backend/prisma/schema.prisma"
PANEL_TYPES="apps/panel/src/lib/types.ts"

for f in "$SCHEMA" "$PANEL_TYPES"; do
  [ -f "$f" ] || { echo "check-feature-drift: missing $f" >&2; exit 1; }
done

# Members of `enum PlanFeatureKey { ... }`, ignoring the doc comments between
# them. sed pulls the block; grep keeps only bare uppercase identifiers.
schema_features=$(
  sed -n '/^enum PlanFeatureKey {/,/^}/p' "$SCHEMA" |
    grep -oE '^  [A-Z][A-Z0-9_]*$' |
    tr -d ' ' | sort
)

# The panel's union members, which are quoted strings in a type alias.
panel_features=$(
  sed -n '/^export type PlanFeatureKey =/,/;$/p' "$PANEL_TYPES" |
    grep -oE '"[A-Z][A-Z0-9_]*"' |
    tr -d '"' | sort
)

if [ -z "$schema_features" ]; then
  echo "check-feature-drift: found no features in $SCHEMA -- the parser is wrong, not the code" >&2
  exit 1
fi

missing_in_panel=$(comm -23 <(echo "$schema_features") <(echo "$panel_features"))
extra_in_panel=$(comm -13 <(echo "$schema_features") <(echo "$panel_features"))

status=0

if [ -n "$missing_in_panel" ]; then
  echo "The panel is missing plan features that exist in the schema:" >&2
  echo "$missing_in_panel" | sed 's/^/  - /' >&2
  echo >&2
  echo "Add them to the PlanFeatureKey union and PLAN_FEATURE_PRESENCE in" >&2
  echo "$PANEL_TYPES. Until then no plan can grant them, and nothing else" >&2
  echo "would ever say so." >&2
  status=1
fi

if [ -n "$extra_in_panel" ]; then
  echo "The panel offers plan features the schema does not have:" >&2
  echo "$extra_in_panel" | sed 's/^/  - /' >&2
  echo "Granting one would be rejected by the API." >&2
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "check-feature-drift: panel and schema agree ($(echo "$schema_features" | wc -l | tr -d ' ') features)"
fi

exit "$status"
