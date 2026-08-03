package shaper

import (
	"context"
	"strings"
	"testing"
)

// recorder captures the tc invocations instead of running them, so the
// argument lists can be asserted without a Linux box or root.
type recorder struct{ calls []string }

func (r *recorder) run(_ context.Context, name string, args ...string) error {
	r.calls = append(r.calls, name+" "+strings.Join(args, " "))
	return nil
}

func (r *recorder) matching(substr string) []string {
	var out []string
	for _, c := range r.calls {
		if strings.Contains(c, substr) {
			out = append(out, c)
		}
	}
	return out
}

func newTest() (*Shaper, *recorder) {
	rec := &recorder{}
	// Built through the real constructor, not a struct literal: a literal
	// left the IFB device name empty and the upload assertions silently
	// matched nothing rather than failing loudly.
	return NewWithRunner("wg0", rec.run), rec
}

func TestUncappedUserIsLeftCompletelyAlone(t *testing.T) {
	// The whole point of the feature is slowing down the customers it is
	// told to. A plan with no limits must install no class and no filter,
	// not a very high one -- otherwise every uncapped user pays queueing
	// cost for nothing.
	s, rec := newTest()
	if err := s.Apply(context.Background(), "10.66.0.5/32", 0, 0); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if got := rec.matching("class replace"); len(got) != 0 {
		t.Errorf("expected no class to be created, got %v", got)
	}
	if got := rec.matching("filter add"); len(got) != 0 {
		t.Errorf("expected no filter to be created, got %v", got)
	}
}

func TestOneDirectionCappedLeavesTheOtherUnlimited(t *testing.T) {
	s, rec := newTest()
	if err := s.Apply(context.Background(), "10.66.0.5", 100, 0); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if got := rec.matching("class replace"); len(got) != 1 {
		t.Errorf("expected the download class, got %v", got)
	}
	if got := rec.matching("dev ifb-wg0 protocol ip parent 1:"); len(got) != 0 {
		t.Errorf("upload was left uncapped, so nothing should be shaped on the ifb: %v", got)
	}
}

func TestDownloadMatchesDestinationAndUploadMatchesSource(t *testing.T) {
	// Getting these backwards would cap the wrong direction, which is the
	// kind of bug that looks like it works until someone measures it.
	s, rec := newTest()
	if err := s.Apply(context.Background(), "10.66.0.7/32", 100, 20); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	down := rec.matching("filter add dev wg0 protocol ip parent 1:")
	if len(down) != 1 || !strings.Contains(down[0], "match ip dst 10.66.0.7/32") {
		t.Errorf("download filter should match the customer as destination, got %v", down)
	}
	// Upload is shaped on the IFB device rather than policed on ingress:
	// policing measured 12.3 Mbit/s against a 20 Mbit/s cap, because it
	// drops instead of queueing and TCP settles well under the rate.
	up := rec.matching("filter add dev ifb-wg0 protocol ip parent 1:")
	if len(up) != 1 || !strings.Contains(up[0], "match ip src 10.66.0.7/32") {
		t.Errorf("upload filter should match the customer as source on the ifb, got %v", up)
	}
	upClass := rec.matching("class replace dev ifb-wg0")
	if len(upClass) != 1 || !strings.Contains(upClass[0], "rate 20mbit") {
		t.Errorf("upload should be shaped at the upload rate, got %v", upClass)
	}
	if got := rec.matching("police"); len(got) != 0 {
		t.Errorf("policing should be gone entirely, got %v", got)
	}
	if !strings.Contains(down[0], "flowid") {
		t.Errorf("download filter must point at its class, got %v", down)
	}
}

func TestReapplyingReplacesRatherThanStacking(t *testing.T) {
	// An admin editing a plan re-applies the cap. Without the delete first,
	// the old filter stays and the customer gets whichever tc matches
	// first -- very likely the stale rate.
	s, rec := newTest()
	if err := s.Apply(context.Background(), "10.66.0.5", 50, 10); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if got := rec.matching("filter del"); len(got) == 0 {
		t.Error("expected the previous rules to be removed before adding new ones")
	}
}

func TestHandlesAreDerivedFromTheAddressSoRemovalNeedsNoState(t *testing.T) {
	// The agent can restart between provisioning a user and removing them.
	// If the handle were remembered rather than computed, teardown after a
	// restart would leave the customer shaped forever.
	first := classID(mustIP(t, "10.66.0.5"))
	again := classID(mustIP(t, "10.66.0.5"))
	if first != again {
		t.Errorf("same address gave different handles: %d then %d", first, again)
	}
	if classID(mustIP(t, "10.66.0.5")) == classID(mustIP(t, "10.66.1.5")) {
		t.Error("addresses differing in the third octet collided")
	}
}

func TestNeverCollidesWithTheDefaultClass(t *testing.T) {
	// 0xFFFF is the catch-all every uncapped user falls into. A customer
	// landing on it would silently share one class with everyone else.
	if got := classID(mustIP(t, "10.66.255.255")); got == 0xFFFF || got == 0 {
		t.Errorf("address mapped onto a reserved handle: %#x", got)
	}
}

func TestRejectsSomethingThatIsNotATunnelAddress(t *testing.T) {
	s, _ := newTest()
	for _, bad := range []string{"", "not-an-ip", "fd00::1"} {
		if err := s.Apply(context.Background(), bad, 10, 10); err == nil {
			t.Errorf("expected %q to be rejected", bad)
		}
	}
}

func mustIP(t *testing.T, s string) []byte {
	t.Helper()
	ip, err := parseAddress(s)
	if err != nil {
		t.Fatalf("parseAddress(%q): %v", s, err)
	}
	return ip
}
