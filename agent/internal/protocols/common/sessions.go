package common

import (
	"math"
	"net"
	"sort"
	"strings"
	"time"
)

// SessionReport is what one engine knows about one user's connections to
// it: how many devices it counts, and where they are connected from.
//
// The two are kept apart on purpose. Count is what every engine has
// always reported, by its own rules -- distinct addresses for Xray and
// IKEv2, one per peer or certificate for WireGuard and OpenVPN -- and the
// device limit acts on it (ConcurrencyService, enforcing in production).
// Sources is for the connection log's "From address": the app reports a
// connect through the tunnel it has just opened, so the backend only ever
// sees one of our servers as the sender, and the engine is the one place
// that saw where the customer came from. Sources is normalised and
// capped, so it can be shorter than Count, or fold together two spellings
// of an address that Count kept apart. Computing either from the other
// would let a change to the log's list move the device limit.
type SessionReport struct {
	Count   int
	Sources []SourceAddress
}

// SourceAddress is one place a user is connected from.
type SourceAddress struct {
	// The client's IP, bare and canonical (net.IP.String()): no port, no
	// brackets, an IPv4-mapped IPv6 address written as IPv4.
	Address string
	// How long before this poll the engine last saw it, on this node's
	// clock. Relative so the backend never has to trust the node's clock.
	// 0 from an engine that only knows "connected now".
	SecondsAgo uint32
}

// MaxSources is the most addresses one report carries. The log needs one
// per connect; a credential seen from more places than this at once is a
// device-limit question, which Count already answers.
const MaxSources = 8

// NormalizeAddress reduces a client address as an engine prints it --
// host:port, [v6]:port, [v6], or a bare IP -- to the bare IP in canonical
// form, so one client reads the same whichever engine saw it. Anything
// that is not an IP is refused rather than passed on: WireGuard's
// "(none)", an empty column, or a link-local address with a zone, which
// would never be a customer's real address anyway.
func NormalizeAddress(raw string) (string, bool) {
	s := strings.TrimSpace(raw)
	// Fails, harmlessly, on a bare IPv4 or bracketed IPv6 with no port
	// and on a bare IPv6, all of which ParseIP takes as they are.
	if host, _, err := net.SplitHostPort(s); err == nil {
		s = host
	}
	s = strings.TrimSuffix(strings.TrimPrefix(s, "["), "]")
	ip := net.ParseIP(s)
	if ip == nil {
		return "", false
	}
	return ip.String(), true
}

// RecentSources turns an engine's sightings of one user, addresses as the
// engine printed them, into the list a report carries: every address
// normalised, anything that is not an IP dropped, each address once at
// its most recent sighting, most recent first, at most MaxSources.
//
// Most recent first because the newest address is the one most likely to
// be the connect the backend is placing, and the cap must never be what
// cuts it off. Ties go by address so the same state always reports in the
// same order.
func RecentSources(sightings []SourceAddress) []SourceAddress {
	newest := make(map[string]uint32, len(sightings))
	for _, s := range sightings {
		addr, ok := NormalizeAddress(s.Address)
		if !ok {
			continue
		}
		if prev, seen := newest[addr]; !seen || s.SecondsAgo < prev {
			newest[addr] = s.SecondsAgo
		}
	}
	if len(newest) == 0 {
		return nil
	}
	out := make([]SourceAddress, 0, len(newest))
	for addr, ago := range newest {
		out = append(out, SourceAddress{Address: addr, SecondsAgo: ago})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].SecondsAgo != out[j].SecondsAgo {
			return out[i].SecondsAgo < out[j].SecondsAgo
		}
		return out[i].Address < out[j].Address
	})
	if len(out) > MaxSources {
		out = out[:MaxSources]
	}
	return out
}

// Ago is d in whole seconds, for SecondsAgo. A sighting stamped after now
// -- the node's clock stepped back -- is 0 rather than a negative number
// wrapped round to a sighting 136 years old.
func Ago(d time.Duration) uint32 {
	if d <= 0 {
		return 0
	}
	if s := d / time.Second; s < math.MaxUint32 {
		return uint32(s)
	}
	return math.MaxUint32
}
