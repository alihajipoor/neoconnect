#!/bin/bash
# nx-e2e-temp.sh <verb> <key> ...   Runs on the panel host.
# Temporary test users, for proving a server BEFORE it is in any plan.
#
# The panel refuses to issue a credential on a route the subscription's
# plan does not hold, so before the plan edit there is no panel-issued
# credential to test with. These users exist only in a running Xray,
# added and removed through its own API with no restart, and never in
# the panel's database.
#
#   gen-direct <key> <nodeName>
#       the five Xray inbounds of a new exit; the tunnel must exit on
#       that server's own address
#   gen-relay <key> <relayNodeName> <set> <exitNodeName>
#       the four entry inbounds tagged *-<set>-in on the relay box; the
#       tunnel must exit on the exit server's address
#   env <key> <PROTO>   envelope for nx-e2e-run.sh  (CONTAINS A CREDENTIAL: pipe only)
#   adu <key>           file for `xray api adu`      (CONTAINS CREDENTIALS: pipe only)
#   rmu <key>           "tag email" lines for `xray api rmu` (no secrets)
#   shred <key>
#
# PROTO: REALITY TLS WS TROJAN SS (no WS on the relay). Files live 0600
# under /dev/shm/nxf/temp/<key>; gen prints tags and test emails only.
set -euo pipefail
umask 077
HERE=$(cd "$(dirname "$0")" && pwd)
PG=${NX_PG:-neoxify-postgres-1}
CMD=${1:?verb}
KEY=${2:?key}
[[ "$KEY" =~ ^[a-z0-9-]{1,48}$ ]] || { echo "bad key" >&2; exit 2; }
D=/dev/shm/nxf/temp/$KEY
# shellcheck disable=SC2016
sql() { docker exec -i "$PG" sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB" -XtAq -v ON_ERROR_STOP=1'; }
name_ok() { [[ "$1" =~ ^[a-z0-9-]{2,40}$ ]] || { echo "bad name" >&2; exit 2; }; }

COLS="'protocol', pc.protocol, 'transport', pc.transport, 'tag', pc.\"inboundTag\", 'port', pc.\"listenPort\",
  'host', n.\"publicIp\", 'pbk', pc.\"publicParamsJson\"->>'realityPublicKey',
  'sid', pc.\"publicParamsJson\"->'shortIds'->>0, 'sni', pc.\"publicParamsJson\"->>'serverName',
  'path', pc.\"publicParamsJson\"->>'path', 'method', pc.\"publicParamsJson\"->>'method',
  'serverKey', pc.\"publicParamsJson\"->>'serverKey'"

mkcreds() { # <email prefix>
  local e
  e="$1-$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  u() { cat /proc/sys/kernel/random/uuid; }
  jq -n --arg u1 "$(u)" --arg u2 "$(u)" --arg u3 "$(u)" \
    --arg tp "$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')" \
    --arg sk "$(head -c 32 /dev/urandom | base64 | tr -d '\n')" --arg e "$e" '{
    REALITY: {uuid: $u1, flow: "xtls-rprx-vision", email: ($e + "-reality")},
    TLS: {uuid: $u2, flow: "xtls-rprx-vision", email: ($e + "-tls")},
    WS: {uuid: $u3, flow: "", email: ($e + "-ws")},
    TROJAN: {password: $tp, email: ($e + "-trojan")},
    SS: {userKey: $sk, email: ($e + "-ss")}}' >"$D/creds.json"
}

# Which config row a PROTO means, and the inbound tag when the row has none.
SEL='def rowfor($p): if $p == "REALITY" then map(select(.protocol == "XRAY_VLESS_REALITY"))[0]
       elif $p == "TLS" then map(select(.protocol == "XRAY_VLESS_TLS" and .transport != "WS"))[0]
       elif $p == "WS" then map(select(.protocol == "XRAY_VLESS_TLS" and .transport == "WS"))[0]
       elif $p == "TROJAN" then map(select(.protocol == "XRAY_TROJAN"))[0]
       else map(select(.protocol == "SHADOWSOCKS"))[0] end;
     def tagof($p): if $p == "REALITY" then "vless-in" elif $p == "TLS" then "vless-tls-in"
       elif $p == "WS" then "vless-ws-in" elif $p == "TROJAN" then "trojan-in" else "shadowsocks-in" end;'

case "$CMD" in
  gen-direct)
    NODE=${3:?node}
    name_ok "$NODE"
    mkdir -p "$D"
    sql >"$D/cfg.json" <<SQL
SELECT json_agg(json_build_object($COLS, 'expect', n."publicIp"))
FROM protocol_configs pc JOIN nodes n ON n.id = pc."nodeId"
WHERE n.name = '$NODE' AND pc."isEnabled"
  AND pc.protocol IN ('XRAY_VLESS_REALITY','XRAY_VLESS_TLS','XRAY_TROJAN','SHADOWSOCKS');
