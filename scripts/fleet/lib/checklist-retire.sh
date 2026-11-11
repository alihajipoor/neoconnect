# shellcheck shell=bash
# `fleet retire <name>`: take a server out without losing anything.
#
# The order matters and every line of it was learned the hard way:
# customers first (plans), then the relay's routes to it, then the
# panel's own records, then its names, then the hop. The server's row and
# its usage history stay for good: there is no step that deletes a
# server, because deleting one deletes its history in the same
# transaction.

old_ip() { node_field "$OLD" publicIp; }

# A fresh dump when the last one is more than 20 minutes old.
dump_if_stale() {
  dry && { panel_dump "$1"; return 0; }
  (($(date +%s) - $(st last_dump 0) < 1200)) || panel_dump "$1"
}

do_retire_params() {
  local row
  row="$(q node-row "name=$OLD")" || return 1
  dry && return 0
  [[ -n "$row" ]] || { say "no server named $OLD in the panel"; return 1; }
  if [[ "$(cut -d'|' -f2 <<<"$row")" == RELAY || "$OLD" == "$RELAY_NODE_NAME" ]]; then
    say "REFUSED ON PURPOSE: $OLD is the relay box. Retiring or replacing the one inside entry is not a checklist:"
    say "its Xray holds routes that exist nowhere else, the sign-in relay shares the box, and a mistake cannot be"
    say "undone from outside the country. That is done by a person, step by step, with the owner."
    return 1
  fi
  state_set old_id "${row%%|*}"
  state_set old_status "$(cut -d'|' -f4 <<<"$row")"
  say "$OLD: status $(cut -d'|' -f4 <<<"$row"), region $(cut -d'|' -f3 <<<"$row")"
}
ok_retire_params() {
  expect "the server exists and is an exit, not the relay box"
  dry || state_has old_id
}

do_retire_snapshot() {
  local out
  q snapshot | sed 's/^/  /' || return 1
  say "routes of $OLD (kind | id | shape | enabled | name):"
  q routes-of "name=$OLD" | sed 's/^/    /' || return 1
  say "plans holding them (plan | routes of this server | default on it | all routes):"
  q plan-holds "name=$OLD" | sed 's/^/    /' || return 1
  out="$(q node-names "name=$OLD")" || return 1
  dry || { echo "$out" >"$RUN_DIR/db-names.txt"; say "names of ours the panel publishes for it: $(grep -c . <<<"$out") (kept in the run directory, for the DNS steps)"; }
  out="$(rscript relay relay/relay.sh state)" || return 1
  dry && return 0
  state_has relay_pid || state_set relay_pid "$(sed -n 's/^xray pid \([0-9]*\),.*/\1/p' <<<"$out" | head -1)"
}
ok_retire_snapshot() {
  expect "the server's routes, plans and names are in the run log, and the relay box's Xray process id is recorded"
  dry || [[ "$(st relay_pid "")" =~ ^[0-9]+$ && -f "$RUN_DIR/db-names.txt" ]]
}

do_retire_guard_hop() {
  local ip n
  ip="$(old_ip)" || return 1
  rscript relay relay/relay.sh hop-list || return 1
  rget relay "$REMOTE_DIR/hop-live.txt" "$RUN_DIR/hop-live.txt" || return 1
  dry && { echo "local \$ tool.mjs hop-through (how many exits reach the relay through this server)" >&2; return 0; }
  n="$(tool hop-through "$RUN_DIR/hop-live.txt" "$ip" | grep -c . || true)"
  rm -f "$RUN_DIR/hop-live.txt"
  state_set hop_through "$n"
  say "exits that reach the relay through $OLD: $n"
}
ok_retire_guard_hop() {
  expect "no other exit reaches the relay box through this server's hop"
  dry && return 0
  [[ "$(st hop_through 1)" == 0 ]] && return 0
  say "REFUSED: $OLD carries the relay hop for $(st hop_through) exit(s). Retiring it now would cut every relay route"
  say "to them. The hop moves first: use 'fleet replace $OLD <new address>', which does that before retiring."
  return 1
}

