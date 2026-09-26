package neoxifyxray

import "runtime/debug"

// Keeping the Go heap inside the Network Extension's memory ceiling.
//
// On Android this package runs in the app's own process and has a normal
// application heap. On iOS the identical code runs inside
// NEPacketTunnelProvider, which the system caps -- 50MB on our
// deployment target, shared with the Swift side and the system
// frameworks in the same process. Cross it and the extension is not
// slowed down or warned: it is killed outright, and the customer sees
// the VPN silently disconnect.
//
// Go's default collector lets the live heap roughly double before it
// runs. That is the right trade on a server and the wrong one here: the
// workload that grows the heap fastest is sustained throughput, so the
// moment most likely to kill the tunnel is the moment the customer is
// actually using it hard. Reported from the field as "connect, run a
// speed test, come back and it has disconnected" -- and the protocol
// that never reproduced it was Built-in, which is IKEv2 through iOS's
// own VPN client and therefore the one protocol with no extension and no
// ceiling over it. That asymmetry is what identified this.
//
// Two settings, doing different jobs:
//
//   - SetMemoryLimit is a soft limit. As the heap approaches it the
//     collector runs harder, and Go will exceed it rather than deadlock
//     if live data genuinely needs more. 30MB leaves the Swift side and
//     the system their share of the 50MB rather than spending it all
//     here.
//   - SetGCPercent bounds how far the heap runs ahead between
//     collections while it is still well below the limit, which is where
//     a throughput burst would otherwise do its growing. 20 rather than
//     the default 100: collecting more often costs CPU, and a tunnel
//     that is alive and slightly busier is worth more than one that is
//     fast until it dies.
//
// Deliberately not a _ios.go file. This package is also built for macOS
// in tests, and a filename constraint beats a build tag in this
// codebase -- see wireguard_darwin.go, where getting that backwards
// meant the file was silently excluded.
func init() {
	debug.SetMemoryLimit(30 << 20)
	debug.SetGCPercent(20)
}
