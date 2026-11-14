#!/bin/bash
# postinstall.sh check|fix <xray version> <public address>
# Runs on the box being built, right after the installer.
#
# Nine things a build needed fixing by hand after the installer finished.
# The installer does them itself now, so `check` is what normally runs,
# and it should say "ok" for each (and once per engine). `fix` is the
# old hand procedure, kept for a box built with an older installer: it
# repairs what `check` finds and nothing else.
#
#   xray-user      the unit runs Xray as nobody (upstream's script makes
#                  an `xray` user that cannot read the certificate key)
#   xray-version   the fleet's pinned build, not whatever is newest today
#   xray-modes     config, certificate directory, assets and log directory
#                  readable by exactly who needs them
#   swanctl-unit   the IKEv2 config loader bound to the strongSwan unit
#                  that exists (on Ubuntu 26.04 it is strongswan.service)
#   wg-pubkey      the WireGuard PUBLIC key world-readable
#   self-loop      Xray may not open connections to this server's own
#                  address (a client bug once looped a server into itself
#                  22,000 times)
#   conntrack      room for at least 65536 connections
#   xray-logs      every file in /var/log/xray owned by nobody: a root-owned
#                  access.log kills Xray at start (2026-11-13: dead from the
#                  install on, while this check said "ok xray-modes")
#   engines        every engine running AND listening, the IKEv2 loader
#                  started with its connections loaded (engines.sh)
#
# `fix` restarts Xray when it changed the unit or the binary. That is
# free on a new box and is why this runs before any customer exists; it
# refuses when the server already has users, unless NX_ALLOW_RESTART=1.
# The checklist never sets that: restarting an exit's Xray under
# customers drops every one of them, and once wiped the uplink users of
# its relay routes until the panel put them back. It is for a person,
# at a time the owner chose.
set -uo pipefail
MODE=${1:?check or fix}
VER=${2:?xray version}
IP=${3:?public address}
HERE=$(cd "$(dirname "$0")" && pwd)
X=/usr/local/bin/xray
UNIT=/etc/systemd/system/xray.service
GUARD=neoxify-no-self-loop
drift=0
restart=0

say_ok() { echo "ok $1"; }
say_drift() {
  echo "DRIFT $1: $2"
  drift=1
}
mode_of() { stat -c '%a %U:%G' "$1" 2>/dev/null; }

unit_text() {
  cat <<'UNIT'
[Unit]
Description=Xray Service
Documentation=https://github.com/xtls
After=network.target nss-lookup.target

[Service]
User=nobody
CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ExecStart=/usr/local/bin/xray run -config /usr/local/etc/xray/config.json
Restart=on-failure
RestartPreventExitStatus=23
LimitNPROC=10000
LimitNOFILE=1000000
RuntimeDirectory=xray
RuntimeDirectoryMode=0755

[Install]
WantedBy=multi-user.target
UNIT
}

ike_unit() {
  local u
  for u in strongswan strongswan-starter; do
    if [ "$(systemctl show -p LoadState --value "$u.service" 2>/dev/null)" = loaded ]; then
      systemctl show -p Id --value "$u.service"
      return 0
    fi
  done
  return 1
}

c_xray_user() {
  [ "$(systemctl show xray -p User --value)" = nobody ] && say_ok xray-user && return
  say_drift xray-user "the unit runs Xray as '$(systemctl show xray -p User --value)'"
  [ "$MODE" = fix ] || return
  cp -a "$UNIT" "/root/xray.service.before-fleet-$(date -u +%Y%m%dT%H%M%SZ)" 2>/dev/null
  unit_text >"$UNIT"
  chmod 644 "$UNIT"
  systemctl daemon-reload
  restart=1
}

c_xray_version() {
  local have
  have=$("$X" version 2>/dev/null | awk 'NR==1{print $2}')
  [ "v$have" = "$VER" ] && say_ok xray-version && return
  say_drift xray-version "installed v$have, the fleet runs $VER"
  [ "$MODE" = fix ] || return
  "$HERE/nx-xray-get.sh" "$VER" /dev/shm/nxf/xray.new || return
  install -m 755 -o root -g root /dev/shm/nxf/xray.new "$X"
  rm -f /dev/shm/nxf/xray.new
  restart=1
}

