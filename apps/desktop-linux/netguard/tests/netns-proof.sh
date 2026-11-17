#!/usr/bin/env bash
# Proves netguard with real packets, inside two network namespaces so the
# machine's own network is never touched.
#
#   sudo bash netns-proof.sh /path/to/netguard-ctl
#
# (build it with: cargo build -p neoxify-netguard --example netguard-ctl)
#
# nxg-c is the customer's machine. nxg-p is everything outside it: the
# router on the "uplink" veth (10.99.0.1, fe80::1, 2001:db8:99::1), the
# internet behind it (198.51.100.10, a server that is not ours, and
# 198.51.100.20:443, the engine's transport) and, over a second veth that
# stands in for the tunnel, 203.0.113.5. Every check runs once before
# netguard is applied, so a refusal is known to be netguard's and not the
# topology's, once with it in force, and once after it is removed.
#
# The second half proves the reconnect hold the same way, and then that a
# stream of packets to a forbidden address shows none arriving on the far
# side while the table swaps between the confinement and the hold. It also
# creates one control group of its own, nxg-proof.app, at the cgroup root,
# for the app's permit, and removes it at the end.
set -u

CTL=${1:?usage: netns-proof.sh /path/to/netguard-ctl}
HERE=$(cd "$(dirname "$0")" && pwd)
PEER="$HERE/netns_peer.py"
C=nxg-c
P=nxg-p
GROUP=nxg-proof.app
FAILS=0

cleanup() {
    [ -n "${SERVER:-}" ] && kill "$SERVER" 2>/dev/null
    ip netns del $C 2>/dev/null
    ip netns del $P 2>/dev/null
    # The group empties itself when its probes exit; a group with a
    # process still in it cannot be removed, and is then left to say so.
    [ -d /sys/fs/cgroup/$GROUP ] && rmdir /sys/fs/cgroup/$GROUP
    [ -n "${WORK:-}" ] && rm -rf "$WORK"
}
trap cleanup EXIT
cleanup
# The capture's own directory: tcpdump writes as root into it (-Z root),
# and Ubuntu's AppArmor profile for tcpdump allows a file ending in .pcap.
WORK=$(mktemp -d /tmp/nxg-proof.XXXXXX)
PCAP=$WORK/hold.pcap

check() { # check <name> <expected 0|1> <command...>
    local name=$1 want=$2
    shift 2
    local out rc
    out=$("$@" 2>&1)
    rc=$?
    if { [ "$want" = 0 ] && [ $rc = 0 ]; } || { [ "$want" = 1 ] && [ $rc != 0 ]; }; then
        echo "PASS  $name  [$out]"
    else
        echo "FAIL  $name  [$out]"
        FAILS=$((FAILS + 1))
    fi
}

inc() { ip netns exec $C "$@"; }
probe() { inc python3 "$PEER" probe "$@"; }

# --- the topology ---
ip netns add $C
ip netns add $P
for ns in $C $P; do
    # No duplicate-address detection: the addresses must be usable at once.
    ip netns exec $ns sysctl -qw net.ipv6.conf.all.accept_dad=0 net.ipv6.conf.default.accept_dad=0
    ip -n $ns link set lo up
done
ip -n $C link add c-up type veth peer name p-up netns $P
ip -n $C link add c-tun type veth peer name p-tun netns $P
ip -n $C addr add 10.99.0.2/24 dev c-up
ip -n $C addr add fe80::2/64 dev c-up nodad
ip -n $C addr add 2001:db8:99::2/64 dev c-up nodad
ip -n $C addr add 100.64.0.2/30 dev c-tun
ip -n $P addr add 10.99.0.1/24 dev p-up
ip -n $P addr add fe80::1/64 dev p-up nodad
ip -n $P addr add 2001:db8:99::1/64 dev p-up nodad
ip -n $P addr add 100.64.0.1/30 dev p-tun
for a in 198.51.100.10/32 198.51.100.20/32 203.0.113.5/32 203.0.113.6/32; do ip -n $P addr add $a dev lo; done
ip -n $P addr add 2001:db8:aa::10/128 dev lo
ip -n $P addr add 2001:db8:aa::53/128 dev lo
for l in c-up c-tun; do ip -n $C link set $l up; done
for l in p-up p-tun; do ip -n $P link set $l up; done
ip -n $C route add default via 10.99.0.1 dev c-up
ip -n $C route add 203.0.113.0/24 via 100.64.0.1 dev c-tun
ip -n $C -6 route add default via fe80::1 dev c-up
ip netns exec $P python3 "$PEER" serve 10.99.0.1 203.0.113.5 fe80::1%p-up \
    198.51.100.10 198.51.100.20 2001:db8:aa::53 >/dev/null 2>&1 &
