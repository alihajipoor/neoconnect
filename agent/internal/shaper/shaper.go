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
//   - Upload (customer -> node) arrives, so there is nothing to queue. It
//     is policed on ingress instead, which drops over-rate packets and
//     lets TCP back off. Coarser than shaping, and the standard approach.
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
	run   Runner
}

func New(iface string) *Shaper {
	return &Shaper{iface: iface, run: execRunner}
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
	if err := s.run(ctx, "tc", "qdisc", "replace", "dev", s.iface, "root", "handle", "1:", "htb", "default", "ffff"); err != nil {
		return err
	}
	// Ingress has no replace, and adding it twice is an error rather than a
	// no-op, so a failure here is ignored: the only realistic cause is that
	// it already exists, which is the desired state.
	_ = s.run(ctx, "tc", "qdisc", "add", "dev", s.iface, "handle", "ffff:", "ingress")
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
		rate := fmt.Sprintf("%dmbit", upMbps)
		// A burst well above one packet, or the policer drops so eagerly
		// that TCP never reaches the rate it is allowed.
		burst := fmt.Sprintf("%dk", maxUint32(upMbps*125/8, 32))
		if err := s.run(ctx, "tc", "filter", "add", "dev", s.iface, "protocol", "ip", "parent", "ffff:",
			"prio", fmt.Sprint(id), "u32", "match", "ip", "src", ip.String()+"/32",
			"police", "rate", rate, "burst", burst, "drop", "flowid", ":1"); err != nil {
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
	_ = s.run(ctx, "tc", "filter", "del", "dev", s.iface, "parent", "1:", "prio", prio)
	_ = s.run(ctx, "tc", "filter", "del", "dev", s.iface, "parent", "ffff:", "prio", prio)
	_ = s.run(ctx, "tc", "class", "del", "dev", s.iface, "classid", fmt.Sprintf("1:%x", id))
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
	return &Shaper{iface: iface, run: run}
}
