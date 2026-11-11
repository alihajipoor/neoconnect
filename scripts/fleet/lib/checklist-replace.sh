# shellcheck shell=bash
# `fleet replace <old> <ip>`: a new server takes an old one's place.
#
# It is the add checklist, then whatever only the old server did moves
# over (the relay hop, plan defaults), then the retire checklist. The
# plans change once: each plan gets the new server's routes and loses the
# old one's in the same edit, so no customer is left with fewer servers
# in between and nobody is re-provisioned twice.

do_replace_params() {
  local row base name
  row="$(q node-row "name=$OLD")" || return 1
  base="${OLD%-*}"
  name="${NAME:-$(q next-name "base=$base")}" || return 1
  dry && return 0
  [[ -n "$row" ]] || { say "no server named $OLD in the panel"; return 1; }
  if [[ "$(cut -d'|' -f2 <<<"$row")" == RELAY || "$OLD" == "$RELAY_NODE_NAME" ]]; then
    say "REFUSED ON PURPOSE: $OLD is the relay box. Replacing the one inside entry is done by a person, with the owner."
    return 1
  fi
  [[ "$name" =~ ^[a-z]+(-[a-z]+)*-[0-9]+$ ]] || { say "could not work out the next free name after $OLD: pass --name"; return 1; }
  state_set name "$name"
  state_set old_id "${row%%|*}"
  state_set region "$(cut -d'|' -f3 <<<"$row")"
  # The old server's disguise site, unless one was given. It is the
  # owner's call whether a site that sat on a blocked server is kept.
  [[ -n "$DEST" ]] || [[ -z "$(cut -d'|' -f8 <<<"$row")" ]] || state_set dest "$(cut -d'|' -f8 <<<"$row")"
  say "$OLD (status $(cut -d'|' -f4 <<<"$row")) will be replaced by $name, region $(cut -d'|' -f3 <<<"$row")"
  [[ -n "$DEST" ]] || say "disguise site: the old server's (pass --dest host:443 to choose another)"
}
ok_replace_params() {
  expect "the old server exists and is an exit; the new one has the next free name, the old one's region and a disguise site"
  dry || { state_has name && state_has region; }
}

