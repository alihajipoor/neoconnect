# shellcheck shell=bash
# `fleet add <name> <ip> --region <r>`: from an empty Ubuntu box to a
# server that is proven and in the plans.
#
# The order is fixed and is the point: checks from inside the country on
# the bare box, then the build, then a reboot while nobody is on it, then
# real tunnels whose exit address must match, and only then the plans.
# Nothing reaches a customer before the proofs pass.

NODE_PROTOS="REALITY TLS WS TROJAN SS"
RELAY_PROTOS="REALITY TLS TROJAN SS"

# ---------------------------------------------------------------- part 0

do_add_params() {
  local c peer dest ver region="${REGION:-$(st region "")}"
  [[ "$region" =~ ^[a-z]{2}-[a-z-]+$ ]] || dry || die "region must look like de-germany (two letters, a dash, the country)"
  c="$(q name-count "name=$(nn)")" || return 1
  peer="${OPT_PEER:-$(q peer-pick "name=$(nn)" "region=$region")}" || return 1
  dest="${DEST:-$(st dest "")}"
  [[ -n "$dest" ]] || dest="$(q region-dest "region=$region")" || return 1
  ver="${FLEET_AGENT_VERSION:-$(q fleet-agent-version)}" || return 1
  dry && return 0
  if [[ "$c" != 0 ]]; then
    say "a server named $(nn) already exists. Names are never reused: nothing can rename a server"
    say "afterwards, and a wrong name means building it again. Pick the next number."
    return 1
  fi
  [[ -n "$peer" ]] || { say "no online server to compare the new one with; name one with --peer"; return 1; }
  [[ "$dest" =~ ^[a-z0-9.-]+:[0-9]+$ ]] || { say "no disguise site known for region $region: pass --dest host:443 (a real site hosted in that country, not behind a CDN)"; return 1; }
  [[ "$ver" =~ ^v[0-9] ]] || { say "could not tell which agent version the fleet runs"; return 1; }
  state_set name "$(nn)"
  state_set region "$region"
  state_set peer "$peer"
  state_set dest "$dest"
  state_set agent_version "$ver"
  say "name $(nn), region $region, protocol set compared with $peer, disguise site ${dest%:*}, agent $ver, Xray $XRAY_VERSION"
}
ok_add_params() {
  expect "the name is free, a peer and a disguise site are known, the fleet's agent version is known"
  dry || { state_has peer && state_has dest && state_has agent_version; }
}

do_add_access() { do_pre_access; }
ok_add_access() { ok_pre_access; }

do_add_snapshot() {
  q snapshot | sed 's/^/  /' || return 1
  local out
  out="$(rscript relay relay/relay.sh state)" || return 1
  dry && return 0
  echo "  relay box: $out" | head -3
  state_set relay_pid "$(sed -n 's/^xray pid \([0-9]*\),.*/\1/p' <<<"$out" | head -1)"
  state_set snapshot taken
}
ok_add_snapshot() {
  expect "the fleet as it is now is in the run log, and the relay box's Xray process id is recorded"
  dry || [[ "$(st relay_pid "")" =~ ^[0-9]+$ ]]
}

# The relay's Xray must be the same process at the end as at the start.
relay_pid_same() {
  local out pid
  out="$(rscript relay relay/relay.sh state)" || return 1
  dry && return 0
  pid="$(sed -n 's/^xray pid \([0-9]*\),.*/\1/p' <<<"$out" | head -1)"
  if [[ "$pid" == "$(st relay_pid x)" ]]; then
    say "relay box Xray: same process as at the start (never restarted)"
  else
    say "RELAY BOX XRAY IS A DIFFERENT PROCESS than at the start. Something restarted it: hot-added"
    say "routes and users were lost until the panel re-asserts them. Check every relay route now."
    return 1
  fi
}

do_add_zone_inside() {
  local out rc=0
  rpushdir relay inside || return 1
  out="$(rsh relay "$REMOTE_DIR/inside.sh zone $NODE_DNS_ZONE")" || rc=$?
  dry && return 0
  say "$out"
  if [[ $rc -eq 0 ]]; then state_set zone_inside clean; else state_set zone_inside rewritten; fi
}
ok_add_zone_inside() {
  expect "a name that was never created under the node zone gets no address from inside (the zone is not blocked whole), or --accept-blocked-zone"
  dry && return 0
  [[ "$(st zone_inside "")" == clean ]] && return 0
  say "Every name under the node zone is rewritten inside the country. On a server named under it,"
  say "VLESS-TLS, WebSocket, Trojan and IKEv2 will not work from there, and neither will its mirrors."
  say "REALITY, Shadowsocks and the relay entries still will."
  say "Put another zone in fleet.env (NODE_DNS_ZONE), or record the owner's decision with --accept-blocked-zone."
  [[ "$OPT_ACCEPT_ZONE" == 1 ]] && { say "continuing: --accept-blocked-zone"; return 0; }
  return 1
}

# ---------------------------------------------------------------- part B: build

do_add_second_key() {
  if [[ -z "${EXTRA_AUTHORIZED_KEY_FILE:-}" ]]; then
    say "no second operator key configured (EXTRA_AUTHORIZED_KEY_FILE): nothing to add"
    dry || state_set second_key none
    return 0
  fi
  rput new "$EXTRA_AUTHORIZED_KEY_FILE" "$REMOTE_DIR/extra.pub" 600 || return 1
  rsh new "K=\$(head -1 $REMOTE_DIR/extra.pub); rm -f $REMOTE_DIR/extra.pub; [ -n \"\$K\" ] || exit 1; cp -a /root/.ssh/authorized_keys /root/.ssh/authorized_keys.bak-pre-fleet; grep -qF \"\$K\" /root/.ssh/authorized_keys || echo \"\$K\" >> /root/.ssh/authorized_keys; echo \"keys now: \$(grep -c . /root/.ssh/authorized_keys)\"" || return 1
  undo "on the new box: cp -a /root/.ssh/authorized_keys.bak-pre-fleet /root/.ssh/authorized_keys"
  dry || state_set second_key added
}
ok_add_second_key() {
  expect "the second machine's public key is in authorized_keys; sshd's own settings are untouched"
  dry && return 0
  state_has second_key && rsh new "true"
}

do_add_inventory() {
  local dest out
  dest="$(need dest)" || return 1
  rscript new node/prep.sh inventory "${dest%:*}" "$PANEL_ORIGIN_NAME" "$PANEL_HOST" "$PANEL_GRPC_PORT" || return 1
  out="$(rsh new "$REMOTE_DIR/prep.sh ports")" || return 1
  dry && return 0
  if ! state_has ss_port; then
    state_set ss_port "$(sed -n 's/.*SS=\([0-9]*\).*/\1/p' <<<"$out")"
    state_set wg_port "$(sed -n 's/.*WG=\([0-9]*\).*/\1/p' <<<"$out")"
    state_set ovpn_port "$(sed -n 's/.*OVPN=\([0-9]*\).*/\1/p' <<<"$out")"
  fi
  say "random free ports chosen for Shadowsocks, WireGuard and OpenVPN"
}
ok_add_inventory() {
  expect "Ubuntu or Debian, fast name lookups, clock in sync, the panel's control port and API reachable; three free ports chosen"
  dry || [[ "$(st ss_port "")" =~ ^[0-9]+$ && "$(st wg_port "")" =~ ^[0-9]+$ && "$(st ovpn_port "")" =~ ^[0-9]+$ ]]
}

do_add_mask_upgrades() {
  rscript new node/prep.sh mask-upgrades || return 1
  undo "on the new box: systemctl unmask apt-daily-upgrade.timer apt-daily.timer unattended-upgrades.service && systemctl enable --now apt-daily-upgrade.timer apt-daily.timer unattended-upgrades.service"
}
ok_add_mask_upgrades() {
  local n
  n="$(rsh new "for u in apt-daily-upgrade.timer apt-daily.timer unattended-upgrades.service; do systemctl is-enabled \$u 2>&1 | head -1; done | grep -c masked")" || true
  expect "all three units report masked (security updates are manual on this server from now on: tell the owner)"
  dry || [[ "$n" == 3 ]]
}

