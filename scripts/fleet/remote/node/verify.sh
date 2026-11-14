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
# ip6tables prints, and saves, the owner of a rule as a number (65534),
# whatever name the rule was added with: "--uid-owner nobody" is in
# neither. Read by name alone, every server of the first real run looked
# open to IPv6 with both rules in place. Both spellings are the rule.
v6_owner_rules() { # rules on stdin -> how many name uid nobody
  local uid
  uid=$(id -u nobody 2>/dev/null || echo 65534)
  grep -cE -- "--uid-owner ($uid|nobody)( |\$)"
}

# Captured first, then looked at, here and below. Piped straight into
# `grep -q` under pipefail, the command on the left is killed when grep
# closes the pipe on its first match, and the pipeline fails with the
# match found: on a real server that runs chrony this line chose
# systemd-timesyncd 16 times out of 40, and then failed it as a unit.
units_listed=$(systemctl list-unit-files chrony.service 2>/dev/null)
timeunit=chrony
grep -q chrony <<<"$units_listed" || timeunit=systemd-timesyncd
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
# Running AND listening, every engine, IKEv2 with its connections loaded.
while read -r word rest; do
  case "$word" in ok) pass "$rest" ;; DOWN) nope "$rest" ;; esac
done < <("$(dirname "$0")/engines.sh" check 2>&1)
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
# No customer may reach this server's own loopback or private ranges
# through a tunnel: the Xray API and OpenVPN's management port listen
# there. Three things hold that, and each is checked: the rule is there,
# nothing a customer's traffic could match sits before it (only the API's
# own rule and the UDP-over-TCP carve-out may), and IPIfNonMatch is on,
# without which a name that resolves to loopback walks past an ip rule.
# shellcheck disable=SC2016
jq -e '.routing.rules as $r
  | ([$r[] | (.outboundTag == "block" and ((.ip // []) | (index("127.0.0.0/8") != null and index("10.0.0.0/8") != null
       and index("172.16.0.0/12") != null and index("192.168.0.0/16") != null and index("169.254.0.0/16") != null)))]
     | index(true)) as $p
  | $p != null
    and ([$r[:$p][] | select(.inboundTag != ["api-in"] and .inboundTag != ["api"] and .outboundTag != "uot-direct")] | length == 0)' "$C" >/dev/null &&
  pass "xray private ranges blocked, before any rule a customer's traffic could match" || nope "xray private-range block rule missing, or a rule sits before it"
[ "$(jq -r '.routing.domainStrategy // empty' "$C")" = IPIfNonMatch ] && pass "xray routing IPIfNonMatch" || nope "xray routing.domainStrategy is not IPIfNonMatch: a name resolving to loopback passes the private-range block"