do_move_hop() {
  local oldip n handle exitname port exitip dest
  oldip="$(old_ip)" || return 1
  rscript relay relay/relay.sh hop-list || return 1
  rget relay "$REMOTE_DIR/hop-live.txt" "$RUN_DIR/hop-live.txt" || return 1
  if dry; then
    say "only when the old server carries the hop; then, for every exit that goes through it:"
    echo "local \$ tool.mjs chain-from-relay (the hop table rebuilt from the relay's own rules, so it works when the old box is already gone)" >&2
    n="{exits}"
  else
    mkdir -p "$RUN_DIR/hopx"
    n="$(tool hop-through "$RUN_DIR/hop-live.txt" "$oldip" "$RUN_DIR/hopx" | tee "$RUN_DIR/hop-through.txt" | grep -c . || true)"
    if [[ "$n" == 0 ]]; then
      say "$OLD carries no hop: nothing to move"
      state_set move_hop none
      rm -rf "$RUN_DIR/hopx" "$RUN_DIR"/hop-*
      return 0
    fi
    if [[ "$(st pre_relay_443 PASS)" != PASS && "$OPT_HOP" != no ]]; then
      say "REFUSED: $OLD carries the hop for $n exit(s), and the relay box cannot move data to the new box directly"
      say "(bare-box test on 443). A server the relay cannot reach cannot be its hop. Choose a box that passes"
      say "from the relay box, or keep $OLD as the hop."
      return 1
    fi
    # Every exit the relay names must be the address the panel has for it.
    while IFS='|' read -r handle exitname port; do
      exitip="$(node_field "$exitname" publicIp)" || return 1
      [[ "$exitip" == "$(cat "$RUN_DIR/hopx/$handle.exit")" ]] || { say "the relay's rule for $exitname does not point at the address the panel has for it: fix that by hand first"; return 1; }
    done <"$RUN_DIR/hop-through.txt"
    tool chain-from-relay "$RUN_DIR/hop-live.txt" "$RUN_DIR/chain.new" "$RELAY_HOST" "$oldip" >/dev/null || return 1
    say "$OLD carries the hop for $n exit(s): $(cut -d'|' -f2 "$RUN_DIR/hop-through.txt" | tr '\n' ' ')"
  fi
  # 1. the new server gets the same table
  rput new "$RUN_DIR/chain.new" "$REMOTE_DIR/chain-fw.nft.new" 600 || return 1
  rscript new node/hop-server.sh apply || return 1
  undo "on the new server: $REMOTE_DIR/hop-server.sh remove (or: systemctl disable --now neoxify-chain-fw; nft delete table ip neoxify_chain)"
  # 2. proof before the relay is touched: each exit's disguise site answers through the new server
  rpushdir relay inside || return 1
  if dry; then
    rsh relay "$REMOTE_DIR/inside.sh sni $NEW_IP <hop port> <that exit's disguise site>   (once per exit; all must answer)"
  else
    while IFS='|' read -r handle exitname port; do
      dest="$(node_field "$exitname" realityDest)" || return 1
      rsh relay "$REMOTE_DIR/inside.sh sni $NEW_IP $port ${dest%:*}" | sed "s/^/  $exitname through the new hop: /" || { say "the new hop does not carry $exitname: the relay was not touched"; return 1; }
    done <"$RUN_DIR/hop-through.txt"
  fi
  # 3. the relay: each live rule repointed by its handle, then the same lines in the file
  rsh relay "$REMOTE_DIR/relay.sh hop-backup move-to-$(nn)" || return 1
  if dry; then
    rput relay "$RUN_DIR/hop-rule.txt" "$REMOTE_DIR/hop-rule.txt" 600
    rsh relay "$REMOTE_DIR/relay.sh hop-set <handle>   (once per exit)"
  else
    while IFS='|' read -r handle exitname port; do
      tool hop-rule "$(cat "$RUN_DIR/hopx/$handle.exit")" "$NEW_IP" "$port" "$exitname" "$(nn)" "$RUN_DIR/hop-rule.txt" || return 1
      rput relay "$RUN_DIR/hop-rule.txt" "$REMOTE_DIR/hop-rule.txt" 600 || return 1
      rsh relay "$REMOTE_DIR/relay.sh hop-set $handle" | sed "s/^/  $exitname: /" || return 1
    done <"$RUN_DIR/hop-through.txt"
  fi
  undo "on the relay box, per exit: nft replace rule ip neoxify_relay_chain output handle <h> <the old rule, from /root/nft-live.bak-pre-move-to-$(nn)-*>"
  rget relay /etc/nftables.conf "$RUN_DIR/nft.old" || return 1
  dry || tool hop-file-repoint "$RUN_DIR/nft.old" "$RUN_DIR/nft.new" "$oldip" "$NEW_IP" "$(nn)" >/dev/null || return 1
  rput relay "$RUN_DIR/nft.new" "$REMOTE_DIR/nftables.conf.new" 600 || return 1
  rsh relay "$REMOTE_DIR/relay.sh hop-file-swap" || return 1
  undo "on the relay box: cp -a /etc/nftables.conf.bak-pre-move-to-$(nn)-<time> /etc/nftables.conf (never load that file)"
  dry && return 0
  state_set move_hop "$n"
  state_set move_hop_exits "$(cut -d'|' -f2 "$RUN_DIR/hop-through.txt" | tr '\n' ' ')"
  rm -rf "$RUN_DIR/hopx" "$RUN_DIR"/hop-* "$RUN_DIR"/chain.* "$RUN_DIR"/nft.*
}
ok_move_hop() {
  local oldip left now x rows pu out bad=0
  expect "no live rule and no file line on the relay goes through the old server; the new server's hop table is loaded and survives a reboot; and a relay tunnel to each exit behind the hop still exits on that exit's own address"
  [[ "$(st move_hop none)" == none ]] && ! dry && return 0
  oldip="$(old_ip)" || return 1
  rscript relay relay/relay.sh hop-list >/dev/null || return 1
  rget relay "$REMOTE_DIR/hop-live.txt" "$RUN_DIR/hop-live.txt" || return 1
  relay_pid_same || return 1
  rscript new node/verify.sh "$(need l1)" "$(need l2)" hop | grep -E '^FAIL|hop table|forwarding' | sed 's/^/  /'
  pscript nx-xray-get.sh "$XRAY_VERSION" >/dev/null || return 1
  panel_mint >/dev/null || return 1
  if dry; then
    q test-creds "name=<each exit behind the hop>" "email=${TEST_RELAY_EMAIL:-}"
    rsh panel "$PANEL_ENV$REMOTE_DIR/nx-e2e-build.sh <relay REALITY credential> | $PANEL_ENV$REMOTE_DIR/nx-e2e-run.sh $REMOTE_DIR/xray 'relay to <exit> through the moved hop'"
    return 0
  fi
  left="$(tool hop-through "$RUN_DIR/hop-live.txt" "$oldip" | grep -c . || true)"
  now="$(tool hop-through "$RUN_DIR/hop-live.txt" "$NEW_IP" | grep -c . || true)"
  rm -f "$RUN_DIR/hop-live.txt"
  say "live hop rules through the old server: $left; through the new one: $now"
  [[ "$left" == 0 && "$now" == "$(st move_hop)" ]] || bad=1
  [[ "$(rsh relay "grep -c ' via $OLD\"' /etc/nftables.conf || true")" == 0 ]] || { say "the relay's file still has a line through $OLD"; bad=1; }
  for x in $(st move_hop_exits); do
    rows="$(q test-creds "name=$x" "email=${TEST_RELAY_EMAIL:-}")" || return 1
    pu="$(awk -F'|' '$4 == "relay" && $1 ~ /REALITY/ {print $3; exit}' <<<"$rows")"
    if [[ -z "$pu" ]]; then
      say "UNVERIFIED: the relay test account has no REALITY credential to $x, so that exit was not dialled through the moved hop"
      bad=1
      continue
    fi
    out="$(rsh panel "$PANEL_ENV$REMOTE_DIR/nx-e2e-build.sh $pu | $PANEL_ENV$REMOTE_DIR/nx-e2e-run.sh $REMOTE_DIR/xray 'relay to $x through the moved hop'")" || true
    grep -E ' \| EXIT-' <<<"$out" | sed 's/^/  /'
    grep -q '^E2E-PASS' <<<"$out" || bad=1
  done
  panel_token_shred >/dev/null
  return $bad
}

