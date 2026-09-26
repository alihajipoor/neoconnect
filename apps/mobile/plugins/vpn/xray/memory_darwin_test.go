package neoxifyxray

import (
	"runtime/debug"
	"testing"
)

// The limits are set in an init(), which is exactly the kind of thing
// that gets dropped in a refactor without anything failing until a
// customer's tunnel dies mid-download. These assert the settings are
// live in the built package, not merely written somewhere.

func TestHeapLimitIsSetForTheExtension(t *testing.T) {
	// -1 reads the current limit without changing it.
	const want = 30 << 20
	if got := debug.SetMemoryLimit(-1); got != want {
		t.Fatalf("heap limit = %d bytes, want %d -- the Network Extension "+
			"ceiling is not being respected", got, want)
	}
}

func TestCollectorIsTighterThanTheDefault(t *testing.T) {
	// SetGCPercent returns the previous value, so setting it to what we
	// expect and reading the result is how the current value is observed.
	const want = 20
	prev := debug.SetGCPercent(want)
	debug.SetGCPercent(prev) // put it back whatever it was
	if prev != want {
		t.Fatalf("GC percent = %d, want %d -- the default of 100 lets the "+
			"heap double, which is what kills the tunnel under load", prev, want)
	}
}