if [ -f /etc/swanctl/conf.d/neoxify.conf ]; then
  # The local id must be the name the panel publishes, or every IKE_AUTH
  # fails while IKE_SA_INIT looks fine.
  conns=$(swanctl --list-conns 2>/dev/null)
  pools=$(swanctl --list-pools 2>/dev/null)
  grep -q "id: $L1" <<<"$conns" && pass "ikev2 local id is the certificate name" || nope "ikev2 local id is not the first name"
  [ -n "$pools" ] && pass "ikev2 pool loaded" || nope "ikev2 pool not loaded"
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
headers=$(curl -sI --max-time 8 http://127.0.0.1/)
grep -qi '^server: nginx/[0-9]' <<<"$headers" && nope "nginx shows its version" || pass "nginx hides its version"
# What installer/maintenance/fix-node-port-80.sh reports, as checks: the
# distribution's default site is off, and no certificate renews by
# binding port 80 itself (nginx holds it, so that renewal would fail in
# silence about ninety days from now).
[ ! -e /etc/nginx/sites-enabled/default ] && [ -e /etc/nginx/sites-enabled/neoxify-http ] && pass "nginx default site off, the deliberate port 80 site in place" || nope "nginx default site still enabled, or the deliberate port 80 site missing"
if grep -lsE '^[[:space:]]*authenticator[[:space:]]*=[[:space:]]*standalone' /etc/letsencrypt/renewal/*.conf >/dev/null; then
  nope "a certificate renews by standalone: it cannot while nginx holds port 80"
else
  pass "no certificate renews by standalone"
fi

# Closed for Xray whether or not the box has a global IPv6 today: the
# provider can turn it on later, and nothing is run again when it does.
if [ -d /proc/sys/net/ipv6 ]; then
  [ "$(ip6tables -S OUTPUT 2>/dev/null | v6_owner_rules)" -ge 2 ] && pass "ipv6 rejected for xray (global IPv6 addresses now: $(ip -6 addr show scope global 2>/dev/null | grep -c inet6))" || nope "ipv6 open for xray"
  [ "$(cat /proc/sys/net/ipv6/conf/all/forwarding)" = 0 ] && pass "ipv6 forwarding off" || nope "ipv6 forwarding on"
else
  pass "no IPv6 in this kernel"
fi

# What a provider's image can bring along. The installer's own check
# (installer/lib/image.sh) is asked, so there is one definition of each:
# ufw and its chains, a hostname or /etc/hosts carrying a brand word,
# swap on a small box, a firmware timer on a virtual machine, a default
# route. It is asked here, and again after the reboot, because that is
# where two of them came back on the first build: cloud-init rewrote
# /etc/hosts with the provider's label, and rules saved with ufw's chains
# in them would have been loaded again.
PI=/root/neoxify-installer/maintenance/provider-image.sh
if [ -f "$PI" ]; then
  while read -r st rest; do
    case "$st" in
      ok) pass "image $rest" ;;
      REPAIR | LOOK) nope "image $rest" ;;
    esac
  done < <(bash "$PI" 2>&1)
else
  nope "image checks: no installer copy with maintenance/provider-image.sh on this box"
fi
if grep -qsE '^:ufw6?-|^:(INPUT|FORWARD) (DROP|REJECT)' /etc/iptables/rules.v4 /etc/iptables/rules.v6; then
  nope "the saved firewall rules hold ufw chains or a closed policy: the next boot loads them"
else
  pass "saved firewall rules: no ufw chain, no closed policy"
fi
# Nothing may assume an interface name. Every NAT rule has to name the
# interface the default route really leaves by, or the tunnels connect
# and carry nothing.
DEF=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}' | head -1)
NATIF=$(iptables -t nat -S POSTROUTING 2>/dev/null | sed -n 's/.* -o \([^ ]*\) .*-j MASQUERADE.*/\1/p' | sort -u | tr '\n' ' ')
if [ -z "$NATIF" ]; then
  nope "no MASQUERADE rule: WireGuard, OpenVPN and IKEv2 would connect and carry nothing"
elif [ "$NATIF" = "$DEF " ]; then
  pass "NAT leaves by the interface the default route uses ($DEF)"
else
  nope "NAT rules name '${NATIF% }', and the default route leaves by '$DEF'"
fi
[ "$(iptables -S OUTPUT 2>/dev/null | grep -c neoxify-no-self-loop)" = 2 ] && pass "self-connect guard (2 rules)" || nope "self-connect guard missing"
[ "$(cat /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null || echo 0)" -ge 65536 ] && pass "conntrack limit" || nope "conntrack limit under 65536"
[ "$(swapon --noheadings | wc -l)" -ge 1 ] || [ "$(free -m | awk '/^Mem:/{print $2}')" -gt 1100 ] && pass "memory or swap" || nope "small box without swap"

if [ "$HOP" = hop ]; then
  nft list table ip neoxify_chain >/dev/null 2>&1 && pass "hop table loaded ($(nft list table ip neoxify_chain | grep -c 'dnat to') exits)" || nope "hop table not loaded"
  [ "$(cat /proc/sys/net/ipv4/ip_forward)" = 1 ] && pass "ipv4 forwarding on" || nope "ipv4 forwarding off: the hop forwards nothing"
fi

echo "agent $(/usr/local/bin/agentd --version 2>&1 | head -1); xray $("$X" version 2>/dev/null | head -1 | cut -d' ' -f2); up since $(uptime -s)"
exit $fail