SERVER=$!
sleep 1

APPLY=(apply --tunnel c-tun --transport 198.51.100.20:443/tcp --fwmark 28280 --lan auto --ipv6 --dns --ipv4)

traffic() { # traffic <phase> <0 when refusals are expected, 1 when everything should pass>
    local phase=$1 guarded=$2 r=0
    [ "$guarded" = 0 ] && r=1
    check "$phase: TCP to a server behind the uplink that is not a transport" $r probe tcp 198.51.100.10 443
    check "$phase: TCP to the transport" 0 probe tcp 198.51.100.20 443
    check "$phase: TCP to the transport's address on another port" $r probe tcp 198.51.100.20 80
    check "$phase: packets with the engine's mark" 0 probe tcp 198.51.100.10 80 28280
    check "$phase: TCP through the tunnel" 0 probe tcp 203.0.113.5 80
    check "$phase: DNS (UDP 53) through the tunnel" 0 probe udp 203.0.113.5 53
    check "$phase: UDP 53 to the on-link router" $r probe udp 10.99.0.1 53
    check "$phase: TCP 53 to the on-link router" $r probe tcp 10.99.0.1 53
    check "$phase: other traffic to the on-link router (TCP 80)" 0 probe tcp 10.99.0.1 80
    check "$phase: global IPv6 to the router" $r probe tcp 2001:db8:99::1 80
    check "$phase: global IPv6 through the default route" $r probe tcp 2001:db8:aa::10 80
    check "$phase: UDP 53 to the router's link-local address" $r probe udp fe80::1%c-up 53
    inc ip -6 neigh flush dev c-up
    check "$phase: link-local ping after flushing the neighbour cache" 0 bash -c "ip netns exec $C ping -q -6 -c1 -W2 fe80::1%c-up | grep received"
    check "$phase: neighbour discovery resolved the router" 0 \
        bash -c "ip netns exec $C ip -6 neigh show dev c-up | grep -E '^fe80::1 lladdr'"
}

traffic before 1
check "before: nothing of ours in force" 0 bash -c "[ \"\$(ip netns exec $C '$CTL' in-force)\" = none ]"

check "apply" 0 inc "$CTL" "${APPLY[@]}"
check "apply again replaces the table in one transaction" 0 inc "$CTL" "${APPLY[@]}"
check "one table, not two" 0 bash -c "[ \$(ip netns exec $C nft list tables | grep -c 'inet neoxify') = 1 ]"
check "in_force reports all three" 0 \
    bash -c "ip netns exec $C '$CTL' in-force | grep -qx 'in-force ipv6_blocked=true dns_confined=true ipv4_confined=true'"
check "a hostile interface name is refused" 1 inc "$CTL" apply --tunnel 'x" accept' --ipv4
check "a refused plan leaves the table in force" 0 \
    bash -c "ip netns exec $C '$CTL' in-force | grep -q 'ipv4_confined=true'"
traffic during 0

check "remove" 0 bash -c "[ \"\$(ip netns exec $C '$CTL' remove)\" = Removed ]"
check "remove again finds nothing" 0 bash -c "[ \"\$(ip netns exec $C '$CTL' remove)\" = Nothing ]"
check "in_force after remove" 0 bash -c "[ \"\$(ip netns exec $C '$CTL' in-force)\" = none ]"
traffic after 1

# --- the reconnect hold ---
#
# The app's group is looked up by nft under /sys/fs/cgroup, which `ip netns
# exec` hides behind a fresh sysfs mount, so the table is loaded with
# nsenter, which changes the network namespace and nothing else.
ctl() { nsenter --net=/run/netns/$C "$CTL" "$@"; }
mkdir -p /sys/fs/cgroup/$GROUP
# The same program as probe(), started from inside the app's group.
ingroup() {
    bash -c 'echo $$ > /sys/fs/cgroup/'$GROUP'/cgroup.procs && exec ip netns exec '$C' python3 "$0" probe "$@"' "$PEER" "$@"
}

HOLD=(hold --tunnel c-tun --tunnel c-late --server 198.51.100.20 --fwmark 28280 --app-group $GROUP
    --resolver 10.99.0.1 --resolver 2001:db8:aa::53 --lan auto)

