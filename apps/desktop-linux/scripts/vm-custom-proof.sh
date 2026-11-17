#!/usr/bin/env bash
# Proves Custom mode (choosing which programs use the VPN) in the INSTALLED
# Linux client, at the wire. Run on a test machine, as root, from a login
# session of an ordinary user (SSH is fine: the test programs must run in
# /user.slice, which is all Custom mode ever moves):
#
#   sudo bash vm-custom-proof.sh /home/nx/profiles
#
# Environment, all optional:
#   ENGINES   profile names to run both modes with
#             (default: xray_vless_reality wireguard openvpn ikev2)
#   RACE      launches in the start-up race (default 300; 0 skips it)
#   EXTRAS    1 runs the one-off checks after the engines (default 1)
#   AS_USER   the ordinary user the test programs run as (default: the
#             user who ran sudo)
#   KEEP      1 keeps the captures in /root/nx-custom-pcaps (they hold
#             the servers' addresses: never paste them anywhere)
#
# Each engine is run in both modes through the helper's own requests
# (SetSplitTunnel, then Connect), with a capture on the uplink as the
# judge. The chosen apps are a copy of curl and a copy of bash at a path of
# this script's own; the system's curl is the unchosen one. Each kind of
# traffic has a destination of its own, so the capture can tell them
# apart:
#
#   chosen, started before the connect (bash's /dev/tcp)  api.ipify.org:80   UDP 198.51.100.11
#   chosen, started after it (the curl copy)              1.1.1.1:443        UDP 198.51.100.12
#   a child of a chosen program (system curl under bash)  1.0.0.1:443        UDP 198.51.100.13
#   not chosen (system curl)                              api.ipify.org:443  UDP 198.51.100.14
#   IPv6: chosen 2606:4700:4700::1111, not chosen 2606:4700:4700::1001
#
# One line per check, "PASS ..." or "FAIL ...: reason", then "ALL PASS" or
# "FAILED n". It never prints an address, a key or a profile's contents:
# an exit address is "the VM's own" or "different". It puts the machine
# back whatever fails, and a dead-man timer does the same if it dies.
#
# What a pass does not prove: anything about a censored network or a real
# IPv6 path (the machine has IPv6 addresses but nothing answers, so a leak
# shows as packets sent), a Flatpak or AppImage app, or the app's own
# screens.
set -u
umask 022

PROFILES=${1:-}
[ -n "$PROFILES" ] && [ -d "$PROFILES" ] || { echo "usage: sudo bash vm-custom-proof.sh <directory of connect requests>"; exit 2; }
[ "$(id -u)" = 0 ] || { echo "vm-custom-proof.sh: run as root"; exit 2; }
for tool in python3 tcpdump curl dig nft ip systemctl gcc runuser; do
  command -v "$tool" >/dev/null 2>&1 || { echo "vm-custom-proof.sh: $tool is not installed"; exit 2; }
