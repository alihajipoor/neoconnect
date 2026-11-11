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

# This step can stop halfway (one dropped connection to the relay box is
# enough), and then it is run again. So it never works from "the rules
# that still go through the old server" alone:
#
#   - the new server's table is built from the rules through the old
#     server AND the rules through the new one. Built from the first
#     only, a second pass would load a table without the exits the first
#     pass had already moved, over the one that had them, and cut them off;
#   - "nothing to move" is said only when no live rule goes through
#     either server AND the relay's file has no line through the old one.
#     The file is read at the relay's next boot: a pass that moved the
#     live rules and stopped before the file would otherwise be followed
#     by one that says "nothing to move" and leaves the boot-time rules
#     pointing at a server that is about to go.
do_move_hop() {
  local oldip n=0 n_old=0 n_new=0 n_file=0 handle exitname port exitip dest
  oldip="$(old_ip)" || return 1
  rscript relay relay/relay.sh hop-list || return 1
  rget relay "$REMOTE_DIR/hop-live.txt" "$RUN_DIR/hop-live.txt" || return 1
  rget relay /etc/nftables.conf "$RUN_DIR/nft.old" || return 1
  if dry; then
    say "only when the old server carries the hop; then, for every exit that goes through it:"
    echo "local \$ tool.mjs chain-from-relay (the hop table rebuilt from the relay's own rules through the old server AND, on a second pass, the new one; it works when the old box is already gone)" >&2
  else
    mkdir -p "$RUN_DIR/hopx"
    tool hop-through "$RUN_DIR/hop-live.txt" "$oldip" "$RUN_DIR/hopx" >"$RUN_DIR/hop-old.txt" || return 1
    tool hop-through "$RUN_DIR/hop-live.txt" "$NEW_IP" "$RUN_DIR/hopx" >"$RUN_DIR/hop-new.txt" || return 1
    cat "$RUN_DIR/hop-old.txt" "$RUN_DIR/hop-new.txt" >"$RUN_DIR/hop-through.txt"
    n_old="$(grep -c . "$RUN_DIR/hop-old.txt" || true)"
    n_new="$(grep -c . "$RUN_DIR/hop-new.txt" || true)"
    n_file="$(tool hop-count "$RUN_DIR/nft.old" hop "$oldip")" || return 1
    n=$((n_old + n_new))
    if [[ $n -eq 0 ]]; then
      if [[ "$n_file" != 0 ]]; then
        say "No live rule on the relay goes through $OLD or through the new server, but the relay's nftables file"
        say "still has $n_file line(s) through $OLD. Nobody made that on purpose, and there is no live rule to learn"
        say "the right target from: look at the relay's file and its live rules by hand."
        return 1
      fi
      say "$OLD carries no hop (no live rule and no file line on the relay goes through it): nothing to move"
      state_set move_hop none
      rm -rf "$RUN_DIR/hopx" "$RUN_DIR"/hop-* "$RUN_DIR"/nft.*
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
    tool chain-from-relay "$RUN_DIR/hop-live.txt" "$RUN_DIR/chain.new" "$RELAY_HOST" "$oldip" "$NEW_IP" >/dev/null || return 1
    say "the hop carries $n exit(s): $(cut -d'|' -f2 "$RUN_DIR/hop-through.txt" | tr '\n' ' ')"
    say "  still through $OLD: $n_old; already through the new server (an earlier pass): $n_new; lines through $OLD in the relay's file: $n_file"
  fi
  # 1. the new server gets the table (loading it again is harmless: it is
  #    the same table, and flows already through it keep their entries)
  rput new "$RUN_DIR/chain.new" "$REMOTE_DIR/chain-fw.nft.new" 600 || return 1
  rscript new node/hop-server.sh apply || return 1
  undo "on the new server: $REMOTE_DIR/hop-server.sh remove (or: systemctl disable --now neoxify-chain-fw; nft delete table ip neoxify_chain)"
  dry && n="<exits>"
  rsh new "$REMOTE_DIR/hop-server.sh check $n" || { say "the new server's hop table is not as it should be: the relay was not touched"; return 1; }
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
  # 3. the relay: each live rule that is still through the old server
  #    repointed by its handle, then the same lines in the file
  rsh relay "$REMOTE_DIR/relay.sh hop-backup move-to-$(nn)" || return 1
  if dry; then
    rput relay "$RUN_DIR/hop-rule.txt" "$REMOTE_DIR/hop-rule.txt" 600
    rsh relay "$REMOTE_DIR/relay.sh hop-set <handle>   (once per exit still through the old server)"
  else
    while IFS='|' read -r handle exitname port; do
      tool hop-rule "$(cat "$RUN_DIR/hopx/$handle.exit")" "$NEW_IP" "$port" "$exitname" "$(nn)" "$RUN_DIR/hop-rule.txt" || return 1
      rput relay "$RUN_DIR/hop-rule.txt" "$REMOTE_DIR/hop-rule.txt" 600 || return 1
      rsh relay "$REMOTE_DIR/relay.sh hop-set $handle" | sed "s/^/  $exitname: /" || return 1
    done <"$RUN_DIR/hop-old.txt"
    [[ $n_old -gt 0 ]] || say "no live rule is left through $OLD (an earlier pass moved them)"
  fi
  undo "on the relay box, per exit: nft replace rule ip neoxify_relay_chain output handle <h> <the old rule, from /root/nft-live.bak-pre-move-to-$(nn)-*>"
  if dry || [[ "$n_file" != 0 ]]; then
    dry || tool hop-file-repoint "$RUN_DIR/nft.old" "$RUN_DIR/nft.new" "$oldip" "$NEW_IP" "$(nn)" >/dev/null || return 1
    rput relay "$RUN_DIR/nft.new" "$REMOTE_DIR/nftables.conf.new" 600 || return 1
    rsh relay "$REMOTE_DIR/relay.sh hop-file-swap" || return 1
    undo "on the relay box: cp -a /etc/nftables.conf.bak-pre-move-to-$(nn)-<time> /etc/nftables.conf (never load that file)"
  else
    say "the relay's nftables file has no line through $OLD (an earlier pass edited it)"
  fi
  dry && return 0
  state_set move_hop "$n"
  state_set move_hop_exits "$(cut -d'|' -f2 "$RUN_DIR/hop-through.txt" | tr '\n' ' ')"
  rm -rf "$RUN_DIR/hopx" "$RUN_DIR"/hop-* "$RUN_DIR"/chain.* "$RUN_DIR"/nft.*
}
# What this run recorded is not taken for the answer: the relay's live
# rules and its file are read again, every time. A run whose state says
# "nothing was moved" while rules go through the new server, or while the
# file still names the old one, fails here.
ok_move_hop() {
  local oldip left now fleft fnow want bad=0
  expect "no live rule and no file line on the relay goes through the old server, and as many of each go through the new one as this step moved; the new server's hop table is loaded with exactly those exits, is the file it loads at boot, its unit is enabled and forwarding is on and written down; and a relay tunnel to each exit behind the hop still exits on that exit's own address"
  oldip="$(old_ip)" || return 1
  rscript relay relay/relay.sh hop-list >/dev/null || return 1
  rget relay "$REMOTE_DIR/hop-live.txt" "$RUN_DIR/hop-live.txt" || return 1
  rget relay /etc/nftables.conf "$RUN_DIR/nft.chk" || return 1
  relay_pid_same || return 1
  if dry; then
    rscript new node/hop-server.sh check "<exits>"
    hop_exits_dial "through the moved hop"
    return 0
  fi
  left="$(tool hop-count "$RUN_DIR/hop-live.txt" hop "$oldip")" || return 1
  now="$(tool hop-count "$RUN_DIR/hop-live.txt" hop "$NEW_IP")" || return 1
  fleft="$(tool hop-count "$RUN_DIR/nft.chk" hop "$oldip")" || return 1
  fnow="$(tool hop-count "$RUN_DIR/nft.chk" hop "$NEW_IP")" || return 1
  rm -f "$RUN_DIR/hop-live.txt" "$RUN_DIR/nft.chk"
  say "hop rules through the old server: $left live, $fleft in the relay's file; through the new one: $now live, $fnow in the file"
  [[ "$left" == 0 ]] || { say "a live rule on the relay still goes through $OLD"; bad=1; }
  [[ "$fleft" == 0 ]] || { say "the relay's file still has a line through $OLD: it would be loaded at the relay's next boot"; bad=1; }
  want="$(st move_hop none)"
  if [[ "$want" == none ]]; then
    [[ "$now" == 0 && "$fnow" == 0 ]] || { say "rules go through the new server, but this run has no record of a finished move: run the step again"; bad=1; }
    return $bad
  fi
  [[ "$now" == "$want" && "$fnow" == "$want" ]] || { say "this step moved $want exit(s); the relay has $now live rule(s) and $fnow file line(s) through the new server"; bad=1; }
  rscript new node/hop-server.sh check "$want" || bad=1
  # shellcheck disable=SC2046
  hop_exits_dial "through the moved hop" $(st move_hop_exits "") || bad=1
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
  # Before the build, not after it: when the old box is already deleted
  # at the provider, its names point at an address a stranger may hold,
  # and the build and its proofs take an hour at best.
  register_retire_reach
  step add.params auto "Name is free; region, peer, disguise site and versions settled"
  step add.access auto "Key-only access to the panel host, both inside boxes and the new box"
  step add.snapshot auto "Read-only snapshot of the fleet into the run log"
  register_precheck_steps
  register_add_steps
  step move.hop ask "Relay hop moved to the new server before the old one goes (only if the old one carries it)"
  step add.plans auto "Plans, one at a time: the new server in and the old one out in the same edit (database dump first)"
  # Nothing reaches a customer until every proof before this has passed
  # in this run. --from and --only do not get round that.
  needs_prior add.plans
  step add.provision auto "Provisioning check: credentials created and acknowledged"
  step add.e2e-issued auto "Tunnels again, with credentials the panel issued"
  step add.monitoring auto "Monitoring picked it up: inside probe reading and the server's API door"
  step move.defaults auto "No plan route and no plan default left on the old server"
  step retire.snapshot auto "Read-only snapshot of the old server: status, routes, plans, names"
  register_retire_guards
  register_retire_steps
  step add.owner-after owner "What only the owner can do for the new server afterwards"
  step add.cleanup auto "Scratch files shredded on every host"
}