c_xray_modes() {
  local bad="" want p
  while read -r want p; do
    [ -e "$p" ] || continue
    [ "$(mode_of "$p")" = "${want/,/ }" ] || bad+=" $p($(mode_of "$p"))"
  done <<'LIST'
755,root:root /usr/local/etc/xray
640,root:nogroup /usr/local/etc/xray/config.json
755,root:root /usr/local/etc/xray/certs
644,nobody:nogroup /usr/local/etc/xray/certs/fullchain.pem
400,nobody:nogroup /usr/local/etc/xray/certs/privkey.pem
755,root:root /usr/local/share/xray
750,nobody:nogroup /var/log/xray
LIST
  if [ -e /usr/local/etc/xray/certs/privkey.pem ] && ! runuser -u nobody -- test -r /usr/local/etc/xray/certs/privkey.pem; then
    bad+=" certificate-key-unreadable-by-nobody"
  fi
  [ -z "$bad" ] && say_ok xray-modes && return
  say_drift xray-modes "$bad"
  [ "$MODE" = fix ] || return
  chown root:root /usr/local/etc/xray && chmod 755 /usr/local/etc/xray
  [ -f /usr/local/etc/xray/config.json ] && chown root:nogroup /usr/local/etc/xray/config.json && chmod 640 /usr/local/etc/xray/config.json
  if [ -d /usr/local/etc/xray/certs ]; then
    chown root:root /usr/local/etc/xray/certs && chmod 755 /usr/local/etc/xray/certs
    [ -x /usr/local/bin/neoxify-sync-certs ] && /usr/local/bin/neoxify-sync-certs
  fi
  if [ -d /usr/local/share/xray ]; then
    chown -R root:root /usr/local/share/xray
    chmod 755 /usr/local/share/xray
    find /usr/local/share/xray -type f -exec chmod 644 {} +
  fi
  install -d -m 750 -o nobody -g nogroup /var/log/xray
  find /var/log/xray -type f -exec chown nobody:nogroup {} + -exec chmod 600 {} +
  restart=1
}

c_xray_logs() {
  local bad="" f o
  [ -d /var/log/xray ] || { say_ok "xray-logs (no log directory)"; return; }
  for f in /var/log/xray/*; do
    [ -f "$f" ] || continue
    o=$(stat -c %U:%G "$f")
    [ "$o" = nobody:nogroup ] || bad+=" $f($o)"
  done
  [ -z "$bad" ] && say_ok xray-logs && return
  say_drift xray-logs "not nobody's:$bad"
  [ "$MODE" = fix ] || return
  find /var/log/xray -type f -exec chown nobody:nogroup {} + -exec chmod 600 {} +
  restart=1
}

c_engines() {
  if "$HERE/engines.sh" check; then
    return
  fi
  drift=1
  [ "$MODE" = fix ] || return
  echo "repairing what is down (Xray only when it is not running; anything else started, never restarted):"
  "$HERE/engines.sh" fix || echo "STILL DOWN after the repair: see the lines above"
}

c_swanctl_unit() {
  local f=/etc/systemd/system/neoxify-swanctl-load.service want
  [ -f "$f" ] || { say_ok "swanctl-unit (no IKEv2 on this box)"; return; }
  want=$(ike_unit) || { say_drift swanctl-unit "no strongSwan unit is loaded"; return; }
  if grep -qx "After=$want" "$f" && grep -qx "Requires=$want" "$f" && grep -qx "PartOf=$want" "$f"; then
    say_ok swanctl-unit
    return
  fi
  say_drift swanctl-unit "the loader is not bound to $want"
  [ "$MODE" = fix ] || return
  cp -a "$f" "/root/neoxify-swanctl-load.service.before-fleet-$(date -u +%Y%m%dT%H%M%SZ)"
  sed -i -E "s/^(After|Requires|PartOf)=.*/\1=$want/" "$f"
  systemctl daemon-reload
  systemctl restart neoxify-swanctl-load
}

c_wg_pubkey() {
  local f=/etc/wireguard/server_public.key
  [ -f "$f" ] || { say_ok "wg-pubkey (no WireGuard on this box)"; return; }
  [ "$(stat -c %a "$f")" = 644 ] && say_ok wg-pubkey && return
  say_drift wg-pubkey "mode $(stat -c %a "$f")"
  [ "$MODE" = fix ] && chmod 644 "$f"
}

guard_rules() {
  echo "-d $IP/32 -p tcp -m owner --uid-owner nobody -m conntrack --ctstate NEW -m comment --comment $GUARD -j REJECT --reject-with tcp-reset"
  echo "-d $IP/32 -p udp -m owner --uid-owner nobody -m conntrack --ctstate NEW -m comment --comment $GUARD -j REJECT --reject-with icmp-port-unreachable"
}

