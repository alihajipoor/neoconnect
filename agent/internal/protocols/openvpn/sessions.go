package openvpn

import (
	"strings"

	"github.com/neoxify/neoxify-hub/agent/internal/protocols/common"
)

/*
Session counting for OpenVPN.

Left out originally on reasoning that has since expired. OpenVPN
replaces a session when the same certificate reconnects, so a shared
credential gave nobody two simultaneous devices and there was nothing
worth reporting.

That held while a subscription had one credential. It now holds one per
route, so the same account has an OpenVPN certificate on every node and
can be connected to two of them at once -- two devices the account-wide
limit never counted. The backend sums per subscription across nodes, so
each node reporting its own connected clients is all that is needed for
that sum to be right.
*/

// Sessions reports one session per connected common name, with the real
// address it is connected from.
//
// The management interface only lists clients that are connected right
// now, so presence in CLIENT_LIST is the whole test -- there is no
// staleness question here as there is for WireGuard, where a peer stays
// configured whether or not anyone is using it.
//
// Counted per common name rather than per real address on purpose. With
// `duplicate-cn` disabled -- the default, and what this installer
// configures -- one certificate can only hold one session, so a second
// address for the same name means the first is already gone.
//
// The address is CLIENT_LIST's Real Address column: host:port for an
// IPv4 client, and for IPv6 OpenVPN prints the address with no port at
// all. NormalizeAddress takes either. Its age is 0: being listed means
// connected now, and CLIENT_LIST has no last-seen time to say more.
func (p *Provisioner) Sessions() (map[string]common.SessionReport, error) {
	out, err := p.mgmtCommand("status 2")
	if err != nil {
		return nil, err
	}
	reports := map[string]common.SessionReport{}
	for _, line := range strings.Split(out, "\n") {
		if !strings.HasPrefix(line, "CLIENT_LIST,") {
			continue
		}
		fields := strings.Split(line, ",")
		// Same columns StatsSince reads: CLIENT_LIST, Common Name, Real
		// Address, ... A short line is a truncated read rather than a
		// client, and counting it would invent a session.
		if len(fields) < 3 || fields[1] == "" {
			continue
		}
		report := reports[fields[1]]
		report.Count = 1
		report.Sources = append(report.Sources, common.SourceAddress{Address: fields[2]})
		reports[fields[1]] = report
	}
	for cn, report := range reports {
		report.Sources = common.RecentSources(report.Sources)
		reports[cn] = report
	}
	return reports, nil
}
