#!/usr/bin/env bash
# Proves, live, the fixes the review asked for, with a second ordinary
# user on the machine. Run on a test machine, as root, from a login session
# of an ordinary user (SSH is fine), after vm-custom-proof.sh has passed:
#
#   sudo bash vm-review-proof.sh /home/nx/profiles
#
# It needs xray_vless_reality.json in the profile directory. The judges are
# the kernel's own tables (control groups, nftables, policy rules), the
# address the internet sees and a capture on the uplink. One line per
# check, then "ALL PASS" or "FAILED n". It never prints an address or a
# profile: an exit address is "the VM's own" or "different".
#
# What it does, in order:
#   c  a process stranded in neoxify.split (the helper killed hard) is moved
#      out when the next Custom mode session starts, and is not routed as
#      chosen;
#   a  with the session owner's Custom mode session up, a second user's
#      Disconnect, DisconnectForReconnect, SetSplitTunnel, SetReconnectHold,
#      ReleaseReconnectHold, ProbeSplitTunnel and Repair are refused, and
#      the session is exactly as before;
#   b  the second user's copy of a chosen program stays in its own group
#      and leaves the machine's own way;
#   d  a chosen program started through `systemd-run --user --scope` is
#      sorted, and its first connection is in the tunnel;
#   e  a FIFO, a link and a device at the sandbox file the sorting reads
#      (/.flatpak-info seen through /proc/<pid>/root), and an environment
#      at its size limit, neither hang nor grow the helper;
#   a  again with a reconnect hold holding (full tunnel), and
#   f  under that hold, a shell the app started after it was adopted.
#
# The stand-in app is a copy of python3 that the development allow-list
# names, run with the neoxify group; the second user is created for the
# run and removed at its end. Everything is put back by one script that
# the normal end and a dead-man timer both run.
set -u
umask 022

PROFILES=${1:-}
[ -n "$PROFILES" ] && [ -f "$PROFILES/xray_vless_reality.json" ] || { echo "usage: sudo bash vm-review-proof.sh <directory with xray_vless_reality.json>"; exit 2; }
[ "$(id -u)" = 0 ] || { echo "vm-review-proof.sh: run as root"; exit 2; }
for tool in python3 tcpdump curl nft ip systemctl setpriv unshare chroot useradd; do
  command -v "$tool" >/dev/null 2>&1 || { echo "vm-review-proof.sh: $tool is not installed"; exit 2; }
