#!/bin/bash
# nx-e2e-build.sh <protocolUserId>
# Runs on the panel host. Prints an envelope {nxExpectIp, nxProto,
# config} where config is an Xray CLIENT config built from a credential
# the panel issued. IT CONTAINS THE CREDENTIAL: only ever pipe it into
# nx-e2e-run.sh, never display it.
#
# nxExpectIp is the address the tunnel must exit from: the route's exit
# server for a relay route, the entry server for a direct one. The run
# script compares it and prints only EXIT-MATCH or EXIT-MISMATCH.
# Protocols: VLESS+REALITY, VLESS+TLS over TCP or WebSocket, Trojan,
# Shadowsocks (UDP-over-TCP on, plus a UDP DNS inbound so the run script
# can test DNS through it).
set -euo pipefail
TOK=${NX_TOKEN_FILE:-/dev/shm/nxf/admin-token}
B=${NX_API:-http://127.0.0.1:4000}
PG=${NX_PG:-neoxify-postgres-1}
uuid='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
[[ "${1:-}" =~ $uuid ]] || { echo "usage: nx-e2e-build.sh <protocolUserId>" >&2; exit 2; }
T=$(cat "$TOK")
U=$(curl -fsS -H "Authorization: Bearer $T" "$B/protocol-users/$1")
PC=$(jq -r .protocolConfigId <<<"$U")
[[ "$PC" =~ $uuid ]] || { echo "no protocolConfigId" >&2; exit 1; }
# shellcheck disable=SC2016
sql() { docker exec -i "$PG" sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB" -XtAq -v ON_ERROR_STOP=1'; }
CFG=$(
  sql <<SQL
SELECT json_build_object('protocol', pc.protocol, 'transport', pc.transport, 'port', pc."listenPort",
  'host', n."publicIp", 'pbk', pc."publicParamsJson"->>'realityPublicKey',
  'sid', pc."publicParamsJson"->'shortIds'->>0, 'sni', pc."publicParamsJson"->>'serverName',
  'path', pc."publicParamsJson"->>'path', 'method', pc."publicParamsJson"->>'method',
  'serverKey', pc."publicParamsJson"->>'serverKey',
  'expect', COALESCE((SELECT xn."publicIp" FROM protocol_users pu JOIN routes r ON r.id = pu."routeId"
                      JOIN protocol_configs xc ON xc.id = r."exitProtocolConfigId" JOIN nodes xn ON xn.id = xc."nodeId"
                      WHERE pu.id = '$1'), n."publicIp"))
FROM protocol_configs pc JOIN nodes n ON n.id = pc."nodeId" WHERE pc.id = '$PC';
SQL
)
[ -n "$CFG" ] || { echo "protocol config not found" >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
jq -n --argjson u "$U" --argjson c "$CFG" -f "$HERE/nx-e2e-client.jq"