done
ENGINES=${ENGINES:-xray_vless_reality wireguard openvpn ikev2}
RACE=${RACE:-300}
EXTRAS=${EXTRAS:-1}
AS_USER=${AS_USER:-${SUDO_USER:-}}
[ -n "$AS_USER" ] && [ "$AS_USER" != root ] || { echo "vm-custom-proof.sh: run through sudo from an ordinary user, or set AS_USER"; exit 2; }
case "$(cut -d: -f3 /proc/$$/cgroup)" in
  /user.slice/*) ;;
  *) echo "vm-custom-proof.sh: run from a login session (this one is not in /user.slice)"; exit 2 ;;
esac

HELPER=/usr/lib/neoxify/neoxify-helper
UNIT=neoxify-helper
DEADMAN=nx-custom-deadman
D=/opt/nx-custom-proof
WORK=$(mktemp -d /run/nx-custom.XXXXXX)
FAILS=0
BG_PIDS=()
V6_CHOSEN=2606:4700:4700::1111
V6_OTHER=2606:4700:4700::1001
RACE_DST=198.51.100.99
# An IPv6 TCP connection being opened (a SYN with no extension headers, as
# curl sends it). Counting only these keeps the late close of a connection
# an earlier check was allowed to make from reading as a new one.
SYN6="ip6 and ip6[6] == 6 and (ip6[53] & 0x02) != 0"

UPLINK=$(ip -4 route show default | awk '{for (i=1;i<NF;i++) if ($i=="dev") {print $(i+1); exit}}')
[ -n "$UPLINK" ] || { echo "vm-custom-proof.sh: no IPv4 default route to test from"; exit 2; }
GW=$(ip -4 route show default | awk '{print $3; exit}')
# The local network's resolver: VirtualBox's NAT puts it beside the gateway.
LANRES=$GW
[ "$GW" = 10.0.2.2 ] && LANRES=10.0.2.3
LANNET=$(ip -4 route show dev "$UPLINK" scope link proto kernel | awk '{print $1; exit}')
MYMAC=$(cat "/sys/class/net/$UPLINK/address")
# The uplink's IPv6 resolver, if it was handed one: lookups at it are tried too.
LANRES6=$(resolvectl dns "$UPLINK" 2>/dev/null | tr ' ' '\n' | grep -m1 -E '^[0-9a-f]+:[0-9a-f:]+$')
RP_ALL=$(cat /proc/sys/net/ipv4/conf/all/rp_filter)
RP_UP=$(cat "/proc/sys/net/ipv4/conf/$UPLINK/rp_filter")

pass() { echo "PASS $1 $2"; }
fail() { echo "FAIL $1 $2: $3"; FAILS=$((FAILS + 1)); }
judge() { if [ "$3" = ok ]; then pass "$1" "$2"; else fail "$1" "$2" "$3"; fi; }
ms() { echo $(( $(date +%s%N) / 1000000 )); }
as_user() { runuser -u "$AS_USER" -- "$@"; }

cat > "$WORK/j.py" <<'PY'
import ipaddress, json, shlex, socket, sys

def server(p):
    if "endpoint" in p:
        host, _, port = p["endpoint"].rpartition(":")
        return host.strip("[]"), int(port)
    if "server" in p:
        return p["server"], 4500
    return p["host"], int(p["port"])

def literal(host):
    try:
        return str(ipaddress.IPv4Address(host))
    except ValueError:
        try:
            return socket.getaddrinfo(host, None, socket.AF_INET)[0][4][0]
        except OSError:
            return ""

cmd = sys.argv[1]
if cmd == "info":
    p = json.load(open(sys.argv[2]))["profile"]
    host, port = server(p)
    print(shlex.join([str(p.get("protocol", "")).upper(), literal(host), str(port)]))
elif cmd == "split":
    # setSplitTunnel request: split <on|off> <onlySelected|allExcept> apps...
    print(json.dumps({"type": "setSplitTunnel", "config": {
        "enabled": sys.argv[2] == "on", "mode": sys.argv[3], "apps": sys.argv[4:]}}))
elif cmd == "status":
    try:
        s = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        s = {}
    out = {
        "reply": s.get("status", "none"),
        "connected": str(s.get("connected", "")).lower(),
        "active": str(s.get("split_tunnel_active", "")).lower(),
        "problem": "yes" if s.get("split_tunnel_problem") else "no",
        "code": s.get("split_tunnel_problem_code") or "",
        "restart": ",".join(sorted(s.get("split_tunnel_restart_needed") or [])),
        "ipv6_blocked": str(s.get("ipv6_blocked", "")).lower(),
        "ipv4_confined": str(s.get("ipv4_confined", "")).lower(),
        "dns_unprotected": str(s.get("tunnel_dns_unprotected", "")).lower(),
        "health": (s.get("health") or {}).get("state", ""),
    }
    for k, v in out.items():
        print(f"S_{k}={shlex.quote(str(v))}")
elif cmd == "reply":
    # "ok", or "error: <first words of the message>" (messages carry no addresses).
    try:
        s = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        s = {}
    if s.get("status") == "ok":
        print("ok")
    else:
        print("error: " + " ".join(str(s.get("message", s.get("status", "nothing"))).split()[:14]))
elif cmd == "lists":
    # running apps: does the list hold argv[2], and does it hold argv[3]?
    s = json.loads(sys.stdin.read() or "{}")
    paths = {a.get("path") for a in s.get("apps") or []}
    print(("yes" if sys.argv[2] in paths else "no") + " " + ("yes" if sys.argv[3] in paths else "no"))
PY
py() { python3 -I "$WORK/j.py" "$@"; }
ctl() { timeout 60 "$HELPER" ctl "$1" 2>/dev/null; }
ctl_file() { timeout 60 "$HELPER" ctl "$(cat "$1")" 2>/dev/null; }
status() { eval "$(ctl '{"type":"status"}' | py status)"; }
disconnect() { ctl '{"type":"disconnect"}' >/dev/null; }
split() { ctl "$(py split "$@")" | py reply; }

# The machine's networking, as vm-proof.sh takes it.
snapshot() {
  local d=$1
  mkdir -p "$d"
  ip -4 route show table all | sed -E 's/ expires [0-9]+sec//' > "$d/routes4"
  ip -6 route show table all | sed -E 's/ expires [0-9]+sec//' > "$d/routes6"
  ip -4 rule > "$d/rules4"
  ip -6 rule > "$d/rules6"
  ip -br link | awk '{print $1, $2}' > "$d/links"
  command -v resolvectl >/dev/null 2>&1 && resolvectl status 2>&1 | grep -v 'Current DNS Server' > "$d/resolvectl"
  nft list ruleset > "$d/nftables" 2>&1
  cat /etc/resolv.conf > "$d/resolv.conf" 2>/dev/null
  grep -H . /proc/sys/net/ipv4/conf/*/src_valid_mark /proc/sys/net/ipv4/conf/*/rp_filter > "$d/sysctl" 2>/dev/null
}
same_as_baseline() {
  local d="$WORK/now" parts f
  for _ in $(seq 1 10); do
    parts=""
    rm -rf "$d"
    snapshot "$d"
    for f in "$WORK/baseline"/*; do cmp -s "$f" "$d/$(basename "$f")" || parts="$parts $(basename "$f")"; done
    [ -z "$parts" ] && { echo ok; return; }
    sleep 0.5
  done
  echo "differs from before the connect in:$parts"
}
online() { curl -s -m 8 -o /dev/null -w '%{http_code}' https://example.com 2>/dev/null | grep -qE '^(200|30[0-9])$'; }
wait_helper() {
  for _ in $(seq 1 40); do
    [ -S /run/neoxify/helper.sock ] && ctl '{"type":"status"}' | grep -q '"status":"state"' && return 0
    sleep 0.5
  done
  return 1
}
tunnel_iface() { ip -br link | awk '$1 ~ /^(neoconnect0|neoxify-wg|neoxify-ovpn|ipsec[0-9]+)(@|$)/ {sub(/@.*/, "", $1); print $1; exit}'; }
group_of() { cut -d: -f3 "/proc/$1/cgroup" 2>/dev/null; }
count() { tcpdump -nr "$1" "$2" 2>/dev/null | wc -l; }

