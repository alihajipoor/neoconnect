#!/bin/bash
# nx-dial.sh <protocolUserId> <label> [hold seconds]
# Runs on the panel host. Dials one WireGuard, OpenVPN or IKEv2 credential
# the panel issued, with the real client for it (wireguard-go + wg,
# openvpn, strongSwan's charon), inside a throwaway container, and proves
# the tunnel the way nx-e2e-run.sh proves an Xray one: the exit address
# the panel's /health/ip sees must be the server's own, and 256 KB must
# go each way through /health/bulk. Prints the same lines:
#   <label> | EXIT-MATCH | down 200 262144B ... | up 200 262144B ...
#   E2E-PASS <label>    (or E2E-FAIL)
# then, with a hold, "HOLDING <n>s" and keeps the tunnel up that long so
# the caller can read the server's own view of the session.
#
# The container, and why it cannot touch the host:
#   - its own network namespace on Docker's default bridge (no
#     --network host): the routes it changes, the default route among
#     them, are the container's. The host's routes, firewall and resolver
#     are never touched;
#   - --cap-drop ALL, then only NET_ADMIN (its own interfaces and routes)
#     and, for IKEv2, NET_BIND_SERVICE (charon's port 500). Not
#     --privileged. The one device is /dev/net/tun, for the client's own
#     TUN interface: WireGuard runs in userspace (wireguard-go) and IKEv2's
#     ESP in charon's userspace libipsec, so no kernel module is asked for;
#   - read-only root, tmpfs for /run and /tmp, 128 MB, half a CPU, 64
#     processes, no new privileges;
#   - a hard time limit inside (timeout) and outside (docker rm -f on any
#     exit of this script, failure and interrupt included). --rm as well.
# The credential is written only under /dev/shm (RAM), mode 600, mounted
# read-only into the container, and shredded on exit. It is never printed.
set -uo pipefail
PU="${1:?protocolUserId}"
L="${2:?label}"
HOLD="${3:-0}"
TOK=${NX_TOKEN_FILE:-/dev/shm/nxf/admin-token}
B=${NX_API:-http://127.0.0.1:4000}
PG=${NX_PG:-neoxify-postgres-1}
H="${NX_HEALTH:?NX_HEALTH is not set}"
IMG=nxf-dial:1
LIMIT=$((90 + HOLD))
uuid='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
[[ "$PU" =~ $uuid ]] || { echo "$L | usage: nx-dial.sh <protocolUserId> <label> [hold]"; echo "E2E-FAIL $L"; exit 2; }
[[ "$HOLD" =~ ^[0-9]+$ && "$HOLD" -le 120 ]] || { echo "$L | hold must be 0-120 seconds"; echo "E2E-FAIL $L"; exit 2; }
HERE=$(cd "$(dirname "$0")" && pwd)
umask 077
mkdir -p /dev/shm/nxf
D=$(mktemp -d /dev/shm/nxf/dial.XXXXXX)
NAME="nxf-dial-${D##*.}"
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1
  find "$D" -type f -exec shred -u {} + 2>/dev/null
  rm -rf "$D"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
fail() { echo "$L | $*"; echo "E2E-FAIL $L"; exit 1; }

docker image inspect "$IMG" >/dev/null 2>&1 || fail "the dial image $IMG is not on this host (nx-dial-image.sh builds it)"
T=$(cat "$TOK" 2>/dev/null) || fail "no admin token"
curl -fsS -H "Authorization: Bearer $T" "$B/protocol-users/$PU" >"$D/u.json" || fail "the panel did not give that credential"
# shellcheck disable=SC2016
sql() { docker exec -i "$PG" sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB" -XtAq -v ON_ERROR_STOP=1'; }
sql >"$D/c.json" <<SQL
SELECT json_build_object('protocol', pc.protocol, 'port', pc."listenPort", 'host', n."publicIp",
  'tlsCrypt', pc."publicParamsJson"->>'tlsCryptKey', 'endpointHost', pc."publicParamsJson"->>'endpointHost',
  'relay', r."exitProtocolConfigId" IS NOT NULL)
FROM protocol_users pu JOIN protocol_configs pc ON pc.id = pu."protocolConfigId" JOIN nodes n ON n.id = pc."nodeId"
LEFT JOIN routes r ON r.id = pu."routeId"
WHERE pu.id = '$PU';
SQL
[ -s "$D/c.json" ] || fail "protocol config not found"
KIND=$(jq -r '.protocol' "$D/c.json")
EXPECT=$(jq -r '.host' "$D/c.json")
[ "$(jq -r '.relay' "$D/c.json")" = false ] || fail "a relay route: this proof dials direct routes only"
CAPS=(--cap-add NET_ADMIN)
case "$KIND" in
  WIREGUARD)
    jq -r '.credentials | "[Interface]\nPrivateKey = \(.privateKey)\n\n[Peer]\nPublicKey = \(.serverPublicKey)\nAllowedIPs = 0.0.0.0/0\nEndpoint = \(.endpoint)\nPersistentKeepalive = 15"' "$D/u.json" >"$D/wg.conf"
    jq -r '.credentials.address' "$D/u.json" >"$D/wg.addr"
    jq -r '.credentials.endpoint' "$D/u.json" >"$D/endpoint"
    ;;
  OPENVPN)
    jq -r --slurpfile c "$D/c.json" '.credentials as $cr | ($cr.endpoint | capture("^(?<h>.+):(?<p>[0-9]+)$")) as $e
      | "client\ndev tun\nproto \($cr.proto // "udp")\nremote \($e.h) \($e.p)\nnobind\npersist-key\npersist-tun\nremote-cert-tls server\ncipher AES-256-GCM\nauth SHA256\nverb 3\nconnect-retry-max 3\n\(if (($cr.proto // "udp") | startswith("udp")) then "explicit-exit-notify 1\n" else "" end)server-poll-timeout 15\npull-filter ignore \"dhcp-option\"\npull-filter ignore \"block-outside-dns\"\n<ca>\n\($cr.caCertPem | rtrimstr("\n"))\n</ca>\n<cert>\n\($cr.certPem | rtrimstr("\n"))\n</cert>\n<key>\n\($cr.keyPem | rtrimstr("\n"))\n</key>\n"
        + (if $c[0].tlsCrypt then "<tls-crypt>\n\($c[0].tlsCrypt | rtrimstr("\n"))\n</tls-crypt>\n" else "" end)' "$D/u.json" >"$D/client.ovpn"
    jq -r '.credentials.endpoint' "$D/u.json" >"$D/endpoint"
    ;;
  IKEV2)
    EH=$(jq -r '.endpointHost // empty' "$D/c.json")
    [ -n "$EH" ] || fail "this server has no IKEv2 host name recorded (endpointHost): IKEv2 cannot be dialled by address"
    # The server's certificate is checked against its host name and the
    # public roots, exactly as the phone and Windows clients check it.
    jq -r --arg eh "$EH" '.credentials | "connections {\n nx {\n  version = 2\n  remote_addrs = \($eh)\n  vips = 0.0.0.0\n  encap = yes\n  proposals = aes256gcm16-prfsha384-ecp384, aes256-sha256-modp2048, default\n  local {\n   auth = eap-mschapv2\n   eap_id = \"\(.username)\"\n  }\n  remote {\n   auth = pubkey\n   id = \($eh)\n  }\n  children {\n   nx {\n    remote_ts = 0.0.0.0/0\n    esp_proposals = aes256gcm16-ecp384, aes256-sha256, default\n   }\n  }\n }\n}\nsecrets {\n eap-nx {\n  id = \"\(.username)\"\n  secret = \"\(.password)\"\n }\n}\n"' "$D/u.json" >"$D/swanctl.conf"
    echo "$EH:500" >"$D/endpoint"
    CAPS+=(--cap-add NET_BIND_SERVICE)
    ;;
  *) fail "not a WireGuard, OpenVPN or IKEv2 credential ($KIND)" ;;