do_add_packages() {
  rscript new node/prep.sh packages || return 1
  undo "none worth doing: the box is new; rebuild it instead"
}
ok_add_packages() {
  local out
  out="$(rsh new "command -v nginx certbot wg openvpn swanctl tmux jq fail2ban-client >/dev/null && echo tools-ok; fail2ban-client get sshd journalmatch 2>/dev/null | grep -c sshd-session")" || true
  expect "every package is there, and the sshd jail also matches sshd-session"
  dry || { grep -q tools-ok <<<"$out" && [[ "$(tail -1 <<<"$out")" -ge 1 ]]; }
}

do_add_firewall() {
  say "OWNER, only if the provider puts a firewall in front of the box (most do not):"
  say "  open TCP 22, 80, 443, 2053, 8443, 2096 and $(st ss_port "{ss_port}")"
  say "  open UDP $(st ss_port "{ss_port}"), $(st wg_port "{wg_port}"), $(st ovpn_port "{ovpn_port}"), 500 and 4500"
  say "80 stays open for good: certificates renew through it. Never move 443, 2053, 8443, 500 or 4500."
  say "The installer cannot do this and prints no reminder for the UDP ports."
}
ok_add_firewall() {
  expect "nothing to check yet: closed TCP ports show in add.verify, closed UDP ports in add.udp-reach"
  return 0
}

do_add_dns() {
  local n
  if dry; then
    cf get "$NODE_DNS_ZONE" "{l1}"
    cf create-a "$NODE_DNS_ZONE" "{l1}" "$NEW_IP"
    cf create-a "$NODE_DNS_ZONE" "{l2}" "$NEW_IP"
    return 0
  fi
  for n in l1 l2; do
    state_has "$n" && continue
    local name out
    name="$(tool label).$NODE_DNS_ZONE" || return 1
    out="$(cf get "$NODE_DNS_ZONE" "$name")" || return 1
    [[ "$out" == free ]] || { say "a random name was already taken; run the step again"; return 1; }
    cf create-a "$NODE_DNS_ZONE" "$name" "$NEW_IP" | sed 's/^/  /' || return 1
    state_set "$n" "$name"
  done
  say "two names created, DNS-only, no AAAA: the first for TLS, IKEv2 and the mirror, the second for the direct mirror"
  undo "fleet dns sweep <the new address> /dev/null $NODE_DNS_ZONE --delete   (or: fleet dns delete $NODE_DNS_ZONE <record id from the lines above>)"
}
ok_add_dns() {
  local n try
  expect "a public resolver answers both names with exactly the new address"
  dry && { cf doh "{l1}" "$NEW_IP"; cf doh "{l2}" "$NEW_IP"; return 0; }
  for n in l1 l2; do
    for try in 1 2 3 4 5 6; do
      cf doh "$(st "$n")" "$NEW_IP" >/dev/null && continue 2
      sleep 10
    done
    say "the $n name does not resolve to the new address yet (try $try)"
    return 1
  done
}

do_add_certs() {
  rscript new node/prep.sh certs "$(need l1)" "$(need l2)" || return 1
  undo "on the new box: certbot delete --cert-name <each name>"
}
ok_add_certs() {
  local out
  out="$(rsh new "test -s /etc/letsencrypt/live/$(need l1)/fullchain.pem && test -s /etc/letsencrypt/live/$(need l2)/fullchain.pem && echo certs-present")" || true
  expect "one certificate per name (never two of our names on one: the public logs would publish the pair), the first RSA"
  dry || [[ "$out" == certs-present ]]
}

do_add_installer_push() {
  if dry; then
    echo "local \$ git diff --quiet HEAD -- installer   (the box gets a committed installer, never a working copy)" >&2
    echo "local \$ tar -cf - installer | ssh <new> (unpack to /root/neoxify-installer, owned by root)" >&2
    return 0
  fi
  git -C "$REPO_ROOT" diff --quiet HEAD -- installer || { say "installer/ has uncommitted changes: commit or stash them, the box gets a committed installer"; return 1; }
  state_set installer_commit "$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
  tar -C "$REPO_ROOT" -cf - installer | rpipe new "rm -rf /root/neoxify-installer /root/neoxify-installer-src && mkdir -p /root/neoxify-installer-src && tar --no-same-owner -xf - -C /root/neoxify-installer-src && mv /root/neoxify-installer-src/installer /root/neoxify-installer && rmdir /root/neoxify-installer-src && chown -R root:root /root/neoxify-installer && chmod +x /root/neoxify-installer/install.sh && echo installer-in-place" || return 1
  say "installer from commit $(st installer_commit)"
}
ok_add_installer_push() {
  local out
  out="$(rsh new "grep -lr \$'\\r' /root/neoxify-installer | wc -l; bash -n /root/neoxify-installer/lib/agent.sh && echo syntax-ok")" || true
  expect "no file with Windows line endings on the box, and the installer parses"
  dry || { [[ "$(head -1 <<<"$out")" == 0 ]] && grep -q syntax-ok <<<"$out"; }
}

do_add_dump_node() { panel_dump "pre-$(nn)-node"; }
ok_add_dump_node() {
  expect "a database dump from the last few minutes, checked with gzip -t"
  dry || (($(date +%s) - $(st last_dump 0) < 1800))
}

do_add_token() {
  panel_mint || return 1
  rsh panel "cat $TOKEN_FILE" | rpipe new "umask 077; mkdir -p $REMOTE_DIR; cat > $REMOTE_DIR/admin-token; chmod 600 $REMOTE_DIR/admin-token; test -s $REMOTE_DIR/admin-token && echo token-on-box" || return 1
  dry || state_set token_at "$(date +%s)"
  say "the installer creates the server in the panel itself with this token. It lives 15 minutes and is"
  say "never refreshed, so the installer starts now and must finish inside that."
}
ok_add_token() {
  expect "the token is on the box, in RAM, mode 600, and is under two minutes old"
  dry || (($(date +%s) - $(st token_at 0) < 120))
}