# The address the internet sees, in words only.
word() { if [ -z "$1" ]; then echo "no answer"; elif [ "$1" = "$OWN" ]; then echo "the VM's own"; else echo different; fi; }
trace_https() { "$@" -s -m 10 "https://$TRACE_HOST/cdn-cgi/trace" 2>/dev/null | tr -d '\r' | sed -n 's/^ip=//p'; }
# What a child of the bash copy (the system's curl) sees.
bash_exit() { word "$(as_user "$D/nxbash" -c 'curl -s -m 10 https://1.1.1.1/cdn-cgi/trace' 2>/dev/null | tr -d '\r' | sed -n 's/^ip=//p')"; }

capture_start() {
  tcpdump -ni "$1" -U -s 128 -w "$2" >/dev/null 2>&1 &
  CAP_PID=$!
  BG_PIDS+=("$CAP_PID")
  sleep 1.5
}
capture_stop() { sleep 1; kill "$CAP_PID" 2>/dev/null; wait "$CAP_PID" 2>/dev/null; }

arm_deadman() {
  systemctl stop "$DEADMAN.timer" "$DEADMAN.service" >/dev/null 2>&1
  systemctl reset-failed "$DEADMAN.timer" "$DEADMAN.service" >/dev/null 2>&1
  systemd-run --quiet --unit="$DEADMAN" --on-active=300 /bin/sh -c \
    "systemctl stop $UNIT; pkill -KILL -f '^$D/'; pkill -KILL -x charon-cmd; $HELPER sweep; nft delete table inet neoxify; nft delete table inet neoxify_split; echo $RP_ALL > /proc/sys/net/ipv4/conf/all/rp_filter; echo $RP_UP > /proc/sys/net/ipv4/conf/$UPLINK/rp_filter; rm -rf $D; systemctl start $UNIT" \
    >/dev/null 2>&1
}