done
OWNER=${AS_USER:-${SUDO_USER:-}}
[ -n "$OWNER" ] && [ "$OWNER" != root ] || { echo "vm-review-proof.sh: run through sudo from an ordinary user"; exit 2; }
case "$(cut -d: -f3 /proc/$$/cgroup)" in
  /user.slice/*) ;;
  *) echo "vm-review-proof.sh: run from a login session (this one is not in /user.slice)"; exit 2 ;;
esac
getent group neoxify >/dev/null || { echo "vm-review-proof.sh: the neoxify group is missing (is the package installed?)"; exit 2; }

HELPER=/usr/lib/neoxify/neoxify-helper
UNIT=neoxify-helper
SOCK=/run/neoxify/helper.sock
DEADMAN=nx-review-deadman
DIR=/opt/nx-review
DEVCONF=/etc/neoxify/helper.json
TWO=nxreviewtwo
RESTORE=/run/nx-review-restore.sh
X="$PROFILES/xray_vless_reality.json"
NXG=$(getent group neoxify | cut -d: -f3)
U1=$(id -u "$OWNER")
UPLINK=$(ip -4 route show default | awk '{for (i=1;i<NF;i++) if ($i=="dev") {print $(i+1); exit}}')
REFUSAL="another user's Neoxify connection is active on this computer"
FAILS=0
BG_PIDS=()

pass() { echo "PASS $1 $2"; }
fail() { echo "FAIL $1 $2: $3"; FAILS=$((FAILS + 1)); }
judge() { if [ "$3" = ok ]; then pass "$1" "$2"; else fail "$1" "$2" "$3"; fi; }

cat > "$RESTORE" <<EOF
#!/bin/sh
pkill -KILL -f '^$DIR/' 2>/dev/null
for m in \$(awk '\$2 ~ "^$DIR/root" {print \$2}' /proc/mounts | sort -r); do umount -l "\$m" 2>/dev/null; done
id $TWO >/dev/null 2>&1 && userdel $TWO >/dev/null 2>&1
systemctl stop user-\$(id -u $TWO 2>/dev/null || echo 0).slice >/dev/null 2>&1
rm -f $DEVCONF; rmdir /etc/neoxify 2>/dev/null
rm -rf $DIR
exit 0
EOF
chmod 0600 "$RESTORE"

arm_deadman() {
  systemctl stop "$DEADMAN.timer" "$DEADMAN.service" >/dev/null 2>&1
  systemctl reset-failed "$DEADMAN.timer" "$DEADMAN.service" >/dev/null 2>&1
  systemd-run --quiet --unit="$DEADMAN" --on-active="${1:-300}" /bin/sh -c \
    "sh $RESTORE; systemctl stop $UNIT; $HELPER sweep; nft delete table inet neoxify; nft delete table inet neoxify_split; systemctl start $UNIT" >/dev/null 2>&1
}

ctl() { timeout 60 "$HELPER" ctl "$1" 2>/dev/null; }
wait_helper() {
  for _ in $(seq 1 40); do
    [ -S "$SOCK" ] && ctl '{"type":"status"}' | grep -q '"status":"state"' && return 0
    sleep 0.5
  done
  return 1
}

finish() {
  trap - EXIT INT TERM
  for p in "${BG_PIDS[@]}"; do kill "$p" 2>/dev/null; done
  ctl '{"type":"releaseReconnectHold"}' >/dev/null
  ctl '{"type":"disconnect"}' >/dev/null
  ctl '{"type":"setSplitTunnel","config":{"enabled":false,"mode":"onlySelected","apps":[]}}' >/dev/null
  ctl '{"type":"setReconnectHold","enabled":false}' >/dev/null
  sh "$RESTORE"
  # The helper read the allow-list at its start: restarted without it.
  systemctl restart "$UNIT" >/dev/null 2>&1
  wait_helper >/dev/null
  systemctl stop "$DEADMAN.timer" "$DEADMAN.service" >/dev/null 2>&1
  local left=""
  nft list table inet neoxify >/dev/null 2>&1 && left="$left neoxify-table"
  nft list table inet neoxify_split >/dev/null 2>&1 && left="$left split-table"
  [ "$(ip rule | wc -l)" = 3 ] || left="$left rules"
  id "$TWO" >/dev/null 2>&1 && left="$left second-user"
  [ -s /sys/fs/cgroup/neoxify.split/cgroup.procs ] && left="$left processes-in-split"
  judge machine "left as found" "$([ -z "$left" ] && echo ok || echo "left:$left")"
  rm -f "$RESTORE"
  if [ "$FAILS" -eq 0 ]; then echo "ALL PASS"; else echo "FAILED $FAILS"; fi
  exit $(( FAILS > 0 ))
}
trap finish EXIT
trap 'exit 1' INT TERM

# ---------------------------------------------------------------------
# Setup: the stand-in app, the test programs, the second user.

arm_deadman 600
rm -rf "$DIR"
mkdir -p "$DIR/out"
chmod 1777 "$DIR/out"
install -m 0755 "$(readlink -f "$(command -v python3)")" "$DIR/nxapp"
cp /usr/bin/curl "$DIR/nxcurl"
cp "$(readlink -f /usr/bin/bash)" "$DIR/nxbash"
cp "$(readlink -f /usr/bin/sleep)" "$DIR/nxsleep"
chmod 755 "$DIR" "$DIR"/nx*
cat > "$DIR/client.py" <<'PY'
# The stand-in app. "once <json>": one request, its reply printed.
# "stay": the request comes on stdin; after the reply it stays running (a
# session's owner is watched, and its exit ends the session) and, given a
# FIFO and an output file, starts a shell as its own child -- inside
# whatever group the helper put the app in -- that waits on the FIFO,
# then fetches a page and writes the HTTP code.
import json, socket, subprocess, sys, time
def ask(line):
    try:
        s = socket.socket(socket.AF_UNIX)
        s.settimeout(90)
        s.connect("/run/neoxify/helper.sock")
        s.sendall(line.encode() + b"\n")
        r = s.makefile().readline().strip()
        s.close()
        return r or "{}"
    except OSError as e:
        return json.dumps({"status": "error", "message": "client: " + str(e)})
mode = sys.argv[1]
req = sys.stdin.read().strip() if mode == "stay" else sys.argv[2]
print(ask(req), flush=True)
if mode == "stay":
    if len(sys.argv) > 3:
        subprocess.Popen(["/bin/bash", "-c",
            'read -r _ < "$0"; curl -4 -s -m 6 -o /dev/null -w "%{http_code}" https://1.0.0.1/cdn-cgi/trace > "$1"',
            sys.argv[2], sys.argv[3]])
    while True:
        time.sleep(3600)
PY
chmod 644 "$DIR/client.py"
install -d -m 0755 /etc/neoxify
printf '{"allowed_clients":["%s/nxapp"]}\n' "$DIR" > "$DEVCONF"
chmod 0644 "$DEVCONF"
useradd -M -N -g nogroup -s /usr/sbin/nologin "$TWO" >/dev/null 2>&1 || { fail setup "second user" "useradd failed"; exit 1; }
U2=$(id -u "$TWO")
systemctl restart "$UNIT"
wait_helper || { fail setup helper "it did not come back"; exit 1; }

# As the owner, in the owner's own login session; as the second user, in a
# slice of their own, as their own login would put them.
as1() { setpriv --reuid="$U1" --regid="$(id -g "$OWNER")" --groups="$NXG,$(id -g "$OWNER")" -- "$@"; }
as2() { systemd-run --quiet --scope --slice="user-$U2.slice" -- setpriv --reuid="$U2" --regid="$(id -g "$TWO")" --groups="$NXG" -- "$@"; }
app1() { as1 "$DIR/nxapp" -I "$DIR/client.py" once "$1"; }
app2() { as2 "$DIR/nxapp" -I "$DIR/client.py" once "$1"; }
reply() { python3 -I -c 'import json,sys
try: s = json.loads(sys.stdin.read() or "{}")
except ValueError: s = {}
print("ok" if s.get("status") in ("ok", "state", "repaired", "repair") or ("results" in s) else "error: " + str(s.get("message", s.get("status", "nothing"))))'; }
split_req() { python3 -I -c 'import json,sys; print(json.dumps({"type":"setSplitTunnel","config":{"enabled":sys.argv[1]=="on","mode":sys.argv[2],"apps":sys.argv[3:]}}))' "$@"; }
# Starts the owner's app with a connect request (a file); APP holds its
# pid and APP_REPLY the reply (not run in $(...): APP must outlive it).
app_stay() {
  local file=$1 fifo=${2:-} out=${3:-}
  : > "$DIR/out/app.txt"; chmod 666 "$DIR/out/app.txt"
  # Not through as1: a function sent to the background runs in a subshell
  # of its own, and $! would be that shell, not the app.
  setpriv --reuid="$U1" --regid="$(id -g "$OWNER")" --groups="$NXG,$(id -g "$OWNER")" -- \
    "$DIR/nxapp" -I "$DIR/client.py" stay $fifo $out < "$file" >> "$DIR/out/app.txt" 2>/dev/null &
  APP=$!
  BG_PIDS+=("$APP")
  for _ in $(seq 1 150); do [ -s "$DIR/out/app.txt" ] && break; sleep 0.2; done
  APP_REPLY=$(head -1 "$DIR/out/app.txt" | reply)
}
st() { ctl '{"type":"status"}' | python3 -I -c 'import json,sys
s = json.loads(sys.stdin.read() or "{}")
h = s.get("reconnect_hold") or {}
print(" ".join([str(s.get("connected")).lower(), str(s.get("split_tunnel_active")).lower(),
  "problem" if s.get("split_tunnel_problem") else "noproblem", h.get("state", "none"), str(s.get("ipv4_confined")).lower()]))'; }
group_of() { cut -d: -f3 "/proc/$1/cgroup" 2>/dev/null; }
word() { if [ -z "$1" ]; then echo "no answer"; elif [ "$1" = "$OWN" ]; then echo "the VM's own"; else echo different; fi; }
trace() { "$@" -s -m 10 https://1.1.1.1/cdn-cgi/trace 2>/dev/null | tr -d '\r' | sed -n 's/^ip=//p'; }
# Everything a session is, as the kernel holds it, in one line of hashes.
machine() {
  { nft -s list ruleset; echo ==; ip rule; echo ==; ip -4 route show table all | sed -E 's/ expires [0-9]+sec//'; echo ==;
    sort /sys/fs/cgroup/neoxify.split/cgroup.procs 2>/dev/null; echo ==; st; } | sha256sum | cut -c1-16
}

OWN=$(trace curl)
[ -n "$OWN" ] || { fail setup "the VM's own address" "no answer"; exit 1; }
xreq() { python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); r["block_while_reconnecting"]=sys.argv[2]=="true"; print(json.dumps(r))' "$X" "$1" > "$DIR/out/req-$1.json"; chmod 600 "$DIR/out/req-$1.json"; chown "$U1" "$DIR/out/req-$1.json"; }
xreq false
xreq true

# ---------------------------------------------------------------------
# c: a process stranded in the chosen apps' group.

L=stranded
judge "$L" "the owner's app is served" "$(app1 "$(split_req on onlySelected "$DIR/nxbash")" | reply)"
rm -f "$DIR/out/go" "$DIR/out/stranded"; mkfifo -m 666 "$DIR/out/go"
as1 "$DIR/nxbash" -c 'read -r _ < "$0"; curl -s -m 10 https://1.1.1.1/cdn-cgi/trace | tr -d "\r" | sed -n "s/^ip=//p" > "$1"; sleep 30' "$DIR/out/go" "$DIR/out/stranded" >/dev/null 2>&1 &
BG_PIDS+=("$!")
SPID=""
for _ in $(seq 1 20); do SPID=$(pgrep -n -f "^$DIR/nxbash -c read") && break; sleep 0.1; done
app_stay "$DIR/out/req-false.json"
judge "$L" "connect with the bash copy chosen" "$APP_REPLY"
sleep 1
judge "$L" "the bash copy is in neoxify.split" "$([ "$(group_of "$SPID")" = /neoxify.split ] && echo ok || echo "it is in another group")"
old=$(systemctl show -p MainPID --value "$UNIT")
kill -KILL "$old"
for _ in $(seq 1 60); do new=$(systemctl show -p MainPID --value "$UNIT"); [ "$new" != 0 ] && [ "$new" != "$old" ] && break; sleep 0.25; done
wait_helper
kill "$APP" 2>/dev/null
judge "$L" "after the helper is killed hard, it is stranded in neoxify.split" "$([ "$(group_of "$SPID")" = /neoxify.split ] && echo ok || echo "it is not there, so this proves nothing")"
judge "$L" "the next session, with other programs chosen" "$(app1 "$(split_req on onlySelected "$DIR/nxcurl")" | reply)"
app_stay "$DIR/out/req-false.json"
judge "$L" "its connect" "$APP_REPLY"
sleep 1
judge "$L" "the stranded process is moved out when it starts" "$([ "$(group_of "$SPID")" != /neoxify.split ] && echo ok || echo "it is still in neoxify.split")"
echo "INFO $L it went to: $(group_of "$SPID" | sed -E 's/[0-9]+/N/g')"
timeout 5 sh -c 'echo go > "$1"' _ "$DIR/out/go"
for _ in $(seq 1 60); do [ -s "$DIR/out/stranded" ] && break; sleep 0.2; done
judge "$L" "it is not routed as chosen: its child leaves the VM's own way" "$([ "$(word "$(cat "$DIR/out/stranded" 2>/dev/null)")" = "the VM's own" ] && echo ok || echo "it saw: $(word "$(cat "$DIR/out/stranded" 2>/dev/null)")")"
judge "$L" "the chosen curl copy still in the tunnel" "$([ "$(word "$(trace as1 "$DIR/nxcurl")")" = different ] && echo ok || echo no)"
kill "$SPID" 2>/dev/null

# ---------------------------------------------------------------------
# a (session) and b: the owner's Custom mode session is up (the curl and
# sleep copies chosen); the second user tries to change it.

app1 "$(split_req on onlySelected "$DIR/nxcurl" "$DIR/nxsleep")" >/dev/null
sleep 1
L="second user, session"
before=$(machine)
for req in '{"type":"disconnect"}' '{"type":"disconnectForReconnect"}' \
  "$(split_req on allExcept "$DIR/nxcurl")" '{"type":"setReconnectHold","enabled":true}' \
  '{"type":"releaseReconnectHold"}' '{"type":"probeSplitTunnel"}' '{"type":"repair"}'; do
  name=$(echo "$req" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["type"])')
  r=$(app2 "$req" | reply)
  judge "$L" "$name refused with the sentence" "$([ "$r" = "error: $REFUSAL" ] && echo ok || echo "it answered '$r'")"
done
after=$(machine)
judge "$L" "the session, its tables, rules, routes and group exactly as before" "$([ "$before" = "$after" ] && echo ok || echo "they changed")"
judge "$L" "status still connected, Custom mode active, no problem" "$(s=$(st); case "$s" in "true true noproblem "*) echo ok ;; *) echo "it says '$s'" ;; esac)"
judge "$L" "the owner's chosen curl copy: different" "$([ "$(word "$(trace as1 "$DIR/nxcurl")")" = different ] && echo ok || echo no)"
judge "$L" "the owner's own requests still served" "$(app1 '{"type":"probeSplitTunnel"}' | reply)"

L="second user's copy"
as1 "$DIR/nxsleep" 20 >/dev/null 2>&1 &
BG_PIDS+=("$!")
as2 "$DIR/nxsleep" 21 >/dev/null 2>&1 &
BG_PIDS+=("$!")
sleep 1.5
p1=$(pgrep -u "$U1" -n -f "^$DIR/nxsleep 20"); p2=$(pgrep -u "$U2" -n -f "^$DIR/nxsleep 21")
judge "$L" "the owner's copy of a chosen program is sorted" "$([ -n "$p1" ] && [ "$(group_of "$p1")" = /neoxify.split ] && echo ok || echo "it is not")"
judge "$L" "the second user's copy stays in its own group" "$([ -n "$p2" ] && group_of "$p2" | grep -q "^/user.slice/user-$U2.slice/" && echo ok || echo "it is in '$(group_of "$p2" | sed -E 's/[0-9]+/N/g')'")"
judge "$L" "the second user's curl copy leaves the VM's own way" "$([ "$(word "$(trace as2 "$DIR/nxcurl")")" = "the VM's own" ] && echo ok || echo no)"

# ---------------------------------------------------------------------
# d: a chosen program started through systemd-run --user --scope.

L="systemd scope"
if [ -S "/run/user/$U1/bus" ]; then
  T=$(ip -br link | awk '$1 ~ /^(neoconnect0|neoxify-wg|neoxify-ovpn|ipsec[0-9]+)(@|$)/ {sub(/@.*/, "", $1); print $1; exit}')
  tcpdump -ni "$UPLINK" -U -w "$DIR/out/scope-up.pcap" "host 1.0.0.1 and tcp port 443" >/dev/null 2>&1 &
  c1=$!; BG_PIDS+=("$c1")
  tcpdump -ni "$T" -U -w "$DIR/out/scope-tun.pcap" "host 1.0.0.1 and tcp port 443" >/dev/null 2>&1 &
  c2=$!; BG_PIDS+=("$c2")
  sleep 1.5
  ok=0
  for i in 1 2 3 4 5; do
    w=$(word "$(runuser -u "$OWNER" -- env XDG_RUNTIME_DIR="/run/user/$U1" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$U1/bus" \
      systemd-run --user --scope --quiet "$DIR/nxcurl" -s -m 10 https://1.0.0.1/cdn-cgi/trace 2>/dev/null | tr -d '\r' | sed -n 's/^ip=//p')")
    [ "$w" = different ] && ok=$((ok + 1))
  done
  sleep 1; kill "$c1" "$c2" 2>/dev/null; wait "$c1" "$c2" 2>/dev/null
  judge "$L" "five starts: each exit different" "$([ "$ok" = 5 ] && echo ok || echo "$ok of 5")"
  judge "$L" "capture: none of their packets on the uplink" "$(n=$(tcpdump -nr "$DIR/out/scope-up.pcap" 2>/dev/null | wc -l); [ "$n" = 0 ] && echo ok || echo "$n packets")"
  judge "$L" "capture: their packets in the tunnel (the control)" "$(n=$(tcpdump -nr "$DIR/out/scope-tun.pcap" 'tcp[tcpflags] & tcp-syn != 0' 2>/dev/null | wc -l); [ "$n" -ge 5 ] && echo ok || echo "$n first packets")"
  runuser -u "$OWNER" -- env XDG_RUNTIME_DIR="/run/user/$U1" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$U1/bus" \
    systemd-run --user --scope --quiet --unit=nx-review-scope "$DIR/nxsleep" 22 >/dev/null 2>&1 &
  BG_PIDS+=("$!")
  sleep 1.5
  p=$(pgrep -u "$U1" -n -f "^$DIR/nxsleep 22")
  judge "$L" "a long-running one ends up in neoxify.split" "$([ -n "$p" ] && [ "$(group_of "$p")" = /neoxify.split ] && echo ok || echo "it is in '$(group_of "$p" | sed -E 's/[0-9]+/N/g')'")"
  kill "$p" 2>/dev/null
else
  fail "$L" "the owner's user manager" "no session bus at /run/user/$U1/bus"
fi

# ---------------------------------------------------------------------
# e: what a sandboxed program's view can put where the sorting reads.

L="sandbox file"
hpid=$(systemctl show -p MainPID --value "$UNIT")
rss() { awk '/^VmRSS/ {print $2}' "/proc/$hpid/status"; }
r0=$(rss)
R=$DIR/root
for kind in fifo link device; do
  mkdir -p "$R"
  mount -t tmpfs -o mode=755 nxreview "$R"
  mkdir -p "$R/usr" "$R/proc" "$R/dev"
  mount --bind /usr "$R/usr"
  for l in bin lib lib64 sbin; do ln -s "usr/$l" "$R/$l"; done
  case $kind in
    fifo) mkfifo -m 644 "$R/.flatpak-info" ;;
    link) ln -s /dev/zero "$R/.flatpak-info" ;;
    device) touch "$R/.flatpak-info"; mount --bind /dev/zero "$R/.flatpak-info" ;;
  esac
  # Whether the helper opened it at all (nothing else here does), or the
  # checks below would prove nothing. A link refused by O_NOFOLLOW is never
  # opened, so it cannot be seen this way.
  python3 -I -c 'import ctypes, os, select, sys, time
