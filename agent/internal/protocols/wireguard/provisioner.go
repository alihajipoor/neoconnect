// Package wireguard implements common.Provisioner against a local
// WireGuard interface via the `wg` CLI -- there is no daemon/API like
// Xray's; `wg set` mutates the running interface directly and affects
// only the targeted peer, satisfying the same no-interruption contract
// as the Xray provisioner. Peer state is not persisted back into
// wg0.conf (a `wg-quick` restart would lose hot-added peers) -- this
// mirrors the equivalent, already-accepted limitation on the Xray side
// (see xray.Provisioner) and will be closed by the StateSnapshot
// reconciliation flow described in the architecture plan, not yet built.
package wireguard

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/neoxify/neoxify-hub/agent/internal/protocols/common"
)

// Provisioner manages peers on a single WireGuard interface, identified
// by its name (e.g. "wg0", see installer/lib/agent.sh's install_wireguard).
type Provisioner struct {
	iface string

	// Where interfaces appear, so notServingWireguard can be tested
	// without a real wg device. Always /sys/class/net in production.
	sysNetDir string
	// How the wg tool is located. Injected for the same reason: without
	// it the "installed but interface down" case can only be exercised on
	// a machine that happens to have WireGuard tools, so the test skipped
	// everywhere it mattered and proved nothing.
	lookPath func(string) (string, error)

	mu       sync.Mutex
	lastSeen map[string][2]uint64 // pubkey -> cumulative [rx, tx] at last poll
}

func New(iface string) *Provisioner {
	return &Provisioner{
		iface:     iface,
		sysNetDir: "/sys/class/net",
		lookPath:  exec.LookPath,
		lastSeen:  make(map[string][2]uint64),
	}
}

// notServingWireguard reports whether there is no WireGuard here to poll:
// the interface does not exist and the `wg` tool is not even installed.
//
// The same problem the IKEv2 provisioner had, and the same shape of fix,
// but a different discriminator because this provisioner keeps no user
// map -- peers live in the kernel, added with `wg set`, so there is
// nothing in memory to count.
//
// The interface is the better signal anyway. If wg0 exists, WireGuard is
// set up here and a polling failure is real: a node whose usage stops
// being counted while its peers keep transferring is an unmetered path
// around every data cap, which must stay loud. If wg0 does not exist
// there are no peers and no traffic to miss, whatever the reason.
//
// Both conditions rather than the interface alone, so that a node which
// has WireGuard installed but whose interface is currently down still
// reports -- that is a fault worth seeing, not an absence.
//
// Measured 2026-08-15: singapore-1 (OpenVPN and IKEv2 only) has neither
// the binary nor wg0 and was logging two errors a minute about both
// StatsSince and SessionCounts; finland1 has both plus sixteen peers.
func (p *Provisioner) notServingWireguard() bool {
	if _, err := os.Stat(filepath.Join(p.sysNetDir, p.iface)); err == nil {
		return false
	}
	_, err := p.lookPath("wg")
	return err != nil
}

func (p *Provisioner) CreateUser(ctx context.Context, user common.ProtocolUser) error {
	pubKey := user.Credentials["publicKey"]
	address := user.Credentials["address"]
	if pubKey == "" || address == "" {
		return fmt.Errorf("wireguard CreateUser: credentials missing publicKey/address")
	}
	if !strings.Contains(address, "/") {
		address += "/32"
	}
	return p.run(ctx, "set", p.iface, "peer", pubKey, "allowed-ips", address)
}

func (p *Provisioner) UpdateUser(ctx context.Context, user common.ProtocolUser) error {
	// No in-place "update a peer's allowed-ips" op that's meaningfully
	// different from re-adding it -- `wg set` on an existing peer just
	// overwrites its config anyway, so this is a plain re-apply. Only
	// this one peer is touched either way.
	return p.CreateUser(ctx, user)
}

func (p *Provisioner) RemoveUser(ctx context.Context, externalUserID string) error {
	if err := p.run(ctx, "set", p.iface, "peer", externalUserID, "remove"); err != nil {
		return err
	}
	p.mu.Lock()
	delete(p.lastSeen, externalUserID)
	p.mu.Unlock()
	return nil
}

// SetEnabled(false) removes the peer entirely -- WireGuard has no
// separate "disabled but still configured" peer state. Re-enabling
// needs the original allowed-ips back, which this interface doesn't
// carry, so enabled=true is rejected the same way the Xray provisioner
// rejects it: callers re-issue CreateUser with the full credentials.
func (p *Provisioner) SetEnabled(ctx context.Context, externalUserID string, enabled bool) error {
	if !enabled {
		return p.RemoveUser(ctx, externalUserID)
	}
	return fmt.Errorf("wireguard SetEnabled(true) not supported -- use CreateUser with the user's credentials")
}

func (p *Provisioner) StatsSince(ctx context.Context) ([]common.UsageDelta, error) {
	if p.notServingWireguard() {
		return nil, nil
	}
	out, err := exec.CommandContext(ctx, "wg", "show", p.iface, "transfer").Output()
	if err != nil {
		return nil, fmt.Errorf("wg show %s transfer: %w", p.iface, err)
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	var deltas []common.UsageDelta
	seen := make(map[string]bool)
	scanner := bufio.NewScanner(bytes.NewReader(out))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) != 3 {
			continue
		}
		pubKey, rx, tx := fields[0], parseUint(fields[1]), parseUint(fields[2])
		seen[pubKey] = true

		prev := p.lastSeen[pubKey]
		// wg reports cumulative counters since the interface came up, not
		// deltas -- diff against the last poll. A lower reading than last
		// time means the peer was removed and re-added (counters reset),
		// so treat the fresh value as the whole delta instead of going
		// negative.
		deltaRx := rx - prev[0]
		if rx < prev[0] {
			deltaRx = rx
		}
		deltaTx := tx - prev[1]
		if tx < prev[1] {
			deltaTx = tx
		}
		p.lastSeen[pubKey] = [2]uint64{rx, tx}

		if deltaRx > 0 || deltaTx > 0 {
			// Server rx (bytes received from the peer) is the user's
			// uplink; server tx (bytes sent to the peer) is downlink --
			// same convention as the Xray provisioner's stats.
			deltas = append(deltas, common.UsageDelta{ExternalUserID: pubKey, BytesUp: deltaRx, BytesDown: deltaTx})
		}
	}

	for pubKey := range p.lastSeen {
		if !seen[pubKey] {
			delete(p.lastSeen, pubKey)
		}
	}

	return deltas, nil
}

func (p *Provisioner) run(ctx context.Context, args ...string) error {
	out, err := exec.CommandContext(ctx, "wg", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("wg %s: %w (%s)", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

func parseUint(s string) uint64 {
	n, _ := strconv.ParseUint(s, 10, 64)
	return n
}
