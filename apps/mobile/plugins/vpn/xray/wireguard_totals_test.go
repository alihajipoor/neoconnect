//go:build darwin

package neoxifyxray

import "testing"

// The iOS speeds read WireGuard's own counters out of its configuration
// text. What a device with one peer says, abridged to the lines that
// matter and the ones around them.
func TestTotalsAreTheDevicesOwnCounters(t *testing.T) {
	uapi := "private_key=00\nlisten_port=51820\npublic_key=11\nrx_bytes=1024\ntx_bytes=2048\nlast_handshake_time_sec=1\n"
	rx, tx := sumTotals(uapi)
	if rx != 1024 || tx != 2048 {
		t.Fatalf("totals = %d, %d; want 1024, 2048", rx, tx)
	}
}

func TestTotalsAddUpEveryPeer(t *testing.T) {
	rx, tx := sumTotals("public_key=11\nrx_bytes=10\ntx_bytes=20\npublic_key=22\nrx_bytes=1\ntx_bytes=2\n")
	if rx != 11 || tx != 22 {
		t.Fatalf("totals = %d, %d; want 11, 22", rx, tx)
	}
}

func TestNoCounterIsNotZero(t *testing.T) {
	rx, tx := sumTotals("private_key=00\nlisten_port=51820\n")
	if rx != -1 || tx != -1 {
		t.Fatalf("totals with no peer = %d, %d; want -1, -1", rx, tx)
	}
	if WireGuardReceived() != -1 || WireGuardSent() != -1 {
		t.Fatal("no running tunnel must read as -1, not 0")
	}
}
