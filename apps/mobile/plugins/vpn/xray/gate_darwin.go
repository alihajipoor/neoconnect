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
// failed lookups. Nothing already running is touched -- unless memory
// stays at the high mark (gateShedAfter), when the idlest connections are
// closed (gateShed) until it falls. The TUN side reads
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
// at 42.1-42.8 MiB, VLESS over WebSocket at 39.6-41.5, everything else at
// 40 MiB or less; the floods, held by the rate, at 40.7 or less. An
// iPhone was killed at 49.2 MiB. Closing at gateHighWater leaves the
// heaviest normal load 3 MiB, and the kill about 4 MiB of headroom for
// what is already in flight. Under these loads it never closed.
//
// A closed gate heals by itself. It opens again once it has been closed
// gateMinClosed and the footprint is gateReopenStep under the high mark --
// not at a low mark far below, which long-lived connections could keep the
// footprint above for minutes while the heaviest normal load sits there
// anyway. If the footprint stays at the high mark for gateShedAfter, the
// idlest connections are closed, a share at a time every gateShedEvery,
// until it falls. So the longest a customer cannot open a new connection
// is about gateShedAfter plus a few shedding rounds: seconds.
const (
	gateHighWater  = 46 << 20
	gateReopenStep = 1 << 20
	gateMinClosed  = time.Second
	gateShedAfter  = 3 * time.Second
	gateShedEvery  = 2 * time.Second
	// Memory pressure: from gatePressureHigh until under gatePressureLow,
	// new TCP connections are admitted at 20 a second rather than 100
	// (neoxify_gate.go), so the gate is rarely reached, and opening it
	// again lets no burst in. The heaviest normal loads sit near 42 MiB and
	// open few connections; browsing there is slowed, not refused.
	gatePressureHigh = 40 << 20
	gatePressureLow  = 38 << 20
	// How often the footprint is read: a system call, not per packet.
	gateSampleEvery = 50 * time.Millisecond
	// How often, while closed, the runtime is asked to give memory back.
	gateReleaseEvery = 3 * time.Second
)

// The names the TUN inbound looks up and publishes
// (patches/ios-memory-gate.patch).
var (
	gateClosedVar   = expvar.NewInt("neoxify.tun.gateClosed")
	gateRefusedVar  = expvar.NewInt("neoxify.tun.refused")
	gateShedVar     = expvar.NewInt("neoxify.tun.shed")
	gatePressureVar = expvar.NewInt("neoxify.tun.pressure")
)

// gateShed closes the idlest connections the TUN inbound holds and says
// how many; the patched xray-core publishes it as expvar
// "neoxify.tun.shedIdlest". A variable so tests can stand in for it.
var gateShed = func() int64 {
	if f, ok := expvar.Get("neoxify.tun.shedIdlest").(expvar.Func); ok {
		if n, ok := f().(int64); ok {
			return n
		}
	}
	return 0
}

var gate struct {
	sync.Mutex
	closings     int64
	closedFor    time.Duration
	closedSince  time.Time
	highSince    time.Time // when the footprint last rose to the high mark; zero below it
	lastReleased time.Time
	lastShed     time.Time
	stop         chan struct{}
}

func init() {
	startGateHook = startGate
	stopGateHook = stopGate
	gateStatsHook = gateStats
}

// startGate begins sampling. Called by Start; a second call while one is
// running does nothing. Each run starts open and counts its own: a run
// must never inherit a closed gate from the one before.
func startGate() {
	gate.Lock()
	defer gate.Unlock()
	if gate.stop != nil {
		return
	}
	resetGateLocked()
	gate.stop = make(chan struct{})
	go sampleGate(gate.stop)
}

func resetGateLocked() {
	gateClosedVar.Set(0)
	gateRefusedVar.Set(0)
	gateShedVar.Set(0)
	gatePressureVar.Set(0)
	gate.closings, gate.closedFor = 0, 0
	gate.closedSince, gate.highSince, gate.lastReleased, gate.lastShed = time.Time{}, time.Time{}, time.Time{}, time.Time{}
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
	gatePressureVar.Set(0)
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
				stepGate(stop, fp, now)
			}
		}
	}
}

// stepGate moves the gate for one reading of the footprint, taken by the
// sampler whose stop channel is stop. A reading from a sampler that is no
// longer the running one -- read as the engine stopped -- does nothing, or
// it could close the gate after stopGate opened it.
func stepGate(stop chan struct{}, fp int64, now time.Time) {
	gate.Lock()
	defer gate.Unlock()
	if stop == nil || gate.stop != stop {
		return
	}
	switch {
	case fp >= gatePressureHigh:
		gatePressureVar.Set(1)
	case fp < gatePressureLow:
		gatePressureVar.Set(0)
	}
	if fp >= gateHighWater {
		if gate.highSince.IsZero() {
			gate.highSince = now
		}
	} else {
		gate.highSince = time.Time{}
	}
	closed := gateClosedVar.Value() != 0
	switch {
	case !closed && fp >= gateHighWater:
		gateClosedVar.Set(1)
		gate.closings++
		gate.closedSince = now
		releaseLocked(now)
	case closed && fp < gateHighWater-gateReopenStep && now.Sub(gate.closedSince) >= gateMinClosed:
		openGateLocked(now)
	case closed && !gate.highSince.IsZero() && now.Sub(gate.highSince) >= gateShedAfter &&
		now.Sub(gate.lastShed) >= gateShedEvery:
		gate.lastShed = now
		gateShedVar.Add(gateShed())
		releaseLocked(now)
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
// closing still going), how much it turned away, and how many connections
// it closed to shed load.
func gateStats() (*GateRecord, bool) {
	gate.Lock()
	defer gate.Unlock()
	closedFor := gate.closedFor
	if gateClosedVar.Value() != 0 {
		closedFor += time.Since(gate.closedSince)
	}
	return &GateRecord{
		Closings: gate.closings,
		ClosedMs: closedFor.Milliseconds(),
		Refused:  gateRefusedVar.Value(),
		Shed:     gateShedVar.Value(),
		Closed:   gateClosedVar.Value() != 0,
	}, true
}