install_answers() {
  local weak="@STOP"
  [[ "$OPT_ACCEPT_DEST" == 1 ]] && weak="y"
  # <regex><TAB><answer>, first match wins. Anything not listed is left
  # for a person: the driver reports it and waits.
  cat <<EOF
Choose \\[1-2\\]:	2
Panel URL, including /api	$PANEL_API_URL
Name for this node	$(nn)
Region label	$(need region)
^Public IP \\[	$NEW_IP
Panel gRPC address	$PANEL_HOST:$PANEL_GRPC_PORT
Install Xray .*\\[Y/n\\]	Y
Listen port for VLESS\\+REALITY	443
Camouflage destination	$(need dest)
Use it anyway\\? \\[y/N\\]	$weak
Set them up\\? \\[Y/n\\]	Y
Domain for the certificate	$(need l1)
Port for VLESS over TLS	2053
Port for Trojan over TLS	8443
Path for the WebSocket	@BRACKET
Port for Shadowsocks 2022	$(need ss_port)
Is this a RELAY node\\?	n
Install WireGuard .*\\[Y/n\\]	Y
Listen port for WireGuard	$(need wg_port)
Client subnet, /24 only	10.66.0.0/24
DNS to hand out to clients	1.1.1.1
Public endpoint host	$NEW_IP
Install OpenVPN .*\\[Y/n\\]	Y
Listen port for OpenVPN	$(need ovpn_port)
Protocol, udp or tcp	udp
Install IKEv2 .*\\[y/N\\]	y
DNS name clients will connect to	$(need l1)
^Choice \\[1\\]:	1
EOF
}

do_add_install() {
  local st_ i shown=""
  if ! dry && [[ "$(rsh new "test -f /etc/neoxify/agent.json && echo enrolled")" == enrolled ]]; then
    say "this box is already enrolled: the installer is not run a second time (that would register a second"
    say "server and abandon the first). Checking what the first run left."
    return 0
  fi
  if ! dry; then
    (($(date +%s) - $(st token_at 0) < 180)) || { say "the admin token is older than three minutes: run again with --from add.token"; return 1; }
    install_answers >"$RUN_DIR/answers.tsv" || return 1
  fi
  dry && { say "answers, one per prompt:"; install_answers | sed 's/\t/  ->  /; s/^/    /'; }
  rpushdir new node || return 1
  rput new "$RUN_DIR/answers.tsv" "$REMOTE_DIR/answers.tsv" 600 || return 1
  rsh new "$REMOTE_DIR/install-drive.sh start $REMOTE_DIR/answers.tsv $PANEL_HOST:$PANEL_GRPC_PORT $PANEL_ORIGIN_NAME" || return 1
  dry && { rsh new "$REMOTE_DIR/install-drive.sh status"; return 0; }
  rm -f "$RUN_DIR/answers.tsv"
  for i in $(seq 1 90); do
    sleep 10
    st_="$(rsh new "$REMOTE_DIR/install-drive.sh status")" || continue
    case "$st_" in
      "DONE 0"*)
        say "installer finished"
        rsh new "$REMOTE_DIR/install-drive.sh screen 12"
        return 0
        ;;
      DONE*)
        say "installer ended badly: $st_"
        rsh new "$REMOTE_DIR/install-drive.sh screen 40"
        return 1
        ;;
      STUCK*)
        if [[ "$st_" != "$shown" ]]; then
          say "THE INSTALLER ASKS SOMETHING THIS CHECKLIST HAS NO ANSWER FOR:"
          say "  ${st_#STUCK }"
          say "Sign in to the box, run 'tmux attach -t nx', answer it, detach with Ctrl-b d. This step keeps watching."
          shown="$st_"
        fi
        ;;
    esac
  done
  say "the installer did not finish in 15 minutes; its screen:"
  rsh new "$REMOTE_DIR/install-drive.sh screen 40"
  return 1
}
ok_add_install() {
  local row direct peerdirect
  row="$(q node-row "name=$(nn)")" || return 1
  direct="$(q route-ids "name=$(nn)" kind=direct)" || return 1
  peerdirect="$(q route-ids "name=$(st peer "{peer}")" kind=direct)" || return 1
  expect "the server exists in the panel and is ONLINE, with as many direct routes as its peer (one per protocol)"
  dry && return 0
  [[ -n "$row" ]] || { say "the installer did not create the server in the panel"; return 1; }
  state_set node_id "${row%%|*}"
  local n p
  n="$(tr ',' '\n' <<<"$direct" | grep -c .)"
  p="$(tr ',' '\n' <<<"$peerdirect" | grep -c .)"
  say "status $(cut -d'|' -f4 <<<"$row"), $n direct routes (its peer has $p)"
  [[ "$(cut -d'|' -f4 <<<"$row")" == ONLINE && "$n" == "$p" && "$n" -gt 0 ]] || {
    say "An engine did not register. Repair it first (--only add.postfix fixes a dead Xray), add the missing"
    say "engine from the box's own menu (install.sh, then 5), and run the same command again: this check repeats."
    return 1
  }
}

do_add_install_cleanup() {
  rsh new "$REMOTE_DIR/install-drive.sh cleanup" || return 1
  panel_token_shred
}
ok_add_install_cleanup() {
  local a b
  a="$(rsh new "test ! -e $REMOTE_DIR/admin-token && test ! -e /root/.nx_token && ! tmux has-session -t nx 2>/dev/null && echo clean")" || true
  b="$(rsh panel "test ! -e $TOKEN_FILE && echo clean")" || true
  expect "no token file on the box or the panel host, and the installer's session is closed"
  dry || [[ "$a" == clean && "$b" == clean ]]
}

do_add_postfix() {
  if rscript new node/postinstall.sh check "$XRAY_VERSION" "$NEW_IP"; then
    dry || say "the installer left nothing to repair"
    dry || return 0
  fi
  dry && say "only if the check above found drift (a box built with an older installer):"
  RENV="NX_ALLOW_RESTART=1 " rscript new node/postinstall.sh fix "$XRAY_VERSION" "$NEW_IP" || return 1
  undo "on the new box: the unit and rules it replaced are saved beside it (/root/xray.service.before-fleet-*, /etc/iptables/rules.v4.bak-pre-selfloop-*)"
}
ok_add_postfix() {
  expect "seven times ok: Xray as nobody at the pinned version, readable certificate copy, strongSwan loader bound to the unit that exists, WireGuard public key readable, self-connect guard, conntrack limit"
  rsh new "$REMOTE_DIR/postinstall.sh check $XRAY_VERSION $NEW_IP"
}

do_add_parity() {
  rscript new node/parity.sh apply "$PANEL_HOST" "$PANEL_ORIGIN_NAME" "$(need l1)" "$(need l2)" || return 1
  undo "on the new box: every file it changed is in /root/pre-parity-<time>/ (named in the lines above); copy back and reload nginx"
}
ok_add_parity() {
  expect "ok for nginx (mirror by address, direct mirror on 2096), hooks (per certificate), agent (control name), openvpn (ccd-exclusive), ipv6 (closed for Xray), modes"
  rsh new "$REMOTE_DIR/parity.sh check $PANEL_HOST $PANEL_ORIGIN_NAME $(need l1) $(need l2)"
}

do_add_egress() { say "read-only: the check is the step"; }
ok_add_egress() {
  expect "UOT-PASS: a DNS question over Shadowsocks UDP-over-TCP is answered through this server's own Xray"
  rscript new node/uot-test.sh
}

do_add_renew_dry() {
  rsh new "timeout 900 certbot renew --dry-run --run-deploy-hooks --no-random-sleep-on-renew 2>&1 | grep -E 'success|fail|error|Congratulations|simulated' | tail -6"
}
ok_add_renew_dry() {
  local out
  out="$(rsh new "stat -c '%a %U:%G' /usr/local/etc/xray/certs/privkey.pem /usr/local/etc/xray/certs/fullchain.pem | tr '\n' ' '; systemctl is-active xray nginx | tr '\n' ' '")" || true
  expect "after a simulated renewal the hooks left Xray's certificate copy readable by nobody (400 and 644) and Xray and nginx running"
  dry || [[ "$out" == "400 nobody:nogroup 644 nobody:nogroup active active "* ]]
}

do_add_maintenance_audit() {
  local s out="" dest
  dest="$(need dest)" || return 1
  for s in isolate-tunnel-clients xray-ipv4-only no-self-loop; do
    out+="== $s"$'\n'"$(lrun bash "$REPO_ROOT/installer/maintenance/$s.sh" "root@$NEW_IP" "$NODE_KEY" 2>&1 | tail -12)"$'\n'
  done
  out+="== reality-dest-audit"$'\n'"$(rsh new "bash /root/neoxify-installer/maintenance/reality-dest-audit.sh ${dest%:*} 2>&1 | tail -6")"$'\n'
  dry && return 0
  echo "$out" | sed 's/^/  /'
  echo "$out" >"$RUN_DIR/audit.out"
}
ok_add_maintenance_audit() {
  expect "the repository's maintenance scripts, run dry, find nothing to change on a fresh build (a diff means the install drifted from the template); the disguise-site rating is shown for the owner"
  dry && return 0
  if grep -qE '^\s*would (insert|append)|^would ' "$RUN_DIR/audit.out"; then say "a maintenance script wants to change something"; return 1; fi
  [[ "$(grep -c 'Nothing to do' "$RUN_DIR/audit.out")" -ge 2 ]] || { say "xray-ipv4-only and no-self-loop must both say 'Nothing to do.'"; return 1; }
}

