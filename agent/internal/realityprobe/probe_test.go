package realityprobe

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeConfig(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

// The shape a real node has: several inbounds, only one of them REALITY,
// and the dest buried in its stream settings. Anything that reads the
// first inbound, or assumes ordering, gets this wrong.
func TestDestFromXrayConfigFindsTheRealityInbound(t *testing.T) {
	p := writeConfig(t, `{"inbounds":[
      {"tag":"api-in","port":10085,"protocol":"dokodemo-door"},
      {"tag":"vless-tls-in","streamSettings":{"security":"tls"}},
      {"tag":"vless-in","streamSettings":{"security":"reality",
        "realitySettings":{"dest":"www.helsinki.fi:443"}}},
      {"tag":"shadowsocks-in"}]}`)

	dest, err := DestFromXrayConfig(p)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if dest != "www.helsinki.fi:443" {
		t.Fatalf("got %q", dest)
	}
}

// A node with no REALITY inbound must report nothing, not an error and
// not a guess. The panel reads an empty dest as "did not measure".
func TestDestFromXrayConfigIsEmptyWithoutReality(t *testing.T) {
	p := writeConfig(t, `{"inbounds":[{"tag":"vless-tls-in","streamSettings":{"security":"tls"}}]}`)
	dest, err := DestFromXrayConfig(p)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if dest != "" {
		t.Fatalf("want empty, got %q", dest)
	}
}

func TestDestFromXrayConfigErrorsWhenUnreadable(t *testing.T) {
	if _, err := DestFromXrayConfig(filepath.Join(t.TempDir(), "nope.json")); err == nil {
		t.Fatal("want an error for a missing config")
	}
}

// A REALITY-less or unreadable config must leave the reported dest
// empty. Reporting `Reachable:false` there would be a lie the panel
// would alert on -- there is nothing to reach.
func TestProbeReportsNothingWithoutAConfig(t *testing.T) {
	p := New(filepath.Join(t.TempDir(), "absent.json"), time.Hour)
	p.probeOnce(context.Background())

	got := p.Snapshot()
	if got.Dest != "" || got.Reachable {
		t.Fatalf("want a zero Result, got %+v", got)
	}
}

// The failing half of Reachable, on a port nothing is listening on.
// Uses a closed local port so this is immediate rather than a timeout.
func TestReachableIsFalseWhenNothingAnswers(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	_ = l.Close() // now guaranteed closed, and nothing else has taken it yet

	start := time.Now()
	if Reachable(context.Background(), addr) {
		t.Fatal("a closed port reported reachable")
	}
	if elapsed := time.Since(start); elapsed > DialTimeout {
		t.Fatalf("took %s, longer than the dial budget", elapsed)
	}
}

// A cancelled context must not leave the probe dialling. This is the
// path taken when the agent is shutting down.
func TestReachableHonoursContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	// 203.0.113.0/24 is TEST-NET-3: guaranteed unroutable, so without
	// the cancellation this would sit until DialTimeout.
	start := time.Now()
	if Reachable(ctx, "203.0.113.1:443") {
		t.Fatal("reported reachable on a cancelled context")
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("cancellation ignored: took %s", elapsed)
	}
}

func TestHostOfStripsThePort(t *testing.T) {
	for in, want := range map[string]string{
		"www.free.fr:443": "www.free.fr",
		"www.free.fr":     "www.free.fr",
	} {
		if got := HostOf(in); got != want {
			t.Fatalf("HostOf(%q) = %q, want %q", in, got, want)
		}
	}
}

// NOTE: the *succeeding* half of Reachable is deliberately not unit
// tested. It requires a dest presenting a publicly trusted certificate
// over TLS 1.3, and faking that means either skipping verification or
// injecting a root -- both of which would test a weakened version of the
// check rather than the one that ships. It is exercised for real by the
// fleet audit (docs/journal/log.md, 2026-08-31) instead.