hold_traffic() { # hold_traffic <phase> <0 under the hold, 1 with nothing in force>
    local phase=$1 open=$2 r=0
    [ "$open" = 0 ] && r=1
    check "$phase: TCP to an address that is not a server" $r probe tcp 198.51.100.10 443
    check "$phase: TCP to a named server, port 443" 0 probe tcp 198.51.100.20 443
    check "$phase: TCP to a named server, port 80" 0 probe tcp 198.51.100.20 80
    check "$phase: UDP to a named server, port 53" 0 probe udp 198.51.100.20 53
    check "$phase: packets with the engine's mark" 0 probe tcp 198.51.100.10 80 28280
    check "$phase: TCP through the tunnel" 0 probe tcp 203.0.113.5 80
    check "$phase: DNS through the tunnel" 0 probe udp 203.0.113.5 53
    check "$phase: UDP 53 to the listed resolver" 0 probe udp 10.99.0.1 53
    check "$phase: TCP 53 to the listed resolver" 0 probe tcp 10.99.0.1 53
    check "$phase: UDP 53 to the listed IPv6 resolver" 0 probe udp 2001:db8:aa::53 53
    check "$phase: TCP 80 to the listed IPv6 resolver" $r probe tcp 2001:db8:aa::53 80
    check "$phase: UDP 53 to a resolver nobody listed" $r probe udp 198.51.100.10 53
    check "$phase: UDP 53 to the router's link-local address, not listed" $r probe udp fe80::1%c-up 53
    check "$phase: global IPv6 through the default route" $r probe tcp 2001:db8:aa::10 80
    check "$phase: the local network (TCP 80 to the router)" 0 probe tcp 10.99.0.1 80
    check "$phase: the same program inside the app's group, TCP" 0 ingroup tcp 198.51.100.10 443
    check "$phase: the same program inside the app's group, a lookup anywhere" 0 ingroup udp 198.51.100.10 53
    check "$phase: the same program inside the app's group, IPv6" 0 ingroup tcp 2001:db8:aa::10 80
    inc ip -6 neigh flush dev c-up
    check "$phase: link-local ping after flushing the neighbour cache" 0 bash -c "ip netns exec $C ping -q -6 -c1 -W2 fe80::1%c-up | grep received"
}

# Only what must not leave, so the capture on the far side of the uplink
# can be counted whole: anything from the customer that is not for the
# local network is a leak.
forbidden() {
    probe tcp 198.51.100.10 443
    probe tcp 198.51.100.10 80
    probe tcp 198.51.100.10 53
    probe udp 198.51.100.10 53
    probe tcp 2001:db8:aa::10 80
    probe tcp 2001:db8:aa::53 80
    inc ping -q -c1 -W1 198.51.100.10
}
leaked() { # leaked: runs forbidden() under a capture and prints what left
    ip netns exec $P tcpdump -Z root --immediate-mode -i p-up -n -U -w $PCAP 'src host 10.99.0.2 or src host 2001:db8:99::2' 2>"$WORK/tcpdump.log" >/dev/null &
    local dump=$! i
    # A capture that starts late would count nothing and pass: wait until
    # tcpdump says it is listening, and a second more for the filter.
    for i in $(seq 50); do grep -q listening "$WORK/tcpdump.log" 2>/dev/null && break; sleep 0.1; done
    sleep 1
    forbidden >/dev/null 2>&1
    sleep 0.5
    kill -INT $dump
    wait $dump 2>/dev/null
    tcpdump -r $PCAP -n 'not dst net 10.99.0.0/24 and not (ip6 and dst net fe80::/10) and not (ip6 and dst net ff00::/8)' 2>/dev/null | wc -l
}

says() { # says <expected output> <command...>: exact match, in this shell
    local want=$1 got
    shift
    got=$("$@" 2>&1)
    echo "$got"
    [ "$got" = "$want" ]
}

hold_traffic "hold, before" 1
CAPTURE_SEEN=$(leaked)
check "hold, before: the capture sees what leaves ($CAPTURE_SEEN packets)" 0 test "$CAPTURE_SEEN" -gt 0

check "the confinement in force before the hold" 0 inc "$CTL" "${APPLY[@]}"
check "hold: swapped in" 0 says 'held dns_anywhere=false' ctl "${HOLD[@]}"
check "hold: still one table" 0 bash -c "[ \$(ip netns exec $C nft list tables | grep -c 'inet neoxify') = 1 ]"
check "hold: read back from the kernel" 0 says 'held dns_anywhere=false' ctl held
check "hold: in_force makes no confinement claim" 0 \
    says 'in-force ipv6_blocked=false dns_confined=false ipv4_confined=false' ctl in-force