libc = ctypes.CDLL(None, use_errno=True)
fd = libc.inotify_init1(os.O_NONBLOCK)
libc.inotify_add_watch(fd, sys.argv[1].encode(), 0x20 | 0x02000000)
end, n = time.time() + 5, 0
while time.time() < end:
    if select.select([fd], [], [], 0.2)[0]:
        try: n += len(os.read(fd, 4096)) // 16
        except BlockingIOError: pass
print(n)' "$R/.flatpak-info" > "$DIR/out/opened" 2>/dev/null &
  watcher=$!
  sleep 0.3
  # A process of the owner's, in a mount namespace of its own whose root
  # is that tree; the sorting reads its view of /.flatpak-info.
  unshare -m --propagation private chroot "$R" /usr/bin/setpriv --reuid="$U1" --regid="$(id -g "$OWNER")" --clear-groups /usr/bin/sleep 8 &
  sb=$!; BG_PIDS+=("$sb")
  sleep 2
  t0=$(date +%s%N)
  s=$(st)
  took=$(( ($(date +%s%N) - t0) / 1000000 ))
  w=$(word "$(trace as1 "$DIR/nxcurl")")
  judge "$L" "$kind: the helper answers at once" "$([ "$took" -lt 1500 ] && case "$s" in "true true "*) true ;; *) false ;; esac && echo ok || echo "status took $took ms and says '$s'")"
  judge "$L" "$kind: Custom mode still sorts (a chosen curl copy: different)" "$([ "$w" = different ] && echo ok || echo "it saw $w")"
  wait "$watcher" 2>/dev/null
  echo "INFO $L $kind: status in $took ms, helper memory ${r0} kB before, $(rss) kB now; opened $(cat "$DIR/out/opened" 2>/dev/null) times"
  [ "$kind" = link ] || judge "$L" "$kind: the helper did look at it (the control)" "$([ "$(cat "$DIR/out/opened" 2>/dev/null)" -gt 0 ] 2>/dev/null && echo ok || echo "it was never opened, so this proves nothing")"
  wait "$sb" 2>/dev/null
  umount -l "$R/.flatpak-info" 2>/dev/null; umount -l "$R/usr"; umount -l "$R"
  rm -rf "$R"
