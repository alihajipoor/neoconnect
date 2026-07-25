// Package shaper enforces a plan's per-user speed caps on the node using
// Linux tc, so a handful of customers downloading at once can no longer
// saturate the VPS for everyone else.
//
// Each user is shaped by their address inside the tunnel, which is what
// makes the limit apply to exactly one customer. Download and upload need
// different mechanisms, because tc can only shape traffic leaving an
// interface:
//
//   - Download (node -> customer) leaves the tunnel interface, so it is
//     shaped with an HTB class and a filter matching the destination.
//     Shaping queues rather than drops, so a capped download slows down
//     smoothly instead of stalling.
//   - Upload (customer -> node) arrives, so there is nothing on this
//     interface to queue. It is redirected to an IFB device, where it
//     becomes egress and can be shaped with HTB exactly like the download
//     direction. This replaced ingress policing, which was measured
//     delivering 12.3 Mbit/s against a 20 Mbit/s cap -- policing drops
//     rather than queues, so TCP backs off repeatedly and settles well
//     under the rate. Customers were getting far less than they paid for.
//
// Every class and filter id is derived from the address rather than
// remembered, so removal works after an agent restart with no state to
// reload and no bookkeeping to fall out of sync.
package shaper

import (
	"context"
	"fmt"
	"net"
	"os/exec"
	"strings"
)

// classID derives a stable tc handle from a tunnel address.
//
// Tunnel subnets are small and private (a /24 per node today), so the last
// two octets are unique within one interface, which is the only scope
// these handles live in. Deterministic on purpose: Remove has to compute
// the same id later without having kept anything.
//
// 0 and 0xFFFF are avoided -- 0 is not a valid classid and 0xFFFF is the
// default class everything unmatched falls into.
func classID(ip net.IP) uint16 {
	v4 := ip.To4()
	if v4 == nil {
		return 0
	}
	id := uint16(v4[2])<<8 | uint16(v4[3])
	if id == 0 || id == 0xFFFF {
		return 1
	}
	return id
}

// redirectPrio is the fixed priority of the catch-all filter mirroring
// ingress onto the IFB device. Fixed so re-running EnsureRoot replaces it
// rather than stacking a second mirror.
//
// It cannot collide with a per-user priority despite those being derived
// from addresses (and .1 deriving exactly 1): this filter lives on the
// tunnel interface ingress qdisc, while per-user filters live on the
// tunnel egress and on the IFB device. Different parents, separate
// priority spaces.
const redirectPrio = "1"

// Runner executes a command. Swapped out in tests so the argument lists
// can be asserted without a Linux box or root.
type Runner func(ctx context.Context, name string, args ...string) error