do_retire_guard_plans() {
  local out line steps
  out="$(q plan-input "incoming=" "outgoing=$OLD" "fallback=$OPT_DEFAULT_TO" "only=")" || return 1
  dry && { echo "local \$ tool.mjs plan-steps (would any plan be left empty, or keep a default on a route that is going?)" >&2; return 0; }
  for line in plans incoming outgoing fallback; do sed -n "s/^$line //p" <<<"$out" >"$RUN_DIR/$line.json"; done
  if steps="$(tool plan-steps "$RUN_DIR/plans.json" "$RUN_DIR/incoming.json" "$RUN_DIR/outgoing.json" "$RUN_DIR/fallback.json")"; then
    say "plans that will change: $(cut -d'|' -f2 <<<"$steps" | tr '\n' ',' | sed 's/,$//; s/^$/none/')"
    state_set plan_guard ok
  else
    state_set plan_guard refused
  fi
  rm -f "$RUN_DIR"/*.json
}
ok_retire_guard_plans() {
  expect "no plan would be left with an empty list (that revokes every subscriber on it), and every default route on this server has somewhere to go"
  dry && return 0
  [[ "$(st plan_guard "")" == ok ]] && return 0
  say "REFUSED (reason above). When a plan's default route is on $OLD, name the server that takes it over:"
  say "  fleet retire $OLD --default-to <server>"
  return 1
}

do_retire_reach() {
  local ip
  ip="$(old_ip)" || return 1
  if dry; then
    rsh "ip:$ip" "true"
    return 0
  fi
  if rsh "ip:$ip" "true" 2>/dev/null; then
    state_set reach yes
    say "the box still answers this PC's key"
  else
    state_set reach no
    say "the box does not answer: deleted at the provider, blocked, or it never had this PC's key."
    say "It is treated as gone: its names are deleted at once, and nothing is stopped on it."
  fi
}
ok_retire_reach() {
  expect "it is known whether the box still answers"
  dry || state_has reach
}

dns_sweep() { # deletes every record in our zones that points at the old address
  local ip
  ip="$(old_ip)" || return 1
  # shellcheck disable=SC2086
  cf sweep "$ip" "$RUN_DIR/swept.txt" $CF_ZONES --delete | sed 's/^/  /' || return 1
  dry && return 0
  cat "$RUN_DIR/swept.txt" >>"$RUN_DIR/dns-names.txt"
  sort -u "$RUN_DIR/dns-names.txt" -o "$RUN_DIR/dns-names.txt"
  undo "the names are gone for good on purpose; to put one back: fleet dns create-a <zone> <name> <address> (names in $RUN_DIR/dns-names.txt)"
}

dns_gone() { # every swept name answers NXDOMAIN from a public resolver
  local n bad=0
  dry && { cf doh "<each deleted name>" gone; return 0; }
  [[ -s "$RUN_DIR/dns-names.txt" ]] || return 0
  while read -r n; do
    [[ -n "$n" ]] || continue
    cf doh "$n" gone >/dev/null || { say "a deleted name still resolves (resolver caches clear within minutes; run the step again)"; bad=1; }
  done <"$RUN_DIR/dns-names.txt"
  return $bad
}

do_retire_dns_now() {
  if ! dry && [[ "$(st reach yes)" == yes ]]; then
    say "the box still answers, so its address is still ours: the names go after its customers are off it (retire.dns)"
    return 0
  fi
  dry && say "only when the box no longer answers (its address may already be someone else's):"
  # A released address goes to a stranger, who can get a real certificate
  # for any name still pointing at it and collect our apps' API calls.
  dns_sweep
}
ok_retire_dns_now() {
  expect "when the box is gone: no record in any zone points at its address, and each deleted name answers 'no such name'"
  dry && { dns_gone; return 0; }
  [[ "$(st reach yes)" == yes ]] && return 0
  dns_gone
}

do_retire_dump() { panel_dump "pre-retire-$OLD"; }
ok_retire_dump() {
  expect "a database dump from the last few minutes, checked with gzip -t"
  dry || (($(date +%s) - $(st last_dump 0) < 1800))
}

do_retire_plans() {
  heartbeats_baseline || return 1
  plan_pass "" "$OLD" "retire-$OLD"
}
ok_retire_plans() {
  expect "no plan holds a route of this server, and every other server that was online still reports"
  plan_pass_done "" "$OLD" || return 1
  heartbeats_fresh "$OLD"
}

do_retire_revoked() { say "read-only: the check is the step. Removing the routes from the plans is what revoked the credentials."; }
ok_retire_revoked() {
  local out
  out="$(q revoked "name=$OLD")" || return 1
  expect "no ACTIVE shared credential is left on this server's routes, and no plan with subscribers is left without an enabled route"
  dry && return 0
  say "$(tr '\n' ' ' <<<"$out")"
  [[ "$(sed -n 's/^active-creds|//p' <<<"$out")" == 0 && "$(sed -n 's/^empty-plans|//p' <<<"$out")" == 0 ]]
}

do_retire_relay_routes() {
  local ids
  ids="$(q route-ids "name=$OLD" kind=relay)" || return 1
  dry && ids="{relay-route-ids}"
  if [[ -z "$ids" ]]; then
    say "no relay route exits on $OLD"
    return 0
  fi
  dry || state_set relay_deleted "$ids"
  panel_mint >/dev/null || return 1
  # shellcheck disable=SC2086
  pscript nx-api.sh route-delete ${ids//,/ } | sed 's/^/  /' || return 1
  undo "the rows cannot be put back; make them again on the freed set with nx-relay-add.sh (pointless once the exit is gone)"
  say "queued DELETE_USER commands for a dead exit stay queued for good: that is expected and left alone"
}
ok_retire_relay_routes() {
  local left out ids
  left="$(q route-ids "name=$OLD" kind=relay)" || return 1
  ids="$(st relay_deleted "")"
  # shellcheck disable=SC2086
  out="$(rscript relay relay/relay.sh state ${ids//,/ })" || return 1
  relay_pid_same || return 1
  expect "no relay route to this exit is left in the panel, the relay box's running Xray holds no rule or outbound for any of them, and it is the same process"
  dry && return 0
  [[ -z "$left" ]] || { say "relay routes still in the panel"; return 1; }
  if grep -E 'rules=[1-9]|outbounds=[1-9]' <<<"$out"; then say "the relay's Xray still holds a rule or outbound for a deleted route (the agent removes it within a minute; run again)"; return 1; fi
}

do_retire_incident() {
  local id
  id="$(q open-incident "name=$OLD")" || return 1
  dry && id="{incident-id}"
  if [[ -z "$id" ]]; then
    say "no open block incident for $OLD"
    return 0
  fi
  panel_mint >/dev/null || return 1
  pscript nx-api.sh incident-retire "$(head -1 <<<"$id")" "server retired $(date -u +%Y-%m-%d)" | sed 's/^/  /' || return 1
  undo "SQL on the panel host: UPDATE block_incidents SET status = 'OPEN', \"closedAt\" = NULL, \"actedBy\" = NULL, \"actionNote\" = NULL WHERE id = '<the incident id>';"
}
ok_retire_incident() {
  local id
  id="$(q open-incident "name=$OLD")" || return 1
  expect "no OPEN block incident is left for this server (closed as retired, so block watch skips it while it keeps that address)"
  dry || [[ -z "$id" ]]
}

do_retire_agent_stop() {
  local ip
  if ! dry && [[ "$(st reach no)" != yes ]]; then
    say "the box is gone: there is no agent to stop"
    return 0
  fi
  ip="$(old_ip)" || return 1
  # The agent is stopped BEFORE the row is disabled: a connected agent
  # sets the status back on its next Hello or when its stream closes.
  rsh "ip:$ip" "systemctl disable --now neoxify-agentd; echo \"agent: \$(systemctl is-active neoxify-agentd)\"" || return 1
  undo "on the old box: systemctl enable --now neoxify-agentd"
}
ok_retire_agent_stop() {
  local ip out
  expect "the agent on the old box is stopped and disabled (when the box still answers)"
  dry && return 0
  [[ "$(st reach no)" == yes ]] || return 0
  ip="$(old_ip)" || return 1
  out="$(rsh "ip:$ip" "systemctl is-active neoxify-agentd; systemctl is-enabled neoxify-agentd" | tr '\n' ' ')" || true
  [[ "$out" == "inactive disabled "* ]]
}

old_status() { q node-row "name=$OLD" | cut -d'|' -f4; }

do_retire_offline() {
  local s i
  dry && { q node-row "name=$OLD"; return 0; }
  for i in $(seq 1 30); do
    s="$(old_status)"
    case "$s" in OFFLINE | DISABLED) say "panel shows $s"; return 0 ;; esac
    sleep 10
  done
  say "the panel still shows '$s' after five minutes (try $i): its agent is still connected somewhere"
  return 1
}
ok_retire_offline() {
  expect "the panel shows the server OFFLINE (or already DISABLED)"
  dry && return 0
  case "$(old_status)" in OFFLINE | DISABLED) return 0 ;; esac
  return 1
}

do_retire_disable() {
  panel_dump "pre-$OLD-disable" || return 1
  q retire-disable "name=$OLD" | sed 's/^/  status | routes still enabled: /' || return 1
  undo "SQL on the panel host, from the dump above: UPDATE nodes SET status = 'OFFLINE' WHERE name = '$OLD'; and \"isEnabled\" = true on its routes"
}
ok_retire_disable() {
  local out
  out="$(q leftovers "name=$OLD")" || return 1
  expect "the server is DISABLED and none of its routes is enabled; its protocol configs and its usage history are kept"
  dry || { grep -qx 'status|DISABLED' <<<"$out" && grep -qx 'enabled-routes|0' <<<"$out"; }
}

do_retire_keys() {
  dump_if_stale "pre-$OLD-keys" || return 1
  q retire-keys "name=$OLD" | sed 's/^/  status | key cleared | mirror cleared: /' || return 1
  undo "from the dump: the old agent public key and mirror host of $OLD (only if the server is ever brought back)"
}
ok_retire_keys() {
  local out
  out="$(q leftovers "name=$OLD")" || return 1
  expect "the agent key is cleared, so nothing can sign in as this server and flip it back to ONLINE"
  dry || grep -qx 'key-cleared|t' <<<"$out"
}

do_retire_dns() { dns_sweep; }
ok_retire_dns() {
  local ip left
  expect "a second sweep finds no record in any zone pointing at the old address, and every deleted name answers 'no such name'"
  dns_gone || return 1
  ip="$(old_ip)" || return 1
  # shellcheck disable=SC2086
  left="$(cf sweep "$ip" "$RUN_DIR/swept2.txt" $CF_ZONES | tail -1)" || return 1
  dry || [[ "$left" == "total 0 found" ]]
}

do_retire_dns_other() {
  local n=0
  if ! dry; then
    # shellcheck disable=SC2086
    tool names-outside "$RUN_DIR/db-names.txt" $CF_ZONES >"$RUN_DIR/owner-names.txt" || return 1
    n="$(grep -c . "$RUN_DIR/owner-names.txt" || true)"
  fi
  if [[ "$n" == 0 ]] && ! dry; then
    say "every name the panel published for $OLD was in a zone this tool edits: nothing left for the owner"
    state_set nowait_retire_dns_other 1
    return 0
  fi
  say "OWNER: $n name(s) of $OLD sit at a registrar this tool cannot edit. They are listed, unmasked, in"
  say "  $RUN_DIR/owner-names.txt"
  say "Delete them there today: once the address is released, a stranger holding it can get a certificate for them."
}
ok_retire_dns_other() {
  local n bad=0
  expect "every name at another registrar answers 'no such name' too"
  dry && return 0
  while read -r n; do
    [[ -n "$n" ]] || continue
    cf doh "$n" gone >/dev/null || { say "one of the owner's names still resolves"; bad=1; }
  done <"$RUN_DIR/owner-names.txt"
  return $bad
}

do_retire_hop() {
  local ip handle hopname hopip
  ip="$(old_ip)" || return 1
  rscript relay relay/relay.sh hop-list || return 1
  rget relay "$REMOTE_DIR/hop-live.txt" "$RUN_DIR/hop-live.txt" || return 1
  if dry; then
    handle="{handle}" hopname="{hop-server}"
    say "only when the relay reached this exit through the hop:"
  else
    handle="$(tool hop-handle "$RUN_DIR/hop-live.txt" "$ip")" || return 1
    if [[ "$handle" == none ]]; then
      say "the relay box has no hop entry for $OLD"
      rm -f "$RUN_DIR/hop-live.txt"
      return 0
    fi
    hopname="$(tool hop-rules "$RUN_DIR/hop-live.txt" | awk -F'|' -v h="$handle" '$1 == h {print $3}')"
  fi
  # the relay box: the live rule by its handle, then the one line in the file
  rsh relay "$REMOTE_DIR/relay.sh hop-backup retire-$OLD" || return 1
  rsh relay "$REMOTE_DIR/relay.sh hop-del $handle $ip" || return 1
  undo "on the relay box: nft add rule ip neoxify_relay_chain output <the rule, from /root/nft-live.bak-pre-retire-$OLD-*>"
  rget relay /etc/nftables.conf "$RUN_DIR/nft.old" || return 1
  dry || tool hop-file-remove "$RUN_DIR/nft.old" "$RUN_DIR/nft.new" "$ip" || return 1
  rput relay "$RUN_DIR/nft.new" "$REMOTE_DIR/nftables.conf.new" 600 || return 1
  rsh relay "$REMOTE_DIR/relay.sh hop-file-swap" || return 1
  undo "on the relay box: cp -a /etc/nftables.conf.bak-pre-retire-$OLD-<time> /etc/nftables.conf (never load that file)"
  # the hop server: the exit's port out of its own table
  hopip="$(node_field "$hopname" publicIp)" || return 1
  rget "ip:$hopip" /etc/neoxify/chain-fw.nft "$RUN_DIR/chain.old" || return 1
  dry || tool chain-remove "$RUN_DIR/chain.old" "$RUN_DIR/chain.new" "$ip" || return 1
  rput "ip:$hopip" "$RUN_DIR/chain.new" "$REMOTE_DIR/chain-fw.nft.new" 600 || return 1
  rscript "ip:$hopip" node/hop-server.sh apply || return 1
  undo "on the hop server $hopname: cp -a /etc/neoxify/chain-fw.nft.bak-<time> /etc/neoxify/chain-fw.nft && nft -f /etc/neoxify/chain-fw.nft"
  dry || rm -f "$RUN_DIR"/chain.* "$RUN_DIR"/nft.* "$RUN_DIR"/hop-*
}
ok_retire_hop() {
  local ip h
  expect "the relay box has no live rule and no file line for this exit, and its Xray is the same process"
  ip="$(old_ip)" || return 1
  rscript relay relay/relay.sh hop-list >/dev/null || return 1
  rget relay "$REMOTE_DIR/hop-live.txt" "$RUN_DIR/hop-live.txt" || return 1
  relay_pid_same || return 1
  dry && return 0
  h="$(tool hop-handle "$RUN_DIR/hop-live.txt" "$ip")"
  rm -f "$RUN_DIR/hop-live.txt"
  [[ "$h" == none ]] || { say "a live hop rule for $OLD is still there"; return 1; }
  [[ "$(rsh relay "grep -c 'comment \"$OLD via ' /etc/nftables.conf || true")" == 0 ]]
}

do_retire_alerts() {
  dump_if_stale "pre-$OLD-alerts" || return 1
  q alerts-resolve "name=$OLD" | sed 's/^/  open reachability alerts now: /'
}
ok_retire_alerts() {
  local out
  out="$(q leftovers "name=$OLD")" || return 1
  expect "no open reachability alert is left for this server"
  dry || grep -qx 'open-alerts|0' <<<"$out"
}

do_retire_leftovers() { say "read-only: the check is the step"; }
ok_retire_leftovers() {
  local out ip n bad=0 k
  out="$(q leftovers "name=$OLD")" || return 1
  ip="$(old_ip)" || return 1
  n="$(rsh panel "grep -rlF -- '$ip' /etc/nginx /etc/cron.d /etc/neoxify /usr/local/bin /root/neoconnect/infra/.env 2>/dev/null | wc -l")" || return 1
  expect "nothing still points at the server: no plan route, no enabled route, no relay route, no plan default, no pinned subscription, no open incident or alert; DISABLED with its key cleared; no file on the panel host names its address; every other server reports"
  heartbeats_fresh "$OLD" || bad=1
  dry && return 0
  echo "$out" | sed 's/^/  /'
  for k in routes-in-plans enabled-routes relay-routes-left plan-defaults pinned-subscriptions gaming-resolvers open-incidents open-alerts; do
    grep -qx "$k|0" <<<"$out" || { say "LEFT OVER: $k"; bad=1; }
  done
  grep -qx 'status|DISABLED' <<<"$out" || bad=1
  grep -qx 'key-cleared|t' <<<"$out" || bad=1
  [[ "$n" == 0 ]] || { say "LEFT OVER: $n file(s) on the panel host still name the old address"; bad=1; }
  return $bad
}

do_retire_owner_after() {
  cat <<EOF
  OWNER, after $OLD is retired (none of this can be done by the tool):
    1. Signed endpoint lists: re-sign without this server's mirrors on the machine that holds the signing
       keys, then publish. Client releases come after that.
    2. If it was the last server in its country: the website's location list and any promo material.
    3. Nothing to do about: its row, its protocol configs and its usage history (kept on purpose), and the
       DELETE_USER commands queued for it (they stay queued).
EOF
}
ok_retire_owner_after() { expect "the owner has the list"; return 0; }

do_retire_delete_vps() {
  say "OWNER: the VPS of $OLD can be deleted at the provider now."
  say "Nothing of ours points at its address any more, no customer holds a credential on it, and the relay"
  say "does not route to it. Type 'done' when it is deleted (or when it already was)."
}
ok_retire_delete_vps() {
  expect "the owner confirmed"
  dry || rclean panel >/dev/null
  dry || rclean relay >/dev/null
  return 0
}

register_retire_steps() {
  step retire.guard-hop gate "Refuse while other exits reach the relay through this server's hop"
  step retire.guard-plans gate "Refuse if a plan would be left empty or its default would have nowhere to go"
  step retire.reach auto "Does the box still answer?"
  step retire.dns-now auto "Names deleted at once when the box is already gone"
  step retire.dump auto "Database dump"
  step retire.plans auto "Routes out of every plan, one plan at a time, heartbeats checked after each"
  step retire.revoked auto "Revocation check: no active credential left, every plan still serves"
  step retire.relay-routes ask "Relay routes to this exit deleted through the API (hot, relay Xray not restarted)"
  step retire.incident auto "Open block incident closed as retired"
  step retire.agent-stop auto "Agent stopped and disabled (only if the box still answers)"
  step retire.offline auto "Wait until the panel shows OFFLINE"
  step retire.disable auto "Server DISABLED and its routes off, only from OFFLINE (database dump first)"
  step retire.keys auto "Agent key and mirror host cleared"
  step retire.dns auto "DNS names deleted in every zone, 'no such name' confirmed"
  step retire.dns-other owner "Names at registrars the tool cannot edit"
  step retire.hop ask "Relay hop entry for this exit removed: live rule by handle, file by line, never loaded"
  step retire.alerts auto "Reachability alerts resolved"
  step retire.leftovers auto "Leftovers: nothing still points at the server"
  step retire.owner-after owner "What only the owner can do afterwards"
  step retire.delete-vps owner "The VPS can be deleted at the provider now"
}

checklist_retire() {
  step retire.params auto "Server exists and is an exit (the relay box is refused on purpose)"
  step retire.snapshot auto "Read-only snapshot: status, routes, plans, names"
  register_retire_steps
}
