#!/usr/bin/env bash
# Proves the INSTALLED Linux client at the wire, for every protocol it has
# a connect request for. Run on a test machine, as root:
#
#   sudo bash vm-proof.sh /home/nx/profiles
#
# Each *.json in the directory is the JSON of one ipc Request::Connect.
# For each one it connects through the installed helper and checks what
# the helper says (status), what the machine does (a page, the exit
# address, DNS through the tunnel) and what actually leaves the uplink
# while it tries to leak on purpose (a capture). Then the failure paths:
# the engine killed, the helper killed, the unit stopped, a second connect
# on top of the first, and a server that does not exist.
#
# One line per check, "PASS <protocol> <check>" or "FAIL <protocol>
# <check>: <reason>", then "ALL PASS" or "FAILED n". It never prints an
# address, a key or a file's contents: the profiles are real, and this
# output gets pasted into chats and journals. It puts the machine back as
# it found it whatever fails, and a dead-man timer does the same if the
# script itself dies with a tunnel up.
#
# What a pass does not prove: anything about a censored network, a real
# IPv6 path (the made-up IPv6 below only shows nothing would be sent),
# or a desktop session; the app itself is not driven here.
set -u
umask 077

PROFILES=${1:-}
[ -n "$PROFILES" ] && [ -d "$PROFILES" ] || { echo "usage: sudo bash vm-proof.sh <directory of connect requests>"; exit 2; }
[ "$(id -u)" = 0 ] || { echo "vm-proof.sh: run as root"; exit 2; }
for tool in python3 tcpdump curl dig nft ip systemctl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "vm-proof.sh: $tool is not installed"; exit 2; }
done

HELPER=/usr/lib/neoxify/neoxify-helper
UNIT=neoxify-helper
DEADMAN=nx-proof-deadman
# Documentation addresses only: a made-up global IPv6 for the uplink, a
# made-up gateway for it, and a server that does not exist.
FAKE6=2001:db8:77::15
FAKE6_GW=2001:db8:77::1
FAKE6_MAC=02:00:00:00:77:01
GLOBAL6=2606:4700:4700::1111
DEAD=192.0.2.10

WORK=$(mktemp -d /run/nx-proof.XXXXXX)
FAILS=0
BG_PIDS=()

UPLINK=$(ip -4 route show default | awk '{for (i=1;i<NF;i++) if ($i=="dev") {print $(i+1); exit}}')
GW=$(ip -4 route show default | awk '{print $3; exit}')
LANNET=$(ip -4 route show dev "$UPLINK" scope link proto kernel | awk '{print $1; exit}')
[ -n "$UPLINK" ] && [ -n "$GW" ] && [ -n "$LANNET" ] || { echo "vm-proof.sh: no IPv4 default route to test from"; exit 2; }

pass() { echo "PASS $1 $2"; }
fail() { echo "FAIL $1 $2: $3"; FAILS=$((FAILS + 1)); }
# A check: pass or fail on a condition, with the reason given for a fail.
judge() { if [ "$3" = ok ]; then pass "$1" "$2"; else fail "$1" "$2" "$3"; fi; }

ms() { echo $(( $(date +%s%N) / 1000000 )); }

# The JSON work, in one place. Values come back on stdout for the shell to
# capture into variables; none of them is ever echoed.
cat > "$WORK/j.py" <<'PY'
import ipaddress, json, re, shlex, socket, sys

def server(profile):
    """(host, port) the engine itself dials."""
    if "endpoint" in profile:
        host, _, port = profile["endpoint"].rpartition(":")
        return host.strip("[]"), int(port)
    return profile["host"], int(profile["port"])

def literal(host):
    try:
        return str(ipaddress.IPv4Address(host))
    except ValueError:
        try:
            return socket.getaddrinfo(host, None, socket.AF_INET)[0][4][0]
        except OSError:
            return ""

