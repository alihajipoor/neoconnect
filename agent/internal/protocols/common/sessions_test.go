package common

import (
	"fmt"
	"math"
	"testing"
	"time"
)

// Every way an engine here prints a client's address, and the one form
// the backend gets for each.
func TestNormalizeAddress(t *testing.T) {
	cases := []struct {
		raw  string
		want string
		ok   bool
	}{
		{"203.0.113.9", "203.0.113.9", true},
		{"203.0.113.9:51234", "203.0.113.9", true},  // Xray, OpenVPN, WireGuard
		{"[2001:db8::7]", "2001:db8::7", true},      // Xray's access log
		{"[2001:db8::7]:5000", "2001:db8::7", true}, // WireGuard's endpoint
		{"2001:db8::7", "2001:db8::7", true},        // IKEv2, OpenVPN
		{"2001:DB8:0:0::7", "2001:db8::7", true},    // one address, one spelling
		{"[::ffff:203.0.113.9]:443", "203.0.113.9", true},
		{" 198.51.100.7 ", "198.51.100.7", true},
		{"(none)", "", false}, // WireGuard, a peer that never connected
		{"", "", false},
		{"example.com:443", "", false},
		{"[fe80::1%eth0]:51820", "", false},
		{"udp4:203.0.113.9:1194", "", false},
	}
	for _, c := range cases {
		got, ok := NormalizeAddress(c.raw)
		if got != c.want || ok != c.ok {
			t.Errorf("NormalizeAddress(%q) = %q, %v; want %q, %v", c.raw, got, ok, c.want, c.ok)
		}
	}
}

// One entry per address at its newest sighting, newest first, ties in
// address order, nothing that is not an IP.
func TestRecentSourcesDedupesAndOrders(t *testing.T) {
	got := RecentSources([]SourceAddress{
		{Address: "198.51.100.7:4000", SecondsAgo: 30},
		{Address: "(none)", SecondsAgo: 0},
		{Address: "[2001:db8::7]:5000", SecondsAgo: 12},
		{Address: "198.51.100.7:4001", SecondsAgo: 3},
		{Address: "203.0.113.20", SecondsAgo: 12},
	})
	want := []SourceAddress{
		{Address: "198.51.100.7", SecondsAgo: 3},
		{Address: "2001:db8::7", SecondsAgo: 12},
		{Address: "203.0.113.20", SecondsAgo: 12},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("got %v, want %v", got, want)
	}

	if got := RecentSources([]SourceAddress{{Address: "(none)"}}); got != nil {
		t.Fatalf("nothing usable should be nil, got %v", got)
	}
}

// At most MaxSources, and the ones kept are the newest.
func TestRecentSourcesKeepsTheNewest(t *testing.T) {
	var in []SourceAddress
	for i := 11; i >= 0; i-- {
		in = append(in, SourceAddress{Address: fmt.Sprintf("203.0.113.%d", i), SecondsAgo: uint32(i)})
	}
	got := RecentSources(in)
	if len(got) != MaxSources {
		t.Fatalf("expected %d, got %d: %v", MaxSources, len(got), got)
	}
	for i, s := range got {
		if s.SecondsAgo != uint32(i) {
			t.Fatalf("expected the newest %d, newest first, got %v", MaxSources, got)
		}
	}
}

func TestAgo(t *testing.T) {
	cases := map[time.Duration]uint32{
		-5 * time.Second:        0, // the clock stepped back
		0:                       0,
		1500 * time.Millisecond: 1,
		40 * time.Second:        40,
		1 << 62:                 math.MaxUint32,
	}
	for d, want := range cases {
		if got := Ago(d); got != want {
			t.Errorf("Ago(%v) = %d, want %d", d, got, want)
		}
	}
}
