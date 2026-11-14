#!/bin/bash
# nx-canary.sh <verb> ...   Runs on the panel host. The canary plan
# ("Internal test" unless NX_CANARY_PLAN says otherwise): a new server is
# proven through it, with credentials the panel itself issues, before any
# customer plan holds the server.
#
#   activate <planId>             isActive on, if it is off. Refuses unless the plan
#                                 carries the canary name and is NOT purchasable: an
#                                 active purchasable plan is one customers can buy.
#                                 Sends {"isActive": true} and nothing else.
#   restore <planId> <true|false> isActive back to what it was. Nothing else is sent.
#   assign <customerId> <planId>  POST /subscriptions/assign for the test account
#   unassign <subscriptionId>     DELETE /subscriptions/:id, only for a subscription
#                                 on the canary plan (revokes its credentials)
#
# isPurchasable is never sent, and no other plan is ever touched: every
# verb reads the plan first and refuses one with another name. After a
# PATCH the plan's route set must be exactly what it was. Prints ids,
# flags and status codes only.
set -uo pipefail
TOK=${NX_TOKEN_FILE:-/dev/shm/nxf/admin-token}
API=${NX_API:-http://127.0.0.1:4000}
PG=${NX_PG:-neoxify-postgres-1}
NAME=${NX_CANARY_PLAN:-Internal test}
uuid='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
auth() { printf 'Authorization: Bearer %s' "$(cat "$TOK")"; }

plan_get() { # <planId> -> the plan's JSON, or exit
  local out
  out=$(curl -fsS -H "$(auth)" "$API/plans/$1") || { echo "could not read plan" >&2; exit 1; }
  [ "$(jq -r .name <<<"$out")" = "$NAME" ] || { echo "REFUSED: that plan is not named '$NAME'; nothing sent" >&2; exit 1; }
  printf '%s' "$out"
}
flags() { jq -r '"isActive=\(.isActive) isPurchasable=\(.isPurchasable) routes=\([.allowedRoutes[]?] | length)"' <<<"$1"; }
routeset() { jq -r '[.allowedRoutes[]?.id] | sort | join(",")' <<<"$1"; }

patch_active() { # <planId> <true|false> <the plan's JSON before>
  local res code out
  res=$(curl -sS -w '\n%{http_code}' -X PATCH -H "$(auth)" -H 'Content-Type: application/json' \
    -d "{\"isActive\":$2}" "$API/plans/$1")
  code=${res##*$'\n'}
  out=${res%$'\n'*}
  [ "$code" = 200 ] || { echo "PATCH -> $code"; exit 1; }
  echo "after:  $(flags "$out")"
  [ "$(jq -r .isActive <<<"$out")" = "$2" ] || { echo "isActive did not become $2"; exit 1; }
  [ "$(jq -r .isPurchasable <<<"$out")" = "$(jq -r .isPurchasable <<<"$3")" ] || { echo "isPurchasable CHANGED"; exit 1; }
  [ "$(routeset "$out")" = "$(routeset "$3")" ] || { echo "ROUTE SET CHANGED"; exit 1; }
}

verb=${1:-}
shift || true
case "$verb" in
  activate)
    [[ "${1:-}" =~ $uuid ]] || { echo "bad plan id"; exit 2; }
    cur=$(plan_get "$1") || exit 1
    echo "before: $(flags "$cur")"
    [ "$(jq -r .isPurchasable <<<"$cur")" = false ] || { echo "REFUSED: '$NAME' is purchasable: made active, customers could buy it. Nothing sent"; exit 3; }
    if [ "$(jq -r .isActive <<<"$cur")" = true ]; then
      echo "already-active"
      exit 0
    fi
    patch_active "$1" true "$cur"
    echo "activated"
    ;;
  restore)
    [[ "${1:-}" =~ $uuid ]] || { echo "bad plan id"; exit 2; }
    case "${2:-}" in true | false) ;; *) echo "restore to true or false"; exit 2 ;; esac
    cur=$(plan_get "$1") || exit 1
    echo "before: $(flags "$cur")"
    if [ "$(jq -r .isActive <<<"$cur")" = "$2" ]; then
      echo "already-as-before"
      exit 0
    fi
    patch_active "$1" "$2" "$cur"
    echo "restored"
    ;;
  assign)
    [[ "${1:-}" =~ $uuid && "${2:-}" =~ $uuid ]] || { echo "bad id"; exit 2; }
    cur=$(plan_get "$2") || exit 1
    jq -e '.isActive == true and .isPurchasable == false' <<<"$cur" >/dev/null || { echo "REFUSED: the canary plan is not active-and-not-purchasable ($(flags "$cur")); nothing sent"; exit 1; }
    res=$(curl -sS -w '\n%{http_code}' -X POST -H "$(auth)" -H 'Content-Type: application/json' \
      -d "$(jq -cn --arg c "$1" --arg p "$2" '{customerId: $c, planId: $p}')" "$API/subscriptions/assign")
    code=${res##*$'\n'}
    out=${res%$'\n'*}
    case "$code" in 200 | 201) ;; *) echo "POST -> $code $(printf '%s' "$out" | jq -r '.message // empty' 2>/dev/null | head -c 200)"; exit 1 ;; esac
    id=$(jq -r '.id // empty' <<<"$out")
    [[ "$id" =~ $uuid ]] || { echo "POST -> $code, but no subscription id came back"; exit 1; }
    echo "sub $id $(jq -r '.status // "?"' <<<"$out")"
    ;;
  unassign)
    [[ "${1:-}" =~ $uuid ]] || { echo "bad subscription id"; exit 2; }
    row=$(docker exec -i "$PG" sh -c 'psql -X -At -F "|" -v ON_ERROR_STOP=1 -v sub="$1" -U "$POSTGRES_USER" -d "$POSTGRES_DB"' sh "$1" <<'SQL'
SELECT sp.name FROM subscriptions s JOIN subscription_plans sp ON sp.id = s."planId" WHERE s.id::text = :'sub';
SQL
    )
    if [ -z "$row" ]; then
      echo "already-gone"
      exit 0
    fi
    [ "$row" = "$NAME" ] || { echo "REFUSED: that subscription is not on '$NAME'; nothing sent"; exit 1; }
    code=$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE -H "$(auth)" "$API/subscriptions/$1")
    echo "DELETE -> $code"
    case "$code" in 200 | 204 | 404) ;; *) exit 1 ;; esac
    ;;
  *)
    echo "usage: nx-canary.sh activate|restore|assign|unassign ..." >&2
    exit 2
    ;;
esac
