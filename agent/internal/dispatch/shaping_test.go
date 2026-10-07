package dispatch

import (
	"context"
	"testing"
	"time"

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

func anyContains(calls []string, substr string) bool {
	for _, c := range calls {
		if contains(c, substr) {
			return true
		}
	}
	return false
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

// wgHarness shapes WireGuard against a recorder, with a stand-in for the
// interface's root qdisc: present once EnsureRoot has installed it, gone
// when the test says wg-quick recreated the interface.
func wgHarness() (*Dispatcher, *tcRecorder, *bool) {
	rec := &tcRecorder{}
	root := false
	run := func(ctx context.Context, name string, args ...string) error {
		if len(args) >= 5 && args[0] == "qdisc" && args[1] == "replace" && args[3] == "wg0" && args[4] == "root" {
			root = true
		}
		return rec.run(ctx, name, args...)
	}
	query := func(context.Context, string, ...string) ([]byte, error) {
		if root {
			return []byte("qdisc htb 1: root refcnt 2 r2q 10 default 0xffff direct_packets_stat 0 direct_qlen 1000\n"), nil
		}
		return []byte("qdisc noqueue 0: root refcnt 2\n"), nil
	}
	d := New()
	d.RegisterShaper("WIREGUARD", shaper.NewWithRunners("wg0", run, query))
	return d, rec, &root
}

func wgCap(mbps uint32) commandPayload {
	return commandPayload{
		Protocol: "WIREGUARD", ExternalUserID: "peer-1", DownloadMbps: mbps,
		Credentials: map[string]string{"address": "10.66.0.5/32"},
	}
}

func TestAReassertedCapIsNotReappliedEveryMinute(t *testing.T) {
	// Re-asserts now carry caps, every 60 s for every capped user.
	// Re-applying each time would take the user's rules down and put them
	// back once a minute: a moment uncapped, queued packets dropped.
	d, rec, _ := wgHarness()
	for i := 0; i < 5; i++ {
		d.applyRateLimit(context.Background(), wgCap(50))
	}
	if got := rec.count("class replace dev wg0"); got != 1 {
		t.Fatalf("expected the cap applied once, got %d applications", got)
	}

	// A plan edit is still applied.
	d.applyRateLimit(context.Background(), wgCap(20))
	if got := rec.count("rate 20mbit"); got != 1 {
		t.Fatalf("a changed cap was not applied: %d", got)
	}
}

func TestCapsComeBackWhenTheInterfaceIsRecreated(t *testing.T) {
	// `wg-quick` recreating wg0 takes every tc rule on it along. The
	// re-assert that follows has to put them back, not trust the record.
	d, rec, root := wgHarness()
	d.applyRateLimit(context.Background(), wgCap(50))

	*root = false
	d.rootSeenAt["WIREGUARD"] = time.Now().Add(-time.Minute)
	d.applyRateLimit(context.Background(), wgCap(50))

	if got := rec.count("class replace dev wg0"); got != 2 {
		t.Fatalf("expected the cap re-applied on the recreated interface, got %d applications", got)
	}
}

func TestAChangedCapReachesAConnectedOpenVPNClient(t *testing.T) {
	// A plan edit used to reach a connected OpenVPN client only once they
	// reconnected: the reconcile saw them shaped at the same address and
	// moved on.
	d, rec := newHarness(map[string]string{"cn-1": "10.8.0.6"})
	d.applyRateLimit(context.Background(), commandPayload{Protocol: "OPENVPN", ExternalUserID: "cn-1", DownloadMbps: 50})
	d.ReconcileShaping(context.Background())

	// The same cap again, as every re-assert now sends it: nothing to do.
	d.applyRateLimit(context.Background(), commandPayload{Protocol: "OPENVPN", ExternalUserID: "cn-1", DownloadMbps: 50})
	d.ReconcileShaping(context.Background())
	if got := rec.count("class replace"); got != 1 {
		t.Fatalf("an unchanged cap was re-applied: %d applications", got)
	}

	d.applyRateLimit(context.Background(), commandPayload{Protocol: "OPENVPN", ExternalUserID: "cn-1", DownloadMbps: 20})
	d.ReconcileShaping(context.Background())
	if got := rec.count("rate 20mbit"); got != 1 {
		t.Fatalf("the changed cap never reached the connected client: %d", got)
	}
}

func TestAChangedCapLeavesNoRuleBehindWhenTheClientLeaves(t *testing.T) {
	// A plan edit used to forget where the user was shaped, so that the
	// next pass would re-apply. A client that disconnected before that
	// pass then left the old rule on its pool address -- the cleanup only
	// removes what it remembers -- and the next customer handed that
	// address inherited it, for good if they were uncapped.
	d, rec := newHarness(map[string]string{"cn-1": "10.8.0.6"})
	d.applyRateLimit(context.Background(), commandPayload{Protocol: "OPENVPN", ExternalUserID: "cn-1", DownloadMbps: 50})
	d.ReconcileShaping(context.Background())

	d.applyRateLimit(context.Background(), commandPayload{Protocol: "OPENVPN", ExternalUserID: "cn-1", DownloadMbps: 20})
	d.discoverers["OPENVPN"] = &fakeDiscoverer{connected: map[string]string{}}
	mark := len(rec.calls)
	d.ReconcileShaping(context.Background())

	// 1:6 is 10.8.0.6's class (shaper.classID).
	if !anyContains(rec.calls[mark:], "class del dev tun0 classid 1:6") {
		t.Fatalf("the rule on the address the client left was not removed: %v", rec.calls[mark:])
	}
}

func TestAChangedCapFollowsAClientThatMovedAddress(t *testing.T) {
	// The cap changes, and the client reconnects on another address before
	// the next pass: the rule on the old one has to go, not only the new
	// one go on.
	d, rec := newHarness(map[string]string{"cn-1": "10.8.0.6"})
	d.applyRateLimit(context.Background(), commandPayload{Protocol: "OPENVPN", ExternalUserID: "cn-1", DownloadMbps: 50})
	d.ReconcileShaping(context.Background())

	d.applyRateLimit(context.Background(), commandPayload{Protocol: "OPENVPN", ExternalUserID: "cn-1", DownloadMbps: 20})
	d.discoverers["OPENVPN"] = &fakeDiscoverer{connected: map[string]string{"cn-1": "10.8.0.9"}}
	mark := len(rec.calls)
	d.ReconcileShaping(context.Background())

	if !anyContains(rec.calls[mark:], "match ip dst 10.8.0.9/32") || !anyContains(rec.calls[mark:], "rate 20mbit") {
		t.Fatalf("expected the new cap on the new address: %v", rec.calls[mark:])
	}
	if !anyContains(rec.calls[mark:], "class del dev tun0 classid 1:6") {
		t.Fatalf("the rule on the old address was left behind: %v", rec.calls[mark:])
	}
	// And it settles: nothing more on the next pass.
	calls := len(rec.calls)
	d.ReconcileShaping(context.Background())
	if len(rec.calls) != calls {
		t.Fatalf("the reconcile kept re-applying: %v", rec.calls[calls:])
	}
}

func TestUncappedConnectedClientIsLeftAlone(t *testing.T) {
	d, rec := newHarness(map[string]string{"cn-nolimit": "10.8.0.7"})
	d.ReconcileShaping(context.Background())
	if got := rec.count("class replace"); got != 0 {
		t.Errorf("a customer with no cap should never be shaped, got %d calls", got)
	}
}