do_add_agent_version() {
  local have want
  want="$(need agent_version)" || return 1
  have="$(rsh new "/usr/local/bin/agentd --version 2>&1 | head -1")" || return 1
  dry && { lrun bash "$REPO_ROOT/installer/maintenance/push-agent-to-node.sh" "$want" "root@$NEW_IP" "$NODE_KEY"; return 0; }
  if grep -qF "$want" <<<"$have"; then
    say "agent $want, the fleet's version"
    return 0
  fi
  say "agent is '$have', the fleet runs $want: pushing (restarting the agent does not restart the engines)"
  lrun bash "$REPO_ROOT/installer/maintenance/push-agent-to-node.sh" "$want" "root@$NEW_IP" "$NODE_KEY" | tail -5
}
ok_add_agent_version() {
  local have
  have="$(rsh new "/usr/local/bin/agentd --version 2>&1 | head -1")" || true
  expect "the agent on the box reports the fleet's version"
  dry || grep -qF "$(st agent_version)" <<<"$have"
}

do_add_leftovers() {
  rsh new "for f in /root/pre-parity-*/agent.json; do [ -e \"\$f\" ] && shred -u \"\$f\"; done; rm -f /usr/local/etc/xray/config.json.bak-* /root/nx-install/answers.tsv; echo leftovers-removed"
}
ok_add_leftovers() {
  local n
  n="$(rsh new "ls /root/pre-parity-*/agent.json /usr/local/etc/xray/config.json.bak-* 2>/dev/null | wc -l")" || true
  expect "no copy of the agent's key file or of an old Xray config is left lying on the box"
  dry || [[ "$n" == 0 ]]
}

do_add_mirror_host() {
  panel_dump "pre-$(nn)-mirrorhost" || return 1
  q mirror-set "name=$(nn)" "host=$(need l1)" | sed 's/^/  mirror host set: /' || return 1
  undo "SQL on the panel host: UPDATE nodes SET \"mirrorHost\" = NULL WHERE name = '$(nn)';"
}
ok_add_mirror_host() {
  local row
  row="$(q node-row "name=$(nn)")" || return 1
  expect "the server's mirror host is recorded (a name on its certificate, never an address)"
  dry || [[ "$(cut -d'|' -f7 <<<"$row")" == t ]]
}

# Everything that must be true of a built server, from three sides: the
# box itself, the panel's database, and the panel host looking at it from
# outside. Run after the build and again after the reboot.
node_full_check() {
  local row diff names bad=0 hop="${1:-}"
  rscript new node/verify.sh "$(need l1)" "$(need l2)" "$hop" || bad=1
  row="$(q node-row "name=$(nn)")" || return 1
  diff="$(q config-diff "name=$(nn)" "peer=$(st peer "{peer}")")" || return 1
  names="$(q config-names "name=$(nn)" "host=$(need l1)")" || return 1
  pscript nx-node-outside.sh "$(nn)" "$(need l1)" "$(need l2)" || bad=1
  dry && return 0
  local status age dest_ok
  IFS='|' read -r _ _ _ status age _ _ _ dest_ok _ <<<"$row"
  if [[ "$status" == ONLINE && "$age" =~ ^[0-9]+$ && "$age" -le 90 ]]; then say "PASS panel: ONLINE, heartbeat $age s ago"; else say "FAIL panel: status $status, heartbeat ${age:-never}"; bad=1; fi
  if [[ "$dest_ok" == t || "$dest_ok" == true ]]; then say "PASS panel: the disguise site answers this server"; else say "FAIL panel: the disguise site is not reachable from this server (or not checked yet)"; bad=1; fi
  if [[ -z "$diff" ]]; then
    say "PASS protocol set and parameter keys equal its peer's"
  else
    say "FAIL protocol set differs from its peer (shape | this server's keys | the peer's keys):"
    echo "$diff" | sed 's/^/    /'
    bad=1
  fi
  if grep -q '|f$' <<<"$names"; then
    say "FAIL a published endpoint is wrong (WireGuard and OpenVPN must publish the address, TLS and IKEv2 the certificate name):"
    grep '|f$' <<<"$names" | cut -d'|' -f1 | sed 's/^/    /'
    bad=1
  else
    say "PASS every published endpoint is what it should be"
  fi
  return $bad
}

do_add_verify() { say "read-only: the checks are the step"; }
ok_add_verify() {
  expect "PASS on every line: units, Xray shape, IKEv2 id, pages, guards (on the box); ONLINE, protocol set equal to its peer, endpoints (in the panel); mirrors report the caller's own address, certificates verify, ports open (from outside)"
  node_full_check ""
}

do_add_reboot() {
  local have i
  have="$(q provision "name=$(nn)")" || return 1
  if ! dry && [[ "$(sed -n 's/^have|//p' <<<"$have")" != 0 ]]; then
    say "REFUSED: customers already have credentials on this server. The reboot test is free only before that."
    return 1
  fi
  rsh new "systemctl reboot" || true
  dry && { rsh new "uptime -s"; return 0; }
  sleep 20
  for i in $(seq 1 30); do
    if rsh new "uptime -s" 2>/dev/null; then
      sleep 20 # units and the agent settle
      return 0
    fi
    sleep 10
  done
  say "the box did not come back in five minutes (try $i)"
  return 1
}
ok_add_reboot() {
  expect "every check of add.verify again, on the rebooted box, and the UDP-over-TCP answer again"
  node_full_check "" || return 1
  rsh new "$REMOTE_DIR/uot-test.sh" || rscript new node/uot-test.sh
}

# ---------------------------------------------------------------- part P: proof

do_add_inside_probe() {
  local b id out port line dn up
  id="$(need node_id)" || return 1
  for b in relay signin; do
    rpushdir "$b" inside || return 1
    out="$(printf '%s %s 2053\n%s %s 8443\n' "$id" "$NEW_IP" "$id" "$NEW_IP" | rpipe "$b" "$REMOTE_DIR/inside.sh probe")" || true
    dry && continue
    while read -r line; do
      port="$(sed -n 's/.*"port":\([0-9]*\).*/\1/p' <<<"$line")"
      [[ -n "$port" ]] || continue
      dn="$(sed -n 's/.*"down":{"status":\([0-9]*\),"bytes":\([0-9]*\).*/\1 \2/p' <<<"$line")"
      up="$(sed -n 's/.*"up":{"status":\([0-9]*\),"bytes":\([0-9]*\).*/\1 \2/p' <<<"$line")"
      if [[ "$dn" == "200 262144" && "$up" == "200 262144" ]]; then
        state_set "inside_${b}_${port}" moves
      else
        state_set "inside_${b}_${port}" held
      fi
      printf '  %-7s port %-5s %-6s (down %s, up %s)\n' "$b" "$port" "$(st "inside_${b}_${port}")" "$dn" "$up"
    done <<<"$out"
  done
}
ok_add_inside_probe() {
  local b p held=0
  expect "256 KB moves both ways through the server on 2053 and 8443 from both inside boxes, or --accept-held. (This cannot see a block on a protocol's own handshake or on our names, and both boxes are datacentres.)"
  dry && return 0
  for b in relay signin; do
    for p in 2053 8443; do
      [[ "$(st "inside_${b}_${p}" missing)" == moves ]] || held=1
    done
  done
  [[ $held -eq 0 ]] && return 0
  [[ "$OPT_ACCEPT_HELD" == 1 ]] && { say "continuing with a held path: --accept-held"; return 0; }
  return 1
}

e2e_record() { # <state key> <output>
  if grep -q '^E2E-PASS' <<<"$2"; then state_set "$1" pass; else state_set "$1" fail; fi
  grep -E ' \| EXIT-' <<<"$2" | sed 's/^/  /'
}

