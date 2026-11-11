#!/bin/bash
# nx-relay-add.sh <relayNodeName> <set> <exitConfigId> "<Exit label>"
# Runs on the panel host. Relay routes from the relay box to a new exit,
# through the backend API, on an entry set the relay already has: the
# four inbounds tagged <protocol>-<set>-in. Nothing changes in the relay
# box's own config. Prints ids and names only. DRY RUN unless NX_APPLY=1.
#
# The route names follow the relay's existing ones ("<prefix> /
# <protocol> -> <Exit label>"); the prefix is read from a route the relay
# already has, so it is not written down here.
#
# Refuses when: the relay is not exactly one RELAY node; the exit is not
# VLESS+REALITY on an EXIT or STANDALONE node (the panel's dropdown lists
# EXIT only, which is why this goes through the API); the set does not
# hold exactly the four relay protocols; an entry already has a route
# (one exit per entry, and a disabled route still counts); a route of the
# same name exists.
#
# Not here on purpose: making a NEW entry set. That generates keys on the
# relay box and rewrites its Xray config, and is done by a person.
set -euo pipefail
TOK=${NX_TOKEN_FILE:-/dev/shm/nxf/admin-token}
B=${NX_API:-http://127.0.0.1:4000}
PG=${NX_PG:-neoxify-postgres-1}
APPLY=${NX_APPLY:-0}
uuid='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
RELAY=${1:-}
SFX=${2:-}
EXIT=${3:-}
XNAME=${4:-}
die() { echo "$*" >&2; exit 1; }
[[ "$RELAY" =~ ^[a-z0-9-]{2,40}$ ]] || die "usage: nx-relay-add.sh <relayNodeName> <set> <exitConfigId> \"<Exit label>\""
[[ "$SFX" =~ ^[a-z0-9]{1,8}$ ]] || die "bad set name"
[[ "$EXIT" =~ $uuid ]] || die "bad exit config id"
[[ "$XNAME" =~ ^[A-Za-z0-9\ ]{2,40}$ ]] || die "bad exit label"
# shellcheck disable=SC2016
sql() { docker exec -i "$PG" sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB" -XtAq -v ON_ERROR_STOP=1'; }
label() {
  case "$1" in
    XRAY_VLESS_REALITY) echo "Xray VLESS+REALITY" ;;
    XRAY_VLESS_TLS) echo "Xray VLESS+TLS" ;;
    XRAY_TROJAN) echo "Xray Trojan (TLS)" ;;
    SHADOWSOCKS) echo "Shadowsocks 2022" ;;
    *) return 1 ;;
  esac
}

RID=$(sql <<<"SELECT id FROM nodes WHERE name = '$RELAY' AND role = 'RELAY';")
[[ "$RID" =~ $uuid ]] || die "relay node not found (or not unique, or not a RELAY)"
X=$(sql <<<"SELECT pc.protocol || '|' || n.role || '|' || n.name || '|' || pc.\"listenPort\" FROM protocol_configs pc JOIN nodes n ON n.id = pc.\"nodeId\" WHERE pc.id = '$EXIT';")
IFS='|' read -r XP XR XN XPORT <<<"$X"
[ "$XP" = XRAY_VLESS_REALITY ] || die "exit config is not XRAY_VLESS_REALITY (got '${XP:-none}')"
[[ "$XR" == EXIT || "$XR" == STANDALONE ]] || die "exit node role is $XR, must be EXIT or STANDALONE"
PREFIX=$(sql <<<"SELECT split_part(r.name, ' / ', 1) FROM routes r JOIN protocol_configs e ON e.id = r.\"entryProtocolConfigId\" WHERE e.\"nodeId\" = '$RID' AND r.\"exitProtocolConfigId\" IS NOT NULL AND r.name LIKE '% / % -> %' GROUP BY 1 ORDER BY count(*) DESC LIMIT 1;")
[ -n "$PREFIX" ] || die "the relay has no route to copy the naming from; name the first routes by hand"
echo "exit: $XN REALITY :$XPORT as \"$XNAME\"; entry set '$SFX'; $([ "$APPLY" = 1 ] && echo APPLY || echo DRY RUN)"

T=$(cat "$TOK")
route_free() { # name entryId
  local n
  n=$(sql <<<"SELECT count(*) FROM routes WHERE \"entryProtocolConfigId\" = '$2';")
  [ "$n" = 0 ] || die "entry $2 already has $n route(s) (disabled ones count); nothing more sent"
  n=$(sql <<<"SELECT count(*) FROM routes WHERE name = '${1//\'/\'\'}';")
  [ "$n" = 0 ] || die "a route named '$1' already exists; nothing more sent"
}
mkroute() { # name entryId
  local body r id
  route_free "$1" "$2"
  if [ "$APPLY" != 1 ]; then
    echo "would POST /routes \"$1\""
    return
  fi
  body=$(jq -n --arg name "$1" --arg e "$2" --arg x "$EXIT" '{name:$name, entryProtocolConfigId:$e, exitProtocolConfigId:$x}')
  r=$(curl -sS -X POST -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d "$body" "$B/routes")
  id=$(jq -r '.id // empty' <<<"$r")
  [ -n "$id" ] || die "route $1 FAILED: $(jq -r '.message // "?" | tostring' <<<"$r" | head -c 300)"
  echo "route $id $1"
}

ROWS=$(sql <<<"SELECT pc.id || '|' || pc.protocol || '|' || pc.\"inboundTag\" || '|' || pc.\"listenPort\" FROM protocol_configs pc WHERE pc.\"nodeId\" = '$RID' AND pc.\"isEnabled\" AND pc.\"inboundTag\" LIKE '%-$SFX-in' ORDER BY pc.protocol;")
n=$(grep -c . <<<"$ROWS" || true)
protos=$(cut -d'|' -f2 <<<"$ROWS" | sort | tr '\n' ' ')
[ "$n" = 4 ] && [ "$protos" = "SHADOWSOCKS XRAY_TROJAN XRAY_VLESS_REALITY XRAY_VLESS_TLS " ] ||
  die "expected the 4 relay protocols tagged *-$SFX-in on the relay, found $n: $protos"
# All four are checked before any is sent.
while IFS='|' read -r id p tag port; do
  route_free "$PREFIX / $(label "$p") -> $XNAME" "$id"
  echo "entry $tag :$port free"
done <<<"$ROWS"
while IFS='|' read -r id p _ _; do
  mkroute "$PREFIX / $(label "$p") -> $XNAME" "$id"
done <<<"$ROWS"
