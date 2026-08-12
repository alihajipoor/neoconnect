#!/usr/bin/env bash
# Fails when a protocol exists in the database schema but not in the
# clients that have to offer it.
#
# This exists because it already happened, twice over and unnoticed.
# SHADOWSOCKS and IKEV2 were both deployed to real nodes and dialled by
# real customers while the panel could not select either one -- so a plan
# created there could not grant them, and a node could not be configured
# for them at all. With failover provisioning a credential on every route
# a plan allows, customers on such a plan would simply never receive
# those protocols.
#
# Nothing failed. No error, no warning, no red build. The absence of an
# option looks exactly like a decision not to offer it, which is why this
# survived long enough to be found by eye while filling in a form.
#
# The panel keeps its own hand-written copy of the enum because it is a
# separate build with no import path to Prisma. A Record<Protocol, true>
# inside the panel now makes an omission there a compile error, but
# nothing could catch the panel's union drifting from the schema itself.
# This does.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

SCHEMA="apps/backend/prisma/schema.prisma"
PANEL_TYPES="apps/panel/src/lib/types.ts"

for f in "$SCHEMA" "$PANEL_TYPES"; do
  [ -f "$f" ] || { echo "check-protocol-drift: missing $f" >&2; exit 1; }
done

# Members of `enum Protocol { ... }`, ignoring the doc comments between
# them. sed pulls the block; grep keeps only bare uppercase identifiers.
schema_protocols=$(
  sed -n '/^enum Protocol {/,/^}/p' "$SCHEMA" |
    grep -oE '^  [A-Z][A-Z0-9_]*$' |
    tr -d ' ' | sort
)

# The panel's union members, which are quoted strings in a type alias.
panel_protocols=$(
  sed -n '/^export type Protocol =/,/;$/p' "$PANEL_TYPES" |
    grep -oE '"[A-Z][A-Z0-9_]*"' |
    tr -d '"' | sort
)

if [ -z "$schema_protocols" ]; then
  echo "check-protocol-drift: found no protocols in $SCHEMA -- the parser is wrong, not the code" >&2
  exit 1
fi

missing_in_panel=$(comm -23 <(echo "$schema_protocols") <(echo "$panel_protocols"))
extra_in_panel=$(comm -13 <(echo "$schema_protocols") <(echo "$panel_protocols"))

status=0

if [ -n "$missing_in_panel" ]; then
  echo "The panel is missing protocols that exist in the schema:" >&2
  echo "$missing_in_panel" | sed 's/^/  - /' >&2
  echo >&2
  echo "Add them to the Protocol union and PROTOCOL_PRESENCE in $PANEL_TYPES," >&2
  echo "then to PROTOCOL_LABELS and DEFAULT_PROTOCOL_PORT (the compiler will" >&2
  echo "insist once the union is right). Until then the panel cannot grant" >&2
  echo "them to a plan or configure a node for them." >&2
  status=1
fi

if [ -n "$extra_in_panel" ]; then
  echo "The panel offers protocols the schema does not have:" >&2
  echo "$extra_in_panel" | sed 's/^/  - /' >&2
  echo "Selecting one would be rejected by the API." >&2
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "check-protocol-drift: panel and schema agree ($(echo "$schema_protocols" | wc -l | tr -d ' ') protocols)"
fi

exit "$status"
