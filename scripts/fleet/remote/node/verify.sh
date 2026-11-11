#!/bin/bash
# verify.sh <name1> <name2> [hop]
# Runs on an exit server. Read-only. One line per check, PASS or FAIL,
# and a non-zero exit on any FAIL. Run after the build and again after
# the reboot test: a server that only works until its first reboot is the
# failure this exists for.
#
# With a third argument "hop" it also checks the relay hop table, for the
# one server that carries it.
set -uo pipefail
L1=${1:?first name}
L2=${2:?second name}
HOP=${3:-}
X=/usr/local/bin/xray
fail=0
pass() { echo "PASS $1"; }
nope() {
  echo "FAIL $1"
  fail=1
}
t() { # t "<label>" <command...>
  local l="$1"
  shift
  if "$@" >/dev/null 2>&1; then pass "$l"; else nope "$l"; fi
}

timeunit=chrony
systemctl list-unit-files chrony.service 2>/dev/null | grep -q chrony || timeunit=systemd-timesyncd
ike=strongswan
[ "$(systemctl show -p LoadState --value strongswan.service 2>/dev/null)" = loaded ] || ike=strongswan-starter
units="xray nginx wg-quick@wg0 openvpn-server@server $ike neoxify-swanctl-load neoxify-agentd fail2ban $timeunit netfilter-persistent"
[ "$HOP" = hop ] && units="$units neoxify-chain-fw"
for u in $units; do
  if [ "$(systemctl is-enabled "$u" 2>/dev/null)" = enabled ] && [ "$(systemctl is-active "$u" 2>/dev/null)" = active ]; then
    pass "unit $u enabled and active"
  else
    nope "unit $u: $(systemctl is-enabled "$u" 2>&1 | head -1) / $(systemctl is-active "$u" 2>&1 | head -1)"
  fi
done
[ "$(systemctl --failed --no-legend | wc -l)" = 0 ] && pass "no failed unit" || nope "failed units: $(systemctl --failed --no-legend | awk '{print $1}' | tr '\n' ' ')"
for u in apt-daily-upgrade.timer apt-daily.timer unattended-upgrades.service; do
  [ "$(systemctl is-enabled "$u" 2>&1 | head -1)" = masked ] && pass "$u masked" || nope "$u is not masked"
done

[ "$(systemctl show xray -p User --value)" = nobody ] && pass "xray runs as nobody" || nope "xray runs as $(systemctl show xray -p User --value)"
tags=$("$X" api lsi -s 127.0.0.1:10085 2>/dev/null | grep -o '"tag": *"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/' | sort | tr '\n' ' ')
for want in api vless-in vless-tls-in vless-ws-in trojan-in shadowsocks-in; do
  case " $tags " in *" $want "* | *" ${want}-in "*) pass "xray inbound $want" ;; *)
    # the API inbound is tagged api or api-in depending on the template
    if [ "$want" = api ] && grep -q 'api' <<<"$tags"; then pass "xray inbound api"; else nope "xray inbound $want missing"; fi
    ;;
  esac
done

C=/usr/local/etc/xray/config.json
[ "$(jq -r '.dns.queryStrategy // empty' "$C")" = UseIPv4 ] && pass "xray dns UseIPv4" || nope "xray dns.queryStrategy is not exactly UseIPv4"
[ "$(jq -r '.outbounds[] | select(.tag == "direct") | .settings.domainStrategy // empty' "$C")" = ForceIPv4 ] && pass "xray direct ForceIPv4" || nope "xray direct outbound is not ForceIPv4"
[ "$(jq -r '[.outbounds[] | select(.tag == "uot-direct")] | length' "$C")" = 1 ] && [ -z "$(jq -r '.outbounds[] | select(.tag == "uot-direct") | .settings.domainStrategy // empty' "$C")" ] &&
  pass "xray uot-direct outbound, unresolved" || nope "xray uot-direct outbound missing or resolving"
jq -e '[.routing.rules[] | select(.outboundTag == "uot-direct")] | length == 1' "$C" >/dev/null && pass "xray UDP-over-TCP rule" || nope "xray UDP-over-TCP rule missing"
jq -e '[.routing.rules[] | select((.ip // []) | index("::/0"))] | length >= 1' "$C" >/dev/null && pass "xray IPv6 egress blocked" || nope "xray has no ::/0 block rule"

if [ -f /etc/swanctl/conf.d/neoxify.conf ]; then
  # The local id must be the name the panel publishes, or every IKE_AUTH
  # fails while IKE_SA_INIT looks fine.
  swanctl --list-conns 2>/dev/null | grep -q "id: $L1" && pass "ikev2 local id is the certificate name" || nope "ikev2 local id is not the first name"
  swanctl --list-pools 2>/dev/null | grep -q . && pass "ikev2 pool loaded" || nope "ikev2 pool not loaded"
fi
t "wireguard interface up" wg show wg0
grep -q '^ccd-exclusive' /etc/openvpn/server/server.conf 2>/dev/null && pass "openvpn ccd-exclusive" || nope "openvpn has no ccd-exclusive"

for pair in "$L1:2053" "$L2:2096"; do
  h=${pair%:*}
  p=${pair#*:}
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 --resolve "$h:$p:127.0.0.1" "https://$h:$p/")
  [ "$code" = 200 ] && pass "disguise page on $p: 200" || nope "disguise page on $p: $code"
done
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1/)
[ "$code" = 200 ] && pass "disguise page on 80: 200" || nope "disguise page on 80: $code"
curl -sI --max-time 8 http://127.0.0.1/ | grep -qi '^server: nginx/[0-9]' && nope "nginx shows its version" || pass "nginx hides its version"

IF6=$(ip -6 route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}' | head -1)
if [ -n "$IF6" ]; then
  ip6tables -S OUTPUT 2>/dev/null | grep -q -- '--uid-owner nobody' && pass "ipv6 rejected for xray" || nope "ipv6 open for xray"
fi
[ "$(cat /proc/sys/net/ipv6/conf/all/forwarding)" = 0 ] && pass "ipv6 forwarding off" || nope "ipv6 forwarding on"
[ "$(iptables -S OUTPUT 2>/dev/null | grep -c neoxify-no-self-loop)" = 2 ] && pass "self-connect guard (2 rules)" || nope "self-connect guard missing"
[ "$(cat /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null || echo 0)" -ge 65536 ] && pass "conntrack limit" || nope "conntrack limit under 65536"
[ "$(swapon --noheadings | wc -l)" -ge 1 ] || [ "$(free -m | awk '/^Mem:/{print $2}')" -gt 1100 ] && pass "memory or swap" || nope "small box without swap"

if [ "$HOP" = hop ]; then
  nft list table ip neoxify_chain >/dev/null 2>&1 && pass "hop table loaded ($(nft list table ip neoxify_chain | grep -c 'dnat to') exits)" || nope "hop table not loaded"
  [ "$(cat /proc/sys/net/ipv4/ip_forward)" = 1 ] && pass "ipv4 forwarding on" || nope "ipv4 forwarding off: the hop forwards nothing"
fi

echo "agent $(/usr/local/bin/agentd --version 2>&1 | head -1); xray $("$X" version 2>/dev/null | head -1 | cut -d' ' -f2); up since $(uptime -s)"
exit $fail