do_add_e2e_direct() {
  local p out key="d-$(nn)"
  pscript nx-xray-get.sh "$XRAY_VERSION" || return 1
  pscript nx-e2e-temp.sh gen-direct "$key" "$(nn)" | sed 's/^/  /' || return 1
  rsh panel "$PANEL_ENV$REMOTE_DIR/nx-e2e-temp.sh adu $key" | rpipe new "umask 077; mkdir -p $REMOTE_DIR; cat > $REMOTE_DIR/adu.json; /usr/local/bin/xray api adu -s 127.0.0.1:10085 $REMOTE_DIR/adu.json 2>&1 | tail -1; shred -u $REMOTE_DIR/adu.json" || return 1
  undo "the temporary users live only in the new server's running Xray; add.temp-off removes them (or: xray api rmu per user, or any Xray restart)"
  for p in $NODE_PROTOS; do
    out="$(rsh panel "$PANEL_ENV$REMOTE_DIR/nx-e2e-temp.sh env $key $p | $PANEL_ENV$REMOTE_DIR/nx-e2e-run.sh $REMOTE_DIR/xray '$(nn) $p from outside'")" || true
    dry || e2e_record "e2e_direct_$p" "$out"
  done
}
ok_add_e2e_direct() {
  local p bad=0
  expect "EXIT-MATCH (the tunnel leaves from the new server's own address) and 256 KB both ways for REALITY, VLESS-TLS, WebSocket, Trojan and Shadowsocks; Shadowsocks also answers DNS over UDP-over-TCP"
  dry && return 0
  for p in $NODE_PROTOS; do [[ "$(st "e2e_direct_$p" fail)" == pass ]] || { say "$p did not pass"; bad=1; }; done
  return $bad
}

do_add_e2e_inside() {
  local p out key="d-$(nn)"
  rpushdir relay relay || return 1
  for p in $NODE_PROTOS; do
    out="$(rsh panel "$PANEL_ENV$REMOTE_DIR/nx-e2e-temp.sh env $key $p" | rpipe relay "NX_HEALTH=https://$PANEL_ORIGIN_NAME/api $REMOTE_DIR/nx-e2e-run.sh /usr/local/bin/xray '$(nn) $p from inside'")" || true
    dry || e2e_record "e2e_inside_$p" "$out"
  done
  say "a temporary client beside the relay box's own Xray, which is not touched; nothing was sent to the sign-in box"
}
ok_add_e2e_inside() {
  local p bad=0 must="REALITY SS"
  expect "from inside the country, straight to the server: REALITY and Shadowsocks pass always; the three TLS-name protocols too, unless the node zone is known to be blocked inside"
  dry && return 0
  [[ "$(st zone_inside clean)" == clean ]] && must="$NODE_PROTOS"
  for p in $NODE_PROTOS; do
    if [[ "$(st "e2e_inside_$p" fail)" == pass ]]; then continue; fi
    if grep -qw "$p" <<<"$must"; then say "$p did not pass from inside"; bad=1; else say "$p does not pass from inside (the node zone is blocked there: expected, and accepted with the zone)"; fi
  done
  return $bad
}

do_add_temp_off() {
  local lines tag email key="d-$(nn)"
  lines="$(pscript nx-e2e-temp.sh rmu "$key")" || return 1
  dry && rsh new "/usr/local/bin/xray api rmu -s 127.0.0.1:10085 -tag=<tag> <test email>   (once per temporary user)"
  while read -r tag email; do
    [[ -n "$tag" && -n "$email" ]] || continue
    rsh new "/usr/local/bin/xray api rmu -s 127.0.0.1:10085 -tag=$tag $email 2>&1 | tail -1" || true
  done <<<"$lines"
  pscript nx-e2e-temp.sh shred "$key"
}
ok_add_temp_off() {
  local n
  n="$(rsh new "for t in vless-in vless-tls-in vless-ws-in trojan-in; do /usr/local/bin/xray api inboundusercount -s 127.0.0.1:10085 -tag \$t 2>/dev/null | grep -o '\"count\": *[0-9]*' | grep -o '[0-9]*\$'; done | awk '{s += \$1} END {print s + 0}'")" || true
  expect "the new server's Xray holds no user again (Shadowsocks keeps its one seed)"
  dry || [[ "$n" == 0 ]]
}

do_add_udp_reach() {
  local ports
  ports="$(q node-ports "name=$(nn)")" || return 1
  dry && ports=$'WIREGUARD/UDP|{wg_port}\nOPENVPN/UDP|{ovpn_port}'
  ports="$(awk -F'|' '$1 ~ /^(WIREGUARD|OPENVPN)/ {print $2}' <<<"$ports" | tr '\n' ' ')500 4500"
  dry || state_set udp_ports "$ports"
  local filter
  filter="udp and ($(sed 's/[^ ][^ ]*/dst port &/g; s/ dst/ or dst/g' <<<"$ports"))"
  rsh new "IF=\$(ip route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if(\$i==\"dev\") print \$(i+1)}' | head -1); mkdir -p $REMOTE_DIR; (timeout 15 tcpdump -ni \$IF -c 60 '$filter' > $REMOTE_DIR/udp.cap 2>/dev/null < /dev/null &) ; sleep 2; echo capture-started" || return 1
  pscript nx-node-outside.sh "$(nn)" "$(need l1)" "$(need l2)" udp-send || return 1
  dry || sleep 6
}
ok_add_udp_reach() {
  local p n bad=0
  expect "datagrams sent from outside to the WireGuard, OpenVPN and IKEv2 ports show up on the server's interface: no provider firewall in the way. This is NOT a handshake: those three tunnels are proven only by a real app (add.owner-after)."
  dry && { rsh new "grep -c '\\.<port>: ' $REMOTE_DIR/udp.cap   (once per port)"; return 0; }
  for p in $(st udp_ports); do
    n="$(rsh new "grep -c '\\.$p: ' $REMOTE_DIR/udp.cap || true")" || n=0
    if [[ "${n:-0}" -ge 1 ]]; then say "udp $p: arrived"; else say "udp $p: NOTHING ARRIVED (a provider firewall?)"; bad=1; fi
  done
  return $bad
}

# The exit currently carrying the hop, read off the relay's own rules.
hop_server_name() {
  rscript relay relay/relay.sh hop-list >/dev/null || return 1
  rget relay "$REMOTE_DIR/hop-live.txt" "$RUN_DIR/hop-live.txt" || return 1
  dry && { echo "{hop-server}"; return 0; }
  tool hop-rules "$RUN_DIR/hop-live.txt" | awk -F'|' '{print $3}' | sort | uniq -c | sort -rn | awk 'NR==1{print $2}'
}