finish() {
  trap - EXIT INT TERM
  for p in "${BG_PIDS[@]}"; do kill "$p" 2>/dev/null; done
  pkill -KILL -f "^$D/" 2>/dev/null
  echo "$RP_ALL" > /proc/sys/net/ipv4/conf/all/rp_filter
  echo "$RP_UP" > "/proc/sys/net/ipv4/conf/$UPLINK/rp_filter"
  systemctl is-active --quiet "$UNIT" || systemctl start "$UNIT" >/dev/null 2>&1
  wait_helper >/dev/null
  disconnect
  split off onlySelected >/dev/null
  sleep 1
  systemctl stop "$DEADMAN.timer" "$DEADMAN.service" >/dev/null 2>&1
  [ -d "$WORK/baseline" ] && judge machine "left as found" "$(same_as_baseline)"
  # KEEP=1 keeps the captures, root's alone, for a look at a failure.
  if [ "${KEEP:-0}" = 1 ]; then rm -rf /root/nx-custom-pcaps; mkdir -m 700 /root/nx-custom-pcaps; cp "$WORK"/*.pcap /root/nx-custom-pcaps/ 2>/dev/null; fi
  rm -rf "$WORK" "$D"
  if [ "$FAILS" -eq 0 ]; then echo "ALL PASS"; else echo "FAILED $FAILS"; fi
  exit $(( FAILS > 0 ))
}
trap finish EXIT
trap 'exit 1' INT TERM

# ---------------------------------------------------------------------
# The test programs.

rm -rf "$D"
mkdir -p "$D/out"
chown "$AS_USER" "$D/out"
cp /usr/bin/curl "$D/nxcurl"
cp "$(readlink -f /usr/bin/bash)" "$D/nxbash"
cp "$(readlink -f /usr/bin/sleep)" "$D/nxsleep"
# Sends one UDP datagram the instant it starts, before anything else.
cat > "$WORK/first.c" <<'C'
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
int main(int argc, char **argv) {
    int s = socket(AF_INET, SOCK_DGRAM, 0);
    struct sockaddr_in a = {0};
    a.sin_family = AF_INET;
    a.sin_port = htons(9);
    inet_pton(AF_INET, argv[1], &a.sin_addr);
    sendto(s, "x", 1, 0, (struct sockaddr *)&a, sizeof a);
    return 0;
}
C
gcc -O2 -o "$D/nxfirst" "$WORK/first.c" || { echo "vm-custom-proof.sh: could not build the race program"; exit 2; }
chmod 755 "$D" "$D"/nx*
CHOSEN=("$D/nxcurl" "$D/nxbash")

[ "$(split off onlySelected)" = ok ] || { fail machine "Custom mode off before starting" "refused"; exit 1; }
disconnect
online || { fail machine online "no internet before any connect; nothing to prove"; exit 1; }
TRACE_HOST=1.1.1.1
OWN=$(trace_https curl)
[ -n "$OWN" ] || { fail machine "the VM's own address" "no answer from the address check"; exit 1; }
# The third address-check service, pinned to one of its addresses so the
# capture can name it: plain HTTP for bash's /dev/tcp, HTTPS for curl.
IPIFY=$(getent ahostsv4 api.ipify.org | awk '{print $1; exit}')
[ -n "$IPIFY" ] || { fail machine "the address-check service" "its name did not resolve"; exit 1; }
snapshot "$WORK/baseline"

# The control: the capture sees each kind of traffic when nothing stops it.
capture_start "$UPLINK" "$WORK/control.pcap"
judge control "plain-HTTP address check answers" "$([ "$(word "$(as_user curl -s -m 8 -H 'Host: api.ipify.org' "http://$IPIFY/")")" = "the VM's own" ] && echo ok || echo no)"
as_user curl -s -m 2 -o /dev/null tftp://198.51.100.11/x
as_user dig +time=2 +tries=1 +short "@$LANRES" example.com A >/dev/null 2>&1
as_user curl -6 -s -m 3 -o /dev/null "https://[$V6_CHOSEN]/"
capture_stop
judge control "TCP is captured" "$([ "$(count "$WORK/control.pcap" "dst host $IPIFY and tcp port 80")" -gt 0 ] && echo ok || echo none)"
judge control "UDP is captured" "$([ "$(count "$WORK/control.pcap" 'dst host 198.51.100.11 and udp')" -gt 0 ] && echo ok || echo "none (is tftp in this curl?)")"
judge control "a lookup is captured" "$([ "$(count "$WORK/control.pcap" "port 53 and ether src $MYMAC")" -gt 0 ] && echo ok || echo none)"
judge control "global IPv6 is captured" "$([ "$(count "$WORK/control.pcap" "$SYN6 and dst host $V6_CHOSEN")" -gt 0 ] && echo ok || echo none)"

# A chosen program that was already running when Custom mode came up. It
# waits on a pipe, then makes its own connections, then waits to be let go.
start_pre() {
  rm -f "$D/out/go" "$D/out/pre"
  mkfifo -m 666 "$D/out/go"
  as_user "$D/nxbash" -c '
    read -r _ < "$1"
    if exec 3<>"/dev/tcp/$3/80"; then
      printf "GET / HTTP/1.0\r\nHost: api.ipify.org\r\n\r\n" >&3
      IFS= read -r -d "" -t 10 all <&3
      printf "%s" "${all##*$'"'"'\n'"'"'}" | tr -d "\r" > "$2"
      exec 3<&-
    fi
    echo x > /dev/udp/198.51.100.11/9
    read -r _ < "$1"
  ' pre "$D/out/go" "$D/out/pre" "$IPIFY" >/dev/null 2>&1 &
  BG_PIDS+=("$!")
  PRE=""
  for _ in $(seq 1 20); do PRE=$(pgrep -n -f "^$D/nxbash -c") && break; sleep 0.1; done
  PRE_FROM=$(group_of "$PRE")
}
# Never blocks: a program that has already gone has nobody reading the pipe.
release_pre() { timeout 5 sh -c 'echo go > "$1"' _ "$D/out/go" 2>/dev/null; }

# The four kinds of traffic, one destination each. Sets E_PRE, E_NEW,
# E_CHILD, E_OTHER to what each saw (in words).
traffic() {
  release_pre
  TRACE_HOST=1.1.1.1 E_NEW=$(word "$(trace_https as_user "$D/nxcurl")")
  as_user "$D/nxcurl" -s -m 3 -o /dev/null tftp://198.51.100.12/x
  E_CHILD=$(word "$(as_user "$D/nxbash" -c 'curl -s -m 10 https://1.0.0.1/cdn-cgi/trace; curl -s -m 3 -o /dev/null tftp://198.51.100.13/x' 2>/dev/null | tr -d '\r' | sed -n 's/^ip=//p')")
  E_OTHER=$(word "$(as_user curl -s -m 10 --resolve "api.ipify.org:443:$IPIFY" https://api.ipify.org/ 2>/dev/null)")
  as_user curl -s -m 3 -o /dev/null tftp://198.51.100.14/x
  for _ in $(seq 1 30); do [ -s "$D/out/pre" ] && break; sleep 0.2; done
  E_PRE=$(word "$(cat "$D/out/pre" 2>/dev/null)")
  # Lookups, from both sides, straight at the local network's resolver and
  # through the machine's own.
  as_user dig +time=2 +tries=1 +short "@$LANRES" example.com A >/dev/null 2>&1
  as_user "$D/nxbash" -c 'dig +time=2 +tries=1 +short "@$1" example.org A' _ "$LANRES" >/dev/null 2>&1
  [ -n "$LANRES6" ] && as_user dig +time=2 +tries=1 +short "@$LANRES6" example.com A >/dev/null 2>&1
  [ -n "$LANRES6" ] && as_user "$D/nxbash" -c 'dig +time=2 +tries=1 +short "@$1" example.org A' _ "$LANRES6" >/dev/null 2>&1
  N_OTHER=$(as_user getent ahostsv4 example.net >/dev/null && echo ok || echo "no answer")
  # Through the machine's resolver, which makes no connection of its own
  # that the capture would have to account for.
  N_CHOSEN=$(as_user "$D/nxbash" -c 'getent ahostsv4 example.org' >/dev/null && echo ok || echo "no answer")
  # IPv6, from both sides.
  as_user "$D/nxcurl" -6 -s -m 3 -o /dev/null "https://[$V6_CHOSEN]/"
  as_user curl -6 -s -m 3 -o /dev/null "https://[$V6_OTHER]/"
}

# Destinations of what is meant to bypass the tunnel, as a capture filter.
# Either direction, so a reply counts with its request.
BYPASS_CHOSEN="(host $IPIFY and tcp port 80) or (host 1.1.1.1 and tcp port 443) or (host 1.0.0.1 and tcp port 443) or host 198.51.100.11 or host 198.51.100.12 or host 198.51.100.13"
BYPASS_OTHER="(host $IPIFY and tcp port 443) or host 198.51.100.14"

# ---------------------------------------------------------------------
# One engine in one mode.

run_mode() {
  local P=$1 file=$2 mode=$3 SRV=$4 PORT=$5 reply cap tun in_dst out_dst v6_in v6_out want_in want_out
  local L="$P $mode"
  arm_deadman
  start_pre
  [ -n "$PRE" ] || { fail "$L" "pre-started program" "it did not start"; return; }
  reply=$(split on "$mode" "${CHOSEN[@]}")
  judge "$L" "setSplitTunnel" "$([ "$reply" = ok ] && echo ok || echo "$reply")"
  reply=$(ctl_file "$file" | py reply)
  if [ "$reply" != ok ]; then fail "$L" connect "$reply"; release_pre; release_pre; disconnect; return; fi
  pass "$L" connect
  tun=$(tunnel_iface)
  judge "$L" "pre-started chosen program sorted" "$([ "$(group_of "$PRE")" = /neoxify.split ] && echo ok || echo "it is not in the group")"

  cap="$WORK/$P-$mode.pcap"
  capture_start "$UPLINK" "$cap"
  traffic
  status
  local restart_with_pre=$S_restart
  capture_stop

  if [ "$mode" = onlySelected ]; then
    want_in=different want_out="the VM's own"
    in_dst=$BYPASS_CHOSEN out_dst=$BYPASS_OTHER v6_in=$V6_CHOSEN v6_out=$V6_OTHER
  else
    want_in="the VM's own" want_out=different
    in_dst=$BYPASS_OTHER out_dst=$BYPASS_CHOSEN v6_in=$V6_OTHER v6_out=$V6_CHOSEN
  fi
  # "in" is what belongs in the tunnel in this mode; "out" what does not.
  a=$want_in
  judge "$L" "chosen, started before: exit $a" "$([ "$E_PRE" = "$a" ] && echo ok || echo "it was $E_PRE")"
  judge "$L" "chosen, started after: exit $a" "$([ "$E_NEW" = "$a" ] && echo ok || echo "it was $E_NEW")"
  judge "$L" "child of a chosen program: exit $a" "$([ "$E_CHILD" = "$a" ] && echo ok || echo "it was $E_CHILD")"
  b=$want_out
  judge "$L" "not chosen: exit $b" "$([ "$E_OTHER" = "$b" ] && echo ok || echo "it was $E_OTHER")"
  n=$(count "$cap" "ip and ($in_dst)")
  judge "$L" "capture: nothing meant for the tunnel on the uplink (TCP and UDP)" "$([ "$n" = 0 ] && echo ok || echo "$n packets")"
  n=$(count "$cap" "ip and ($out_dst)")
  judge "$L" "capture: what bypasses is seen on the uplink" "$([ "$n" -gt 0 ] && echo ok || echo "none, so the capture proves nothing")"
  n=$(count "$cap" "ip and udp and ($out_dst)")
  judge "$L" "capture: bypassing UDP is seen on the uplink" "$([ "$n" -gt 0 ] && echo ok || echo none)"
  n=$(count "$cap" "port 53 and ether src $MYMAC")
  judge "$L" "capture: no DNS on the uplink" "$([ "$n" = 0 ] && echo ok || echo "$n packets")"
  n=$(count "$cap" "$SYN6 and dst host $v6_in")
  judge "$L" "capture: IPv6 refused for what belongs in the tunnel" "$([ "$n" = 0 ] && echo ok || echo "$n packets sent")"
  n=$(count "$cap" "$SYN6 and dst host $v6_out")
  judge "$L" "capture: IPv6 of what bypasses is sent (the control)" "$([ "$n" -gt 0 ] && echo ok || echo none)"
  if [ "$mode" = allExcept ]; then
    # Everything that is not a chosen program's goes into the tunnel, the
    # machine's own daemons included.
    n=$(count "$cap" "ip and not ($BYPASS_CHOSEN) and not host $SRV and not arp and not (udp and (port 67 or port 68)) and not (tcp port 22 and net $LANNET) and not dst net 224.0.0.0/4")
    judge "$L" "capture: no other IPv4 on the uplink" "$([ "$n" = 0 ] && echo ok || echo "$n packets")"
  fi
  n=$(count "$cap" "host $SRV")
  judge "$L" "capture: the engine's own traffic is seen" "$([ "$n" -gt 0 ] && echo ok || echo none)"
  judge "$L" "names resolve for a program not chosen" "$N_OTHER"
  judge "$L" "names resolve for a chosen program" "$N_CHOSEN"

  judge "$L" "status: Custom mode active" "$([ "$S_active" = true ] && echo ok || echo "it says '$S_active' (connected '$S_connected', health '$S_health')")"
  judge "$L" "status: no problem reported" "$([ "$S_problem" = no ] && [ -z "$S_code" ] && echo ok || echo "problem '$S_problem' code '$S_code'")"
  judge "$L" "status: restart needed names exactly the pre-started program" "$([ "$restart_with_pre" = nxbash ] && echo ok || echo "it names '$restart_with_pre'")"
  judge "$L" "status: DNS protected" "$([ "$S_dns_unprotected" = false ] && echo ok || echo "it says '$S_dns_unprotected'")"
  echo "INFO $L status: ipv4_confined '$S_ipv4_confined', ipv6_blocked '$S_ipv6_blocked' (no machine-wide table in Custom mode)"
  release_pre
  sleep 0.5
  status
  judge "$L" "status: restart needed empty once it has exited" "$([ -z "$S_restart" ] && echo ok || echo "it names '$S_restart'")"
  reply=$(ctl '{"type":"probeSplitTunnel"}' | py reply)
  judge "$L" "probeSplitTunnel" "$reply"

  # The groups the processes came from: a fresh chosen program, held
  # running, goes back to where it started at disconnect.
  as_user "$D/nxsleep" 30 >/dev/null 2>&1 &
  local job=$!
  disown "$job"
  BG_PIDS+=("$job")
  local held="" from
  for _ in $(seq 1 20); do held=$(pgrep -n -f "^$D/nxsleep 30") && break; sleep 0.1; done
  from=$(group_of "$$")
  if [ "$mode" = onlySelected ]; then
    reply=$(split on "$mode" "${CHOSEN[@]}" "$D/nxsleep")
    sleep 0.5
    judge "$L" "a program chosen while connected is sorted" "$([ "$reply" = ok ] && [ "$(group_of "$held")" = /neoxify.split ] && echo ok || echo "reply '$reply', group: $([ "$(group_of "$held")" = /neoxify.split ] && echo ours || echo other)")"
  fi

  reply=$(ctl '{"type":"disconnect"}' | py reply)
  judge "$L" disconnect "$reply"
  sleep 1
  judge "$L" "after disconnect: as before" "$(same_as_baseline)"
  [ -n "$held" ] && judge "$L" "after disconnect: the process is back in its own group" "$([ "$(group_of "$held")" = "$from" ] && echo ok || echo "it is elsewhere")"
  kill "$held" 2>/dev/null
  judge "$L" "after disconnect: online" "$(online && echo ok || echo "no page")"
  [ "$(split off onlySelected)" = ok ] || fail "$L" "Custom mode off" "refused"
}

FILES=()
for e in $ENGINES; do
  [ -f "$PROFILES/$e.json" ] && FILES+=("$PROFILES/$e.json") || fail "$e" profile "not found"
done

for file in "${FILES[@]}"; do
  eval "set -- $(py info "$file")"
  P=$1 SRV=$2 PORT=$3
  [ -n "$SRV" ] || { fail "$P" profile "its server could not be resolved"; continue; }
  run_mode "$P" "$file" onlySelected "$SRV" "$PORT"
  run_mode "$P" "$file" allExcept "$SRV" "$PORT"
done

# ---------------------------------------------------------------------
# The start-up race, at its worst: a program that sends a datagram the
# instant it starts, started fresh again and again by a program that is
# not chosen, under "only these apps". Every datagram has to be in the
# tunnel: counted on the uplink (must be none) and on the tunnel (must be
# all of them).

if [ "$RACE" -gt 0 ] && [ "${#FILES[@]}" -gt 0 ]; then
  file=${FILES[0]}
  eval "set -- $(py info "$file")"
  P=$1
  arm_deadman
  if [ "$(split on onlySelected "$D/nxfirst")" = ok ] && [ "$(ctl_file "$file" | py reply)" = ok ]; then
    tun=$(tunnel_iface)
    capture_start "$UPLINK" "$WORK/race-up.pcap"
    up_pid=$CAP_PID
    capture_start "$tun" "$WORK/race-tun.pcap"
    t0=$(ms)
    as_user "$D/nxbash" -c 'for i in $(seq 1 "$1"); do "$2" "$3"; done' race "$RACE" "$D/nxfirst" "$RACE_DST"
    took=$(( $(ms) - t0 ))
    capture_stop
    CAP_PID=$up_pid
    capture_stop
    out=$(count "$WORK/race-up.pcap" "dst host $RACE_DST")
    in=$(count "$WORK/race-tun.pcap" "dst host $RACE_DST")
    echo "INFO race $P: $RACE launches in $took ms; on the uplink $out, in the tunnel $in"
    judge "race $P" "no first packet outside the tunnel" "$([ "$out" = 0 ] && echo ok || echo "$out of $RACE went out the machine's own way")"
    judge "race $P" "every first packet in the tunnel" "$([ "$in" = "$RACE" ] && echo ok || echo "$in of $RACE")"
    status
    judge "race $P" "status: nothing claimed as needing a restart" "$([ -z "$S_restart" ] && echo ok || echo "it names '$S_restart'")"
  else
    fail "race $P" connect "refused"
  fi
  disconnect
  split off onlySelected >/dev/null
  sleep 1
  judge "race $P" "after disconnect: as before" "$(same_as_baseline)"
fi

[ "$EXTRAS" = 1 ] || exit 0
[ -f "$PROFILES/xray_vless_reality.json" ] || { fail extras profile "xray_vless_reality not found"; exit 1; }
X="$PROFILES/xray_vless_reality.json"

# ---------------------------------------------------------------------
# Changing the list and the mode while connected.

arm_deadman
L="change while connected"
if [ "$(split on onlySelected "$D/nxcurl")" = ok ] && [ "$(ctl_file "$X" | py reply)" = ok ]; then
  TRACE_HOST=1.1.1.1
  judge "$L" "curl copy chosen: different" "$([ "$(word "$(trace_https as_user "$D/nxcurl")")" = different ] && echo ok || echo no)"
  judge "$L" "bash copy not chosen: the VM's own" "$([ "$(bash_exit)" = "the VM's own" ] && echo ok || echo no)"
  reply=$(split on onlySelected "$D/nxbash")
  judge "$L" "list changed" "$reply"
  judge "$L" "curl copy no longer chosen: the VM's own" "$([ "$(word "$(trace_https as_user "$D/nxcurl")")" = "the VM's own" ] && echo ok || echo no)"
  judge "$L" "bash copy now chosen: different" "$([ "$(bash_exit)" = different ] && echo ok || echo no)"
  reply=$(split on allExcept "$D/nxbash")
  judge "$L" "mode changed" "$reply"
  judge "$L" "everything except: curl copy different" "$([ "$(word "$(trace_https as_user "$D/nxcurl")")" = different ] && echo ok || echo no)"
  judge "$L" "everything except: bash copy the VM's own" "$([ "$(bash_exit)" = "the VM's own" ] && echo ok || echo no)"
  status
  judge "$L" "status still active" "$([ "$S_active" = true ] && [ "$S_problem" = no ] && echo ok || echo "active '$S_active' problem '$S_problem'")"
  reply=$(split off onlySelected)
  judge "$L" "Custom mode turned off while connected" "$reply"
  status
  judge "$L" "off: leak protection back" "$([ "$S_active" = false ] && [ "$S_ipv4_confined" = true ] && [ "$S_ipv6_blocked" = true ] && nft list table inet neoxify >/dev/null 2>&1 && ! nft list table inet neoxify_split >/dev/null 2>&1 && echo ok || echo "active '$S_active' confined '$S_ipv4_confined' v6 '$S_ipv6_blocked'")"
  judge "$L" "off: bash copy different" "$([ "$(bash_exit)" = different ] && echo ok || echo no)"
else
  fail "$L" connect refused
fi
disconnect
split off onlySelected >/dev/null
sleep 1
judge "$L" "after disconnect: as before" "$(same_as_baseline)"

# OpenVPN cannot move between the full tunnel and Custom mode in place: the
# helper says so, keeps what it had, and the reconnect it asks for takes
# the new shape.
O="$PROFILES/openvpn.json"
L="OpenVPN on and off"
if [ -f "$O" ]; then
  arm_deadman
  if [ "$(ctl_file "$O" | py reply)" = ok ]; then
    reply=$(split on onlySelected "$D/nxcurl")
    judge "$L" "turning it on while connected asks for a reconnect" "$(echo "$reply" | grep -q reconnect && echo ok || echo "it said '$reply'")"
    status
    judge "$L" "the full tunnel stays, with leak protection" "$([ "$S_connected" = true ] && [ "$S_active" = false ] && [ "$S_ipv4_confined" = true ] && nft list table inet neoxify >/dev/null 2>&1 && echo ok || echo "connected '$S_connected' active '$S_active' confined '$S_ipv4_confined'")"
    judge "$L" "not chosen still in the tunnel" "$([ "$(word "$(trace_https as_user curl)")" = different ] && echo ok || echo no)"
    reply=$(ctl_file "$O" | py reply)
    status
    judge "$L" "after the reconnect: Custom mode" "$([ "$reply" = ok ] && [ "$S_active" = true ] && ! nft list table inet neoxify >/dev/null 2>&1 && echo ok || echo "reply '$reply' active '$S_active'")"
    judge "$L" "after the reconnect: not chosen the VM's own" "$([ "$(word "$(trace_https as_user curl)")" = "the VM's own" ] && echo ok || echo no)"
    judge "$L" "after the reconnect: chosen different" "$([ "$(word "$(trace_https as_user "$D/nxcurl")")" = different ] && echo ok || echo no)"
    reply=$(split off onlySelected)
    judge "$L" "turning it off while connected asks for a reconnect" "$(echo "$reply" | grep -q reconnect && echo ok || echo "it said '$reply'")"
    reply=$(ctl_file "$O" | py reply)
    status
    judge "$L" "after the second reconnect: full tunnel with leak protection" "$([ "$reply" = ok ] && [ "$S_active" = false ] && [ "$S_ipv4_confined" = true ] && nft list table inet neoxify >/dev/null 2>&1 && echo ok || echo "reply '$reply' active '$S_active' confined '$S_ipv4_confined'")"
  else
    fail "$L" connect refused
  fi
  disconnect
  split off onlySelected >/dev/null
  sleep 1
  judge "$L" "after disconnect: as before" "$(same_as_baseline)"
fi

# Custom mode on with nothing chosen is the ordinary full tunnel, with
# leak protection.
arm_deadman
L="on with nothing chosen"
if [ "$(split on onlySelected)" = ok ] && [ "$(ctl_file "$X" | py reply)" = ok ]; then
  status
  judge "$L" "status: full tunnel with leak protection" "$([ "$S_active" = false ] && [ "$S_ipv4_confined" = true ] && [ "$S_ipv6_blocked" = true ] && nft list table inet neoxify >/dev/null 2>&1 && ! nft list table inet neoxify_split >/dev/null 2>&1 && echo ok || echo "active '$S_active' confined '$S_ipv4_confined' v6 '$S_ipv6_blocked'")"
  judge "$L" "every program different" "$([ "$(word "$(trace_https as_user curl)")" = different ] && echo ok || echo no)"
  judge "$L" "a request forced out of the uplink fails" "$(as_user curl -s -m 5 --interface "$UPLINK" -o /dev/null https://example.com && echo "it succeeded" || echo ok)"
else
  fail "$L" connect refused
fi
disconnect
split off onlySelected >/dev/null
sleep 1
judge "$L" "after disconnect: as before" "$(same_as_baseline)"

# Strict reverse-path filtering does not break replies, in either mode.
for mode in onlySelected allExcept; do
  arm_deadman
  L="strict rp_filter $mode"
  echo 1 > /proc/sys/net/ipv4/conf/all/rp_filter
  echo 1 > "/proc/sys/net/ipv4/conf/$UPLINK/rp_filter"
  if [ "$(split on "$mode" "$D/nxcurl")" = ok ] && [ "$(ctl_file "$X" | py reply)" = ok ]; then
    if [ "$mode" = onlySelected ]; then a=different b="the VM's own"; else a="the VM's own" b=different; fi
    judge "$L" "chosen: $a" "$([ "$(word "$(trace_https as_user "$D/nxcurl")")" = "$a" ] && echo ok || echo no)"
    judge "$L" "not chosen: $b" "$([ "$(word "$(trace_https as_user curl)")" = "$b" ] && echo ok || echo no)"
    judge "$L" "names resolve" "$(as_user getent ahostsv4 example.net >/dev/null && echo ok || echo "no answer")"
  else
    fail "$L" connect refused
  fi
  disconnect
  split off onlySelected >/dev/null
  sleep 1
  echo "$RP_ALL" > /proc/sys/net/ipv4/conf/all/rp_filter
  echo "$RP_UP" > "/proc/sys/net/ipv4/conf/$UPLINK/rp_filter"
  judge "$L" "after disconnect: as before" "$(same_as_baseline)"
done

# The helper killed hard in the middle of a Custom mode session: systemd
# restarts it, and nothing of Custom mode is left that could blackhole
# traffic, for a program still in the group as well.
arm_deadman
L="helper killed"
start_pre
if [ "$(split on onlySelected "${CHOSEN[@]}")" = ok ] && [ "$(ctl_file "$X" | py reply)" = ok ]; then
  old=$(systemctl show -p MainPID --value "$UNIT")
  kill -KILL "$old"
  back=""
  for _ in $(seq 1 60); do
    new=$(systemctl show -p MainPID --value "$UNIT")
    if [ "$new" != 0 ] && [ "$new" != "$old" ] && systemctl is-active --quiet "$UNIT"; then back=yes; break; fi
    sleep 0.25
  done
  wait_helper >/dev/null
  judge "$L" "restarted" "$([ -n "$back" ] && echo ok || echo "not within 15 s")"
  judge "$L" "Custom mode's table gone" "$(nft list table inet neoxify_split >/dev/null 2>&1 && echo "still loaded" || echo ok)"
  judge "$L" "its rules gone" "$([ "$(ip rule | grep -cE '^2827[5-7]:')" = 0 ] && echo ok || echo "some are left")"
  judge "$L" "its routes gone" "$([ -z "$(ip route show table 28281 2>/dev/null)$(ip route show table 28282 2>/dev/null)" ] && echo ok || echo "some are left")"
  release_pre
  for _ in $(seq 1 30); do [ -s "$D/out/pre" ] && break; sleep 0.2; done
  judge "$L" "a program left in the group still gets out" "$([ "$(word "$(cat "$D/out/pre" 2>/dev/null)")" = "the VM's own" ] && echo ok || echo "it saw: $(word "$(cat "$D/out/pre" 2>/dev/null)")")"
  judge "$L" "online" "$(online && echo ok || echo "no page")"
  status
  judge "$L" "not connected after restart" "$([ "$S_connected" != true ] && echo ok || echo "it says connected")"
  judge "$L" "nothing left" "$(same_as_baseline)"
else
  fail "$L" connect refused
fi
release_pre
disconnect
split off onlySelected >/dev/null
sleep 1

# A snap (Firefox) chosen by its path, started after the connect.
FF=/snap/firefox/current/usr/lib/firefox/firefox
L="snap Firefox"
if [ -x "$FF" ] && command -v snap >/dev/null 2>&1; then
  arm_deadman
  uid=$(id -u "$AS_USER")
  if [ "$(split on onlySelected "$FF")" = ok ] && [ "$(ctl_file "$X" | py reply)" = ok ]; then
    capture_start "$UPLINK" "$WORK/snap.pcap"
    up_pid=$CAP_PID
    capture_start "$(tunnel_iface)" "$WORK/snap-tun.pcap"
    ( cd "/home/$AS_USER" && runuser -u "$AS_USER" -- env XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" \
        timeout 60 snap run firefox --headless --screenshot "/home/$AS_USER/nx-custom-shot.png" http://1.0.0.1/cdn-cgi/trace >/dev/null 2>&1 ) &
    BG_PIDS+=("$!")
    ffpid=""
    # The snap starts it as /snap/firefox/<revision>/..., not by "current".
    for _ in $(seq 1 100); do ffpid=$(pgrep -u "$AS_USER" -o -f "^/snap/firefox/[^ ]*/usr/lib/firefox/firefox") && break; sleep 0.1; done
    sleep 1
    judge "$L" "sorted" "$([ -n "$ffpid" ] && [ "$(group_of "$ffpid")" = /neoxify.split ] && echo ok || echo "$([ -n "$ffpid" ] && echo "in another group" || echo "not seen running")")"
    for _ in $(seq 1 60); do pgrep -u "$AS_USER" -f "^/snap/firefox/[^ ]*/usr/lib/firefox/firefox" >/dev/null || break; sleep 0.5; done
    capture_stop
    CAP_PID=$up_pid
    capture_stop
    rm -f "/home/$AS_USER/nx-custom-shot.png"
    judge "$L" "its page request is in the tunnel" "$([ "$(count "$WORK/snap-tun.pcap" 'dst host 1.0.0.1 and tcp port 80')" -gt 0 ] && echo ok || echo "not seen there, so the next check proves nothing")"
    judge "$L" "its page request is not on the uplink" "$([ "$(count "$WORK/snap.pcap" 'dst host 1.0.0.1 and tcp port 80')" = 0 ] && echo ok || echo "it is")"
  else
    fail "$L" connect refused
  fi
  disconnect
  split off onlySelected >/dev/null
  sleep 1
  judge "$L" "after disconnect: as before" "$(same_as_baseline)"
else
  echo "INFO $L: not installed here, not checked"
fi

# The running programs: the caller's own (root's here), not another user's.
as_user "$D/nxsleep" 20 >/dev/null 2>&1 &
BG_PIDS+=("$!")
"$D/nxsleep" 21 >/dev/null 2>&1 &
BG_PIDS+=("$!")
sleep 0.5
read -r mine theirs <<<"$(ctl '{"type":"listRunningApps"}' | py lists "$D/nxsleep" "$D/nxbash")"
judge apps "listRunningApps lists the caller's program" "$([ "$mine" = yes ] && echo ok || echo "it does not")"
as_user "$D/nxbash" -c 'sleep 20' >/dev/null 2>&1 &
BG_PIDS+=("$!")
sleep 0.5
read -r mine theirs <<<"$(ctl '{"type":"listRunningApps"}' | py lists "$D/nxsleep" "$D/nxbash")"
judge apps "listRunningApps leaves out another user's program" "$([ "$theirs" = no ] && echo ok || echo "it lists it")"
