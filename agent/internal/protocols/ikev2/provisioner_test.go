package ikev2

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// A path that cannot exist, so these tests never depend on whether the
// machine running them happens to have strongSwan installed.
const missingSwanctl = "/nonexistent/neoxify-test/swanctl"

func TestStatsSinceIsSilentWhereIkev2IsNotServed(t *testing.T) {
	// A relay or Xray-only node: no IKEv2 user has ever been provisioned
	// and strongSwan is not installed. This provisioner is still
	// registered there on purpose, so without this the 30s stats poll
	// reported an error twice a minute forever about a protocol the node
	// was never asked to serve. Observed on ir1.
	p := New(filepath.Join(t.TempDir(), "users.conf"), missingSwanctl)

	deltas, err := p.StatsSince(context.Background())
	if err != nil {
		t.Fatalf("expected no error on a node that does not serve IKEv2, got %v", err)
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

func TestStatsSinceStaysLoudWhenUsersExistButStrongSwanIsGone(t *testing.T) {
	// The case the silence above must not swallow. A node that really
	// does serve IKEv2 and has lost strongSwan is not quiet -- its
	// customers' usage stops being counted while their sessions carry on,
	// which is an unmetered path around every data cap. It has
	// provisioned users, and that is what keeps the error.
	p := New(filepath.Join(t.TempDir(), "users.conf"), missingSwanctl)
	p.users["customer-1"] = "secret"

	if _, err := p.StatsSince(context.Background()); err == nil {
		t.Fatal("expected StatsSince to report the missing engine when users are provisioned")
	}
	if _, err := p.SessionCounts(); err == nil {
		t.Fatal("expected SessionCounts to report the missing engine when users are provisioned")
	}
}

func TestSwanctlAvailableResolvesPathsAndBareNames(t *testing.T) {
	// A configured path has to be stat'ed and a bare name looked up on
	// PATH, matching how exec.Command resolves it. Checking only PATH
	// would call a node started with -ikev2-swanctl=/usr/sbin/swanctl
	// unavailable; stat'ing a bare name would look in the working
	// directory.
	dir := t.TempDir()
	present := filepath.Join(dir, "swanctl")
	// Only its existence is checked, so the contents do not matter.
	if err := os.WriteFile(present, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatalf("could not create the stand-in binary: %v", err)
	}

	if !New("x", present).swanctlAvailable() {
		t.Error("an explicit path that exists should be available")
	}
	if New("x", filepath.Join(dir, "absent")).swanctlAvailable() {
		t.Error("an explicit path that does not exist should be unavailable")
	}
	// Bare name that is certainly not on PATH.
	if New("x", "neoxify-definitely-not-a-real-binary").swanctlAvailable() {
		t.Error("a bare name not on PATH should be unavailable")
	}
}