NAMES = {"wireguard": "WIREGUARD", "xray_vless_reality": "XRAY_VLESS_REALITY", "xray_vless_tls": "XRAY_VLESS_TLS",
         "xray_trojan": "XRAY_TROJAN", "shadowsocks": "SHADOWSOCKS", "openvpn": "OPENVPN", "ikev2": "IKEV2"}

cmd = sys.argv[1]
if cmd == "info":
    req = json.load(open(sys.argv[2]))
    p = req["profile"]
    host, port = server(p)
    proto = NAMES.get(str(p.get("protocol", "")).lower(), str(p.get("protocol", "")).upper())
    print(shlex.join([proto, literal(host), str(port)]))
elif cmd == "dead":
    req = json.load(open(sys.argv[2]))
    p = req["profile"]
    if "endpoint" in p:
        p["endpoint"] = sys.argv[4] + ":" + p["endpoint"].rpartition(":")[2]
    else:
        p["host"] = sys.argv[4]
    req["known_nodes"] = []
    with open(sys.argv[3], "w") as f:
        json.dump(req, f)
elif cmd == "status":
    # key=value lines, shell-quoted, from a status reply on stdin.
    try:
        s = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        s = {}
    t = s.get("traffic") or {}
    out = {
        "reply": s.get("status", "none"),
        "connected": str(s.get("connected", "")).lower(),
        "protocol": s.get("protocol") or "",
        "health": (s.get("health") or {}).get("state", ""),
        "ipv6_blocked": str(s.get("ipv6_blocked", "")).lower(),
        "ipv4_confined": str(s.get("ipv4_confined", "")).lower(),
        "dns_unprotected": str(s.get("tunnel_dns_unprotected", "")).lower(),
        "rx": t.get("rx_bytes", ""), "tx": t.get("tx_bytes", ""),
    }
    for k, v in out.items():
        print(f"S_{k}={shlex.quote(str(v))}")
elif cmd == "kind":
    # The reply to a connect, sorted exactly as the shared interface sorts
    # it (desktop-windows src/lib/connection-errors.ts, first match wins).
    try:
        s = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        s = {}
    if s.get("status") == "ok":
        print("ok"); sys.exit()
    text = str(s.get("message", "")).lower()
    for kind, pat in [
        ("unknown", r"tunnel extension (did not start on this device|had not finished starting)"),
        ("serviceUnavailable", r"background service|pipe|cannot find the file specified.*pipe|not running"),
        ("engineMissing", r"is missing from the installation|missing from the install"),
        ("concurrentLimit", r"concurrent|too many (active )?connections|device limit"),
        ("quotaExhausted", r"quota|data cap|out of data"),
        ("subscriptionInactive", r"suspended|expired|not active|inactive"),
        ("noNetwork", r"no network connection with a gateway"),
        ("serverUnreachable", r"timed out|timeout|unreachable|refused|no route|network is down|handshake"),
    ]:
        if re.search(pat, text):
            print(kind); sys.exit()
    print("unknown")
elif cmd == "refused":
    # Asks the helper for its status as an ordinary process; prints what
    # came back, sorted: "refused", "served" or "nothing".
    sock = socket.socket(socket.AF_UNIX)
    sock.settimeout(5)
    try:
        sock.connect(sys.argv[2])
        sock.sendall(b'{"type":"status"}\n')
        reply = json.loads(sock.makefile().readline() or "{}")
    except (OSError, ValueError):
        print("nothing"); sys.exit()
    if reply.get("status") == "error" and "only the neoxify app" in reply.get("message", "").lower():
        print("refused")
    else:
        print("served")
PY
py() { python3 -I "$WORK/j.py" "$@"; }

ctl() { timeout 60 "$HELPER" ctl "$1" 2>/dev/null; }
ctl_file() { timeout 60 "$HELPER" ctl "$(cat "$1")" 2>/dev/null; }
status() { eval "$(ctl '{"type":"status"}' | py status)"; }
disconnect() { ctl '{"type":"disconnect"}' >/dev/null; }