SQL
    n=$(jq 'length' "$D/cfg.json")
    [ "$n" = 5 ] || { echo "expected 5 Xray configs on $NODE, got $n" >&2; exit 1; }
    mkcreds nxtd
    echo "REALITY TLS WS TROJAN SS" >"$D/protos"
    ;;
  gen-relay)
    RELAY=${3:?relay}
    SFX=${4:?set}
    X=${5:?exit}
    name_ok "$RELAY"
    name_ok "$X"
    [[ "$SFX" =~ ^[a-z0-9]{1,8}$ ]] || { echo "bad set" >&2; exit 2; }
    mkdir -p "$D"
    sql >"$D/cfg.json" <<SQL
SELECT json_agg(json_build_object($COLS, 'expect', (SELECT x."publicIp" FROM nodes x WHERE x.name = '$X')))
FROM protocol_configs pc JOIN nodes n ON n.id = pc."nodeId"
WHERE n.name = '$RELAY' AND n.role = 'RELAY' AND pc."isEnabled" AND pc."inboundTag" LIKE '%-$SFX-in';
SQL
    n=$(jq 'length' "$D/cfg.json")
    [ "$n" = 4 ] || { echo "expected 4 entry configs in set $SFX, got $n" >&2; exit 1; }
    jq -e 'all(.[]; (.expect // "") | test("^[0-9.]+$"))' "$D/cfg.json" >/dev/null || { echo "exit address not found" >&2; exit 1; }
    mkcreds nxtr
    echo "REALITY TLS TROJAN SS" >"$D/protos"
    ;;
  env | adu | rmu)
    [ -s "$D/cfg.json" ] && [ -s "$D/creds.json" ] || { echo "run gen first" >&2; exit 1; }
    PROTOS=$(cat "$D/protos")
    if [ "$CMD" = rmu ]; then
      jq -r --slurpfile cfg "$D/cfg.json" --arg ps "$PROTOS" "$SEL"'
        ($ps | split(" ")) as $want | to_entries[] | select(.key as $k | $want | index($k)) | .key as $k
        | "\((($cfg[0] | rowfor($k)).tag) // tagof($k)) \(.value.email)"' "$D/creds.json"
    elif [ "$CMD" = adu ]; then
      # The WebSocket inbound listens on its own local port behind the TLS
      # one; the row's port is the public one.
      jq --slurpfile cfg "$D/cfg.json" --arg ps "$PROTOS" "$SEL"'
        . as $cr | $cfg[0] as $c | ($ps | split(" ")) as $want
        | {inbounds: [$want[] as $p | ($c | rowfor($p)) as $row
            | {tag: ($row.tag // tagof($p)), port: (if $p == "WS" then 10086 else $row.port end)}
              + (if $p == "TROJAN" then
                   {protocol: "trojan", settings: {clients: [{password: $cr.TROJAN.password, email: $cr.TROJAN.email}]}}
                 elif $p == "SS" then
                   {protocol: "shadowsocks", settings: {method: $row.method, password: $row.serverKey, network: "tcp,udp",
                     clients: [{password: $cr.SS.userKey, email: $cr.SS.email}]}}
                 elif $p == "WS" then
                   {protocol: "vless", settings: {decryption: "none", clients: [{id: $cr.WS.uuid, email: $cr.WS.email}]}}
                 else
                   {protocol: "vless", settings: {decryption: "none",
                     clients: [{id: $cr[$p].uuid, flow: $cr[$p].flow, email: $cr[$p].email}]}}
                 end)]}' "$D/creds.json"
    else
      P=${3:?proto}
      grep -qw -- "$P" <<<"$PROTOS" || { echo "bad proto for this key" >&2; exit 2; }
      jq -n --slurpfile cfg "$D/cfg.json" --slurpfile crs "$D/creds.json" --arg p "$P" "$SEL"'
        {c: ($cfg[0] | rowfor($p)), u: {credentials: $crs[0][$p]}}' |
        jq '.c as $c | .u as $u | '"$(cat "$HERE/nx-e2e-client.jq")"
    fi
    ;;
  shred)
    if [ -d "$D" ]; then
      shred -u "$D"/* 2>/dev/null || true
      rm -rf "$D"
    fi
    echo "shredded $KEY"
    ;;
  *)
    echo "unknown verb" >&2
    exit 2
    ;;
esac
if [ "$CMD" = gen-direct ] || [ "$CMD" = gen-relay ]; then
  jq -r '.[] | "\(.protocol)/\(.transport) tag=\(.tag // "default") port=\(.port)"' "$D/cfg.json"
  jq -r --arg ps "$(cat "$D/protos")" '($ps | split(" ")) as $w | to_entries[] | select(.key as $k | $w | index($k)) | "\(.key) \(.value.email)"' "$D/creds.json"
fi