func execRunner(ctx context.Context, name string, args ...string) error {
	out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %w (%s)", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

type Shaper struct {
	iface string
	// ifb is the intermediate device inbound traffic is redirected to so
	// it can be shaped as egress. Interface names are capped at 15
	// characters by the kernel, hence the short prefix.
	ifb string
	run Runner
}

func New(iface string) *Shaper {
	return &Shaper{iface: iface, ifb: ifbNameFor(iface), run: execRunner}
}

func ifbNameFor(iface string) string {
	name := "ifb-" + iface
	if len(name) > 15 {
		name = name[:15]
	}
	return name
}

// EnsureRoot installs the qdiscs every per-user rule hangs off.
//
// Called before the first user is shaped and safe to repeat: `replace`
// creates or overwrites rather than failing on an existing qdisc, so an
// agent restart does not need to know whether it ran before.
//
// The default class is deliberately unlimited. A user with no cap, and any
// traffic that is not a customer's, must keep running at full speed --
// this feature slows down the customers it is told to and nobody else.
func (s *Shaper) EnsureRoot(ctx context.Context) error {
	// Download: HTB directly on the tunnel interface.
	if err := s.run(ctx, "tc", "qdisc", "replace", "dev", s.iface, "root", "handle", "1:", "htb", "default", "ffff"); err != nil {
		return err
	}

	// Upload: inbound traffic has to become egress somewhere before it can
	// be shaped, so it is mirrored onto an IFB device. Each step below is
	// create-or-already-exists; failures are ignored for exactly that
	// reason, and a real problem surfaces when the class is added.
	_ = s.run(ctx, "modprobe", "ifb")
	_ = s.run(ctx, "ip", "link", "add", s.ifb, "type", "ifb")
	if err := s.run(ctx, "ip", "link", "set", s.ifb, "up"); err != nil {
		return fmt.Errorf("bringing up %s: %w", s.ifb, err)
	}
	// Ingress has no replace, and adding it twice errors rather than being
	// a no-op, so this is ignored: the only realistic cause is that it
	// already exists, which is the desired state.
	_ = s.run(ctx, "tc", "qdisc", "add", "dev", s.iface, "handle", "ffff:", "ingress")
	// One redirect for everything arriving, at a fixed priority so
	// re-running replaces it rather than stacking a second mirror.
	_ = s.run(ctx, "tc", "filter", "del", "dev", s.iface, "parent", "ffff:", "prio", redirectPrio)
	if err := s.run(ctx, "tc", "filter", "add", "dev", s.iface, "parent", "ffff:", "protocol", "all",
		"prio", redirectPrio, "u32", "match", "u32", "0", "0",
		"action", "mirred", "egress", "redirect", "dev", s.ifb); err != nil {
		return fmt.Errorf("redirecting %s ingress to %s: %w", s.iface, s.ifb, err)
	}
	if err := s.run(ctx, "tc", "qdisc", "replace", "dev", s.ifb, "root", "handle", "1:", "htb", "default", "ffff"); err != nil {
		return err
	}
	return nil
}

// Apply caps one customer. A zero rate means "no limit in this direction"
// and installs nothing, so an uncapped plan is genuinely untouched rather
// than shaped at some very high number.
func (s *Shaper) Apply(ctx context.Context, address string, downMbps, upMbps uint32) error {
	ip, err := parseAddress(address)
	if err != nil {
		return err
	}
	id := classID(ip)
	if id == 0 {
		return fmt.Errorf("shaper: %q is not an IPv4 tunnel address", address)
	}

	// Removed first so re-applying a changed cap replaces the old one
	// instead of layering a second rule beside it, which would leave the
	// customer on whichever rule tc happened to match first.
	s.remove(ctx, id)

	if downMbps > 0 {
		classid := fmt.Sprintf("1:%x", id)
		rate := fmt.Sprintf("%dmbit", downMbps)
		// quantum is set explicitly because HTB derives it from r2q
		// otherwise, and at these rates the kernel warns that the derived
		// value is too big -- a large quantum means one class can send a
		// long burst before yielding, which hurts fairness between users
		// sharing the interface. One MTU is the usual choice.
		if err := s.run(ctx, "tc", "class", "replace", "dev", s.iface, "parent", "1:", "classid", classid,
			"htb", "rate", rate, "ceil", rate, "quantum", "1514"); err != nil {
			return err
		}
		if err := s.run(ctx, "tc", "filter", "add", "dev", s.iface, "protocol", "ip", "parent", "1:",
			"prio", fmt.Sprint(id), "u32", "match", "ip", "dst", ip.String()+"/32", "flowid", classid); err != nil {
			return err
		}
	}

	if upMbps > 0 {
		// Shaped on the IFB device, where the customer traffic is egress
		// and can be queued. Matched on source, since from the node this
		// is traffic coming from the customer.
		classid := fmt.Sprintf("1:%x", id)
		rate := fmt.Sprintf("%dmbit", upMbps)
		if err := s.run(ctx, "tc", "class", "replace", "dev", s.ifb, "parent", "1:", "classid", classid,
			"htb", "rate", rate, "ceil", rate, "quantum", "1514"); err != nil {
			return err
		}
		if err := s.run(ctx, "tc", "filter", "add", "dev", s.ifb, "protocol", "ip", "parent", "1:",
			"prio", fmt.Sprint(id), "u32", "match", "ip", "src", ip.String()+"/32", "flowid", classid); err != nil {
			return err
		}
	}
	return nil
}

// Remove drops a customer's caps. Best-effort: this runs while tearing a
// user down, and a rule that is already gone is the desired end state.
func (s *Shaper) Remove(ctx context.Context, address string) error {
	ip, err := parseAddress(address)
	if err != nil {
		return err
	}
	s.remove(ctx, classID(ip))
	return nil
}

func (s *Shaper) remove(ctx context.Context, id uint16) {
	if id == 0 {
		return
	}
	prio := fmt.Sprint(id)
	classid := fmt.Sprintf("1:%x", id)
	_ = s.run(ctx, "tc", "filter", "del", "dev", s.iface, "parent", "1:", "prio", prio)
	_ = s.run(ctx, "tc", "class", "del", "dev", s.iface, "classid", classid)
	_ = s.run(ctx, "tc", "filter", "del", "dev", s.ifb, "parent", "1:", "prio", prio)
	_ = s.run(ctx, "tc", "class", "del", "dev", s.ifb, "classid", classid)
}

// parseAddress accepts the tunnel address in either the bare form or the
// "10.66.0.5/32" the control plane stores for WireGuard peers.
func parseAddress(address string) (net.IP, error) {
	address = strings.TrimSpace(address)
	if address == "" {
		return nil, fmt.Errorf("shaper: no tunnel address to shape")
	}
	if i := strings.IndexByte(address, '/'); i >= 0 {
		address = address[:i]
	}
	ip := net.ParseIP(address)
	if ip == nil || ip.To4() == nil {
		return nil, fmt.Errorf("shaper: %q is not an IPv4 tunnel address", address)
	}
	return ip.To4(), nil
}

func maxUint32(a, b uint32) uint32 {
	if a > b {
		return a
	}
	return b
}

// NewWithRunner builds a Shaper that executes commands through the given
// runner instead of tc. Exists so callers in other packages can exercise
// their own shaping logic without a kernel or root.
func NewWithRunner(iface string, run Runner) *Shaper {
	return &Shaper{iface: iface, ifb: ifbNameFor(iface), run: run}
}