done
# The environment, read from /proc for a program run from an AppImage's
# mount directory, at about the kernel's limit (2 MB).
mkdir -p "/tmp/.mount_nxreview"
cp "$DIR/nxsleep" /tmp/.mount_nxreview/prog
chmod 755 /tmp/.mount_nxreview /tmp/.mount_nxreview/prog
big=$(head -c 120000 /dev/zero | tr '\0' x)
envs=(); for i in $(seq 1 14); do envs+=("NXBIG$i=$big"); done
as1 env "${envs[@]}" /tmp/.mount_nxreview/prog 8 >/dev/null 2>&1 &
ap=$!; BG_PIDS+=("$ap")
sleep 2
t0=$(date +%s%N); s=$(st); took=$(( ($(date +%s%N) - t0) / 1000000 ))
judge "$L" "a 1.7 MB environment: the helper answers at once" "$([ "$took" -lt 1500 ] && echo ok || echo "status took $took ms")"
echo "INFO $L environment: status in $took ms, helper memory ${r0} kB before, $(rss) kB now"
wait "$ap" 2>/dev/null
rm -rf /tmp/.mount_nxreview
judge "$L" "the helper's memory did not grow by more than 8 MB" "$([ $(( $(rss) - r0 )) -lt 8192 ] && echo ok || echo "it grew by $(( $(rss) - r0 )) kB")"
judge "$L" "the helper is the same process (not restarted)" "$([ "$(systemctl show -p MainPID --value "$UNIT")" = "$hpid" ] && echo ok || echo "it was restarted")"

