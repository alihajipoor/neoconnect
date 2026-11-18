package neoxifyxray

import (
	"expvar"
	"runtime/debug"
	"sync"
	"time"
)

// The memory-pressure gate: when the extension's footprint nears what iOS
// kills it at, the TUN inbound stops admitting new work until it falls
// again.
//
// Why a gate and not a cap on connections: what kills the extension is
// memory, and what a connection costs differs by protocol by an order of
// magnitude -- about 350 KiB for Shadowsocks, far less for VLESS -- so any
// fixed count is either too high for one or needlessly low for another.
// An unpaced flood of new connections (360 a second in TestEngineMemory)
// reached 107 MiB on Stealth and 400 MiB on Shadowsocks with nothing to
// stop it; the extension is killed at about 50 MiB.
//
// What closing does: new TCP connections from the phone's apps are
// refused at once with a reset, so the app retries a moment later; a
// packet that would open a new UDP flow is dropped. Lookups (port 53) are
// still admitted: they have their own cap and are gone 2 s after their
// answer, and refusing them would only turn the refused connections into
// failed lookups. Nothing already running is touched. The TUN side reads
// the gate through expvar (patches/ios-memory-gate.patch), because the
// patched xray-core cannot import this package and Android's unpatched
// one must still build against it; there, nothing reads it.
//
// The TUN side also admits new TCP connections at no more than 100 a
// second (neoxify_gate.go): this gate reads memory 20 times a second, and
// a flood opens thousands of connections between two readings -- with the
// gate alone, a flood reached 165 MiB on Shadowsocks before it closed.
//
// The marks, from TestEngineMemoryBudget on the Mac with the iOS patches
// (2026-11-18, three runs): the heaviest normal load there -- a phone
// opening apps on Shadowsocks with the DoH resolver unreachable -- peaks
// at 40.5-42.4 MiB, VLESS over WebSocket at 38.9-39.6, everything else at
// 37 MiB or less; the TCP flood on Shadowsocks, held by the rate, at
// 44.1-44.5. An iPhone was killed at 49.2 MiB. Closing at gateHighWater
// leaves the heaviest normal load 2.6 MiB, and the kill about 5 MiB of
// headroom for what is already in flight. Opening again only below
// gateLowWater, and no sooner than gateMinClosed, so it does not flap
// around one figure.
const (
	gateHighWater = 45 << 20
	gateLowWater  = 39 << 20
	gateMinClosed = 2 * time.Second
	// How often the footprint is read: a system call, not per packet.
	gateSampleEvery = 50 * time.Millisecond
	// How often, while closed, the runtime is asked to give memory back.
	gateReleaseEvery = 3 * time.Second
)

// The names the TUN inbound looks up (patches/ios-memory-gate.patch).
var (
	gateClosedVar  = expvar.NewInt("neoxify.tun.gateClosed")
	gateRefusedVar = expvar.NewInt("neoxify.tun.refused")
)

var gate struct {
	sync.Mutex
	closings     int64
	closedFor    time.Duration
	closedSince  time.Time
	lastReleased time.Time
	stop         chan struct{}
}

func init() {
	startGateHook = startGate
	stopGateHook = stopGate
	gateStatsHook = gateStats
}

// startGate begins sampling. Called by Start; a second call while one is
// running does nothing.
func startGate() {
	gate.Lock()
	defer gate.Unlock()
	if gate.stop != nil {
		return
	}
	// Each run counts its own.
	gate.closings, gate.closedFor = 0, 0
	gateRefusedVar.Set(0)
	gate.stop = make(chan struct{})
	go sampleGate(gate.stop)
}

// stopGate ends sampling and opens the gate, so nothing outlives the
// engine. The counts are kept for the run's last heartbeat.
func stopGate() {
	gate.Lock()
	defer gate.Unlock()
	if gate.stop == nil {
		return
	}
	close(gate.stop)
	gate.stop = nil
	openGateLocked(time.Now())
}

func sampleGate(stop chan struct{}) {
	tick := time.NewTicker(gateSampleEvery)
	defer tick.Stop()
	for {
		select {
		case <-stop:
			return
		case now := <-tick.C:
			fp, _ := footprint()
			if fp >= 0 {
				stepGate(fp, now)
			}
		}
	}
}

// stepGate moves the gate for one reading of the footprint.
func stepGate(fp int64, now time.Time) {
	gate.Lock()
	defer gate.Unlock()
	closed := gateClosedVar.Value() != 0
	switch {
	case !closed && fp >= gateHighWater:
		gateClosedVar.Set(1)
		gate.closings++
		gate.closedSince = now
		releaseLocked(now)
	case closed && fp < gateLowWater && now.Sub(gate.closedSince) >= gateMinClosed:
		openGateLocked(now)
	case closed && now.Sub(gate.lastReleased) >= gateReleaseEvery:
		releaseLocked(now)
	}
}

func openGateLocked(now time.Time) {
	if gateClosedVar.Value() == 0 {
		return
	}
	gate.closedFor += now.Sub(gate.closedSince)
	gateClosedVar.Set(0)
}

// releaseLocked asks the runtime to collect and return what it can --
// the footprint counts pages Go has freed but not yet given back.
func releaseLocked(now time.Time) {
	gate.lastReleased = now
	go debug.FreeOSMemory()
}

// gateStats: how often the gate closed, for how long in all (counting a
// closing still going), and how much it turned away.
func gateStats() (closings, closedMs, refused int64) {
	gate.Lock()
	defer gate.Unlock()
	closedFor := gate.closedFor
	if gateClosedVar.Value() != 0 {
		closedFor += time.Since(gate.closedSince)
	}
	return gate.closings, closedFor.Milliseconds(), gateRefusedVar.Value()
}