esac
shred -u "$D/u.json"
cp "$HERE/nx-dial-inner.sh" "$D/inner.sh"
chmod 600 "$D"/*
chmod 755 "$D/inner.sh" "$D"
head -c 262144 /dev/urandom >"$D/body"
chmod 644 "$D/body"

# The container's name: the caller ends the hold early with
# `docker exec <name> touch /tmp/release` once it has read the server.
echo "DIAL $NAME"
timeout -k 5 $((LIMIT + 15)) docker run --rm --name "$NAME" --label nxf-dial=1 \
  --network bridge --cap-drop ALL "${CAPS[@]}" --device /dev/net/tun \
  --security-opt no-new-privileges --read-only --tmpfs /run --tmpfs /tmp \
  --memory 128m --memory-swap 128m --cpus 0.5 --pids-limit 64 \
  -e NX_HEALTH="$H" -e NX_EXPECT="$EXPECT" -e NX_HOLD="$HOLD" -e NX_LABEL="$L" \
  -v "$D:/nx:ro" "$IMG" timeout -k 3 "$LIMIT" /nx/inner.sh "${KIND,,}" 2>&1 |
  sed -u -E 's/[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/<ip>/g; /PRIVATE KEY|BEGIN CERT|secret|password|PrivateKey/Id'
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || exit 1
