package neoxifyxray

import (
	"testing"
	"time"
)

// The gate's own rules, without an engine: closes at the high mark, stays
// closed until below the low mark and at least gateMinClosed, counts what
// it did, and opens when the engine stops.
func TestMemoryGateOpensAndClosesOnItsMarks(t *testing.T) {
	// As startGate leaves it, without the sampler, whose real readings
	// would race the made-up ones here.
	gate.Lock()
	gate.closings, gate.closedFor, gate.stop = 0, 0, make(chan struct{})
	gate.Unlock()
	gateRefusedVar.Set(0)
	defer stopGate()
	t0 := time.Now()
	at := func(d time.Duration) time.Time { return t0.Add(d) }

	stepGate(gateHighWater-1, at(0))
	if gateClosedVar.Value() != 0 {
		t.Fatal("closed below the high mark")
	}
	stepGate(gateHighWater, at(100*time.Millisecond))
	if gateClosedVar.Value() != 1 {
		t.Fatal("open at the high mark")
	}
	// Between the marks: stays closed.
	stepGate(gateLowWater+1, at(5*time.Second))
	if gateClosedVar.Value() != 1 {
		t.Fatal("opened above the low mark")
	}
	// Below the low mark, but too soon after closing: stays closed.
	gate.Lock()
	gate.closedSince = at(time.Second)
	gate.Unlock()
	stepGate(gateLowWater-1, at(2*time.Second))
	if gateClosedVar.Value() != 1 {
		t.Fatal("opened before gateMinClosed")
	}
	stepGate(gateLowWater-1, at(4*time.Second))
	if gateClosedVar.Value() != 0 {
		t.Fatal("still closed below the low mark")
	}
	closings, closedMs, _ := gateStats()
	if closings != 1 || closedMs != 3000 {
		t.Fatalf("closings %d, closed %d ms; want 1 and 3000", closings, closedMs)
	}

	// Closed when the engine stops: opened, and the time counted.
	stepGate(gateHighWater+1, time.Now())
	stopGate()
	if gateClosedVar.Value() != 0 {
		t.Fatal("left closed after the engine stopped")
	}
	if closings, _, _ := gateStats(); closings != 2 {
		t.Fatalf("closings %d, want 2", closings)
	}
}
