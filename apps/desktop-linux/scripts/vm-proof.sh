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
# After the protocols come the parts that are not per protocol: the
# reconnect hold (with a steady stream from an ordinary program and a
# capture as the judge), the uplink going away under a session, IKEv2's
# failure sentences, Repair, and the Linux-only requests. NX_PROOF_PARTS
# picks some of them (default: all, in this order), and NX_PROOF_ONLY
# limits the protocols to the profiles whose file names contain it:
#
#   sudo NX_PROOF_PARTS="hold repair" bash vm-proof.sh /home/nx/profiles
#
# The uplink part takes the uplink down for a few seconds. Over SSH, which
# rides that link, run the script detached so it is not cut off with it:
#
#   sudo systemd-run --unit=nx-proof --collect -p StandardOutput=file:/root/nx-proof.log \
#     -p StandardError=file:/root/nx-proof.log bash vm-proof.sh /home/nx/profiles
#
# What a pass does not prove: anything about a censored network, a real
# IPv6 path (the made-up IPv6 below only shows nothing would be sent),
# or a desktop session; the app itself is not driven here.
set -u
umask 077

PARTS=${NX_PROOF_PARTS:-"protocols hold uplink ikev2 repair linux"}
ONLY=${NX_PROOF_ONLY:-}
want() { case " $PARTS " in *" $1 "*) return 0 ;; esac; return 1; }

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
DEAD_NAME=nx-proof-dead.example.com
HOSTS_MARK="# nx-proof dead server"

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
    if "server" in profile:
        # IKEv2 names only its server: charon-cmd starts on UDP 500 and
        # moves to 4500, where the rest of the session runs behind NAT.
        return profile["server"], 4500
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
    elif "server" in p:
        # IKEv2 takes a name only (the certificate is checked against it),
        # so the dead server is a name that /etc/hosts points at $DEAD.
        p["server"] = sys.argv[5]
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
    h = s.get("reconnect_hold") or {}
    out.update({
        "hold": h.get("state", ""),
        "hold_landed": str(h.get("landed", False)).lower(),
        "hold_problem": h.get("problem", ""),
        "hold_detail": h.get("detail") or "",
    })
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
elif cmd == "servers":
    # Every IPv4 address the hold may name for this request: the server it
    # dials and the literals among known_nodes. Space-separated.
    req = json.load(open(sys.argv[2]))
    host, _ = server(req["profile"])
    out = {literal(host)}
    for n in req.get("known_nodes", []):
        try:
            out.add(str(ipaddress.IPv4Address(str(n).strip())))
        except ValueError:
            pass
    print(" ".join(sorted(o for o in out if o)))
elif cmd == "with":
    # A copy of a connect request with one thing changed.
    req = json.load(open(sys.argv[2]))
    if sys.argv[4] == "block":
        req["block_while_reconnecting"] = sys.argv[5] == "true"
    elif sys.argv[4] == "password":
        req["profile"]["password"] = sys.argv[5]
    with open(sys.argv[3], "w") as f:
        json.dump(req, f)
elif cmd == "message":
    # The message of an error reply, or "" for anything else.
    try:
        s = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        s = {}
    print(s.get("message", "") if s.get("status") == "error" else "")
elif cmd == "field":
    # One field of a reply, by a dotted path; lists are joined with commas.
    try:
        v = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        v = {}
    for k in sys.argv[2].split("."):
        v = v.get(k) if isinstance(v, dict) else None
    if isinstance(v, list):
        print(",".join(json.dumps(x, sort_keys=True) if isinstance(x, dict) else str(x) for x in v))
    elif isinstance(v, bool):
        print(str(v).lower())
    else:
        print("" if v is None else v)
elif cmd == "repair":
    # A repair report as "id=outcome" words, in order.
    try:
        s = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        s = {}
    steps = (s.get("report") or {}).get("steps") or []
    print(" ".join(f'{st.get("id")}={st.get("outcome")}' for st in steps) or "none")
elif cmd == "stream":
    # An ordinary program talking all the time, to addresses of our own
    # choosing that nothing answers (documentation ranges) and to two
    # public resolvers directly: a TCP connect and UDP datagrams over both
    # families every 0.1 s. A packet of it on the uplink is a leak whenever
    # a tunnel or the hold is in force. Prints how many rounds it sent.
    import signal, time
    end = time.time() + float(sys.argv[2])
    # Rounds sent, and the longest pause between two (a round that blocks
    # would leave a gap in what the capture is judging).
    sent = [0, 0.0, time.time()]
    def stop(*_):
        print(sent[0], round(sent[1], 1), flush=True)
        sys.exit(0)
    signal.signal(signal.SIGTERM, stop)
    query = bytes.fromhex("abcd01000001000000000000076578616d706c6503636f6d0000010001")
    tcp = [(socket.AF_INET, ("198.51.100.20", 443)), (socket.AF_INET6, ("2001:db8:99::20", 443))]
    udp = [(socket.AF_INET, ("198.51.100.20", 9999), b"nx-proof"), (socket.AF_INET6, ("2001:db8:99::20", 9999), b"nx-proof"),
           (socket.AF_INET, ("198.51.100.53", 53), query), (socket.AF_INET, ("1.1.1.1", 53), query), (socket.AF_INET, ("8.8.8.8", 53), query)]
    while time.time() < end:
        for fam, addr in tcp:
            try:
                t = socket.socket(fam, socket.SOCK_STREAM)
                t.setblocking(False)
                t.connect_ex(addr)
                t.close()
            except OSError:
                pass
        for fam, addr, data in udp:
            try:
                u = socket.socket(fam, socket.SOCK_DGRAM)
                u.sendto(data, addr)
                u.close()
            except OSError:
                pass
        sent[0] += 1
        now = time.time()
        sent[1] = max(sent[1], now - sent[2])
        sent[2] = now
        time.sleep(0.1)
    stop()
elif cmd == "app":
    # Stands in for the app: run from an executable the development
    # allow-list names, so the helper judges it as the app. Sends its first
    # request, prints the reply, then (unless the FIFO is "-") does what each
    # line written to the FIFO says: "req <json>" sends one more request,
    # "curl" fetches a page as a child of this process -- in whatever
    # control group the helper put it -- and "quit" ends it.
    import subprocess
    sock_path, fifo, first = sys.argv[2], sys.argv[3], sys.argv[4]
    def ask(line):
        try:
            s = socket.socket(socket.AF_UNIX)
            s.settimeout(60)
            s.connect(sock_path)
            s.sendall(line.encode() + b"\n")
            r = s.makefile().readline().strip()
            s.close()
            return r or "{}"
        except OSError:
            return "{}"
    print("reply " + ask(first), flush=True)
    if fifo == "-":
        sys.exit()
    while True:
        with open(fifo) as f:
            for line in f:
                line = line.strip()
                if line == "quit":
                    sys.exit()
                if line == "curl":
                    # 1.0.0.1, which nothing else here asks, so the
                    # capture can tell the app's own request apart.
                    r = subprocess.run(["curl", "-4", "-s", "-m", "6", "-o", "/dev/null", "-w", "%{http_code}", "https://1.0.0.1/cdn-cgi/trace"],
                                       capture_output=True, text=True)
                    print("curl " + (r.stdout.strip() or "000"), flush=True)
                elif line.startswith("req "):
                    print("reply " + ask(line[4:]), flush=True)