kill "$APP" 2>/dev/null
sleep 1
ctl '{"type":"disconnect"}' >/dev/null
app1 "$(split_req off onlySelected)" >/dev/null

# ---------------------------------------------------------------------
# a (hold) and f: a full-tunnel session with the hold, held after the
# owner's DisconnectForReconnect.

arm_deadman 400
L="second user, hold"
judge "$L" "the owner wants the hold" "$(app1 '{"type":"setReconnectHold","enabled":true}' | reply)"
rm -f "$DIR/out/go2" "$DIR/out/shell"; mkfifo -m 666 "$DIR/out/go2"
app_stay "$DIR/out/req-true.json" "$DIR/out/go2" "$DIR/out/shell"
judge "$L" "connect with the hold" "$APP_REPLY"
for _ in $(seq 1 30); do case "$(st)" in "true "*" armed "*) break ;; esac; sleep 0.5; done
SH=$(pgrep -P "$APP" -n bash)
judge "$L" "the app is in neoxify.app, and so is the shell it started" "$([ "$(group_of "$APP")" = /neoxify.app ] && [ -n "$SH" ] && [ "$(group_of "$SH")" = /neoxify.app ] && echo ok || echo "app '$(group_of "$APP")', shell '$(group_of "$SH")'")"
judge "$L" "the owner's DisconnectForReconnect" "$(app1 '{"type":"disconnectForReconnect"}' | reply)"
sleep 1
s=$(st)
judge "$L" "holding" "$(case "$s" in *" holding "*) echo ok ;; *) echo "it says '$s'" ;; esac)"
before=$(machine)
for req in '{"type":"disconnect"}' '{"type":"disconnectForReconnect"}' \
  "$(split_req on allExcept "$DIR/nxcurl")" '{"type":"setReconnectHold","enabled":false}' \
  '{"type":"releaseReconnectHold"}' '{"type":"probeSplitTunnel"}' '{"type":"repair"}'; do
  name=$(echo "$req" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["type"])')
  r=$(app2 "$req" | reply)
  judge "$L" "$name refused with the sentence" "$([ "$r" = "error: $REFUSAL" ] && echo ok || echo "it answered '$r'")"
