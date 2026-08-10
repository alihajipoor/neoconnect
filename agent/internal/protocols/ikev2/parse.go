package ikev2

import (
	"regexp"
	"strconv"
	"strings"
)

// swanctl --list-sas --raw emits the VICI message as nested key=value
// groups, one connection per top-level block:
//
//	neoxify-ikev2: { uniqueid=3 version=2 state=ESTABLISHED
//	  remote-host=1.2.3.4 remote-port=4500 remote-eap-id=nx-abc...
//	  child-sas { neoxify-ikev2-1: { bytes-in=1234 bytes-out=5678 ... } } }
//
// Parsed with field scanning rather than a full VICI decoder. The
// alternative is speaking the binary protocol over its unix socket,
// which means a dependency and a second way to talk to strongSwan, for
// four fields. If the format ever changes this returns nothing rather
// than wrong numbers, because every field is matched by name.
var (
	// A top-level SA begins with the connection name at the start of a
	// line. Child SAs are nested and indented, so anchoring on the line
	// start keeps the two apart.
	saStart   = regexp.MustCompile(`(?m)^\S+:\s*\{`)
	uniqueID  = regexp.MustCompile(`uniqueid=(\S+)`)
	eapID     = regexp.MustCompile(`remote-eap-id=(\S+)`)
	xauthID   = regexp.MustCompile(`remote-xauth-id=(\S+)`)
	remoteID  = regexp.MustCompile(`remote-id=(\S+)`)
	remoteHst = regexp.MustCompile(`remote-host=(\S+)`)
	bytesIn   = regexp.MustCompile(`bytes-in=(\d+)`)
	bytesOut  = regexp.MustCompile(`bytes-out=(\d+)`)
)

// parseSAs pulls one saInfo per established security association.
//
// Bytes are summed across every child SA of a connection: a single IKE
// SA can carry several, and reporting only the first would undercount a
// customer's traffic.
func parseSAs(raw string) []saInfo {
	starts := saStart.FindAllStringIndex(raw, -1)
	if len(starts) == 0 {
		return nil
	}

	out := make([]saInfo, 0, len(starts))
	for i, loc := range starts {
		end := len(raw)
		if i+1 < len(starts) {
			end = starts[i+1][0]
		}
		block := raw[loc[0]:end]

		sa := saInfo{
			id:         first(uniqueID, block),
			remoteHost: first(remoteHst, block),
		}
		// EAP first: that is what this deployment authenticates with, and
		// it is the identity the control plane knows the customer by. The
		// others are read only so a node configured differently still
		// reports something rather than silently counting nobody.
		sa.user = firstNonEmpty(
			first(eapID, block),
			first(xauthID, block),
			first(remoteID, block),
		)
		// An SA with no id cannot be attributed, and guessing which
		// customer it belongs to would be worse than ignoring it.
		if sa.id == "" {
			continue
		}
		for _, m := range bytesIn.FindAllStringSubmatch(block, -1) {
			sa.bytesDown += atoi(m[1])
		}
		for _, m := range bytesOut.FindAllStringSubmatch(block, -1) {
			sa.bytesUp += atoi(m[1])
		}
		out = append(out, sa)
	}
	return out
}

func first(re *regexp.Regexp, s string) string {
	m := re.FindStringSubmatch(s)
	if len(m) < 2 {
		return ""
	}
	// swanctl quotes values containing spaces; identities generated here
	// never do, but a hand-added one might.
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

func atoi(s string) uint64 {
	n, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		return 0
	}
	return n
}