elif cmd == "badsig":
    # A signature in the updater's form that is not a good one: base64 of a
    # minisign signature file. "otherkey": a key id that is not the
    # updater's. "rightkey": the updater's key id (read from its public key,
    # argv[3]) over random bytes, so only the check of the file can refuse it.
    import base64, os
    keyid = os.urandom(8)
    if sys.argv[2] == "rightkey":
        text = base64.b64decode(open(sys.argv[3]).read().strip()).decode()
        line = [l for l in text.splitlines() if l and not l.startswith("untrusted comment")][0]
        keyid = base64.b64decode(line)[2:10]
    sig = base64.b64encode(b"ED" + keyid + os.urandom(64)).decode()
    glob = base64.b64encode(os.urandom(64)).decode()
    body = f"untrusted comment: nx-proof\n{sig}\ntrusted comment: timestamp:0\tfile:nx-proof\n{glob}\n"
    print(base64.b64encode(body.encode()).decode())
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
    # NetworkManager adds 20000 to the uplink's route metric when its own
    # connectivity check fails, which it does while our table refuses its
    # plain HTTP, and takes it off at its next check (every five minutes).
    # Asked to check now, it puts the metric back if the network is fine.
    if [ "$try" = 3 ] && [ -z "$(echo "$parts" | tr ' ' '\n' | grep -vE '^(routes4|routes6)?$')" ] && command -v nmcli >/dev/null 2>&1; then
      nmcli networking connectivity check >/dev/null 2>&1
    fi
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
# resolvers on the local network the uplink was handed. A public
# resolver the uplink was handed is left out: under a full tunnel a lookup
# at it is routed into the tunnel and may be answered there (Xray answers
# port 53 itself), which is not a leak; the capture is what would show one.
RESOLVERS="$GW"
case "$GW" in 10.0.2.2) RESOLVERS="$RESOLVERS 10.0.2.3" ;; esac
if command -v resolvectl >/dev/null 2>&1; then
  for r in $(resolvectl dns "$UPLINK" 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+(\.[0-9]+){3}$' \
      | grep -E '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)'); do
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
# off the link. Also anything to a link-scope multicast group (224.0.0.0/24,
# ff02::/16), from any source address: leak protection leaves multicast
# open on purpose, as Windows does, and these groups are never forwarded
# off the link. On a desktop install avahi's mDNS announcements are such
# traffic, sent from the global IPv6 address as well as the link-local one.
# $2/$3: the server and its port.
allowed_filter() {
  local engine="host $2 and port $3"
  # IKEv2 speaks to its server on two ports (500, then 4500), and ESP
  # would go bare if no NAT were in the way.
  [ "$1" = IKEV2 ] && engine="host $2 and (udp port 500 or udp port 4500 or ip proto 50)"
  echo "($engine) or src host $2 or arp or (udp and (port 67 or port 68)) or (tcp port 22 and net $LANNET) or (ip6 and src net fe80::/10 and (dst net fe80::/10 or dst net ff00::/8)) or (ip and dst net 224.0.0.0/24) or (ip6 and dst net ff02::/16) or (icmp6 and ip6[7] = 255 and ip6[40] >= 133 and ip6[40] <= 137)"
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
    IKEV2) pkill -KILL -x charon-cmd ;;
    *) pkill -KILL -f '^/usr/lib/neoxify/xray' ;;
  esac
}

# Everything the later parts change outside what the helper sweeps, put
# back by one script that both the dead-man and the normal end run: the
# uplink brought back, programs moved aside put back, the development
# allow-list and the test user removed, our stand-ins killed. It lives
# outside $WORK so the dead-man can still run it after this script is gone.
RESTORE=/run/nx-proof-restore.sh
ASIDE=nx-proof-aside
DEVCONF=/etc/neoxify/helper.json
FAKEAPP_DIR=/usr/local/lib/nx-proof
AWAY_USER=nxproofaway
cat > "$RESTORE" <<EOF
#!/bin/sh
for f in /usr/sbin/charon-cmd /usr/sbin/nft /usr/lib/ipsec/plugins/libstrongswan-kernel-libipsec.so /usr/lib64/strongswan/plugins/libstrongswan-kernel-libipsec.so; do
  [ -e "\$f.$ASIDE" ] && mv -f "\$f.$ASIDE" "\$f"
done
ip link set $UPLINK up 2>/dev/null
command -v nmcli >/dev/null 2>&1 && nmcli device connect $UPLINK >/dev/null 2>&1
rm -f $DEVCONF; rmdir /etc/neoxify 2>/dev/null
pkill -KILL -f '^$FAKEAPP_DIR/' 2>/dev/null
pkill -KILL -f 'nx-proof-sleeper' 2>/dev/null
pkill -KILL -f 'nx-proof-orphan' 2>/dev/null
id $AWAY_USER >/dev/null 2>&1 && userdel $AWAY_USER >/dev/null 2>&1
ip rule del pref 28278 table main suppress_prefixlength 0 2>/dev/null
ip rule del pref 28279 not fwmark 28280 table 28280 2>/dev/null
ip route del 192.0.2.77/32 proto 98 2>/dev/null
sed -i '/$HOSTS_MARK\$/d' /etc/hosts
ip -6 route del default via $FAKE6_GW dev $UPLINK metric 1 2>/dev/null
ip -6 neigh del $FAKE6_GW dev $UPLINK 2>/dev/null
ip -6 addr del $FAKE6/64 dev $UPLINK 2>/dev/null
command -v resolvectl >/dev/null 2>&1 && resolvectl revert neoconnect0 2>/dev/null
rm -rf /home/nx/.cache/nx-proof
exit 0
EOF
# Run with sh: /run is mounted noexec.
chmod 0600 "$RESTORE"

arm_deadman() {
  systemctl stop "$DEADMAN.timer" "$DEADMAN.service" >/dev/null 2>&1
  systemctl reset-failed "$DEADMAN.timer" "$DEADMAN.service" >/dev/null 2>&1
  systemd-run --quiet --unit="$DEADMAN" --on-active="${1:-300}" /bin/sh -c \
    "sh $RESTORE; systemctl stop $UNIT; pkill -KILL -x charon-cmd; $HELPER sweep; nft delete table inet neoxify; nft delete table inet neoxify_split; systemctl start $UNIT" \
    >/dev/null 2>&1
}

