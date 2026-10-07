package ikev2

import (
	"regexp"
	"strconv"
	"strings"
)

// What `swanctl --list-sas --raw` prints, and so what this parses.
//
// --raw is vici's own dump of each message with no line breaks inside it:
// one `list-sa event` per IKE SA, each on a single line, then a closing
// `list-sas reply {}`. A section is `name {...}`, a value `key=value`,
// and the first key of a section follows its brace with no space. One SA,
// wrapped here and shortened (testdata/swanctl-list-sas-raw.txt holds two
// in full, captured from a live IKEv2 node on 2026-10-06 and redacted):
//
//	list-sa event {neoxify-ikev2 {uniqueid=7 version=2 state=ESTABLISHED
//	  remote-host=... remote-port=51857 remote-id=... remote-eap-id=nx-...
//	  child-sas {neoxify-ikev2-16 {name=neoxify-ikev2 uniqueid=16 reqid=3
//	  state=INSTALLED ... bytes-in=31970 packets-in=202 use-in=75342
//	  bytes-out=85956 ...}}}}
//
// The parser this replaced looked for `<name>: {` at the start of a line,
// a shape strongSwan prints in no output mode at all, and its test
// fixture was written to match it rather than taken from a node. It
// matched nothing, so from the day it shipped IKEv2 reported no usage and
// no sessions, and said nothing: "no SAs" and "could not read the SAs"
// looked the same. listSAs now tells them apart.
//
// Field scanning rather than a VICI decoder, still: the alternative is
// speaking the binary protocol over its unix socket, a second way to talk
// to strongSwan for a handful of fields.
const eventPrefix = "list-sa event {"

// Each key is matched only where a key can start -- after a space or the
// brace that opens its section -- so `uniqueid=` is never found inside
// some longer key. Values stop at whitespace or a brace, because the last
// value in a section is followed directly by the brace that closes it.
func field(name string) *regexp.Regexp {
	return regexp.MustCompile(`(?:^|[\s{])` + regexp.QuoteMeta(name) + `=([^\s{}]+)`)
}

var (
	uniqueID  = field("uniqueid")
	eapID     = field("remote-eap-id")
	xauthID   = field("remote-xauth-id")
	remoteID  = field("remote-id")
	remoteHst = field("remote-host")
	bytesIn   = field("bytes-in")
	bytesOut  = field("bytes-out")
	saState   = field("state")
	useIn     = field("use-in")

	// One CHILD_SA inside `child-sas {...}`: its name and its body. A
	// child SA has no sections of its own (traffic selectors are lists,
	// in brackets), so its body is everything up to the next brace.
	childBlock = regexp.MustCompile(`([^\s{}]+) \{([^{}]*)\}`)
)

// saInfo is the part of one IKE SA this cares about.
type saInfo struct {
	// The IKE SA's uniqueid: what `swanctl --terminate --ike-id` takes.
	id         string
	user       string
	remoteHost string
	// The IKE SA's state. ESTABLISHED only once authentication is complete:
	// before that, user is whatever identity the client claimed.
	state    string
	children []childInfo
}

// childInfo is one CHILD_SA: where the traffic, and so the counters, are.
type childInfo struct {
	name string
	// The CHILD_SA's own uniqueid. Usage is tracked under this rather than
	// under the IKE SA's, because when a client rekeys its IKE SA the
	// CHILD_SAs move to the new one with their counters intact; keyed by
	// the IKE SA, the new one's first reading would bill the whole
	// session again. (How strongSwan rekeys, not yet seen on a node.)
	id string
	// Bytes through the inbound SA, from the customer: their upload.
	bytesIn uint64
	// Bytes through the outbound SA, to the customer: their download.
	bytesOut uint64
	// Seconds since a packet last arrived from the customer on this
	// CHILD_SA, or -1 when strongSwan printed none -- which it does for a
	// child that has never received one.
	useIn int64
}

// key identifies a child SA across polls.
func (c childInfo) key(ikeID string) string {
	if c.id != "" {
		return "child:" + c.id
	}
	// No id is not something strongSwan prints; if it ever does, the
	// child is still counted, against its IKE SA and name.
	return "ike:" + ikeID + "/" + c.name
}

// parseSAs reads every IKE SA out of swanctl's --raw output, and says how
// many `list-sa event` lines there were, so a caller can tell an empty
// list from one it could not read.
//
// Anything that is not an event line is skipped: the closing reply, and
// any line strongSwan's plugin loader prints on startup.
func parseSAs(raw string) ([]saInfo, int) {
	var out []saInfo
	events := 0
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, eventPrefix) {
			continue
		}
		events++

		ike, children := line, ""
		if i := strings.Index(line, "child-sas {"); i >= 0 {
			ike, children = line[:i], line[i+len("child-sas {"):]
		}

		sa := saInfo{
			id:         first(uniqueID, ike),
			remoteHost: first(remoteHst, ike),
			state:      first(saState, ike),
		}
		// An SA with no id cannot be attributed or terminated, and
		// guessing which customer it belongs to would be worse than
		// leaving it out. The caller hears about it through the count.
		if sa.id == "" {
			continue
		}
		// EAP first: that is what this deployment authenticates with, and
		// it is the identity the control plane knows the customer by. The
		// others are read only so a node configured differently still
		// reports something rather than silently counting nobody.
		sa.user = firstNonEmpty(
			first(eapID, ike),
			first(xauthID, ike),
			first(remoteID, ike),
		)
		for _, m := range childBlock.FindAllStringSubmatch(children, -1) {
			body := m[2]
			sa.children = append(sa.children, childInfo{
				name:     m[1],
				id:       first(uniqueID, body),
				bytesIn:  atoi(first(bytesIn, body)),
				bytesOut: atoi(first(bytesOut, body)),
				useIn:    seconds(first(useIn, body)),
			})
		}
		out = append(out, sa)
	}
	return out, events
}

func first(re *regexp.Regexp, s string) string {
	m := re.FindStringSubmatch(s)
	if len(m) < 2 {
		return ""
	}
	// swanctl's pretty mode quotes values containing spaces; --raw does
	// not, but a quoted identity costs nothing to accept.
	return strings.Trim(m[1], `"`)
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// seconds reads a duration swanctl prints in whole seconds, or -1 when
// there is none.
func seconds(s string) int64 {
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n < 0 {
		return -1
	}
	return n
}

func atoi(s string) uint64 {
	n, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		return 0
	}
	return n
}