done
after=$(machine)
judge "$L" "the hold, its table and rules exactly as before" "$([ "$before" = "$after" ] && echo ok || echo "they changed")"
judge "$L" "still holding" "$(s=$(st); case "$s" in *" holding "*) echo ok ;; *) echo "it says '$s'" ;; esac)"

L="hold, app's group"
tcpdump -ni "$UPLINK" -U -w "$DIR/out/hold-up.pcap" "host 1.0.0.1 and tcp port 443" >/dev/null 2>&1 &
c1=$!; BG_PIDS+=("$c1")
sleep 1.5
code=$(as1 curl -4 -s -m 6 -o /dev/null -w '%{http_code}' https://1.0.0.1/cdn-cgi/trace)
judge "$L" "an ordinary program does not get out (the control)" "$([ "$code" = 000 ] && echo ok || echo "it got $code")"
n0=$(tcpdump -nr "$DIR/out/hold-up.pcap" 2>/dev/null | wc -l)
timeout 5 sh -c 'echo go > "$1"' _ "$DIR/out/go2"
for _ in $(seq 1 40); do [ -s "$DIR/out/shell" ] && break; sleep 0.2; done
sleep 1; kill "$c1" 2>/dev/null; wait "$c1" 2>/dev/null
n=$(( $(tcpdump -nr "$DIR/out/hold-up.pcap" 2>/dev/null | wc -l) - n0 ))
judge "$L" "a shell the app started does not get out" "$([ "$(cat "$DIR/out/shell" 2>/dev/null)" = 000 ] && [ "$n" = 0 ] && echo ok || echo "it got '$(cat "$DIR/out/shell" 2>/dev/null)', $n packets on the uplink")"

judge "$L" "the owner releases the hold" "$(app1 '{"type":"releaseReconnectHold"}' | reply)"
app1 '{"type":"disconnect"}' >/dev/null
app1 '{"type":"setReconnectHold","enabled":false}' >/dev/null
kill "$APP" 2>/dev/null