finish() {
  local rc
  trap - EXIT INT TERM
  for p in "${BG_PIDS[@]}"; do kill "$p" 2>/dev/null; done
  fake_ipv6_off
  [ -f "$DEVCONF" ] && devconf=1 || devconf=0
  sh "$RESTORE"
  rm -rf "$FAKEAPP_DIR"
  # The helper read the development allow-list at its start: one started
  # with it is restarted without it.
  [ "$devconf" = 1 ] && systemctl restart "$UNIT" >/dev/null 2>&1
  systemctl is-active --quiet "$UNIT" || systemctl start "$UNIT" >/dev/null 2>&1
  wait_helper >/dev/null
  disconnect
  sleep 1
  systemctl stop "$DEADMAN.timer" "$DEADMAN.service" >/dev/null 2>&1
  if [ -d "$WORK/baseline" ]; then
    rc=$(same_as_baseline)
    judge machine "left as found" "$rc"
  fi
  rm -rf "$WORK" "$RESTORE"
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
for f in "$PROFILES"/*.json; do
  [ -f "$f" ] || continue
  case "$(basename "$f")" in *"$ONLY"*) FILES+=("$f") ;; esac
done
[ "${#FILES[@]}" -gt 0 ] || { fail machine profiles "none found"; exit 1; }

# The request for a protocol, by the name the status gives it.
profile_of() {
  local f wanted=$1
  for f in "$PROFILES"/*.json; do
    [ -f "$f" ] || continue
    eval "set -- $(py info "$f")"
    [ "$1" = "$wanted" ] && { echo "$f"; return 0; }
  done
  return 1
}

# The per-protocol proof. Not re-indented, to keep the history readable.
if want protocols; then
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
    judge "$P" "names resolve through the tunnel" "$(case "$via" in neoconnect0|neoxify-wg|neoxify-ovpn|ipsec[0-9]*) echo ok ;; '') echo "no answer" ;; *) echo "answered on another link" ;; esac)"
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
      links=$(ip -br link | awk '$1 ~ /^(neoconnect0|neoxify-wg|neoxify-ovpn|ipsec[0-9]+)(@|$)/' | wc -l)
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
  py dead "$file" "$WORK/dead.json" "$DEAD" "$DEAD_NAME"
  [ "$P" = IKEV2 ] && echo "$DEAD $DEAD_NAME $HOSTS_MARK" >> /etc/hosts
  t0=$(ms)
  kind=$(ctl_file "$WORK/dead.json" | py kind)
  took=$(( $(ms) - t0 ))
  sed -i "/$HOSTS_MARK\$/d" /etc/hosts
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
fi

# ---------------------------------------------------------------------
# Shared by the parts below.

# The machine's own resolvers, read now with no tunnel up: the only
# lookups the hold lets out of the uplink.
MACHINE_RESOLVERS=$(resolvectl dns 2>/dev/null | sed 's/^[^:]*://' | tr ' ' '\n' | grep -E '^[0-9a-fA-F:.]+$' | grep -E '[.:]' | sort -u | tr '\n' ' ')

# The stream's packets (`py stream`), as a capture filter. A public
# resolver that is one of the machine's own is left out: the hold lets
# lookups to it through, on purpose.
STREAM_FILTER="dst host 198.51.100.20 or dst host 2001:db8:99::20 or dst host 198.51.100.53"
for r in 1.1.1.1 8.8.8.8; do
  case " $MACHINE_RESOLVERS " in *" $r "*) ;; *) STREAM_FILTER="$STREAM_FILTER or (dst port 53 and dst host $r)" ;; esac
done

# Everything the capture may hold while the hold is in force, as the hold
# itself names it: our servers on any port, lookups to the machine's own
# resolvers, DHCP, the LAN, ARP and the link's own IPv6 and multicast
# housekeeping (as allowed_filter above), and the stand-in app's own
# request, which goes to 1.0.0.1 and nowhere else. $1: the servers.
hold_allowed() {
  local ip s="" d=""
  for ip in $1; do s="$s or host $ip"; done
  for ip in $MACHINE_RESOLVERS; do d="$d or host $ip"; done
  [ -n "$d" ] || d=" or host 192.0.2.254"
  echo "(${s# or }) or host 1.0.0.1 or (port 53 and (${d# or })) or arp or (udp and (port 67 or port 68)) or (ip and net $LANNET) or (ip6 and src net fe80::/10 and (dst net fe80::/10 or dst net ff00::/8)) or (ip and dst net 224.0.0.0/24) or (ip6 and dst net ff02::/16) or (icmp6 and ip6[7] = 255 and ip6[40] >= 133 and ip6[40] <= 137)"
}

# A capture on the uplink that survives the uplink going away: tcpdump
# ends when its device does, so it is started again, into the next file.
# Outgoing packets only: what the hold is judged on is what leaves. An
# incoming one is no leak, and VirtualBox's NAT answers an IPv6 SYN with a
# reset some 20 s later, so the control's own SYNs come back in the middle
# of the next run (seen: RSTs to the control's ports, win 65535, from the
# NAT's MAC).
cap_start() {
  CAP=$1
  ( n=0; while :; do tcpdump -ni "$UPLINK" -Q out -U -s 128 -w "$CAP.$n.pcap" >/dev/null 2>&1; n=$((n + 1)); sleep 0.2; done ) &
  CAP_LOOP=$!
  BG_PIDS+=("$CAP_LOOP")
  sleep 1.5
}
cap_stop() {
  sleep 1
  kill "$CAP_LOOP" 2>/dev/null
  wait "$CAP_LOOP" 2>/dev/null
  pkill -f "tcpdump -ni $UPLINK -Q out -U -s 128 -w $CAP" 2>/dev/null
  sleep 0.5
}
capcount() {
  local f n=0 c
  for f in "$1".*.pcap; do
    [ -f "$f" ] || continue
    c=$(tcpdump -nr "$f" "$2" 2>/dev/null | wc -l)
    n=$((n + c))
  done
  echo "$n"
}
# A moment in a run, by name, so a packet the capture should not hold can
# be placed: "drop:3" is three such packets between the drop and the next
# mark.
mark() { echo "$(date +%s.%N) $1" >> "$PH"; }
by_phase() {
  captimes "$1" "$2" | awk -v pf="$3" '
    BEGIN { while ((getline l < pf) > 0) { split(l, a, " "); n++; t[n] = a[1]; lab[n] = a[2] } }
    { p = "before-" lab[1]; for (i = 1; i <= n; i++) if ($1 >= t[i]) p = lab[i]; c[p]++ }
    END { for (k in c) printf "%s:%d ", k, c[k] }'
}
# What those packets were, without an address of ours: the protocol, the
# destination port, and the destination only when it is one this script
# chose (documentation ranges, the public resolvers, 1.0.0.1).
what_left() {
  local f
  for f in "$1".*.pcap; do [ -f "$f" ] && tcpdump -nr "$f" "$2" 2>/dev/null; done | awk '
    { proto = ($2 == "IP6") ? "v6" : "v4"; dst = $5; sub(/:$/, "", dst)
      n = split(dst, p, "."); port = p[n]; host = dst; sub("\\." port "$", "", host)
      if (host !~ /^(198\.51\.100\.|2001:db8:|1\.1\.1\.1$|8\.8\.8\.8$|1\.0\.0\.1$|192\.0\.2\.)/) host = "elsewhere"
      k = proto " " host " port " port; c[k]++ }
    END { for (k in c) printf "%s x%d, ", k, c[k] }' | cut -c1-400
  # NX_PROOF_DEBUG=1: the first few in full, with every address that is
  # not one this script chose replaced.
  if [ "${NX_PROOF_DEBUG:-}" = 1 ]; then
    for f in "$1".*.pcap; do [ -f "$f" ] && tcpdump -tt -nr "$f" "$2" 2>/dev/null; done | head -8 | python3 -I -c '
import re, sys
mine = re.compile(r"^(198\.51\.100\.|2001:db8:|1\.1\.1\.1$|8\.8\.8\.8$|1\.0\.0\.1$|192\.0\.2\.|10\.0\.2\.|fe80:)")
def mask(m):
    a = m.group(0)
    host = a.rsplit(".", 1)[0] if a.count(".") in (1, 4) else a
    return a if mine.match(host) or mine.match(a) else "ADDR"
for line in sys.stdin:
    print("  DEBUG", re.sub(r"[0-9a-fA-F:]*:[0-9a-fA-F:]+(\.\d+)?|\d+\.\d+\.\d+\.\d+(\.\d+)?", mask, line.strip())[:200])'
  fi
}
# The capture times of matching packets, one per line, in order.
captimes() {
  local f
  for f in "$1".*.pcap; do [ -f "$f" ] && tcpdump -tt -nr "$f" "$2" 2>/dev/null | awk '{print $1}'; done | sort -n
}

stream_start() {
  runuser -u nx -- python3 -I - stream "$1" < "$WORK/j.py" > "$WORK/stream.out" 2>/dev/null &
  STREAM_PID=$!
  BG_PIDS+=("$STREAM_PID")
}
stream_stop() {
  pkill -TERM -u nx -f 'python3 -I - stream' 2>/dev/null
  wait "$STREAM_PID" 2>/dev/null
  read -r STREAM_ROUNDS STREAM_GAP < "$WORK/stream.out" 2>/dev/null
}

# Which of our two contents the table has now.
held_table() {
  if table_gone; then echo none
  elif nft list table inet neoxify 2>/dev/null | grep -q 'nx:hold'; then echo hold
  else echo confinement; fi
}
# Whether an ordinary program (the desktop user's curl) reaches the
# internet now.
ordinary_out() {
  runuser -u nx -- curl -4 -s -m 5 -o /dev/null -w '%{http_code}' https://1.1.1.1/cdn-cgi/trace 2>/dev/null | grep -qE '^(200|30[0-9])$' && echo out || echo blocked
}
exit_is() {
  local ip
  ip=$(curl -4 -s -m 10 https://1.1.1.1/cdn-cgi/trace 2>/dev/null | sed -n 's/^ip=//p')
  [ -n "$ip" ] && [ "$ip" = "$1" ] && echo ok || echo "match: no"
}

# The stand-in app (`py app`), run from an executable the development
# allow-list names. The helper reads that list when it starts, so it is
# restarted with it once and without it at the end.
devconf_on() {
  install -d -m 0755 "$FAKEAPP_DIR"
  install -m 0755 "$(readlink -f "$(command -v python3)")" "$FAKEAPP_DIR/nxapp"
  install -d -m 0755 /etc/neoxify
  printf '{"allowed_clients":["%s/nxapp"]}\n' "$FAKEAPP_DIR" > "$DEVCONF"
  chmod 0644 "$DEVCONF"
  systemctl restart "$UNIT"
  wait_helper
}
app_start() {
  APP_FIFO=$WORK/app.fifo
  APP_OUT=$WORK/app.out
  rm -f "$APP_FIFO"
  mkfifo -m 0600 "$APP_FIFO"
  : > "$APP_OUT"
  "$FAKEAPP_DIR/nxapp" -I - app /run/neoxify/helper.sock "$APP_FIFO" "$1" < "$WORK/j.py" >> "$APP_OUT" 2>/dev/null &
  APP_PID=$!
  BG_PIDS+=("$APP_PID")
  for _ in $(seq 1 100); do [ -s "$APP_OUT" ] && break; sleep 0.1; done
  APP_FIRST=$(head -1 "$APP_OUT")
}
app_do() {
  local before
  before=$(wc -l < "$APP_OUT")
  timeout 5 sh -c 'echo "$1" > "$2"' _ "$1" "$APP_FIFO" || { echo "no app"; return; }
  for _ in $(seq 1 150); do [ "$(wc -l < "$APP_OUT")" -gt "$before" ] && break; sleep 0.1; done
  sed -n "$((before + 1))p" "$APP_OUT"
}

# Connects with the hold wanted and drops the tunnel as life does. True
# when the status then says it holds.
up_and_drop() {
  local P=$1 HF=$2 H
  H=$(expected_health "$P")
  [ "$(ctl_file "$HF" | py kind)" = ok ] || return 1
  wait_status 15 '[ "$S_health" = "$H" ] && [ "$S_hold" = armed ]' || return 1
  kill_engine "$P"
  wait_status 10 '[ "$S_hold" = holding ] && [ "$S_connected" != true ]'
}

released_cleanly() {
  status
  if [ -n "$S_hold" ]; then echo "the status still says '$S_hold'"
  elif ! table_gone; then echo "the table is still in ($(held_table))"
  elif ! wait_online; then echo "no page"
  else echo ok; fi
}

# ---------------------------------------------------------------------
# The reconnect hold, for the engines it covers, as a full tunnel.

if want hold; then
  devconf_on
  app_start '{"type":"setReconnectHold","enabled":true}'; r=$APP_FIRST
  judge hold "the stand-in app is served as the app" "$(echo "$r" | grep -q '"status":"ok"' && echo ok || echo "it was answered '${r#reply }'")"
  grp=$(cat "/proc/$APP_PID/cgroup" 2>/dev/null)
  judge hold "the helper put the app in its group" "$(echo "$grp" | grep -q 'neoxify.app' && echo ok || echo "it is in '$grp'")"
  ctl '{"type":"setReconnectHold","enabled":false}' >/dev/null

  # The control: the same stream with nothing of ours in force reaches
  # the uplink, or a clean capture below would prove nothing.
  fake_ipv6_on
  cap_start "$WORK/stream-control"
  stream_start 5
  sleep 6
  stream_stop
  cap_stop
  fake_ipv6_off
  for what in "ip and tcp and dst host 198.51.100.20" "ip and udp and dst host 198.51.100.20" "ip6 and dst host 2001:db8:99::20" "udp and dst port 53 and not dst host 198.51.100.53"; do
    n=$(capcount "$WORK/stream-control" "$what")
    judge control "the stream is captured ($what)" "$([ "$n" -gt 0 ] && echo ok || echo "none seen")"
  done
  rm -f "$WORK"/stream-control.*

  for P in ${NX_PROOF_HOLD:-XRAY_VLESS_REALITY WIREGUARD OPENVPN}; do
    file=$(profile_of "$P") || { fail "$P" hold "no profile"; continue; }
    eval "set -- $(py info "$file")"
    SRV=$2
    H=$(expected_health "$P")
    HF=$WORK/hold-$P.json
    py with "$file" "$HF" block true
    allowed=$(hold_allowed "$(py servers "$HF")")
    arm_deadman 600
    PH=$WORK/phases-$P
    : > "$PH"
    if [ "$(ctl_file "$HF" | py kind)" != ok ]; then
      fail "$P" "hold: connect" "it failed"
      disconnect; continue
    fi
    wait_status 15 '[ "$S_health" = "$H" ] && [ "$S_hold" = armed ]'
    judge "$P" "hold: armed after the connect" "$([ "$S_hold" = armed ] && echo ok || echo "the status says '$S_hold'")"
    # The capture and the stream start with the tunnel up: before it,
    # the stream going out of the uplink is simply the machine online.
    fake_ipv6_on
    cap_start "$WORK/hold-$P"
    mark tunnel-up
    stream_start 900
    sleep 2

    # The drop, as it comes in life: the engine dies (WireGuard has no
    # process; to the helper its drop is the link going).
    mark drop
    kill_engine "$P"
    t0=$(ms)
    if wait_status 10 '[ "$S_hold" = holding ] && [ "$S_connected" != true ]'; then
      pass "$P" "hold: the drop is held, and said ($(( $(ms) - t0 )) ms)"
    else
      fail "$P" "hold: the drop is held, and said" "the status says '$S_hold', connected '$S_connected'"
    fi
    judge "$P" "hold: the table in force is the hold's" "$([ "$(held_table)" = hold ] && echo ok || echo "it is $(held_table)")"
    judge "$P" "hold: an ordinary program cannot get out" "$([ "$(ordinary_out)" = blocked ] && echo ok || echo "it got out")"
    r=$(app_do curl)
    judge "$P" "hold: a program in the app's group gets out" "$(echo "$r" | grep -qE '^curl (200|30[0-9])$' && echo ok || echo "it got '$r'")"
    judge "$P" "hold: the same program outside the group cannot" "$(curl -4 -s -m 5 -o /dev/null https://1.0.0.1/cdn-cgi/trace 2>/dev/null && echo "it got out" || echo ok)"
    sleep 3

    # The app reconnects under the hold, lands, and lets go.
    mark reconnect
    kind=$(ctl_file "$HF" | py kind)
    judge "$P" "hold: a connect under the hold" "$([ "$kind" = ok ] && echo ok || echo "it answered '$kind'")"
    wait_status 15 '[ "$S_hold" = holding ] && [ "$S_hold_landed" = true ] && [ "$S_connected" = true ]'
    judge "$P" "hold: landed, and said" "$([ "$S_hold_landed" = true ] && [ "$S_connected" = true ] && echo ok || echo "'$S_hold' landed '$S_hold_landed' connected '$S_connected'")"
    judge "$P" "hold: landed: the exit address is the server's" "$(exit_is "$SRV")"
    judge "$P" "hold: landed: the tunnel's own confinement is in" "$([ "$(held_table)" = confinement ] && echo ok || echo "it is $(held_table)")"
    mark release
    ctl '{"type":"releaseReconnectHold"}' >/dev/null
    status
    judge "$P" "hold: let go after landing: armed, still connected" "$([ "$S_hold" = armed ] && [ "$S_connected" = true ] && echo ok || echo "'$S_hold', connected '$S_connected'")"

    # The app's own teardown for a reconnect.
    mark for-reconnect
    ctl '{"type":"disconnectForReconnect"}' >/dev/null
    status
    judge "$P" "hold: a disconnect for a reconnect is held" "$([ "$S_hold" = holding ] && [ "$S_connected" != true ] && [ "$(held_table)" = hold ] && echo ok || echo "'$S_hold', connected '$S_connected', table $(held_table)")"
    sleep 2
    mark reconnect-2
    kind=$(ctl_file "$HF" | py kind)
    wait_status 15 '[ "$S_hold_landed" = true ] && [ "$S_connected" = true ]'
    judge "$P" "hold: the reconnect after it lands" "$([ "$kind" = ok ] && [ "$S_hold_landed" = true ] && echo ok || echo "connect '$kind', '$S_hold' landed '$S_hold_landed'")"
    judge "$P" "hold: that tunnel's exit address is the server's" "$(exit_is "$SRV")"
    mark release-2
    ctl '{"type":"releaseReconnectHold"}' >/dev/null
    sleep 2

    stream_stop
    cap_stop
    fake_ipv6_off
    judge "$P" "hold: the stream ran throughout, never pausing 3 s" "$([ "${STREAM_ROUNDS:-0}" -gt 40 ] 2>/dev/null && awk -v g="${STREAM_GAP:-9}" 'BEGIN{exit !(g < 3)}' && echo ok || echo "${STREAM_ROUNDS:-no} rounds, longest pause ${STREAM_GAP:-?} s")"
    n=$(capcount "$WORK/hold-$P" "$STREAM_FILTER")
    judge "$P" "hold capture: none of the stream on the uplink" "$([ "$n" = 0 ] && echo ok || echo "$n packets ($(by_phase "$WORK/hold-$P" "$STREAM_FILTER" "$PH"); $(what_left "$WORK/hold-$P" "$STREAM_FILTER"))")"
    n=$(capcount "$WORK/hold-$P" "not ($allowed)")
    judge "$P" "hold capture: nothing the hold does not name" "$([ "$n" = 0 ] && echo ok || echo "$n packets ($(by_phase "$WORK/hold-$P" "not ($allowed)" "$PH"); $(what_left "$WORK/hold-$P" "not ($allowed)"))")"
    n=$(capcount "$WORK/hold-$P" "host $SRV")
    judge "$P" "hold capture: the engine's own traffic is seen" "$([ "$n" -gt 0 ] && echo ok || echo "none, so the capture saw nothing")"
    rm -f "$WORK"/hold-"$P".*

    disconnect
    judge "$P" "hold: Disconnect afterwards leaves nothing" "$(released_cleanly)"
    judge "$P" "hold: after it all: as before" "$(same_as_baseline)"
  done

  # Each way a hold ends on purpose, with Xray (the quickest to drop).
  P=XRAY_VLESS_REALITY
  # NX_PROOF_HOLD picks the protocols above (repeat one to run it again);
  # NX_PROOF_HOLD_ENDS=0 leaves out these endings, which take five minutes.
  if [ "${NX_PROOF_HOLD_ENDS:-1}" = 1 ] && file=$(profile_of "$P"); then
    HF=$WORK/hold-end.json
    py with "$file" "$HF" block true

    arm_deadman 300
    if up_and_drop "$P" "$HF"; then
      ctl '{"type":"disconnect"}' >/dev/null
      judge hold "ends: the customer's Disconnect lets the internet back" "$(released_cleanly)"
    else
      fail hold "ends: Disconnect" "the drop was not held"
    fi
    disconnect

    arm_deadman 300
    if up_and_drop "$P" "$HF"; then
      ctl '{"type":"setReconnectHold","enabled":false}' >/dev/null
      judge hold "ends: the setting turned off lets the internet back" "$(released_cleanly)"
    else
      fail hold "ends: setting off" "the drop was not held"
    fi
    disconnect

    arm_deadman 300
    if up_and_drop "$P" "$HF"; then
      systemctl restart "$UNIT"
      wait_helper >/dev/null
      judge hold "ends: the helper restarting lets the internet back" "$(released_cleanly)"
    else
      fail hold "ends: helper restart" "the drop was not held"
    fi
    disconnect

    # A drop no reconnect follows: let go after 120 s, read by the status
    # the app keeps polling. Whether "letting go" was said first is noted.
    arm_deadman 400
    if up_and_drop "$P" "$HF"; then
      t0=$(date +%s)
      said=no
      while [ $(( $(date +%s) - t0 )) -lt 160 ]; do
        status
        [ "$S_hold" = lettingGo ] && said=yes
        [ "$S_hold" = holding ] || [ "$S_hold" = lettingGo ] || break
        sleep 1
      done
      took=$(( $(date +%s) - t0 ))
      judge hold "ends: no reconnect within 120 s: let go, and said why" "$([ "$S_hold" = notHeld ] && [ "$S_hold_problem" = other ] && [ "$took" -ge 115 ] && [ "$took" -le 135 ] && echo ok || echo "after ${took} s the status says '$S_hold' '$S_hold_problem'")"
      echo "INFO hold ends: no reconnect: let go after ${took} s; 'letting go' said first: $said; detail: $S_hold_detail"
      judge hold "ends: no reconnect: the internet is back" "$(table_gone && wait_online && echo ok || echo "table $(held_table)")"
    else
      fail hold "ends: no reconnect" "the drop was not held"
    fi
    disconnect

    # The app going silent: nothing asks the helper anything for 85 s (the
    # app's silence limit is 60 s, looked at every 10 s). A reconnect's own
    # teardown starts this hold, so the 120 s limit above is not what ends it.
    arm_deadman 400
    if [ "$(ctl_file "$HF" | py kind)" = ok ] && wait_status 15 '[ "$S_hold" = armed ]'; then
      ctl '{"type":"disconnectForReconnect"}' >/dev/null
      before=$(held_table)
      ping -c 85 -i 1 127.0.0.1 >/dev/null 2>&1
      after=$(held_table)
      status
      judge hold "ends: the app silent: let go, and said why" "$([ "$before" = hold ] && [ "$after" = none ] && [ "$S_hold" = notHeld ] && echo "$S_hold_detail" | grep -q silent && echo ok || echo "table $before then $after, the status says '$S_hold' '$S_hold_detail'")"
      judge hold "ends: the app silent: the internet is back" "$(wait_online && echo ok || echo "no page")"
    else
      fail hold "ends: app silent" "the connect failed"
    fi
    disconnect
  fi
  kill "${APP_PID:-}" 2>/dev/null
  judge hold "after the hold: as before" "$(same_as_baseline)"
fi

# ---------------------------------------------------------------------
# The uplink going away and coming back under a session: NetworkManager
# takes the device down and brings it back, as a roam or a dropped Wi-Fi
# does. SSH rides that link, so this part is run detached (see the end of
# this file's header) and the dead-man brings the link back by itself.

uplink_back() {
  local i
  for i in $(seq 1 80); do
    ip -4 route show default | grep -q "dev $UPLINK" && return 0
    sleep 0.5
  done
  return 1
}

uplink_run() {
  local P=$1 hold=$2 file HF SRV H allowed t_down t_up t_dial seen dropped n first last
  file=$(profile_of "$P") || { fail "$P" uplink "no profile"; return; }
  eval "set -- $(py info "$file")"
  SRV=$2
  H=$(expected_health "$P")
  HF=$WORK/uplink-$P.json
  py with "$file" "$HF" block "$hold"
  allowed=$(hold_allowed "$(py servers "$HF")")
  arm_deadman 300
  PH=$WORK/phases-uplink
  : > "$PH"
  if [ "$(ctl_file "$HF" | py kind)" != ok ]; then
    fail "$P" "uplink (hold $hold): connect" "it failed"
    disconnect; return
  fi
  wait_status 15 '[ "$S_health" = "$H" ]'
  # As in the hold part: the capture and the stream start with the
  # tunnel up.
  cap_start "$WORK/uplink-$P-$hold"
  mark tunnel-up
  stream_start 600
  sleep 2

  t_down=$(date +%s.%N)
  mark uplink-gone
  nmcli device disconnect "$UPLINK" >/dev/null 2>&1
  dropped=no
  for _ in $(seq 1 12); do
    status
    [ "$S_connected" != true ] && { dropped=yes; break; }
    sleep 0.5
  done
  # When the helper sees no drop (WireGuard's link outlives the uplink),
  # the app's uplink watch takes the tunnel down for its reconnect.
  [ "$dropped" = no ] && ctl '{"type":"disconnectForReconnect"}' >/dev/null
  status
  echo "INFO $P uplink gone (hold $hold): the helper saw the drop itself: $dropped; the status then says '$S_hold'"
  [ "$hold" = true ] && judge "$P" "uplink gone: held" "$([ "$S_hold" = holding ] && [ "$(held_table)" = hold ] && echo ok || echo "'$S_hold', table $(held_table)")"
  ping -c 6 -i 1 127.0.0.1 >/dev/null 2>&1

  mark uplink-asked-back
  nmcli device connect "$UPLINK" >/dev/null 2>&1
  if uplink_back; then pass "$P" "uplink (hold $hold): back"; else fail "$P" "uplink (hold $hold): back" "no default route after 40 s"; fi
  t_up=$(date +%s.%N)
  mark uplink-back
  status
  echo "INFO $P uplink back (hold $hold): the status says '$S_hold', table $(held_table)"
  # The app looks twice, a second apart, before it dials again.
  sleep 2
  t_dial=$(date +%s.%N)
  mark reconnect
  kind=$(ctl_file "$HF" | py kind)
  judge "$P" "uplink (hold $hold): the reconnect" "$([ "$kind" = ok ] && echo ok || echo "it answered '$kind'")"
  if [ "$hold" = true ]; then
    wait_status 15 '[ "$S_hold_landed" = true ] && [ "$S_connected" = true ]'
    judge "$P" "uplink: landed" "$([ "$S_hold_landed" = true ] && echo ok || echo "'$S_hold' landed '$S_hold_landed'")"
    ctl '{"type":"releaseReconnectHold"}' >/dev/null
  else
    wait_status 15 '[ "$S_health" = "$H" ]'
  fi
  judge "$P" "uplink (hold $hold): the exit address is the server's" "$(exit_is "$SRV")"
  sleep 2
  stream_stop
  cap_stop
  n=$(capcount "$WORK/uplink-$P-$hold" "$STREAM_FILTER")
  if [ "$hold" = true ]; then
    judge "$P" "uplink capture: none of the stream on the uplink" "$([ "$n" = 0 ] && echo ok || echo "$n packets ($(by_phase "$WORK/uplink-$P-$hold" "$STREAM_FILTER" "$PH"); $(what_left "$WORK/uplink-$P-$hold" "$STREAM_FILTER"))")"
    n=$(capcount "$WORK/uplink-$P-$hold" "not ($allowed)")
    judge "$P" "uplink capture: nothing the hold does not name" "$([ "$n" = 0 ] && echo ok || echo "$n packets ($(by_phase "$WORK/uplink-$P-$hold" "not ($allowed)" "$PH"); $(what_left "$WORK/uplink-$P-$hold" "not ($allowed)"))")"
  else
    # Fail open is the product's default: say what left, and when.
    first=$(captimes "$WORK/uplink-$P-$hold" "$STREAM_FILTER" | head -1)
    last=$(captimes "$WORK/uplink-$P-$hold" "$STREAM_FILTER" | tail -1)
    if [ "$n" -gt 0 ]; then
      echo "INFO $P uplink (hold off): by phase: $(by_phase "$WORK/uplink-$P-$hold" "$STREAM_FILTER" "$PH")"
      echo "INFO $P uplink (hold off): $n packets of the stream left the uplink, from $(awk -v a="$first" -v b="$t_up" 'BEGIN{printf "%.1f", a-b}') s to $(awk -v a="$last" -v b="$t_up" 'BEGIN{printf "%.1f", a-b}') s after the uplink was back; the reconnect was sent at $(awk -v a="$t_dial" -v b="$t_up" 'BEGIN{printf "%.1f", a-b}') s"
    else
      echo "INFO $P uplink (hold off): none of the stream left the uplink"
    fi
    n=$(captimes "$WORK/uplink-$P-$hold" "$STREAM_FILTER" | awk -v t="$t_dial" '$1 > t + 15' | wc -l)
    judge "$P" "uplink (hold off): nothing of the stream once the reconnect is up" "$([ "$n" = 0 ] && echo ok || echo "$n packets")"
  fi
  rm -f "$WORK"/uplink-"$P"-"$hold".*
  disconnect
  sleep 1
  judge "$P" "uplink (hold $hold): after disconnect: online" "$(wait_online && echo ok || echo "no page")"
}

if want uplink; then
  if command -v nmcli >/dev/null 2>&1 && nmcli -t -f DEVICE,STATE device 2>/dev/null | grep -q "^$UPLINK:connected"; then
    uplink_run XRAY_VLESS_REALITY true
    uplink_run WIREGUARD true
    uplink_run XRAY_VLESS_REALITY false
    judge uplink "after the uplink runs: as before" "$(same_as_baseline)"
  else
    fail uplink "NetworkManager manages the uplink" "it does not, so this part cannot run"
  fi
fi

# ---------------------------------------------------------------------
# IKEv2's failures, each in a sentence the customer can act on.

if want ikev2 && file=$(profile_of IKEV2); then
  arm_deadman 300
  py with "$file" "$WORK/badpass.json" password "nx-proof-not-the-password"
  reply=$(ctl_file "$WORK/badpass.json")
  rm -f "$WORK/badpass.json"
  msg=$(echo "$reply" | py message)
  judge IKEV2 "wrong password: refused as the credentials" "$(echo "$msg" | grep -qiE 'credential|password|authenticat' && echo ok || echo "it said something else (kind '$(echo "$reply" | py kind)')")"
  judge IKEV2 "wrong password: nothing left" "$(same_as_baseline)"

  # strongSwan missing: the interface says "install strongSwan" for a
  # sentence naming strongswan or charon-cmd with missing or install.
  ui_says_install() { echo "$1" | tr 'A-Z' 'a-z' | grep -qE 'strongswan|charon-cmd' && echo "$1" | tr 'A-Z' 'a-z' | grep -qE 'missing|not installed|install'; }
  plugin=""
  for d in /usr/lib/ipsec/plugins /usr/lib64/strongswan/plugins; do
    [ -f "$d/libstrongswan-kernel-libipsec.so" ] && plugin="$d/libstrongswan-kernel-libipsec.so"
  done
  for aside in /usr/sbin/charon-cmd "$plugin"; do
    [ -n "$aside" ] && [ -e "$aside" ] || { fail IKEV2 "strongSwan missing ($aside)" "not where expected"; continue; }
    mv "$aside" "$aside.$ASIDE"
    msg=$(ctl_file "$file" | py message)
    mv "$aside.$ASIDE" "$aside"
    judge IKEV2 "$(basename "$aside") missing: the sentence says to install strongSwan" "$(ui_says_install "$msg" && echo ok || echo "it said '$msg'")"
    echo "INFO IKEV2 $(basename "$aside") missing: '$msg'"
    disconnect
    judge IKEV2 "$(basename "$aside") missing: nothing left" "$(same_as_baseline)"
  done
fi

# ---------------------------------------------------------------------
# Repair, the request and the subcommand, on a clean machine and on one
# dirtied by hand in each way a step exists for.

# Leaves one of each leftover a step clears: interfaces of ours, a route
# and rules of ours, both our tables, an orphaned engine, lookups pointed
# at a link of ours that is dead (with the ledger's record of it), and a
# program left in Custom mode's group.
dirty() {
  ip link add neoxify-wg type wireguard 2>/dev/null
  ip tuntap add dev neoxify-ovpn mode tun 2>/dev/null
  ip tuntap add dev neoconnect0 mode tun 2>/dev/null
  ip link set neoxify-ovpn up; ip link set neoconnect0 up
  resolvectl dns neoconnect0 192.0.2.53 2>/dev/null
  resolvectl domain neoconnect0 '~.' 2>/dev/null
  printf '[{"kind":"resolvedLink","link":"neoconnect0"}]\n' > /var/lib/neoxify/owed.json
  chmod 0600 /var/lib/neoxify/owed.json
  ip route add 192.0.2.77/32 via "$GW" dev "$UPLINK" proto 98
  # WireGuard's two rules, exactly as it adds them; its table stays empty,
  # so lookups fall through to main and the machine stays online.
  ip rule add pref 28278 table main suppress_prefixlength 0
  ip rule add pref 28279 not fwmark 28280 table 28280
  nft add table inet neoxify
  nft add table inet neoxify_split
  printf '{"log":{"loglevel":"none"},"outbounds":[{"protocol":"freedom"}]}\n' > "$WORK/nx-proof-orphan.json"
  setsid /usr/lib/neoxify/xray run -c "$WORK/nx-proof-orphan.json" >/dev/null 2>&1 < /dev/null &
  mkdir -p /sys/fs/cgroup/neoxify.split
  ( exec -a nx-proof-sleeper sleep 900 ) &
  SLEEPER=$!
  echo "$SLEEPER" > /sys/fs/cgroup/neoxify.split/cgroup.procs
  sleep 1
}
outcome_of() { echo " $1 " | grep -oE " $2=[a-zA-Z]+" | cut -d= -f2; }

if want repair; then
  arm_deadman 300
  # Once to clear what earlier parts may have left (Custom mode and the
  # hold leave their empty control groups behind), then on a clean machine.
  r=$(ctl '{"type":"repair"}' | py repair)
  echo "INFO repair before the clean run: $r"
  r=$(ctl '{"type":"repair"}' | py repair)
  judge repair "clean machine: every step already clean" "$([ "$(echo "$r" | tr ' ' '\n' | grep -vc '=alreadyClean$')" = 0 ] && [ "$(echo "$r" | wc -w)" = 7 ] && echo ok || echo "it said: $r")"

  dirty
  getent hosts example.com >/dev/null 2>&1 && dead=answered || dead="no answer"
  echo "INFO repair: with lookups pointed at the dead link, a lookup got: $dead"
  d=$("$HELPER" ctl '{"type":"linuxDiagnostics"}' 2>/dev/null)
  judge linux "diagnostics see the leftovers" "$( \
    [ "$(echo "$d" | py field diagnostics.firewallTable)" = true ] && \
    [ "$(echo "$d" | py field diagnostics.splitTable)" = true ] && \
    [ "$(echo "$d" | py field diagnostics.ourRoutes)" -ge 1 ] && \
    [ "$(echo "$d" | py field diagnostics.ourRules)" -ge 1 ] && \
    [ "$(echo "$d" | py field diagnostics.orphanedEngines)" = 1 ] && \
    [ "$(echo "$d" | py field diagnostics.dnsPointedAtUs)" = true ] && \
    [ "$(echo "$d" | py field diagnostics.ourLinks | grep -o '"present": true' | wc -l)" = 3 ] && \
    echo ok || echo "they said: firewall $(echo "$d" | py field diagnostics.firewallTable) split $(echo "$d" | py field diagnostics.splitTable) routes $(echo "$d" | py field diagnostics.ourRoutes) rules $(echo "$d" | py field diagnostics.ourRules) engines $(echo "$d" | py field diagnostics.orphanedEngines) dns $(echo "$d" | py field diagnostics.dnsPointedAtUs)")"

  r=$(ctl '{"type":"repair"}' | py repair)
  echo "INFO repair on the dirtied machine: $r"
  for step in engines dns routes firewall links; do
    judge repair "dirtied: $step fixed" "$([ "$(outcome_of "$r" "$step")" = fixed ] && echo ok || echo "it said $(outcome_of "$r" "$step")")"
  done
  judge repair "dirtied: tunnel step clean (no session)" "$([ "$(outcome_of "$r" tunnel)" = alreadyClean ] && echo ok || echo "it said $(outcome_of "$r" tunnel)")"
  judge repair "dirtied: a program still in Custom mode's group is said, not hidden" "$([ "$(outcome_of "$r" groups)" = unknown ] && echo ok || echo "it said $(outcome_of "$r" groups)")"
  judge repair "dirtied: lookups work again" "$(getent hosts example.com >/dev/null 2>&1 && echo ok || echo "no answer")"
  kill "$SLEEPER" 2>/dev/null; wait "$SLEEPER" 2>/dev/null
  r=$(ctl '{"type":"repair"}' | py repair)
  judge repair "then: the empty group removed, the rest clean" "$([ "$(outcome_of "$r" groups)" = fixed ] && [ "$(echo "$r" | tr ' ' '\n' | grep -vcE '^groups=|=alreadyClean$')" = 0 ] && echo ok || echo "it said: $r")"
  judge repair "the request: as before" "$(same_as_baseline)"
  d=$("$HELPER" ctl '{"type":"linuxDiagnostics"}' 2>/dev/null)
  judge linux "diagnostics after Repair: nothing of ours" "$( \
    [ "$(echo "$d" | py field diagnostics.firewallTable)" = false ] && [ "$(echo "$d" | py field diagnostics.splitTable)" = false ] && \
    [ "$(echo "$d" | py field diagnostics.ourRoutes)" = 0 ] && [ "$(echo "$d" | py field diagnostics.ourRules)" = 0 ] && \
    [ "$(echo "$d" | py field diagnostics.orphanedEngines)" = 0 ] && [ "$(echo "$d" | py field diagnostics.dnsPointedAtUs)" = false ] && \
    [ "$(echo "$d" | py field diagnostics.owed)" = 0 ] && \
    ! echo "$d" | py field diagnostics.ourLinks | grep -q '"present": true' && echo ok || echo "they did not say so")"

  # The subcommand, with the helper stopped, as a customer would run it
  # when the helper does not answer.
  systemctl stop "$UNIT"
  dirty
  out=$("$HELPER" repair 2>/dev/null); rc=$?
  ok_fixed=ok
  for label in "Stop leftover VPN engines" "Restore the DNS settings" "Remove leftover routes" "Remove leftover firewall rules" "Remove leftover network interfaces"; do
    echo "$out" | grep -q "^\[FIXED\] $label" || ok_fixed="'$label' was not FIXED"
  done
  echo "$out" | grep -q '^\[FAIL\]' && ok_fixed="a step FAILED"
  judge repair "subcommand, dirtied: every leftover FIXED, nothing FAILED" "$ok_fixed"
  echo "INFO repair subcommand, dirtied: $(echo "$out" | cut -c1-7 | tr -d ' ' | tr '\n' ' ')"
  judge repair "subcommand, dirtied: exit 0 (nothing failed)" "$([ "$rc" = 0 ] && echo ok || echo "exit $rc")"
  kill "$SLEEPER" 2>/dev/null; wait "$SLEEPER" 2>/dev/null
  "$HELPER" repair >/dev/null 2>&1
  out=$("$HELPER" repair 2>/dev/null); rc=$?
  judge repair "subcommand, clean: seven [ok] and exit 0" "$([ "$(echo "$out" | grep -c '^\[ok\]')" = 7 ] && [ "$rc" = 0 ] && echo ok || echo "exit $rc: $(echo "$out" | cut -c1-9 | tr '\n' ' ')")"
  out=$(runuser -u nx -- "$HELPER" repair 2>&1); rc=$?
  judge repair "subcommand as a user: refused, exit 2, says how" "$([ "$rc" = 2 ] && echo "$out" | grep -q 'sudo /usr/lib/neoxify/neoxify-helper repair' && echo ok || echo "exit $rc")"

  # Could not look: nft moved aside, so nothing can say whether a table
  # stands. Repair calls the step unknown and exits 0, as the Windows
  # repair does (an unknown establishes no failure); the sweep exits 1.
  mv /usr/sbin/nft "/usr/sbin/nft.$ASIDE"
  out=$("$HELPER" repair 2>/dev/null); rc=$?
  judge repair "could not look: the firewall step is unknown, not clean" "$(echo "$out" | grep -q '^\[????\]  *Remove leftover firewall rules' && echo ok || echo "it said: $(echo "$out" | grep firewall | cut -c1-9)")"
  echo "INFO repair could not look: exit $rc"
  "$HELPER" sweep >/dev/null 2>&1; rc=$?
  mv "/usr/sbin/nft.$ASIDE" /usr/sbin/nft
  judge repair "could not look: sweep exits 1" "$([ "$rc" = 1 ] && echo ok || echo "exit $rc")"
  "$HELPER" sweep >/dev/null 2>&1; rc=$?
  judge repair "sweep on a clean machine exits 0" "$([ "$rc" = 0 ] && echo ok || echo "exit $rc")"
  systemctl start "$UNIT"
  wait_helper >/dev/null
  judge repair "the subcommand: as before" "$(same_as_baseline)"
fi

# ---------------------------------------------------------------------
# The Linux-only requests: what this install is, and an update refused in
# every way it is meant to be, with nothing run. A real signed package
# does not exist outside CI, so the accepting path is not proven here.

if want linux; then
  arm_deadman 300
  r=$("$HELPER" ctl '{"type":"updateSupport"}' 2>/dev/null)
  pkgver=$(dpkg-query -W -f '${Version}' neoxify 2>/dev/null)
  judge linux "updateSupport: a .deb install of this version" "$([ "$(echo "$r" | py field kind)" = deb ] && [ "$(echo "$r" | py field version)" = "$pkgver" ] && echo ok || echo "it said kind '$(echo "$r" | py field kind)' version '$(echo "$r" | py field version)'")"

  [ -f "$DEVCONF" ] || devconf_on
  dl=/home/nx/.cache/nx-proof
  runuser -u nx -- mkdir -p "$dl"
  # A well-formed package that is not Neoxify's.
  pk=$WORK/pkg
  mkdir -p "$pk/DEBIAN"
  # dpkg-deb refuses a control directory this script's umask made 0700.
  chmod 0755 "$pk" "$pk/DEBIAN"
  printf 'Package: nx-proof-other\nVersion: 9.9.9\nArchitecture: all\nMaintainer: nobody <nobody@example.com>\nDescription: not Neoxify\n' > "$pk/DEBIAN/control"
  dpkg-deb --build "$pk" "$WORK/other.deb" >/dev/null 2>&1 || fail linux "a package that is not Neoxify's" "dpkg-deb could not build it"
  runuser -u nx -- cp "$WORK/other.deb" "$dl/other.deb" 2>/dev/null || install -o nx -m 0644 "$WORK/other.deb" "$dl/other.deb"
  runuser -u nx -- ln -sf "$dl/other.deb" "$dl/link.deb"
  runuser -u nx -- mkdir -p "$dl/adir"
  runuser -u nx -- mkfifo "$dl/afifo"
  runuser -u nx -- truncate -s 201M "$dl/big.deb"
  pubkey=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["plugins"]["updater"]["pubkey"])' "$(dirname "$0")/../../desktop-windows/src-tauri/tauri.conf.json" 2>/dev/null)
  printf '%s' "$pubkey" > "$WORK/pubkey"
  othersig=$(py badsig otherkey)
  rightsig=""
  [ -n "$pubkey" ] && rightsig=$(py badsig rightkey "$WORK/pubkey")

  refuse() { # $1 name, $2 package, $3 signature, $4 what the sentence must say
    local req r msg units left
    req=$(python3 -I -c 'import json,sys; print(json.dumps({"type":"installUpdate","package":sys.argv[1],"signature":sys.argv[2]}))' "$2" "$3")
    r=$(app_do "req $req")
    msg=$(echo "${r#reply }" | py message)
    units=$(systemctl list-units --all --no-legend 'neoxify-update-*' 2>/dev/null | wc -l)
    left=$(ls -A /var/lib/neoxify/update 2>/dev/null | grep -cE 'neoxify-update|state.json')
    judge linux "installUpdate refuses $1" "$(echo "$msg" | grep -qiE "$4" && [ "$units" = 0 ] && [ "$left" = 0 ] && echo ok || echo "it said '$msg'; update units $units; files left $left")"
    echo "INFO installUpdate $1: '$msg'"
  }

  app_start '{"type":"status"}'
  refuse "a missing signature" "$dl/other.deb" "" "without its signature"
  refuse "a signature that is not one" "$dl/other.deb" "bm90IGEgc2lnbmF0dXJl" "signature"
  refuse "a signature from another key" "$dl/other.deb" "$othersig" "not signed with Neoxify"
  if [ -n "$rightsig" ]; then
    refuse "a signature of the right key that does not match" "$dl/other.deb" "$rightsig" "does not match"
  else
    fail linux "installUpdate: the right key's id" "the updater key could not be read from the checkout"
  fi
  refuse "a symlink" "$dl/link.deb" "$othersig" "link"
  refuse "a directory" "$dl/adir" "$othersig" "not a regular file"
  refuse "a FIFO" "$dl/afifo" "$othersig" "not a regular file"
  refuse "a file over the limit" "$dl/big.deb" "$othersig" "larger than"
  refuse "a relative path" "other.deb" "$othersig" "absolute"
  refuse "a file that is not there" "$dl/none.deb" "$othersig" "no longer there"
  echo "INFO installUpdate: a package that is not Neoxify's own is refused only after a good signature, so its name check is not reached here"
  if wfile=$(profile_of WIREGUARD) && [ "$(ctl_file "$wfile" | py kind)" = ok ]; then
    refuse "while a tunnel is up" "$dl/other.deb" "$othersig" "while connected"
    disconnect
  else
    fail linux "installUpdate while a tunnel is up" "the connect failed"
  fi
  r=$("$HELPER" ctl "{\"type\":\"installUpdate\",\"package\":\"$dl/other.deb\",\"signature\":\"\"}" 2>/dev/null)
  judge linux "installUpdate refuses root's own tools" "$(echo "$r" | py message | grep -q 'only the Neoxify app' && echo ok || echo "it said '$(echo "$r" | py message)'")"
  timeout 5 sh -c 'echo quit > "$1"' _ "$APP_FIFO"

  # Someone who is neither at the screen nor in the group, running the
  # app: told the group and the command that adds them. Then in the group.
  useradd -M -r -s /usr/sbin/nologin "$AWAY_USER" >/dev/null 2>&1
  r=$(runuser -u "$AWAY_USER" -- "$FAKEAPP_DIR/nxapp" -I - app /run/neoxify/helper.sock - '{"type":"status"}' < "$WORK/j.py" 2>/dev/null)
  msg=$(echo "${r#reply }" | py message)
  judge linux "a user not at the screen nor in the group: refused, told the group and the command" "$(echo "$msg" | grep -q 'neoxify group' && echo "$msg" | grep -q "sudo usermod -aG neoxify $AWAY_USER" && echo ok || echo "it said '$msg'")"
  usermod -aG neoxify "$AWAY_USER"
  r=$(runuser -u "$AWAY_USER" -- "$FAKEAPP_DIR/nxapp" -I - app /run/neoxify/helper.sock - '{"type":"status"}' < "$WORK/j.py" 2>/dev/null)
  judge linux "the same user once in the group: served" "$(echo "${r#reply }" | grep -q '"status":"state"' && echo ok || echo "it was not")"
  userdel "$AWAY_USER" >/dev/null 2>&1
  rm -rf "$dl"
  judge linux "after the requests: as before" "$(same_as_baseline)"
fi
