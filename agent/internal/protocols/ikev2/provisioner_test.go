package ikev2

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
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

func TestAnAgentRestartDoesNotBillSATotalsAgain(t *testing.T) {
	// strongSwan keeps running across an agent restart and rekey_time is
	// 0s, so a CHILD_SA's totals can cover a whole connection. A fresh
	// agent process used to report all of it again on its first poll.
	lines := strings.Split(filled(t), "\n")
	firstOnly := lines[0] + "\nlist-sas reply {}\n"
	p, f := withFake(t, firstOnly)
	ctx := context.Background()

	deltas, err := p.StatsSince(ctx)
	if err != nil {
		t.Fatalf("first poll: %v", err)
	}
	if len(deltas) != 0 {
		t.Fatalf("the first poll after a start must be a baseline, got %+v", deltas)
	}

	// The first customer receives 1000 bytes; a second connects after the
	// baseline, and its SA started from zero, so all of it is new.
	f.listSAs = strings.Replace(filled(t), "bytes-out=85956", "bytes-out=86956", 1)
	deltas, err = p.StatsSince(ctx)
	if err != nil {
		t.Fatalf("second poll: %v", err)
	}
	got := map[string][2]uint64{}
	for _, d := range deltas {
		got[d.ExternalUserID] = [2]uint64{d.BytesUp, d.BytesDown}
	}
	if len(got) != 2 || got["nx-user1"] != [2]uint64{0, 1000} || got["nx-user2"] != [2]uint64{62669, 257213} {
		t.Fatalf("expected growth for the first customer and the new SA in full, got %v", got)
	}
}

func TestDisablingAUserEndsOnlyTheirSession(t *testing.T) {
	// The finding: `--terminate --eap-id` is not a swanctl option, so it
	// failed before reaching charon, the failure was swallowed, and a
	// disabled customer stayed connected. With the fake checking options
	// the way swanctl does, the old code terminates nothing here.
	p, f := withFake(t, filled(t))

	if err := p.SetEnabled(context.Background(), "nx-user1", false); err != nil {
		t.Fatalf("SetEnabled(false): %v", err)
	}
	if len(f.terminated) != 1 || f.terminated[0] != "1" {
		t.Fatalf("expected exactly IKE SA 1 terminated, got %v", f.terminated)
	}

	// DELETE_USER takes the same path.
	if err := p.RemoveUser(context.Background(), "nx-user2"); err != nil {
		t.Fatalf("RemoveUser: %v", err)
	}
	if len(f.terminated) != 2 || f.terminated[1] != "2" {
		t.Fatalf("expected IKE SA 2 terminated next, got %v", f.terminated)
	}
}

func TestRemovingAUserWithNoSessionIsNotAnError(t *testing.T) {
	p, f := withFake(t, filled(t))
	if err := p.RemoveUser(context.Background(), "nx-nobody"); err != nil {
		t.Fatalf("RemoveUser: %v", err)
	}
	if len(f.terminated) != 0 {
		t.Fatalf("other customers' sessions were ended: %v", f.terminated)
	}
}

func TestAFailedTerminateIsReported(t *testing.T) {
	// Swallowing this is what let the old bug pass unnoticed: the command
	// was acked as done while the session kept running.
	p, f := withFake(t, filled(t))
	f.terminateErr = errors.New("exit status 1")
	if err := p.SetEnabled(context.Background(), "nx-user1", false); err == nil {
		t.Fatal("a terminate that failed, on a session still up, must fail the command")
	}
}

func TestASessionThatEndedOnItsOwnIsNotAFailure(t *testing.T) {
	// The client hung up between the list and the terminate.
	p, f := withFake(t, filled(t))
	f.terminateErr = errors.New("exit status 1")
	f.onTerminate = func(f *fakeSwanctl) {
		f.listSAs = strings.Split(f.listSAs, "\n")[1] + "\nlist-sas reply {}\n"
	}
	if err := p.SetEnabled(context.Background(), "nx-user1", false); err != nil {
		t.Fatalf("a session that is already gone is not a failure: %v", err)
	}
}

func TestOnlyASuccessfulListIsTheBaseline(t *testing.T) {
	p, f := withFake(t, filled(t))
	ctx := context.Background()

	f.listErr = errors.New("connecting to 'unix:///var/run/charon.vici' failed: No such file or directory")
	if _, err := p.StatsSince(ctx); err == nil {
		t.Fatal("expected the failed list to be reported")
	}
	f.listErr = nil
	deltas, err := p.StatsSince(ctx)
	if err != nil || len(deltas) != 0 {
		t.Fatalf("the first successful list must be the baseline, got %+v, %v", deltas, err)
	}
}