# The machine's networking, one file per part, so a difference can be
# named without printing it. Lifetimes that count down and the resolver
# systemd-resolved happens to be using are left out: they change on their
# own.
snapshot() {
  local d=$1
  mkdir -p "$d"
  ip -4 route show table all | sed -E 's/ expires [0-9]+sec//' > "$d/routes4"
  ip -6 route show table all | sed -E 's/ expires [0-9]+sec//' > "$d/routes6"
  ip -4 rule > "$d/rules4"
  ip -6 rule > "$d/rules6"
  ip -br link | awk '{print $1, $2}' > "$d/links"
  if command -v resolvectl >/dev/null 2>&1; then
    resolvectl status 2>&1 | grep -v 'Current DNS Server' > "$d/resolvectl"
  fi
  nft list ruleset > "$d/nftables" 2>&1
  cat /etc/resolv.conf > "$d/resolv.conf" 2>/dev/null
  ls -A /run/neoxify/private > "$d/private" 2>/dev/null
}
# "ok", or which parts differ from the baseline. Looked at for up to five
# seconds: a disconnect is answered after the fast half of the teardown,
# and the thorough half (DNS, links, files) finishes just after it.
same_as_baseline() {
  local d="$WORK/now" parts f try
  for try in $(seq 1 10); do
    parts=""
    rm -rf "$d"
    snapshot "$d"
    for f in "$WORK/baseline"/*; do
      cmp -s "$f" "$d/$(basename "$f")" || parts="$parts $(basename "$f")"
    done
    [ -z "$parts" ] && { echo ok; return; }
    sleep 0.5
  done
  echo "differs from before the connect in:$parts"
}

# The network works without a tunnel: a page over the machine's own route.
online() { curl -s -m 8 -o /dev/null -w '%{http_code}' https://example.com 2>/dev/null | grep -qE '^(200|30[0-9])$'; }
wait_online() { local i; for i in $(seq 1 20); do online && return 0; sleep 0.5; done; return 1; }

table_gone() { ! nft list table inet neoxify >/dev/null 2>&1; }

# Waits for a status that satisfies a shell condition, up to $1 seconds.
wait_status() {
  local limit=$1 cond=$2 end
  end=$(( $(date +%s) + limit ))
  while :; do
    status
    eval "$cond" && return 0
    [ "$(date +%s)" -ge "$end" ] && return 1
    sleep 0.5
  done
}

wait_helper() {
  local i
  for i in $(seq 1 40); do
    [ -S /run/neoxify/helper.sock ] && ctl '{"type":"status"}' | grep -q '"status":"state"' && return 0
    sleep 0.5
  done
  return 1
}

fake_ipv6_on() {
  ip -6 addr add "$FAKE6/64" dev "$UPLINK" nodad 2>/dev/null
  ip -6 route add default via "$FAKE6_GW" dev "$UPLINK" metric 1 2>/dev/null
  ip -6 neigh replace "$FAKE6_GW" lladdr "$FAKE6_MAC" dev "$UPLINK" nud permanent 2>/dev/null
}
fake_ipv6_off() {
  ip -6 route del default via "$FAKE6_GW" dev "$UPLINK" metric 1 2>/dev/null
  ip -6 neigh del "$FAKE6_GW" dev "$UPLINK" 2>/dev/null
  ip -6 addr del "$FAKE6/64" dev "$UPLINK" 2>/dev/null
  return 0
}

# The resolvers a lookup straight at the local network would use: the
# gateway, VirtualBox's NAT resolver beside it, and whatever IPv4
# resolvers the uplink was handed.
RESOLVERS="$GW"
case "$GW" in 10.0.2.2) RESOLVERS="$RESOLVERS 10.0.2.3" ;; esac
if command -v resolvectl >/dev/null 2>&1; then
  for r in $(resolvectl dns "$UPLINK" 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+(\.[0-9]+){3}$'); do
    RESOLVERS="$RESOLVERS $r"
  done
fi

# Tries every way out of the tunnel at once, with a capture on the uplink
# running. $1 is the capture file. Sets L_PAGE, L_DIG (lookups that got an
# answer), L_IFACE, L_V6 to what the programs themselves saw.
leak_attempts() {
  local cap=$1 r td
  tcpdump -ni "$UPLINK" -U -s 128 -w "$cap" >/dev/null 2>&1 &
  td=$!
  BG_PIDS+=("$td")
  sleep 1.5
  L_PAGE=fail
  curl -s -m 8 -o /dev/null https://example.com 2>/dev/null && L_PAGE=ok
  L_DIG=0
  for r in $RESOLVERS; do
    dig +time=2 +tries=1 +short "@$r" example.com A 2>/dev/null | grep -qE '^[0-9]' && L_DIG=$((L_DIG + 1))
  done
  L_IFACE=fail
  curl -s -m 5 --interface "$UPLINK" -o /dev/null https://example.com 2>/dev/null && L_IFACE=ok
  fake_ipv6_on
  L_V6=fail
  curl -6 -s -m 4 -o /dev/null "https://[$GLOBAL6]/" 2>/dev/null && L_V6=ok
  ping -6 -c 2 -W 2 "$GLOBAL6" >/dev/null 2>&1 && L_V6=ok
  fake_ipv6_off
  sleep 1
  kill "$td" 2>/dev/null
  wait "$td" 2>/dev/null
}

# Counts packets in a capture matching a filter.
count() { tcpdump -nr "$1" "$2" 2>/dev/null | wc -l; }

# Everything the capture may contain while a tunnel is up: the engine's
# own traffic to its server (and what the server sends back, which for a
# Shadowsocks UDP relay can come from another port), ARP, DHCP, the SSH
# session on the local network, and IPv6's own on-link housekeeping:
# anything from a link-local address to a link-local or multicast one
# (multicast listener reports among them), and neighbour discovery from
# any address, which carries hop limit 255 and so can never be forwarded
# off the link. $2/$3: the server and its port.
allowed_filter() {
  echo "(host $2 and port $3) or src host $2 or arp or (udp and (port 67 or port 68)) or (tcp port 22 and net $LANNET) or (ip6 and src net fe80::/10 and (dst net fe80::/10 or dst net ff00::/8)) or (icmp6 and ip6[7] = 255 and ip6[40] >= 133 and ip6[40] <= 137)"
}

# What a healthy tunnel's status says, as the Windows service reports the
# same engine: WireGuard from its handshake; Xray and OpenVPN "unknown",
# because a running engine is no evidence the server answers (the exit
# address check above is what proves that).
expected_health() { case "$1" in WIREGUARD) echo alive ;; *) echo unknown ;; esac; }

kill_engine() {
  case "$1" in
    WIREGUARD) ip link del neoxify-wg 2>/dev/null ;;
    OPENVPN) pkill -KILL -f 'neoxify\.ovpn' ;;
    *) pkill -KILL -f '^/usr/lib/neoxify/xray' ;;
  esac
}

arm_deadman() {
  systemctl stop "$DEADMAN.timer" "$DEADMAN.service" >/dev/null 2>&1
  systemctl reset-failed "$DEADMAN.timer" "$DEADMAN.service" >/dev/null 2>&1
  systemd-run --quiet --unit="$DEADMAN" --on-active=300 /bin/sh -c \
    "systemctl stop $UNIT; $HELPER sweep; nft delete table inet neoxify; ip -6 route del default via $FAKE6_GW dev $UPLINK metric 1; ip -6 neigh del $FAKE6_GW dev $UPLINK; ip -6 addr del $FAKE6/64 dev $UPLINK; systemctl start $UNIT" \
    >/dev/null 2>&1
}

finish() {
  local rc
  trap - EXIT INT TERM
  for p in "${BG_PIDS[@]}"; do kill "$p" 2>/dev/null; done
  fake_ipv6_off
  systemctl is-active --quiet "$UNIT" || systemctl start "$UNIT" >/dev/null 2>&1
  wait_helper >/dev/null
  disconnect
  sleep 1
  systemctl stop "$DEADMAN.timer" "$DEADMAN.service" >/dev/null 2>&1
  if [ -d "$WORK/baseline" ]; then
    rc=$(same_as_baseline)
    judge machine "left as found" "$rc"
  fi
  rm -rf "$WORK"
  if [ "$FAILS" -eq 0 ]; then echo "ALL PASS"; else echo "FAILED $FAILS"; fi
  exit $(( FAILS > 0 ))
}
trap finish EXIT
trap 'exit 1' INT TERM

# ---------------------------------------------------------------------
# The install and who may call.

systemctl is-enabled --quiet "$UNIT" && systemctl is-active --quiet "$UNIT" \
  && judge helper "unit enabled and active" ok || judge helper "unit enabled and active" "it is not"
mode=$(stat -c '%a %U' /run/neoxify/helper.sock 2>/dev/null)
judge helper "socket mode" "$([ "$mode" = "666 root" ] && echo ok || echo "socket is '$mode', expected '666 root'")"
mode=$(stat -c '%a %U' /run/neoxify/private /var/lib/neoxify 2>/dev/null | tr '\n' ' ')
judge helper "private directories" "$([ "$mode" = "700 root 700 root " ] && echo ok || echo "they are '$mode'")"

disconnect
status
judge helper "root is served" "$([ "$S_reply" = state ] && echo ok || echo "status reply was '$S_reply'")"
who=${SUDO_USER:-nobody}
[ "$who" = root ] && who=nobody
# The program goes in on stdin: the work directory is root's alone.
seen=$(runuser -u "$who" -- python3 -I - refused /run/neoxify/helper.sock < "$WORK/j.py" 2>/dev/null)
judge helper "an ordinary process is refused" "$([ "$seen" = refused ] && echo ok || echo "it was $seen")"
getent group neoxify >/dev/null && judge helper "the neoxify group exists" ok || judge helper "the neoxify group exists" "it does not"
nofile=$(systemctl show -p LimitNOFILE --value "$UNIT" 2>/dev/null)
judge helper "descriptor limit raised" "$([ "${nofile:-0}" -ge 65536 ] 2>/dev/null && echo ok || echo "LimitNOFILE is '$nofile'")"
# A caller that connects and sends nothing is let go within the helper's
# request wait (5 s), rather than holding a descriptor for ever.
held=$(timeout 15 python3 -I -c '
import socket, sys, time
s = socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); began = time.time()
s.settimeout(12)
try:
    s.recv(1)
    print("closed" if time.time() - began < 10 else "held")
except OSError:
    print("held")
' /run/neoxify/helper.sock 2>/dev/null)
judge helper "a silent connection is let go" "$([ "$held" = closed ] && echo ok || echo "it was ${held:-nothing}")"

online || { fail machine online "no internet before any connect; nothing to prove"; exit 1; }
snapshot "$WORK/baseline"

# ---------------------------------------------------------------------
# The control: no tunnel, the same leak attempts. The capture must see
# each of them, or a clean capture under a tunnel would prove nothing.

leak_attempts "$WORK/control.pcap"
n=$(count "$WORK/control.pcap" "port 53")
judge control "a lookup at the local resolver is captured" "$([ "$n" -gt 0 ] && echo ok || echo "no port 53 packets seen")"
n=$(count "$WORK/control.pcap" "ip and tcp port 443")
judge control "a request out of the uplink is captured" "$([ "$n" -gt 0 ] && echo ok || echo "no packets seen")"
n=$(count "$WORK/control.pcap" "ip6 and not dst net ff00::/8 and not dst net fe80::/10 and not src net fe80::/10")
judge control "global IPv6 is captured" "$([ "$n" -gt 0 ] && echo ok || echo "no global IPv6 seen")"

# ---------------------------------------------------------------------
# Every protocol.

FILES=()
for f in "$PROFILES"/*.json; do [ -f "$f" ] && FILES+=("$f"); done
[ "${#FILES[@]}" -gt 0 ] || { fail machine profiles "none found"; exit 1; }

for i in "${!FILES[@]}"; do
  file=${FILES[$i]}
  eval "set -- $(py info "$file")"
  P=$1 SRV=$2 PORT=$3
  H=$(expected_health "$P")
  if [ -z "$SRV" ]; then fail "$P" profile "its server could not be resolved"; continue; fi
  arm_deadman

  # Connect.
  t0=$(ms)
  reply=$(ctl_file "$file")
  took=$(( $(ms) - t0 ))
  kind=$(echo "$reply" | py kind)
  if [ "$kind" != ok ]; then
    fail "$P" connect "the helper answered '$kind' after ${took} ms"
    disconnect
    continue
  fi
  pass "$P" "connect (${took} ms)"

  wait_status 15 '[ "$S_health" = "$H" ]'
  judge "$P" "status connected" "$([ "$S_connected" = true ] && echo ok || echo "connected is '$S_connected'")"
  judge "$P" "status protocol" "$([ "$S_protocol" = "$P" ] && echo ok || echo "it says '$S_protocol'")"
  judge "$P" "status health $H" "$([ "$S_health" = "$H" ] && echo ok || echo "health is '$S_health'")"
  judge "$P" "status ipv6_blocked" "$([ "$S_ipv6_blocked" = true ] && echo ok || echo "it is '$S_ipv6_blocked'")"
  judge "$P" "status ipv4_confined" "$([ "$S_ipv4_confined" = true ] && echo ok || echo "it is '$S_ipv4_confined'")"
  judge "$P" "status tunnel_dns_unprotected false" "$([ "$S_dns_unprotected" = false ] && echo ok || echo "it is '$S_dns_unprotected'")"

  code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' https://example.com 2>/dev/null)
  judge "$P" "a page loads" "$(echo "$code" | grep -qE '^(200|30[0-9])$' && echo ok || echo "HTTP '$code'")"

  exit_ip=$(curl -4 -s -m 10 https://1.1.1.1/cdn-cgi/trace 2>/dev/null | sed -n 's/^ip=//p')
  [ -n "$exit_ip" ] || exit_ip=$(curl -4 -s -m 10 https://api.ipify.org 2>/dev/null)
  if [ -z "$exit_ip" ]; then
    fail "$P" "exit address is the server's" "no answer from the address check"
  else
    judge "$P" "exit address is the server's" "$([ "$exit_ip" = "$SRV" ] && echo ok || echo "match: no")"
  fi
  unset exit_ip

  if command -v resolvectl >/dev/null 2>&1; then
    via=$(resolvectl query --cache=no example.com 2>/dev/null | sed -n 's/.*-- link: //p' | head -1)
    judge "$P" "names resolve through the tunnel" "$(case "$via" in neoconnect0|neoxify-wg|neoxify-ovpn) echo ok ;; '') echo "no answer" ;; *) echo "answered on another link" ;; esac)"
  else
    judge "$P" "names resolve" "$(getent hosts example.com >/dev/null && echo ok || echo "no answer")"
  fi

  status
  judge "$P" "status counts traffic" "$([ "${S_rx:-0}" -gt 0 ] 2>/dev/null && [ "${S_tx:-0}" -gt 0 ] 2>/dev/null && echo ok || echo "rx '$S_rx' tx '$S_tx'")"

  # The wire.
  cap="$WORK/$P.pcap"
  leak_attempts "$cap"
  judge "$P" "page loads during the leak attempts" "$([ "$L_PAGE" = ok ] && echo ok || echo "it did not")"
  judge "$P" "lookups at the local resolver get no answer" "$([ "$L_DIG" = 0 ] && echo ok || echo "$L_DIG answered")"
  judge "$P" "a request forced out of the uplink fails" "$([ "$L_IFACE" = fail ] && echo ok || echo "it succeeded")"
  judge "$P" "IPv6 fails" "$([ "$L_V6" = fail ] && echo ok || echo "it succeeded")"
  allowed=$(allowed_filter "$P" "$SRV" "$PORT")
  n53=$(count "$cap" "port 53 and not ($allowed)")
  n4=$(count "$cap" "ip and not ($allowed)")
  n6=$(count "$cap" "ip6 and not ($allowed)")
  engine=$(count "$cap" "host $SRV and port $PORT")
  judge "$P" "capture: no DNS on the uplink" "$([ "$n53" = 0 ] && echo ok || echo "$n53 packets")"
  judge "$P" "capture: no other IPv4 on the uplink" "$([ "$n4" = 0 ] && echo ok || echo "$n4 packets")"
  judge "$P" "capture: no global IPv6 on the uplink" "$([ "$n6" = 0 ] && echo ok || echo "$n6 packets")"
  judge "$P" "capture: the engine's own traffic is seen" "$([ "$engine" -gt 0 ] && echo ok || echo "none, so the capture saw nothing")"

  # Disconnect, and the machine is as it was.
  reply=$(ctl '{"type":"disconnect"}')
  judge "$P" "disconnect" "$(echo "$reply" | grep -q '"status":"ok"' && echo ok || echo "the helper did not say ok")"
  sleep 1
  judge "$P" "after disconnect: as before" "$(same_as_baseline)"
  judge "$P" "after disconnect: online" "$(wait_online && echo ok || echo "no page")"

  # ---- Failure paths.

  # The engine dies: the helper notices, takes the table down, and the
  # machine is back on its own network.
  if [ "$(ctl_file "$file" | py kind)" = ok ]; then
    wait_status 15 '[ "$S_health" = "$H" ]'
    kill_engine "$P"
    t0=$(ms)
    if wait_status 10 '[ "$S_connected" != true ] || [ "$S_health" = down ]'; then
      pass "$P" "engine killed: status reports the drop ($(( $(ms) - t0 )) ms)"
    else
      fail "$P" "engine killed: status reports the drop" "still '$S_connected' / '$S_health' after 10 s"
    fi
    for _ in $(seq 1 20); do table_gone && break; sleep 0.5; done
    judge "$P" "engine killed: table gone" "$(table_gone && echo ok || echo "it is still loaded")"
    judge "$P" "engine killed: online without it" "$(wait_online && echo ok || echo "no page")"
    sleep 2
    judge "$P" "engine killed: nothing left" "$(same_as_baseline)"
    disconnect
  else
    fail "$P" "engine killed" "the connect before it failed"
  fi

  # The helper is killed outright: systemd restarts it, the sweep clears
  # the tunnel, and the time without internet is measured.
  if [ "$(ctl_file "$file" | py kind)" = ok ]; then
    wait_status 15 '[ "$S_health" = "$H" ]'
    old=$(systemctl show -p MainPID --value "$UNIT")
    probe="$WORK/probe"
    ( while :; do
        if curl -s -m 1 -o /dev/null https://1.1.1.1/cdn-cgi/trace 2>/dev/null; then echo "$(ms) 0"; else echo "$(ms) 1"; fi
        sleep 0.2
      done ) > "$probe" &
    pr=$!
    BG_PIDS+=("$pr")
    sleep 1
    t0=$(ms)
    kill -KILL "$old" 2>/dev/null
    back=""
    for _ in $(seq 1 60); do
      new=$(systemctl show -p MainPID --value "$UNIT")
      if [ "$new" != 0 ] && [ "$new" != "$old" ] && systemctl is-active --quiet "$UNIT"; then back=$(( $(ms) - t0 )); break; fi
      sleep 0.25
    done
    wait_helper >/dev/null
    sleep 4
    kill "$pr" 2>/dev/null
    wait "$pr" 2>/dev/null
    offline=$(awk -v t0="$t0" '$1 >= t0 { if ($2 == 1) { if (!s) s = $1 } else if (s) { d = $1 - s; if (d > m) m = d; s = 0 } } END { if (s) print "never back"; else print m + 0 }' "$probe")
    if [ -n "$back" ]; then pass "$P" "helper killed: restarted (${back} ms)"; else fail "$P" "helper killed: restarted" "not within 15 s"; fi
    judge "$P" "helper killed: internet back" "$([ "$offline" != "never back" ] && echo ok || echo "it never came back")"
    [ "$offline" != "never back" ] && echo "INFO $P helper killed: longest time without internet ${offline} ms"
    status
    judge "$P" "helper killed: not connected after restart" "$([ "$S_connected" != true ] && echo ok || echo "it says connected")"
    judge "$P" "helper killed: table gone" "$(table_gone && echo ok || echo "it is still loaded")"
    judge "$P" "helper killed: nothing left" "$(same_as_baseline)"
  else
    fail "$P" "helper killed" "the connect before it failed"
  fi

  # The unit is stopped while connected.
  if [ "$(ctl_file "$file" | py kind)" = ok ]; then
    wait_status 15 '[ "$S_health" = "$H" ]'
    systemctl stop "$UNIT"
    judge "$P" "unit stopped: nothing left" "$(same_as_baseline)"
    judge "$P" "unit stopped: online" "$(wait_online && echo ok || echo "no page")"
    systemctl start "$UNIT"
    judge "$P" "unit started again" "$(wait_helper && echo ok || echo "the helper did not answer")"
  else
    fail "$P" "unit stopped" "the connect before it failed"
  fi

  # A second connect, with the next protocol, on top of the first.
  other=${FILES[$(( (i + 1) % ${#FILES[@]} ))]}
  eval "set -- $(py info "$other")"
  Q=$1 QSRV=$2 QH=$(expected_health "$1")
  if [ "$(ctl_file "$file" | py kind)" = ok ]; then
    wait_status 15 '[ "$S_health" = "$H" ]'
    kind=$(ctl_file "$other" | py kind)
    if [ "$kind" = ok ]; then
      wait_status 15 '[ "$S_health" = "$QH" ]'
      judge "$P" "second connect ($Q): status" "$([ "$S_protocol" = "$Q" ] && [ "$S_connected" = true ] && echo ok || echo "it says '$S_protocol' connected '$S_connected'")"
      links=$(ip -br link | awk '$1 ~ /^(neoconnect0|neoxify-wg|neoxify-ovpn)(@|$)/' | wc -l)
      judge "$P" "second connect ($Q): one tunnel interface" "$([ "$links" = 1 ] && echo ok || echo "$links")"
      exit_ip=$(curl -4 -s -m 10 https://1.1.1.1/cdn-cgi/trace 2>/dev/null | sed -n 's/^ip=//p')
      judge "$P" "second connect ($Q): exit address is its server's" "$([ -n "$exit_ip" ] && [ "$exit_ip" = "$QSRV" ] && echo ok || echo "match: no")"
      unset exit_ip
    else
      fail "$P" "second connect ($Q)" "the helper answered '$kind'"
    fi
    disconnect
    sleep 1
    judge "$P" "second connect ($Q): nothing left after disconnect" "$(same_as_baseline)"
  else
    fail "$P" "second connect" "the first connect failed"
  fi

  # A server that does not exist.
  py dead "$file" "$WORK/dead.json" "$DEAD"
  t0=$(ms)
  kind=$(ctl_file "$WORK/dead.json" | py kind)
  took=$(( $(ms) - t0 ))
  rm -f "$WORK/dead.json"
  if [ "$kind" = serverUnreachable ] && [ "$took" -le 45000 ]; then
    pass "$P" "dead server: refused as unreachable (${took} ms)"
  elif [ "$kind" = ok ]; then
    # WireGuard has no answer to wait for at connect (as on Windows); the
    # interface learns from health, which must then never say alive.
    sleep 6
    status
    judge "$P" "dead server: health is not alive" "$([ "$S_health" != alive ] && echo ok || echo "health says alive")"
    [ "$S_health" != alive ] && echo "INFO $P dead server: connect said ok; health '$S_health' after 6 s"
  else
    fail "$P" "dead server" "answered '$kind' after ${took} ms"
  fi
  disconnect
  sleep 1
  judge "$P" "dead server: nothing left" "$(same_as_baseline)"
done
