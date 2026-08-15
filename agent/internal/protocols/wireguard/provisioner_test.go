package wireguard

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// build returns a provisioner whose two environment signals are both
// controlled, so every case below is deterministic on any machine. The
// earlier version of this file consulted the real /usr/bin/wg and
// skipped when it was absent, which meant the case it existed to cover
// never ran anywhere.
func build(t *testing.T, ifacePresent, toolInstalled bool) *Provisioner {
	t.Helper()
	dir := t.TempDir()
	if ifacePresent {
		if err := os.Mkdir(filepath.Join(dir, "wg0"), 0o755); err != nil {
			t.Fatalf("could not create the stand-in interface: %v", err)
		}
	}
	p := New("wg0")
	p.sysNetDir = dir
	p.lookPath = func(string) (string, error) {
		if toolInstalled {
			return "/usr/bin/wg", nil
		}
		return "", errors.New("executable file not found in $PATH")
	}
	return p
}

func TestPollsAreSilentWhereWireguardIsNotServed(t *testing.T) {
	// singapore-1's case: serves OpenVPN and IKEv2 only, so no wg0 and no
	// `wg` tool. It was logging an error from both polls twice a minute
	// about a protocol it was never asked to serve.
	p := build(t, false, false)

	deltas, err := p.StatsSince(context.Background())
	if err != nil {
		t.Fatalf("expected no error where WireGuard is not served, got %v", err)
	}
	if len(deltas) != 0 {
		t.Fatalf("expected no deltas, got %d", len(deltas))
	}

	counts, err := p.SessionCounts()
	if err != nil {
		t.Fatalf("expected no error from SessionCounts, got %v", err)
	}
	if len(counts) != 0 {
		t.Fatalf("expected no session counts, got %d", len(counts))
	}
}

func TestAnExistingInterfaceKeepsFailuresLoud(t *testing.T) {
	// The case the silence must not swallow. If wg0 exists then WireGuard
	// is set up here, and a failing poll means usage going uncounted
	// while peers keep transferring -- an unmetered path around every
	// data cap. True even if the tool has gone missing, which is exactly
	// how that breakage would look.
	if build(t, true, true).notServingWireguard() {
		t.Error("an existing interface must never be treated as 'not served'")
	}
	if build(t, true, false).notServingWireguard() {
		t.Error("an existing interface with the tool missing is a fault, not an absence")
	}
}

func TestInstalledButInterfaceDownStillReports(t *testing.T) {
	// Both conditions are required, not the interface alone: a node with
	// WireGuard installed whose interface is down is a fault worth
	// seeing. This is the case that used to skip everywhere.
	if build(t, false, true).notServingWireguard() {
		t.Error("with wg installed, a missing interface should report rather than go silent")
	}
}
