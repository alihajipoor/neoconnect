package ikev2

import "testing"

// Shaped after real `swanctl --list-sas --raw` output: two customers,
// one of them connected twice from different addresses, and a
// connection carrying two child SAs.
const sample = `neoxify-ikev2: {
  uniqueid=1 version=2 state=ESTABLISHED local-host=10.0.0.1 local-port=4500
  local-id=sg1.neoxify.site remote-host=203.0.113.5 remote-port=4500
  remote-eap-id=nx-aaaaaaaaaaaaaaaa
  child-sas {
    neoxify-ikev2-1: { uniqueid=11 state=INSTALLED bytes-in=1000 bytes-out=2000 }
    neoxify-ikev2-2: { uniqueid=12 state=INSTALLED bytes-in=500 bytes-out=250 }
  }
}
neoxify-ikev2: {
  uniqueid=2 version=2 state=ESTABLISHED local-host=10.0.0.1 local-port=4500
  remote-host=198.51.100.9 remote-port=4500
  remote-eap-id=nx-aaaaaaaaaaaaaaaa
  child-sas {
    neoxify-ikev2-3: { uniqueid=13 state=INSTALLED bytes-in=7 bytes-out=9 }
  }
}
neoxify-ikev2: {
  uniqueid=3 version=2 state=ESTABLISHED remote-host=192.0.2.77 remote-port=500
  remote-eap-id=nx-bbbbbbbbbbbbbbbb
  child-sas {
    neoxify-ikev2-4: { uniqueid=14 state=INSTALLED bytes-in=100 bytes-out=0 }
  }
}
`

func TestParseSumsChildSAsPerConnection(t *testing.T) {
	sas := parseSAs(sample)
	if len(sas) != 3 {
		t.Fatalf("expected 3 security associations, got %d", len(sas))
	}
	// bytes-in is traffic arriving at the node, which is the customer
	// uploading, so it lands in BytesDown only after the provisioner maps
	// it. Here just check both child SAs were summed rather than the
	// first one winning.
	if sas[0].bytesDown != 1500 || sas[0].bytesUp != 2250 {
		t.Fatalf("child SAs not summed: down=%d up=%d", sas[0].bytesDown, sas[0].bytesUp)
	}
	if sas[0].user != "nx-aaaaaaaaaaaaaaaa" || sas[0].remoteHost != "203.0.113.5" {
		t.Fatalf("wrong identity or host: %+v", sas[0])
	}
}

func TestSessionsCountedByDistinctAddress(t *testing.T) {
	p := New(t.TempDir()+"/secrets.conf", "swanctl")
	counts := map[string]map[string]bool{}
	for _, sa := range parseSAs(sample) {
		if counts[sa.user] == nil {
			counts[sa.user] = map[string]bool{}
		}
		counts[sa.user][sa.remoteHost] = true
	}
	_ = p
	// The first customer holds two SAs from two different addresses:
	// two devices, which is what the limit is meant to see.
	if got := len(counts["nx-aaaaaaaaaaaaaaaa"]); got != 2 {
		t.Fatalf("expected 2 distinct sources, got %d", got)
	}
	if got := len(counts["nx-bbbbbbbbbbbbbbbb"]); got != 1 {
		t.Fatalf("expected 1 distinct source, got %d", got)
	}
}

// The same address twice is one device rekeying or roaming, not two
// connections. Counting it would disconnect somebody who did nothing.
func TestSameAddressTwiceIsOneSession(t *testing.T) {
	raw := `neoxify-ikev2: {
  uniqueid=1 remote-host=203.0.113.5 remote-eap-id=nx-cccccccccccccccc
  child-sas { a: { bytes-in=1 bytes-out=1 } }
}
neoxify-ikev2: {
  uniqueid=2 remote-host=203.0.113.5 remote-eap-id=nx-cccccccccccccccc
  child-sas { b: { bytes-in=1 bytes-out=1 } }
}
`
	seen := map[string]bool{}
	for _, sa := range parseSAs(raw) {
		seen[sa.remoteHost] = true
	}
	if len(seen) != 1 {
		t.Fatalf("expected one distinct address, got %d", len(seen))
	}
}

func TestEmptyOutputIsNotAnError(t *testing.T) {
	if got := parseSAs(""); got != nil {
		t.Fatalf("expected nil for no SAs, got %+v", got)
	}
}
