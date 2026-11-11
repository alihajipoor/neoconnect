# shellcheck shell=bash
# `fleet precheck <ip>`: is this empty box worth building on?
#
# Before anything is installed, the raw address is tested from both boxes
# inside the watched country with a real 256 KB upload and download on
# three ports. Not a TCP connect: a held address range lets the
# connection open and then stalls the upload after 60-150 KB, and every
# connect-only checker stays green on it. A box that fails here would be
# a server that never worked for the customers it is for.

PRE_PORTS="443 2053 8443"

do_pre_access() {
  local r fail=0
  for r in panel relay signin new; do
    if rsh "$r" "true"; then
      dry || say "$r: key-only access works"
    else
      say "$r: NO key-only access (never sign in with a password; fix the key and run again)"
      fail=1
    fi
  done
  [[ $fail -eq 0 ]] || return 1
  dry || state_set access ok
}
ok_pre_access() {
  expect "the panel host, both inside boxes and the new box each answered a key, with password login refused by this tool"
  dry || [[ "$(st access "")" == ok ]]
}

do_pre_sink() {
  local busy
  busy="$(rsh new "ss -ltnH | awk '{print \$4}' | grep -cE ':(443|2053|8443)\$' || true")" || return 1
  if ! dry && [[ "$busy" != 0 ]]; then
    say "ports 443/2053/8443 are in use: this box is already built. The bare-box test is for an empty box;"
    say "for a built server read the inside probe instead (fleet status <name>)."
    return 1
  fi
  rpushdir new node || return 1
  rsh new "command -v python3 >/dev/null || { echo no-python3; exit 1; }; for p in $PRE_PORTS; do nohup timeout 230 python3 $REMOTE_DIR/sink.py \$p 220 > $REMOTE_DIR/sink-\$p.log 2>&1 < /dev/null & done; sleep 1; echo sinks-started"
}
ok_pre_sink() {
  local n
  n="$(rsh new "ss -ltnH | awk '{print \$4}' | grep -cE ':(443|2053|8443)\$' || true")" || return 1
  expect "three listeners on the new box"
  dry || [[ "$n" == 3 ]]
}

do_pre_probe() {
  local b out port verdict rest
  for b in relay signin; do
    rpushdir "$b" inside || return 1
    out="$(rsh "$b" "$REMOTE_DIR/inside.sh bare $NEW_IP $PRE_PORTS")" || true
    dry && continue
    while read -r port verdict rest; do
      [[ "$port" =~ ^[0-9]+$ ]] || continue
      printf '  %-7s port %-5s %-6s %s\n' "$b" "$port" "$verdict" "$rest"
      state_set "pre_${b}_${port}" "$verdict"
    done <<<"$out"
  done
}
ok_pre_probe() {
  local b p
  expect "a PASS, HELD or CLOSED reading for each of the three ports from each inside box"
  dry && return 0
  for b in relay signin; do
    for p in $PRE_PORTS; do
      state_has "pre_${b}_${p}" || { say "no reading from $b for port $p"; return 1; }
    done
  done
}

do_pre_cleanup() {
  # The bracket in the pattern keeps pkill from matching the shell that
  # carries the pattern: a plain `pkill -f sink.py` once killed its own
  # SSH session.
  rsh new "cat $REMOTE_DIR/sink-*.log 2>/dev/null | sort | uniq -c; pkill -f '[p]ython3 $REMOTE_DIR/s[i]nk.py'; rm -f $REMOTE_DIR/sink*; true"
  rclean relay
  rclean signin
}
ok_pre_cleanup() {
  local n
  n="$(rsh new "pgrep -fc '[p]ython3 $REMOTE_DIR/s[i]nk.py' || true")" || return 1
  expect "no sink left running on the new box, nothing left on the inside boxes"
  dry || [[ "$n" == 0 ]]
}

do_pre_reputation() {
  # A readout, not a gate: one feed's free tier changing shape crashes the
  # script, and whether a datacentre flag is acceptable is the owner's call.
  rput panel "$REPO_ROOT/scripts/check-exit-reputation.py" "$REMOTE_DIR/rep/check-exit-reputation.py" 600 || return 1
  local out
  out="$(rsh panel "cd $REMOTE_DIR/rep && timeout 300 python3 -I check-exit-reputation.py --nodes-from args --node candidate=$NEW_IP --artifact-dir $REMOTE_DIR/rep/out 2>&1 | tail -30; rm -rf $REMOTE_DIR/rep")" || true
  dry && return 0
  echo "$out" | sed 's/^/  /'
  if grep -q 'Traceback' <<<"$out"; then say "readout INCOMPLETE: the reputation script stopped on one of its sources"; fi
  state_set reputation shown
}
ok_pre_reputation() {
  expect "a reputation readout was shown (it is information for the owner, never a pass)"
  dry || state_has reputation
}

do_pre_ptr() {
  local ptr
  ptr="$(rsh panel "dig +short -x $NEW_IP | head -1")" || true
  dry && return 0
  if [[ -z "$ptr" ]]; then
    say "reverse DNS: none"
  elif grep -qiE 'neox|vpn|proxy|tunnel|node' <<<"$ptr"; then
    say "reverse DNS CARRIES A TELLING WORD. OWNER: ask the provider for an empty or generic name"
    say "(a droplet's name becomes its reverse DNS at some providers: rename the machine)."
  else
    say "reverse DNS: a generic provider name"
  fi
  state_set ptr shown
}
ok_pre_ptr() {
  expect "the reverse DNS name was read and judged (generic, none, or telling)"
  dry || state_has ptr
}

do_pre_verdict() {
  local b p v held=0
  dry && { say "print PASS or HELD per box and port; any HELD stops here unless --accept-held records the owner's decision"; return 0; }
  echo "  box     port  verdict"
  for b in relay signin; do
    for p in $PRE_PORTS; do
      v="$(st "pre_${b}_${p}" MISSING)"
      printf '  %-7s %-5s %s\n' "$b" "$p" "$v"
      [[ "$v" == PASS ]] || held=1
    done
  done
  state_set pre_held "$held"
  if [[ $held -eq 1 ]]; then
    say "HELD: at least one path from inside does not move 256 KB both ways."
    say "Do not build on a held range without the owner's say-so: a different provider or range is the usual answer."
    say "A green connect-only reachability page proves nothing here."
  else
    say "PASS on every port from both inside boxes."
  fi
}
ok_pre_verdict() {
  expect "every reading is PASS, or --accept-held was given"
  dry && return 0
  [[ "$(st pre_held 1)" == 0 ]] && return 0
  if [[ "$OPT_ACCEPT_HELD" == 1 ]]; then
    say "continuing on a HELD box: --accept-held (the owner's decision, recorded in this run log)"
    return 0
  fi
  return 1
}

register_precheck_steps() {
  step pre.sink auto "Byte sinks started on the empty box (443, 2053, 8443)"
  step pre.probe auto "256 KB up and down from both inside boxes, three ports"
  step pre.cleanup auto "Sinks stopped, probe files removed"
  step pre.reputation auto "Reputation readout (the address goes to third-party lookups)"
  step pre.ptr auto "Reverse DNS readout"
  step pre.verdict gate "Verdict: PASS or HELD per box and port"
}

checklist_precheck() {
  step pre.access auto "Key-only access to the panel host, both inside boxes and the new box"
  register_precheck_steps
}
