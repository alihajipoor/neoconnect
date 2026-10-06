package ikev2

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// realSample is `swanctl --list-sas --raw` exactly as a live IKEv2 node
// printed it on 2026-10-06, with two customers connected: addresses,
// identities, SPIs and ids replaced by placeholders, nothing else
// touched. Every test below starts from it. The fixture this replaced was
// written by hand, in a shape strongSwan never prints, which is how a
// parser that matched nothing passed its tests for weeks.
func realSample(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "swanctl-list-sas-raw.txt"))
	if err != nil {
		t.Fatalf("could not read the captured sample: %v", err)
	}
	return string(b)
}

// filled gives the placeholders values, distinct per SA, so customers and
// ids can be told apart. Every key, brace and space is the captured
// output's. Addresses are RFC 5737 documentation addresses.
func filled(t *testing.T) string {
	t.Helper()
	lines := strings.Split(realSample(t), "\n")
	n := 0
	for i, line := range lines {
		if !strings.HasPrefix(line, eventPrefix) {
			continue
		}
		n++
		// The first uniqueid on the line is the IKE SA's, the second its
		// CHILD_SA's.
		line = strings.Replace(line, "uniqueid=<n>", fmt.Sprintf("uniqueid=%d", n), 1)
		line = strings.Replace(line, "uniqueid=<n>", fmt.Sprintf("uniqueid=%d", 100+n), 1)
		line = strings.Replace(line, "remote-host=<ip4>", fmt.Sprintf("remote-host=198.51.100.%d", n), 1)
		line = strings.Replace(line, "remote-eap-id=<id>", fmt.Sprintf("remote-eap-id=nx-user%d", n), 1)
		lines[i] = line
	}
	return strings.Join(lines, "\n")
}

// fakeSwanctl stands in for strongSwan: it serves canned --list-sas
// output and records every call it is given.
type fakeSwanctl struct {
	listSAs string
	calls   [][]string
}

func (f *fakeSwanctl) run(_ context.Context, args ...string) (string, string, error) {
	f.calls = append(f.calls, append([]string(nil), args...))
	if len(args) > 0 && args[0] == "--list-sas" {
		return f.listSAs, "", nil
	}
	return "", "", nil
}

// withFake builds a provisioner that talks to a fake strongSwan and has
// customers provisioned, so it polls rather than deciding IKEv2 is not
// served here.
func withFake(t *testing.T, output string) (*Provisioner, *fakeSwanctl) {
	t.Helper()
	f := &fakeSwanctl{listSAs: output}
	p := New(filepath.Join(t.TempDir(), "users.conf"), missingSwanctl)
	p.runSwanctl = f.run
	p.users["nx-user1"] = "secret-1"
	p.users["nx-user2"] = "secret-2"
	return p, f
}

func TestParsesTheOutputCapturedFromANode(t *testing.T) {
	// The finding, as a test: the old parser returned nothing at all for
	// this input, so IKEv2 reported no usage and no sessions.
	sas, events := parseSAs(realSample(t))
	if events != 2 {
		t.Fatalf("expected 2 list-sa events, counted %d", events)
	}
	if len(sas) != 2 {
		t.Fatalf("expected 2 security associations, got %d", len(sas))
	}
	want := []struct {
		child   string
		in, out uint64
	}{
		{"neoxify-ikev2-16", 31970, 85956},
		{"neoxify-ikev2-15", 62669, 257213},
	}
	for i, w := range want {
		if len(sas[i].children) != 1 {
			t.Fatalf("SA %d: expected one child SA, got %d", i, len(sas[i].children))
		}
		c := sas[i].children[0]
		if c.name != w.child || c.bytesIn != w.in || c.bytesOut != w.out {
			t.Errorf("SA %d: got child %q in=%d out=%d, want %q in=%d out=%d", i, c.name, c.bytesIn, c.bytesOut, w.child, w.in, w.out)
		}
		if sas[i].user == "" || sas[i].remoteHost == "" {
			t.Errorf("SA %d: identity or address not read: %+v", i, sas[i])
		}
	}
}

func TestReadsIdsIdentitiesAndAddresses(t *testing.T) {
	sas, _ := parseSAs(filled(t))
	if len(sas) != 2 {
		t.Fatalf("expected 2 security associations, got %d", len(sas))
	}
	sa := sas[0]
	// The IKE SA's own id, not its child's: that is what --terminate
	// --ike-id takes.
	if sa.id != "1" {
		t.Errorf("expected IKE SA id 1, got %q", sa.id)
	}
	if sa.children[0].id != "101" {
		t.Errorf("expected CHILD_SA id 101, got %q", sa.children[0].id)
	}
	// remote-eap-id, not remote-id: the EAP identity is the username the
	// control plane provisioned, and remote-id is whatever the client's
	// operating system chose to send.
	if sa.user != "nx-user1" {
		t.Errorf("expected the EAP identity, got %q", sa.user)
	}
	if sa.remoteHost != "198.51.100.1" {
		t.Errorf("expected the remote host, got %q", sa.remoteHost)
	}
}

