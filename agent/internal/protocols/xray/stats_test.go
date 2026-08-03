package xray

import (
	"context"
	"testing"
)

// Xray's usage counters are per-process, and reading them drains them.
// So exactly one provisioner may report, however many inbounds the
// process serves.
//
// This is the guard on a bug that cost real usage data: with a second
// Xray inbound registered for Trojan, both provisioners issued the same
// draining process-wide query. Each poll whichever won Go's randomised
// map iteration took everything and stamped it with its own protocol,
// and the control plane discarded every delta whose protocol did not
// match the user's -- so about half the node's traffic vanished with
// nothing logged anywhere.
func TestOnlyThePrimaryProvisionerReportsStats(t *testing.T) {
	// Nil clients on purpose: a derived provisioner must return before
	// touching the stats connection at all. If the guard is ever removed
	// this panics rather than quietly passing.
	primary := &Provisioner{inboundTag: "vless-in", kind: kindVLESS, reportsStats: true}

	for _, derived := range []*Provisioner{
		primary.ForTrojan("trojan-in", ""),
		primary.ForVless("vless-tls-in", ""),
	} {
		deltas, err := derived.StatsSince(context.Background())
		if err != nil {
			t.Fatalf("derived provisioner %q should not error: %v", derived.inboundTag, err)
		}
		if len(deltas) != 0 {
			t.Fatalf("derived provisioner %q reported %d deltas, want none", derived.inboundTag, len(deltas))
		}
	}
}

// The inbound tag and account kind still have to differ per inbound --
// only stats reporting is centralised. Getting this wrong would
// provision Trojan users onto the VLESS listener.
func TestDerivedProvisionersKeepTheirOwnInboundAndKind(t *testing.T) {
	primary := &Provisioner{inboundTag: "vless-in", kind: kindVLESS, reportsStats: true}

	trojan := primary.ForTrojan("trojan-in", "")
	if trojan.inboundTag != "trojan-in" || trojan.kind != kindTrojan {
		t.Fatalf("ForTrojan gave tag=%q kind=%v", trojan.inboundTag, trojan.kind)
	}

	vlessTLS := primary.ForVless("vless-tls-in", "")
	if vlessTLS.inboundTag != "vless-tls-in" || vlessTLS.kind != kindVLESS {
		t.Fatalf("ForVless gave tag=%q kind=%v", vlessTLS.inboundTag, vlessTLS.kind)
	}
}
