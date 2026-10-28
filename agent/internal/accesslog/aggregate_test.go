package accesslog

import (
	"fmt"
	"math"
	"testing"
	"time"
)

func entry(user, host string, port uint32, at time.Time) Entry {
	return Entry{At: at, User: user, InboundTag: "vless-in", Network: "tcp", Host: host, Port: port}
}

func TestAggregatorCountsPerKey(t *testing.T) {
	t0 := time.Date(2026, 10, 28, 8, 0, 0, 0, time.UTC)
	a := NewAggregator(100, 0)

	// One page load: many connections to one place.
	for i := 0; i < 5; i++ {
		a.Add(entry("u1", "example.com", 443, t0.Add(time.Duration(i)*time.Second)))
	}
	// Logged out of order: first and last must still be the extremes.
	a.Add(entry("u1", "example.com", 443, t0.Add(-time.Second)))
	// Same host, another port, network, inbound or user: all separate.
	a.Add(entry("u1", "example.com", 80, t0))
	udp := entry("u1", "example.com", 443, t0)
	udp.Network = "udp"
	a.Add(udp)
	trojan := entry("u1", "example.com", 443, t0)
	trojan.InboundTag = "trojan-in"
	a.Add(trojan)
	a.Add(entry("u2", "example.com", 443, t0))

	dests, dropped := a.Take()
	if dropped != 0 {
		t.Fatalf("dropped = %d, want 0", dropped)
	}
	if len(dests) != 5 {
		t.Fatalf("got %d destinations, want 5: %+v", len(dests), dests)
	}
	var main *Destination
	for i := range dests {
		d := &dests[i]
		if d.User == "u1" && d.Port == 443 && d.Network == "tcp" && d.InboundTag == "vless-in" {
			main = d
		}
	}
	if main == nil {
		t.Fatal("u1 example.com:443 missing")
	}
	if main.Count != 6 {
		t.Errorf("count = %d, want 6", main.Count)
	}
	if !main.FirstSeen.Equal(t0.Add(-time.Second)) || !main.LastSeen.Equal(t0.Add(4*time.Second)) {
		t.Errorf("first/last = %s/%s", main.FirstSeen, main.LastSeen)
	}
	// Sorted by user first, so one user's rows stay together when a
	// window is split across messages.
	if dests[len(dests)-1].User != "u2" {
		t.Errorf("not sorted by user: %+v", dests)
	}

	// Take starts the next window empty.
	if dests, dropped := a.Take(); len(dests) != 0 || dropped != 0 {
		t.Fatalf("second Take = %d dests, %d dropped; want an empty window", len(dests), dropped)
	}
}

// Past the cap, known keys keep counting and new ones are dropped -- and
// counted as dropped, so the window says it is incomplete.
func TestAggregatorCapCountsTheRestAsDropped(t *testing.T) {
	t0 := time.Date(2026, 10, 28, 8, 0, 0, 0, time.UTC)
	a := NewAggregator(3, 0)

	for i := 0; i < 3; i++ {
		a.Add(entry("u1", fmt.Sprintf("198.51.100.%d", i), 443, t0))
	}
	// A spray of new destinations, as a scanner would make.
	for i := 10; i < 17; i++ {
		a.Add(entry("u1", fmt.Sprintf("198.51.100.%d", i), 443, t0))
	}
	// An already-held key still counts after the cap is reached.
	a.Add(entry("u1", "198.51.100.0", 443, t0.Add(time.Second)))

	if a.Len() != 3 {
		t.Fatalf("held %d keys, cap is 3", a.Len())
	}
	dests, dropped := a.Take()
	if dropped != 7 {
		t.Errorf("dropped = %d, want 7", dropped)
	}
	var total uint64
	for _, d := range dests {
		total += uint64(d.Count)
		if d.Host == "198.51.100.0" && d.Count != 2 {
			t.Errorf("held key count = %d, want 2", d.Count)
		}
	}
	if total+dropped != 11 {
		t.Errorf("counted %d + dropped %d != 11 lines added", total, dropped)
	}

	// The cap is per window: the next one starts with room again.
	a.Add(entry("u1", "198.51.100.99", 443, t0))
	if dests, dropped := a.Take(); len(dests) != 1 || dropped != 0 {
		t.Fatalf("next window: %d dests, %d dropped", len(dests), dropped)
	}
}

// One user spraying new destinations is held to their own share, so the
// rest of the node's room is still there for everyone else -- the
// failure this prevents is a scanner on one account blanking every other
// account's history on the same node.
func TestAggregatorPerUserCapLeavesRoomForOthers(t *testing.T) {
	t0 := time.Date(2026, 10, 28, 8, 0, 0, 0, time.UTC)
	a := NewAggregator(10, 3)

	for i := 0; i < 50; i++ {
		a.Add(entry("scanner", fmt.Sprintf("198.51.100.%d", i), 443, t0))
	}
	// A destination the scanner already holds still counts past its cap.
	a.Add(entry("scanner", "198.51.100.0", 443, t0.Add(time.Second)))
	for i := 0; i < 3; i++ {
		a.Add(entry("u2", fmt.Sprintf("site%d.example", i), 443, t0))
	}
	a.Add(entry("u3", "example.org", 443, t0))

	dests, dropped := a.Take()
	if dropped != 47 {
		t.Errorf("dropped = %d, want the scanner's 47 lines past its share", dropped)
	}
	per := map[string]int{}
	var total uint64
	for _, d := range dests {
		per[d.User]++
		total += uint64(d.Count)
	}
	if per["scanner"] != 3 || per["u2"] != 3 || per["u3"] != 1 {
		t.Errorf("held per user = %v, want scanner 3, u2 3, u3 1", per)
	}
	if total+dropped != 55 {
		t.Errorf("counted %d + dropped %d != 55 lines added", total, dropped)
	}

	// The share is per window, like the node's cap.
	a.Add(entry("scanner", "198.51.100.200", 443, t0))
	if dests, dropped := a.Take(); len(dests) != 1 || dropped != 0 {
		t.Fatalf("next window: %d dests, %d dropped", len(dests), dropped)
	}
}

func TestAggregatorCountSaturates(t *testing.T) {
	t0 := time.Date(2026, 10, 28, 8, 0, 0, 0, time.UTC)
	a := NewAggregator(10, 0)
	e := entry("u1", "example.com", 443, t0)
	a.Add(e)
	for _, tl := range a.counts {
		tl.count = math.MaxUint32 - 1
	}
	a.Add(e)
	a.Add(e)
	dests, _ := a.Take()
	if dests[0].Count != math.MaxUint32 {
		t.Fatalf("count = %d, want it held at MaxUint32 rather than wrapped", dests[0].Count)
	}
}

func TestBatchLines(t *testing.T) {
	b := Batch{
		Destinations: []Destination{{Count: 3}, {Count: 4}},
		Dropped:      5,
	}
	if got := b.Lines(); got != 12 {
		t.Fatalf("Lines() = %d, want 12", got)
	}
}