func TestStatsReadTheRealOutputInTheRightDirection(t *testing.T) {
	p, f := withFake(t, filled(t))
	ctx := context.Background()
	if _, err := p.StatsSince(ctx); err != nil {
		t.Fatalf("first poll: %v", err)
	}

	// The first customer sends 1000 bytes and receives 5000.
	f.listSAs = strings.Replace(filled(t), "bytes-in=31970", "bytes-in=32970", 1)
	f.listSAs = strings.Replace(f.listSAs, "bytes-out=85956", "bytes-out=90956", 1)
	deltas, err := p.StatsSince(ctx)
	if err != nil {
		t.Fatalf("second poll: %v", err)
	}
	if len(deltas) != 1 {
		t.Fatalf("expected usage for the one customer who used anything, got %+v", deltas)
	}
	d := deltas[0]
	// bytes-in is what arrived at the node from the customer: their
	// upload. The old code had the two the other way round.
	if d.ExternalUserID != "nx-user1" || d.BytesUp != 1000 || d.BytesDown != 5000 {
		t.Fatalf("got %+v, want nx-user1 up=1000 down=5000", d)
	}
}

func TestAnIkeRekeyDoesNotBillTheSessionAgain(t *testing.T) {
	// A client that rekeys its IKE SA gets a new IKE SA id, and strongSwan
	// moves the existing CHILD_SA -- counters intact -- onto it. Tracked
	// per IKE SA, the next poll would bill the whole session again.
	p, f := withFake(t, filled(t))
	ctx := context.Background()
	if _, err := p.StatsSince(ctx); err != nil {
		t.Fatalf("first poll: %v", err)
	}

	rekeyed := strings.Replace(filled(t), "{uniqueid=1 ", "{uniqueid=9 ", 1)
	f.listSAs = strings.Replace(rekeyed, "bytes-in=31970", "bytes-in=32000", 1)
	deltas, err := p.StatsSince(ctx)
	if err != nil {
		t.Fatalf("second poll: %v", err)
	}
	if len(deltas) != 1 || deltas[0].BytesUp != 30 || deltas[0].BytesDown != 0 {
		t.Fatalf("expected only the 30 bytes of growth, got %+v", deltas)
	}
}

func TestSessionsCountedByDistinctAddress(t *testing.T) {
	p, f := withFake(t, filled(t))

	counts, err := p.SessionCounts()
	if err != nil {
		t.Fatalf("SessionCounts: %v", err)
	}
	if counts["nx-user1"] != 1 || counts["nx-user2"] != 1 || len(counts) != 2 {
		t.Fatalf("expected one session each for two customers, got %v", counts)
	}

	// The same customer from two addresses: two devices, which is what
	// the limit is meant to see.
	f.listSAs = strings.Replace(filled(t), "nx-user2", "nx-user1", 1)
	counts, err = p.SessionCounts()
	if err != nil {
		t.Fatalf("SessionCounts: %v", err)
	}
	if counts["nx-user1"] != 2 {
		t.Fatalf("expected 2 distinct sources, got %v", counts)
	}

	// The same address twice is one device rekeying or roaming, not two
	// connections. Counting it would disconnect somebody who did nothing.
	f.listSAs = strings.Replace(f.listSAs, "198.51.100.2", "198.51.100.1", 1)
	counts, err = p.SessionCounts()
	if err != nil {
		t.Fatalf("SessionCounts: %v", err)
	}
	if counts["nx-user1"] != 1 {
		t.Fatalf("expected one distinct source, got %v", counts)
	}
}

func TestPluginLoaderNoiseIsIgnored(t *testing.T) {
	// Lines strongSwan's loader prints on startup are not SAs and must not
	// stop the ones after them being read.
	noisy := "plugin 'eap-radius': failed to load - eap_radius_plugin_create not found and no plugin file available\n" +
		"no files found matching '/etc/strongswan.d/charon/missing.conf'\n" + filled(t)
	sas, events := parseSAs(noisy)
	if events != 2 || len(sas) != 2 {
		t.Fatalf("expected 2 SAs past the noise, got %d of %d", len(sas), events)
	}
}

func TestUnreadableOutputIsLoud(t *testing.T) {
	// SAs that are listed and cannot be read must not look like nobody
	// being connected: that silence is what hid the old parser.
	p, _ := withFake(t, "list-sa event {neoxify-ikev2 {state=ESTABLISHED}}\nlist-sas reply {}\n")
	if _, err := p.StatsSince(context.Background()); err == nil {
		t.Fatal("expected an error when listed SAs cannot be read")
	}
	if _, err := p.SessionCounts(); err == nil {
		t.Fatal("expected SessionCounts to report unreadable SAs too")
	}
}

func TestNobodyConnectedIsNotAnError(t *testing.T) {
	p, _ := withFake(t, "list-sas reply {}\n")
	deltas, err := p.StatsSince(context.Background())
	if err != nil || len(deltas) != 0 {
		t.Fatalf("expected nothing and no error, got %+v, %v", deltas, err)
	}
	if sas, events := parseSAs(""); sas != nil || events != 0 {
		t.Fatalf("expected nothing from empty output, got %+v, %d", sas, events)
	}
}