c_self_loop() {
  local live file r
  live=$(iptables -S OUTPUT 2>/dev/null | grep -c -- "$GUARD")
  file=$(grep -c -- "$GUARD" /etc/iptables/rules.v4 2>/dev/null)
  if [ "$live" = 2 ] && [ "${file:-0}" = 2 ] && iptables -S OUTPUT | grep -- "$GUARD" | grep -q -- "-d $IP/32"; then
    say_ok self-loop
    return
  fi
  say_drift self-loop "live rules ${live:-0} of 2, saved rules ${file:-0} of 2"
  [ "$MODE" = fix ] || return
  [ -f /etc/iptables/rules.v4 ] && cp -a /etc/iptables/rules.v4 "/etc/iptables/rules.v4.bak-pre-selfloop-$(date -u +%Y%m%dT%H%M%SZ)"
  while read -r r; do
    # shellcheck disable=SC2086
    [ -n "$r" ] && iptables ${r/-A /-D }
  done < <(iptables -S OUTPUT | grep -- "$GUARD")
  local n=1
  while read -r r; do
    # shellcheck disable=SC2086
    iptables -I OUTPUT "$n" $r
    n=$((n + 1))
  done < <(guard_rules)
  netfilter-persistent save >/dev/null 2>&1
}

c_conntrack() {
  local cur
  cur=$(cat /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null || echo 0)
  if [ "$cur" -ge 65536 ] && { [ -f /etc/sysctl.d/99-neoxify-conntrack.conf ] || [ "$cur" -gt 65536 ]; }; then
    say_ok conntrack
    return
  fi
  say_drift conntrack "limit $cur, or not written down to survive a reboot"
  [ "$MODE" = fix ] || return
  echo nf_conntrack >/etc/modules-load.d/neoxify-conntrack.conf
  modprobe nf_conntrack 2>/dev/null
  echo net.netfilter.nf_conntrack_max=65536 >/etc/sysctl.d/99-neoxify-conntrack.conf
  sysctl -q -p /etc/sysctl.d/99-neoxify-conntrack.conf
}

has_users() {
  local t n
  for t in vless-in vless-tls-in vless-ws-in trojan-in; do
    n=$("$X" api inboundusercount -s 127.0.0.1:10085 -tag "$t" 2>/dev/null | grep -o '"count": *[0-9]*' | grep -o '[0-9]*$')
    [ "${n:-0}" -gt 0 ] && return 0
  done
  # Shadowsocks keeps one seed user on every server; more than that is people.
  n=$("$X" api inboundusercount -s 127.0.0.1:10085 -tag shadowsocks-in 2>/dev/null | grep -o '"count": *[0-9]*' | grep -o '[0-9]*$')
  [ "${n:-0}" -gt 1 ] && return 0
  return 1
}

c_xray_user
c_xray_version
c_xray_modes
c_swanctl_unit
c_wg_pubkey
c_self_loop
c_conntrack
c_xray_logs

if [ "$MODE" = fix ] && [ "$restart" = 1 ]; then
  if has_users && [ "${NX_ALLOW_RESTART:-0}" != 1 ]; then
    echo "REFUSED: Xray needs a restart and this server already has users. Restart it yourself, at a time of your choosing."
    exit 1
  fi
  if runuser -u nobody -- "$X" run -test -config /usr/local/etc/xray/config.json >/dev/null 2>&1; then
    systemctl restart xray
    sleep 3
    echo "xray restarted: user $(systemctl show xray -p User --value), $("$X" version | head -1 | cut -d' ' -f1-2), active=$(systemctl is-active xray)"
  else
    echo "REFUSED: Xray, run as nobody, does not accept its config; not restarted"
    exit 1
  fi
fi
# A leftover `xray` account that owns nothing and runs nothing.
if [ "$MODE" = fix ] && id xray >/dev/null 2>&1 && ! pgrep -u xray >/dev/null 2>&1 &&
  [ -z "$(find /usr/local/etc/xray /usr/local/share/xray /var/log/xray /etc/systemd/system -user xray -print -quit 2>/dev/null)" ]; then
  userdel xray 2>/dev/null && echo "removed the unused xray account"
fi
# Last, after any restart above: what is running and listening now.
c_engines
[ "$MODE" = fix ] && exit 0
exit $drift
