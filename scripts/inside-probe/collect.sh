#!/usr/bin/env bash
# Runs on the panel host from cron, every half hour: asks each box inside
# the watched country to run the data check (probe.sh) against every node,
# and posts each box's round to the backend (modules/inside-probe).
#
# Installed as /usr/local/bin/neoxify-inside-collect, with
#   /etc/neoxify/inside-probe.conf   one box per line: "<vantage> <user@address>"
#   /root/.ssh/neoxify_inside_probe  the key each box accepts, for the check only
# and INSIDE_PROBE_TOKEN in /root/neoconnect/infra/.env. Nothing about the
# nodes is kept on the boxes: the list is made here, from the database,
# and sent on stdin each time.
set -euo pipefail

CONF=/etc/neoxify/inside-probe.conf
KEY=/root/.ssh/neoxify_inside_probe
ENV_FILE=/root/neoconnect/infra/.env
API=http://127.0.0.1:4000/api/inside-probe/results

token="$(grep -E '^INSIDE_PROBE_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
[ -n "$token" ] || { echo "INSIDE_PROBE_TOKEN is not set in $ENV_FILE" >&2; exit 1; }

# One TLS port per ONLINE node that is not an Iranian relay entry: the
# lowest VLESS-TLS or Trojan port over plain TCP, whose fallback reaches
# the API mirror.
targets="$(docker exec neoxify-postgres-1 sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F " " -c "
  SELECT n.id, n.\"publicIp\", MIN(c.\"listenPort\")
  FROM nodes n JOIN protocol_configs c ON c.\"nodeId\" = n.id
  WHERE n.status = '\''ONLINE'\'' AND n.role <> '\''RELAY'\''
    AND c.\"isEnabled\" AND c.transport = '\''TCP'\''
    AND c.protocol IN ('\''XRAY_VLESS_TLS'\'', '\''XRAY_TROJAN'\'')
  GROUP BY n.id, n.\"publicIp\""')"
[ -n "$targets" ] || { echo "no nodes to check" >&2; exit 0; }

while read -r vantage address _; do
  [[ "$vantage" =~ ^[a-z0-9-]{1,32}$ ]] || continue
  [ -n "${address:-}" ] || continue
  # Up to a minute per node in the worst case; a box that hangs is cut off
  # well before the next round.
  if ! lines="$(timeout 1500 ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 \
      -o StrictHostKeyChecking=yes "$address" <<<"$targets")"; then
    echo "$vantage: the check did not finish" >&2
    continue
  fi
  results="$(grep -E '^\{"nodeId"' <<<"$lines" | paste -sd, -)"
  [ -n "$results" ] || { echo "$vantage: nothing came back" >&2; continue; }
  curl -sS --max-time 30 -X POST "$API" \
    -H "Content-Type: application/json" -H "X-Probe-Token: $token" \
    --data-binary "{\"vantage\":\"$vantage\",\"results\":[$results]}" >/dev/null ||
    echo "$vantage: the backend refused the round" >&2
done <"$CONF"
