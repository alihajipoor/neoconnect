package dispatch

import (
	"context"
	"testing"

	"github.com/neoxify/neoxify-hub/agent/internal/shaper"
)

// fakeDiscoverer stands in for OpenVPN's management interface.
type fakeDiscoverer struct{ connected map[string]string }

func (f *fakeDiscoverer) ConnectedAddresses() (map[string]string, error) {
	return f.connected, nil
}

// tcRecorder captures what the shaper would run, so the reconcile logic
// can be asserted without a kernel.
type tcRecorder struct{ calls []string }

func (r *tcRecorder) run(_ context.Context, name string, args ...string) error {
	call := name
	for _, a := range args {
		call += " " + a
	}
	r.calls = append(r.calls, call)
	return nil
}

func (r *tcRecorder) count(substr string) int {
	n := 0
	for _, c := range r.calls {
		if len(substr) > 0 && contains(c, substr) {
			n++
		}
	}
	return n
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (func() bool {
		for i := 0; i+len(needle) <= len(haystack); i++ {
			if haystack[i:i+len(needle)] == needle {
				return true
			}
		}
		return false
	})()
}

func newHarness(connected map[string]string) (*Dispatcher, *tcRecorder) {
	rec := &tcRecorder{}
	d := New()
	d.RegisterShaper("OPENVPN", shaper.NewWithRunner("tun0", rec.run))
	d.RegisterAddressDiscoverer("OPENVPN", &fakeDiscoverer{connected: connected})
	return d, rec
}

func TestConnectTimeAddressIsShapedOnceTheClientAppears(t *testing.T) {
	// OpenVPN has no address to shape when the user is created, so the cap
	// has to be remembered and applied when they connect. If this didn't
	// happen, an OpenVPN customer would simply never be limited.
	d, rec := newHarness(map[string]string{})
	d.applyRateLimit(context.Background(), commandPayload{
		Protocol: "OPENVPN", ExternalUserID: "cn-1", DownloadMbps: 50,
	})
	if got := rec.count("class replace"); got != 0 {
		t.Fatalf("nothing should be shaped before the client connects, got %d calls", got)
	}

	d.discoverers["OPENVPN"] = &fakeDiscoverer{connected: map[string]string{"cn-1": "10.8.0.6"}}
	d.ReconcileShaping(context.Background())

	if got := rec.count("match ip dst 10.8.0.6/32"); got != 1 {
		t.Errorf("expected the connected client to be shaped, got %d", got)
	}
}

func TestAlreadyShapedClientIsNotReappliedEveryPoll(t *testing.T) {
	// The reconcile runs on every stats tick. Re-applying each time would
	// churn tc rules constantly for no benefit.
	d, rec := newHarness(map[string]string{"cn-1": "10.8.0.6"})
	d.applyRateLimit(context.Background(), commandPayload{
		Protocol: "OPENVPN", ExternalUserID: "cn-1", DownloadMbps: 50,
	})
	d.ReconcileShaping(context.Background())
	first := rec.count("class replace")
	d.ReconcileShaping(context.Background())
	d.ReconcileShaping(context.Background())

	if got := rec.count("class replace"); got != first {
		t.Errorf("rules were re-applied on later polls: %d then %d", first, got)
	}
}

func TestDisconnectedClientsRulesAreRemoved(t *testing.T) {
	// The address goes back to OpenVPN's pool. A rule left behind would be
	// inherited by whichever customer is handed that address next -- they
	// would silently get someone else's speed limit.
	d, rec := newHarness(map[string]string{"cn-1": "10.8.0.6"})
	d.applyRateLimit(context.Background(), commandPayload{
		Protocol: "OPENVPN", ExternalUserID: "cn-1", DownloadMbps: 50,
	})
	d.ReconcileShaping(context.Background())

	d.discoverers["OPENVPN"] = &fakeDiscoverer{connected: map[string]string{}}
	d.ReconcileShaping(context.Background())

	if got := rec.count("class del"); got == 0 {
		t.Error("expected the disconnected client's rules to be removed")
	}
}

func TestReconnectOnADifferentAddressMovesTheLimit(t *testing.T) {
	// OpenVPN can hand a returning client a different address. Without
	// clearing the old one, the customer keeps a stale rule on an address
	// someone else may now hold, and gets shaped twice over.
	d, rec := newHarness(map[string]string{"cn-1": "10.8.0.6"})
	d.applyRateLimit(context.Background(), commandPayload{
		Protocol: "OPENVPN", ExternalUserID: "cn-1", DownloadMbps: 50,
	})
	d.ReconcileShaping(context.Background())

	d.discoverers["OPENVPN"] = &fakeDiscoverer{connected: map[string]string{"cn-1": "10.8.0.9"}}
	d.ReconcileShaping(context.Background())

	if got := rec.count("match ip dst 10.8.0.9/32"); got != 1 {
		t.Errorf("expected the limit to follow the client to its new address, got %d", got)
	}
	if got := rec.count("class del"); got == 0 {
		t.Error("expected the rule on the old address to be removed")
	}
}

func TestUncappedConnectedClientIsLeftAlone(t *testing.T) {
	d, rec := newHarness(map[string]string{"cn-nolimit": "10.8.0.7"})
	d.ReconcileShaping(context.Background())
	if got := rec.count("class replace"); got != 0 {
		t.Errorf("a customer with no cap should never be shaped, got %d calls", got)
	}
}
