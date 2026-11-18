package neoxifyxray

import (
	"testing"
	"time"
)

// The gate's rules, without an engine or a sampler: the readings are made
// up, and a stop channel stands in for a running sampler.
func runningGate(t *testing.T) chan struct{} {
	t.Helper()
	stopGate()
	gate.Lock()
	resetGateLocked()
	stop := make(chan struct{})
	gate.stop = stop
	gate.Unlock()
	t.Cleanup(stopGate)
	return stop
}

func closed() bool { return gateClosedVar.Value() != 0 }

func TestMemoryGateClosesAtTheHighMarkAndHealsJustUnderIt(t *testing.T) {
	stop := runningGate(t)
	t0 := time.Now()
	at := func(d time.Duration) time.Time { return t0.Add(d) }

	stepGate(stop, gateHighWater-1, at(0))
	if closed() {
		t.Fatal("closed below the high mark")
	}
	stepGate(stop, gateHighWater, at(100*time.Millisecond))
	if !closed() {
		t.Fatal("open at the high mark")
	}
	// Under the high mark, but not by gateReopenStep: stays closed.
	stepGate(stop, gateHighWater-gateReopenStep/2, at(2*time.Second))
	if !closed() {
		t.Fatal("opened less than gateReopenStep under the mark")
	}
	// Far enough under, but sooner than gateMinClosed: stays closed.
	gate.Lock()
	gate.closedSince = at(1500 * time.Millisecond)
	gate.Unlock()
	stepGate(stop, gateHighWater-2*gateReopenStep, at(2*time.Second))
	if !closed() {
		t.Fatal("opened before gateMinClosed")
	}
	// Both: open -- the heaviest normal load sits above a low mark far
	// below, and must not hold the gate shut.
	stepGate(stop, gateHighWater-2*gateReopenStep, at(2500*time.Millisecond))
	if closed() {
		t.Fatal("still closed just under the high mark after gateMinClosed")
	}
	g, ok := gateStats()
	if !ok || g.Closings != 1 || g.ClosedMs != 1000 {
		t.Fatalf("stats %+v; want one closing of 1000 ms", g)
	}
}

func TestMemoryGateShedsTheIdlestWhenMemoryStaysHigh(t *testing.T) {
	stop := runningGate(t)
	var rounds int
	saved := gateShed
	gateShed = func() int64 { rounds++; return 5 }
	t.Cleanup(func() { gateShed = saved })
	t0 := time.Now()
	for d := time.Duration(0); d <= 8*time.Second; d += 250 * time.Millisecond {
		stepGate(stop, gateHighWater+1, t0.Add(d))
	}
	// High from 0: the first round at gateShedAfter, then every
	// gateShedEvery -- 3 s, 5 s, 7 s.
	if rounds != 3 {
		t.Fatalf("%d shedding rounds in 8 s at the high mark, want 3", rounds)
	}
	if g, _ := gateStats(); g.Shed != 15 {
		t.Fatalf("shed %d, want 15", g.Shed)
	}
	// Under the mark, it stops shedding.
	stepGate(stop, gateHighWater-1, t0.Add(9*time.Second))
	stepGate(stop, gateHighWater-1, t0.Add(12*time.Second))
	if rounds != 3 {
		t.Fatalf("shed again under the high mark")
	}
}

// A sampler that read the footprint as the engine stopped must not close
// the gate behind stopGate, and the next run must start open.
func TestMemoryGateIgnoresAStoppedSamplerAndStartsEachRunOpen(t *testing.T) {
	stop := runningGate(t)
	stepGate(stop, gateHighWater+1, time.Now())
	if !closed() {
		t.Fatal("not closed at the high mark")
	}
	stopGate()
	if closed() {
		t.Fatal("left closed when the engine stopped")
	}
	// The stopped sampler's last reading, arriving late.
	stepGate(stop, gateHighWater+1, time.Now())
	if closed() {
		t.Fatal("a stopped sampler closed the gate")
	}
	// Left closed some other way, the next run still starts open.
	gateClosedVar.Set(1)
	startGate()
	if closed() {
		t.Fatal("a run started with the gate closed")
	}
	if g, _ := gateStats(); g.Closings != 0 || g.Refused != 0 {
		t.Fatalf("a run started with the last one's counts: %+v", g)
	}
}
