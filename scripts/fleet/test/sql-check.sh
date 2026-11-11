#!/usr/bin/env bash
# Runs every query in scripts/fleet/sql/fleet.sql against a real
# database with the current schema, and rolls each one back.
#
#   DATABASE_URL=postgresql://... bash scripts/fleet/test/sql-check.sh
#
# An empty, freshly migrated database is enough: Postgres checks every
# table and column a query names when it plans it, rows or no rows. So
# this is where a renamed column is found -- in CI, against the schema
# the migrations produce -- and not halfway through retiring a server.
# The queries are written against production by hand; nothing else runs
# them before a real server change does.
#
# Each block gets its variables from its own header ("-- @@ name (mode)
# var ..."), with harmless stand-in values. Write blocks run too, inside
# a transaction that is rolled back.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL="$HERE/../sql/fleet.sql"
URL="${DATABASE_URL:?DATABASE_URL is not set}"
# Prisma's ?schema=public is not something psql accepts.
URL="${URL%%\?*}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mapfile -t headers < <(grep '^-- @@ ' "$SQL")
[[ ${#headers[@]} -ge 20 ]] || { echo "found only ${#headers[@]} queries in fleet.sql" >&2; exit 1; }

failed=0
for header in "${headers[@]}"; do
  read -r _ _ name mode vars <<<"$header"
  mode="${mode//[()]/}"
  [[ "$mode" == read || "$mode" == write ]] || { echo "FAIL $name: mode must be (read) or (write), got $mode"; failed=1; continue; }

  args=()
  for v in $vars; do
    case "$v" in
      col) args+=(-v "col=name") ;;
      minutes) args+=(-v "minutes=5") ;;
      *) args+=(-v "$v=sql-check") ;;
    esac
  done

  # The block, exactly as lib/remote.sh cuts it out.
  awk -v want="$name" '
    /^-- @@ / { on = ($3 == want); next }
    on { print }
  ' "$SQL" >"$WORK/body.sql"
  { echo "BEGIN;"; cat "$WORK/body.sql"; echo "ROLLBACK;"; } >"$WORK/run.sql"

  # Every variable the block uses must be named in its header, or the
  # tool would send the query with a hole in it.
  used="$(grep -v '^[[:space:]]*--' "$WORK/body.sql" | grep -oE ":[\"'][a-z_]+[\"']" | tr -d ":\"'" | sort -u | tr '\n' ' ')"
  for u in $used; do
    case " $vars " in *" $u "*) ;; *) echo "FAIL $name: uses :$u, which its header does not list"; failed=1 ;; esac
  done

  if out="$(psql "$URL" -X -q -At -v ON_ERROR_STOP=1 "${args[@]}" -f "$WORK/run.sql" 2>&1)"; then
    echo "ok   $name ($mode)"
  else
    echo "FAIL $name ($mode):"
    echo "$out" | sed 's/^/     /'
    failed=1
  fi
done

[[ $failed -eq 0 ]] || exit 1
echo "all ${#headers[@]} fleet queries run against this schema"