do_move_defaults() { say "read-only: the check is the step. The plan edit already moved each plan from the old server to the new one."; }
ok_move_defaults() {
  local out
  out="$(q plan-holds "name=$OLD")" || return 1
  expect "no plan holds a route of the old server and no plan's default route is on it"
  dry && return 0
  if awk -F'|' '$2 != 0 || $3 == "t" {bad = 1} END {exit !bad}' <<<"$out"; then
    say "a plan still holds the old server (plan | its routes | default on it | all routes):"
    echo "$out" | sed 's/^/    /'
    [[ "$OPT_NO_PLANS" == 1 ]] && say "(--no-plans was given: the retire steps below take them out)" && return 0
    return 1
  fi
}

checklist_replace() {
  step replace.params auto "Old server exists; the new one gets the next free name, its region and its disguise site"
  step add.params auto "Name is free; region, peer, disguise site and versions settled"
  step add.access auto "Key-only access to the panel host, both inside boxes and the new box"
  step add.snapshot auto "Read-only snapshot of the fleet into the run log"
  register_precheck_steps
  register_add_steps
  step move.hop ask "Relay hop moved to the new server before the old one goes (only if the old one carries it)"
  step add.plans auto "Plans, one at a time: the new server in and the old one out in the same edit (database dump first)"
  step add.provision auto "Provisioning check: credentials created and acknowledged"
  step add.e2e-issued auto "Tunnels again, with credentials the panel issued"
  step add.monitoring auto "Monitoring picked it up: inside probe reading and the server's API door"
  step move.defaults auto "No plan route and no plan default left on the old server"
  step retire.snapshot auto "Read-only snapshot of the old server: status, routes, plans, names"
  register_retire_steps
  step add.owner-after owner "What only the owner can do for the new server afterwards"
  step add.cleanup auto "Scratch files shredded on every host"
}
