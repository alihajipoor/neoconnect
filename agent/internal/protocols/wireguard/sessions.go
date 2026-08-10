package wireguard

import (
	"bufio"
	"bytes"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

/*
Session counting for WireGuard.

This was left out originally, on reasoning that was correct at the time
and stopped being so. A WireGuard peer holds one endpoint at a time: a
second device using the same key takes the tunnel over rather than
adding a session, so a shared credential bought nobody extra devices and
there was nothing to report.

What changed is that a subscription now holds a credential on *every*
route, so failover can move without asking the server. One account
therefore has a WireGuard peer on each node, and somebody can run
Finland and France at once for two simultaneous devices that the
account-wide limit never saw. The limit is summed per subscription
across nodes, so each node only has to report its own peers honestly for
that sum to come out right.
*/

/** How recently a peer must have handshaked to count as connected.
 *
 * WireGuard rehandshakes about every two minutes while traffic flows,
 * so three minutes is late enough not to miscount a live tunnel during
 * a quiet moment. It matches the staleness threshold the clients and the
 * Windows service already use, so all three agree on what "connected"
 * means rather than each having an opinion.
 */
const handshakeFreshFor = 3 * time.Minute

// SessionCounts reports peers that look genuinely connected, one per
// public key.
//
// One per peer rather than a count of addresses: a peer has exactly one
// endpoint, and the roaming case that needs care on IKEv2 cannot arise
// here -- when a device moves network, WireGuard updates the endpoint on
// the same peer rather than creating a second one.
func (p *Provisioner) SessionCounts() (map[string]int, error) {
	out, err := exec.Command("wg", "show", p.iface, "dump").Output()
	if err != nil {
		// A node whose WireGuard is not running has no sessions to
		// report. Returning an error would be read as "unknown", and the
		// caller logs it rather than assuming zero -- which is right, but
		// on a node that simply does not offer WireGuard it would be
		// noise on every poll.
		return nil, err
	}

	counts := map[string]int{}
	scanner := bufio.NewScanner(bytes.NewReader(out))
	// The first line of `dump` describes the interface itself (private
	// key, public key, listen port, fwmark) rather than a peer.
	first := true
	now := time.Now().Unix()
	for scanner.Scan() {
		if first {
			first = false
			continue
		}
		// peer: pubkey, psk, endpoint, allowed-ips, handshake, rx, tx, keepalive
		fields := strings.Split(scanner.Text(), "\t")
		if len(fields) < 5 {
			continue
		}
		pubKey, endpoint, handshake := fields[0], fields[2], fields[4]
		// A configured peer that has never connected has no endpoint and
		// a zero handshake. Counting those would charge a customer for
		// every node they have a credential on, which after the change
		// described above is all of them.
		if endpoint == "" || endpoint == "(none)" {
			continue
		}
		last, err := strconv.ParseInt(handshake, 10, 64)
		if err != nil || last == 0 {
			continue
		}
		if now-last > int64(handshakeFreshFor.Seconds()) {
			continue
		}
		counts[pubKey] = 1
	}
	return counts, nil
}
