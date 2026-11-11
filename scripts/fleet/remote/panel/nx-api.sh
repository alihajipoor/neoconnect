#!/bin/bash
# nx-api.sh <verb> ...   Runs on the panel host. The few admin API calls
# the checklist makes that are not a plan edit. Prints ids and status
# codes only.
#
#   route-delete <routeId>...
#       DELETE /routes/:id. For a relay route this is the hot path: the
#       backend sends DELETE_USER per user, then REMOVE_ROUTE to the
#       relay, whose agent removes the rule and the outbound from the
#       running Xray with no restart, and the entry inbounds become free
#       for another exit. (An SQL disable leaves the rule in the running
#       process, where it keeps winning, and keeps the entry taken.)
#   incident-retire <incidentId> <note>
#       close an OPEN block incident as retired; block watch then skips
#       the server while it keeps that address
#   tx-errors <minutes>
#       how often the backend failed to start a transaction lately
#
# There is deliberately no verb for DELETE /nodes: it deletes the
# server's usage history in the same transaction.
set -uo pipefail
TOK=${NX_TOKEN_FILE:-/dev/shm/nxf/admin-token}
API=${NX_API:-http://127.0.0.1:4000}
BACKEND=${NX_BACKEND:-neoxify-backend-1}
uuid='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
verb=${1:-}
shift || true
case "$verb" in
  route-delete)
    [ $# -ge 1 ] || { echo "no route id"; exit 2; }
    bad=0
    for id in "$@"; do
      [[ "$id" =~ $uuid ]] || { echo "bad route id"; exit 2; }
      code=$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE -H "Authorization: Bearer $(cat "$TOK")" "$API/routes/$id")
      echo "$id $code"
      case "$code" in 200 | 204 | 404) ;; *) bad=1 ;; esac
    done
    exit $bad
    ;;
  incident-retire)
    [[ "${1:-}" =~ $uuid ]] || { echo "bad incident id"; exit 2; }
    body=$(jq -cn --arg note "${2:-retired}" '{action:"retired", note:$note}')
    curl -sS -X POST -H "Authorization: Bearer $(cat "$TOK")" -H 'Content-Type: application/json' -d "$body" \
      "$API/block-watch/incidents/$1/action" | jq -r '"incident status: " + ((.status // .message // "?") | tostring)'
    ;;
  tx-errors)
    echo "tx-errors=$(docker logs --since "${1:-3}m" "$BACKEND" 2>&1 | grep -c "Unable to start a transaction")"
    ;;
  *)
    echo "usage: nx-api.sh route-delete|incident-retire|tx-errors ..." >&2
    exit 2
    ;;
esac
