#!/bin/bash
# reality-trial.sh <verb> ...   Runs on the box being built, BEFORE the installer.
#
# Proves that REALITY can work through a disguise site from THIS box, with
# a real handshake from outside, before a server is built on that site.
#
# A node was once built on a site that speaks TLS 1.3 and HTTP/2 with a
# valid certificate and refuses X25519. REALITY needs X25519: it came up,
# looked healthy, and every client was handed the site's real certificate.
# That was found by the first test tunnel, with the site already written
# into the server's config, the panel's protocol config and the server
# row, and all three had to be changed by hand. The dest audit checks
# for that now, but a check is a reading. This is the thing itself: a
# throwaway Xray with one REALITY inbound on this box, on the port the
# real one will use, with keys that exist for a minute, dialled from the
# panel host by the same client the later proofs use.
#
#   start <dest host> <dest port> <xray version>
#         TRIAL-UP, or TRIAL-ENROLLED when the box already is a server
#         (its own Xray holds the port; its tunnels are the proof then)
#   params <this box's public address>
#         {c, u} for nx-e2e-pipe.sh on the panel host.
#         CONTAINS THE THROWAWAY KEYS: only ever pipe it, never display it
#   log   the last lines of the trial server's log, addresses masked
#   stop  kill it, shred its files
#   status   up | down
#
# The trial server runs as root for its minute: it binds 443 and nobody
# is on the box. It is a separate process, never touches a service, and
# ends by itself after ten minutes if nobody stops it.
set -uo pipefail
umask 077
HERE=$(cd "$(dirname "$0")" && pwd)
D=/dev/shm/nxf/trial
PORT=443
verb=${1:-}
shift || true

running() { [ -s "$D/pid" ] && kill -0 "$(cat "$D/pid")" 2>/dev/null; }
# Read first, matched after: under pipefail a grep that stops at its first
# match fails the pipe it was reading.
listening() {
  local l
  l=$(ss -ltnH 2>/dev/null | awk '{print $4}')
  grep -q ":$PORT\$" <<<"$l"
}

stop_trial() {
  if [ -s "$D/pid" ]; then
    kill "$(cat "$D/pid")" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      running || break
      sleep 0.3
    done
  fi
  # Whatever is left of it, by the one thing only it has on its command line.
  pkill -9 -f -- "$D/server.json" 2>/dev/null
  if [ -d "$D" ]; then
    find "$D" -type f ! -name xray -exec shred -u {} + 2>/dev/null
    rm -rf "$D"
  fi
}

case "$verb" in
  start)
    DEST=${1:?dest host}
    DPORT=${2:?dest port}
    VER=${3:?xray version}
    [[ "$DEST" =~ ^[a-z0-9.-]+$ && "$DPORT" =~ ^[0-9]+$ ]] || { echo "FAIL bad dest"; exit 2; }
    if [ -f /etc/neoxify/agent.json ]; then
      echo "TRIAL-ENROLLED"
      exit 0
    fi
    stop_trial
    if listening; then
      echo "FAIL port $PORT is already taken on this box, so no trial inbound can listen there"
      exit 1
    fi
    for t in jq curl python3 ss; do
      command -v "$t" >/dev/null 2>&1 || { echo "FAIL $t is not installed on this box"; exit 1; }
    done
    mkdir -p "$D"
    "$HERE/nx-xray-get.sh" "$VER" "$D/xray" >/dev/null || { echo "FAIL could not fetch Xray $VER"; exit 1; }
    K=$("$D/xray" x25519 2>/dev/null)
    # "PrivateKey: .." and "Password (PublicKey): .." on current builds,
    # "Private key: .." and "Public key: .." on older ones.
    PRIV=$(sed -n -E 's/^Private ?[Kk]ey: *//p' <<<"$K" | head -1)
    PUB=$(sed -n -E 's/^.*Public ?[Kk]ey\)?: *//p' <<<"$K" | head -1)
    [ -n "$PRIV" ] && [ -n "$PUB" ] || { echo "FAIL could not make a key pair with this Xray"; exit 1; }
    U=$(cat /proc/sys/kernel/random/uuid)
    SID=$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')
    # The same inbound the installer's template writes, and the same
    # IPv4-only way out.
    jq -n --arg dest "$DEST:$DPORT" --arg host "$DEST" --arg priv "$PRIV" --arg sid "$SID" --arg u "$U" --argjson port "$PORT" '{
      log: {loglevel: "info"},
      inbounds: [{listen: "0.0.0.0", port: $port, protocol: "vless", tag: "trial-in",
        settings: {clients: [{id: $u, flow: "xtls-rprx-vision", email: "nxt-trial"}], decryption: "none"},
        streamSettings: {network: "tcp", security: "reality",
          realitySettings: {show: false, dest: $dest, xver: 0, serverNames: [$host], privateKey: $priv, shortIds: [$sid]}}}],
      outbounds: [{protocol: "freedom", tag: "direct", settings: {domainStrategy: "ForceIPv4"}}]}' >"$D/server.json"
    jq -n --arg host "$DEST" --arg pub "$PUB" --arg sid "$SID" --arg u "$U" --argjson port "$PORT" '{
      c: {protocol: "XRAY_VLESS_REALITY", transport: "TCP", port: $port, pbk: $pub, sid: $sid, sni: $host},
      u: {credentials: {uuid: $u, flow: "xtls-rprx-vision"}}}' >"$D/params.json"
    if ! "$D/xray" run -test -c "$D/server.json" >/dev/null 2>&1; then
      echo "FAIL Xray refuses the trial config:"
      "$D/xray" run -test -c "$D/server.json" 2>&1 | tail -3
      stop_trial
      exit 1
    fi
    # Under a timeout: a trial that a dead run never came back for ends
    # by itself, and the port is free again.
    nohup timeout 600 "$D/xray" run -c "$D/server.json" >"$D/log" 2>&1 </dev/null &
    echo $! >"$D/pid"
    for _ in $(seq 1 20); do
      listening && break
      sleep 0.3
    done
    if running && listening; then
      echo "TRIAL-UP"
    else
      echo "FAIL the trial inbound did not come up:"
      tail -3 "$D/log" 2>/dev/null | sed -E 's/[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/<ip>/g'
      stop_trial
      exit 1
    fi
    ;;

  params)
    IP=${1:?the public address of this box}
    [ -s "$D/params.json" ] || { echo "no trial is running" >&2; exit 1; }
    jq --arg ip "$IP" '.c.host = $ip | .c.expect = $ip' "$D/params.json"
    ;;

  log)
    tail -"${1:-12}" "$D/log" 2>/dev/null | sed -E 's/[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/<ip>/g' | cut -c1-200
    ;;

  stop)
    stop_trial
    if running; then
      echo "FAIL the trial server is still running"
      exit 1
    fi
    echo "TRIAL-DOWN"
    ;;

  status)
    if running; then echo up; else echo down; fi
    [ -e "$D/server.json" ] && echo "files-left"
    exit 0
    ;;

  *)
    echo "usage: reality-trial.sh start|params|log|stop|status" >&2
    exit 2
    ;;
esac
