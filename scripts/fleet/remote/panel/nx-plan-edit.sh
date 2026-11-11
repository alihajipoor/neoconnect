#!/bin/bash
# nx-plan-edit.sh <planId> '<json ids to add>' '<json ids to remove>' [defaultRouteId]
# Runs on the panel host. Reads the plan's CURRENT allowedRouteIds right
# before the PATCH and sends the full new list.
#
# NX_EXPECT_NEW, when set, names a file holding the list the operator's
# PC computed (lib/planlist.mjs). The list computed here must equal it,
# or nothing is sent: two implementations, and a plan that changed in
# between, both stop here.
#
# Never sends an empty list: an empty allowedRouteIds revokes every
# subscriber on the plan. Edits of one plan are serialised with flock.
# The backend on the host has no /api prefix. An HTTP 413 means the body
# was wrong (100 KB limit) and nothing changed.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
TOK=${NX_TOKEN_FILE:-/dev/shm/nxf/admin-token}
API=${NX_API:-http://127.0.0.1:4000}
[ $# -ge 3 ] || { echo "usage: nx-plan-edit.sh <planId> '<add json>' '<remove json>' [defaultRouteId]" >&2; exit 2; }
PLAN=$1
ADD=$2
DEL=$3
DEF=${4:-}
TS=$(date -u +%Y%m%dT%H%M%SZ)
uuid='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
[[ "$PLAN" =~ $uuid ]] || { echo "bad planId"; exit 1; }
[ -z "$DEF" ] || [[ "$DEF" =~ $uuid ]] || { echo "bad defaultRouteId"; exit 1; }
for a in "$ADD" "$DEL"; do
  jq -en --argjson x "$a" '($x|type=="array") and ($x|all(.[]; type=="string" and test("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")))' >/dev/null ||
    { echo "add/remove must be JSON arrays of route ids; nothing sent"; exit 1; }
done
jq -en --argjson a "$ADD" --argjson d "$DEL" '($a - ($a - $d)) | length == 0' >/dev/null ||
  { echo "an id is in both add and remove; nothing sent"; exit 1; }
exec 9>"/dev/shm/nx-plan-edit-$PLAN.lock"
flock -w 1800 9 || { echo "plan is locked by another edit; nothing sent"; exit 1; }
# After waiting on the lock the token may be old: mint again past 10 minutes.
if [ -z "$(find "$TOK" -mmin -10 2>/dev/null)" ]; then "$HERE/nx-mint.sh" "$TOK" >/dev/null; fi
T=$(cat "$TOK")
cur=$(curl -fsS -H "Authorization: Bearer $T" "$API/plans/$PLAN")
old=$(jq -c '[.allowedRoutes[].id]' <<<"$cur")
mkdir -p /root/db-backups
echo "$old" >"/root/db-backups/plan-routes-before-$PLAN-$TS.json"
# List subtraction. Never `[.[] as $x | select()]`: that emits the whole
# array once per match.
new=$(jq -c --argjson a "$ADD" --argjson d "$DEL" '((. - $d) + $a) | unique' <<<"$old")
jq -en --argjson n "$new" --argjson o "$old" --argjson a "$ADD" --argjson d "$DEL" --arg def "$DEF" '
  ($n|length) > 0
  and ($n|all(.[]; type=="string" and length==36))
  and (($a - $n)|length) == 0
  and (($n - ($n - $d))|length) == 0
  and ((($n - $a)|unique|sort) == ((($o - $d) - $a)|unique|sort))
  and ($def == "" or ($n|index($def)) != null)' >/dev/null ||
  { echo "GUARD FAILED, nothing sent"; exit 1; }
if [ -n "${NX_EXPECT_NEW:-}" ]; then
  jq -e --argjson n "$new" '(. | unique | sort) == ($n | sort)' "$NX_EXPECT_NEW" >/dev/null ||
    { echo "GUARD FAILED: the plan is not what the checklist computed from (it changed, or the two computations differ); nothing sent"; exit 1; }
fi
body=$(jq -cn --argjson ids "$new" --arg def "$DEF" '{allowedRouteIds:$ids} + (if $def=="" then {} else {defaultRouteId:$def} end)')
echo "$(jq -r .name <<<"$cur"): $(jq length <<<"$old") -> $(jq length <<<"$new") routes, sending PATCH at $(date -u +%H:%M:%SZ); before-list saved as plan-routes-before-$PLAN-$TS.json"
res=$(curl -fsS -X PATCH -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d "$body" "$API/plans/$PLAN")
jq -c --argjson want "$new" '{plan: .name, count: ([.allowedRoutes[].id]|length), missing: ($want - [.allowedRoutes[].id]), extra: ([.allowedRoutes[].id] - $want), defaultRouteId}' <<<"$res"
if jq -e --argjson want "$new" '(($want - [.allowedRoutes[].id])|length) == 0 and (([.allowedRoutes[].id] - $want)|length) == 0' <<<"$res" >/dev/null; then
  echo "PLAN-EDIT-OK"
fi
