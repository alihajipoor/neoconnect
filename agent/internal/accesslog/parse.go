package accesslog

import (
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Entry is one connection Xray accepted on behalf of a provisioned user.
//
// The source address is deliberately not here. Xray logs it, and the
// session counter in protocols/xray reads it for device limits, but the
// site history is about where a customer's connections went, not where
// the customer was. Leaving it out of the type means it cannot leak into
// a batch by accident.
type Entry struct {
	At         time.Time
	User       string // the Xray client's email, which is the provisioned user's externalUserId
	InboundTag string // "" when Xray logged no inbound for the line
	Network    string // "tcp" or "udp"
	Host       string // a name or an address as Xray logged it, IPv6 without its brackets
	Port       uint32
}

// Xray writes its access log through Go's log package with
// Ldate|Ltime|Lmicroseconds and no LUTC, so the stamp is the node's local
// time with six fractional digits. Older Xray builds wrote whole seconds.
// One layout reads both: time.Parse accepts a fractional second after
// the seconds field even when the layout does not mention one.
const timeLayout = "2006/01/02 15:04:05"

// maxHostLen is the longest a DNS name can be. A client names its own
// destination, so anything longer is not a real site, only something a
// client typed to fill the panel's table.
const maxHostLen = 253

// uotSuffix marks the pseudo-destination a Shadowsocks UDP-over-TCP
// stream is addressed to (sp.v2.udp-over-tcp.arpa:0, and the v1 name
// before it). It names the mechanism, not a place, so it is skipped.
// What the datagrams inside that stream reached is not in this log at
// all: the template's uot-direct note says Xray never routes them. That
// is a gap in the site history for Shadowsocks UDP, DNS included -- not
// something this filter hides, and not something it can recover.
const uotSuffix = "udp-over-tcp.arpa"

// ParseLine reads one access-log line. ok is false for anything that is
// not an accepted connection attributed to a user: rejected handshakes,
// the agent's own API calls (no email), DNS log lines, the UoT
// pseudo-destination, and anything malformed.
//
// The shapes it accepts:
//
//	2026/10/28 08:20:17.560474 from tcp:203.0.113.5:51752 accepted tcp:example.com:443 [vless-in >> direct] email: <user>
//	2026/10/28 08:21:40 from 203.0.113.5:4411 accepted 198.51.100.63:443 [shadowsocks-in >> direct] email: <user>
//	2026/10/28 08:22:03.004120 from tcp:203.0.113.5:51760 accepted udp:198.18.0.3:137 [vless-in >> direct] email: <user>
//	2026/10/28 08:22:09.118342 from tcp:203.0.113.5:51761 accepted tcp:[2001:db8::1]:443 [vless-in >> direct] email: <user>
//
// Split by hand rather than with one regexp because the middle of the
// line varies -- the detour can be absent, use any of three arrows, or
// be followed by a reason -- and a regexp loose enough for all of that
// is also loose enough to mistake a reason for a destination.
func ParseLine(line string, loc *time.Location) (Entry, bool) {
	line = strings.TrimRight(line, "\r\n\t ")

	// "2026/10/28" then a space, then the clock up to the next space.
	if len(line) < 20 || line[10] != ' ' {
		return Entry{}, false
	}
	clockEnd := strings.IndexByte(line[11:], ' ')
	if clockEnd < 0 {
		return Entry{}, false
	}
	stampEnd := 11 + clockEnd
	at, err := time.ParseInLocation(timeLayout, line[:stampEnd], loc)
	if err != nil {
		return Entry{}, false
	}

	rest, found := strings.CutPrefix(line[stampEnd+1:], "from ")
	if !found {
		return Entry{}, false
	}
	// The source address. Skipped, see Entry.
	sp := strings.IndexByte(rest, ' ')
	if sp < 0 {
		return Entry{}, false
	}
	rest, found = strings.CutPrefix(rest[sp+1:], "accepted ")
	if !found {
		return Entry{}, false
	}
	sp = strings.IndexByte(rest, ' ')
	if sp < 0 {
		// A destination and nothing after it: no email, so no user.
		return Entry{}, false
	}
	dest, tail := rest[:sp], rest[sp:]

	// The email is always last (AccessMessage.String in xray-core). Last
	// rather than first occurrence so that a reason which happens to
	// contain the marker cannot be read as the user.
	emailAt := strings.LastIndex(tail, " email: ")
	if emailAt < 0 {
		return Entry{}, false
	}
	user := strings.TrimSpace(tail[emailAt+len(" email: "):])
	if user == "" || strings.ContainsAny(user, " \t") {
		return Entry{}, false
	}

	network, host, port, ok := parseDestination(dest)
	if !ok {
		return Entry{}, false
	}
	if strings.HasSuffix(strings.ToLower(host), uotSuffix) {
		return Entry{}, false
	}

	e := Entry{
		At:         at,
		User:       user,
		InboundTag: inboundTag(tail[:emailAt]),
		Network:    network,
		Host:       host,
		Port:       port,
	}
	// Every string here ends up in a proto3 string field, and the Go
	// protobuf runtime refuses to marshal one that is not valid UTF-8 --
	// the whole message fails, not just the field. The host is whatever
	// the client asked for, so one client naming a destination in raw
	// bytes would otherwise cost every other user on the node their
	// window. Control characters are refused for the same reason they
	// would be in the panel: they are not a site, and they render badly.
	for _, s := range [...]string{e.User, e.InboundTag, e.Host} {
		if !utf8.ValidString(s) || strings.ContainsFunc(s, isControl) {
			return Entry{}, false
		}
	}
	return e, true
}

func isControl(r rune) bool { return r < 0x20 || r == 0x7f }

// parseDestination splits Xray's rendering of a net.Destination:
// "tcp:host:port", "udp:host:port", or a bare "host:port", which some
// inbounds log and which is TCP. IPv6 hosts arrive bracketed and leave
// without the brackets -- they are part of the host:port syntax, not
// of the address, and the backend asks whether the host is an IP
// literal before it looks up who owns it.
func parseDestination(dest string) (network, host string, port uint32, ok bool) {
	network = "tcp"
	for _, n := range [...]string{"tcp", "udp"} {
		// "tcp:443" on its own is a host called tcp, not a prefix:
		// only treat it as one when a host:port still follows.
		if r, found := strings.CutPrefix(dest, n+":"); found && strings.IndexByte(r, ':') >= 0 {
			network, dest = n, r
			break
		}
	}
	// unix: and unknown: destinations carry no host:port at all, and
	// fall out here as malformed.

	var portStr string
	if strings.HasPrefix(dest, "[") {
		end := strings.Index(dest, "]:")
		if end < 0 {
			return "", "", 0, false
		}
		host, portStr = dest[1:end], dest[end+2:]
	} else {
		colon := strings.LastIndexByte(dest, ':')
		if colon < 0 {
			return "", "", 0, false
		}
		host, portStr = dest[:colon], dest[colon+1:]
	}
	if host == "" || len(host) > maxHostLen {
		return "", "", 0, false
	}
	p, err := strconv.ParseUint(portStr, 10, 16)
	if err != nil {
		return "", "", 0, false
	}
	return network, host, uint32(p), true
}

// inboundTag reads the inbound out of the detour Xray writes in square
// brackets after the destination. app/dispatcher picks one of three
// arrows depending on how the outbound was chosen, and writes the
// outbound alone when the connection has no inbound tag; that last case
// yields "", which is the truth.
func inboundTag(middle string) string {
	middle = strings.TrimLeft(middle, " ")
	if !strings.HasPrefix(middle, "[") {
		return ""
	}
	end := strings.IndexByte(middle, ']')
	if end < 0 {
		return ""
	}
	detour := middle[1:end]
	for _, arrow := range [...]string{" >> ", " -> ", " ==> "} {
		if i := strings.Index(detour, arrow); i >= 0 {
			return detour[:i]
		}
	}
	return ""
}
