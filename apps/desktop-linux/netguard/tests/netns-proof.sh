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
set -u

CTL=${1:?usage: netns-proof.sh /path/to/netguard-ctl}
HERE=$(cd "$(dirname "$0")" && pwd)
PEER="$HERE/netns_peer.py"
C=nxg-c
P=nxg-p
FAILS=0

cleanup() {
    [ -n "${SERVER:-}" ] && kill "$SERVER" 2>/dev/null
    ip netns del $C 2>/dev/null
    ip netns del $P 2>/dev/null
}
trap cleanup EXIT
cleanup

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
for a in 198.51.100.10/32 198.51.100.20/32 203.0.113.5/32; do ip -n $P addr add $a dev lo; done
ip -n $P addr add 2001:db8:aa::10/128 dev lo
for l in c-up c-tun; do ip -n $C link set $l up; done
for l in p-up p-tun; do ip -n $P link set $l up; done
ip -n $C route add default via 10.99.0.1 dev c-up
ip -n $C route add 203.0.113.0/24 via 100.64.0.1 dev c-tun
ip -n $C -6 route add default via fe80::1 dev c-up
ip netns exec $P python3 "$PEER" serve 10.99.0.1 203.0.113.5 fe80::1%p-up >/dev/null 2>&1 &
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

echo
if [ $FAILS = 0 ]; then echo "ALL PASS"; else echo "$FAILS FAILED"; fi
exit $FAILS