check "hold: a group that does not exist is refused" 1 ctl hold --app-group nxg-proof.absent
check "hold: a refused hold leaves the hold in force" 0 says 'held dns_anywhere=false' ctl held
check "hold: a hostile group path is refused" 1 ctl hold --app-group '../x'
hold_traffic "hold" 0
HOLD_LEAKED=$(leaked)
check "hold: nothing outside the plan reached the far side ($HOLD_LEAKED packets)" 0 test "$HOLD_LEAKED" = 0

# A tunnel that comes up under the hold carries at once: the name was in
# the plan before the interface existed.
ip -n $C link add c-late type veth peer name p-late netns $P
ip -n $C addr add 100.64.1.2/30 dev c-late
ip -n $P addr add 100.64.1.1/30 dev p-late
ip -n $C link set c-late up
ip -n $P link set p-late up
ip -n $C route add 203.0.113.6/32 via 100.64.1.1 dev c-late
check "hold: a tunnel interface created after the hold carries" 0 probe tcp 203.0.113.6 80

check "hold, other resolver: in force" 0 \
    says 'held dns_anywhere=false' ctl hold --server 198.51.100.20 --resolver 198.51.100.10 --lan auto
check "hold, other resolver: UDP 53 to it" 0 probe udp 198.51.100.10 53
check "hold, other resolver: UDP 53 to the router, no longer listed" 1 probe udp 10.99.0.1 53
check "hold, other resolver: TCP 53 to the router, no longer listed" 1 probe tcp 10.99.0.1 53
check "hold, other resolver: the tunnel is not named, so it is refused" 1 probe tcp 203.0.113.5 80

check "hold, DNS anywhere: in force" 0 says 'held dns_anywhere=true' ctl hold --dns-anywhere --lan auto
check "hold, DNS anywhere: read back" 0 says 'held dns_anywhere=true' ctl held
check "hold, DNS anywhere: UDP 53 to the router" 0 probe udp 10.99.0.1 53
check "hold, DNS anywhere: UDP 53 to an unlisted resolver" 0 probe udp 198.51.100.10 53
check "hold, DNS anywhere: TCP 443 to the same address" 1 probe tcp 198.51.100.10 443

# --- swaps under a stream ---
#
# Datagrams to an address neither table permits, sent without pause while
# the table is swapped from the confinement to the hold and back, ten
# times. One transaction per swap means the count on the far side is 0;
# a moment with no rules would show as datagrams arriving.
STREAM_TO=(198.51.100.10 9999)
check "stream: the hold lifted for the control run" 0 says Removed ctl remove
control=$(
    ip netns exec $P python3 "$PEER" count "${STREAM_TO[@]}" 2 &
    sleep 0.3
    inc python3 "$PEER" stream "${STREAM_TO[@]}" 1 >/dev/null
    wait
)
check "stream, without rules: the far side counts it ($control)" 0 test "${control:-0}" -gt 100
check "stream: the confinement in force" 0 inc "$CTL" "${APPLY[@]}"
COUNTED=$(mktemp)
ip netns exec $P python3 "$PEER" count "${STREAM_TO[@]}" 9 >"$COUNTED" &
COUNTER=$!
sleep 0.3
SENT=$(mktemp)
inc python3 "$PEER" stream "${STREAM_TO[@]}" 7 >"$SENT" &
STREAMER=$!
sleep 0.5
swaps=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
    ctl "${HOLD[@]}" >/dev/null && swaps=$((swaps + 1))
    ctl held | grep -q '^held' || swaps=$((swaps - 100))
    inc "$CTL" "${APPLY[@]}" >/dev/null && swaps=$((swaps + 1))
    ctl in-force | grep -q 'ipv4_confined=true' || swaps=$((swaps - 100))
    sleep 0.2
done
wait $STREAMER
wait $COUNTER
check "stream: twenty swaps, each read back ($swaps)" 0 bash -c "[ $swaps = 20 ]"
check "stream: datagrams sent across the swaps ($(cat "$SENT"))" 0 bash -c "[ \$(cat $SENT) -gt 1000 ]"
check "stream: none arrived on the far side ($(cat "$COUNTED"))" 0 bash -c "[ \"\$(cat $COUNTED)\" = 0 ]"
rm -f "$COUNTED" "$SENT"
check "stream: the confinement is what stands at the end" 0 \
    says 'in-force ipv6_blocked=true dns_confined=true ipv4_confined=true' ctl in-force
check "stream: and it is not a hold" 0 says none ctl held

check "remove after the swaps" 0 says Removed ctl remove
check "held after remove" 0 says none ctl held

echo
if [ $FAILS = 0 ]; then echo "ALL PASS"; else echo "$FAILS FAILED"; fi
exit $FAILS
