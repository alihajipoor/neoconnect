# shellcheck shell=bash
# `fleet status [<name>]`: read-only health of one server or of all.
#
# For each: what the panel knows (heartbeat, agent, API door, plans,
# relay routes, bytes customers moved), what the boxes inside the country
# measured, what the server itself says (engine units, certificate days
# left), and how many DNS records point at it.
#
# Whether a server is blocked is read from the inside probe and from
# customers' bytes UP, never from a TCP connect: a held range stays
# green on every connect-only checker.

status_one() {
  local name="$1" out row ip role status line
  out="$(q status-node "name=$name")" || return 1
  if dry; then
    row="row|STANDALONE|{region}|ONLINE|0|{agent}|t|t|{port}"
  else
    row="$(grep '^row|' <<<"$out")"
    [[ -n "$row" ]] || { echo "$name: no such server"; return 1; }
  fi
  IFS='|' read -r _ role _ status _ <<<"$row"
  echo
  echo "== $name"
  awk -F'|' '{printf "  panel: %s %s, status %s, heartbeat %s s ago, agent %s, mirror host %s, API door %s (port %s)\n", $2, $3, $4, $5, $6, ($7 == "t" ? "set" : "NOT SET"), ($8 == "t" ? "checked" : "NOT FOUND"), $9}' <<<"$row"
  dry || {
    grep '^plan|' <<<"$out" | awk -F'|' '{printf "  plan %s: %s route(s)\n", $2, $3}'
    grep '^relay-routes|' <<<"$out" | awk -F'|' '{printf "  relay routes to it: %s enabled of %s\n", $2, $3}'
    grep '^bytes-24h|' <<<"$out" | awk -F'|' '{printf "  last 24 h: %s subscription(s) moved bytes UP, %s MB up, %s MB down\n", $2, $3, $4}'
  }
  out="$(q inside-latest "name=$name")" || return 1
  if [[ -n "$out" ]]; then
    awk -F'|' '{printf "  inside probe: %s port %s %s (down %s B, up %s B, %s min ago)\n", $1, $2, $3, $4, $5, $6}' <<<"$out"
  else
    dry || echo "  inside probe: no reading (the relay box and disabled servers are not probed)"
  fi
  [[ "$status" == ONLINE ]] || return 0

  if [[ "$role" == RELAY ]]; then
    rscript relay relay/relay.sh state | sed 's/^/  box: /'
    # After every backend deploy the relay's agent has to dial in again,
    # and it only can if the name it uses is not reset from inside.
    rsh relay "$REMOTE_DIR/relay.sh control-name" | sed 's/^/  box: /'
    rclean relay >/dev/null
    return 0
  fi

  ip="$(node_field "$name" publicIp)" || return 1
  line="$(rsh "ip:$ip" "for u in xray nginx wg-quick@wg0 openvpn-server@server strongswan strongswan-starter neoxify-agentd neoxify-chain-fw; do s=\$(systemctl is-active \$u 2>/dev/null); [ \"\$s\" = inactive ] && [ \"\$(systemctl is-enabled \$u 2>/dev/null)\" != enabled ] && continue; printf '%s=%s ' \$u \$s; done; echo; for c in /etc/letsencrypt/live/*/cert.pem; do [ -e \"\$c\" ] || continue; e=\$(date -d \"\$(openssl x509 -enddate -noout -in \$c | cut -d= -f2)\" +%s); printf 'certificate %s days left; ' \$(( (e - \$(date +%s)) / 86400 )); done; echo; echo \"xray user \$(systemctl show xray -p User --value), failed units \$(systemctl --failed --no-legend | wc -l), up since \$(uptime -s)\"" 2>/dev/null)" || line=""
  if [[ -n "$line" ]]; then
    echo "$line" | sed 's/^/  box: /'
  else
    dry || echo "  box: no answer to this PC's key (deleted, blocked, or built from another machine)"
  fi
  # shellcheck disable=SC2086
  cf sweep "$ip" "$RUN_DIR/status-names.txt" $CF_ZONES | tail -1 | sed 's/^/  DNS records pointing at it: /'
}

fleet_status() {
  local name="${1:-}" names n
  if [[ -n "$name" ]]; then
    status_one "$name"
    return
  fi
  names="$(q status-names)" || return 1
  dry && names="{server}"
  for n in $names; do status_one "$n"; done
  echo
  echo "Disabled (retired) servers are not listed. 'fleet status <name>' shows one of them."
}
