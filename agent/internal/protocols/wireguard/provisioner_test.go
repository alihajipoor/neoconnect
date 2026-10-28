package wireguard

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

	counts, err := p.Sessions()
	if err != nil {
		t.Fatalf("expected no error from Sessions, got %v", err)
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

// transfer feeds StatsSince a canned `wg show wg0 transfer` reading.
func transfer(p *Provisioner, reading *string, failing *bool) {
	p.readTransfer = func(context.Context) ([]byte, error) {
		if failing != nil && *failing {
			return nil, errors.New("wg: interface busy")
		}
		return []byte(*reading), nil
	}
}

func TestAnAgentRestartDoesNotBillLifetimeCountersAgain(t *testing.T) {
	// The finding, reduced: wg0 has run for weeks and a peer's counter
	// reads 30 GB, all of it already reported by the previous agent
	// process. A fresh process -- every rollout is one -- used to report
	// the whole 30 GB again on its first poll.
	p := build(t, true, true)
	reading := "peerA=\t30000000000\t2000000000\n"
	transfer(p, &reading, nil)
	ctx := context.Background()

	deltas, err := p.StatsSince(ctx)
	if err != nil {
		t.Fatalf("first poll: %v", err)
	}
	if len(deltas) != 0 {
		t.Fatalf("the first poll after a start must be a baseline, got %+v", deltas)
	}

	// From then on, only growth.
	reading = "peerA=\t30000001000\t2000002000\n"
	deltas, err = p.StatsSince(ctx)
	if err != nil {
		t.Fatalf("second poll: %v", err)
	}
	if len(deltas) != 1 || deltas[0].BytesUp != 1000 || deltas[0].BytesDown != 2000 {
		t.Fatalf("expected only the growth since the baseline, got %+v", deltas)
	}

	// A peer added after the baseline started from zero when it was
	// added, so all of its counter is new usage.
	reading = "peerA=\t30000001000\t2000002000\npeerB=\t500\t700\n"
	deltas, err = p.StatsSince(ctx)
	if err != nil {
		t.Fatalf("third poll: %v", err)
	}
	if len(deltas) != 1 || deltas[0].ExternalUserID != "peerB=" || deltas[0].BytesUp != 500 || deltas[0].BytesDown != 700 {
		t.Fatalf("expected the new peer counted in full, got %+v", deltas)
	}
}

func TestOnlyASuccessfulReadIsTheBaseline(t *testing.T) {
	ctx := context.Background()

	// A failed read leaves the baseline to the next one that works.
	p := build(t, true, true)
	reading := "peerA=\t9000\t9000\n"
	failing := true
	transfer(p, &reading, &failing)
	if _, err := p.StatsSince(ctx); err == nil {
		t.Fatal("expected the failed read to be reported")
	}
	failing = false
	if deltas, err := p.StatsSince(ctx); err != nil || len(deltas) != 0 {
		t.Fatalf("the first successful read must be the baseline, got %+v, %v", deltas, err)
	}

	// So does a poll that found no WireGuard here at all.
	p = build(t, false, false)
	transfer(p, &reading, nil)
	if deltas, err := p.StatsSince(ctx); err != nil || len(deltas) != 0 {
		t.Fatalf("expected nothing where WireGuard is not served, got %+v, %v", deltas, err)
	}
	if err := os.Mkdir(filepath.Join(p.sysNetDir, "wg0"), 0o755); err != nil {
		t.Fatalf("could not create the stand-in interface: %v", err)
	}
	if deltas, err := p.StatsSince(ctx); err != nil || len(deltas) != 0 {
		t.Fatalf("the first real read must be the baseline, got %+v, %v", deltas, err)
	}
}

// dump feeds Sessions a canned `wg show wg0 dump`: the interface line,
// then one tab-separated line per peer -- public key, preshared key,
// endpoint, allowed IPs, latest handshake, rx, tx, keepalive.
func dump(p *Provisioner, peers ...string) {
	table := "privkey=\tpubkey=\t51820\toff\n" + strings.Join(peers, "\n") + "\n"
	p.readDump = func() ([]byte, error) { return []byte(table), nil }
}

func peer(key, endpoint string, handshake int64) string {
	return fmt.Sprintf("%s\t(none)\t%s\t10.66.0.2/32\t%d\t1000\t2000\toff", key, endpoint, handshake)
}

// Who counts is unchanged by the addresses -- a fresh handshake from a
// real endpoint, one per peer -- and each counted peer now says where it
// is connected from, IPv6 without its brackets, aged by its handshake.
func TestSessionsCountConnectedPeersAndSayWhereFrom(t *testing.T) {
	p := build(t, true, true)
	now := time.Now().Unix()
	dump(p,
		peer("v4=", "203.0.113.5:51820", now-10),
		peer("v6=", "[2001:db8::5]:40000", now-100),
		// Configured but never connected: no endpoint, no handshake.
		peer("idle=", "(none)", 0),
		// Connected once, long enough ago to be gone.
		peer("stale=", "203.0.113.6:51820", now-600),
		// An endpoint with no handshake behind it is not a session.
		peer("nohs=", "203.0.113.7:51820", 0),
	)

	got, err := p.Sessions()
	if err != nil {
		t.Fatalf("Sessions: %v", err)
	}
	if len(got) != 2 || got["v4="].Count != 1 || got["v6="].Count != 1 {
		t.Fatalf("expected the two connected peers counted once each, got %+v", got)
	}
	v4, v6 := got["v4="].Sources, got["v6="].Sources
	if len(v4) != 1 || v4[0].Address != "203.0.113.5" || v4[0].SecondsAgo < 10 || v4[0].SecondsAgo > 12 {
		t.Errorf("IPv4 endpoint: got %+v", v4)
	}
	if len(v6) != 1 || v6[0].Address != "2001:db8::5" || v6[0].SecondsAgo < 100 || v6[0].SecondsAgo > 102 {
		t.Errorf("IPv6 endpoint: got %+v", v6)
	}
}

// A failed read stays an error, as it always has: unknown, not nobody.
func TestAFailedPeerReadIsAnError(t *testing.T) {
	p := build(t, true, true)
	p.readDump = func() ([]byte, error) { return nil, errors.New("wg: interface busy") }
	if got, err := p.Sessions(); err == nil || got != nil {
		t.Fatalf("expected an error and nothing reported, got %+v, %v", got, err)
	}
}