do_add_hop() {
  local need_hop="$OPT_HOP" hopname hopip port dest
  dest="$(need dest)" || return 1
  if [[ "$need_hop" == auto ]]; then
    if dry || [[ "$(st pre_relay_443 PASS)" != PASS ]]; then need_hop=yes; else need_hop=no; fi
  fi
  if [[ "$need_hop" != yes ]]; then
    say "the relay box reaches this exit directly (bare-box test on 443 passed from it): no hop"
    state_set hop none
    return 0
  fi
  dry && say "only when the relay box cannot reach the exit directly (or --hop yes):"
  hopname="$(hop_server_name)" || return 1
  [[ -n "$hopname" ]] || { say "the relay has no hop rule to learn the hop server from: set up the first hop by hand"; return 1; }
  if ! dry && [[ -n "${OLD:-}" && "$hopname" == "$OLD" ]]; then
    say "REFUSED: the hop server is $OLD, the server being replaced, and the relay cannot reach the new box"
    say "directly. A box the relay cannot reach cannot take over the hop. Choose one that passes the bare-box"
    say "test from the relay box."
    return 1
  fi
  hopip="$(node_field "$hopname" publicIp)" || return 1
  # 1. the hop server: one more port in its own table
  rget "ip:$hopip" /etc/neoxify/chain-fw.nft "$RUN_DIR/chain.old" || return 1
  if dry; then
    echo "local \$ tool.mjs chain-add (the new exit on the lowest free port from $HOP_PORT_BASE)" >&2
    port="{hop-port}"
  else
    port="$(tool chain-add "$RUN_DIR/chain.old" "$RUN_DIR/chain.new" "$NEW_IP" "$(nn)" "$HOP_PORT_BASE")" || return 1
  fi
  rput "ip:$hopip" "$RUN_DIR/chain.new" "$REMOTE_DIR/chain-fw.nft.new" 600 || return 1
  rscript "ip:$hopip" node/hop-server.sh apply || return 1
  undo "on the hop server $hopname: cp -a /etc/neoxify/chain-fw.nft.bak-<time> /etc/neoxify/chain-fw.nft && nft -f /etc/neoxify/chain-fw.nft (its own table only)"
  # 2. proof before the relay is touched: the disguise site answers through the new port
  rpushdir relay inside || return 1
  rsh relay "$REMOTE_DIR/inside.sh sni $hopip $port ${dest%:*}" || { say "the new hop port does not carry a TLS hello to the exit: the relay was not touched"; return 1; }
  # 3. the relay: one live rule, then the same line in its file (checked, never loaded)
  rscript relay relay/relay.sh hop-backup "$(nn)-hop" || return 1
  dry || tool hop-rule "$NEW_IP" "$hopip" "$port" "$(nn)" "$hopname" "$RUN_DIR/hop-rule.txt" || return 1
  rput relay "$RUN_DIR/hop-rule.txt" "$REMOTE_DIR/hop-rule.txt" 600 || return 1
  rsh relay "$REMOTE_DIR/relay.sh hop-add" || return 1
  undo "on the relay box: nft -a list chain ip neoxify_relay_chain output, then nft delete rule ip neoxify_relay_chain output handle <the new rule's handle>"
  rget relay /etc/nftables.conf "$RUN_DIR/nft.old" || return 1
  dry || tool hop-file-add "$RUN_DIR/nft.old" "$RUN_DIR/nft.new" "$NEW_IP" "$hopip" "$port" "$(nn)" "$hopname" || return 1
  rput relay "$RUN_DIR/nft.new" "$REMOTE_DIR/nftables.conf.new" 600 || return 1
  rsh relay "$REMOTE_DIR/relay.sh hop-file-swap" || return 1
  undo "on the relay box: cp -a /etc/nftables.conf.bak-pre-$(nn)-hop-<time> /etc/nftables.conf (never load that file)"
  dry || { rm -f "$RUN_DIR"/chain.* "$RUN_DIR"/nft.* "$RUN_DIR"/hop-*; state_set hop "$port"; state_set hop_server "$hopname"; }
}
ok_add_hop() {
  local out
  expect "either no hop is needed, or: one live rule and one file line on the relay for this exit, the hop server's table lists it, and the relay's Xray is the same process"
  [[ "$(st hop none)" == none ]] && ! dry && return 0
  out="$(rsh relay "L=\$(nft list chain ip neoxify_relay_chain output); echo \"live=\$(grep -c 'comment \"$(nn) via ' <<<\"\$L\") file=\$(grep -c 'comment \"$(nn) via ' /etc/nftables.conf)\"")" || return 1
  relay_pid_same || return 1
  dry || [[ "$out" == "live=1 file=1" ]]
}

exit_label() { sed -E 's/-/ /g; s/(^| )([a-z])/\1\u\2/g' <<<"$1"; }

do_add_relay_routes() {
  local set xcfg out
  if [[ "$OPT_NO_RELAY" == 1 ]]; then
    say "--no-relay: this server gets no relay routes"
    state_set relay_set none
    return 0
  fi
  set="${OPT_RELAY_SET:-$(st relay_set "")}"
  if [[ -z "$set" || "$set" == none ]]; then
    out="$(q relay-free-sets "relay=$RELAY_NODE_NAME")" || return 1
    set="$(head -1 <<<"$out")"
    dry && set="{relay-set}"
    dry || say "free entry sets on the relay box: $(tr '\n' ' ' <<<"$out")"
  fi
  if [[ -z "$set" ]]; then
    say "REFUSED ON PURPOSE: the relay box has no free entry set. Making a new one generates keys on the relay and"
    say "rewrites its Xray config, and that is done by a person (docs/runbooks/fleet.md, 'What stays manual')."
    say "Usually a set is free: retiring a server frees its set. In a replace, pass --no-relay now, retire the old"
    say "server, then run: fleet add ... --only add.relay-routes (and the two steps after it)."
    return 1
  fi
  xcfg="$(q reality-config "name=$(nn)")" || return 1
  dry && xcfg="{reality-config-id}"
  panel_dump "pre-$(nn)-relay" || return 1
  panel_mint >/dev/null || return 1
  RENV="${PANEL_ENV}NX_APPLY=0 " rscript panel panel/nx-relay-add.sh "$RELAY_NODE_NAME" "$set" "$xcfg" "$(exit_label "$(nn)")" || return 1
  out="$(RENV="${PANEL_ENV}NX_APPLY=1 " rscript panel panel/nx-relay-add.sh "$RELAY_NODE_NAME" "$set" "$xcfg" "$(exit_label "$(nn)")")" || { echo "$out"; return 1; }
  dry && return 0
  echo "$out" | sed 's/^/  /'
  state_set relay_set "$set"
  undo "on the panel host: nx-api.sh route-delete $(sed -n 's/^route \([0-9a-f-]*\) .*/\1/p' <<<"$out" | tr '\n' ' ') (hot: removes the rules from the relay's running Xray, frees the set)"
}
ok_add_relay_routes() {
  local rows try bad
  expect "four relay routes to this exit, each asserted on both ends in the last three minutes with no error; the relay's Xray is the same process"
  [[ "$(st relay_set none)" == none ]] && ! dry && return 0
  for try in 1 2 3 4 5 6; do
    rows="$(q relay-asserted "name=$(nn)")" || return 1
    dry && break
    bad="$(awk -F'|' '$2 != "t" || $3 !~ /^[0-9]+$/ || $3 > 180 || $4 !~ /^[0-9]+$/ || $4 > 180 || $5 != "" || $6 != "" {n++} END {print n + 0}' <<<"$rows")"
    [[ "$(grep -c . <<<"$rows")" == 4 && "$bad" == 0 ]] && break
    sleep 20
  done
  relay_pid_same || return 1
  dry && return 0
  echo "$rows" | cut -d'|' -f1,3,4 | sed 's/^/  /'
  [[ "$(grep -c . <<<"$rows")" == 4 && "$bad" == 0 ]] || { say "a relay route is not asserted yet (try $try): name | uplink age | entry age above; errors, if any, are in the panel"; return 1; }
}

