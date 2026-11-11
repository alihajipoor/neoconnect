#!/bin/sh
# nx-mint.sh [output path]   (default: $NX_TOKEN_FILE, else /dev/shm/nxf/admin-token)
# Runs on the panel host. Mints a 15-minute SUPERADMIN access token with
# the backend's own secret, inside the backend container, and writes it
# 0600 to the output path, which must be under /dev/shm (RAM, gone at
# reboot). Prints nothing secret: only the time and the status of one
# GET /nodes made with it.
#
# The token is checked only when a request starts, so a long request
# outlives it; anything that waits (a plan lock) mints again.
set -eu
umask 077
OUT=${1:-${NX_TOKEN_FILE:-/dev/shm/nxf/admin-token}}
API=${NX_API:-http://127.0.0.1:4000}
PG=${NX_PG:-neoxify-postgres-1}
BACKEND=${NX_BACKEND:-neoxify-backend-1}
case "$OUT" in /dev/shm/*) ;; *) echo "output must be under /dev/shm" >&2; exit 1 ;; esac
case "$OUT" in *..* | */) echo "bad output path" >&2; exit 1 ;; esac
mkdir -p "$(dirname "$OUT")"
# shellcheck disable=SC2016
ADM=$(docker exec "$PG" sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB" -XtAq -F "|" -c "SELECT id, email FROM admin_users WHERE role = '\''SUPERADMIN'\''"')
n=$(printf '%s\n' "$ADM" | grep -c . || true)
[ "$n" = 1 ] || { echo "expected exactly 1 SUPERADMIN, got $n" >&2; exit 1; }
ID=${ADM%%|*}
EM=${ADM#*|}
TMP="$OUT.tmp.$$"
trap 'rm -f "$TMP"' EXIT
docker exec -e NX_SUB="$ID" -e NX_EMAIL="$EM" "$BACKEND" node -e '
const c=require("crypto");
const b=o=>Buffer.from(JSON.stringify(o)).toString("base64url");
const now=Math.floor(Date.now()/1000);
const h=b({alg:"HS256",typ:"JWT"});
const p=b({sub:process.env.NX_SUB,email:process.env.NX_EMAIL,role:"SUPERADMIN",iat:now,exp:now+900});
const s=c.createHmac("sha256",process.env.JWT_ACCESS_SECRET).update(h+"."+p).digest("base64url");
process.stdout.write(h+"."+p+"."+s);
' >"$TMP"
[ -s "$TMP" ] || { echo "mint produced nothing" >&2; exit 1; }
chmod 600 "$TMP"
mv -f "$TMP" "$OUT"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(cat "$OUT")" "$API/nodes")
echo "token minted at $(date -u +%H:%M:%SZ) (15 min); GET /nodes -> $code"
[ "$code" = 200 ]