do_add_e2e_relay() {
  local p out lines tag email key="r-$(nn)" set
  set="$(st relay_set none)"
  dry && set="{relay-set}"
  if [[ "$set" == none ]]; then
    say "no relay routes on this server: nothing to prove"
    return 0
  fi
  pscript nx-xray-get.sh "$XRAY_VERSION" || return 1
  pscript nx-e2e-temp.sh gen-relay "$key" "$RELAY_NODE_NAME" "$set" "$(nn)" | sed 's/^/  /' || return 1
  rpushdir relay relay || return 1
  rsh panel "$PANEL_ENV$REMOTE_DIR/nx-e2e-temp.sh adu $key" | rpipe relay "$REMOTE_DIR/relay.sh adu" || return 1
  undo "the temporary users live only in the relay's running Xray and are removed at the end of this step (relay.sh rmu <tag> <email>)"
  for p in $RELAY_PROTOS; do
    out="$(rsh panel "$PANEL_ENV$REMOTE_DIR/nx-e2e-temp.sh env $key $p | $PANEL_ENV$REMOTE_DIR/nx-e2e-run.sh $REMOTE_DIR/xray 'relay to $(nn) $p'")" || true
    dry || e2e_record "e2e_relay_$p" "$out"
  done
  lines="$(pscript nx-e2e-temp.sh rmu "$key")" || return 1
  dry && rsh relay "$REMOTE_DIR/relay.sh rmu <tag> <test email>   (once per temporary user)"
  while read -r tag email; do
    [[ -n "$tag" && -n "$email" ]] || continue
    rsh relay "$REMOTE_DIR/relay.sh rmu $tag $email" || true
  done <<<"$lines"
  pscript nx-e2e-temp.sh shred "$key"
}
ok_add_e2e_relay() {
  local p bad=0
  expect "through the relay box, REALITY, VLESS-TLS, Trojan and Shadowsocks each exit on the NEW server's address with 256 KB both ways; the relay's Xray is the same process"
  relay_pid_same || return 1
  dry && return 0
  [[ "$(st relay_set none)" == none ]] && return 0
  for p in $RELAY_PROTOS; do [[ "$(st "e2e_relay_$p" fail)" == pass ]] || { say "relay $p did not pass"; bad=1; }; done
  return $bad
}

# One pass over the plans: incoming routes join, outgoing routes leave,
# one plan at a time, smallest first. Used by add (incoming only), by
# replace (both, in one PATCH per plan) and by retire (outgoing only).
plan_pass() { # <incoming server or ''> <outgoing server or ''> <label>
  local incoming="$1" outgoing="$2" label="$3" out steps pid pname add del def next rc tx line
  out="$(q plan-input "incoming=$incoming" "outgoing=$outgoing" "fallback=$OPT_DEFAULT_TO" "only=$OPT_PLANS")" || return 1
  if dry; then
    say "for each plan, smallest first (the new list is computed here and again on the panel host; they must agree):"
    RENV="${PANEL_ENV}NX_EXPECT_NEW=$REMOTE_DIR/expect-<plan>.json " rscript panel panel/nx-plan-run.sh "$label-<plan>" 900 "<planId>" "<ids to add>" "<ids to remove>" "<default, if it moves>"
    heartbeats_fresh
    pscript nx-api.sh tx-errors 3
    return 0
  fi
  for line in plans incoming outgoing fallback; do
    sed -n "s/^$line //p" <<<"$out" >"$RUN_DIR/$line.json"
    [[ -s "$RUN_DIR/$line.json" ]] || { say "the panel gave no '$line' document"; return 1; }
  done
  steps="$(tool plan-steps "$RUN_DIR/plans.json" "$RUN_DIR/incoming.json" "$RUN_DIR/outgoing.json" "$RUN_DIR/fallback.json")" || {
    say "If a plan's default route is on the server that is leaving, name where it should go: --default-to <server>."
    return 1
  }
  if [[ -z "$steps" ]]; then
    say "no plan needs changing"
    return 0
  fi
  while IFS='|' read -r pid pname add del def next; do
    say "plan '$pname': +$(tr ',' '\n' <<<"$add" | grep -c '"') -$(tr ',' '\n' <<<"$del" | grep -c '"') routes${def:+, default moves}"
    echo "$next" >"$RUN_DIR/next.json"
    rput panel "$RUN_DIR/next.json" "$REMOTE_DIR/expect-$pid.json" 600 || return 1
    rc=0
    # shellcheck disable=SC2086
    RENV="${PANEL_ENV}NX_EXPECT_NEW=$REMOTE_DIR/expect-$pid.json " rscript panel panel/nx-plan-run.sh "$label-${pid:0:8}" 900 "$pid" "$add" "$del" $def | sed 's/^/    /'
    rc=${PIPESTATUS[0]}
    undo "plan '$pname', on the panel host: $REMOTE_DIR/nx-plan-edit.sh $pid '$del' '$add'   (the list before is in /root/db-backups/plan-routes-before-$pid-*.json; an old default route is not put back by this)"
    [[ $rc -eq 0 ]] || { say "the edit of '$pname' did not finish cleanly (exit $rc): later plans were not touched"; return 1; }
    heartbeats_fresh "$outgoing" || return 1
    tx="$(pscript nx-api.sh tx-errors 3)" || return 1
    [[ "$tx" == "tx-errors=0" ]] || { say "the backend failed to start a transaction during the edit ($tx): stop and look before the next plan"; return 1; }
  done <<<"$steps"
  rm -f "$RUN_DIR"/*.json
}

# Converged: asking again finds nothing left to change.
plan_pass_done() { # <incoming> <outgoing>
  local out steps line
  out="$(q plan-input "incoming=$1" "outgoing=$2" "fallback=$OPT_DEFAULT_TO" "only=$OPT_PLANS")" || return 1
  dry && return 0
  for line in plans incoming outgoing fallback; do sed -n "s/^$line //p" <<<"$out" >"$RUN_DIR/$line.json"; done
  steps="$(tool plan-steps "$RUN_DIR/plans.json" "$RUN_DIR/incoming.json" "$RUN_DIR/outgoing.json" "$RUN_DIR/fallback.json")" || return 1
  rm -f "$RUN_DIR"/*.json
  [[ -z "$steps" ]] || { say "plans still to change: $(cut -d'|' -f2 <<<"$steps" | tr '\n' ' ')"; return 1; }
}

do_add_plans() {
  if [[ "$OPT_NO_PLANS" == 1 ]]; then
    say "--no-plans: the server stays out of every plan"
    return 0
  fi
  say "OWNER: the plan edits start now. From here customers get this server."
  panel_dump "pre-$(nn)-plans" || return 1
  heartbeats_baseline || return 1
  plan_pass "$(nn)" "${OLD:-}" "$(nn)"
}
ok_add_plans() {
  expect "every plan holds the new server's routes (relay-only plans its relay routes) and, in a replace, none of the old server's; every server that was online still reports"
  [[ "$OPT_NO_PLANS" == 1 ]] && return 0
  plan_pass_done "$(nn)" "${OLD:-}" || return 1
  heartbeats_fresh "${OLD:-}"
}

do_add_provision() { say "read-only: the check is the step"; }
ok_add_provision() {
  local out have want nack try
  expect "one shared credential per direct route for every active subscription that should have one, and every command to the new server acknowledged"
  [[ "$OPT_NO_PLANS" == 1 ]] && return 0
  for try in 1 2 3 4 5 6 7 8; do
    out="$(q provision "name=$(nn)")" || return 1
    dry && break
    have="$(sed -n 's/^have|//p' <<<"$out")" want="$(sed -n 's/^want|//p' <<<"$out")" nack="$(sed -n 's/^not-acked|//p' <<<"$out")"
    [[ "$have" -ge "$want" && "$want" -gt 0 && "$nack" == 0 ]] && break
    sleep 15
  done
  rsh new "for t in vless-in vless-tls-in vless-ws-in trojan-in shadowsocks-in; do printf '%s=%s ' \$t \"\$(/usr/local/bin/xray api inboundusercount -s 127.0.0.1:10085 -tag \$t 2>/dev/null | grep -o '\"count\": *[0-9]*' | grep -o '[0-9]*\$')\"; done; echo; echo \"wg_peers=\$(wg show wg0 peers | wc -l) ccd=\$(ls /etc/openvpn/ccd 2>/dev/null | wc -l)\"" | sed 's/^/  on the server: /'
  dry && return 0
  say "shared credentials: $have, expected $want; commands not acknowledged: $nack (try $try)"
  [[ "$have" -ge "$want" && "$want" -gt 0 && "$nack" == 0 ]]
}

do_add_e2e_issued() {
  local email rows shape pu kind out n=0
  [[ "$OPT_NO_PLANS" == 1 ]] && { say "--no-plans: no panel-issued credential exists to test with"; return 0; }
  pscript nx-xray-get.sh "$XRAY_VERSION" || return 1
  panel_mint >/dev/null || return 1
  for email in "${TEST_DIRECT_EMAIL:-}" "${TEST_RELAY_EMAIL:-}"; do
    [[ -n "$email" ]] || continue
    rows="$(q test-creds "name=$(nn)" "email=$email")" || return 1
    dry && rows="{shape}|{route}|{credential-id}|{direct or relay}"
    while IFS='|' read -r shape _ pu kind; do
      [[ -n "$pu" ]] || continue
      n=$((n + 1))
      out="$(rsh panel "$PANEL_ENV$REMOTE_DIR/nx-e2e-build.sh $pu | $PANEL_ENV$REMOTE_DIR/nx-e2e-run.sh $REMOTE_DIR/xray '$(nn) $kind ${shape//\//-} issued'")" || true
      dry || e2e_record "e2e_issued_$n" "$out"
    done <<<"$rows"
  done
  dry || state_set e2e_issued_n "$n"
  panel_token_shred
}
ok_add_e2e_issued() {
  local i n bad=0
  expect "with credentials the panel itself issued to the test accounts after the plan edit: every Xray protocol exits on the new server, direct and through the relay"
  dry && return 0
  [[ "$OPT_NO_PLANS" == 1 ]] && return 0
  n="$(st e2e_issued_n 0)"
  [[ "$n" -ge 1 ]] || { say "the test accounts hold no credential on this server. Are TEST_DIRECT_EMAIL and TEST_RELAY_EMAIL (fleet.env) on plans that hold it?"; return 1; }
  for i in $(seq 1 "$n"); do [[ "$(st "e2e_issued_$i" fail)" == pass ]] || bad=1; done
  [[ $bad -eq 0 ]] || say "a tunnel with a panel-issued credential did not pass (lines above)"
  return $bad
}

do_add_monitoring() { say "read-only. Nothing is configured per server: the inside probe reads its list from the database every half hour, and the backend finds each server's API door by itself within 15 minutes of it coming online."; }
ok_add_monitoring() {
  local door rows try
  expect "the server's API door has been found and checked by the backend, and the scheduled inside probe has a reading for it from the relay box"
  for try in $(seq 1 34); do
    door="$(q door "name=$(nn)")" || return 1
    rows="$(q inside-latest "name=$(nn)")" || return 1
    dry && return 0
    [[ "${door%%|*}" == t ]] && grep -q . <<<"$rows" && break
    sleep 30
  done
  echo "$rows" | awk -F'|' '{printf "  inside probe: %s port %s %s (%s min ago)\n", $1, $2, $3, $6}'
  say "API door: checked=${door%%|*}"
  [[ "${door%%|*}" == t ]] || { say "no door after 17 minutes: look at the backend log for this server (module node-doors), then --only add.monitoring"; return 1; }
  grep -q . <<<"$rows" || { say "no scheduled inside-probe reading yet (rounds run at :07 and :37): run --only add.monitoring after the next one"; return 1; }
}

do_add_owner_after() {
  cat <<EOF
  OWNER, after this server is in the plans (none of this can be done by the tool):
    1. Signed endpoint lists: re-sign on the machine that holds the signing keys, adding this server's two
       mirrors, then publish. Client releases come after that, never before.
    2. Root password of the new box: change it if it was ever pasted anywhere. Key access is unaffected.
    3. Reverse DNS: generic or empty at the provider (see pre.ptr above).
    4. WireGuard, OpenVPN and IKEv2: connect once to this server with the real app (the test VM) and check
       the exit address and the server-side handshake. Until then those three are UNVERIFIED on this server:
       only the arrival of datagrams was shown.
    5. In 24 and 48 hours: fleet status $(nn). Customers must move bytes UP, not only down, and the mobile
       and home networks stay unverified until their own attempts show success.
    6. Website and promo material, if this is a new country.
EOF
}
ok_add_owner_after() { expect "the owner has the list"; return 0; }

do_add_cleanup() {
  local r
  for r in panel relay signin new; do rclean "$r" || true; done
  rsh new "rm -rf /root/nx-install; echo build-notes-removed" || true
}
ok_add_cleanup() {
  local r n bad=0
  expect "no scratch file, token or test config left on the panel host, the inside boxes or the new server; the relay's Xray is the same process as at the start"
  for r in panel relay signin new; do
    n="$(rsh "$r" "test ! -e $REMOTE_DIR && echo clean")" || true
    dry || [[ "$n" == clean ]] || { say "$r still has $REMOTE_DIR"; bad=1; }
  done
  relay_pid_same || bad=1
  return $bad
}

register_add_steps() {
  step add.zone-inside gate "Names under the node zone are not rewritten from inside"
  step add.second-key auto "Second operator key on the box (authorized_keys backed up, sshd untouched)"
  step add.inventory auto "OS inventory: release, resolver speed, clock, panel reachable; three free ports chosen"
  step add.mask-upgrades auto "Automatic upgrades masked, dpkg lock free"
  step add.packages auto "Base packages, swap on a small box, sshd jail that sees sshd-session"
  step add.firewall owner "Provider firewall opened for the server's ports (only where there is one)"
  step add.dns auto "Two fresh random names in the node zone, DNS-only"
  step add.certs auto "One certificate per name, by webroot, the first RSA"
  step add.installer-push auto "Committed installer copied to the box"
  step add.dump-node auto "Database dump before the server is created"
  step add.token auto "15-minute admin token handed to the box, never shown"
  step add.install auto "Installer run, one prompt at a time, same protocol set as its peers"
  step add.install-cleanup auto "Token shredded on the box and the panel host, installer session closed"
  step add.postfix auto "Known installer defects: verified, repaired only if found"
  step add.parity auto "Fleet form: API mirrors, per-certificate renewal hooks, agent's control name, ccd-exclusive, IPv6 closed for Xray, file modes"
  step add.egress auto "Shadowsocks UDP-over-TCP answers through the server's own Xray"
  step add.renew-dry auto "Certificate renewal dry run with its hooks"
  step add.maintenance-audit auto "Maintenance scripts, run dry, find nothing to change"
  step add.agent-version auto "Agent at the fleet's version (pushed if behind)"
  step add.leftovers auto "Key and config copies left by the build removed"
  step add.mirror-host auto "Mirror host recorded for the server (database dump first)"
  step add.verify auto "Server verified from the box, from the panel and from outside"
  step add.reboot auto "Reboot test while nobody is on it, every check repeated"
  step add.inside-probe gate "Inside probe through the server from both inside boxes"
  step add.e2e-direct auto "Test tunnels from outside: five Xray protocols, exit address must match"
  step add.e2e-inside ask "The same tunnels from the relay box, straight to the server"
  step add.temp-off auto "Temporary test users removed from the server's Xray"
  step add.udp-reach auto "Datagrams reach the WireGuard, OpenVPN and IKEv2 ports"
  step add.hop ask "Relay hop for this exit, only if the relay cannot reach it directly"
  step add.relay-routes ask "Relay routes to the new exit on a free entry set (database dump first)"
  step add.e2e-relay ask "Relay tunnels through the relay box, exit address must match"
}

register_add_tail() {
  step add.plans auto "Plans, one at a time, smallest first, heartbeats checked after each (database dump first)"
  step add.provision auto "Provisioning check: credentials created and acknowledged"
  step add.e2e-issued auto "Tunnels again, with credentials the panel issued"
  step add.monitoring auto "Monitoring picked it up: inside probe reading and the server's API door"
  step add.owner-after owner "What only the owner can do afterwards"
  step add.cleanup auto "Scratch files shredded on every host"
}

checklist_add() {
  step add.params auto "Name is free; region, peer, disguise site and versions settled"
  step add.access auto "Key-only access to the panel host, both inside boxes and the new box"
  step add.snapshot auto "Read-only snapshot of the fleet into the run log"
  register_precheck_steps
  register_add_steps
  register_add_tail
}
