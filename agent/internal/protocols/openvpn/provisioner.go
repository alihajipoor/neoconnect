// Package openvpn implements common.Provisioner against a local OpenVPN
// server. Unlike Xray/WireGuard, an OpenVPN client's cert IS its
// credential -- the server has no per-user "add" step, since possessing
// a cert signed by the trusted CA is sufficient authorization by design
// (see the CA-centralization note in
// apps/backend/src/modules/protocol-configs/openvpn-pki.ts). Access
// control instead uses OpenVPN's client-config-dir (ccd) "disable"
// directive: a per-CN file that rejects that client's connection
// attempts, checked on every handshake, combined with the Management
// Interface's `kill <CN>` for dropping an already-connected session
// immediately -- the same standard technique real-world OpenVPN
// deployments use for revocation without needing a CRL.
package openvpn

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/neoxify/neoxify-hub/agent/internal/protocols/common"
)

type Provisioner struct {
	mgmtAddr string
	ccdDir   string

	mu       sync.Mutex
	lastSeen map[string][2]uint64 // CN -> cumulative [bytesReceived, bytesSent] at last poll
}

func New(mgmtAddr, ccdDir string) *Provisioner {
	return &Provisioner{mgmtAddr: mgmtAddr, ccdDir: ccdDir, lastSeen: make(map[string][2]uint64)}
}

// CreateUser doesn't need to touch the OpenVPN server at all -- the
// signed cert the control plane already generated (see generate-
// credentials.ts) is what authorizes this client. What it does need to
// do is clear any stale ccd "disable" file for this CN, so this also
// doubles as the re-enable path (ENABLE_USER dispatches here too -- see
// agent/internal/dispatch).
func (p *Provisioner) CreateUser(ctx context.Context, user common.ProtocolUser) error {
	if user.ExternalUserID == "" {
		return fmt.Errorf("openvpn CreateUser: missing commonName")
	}
	return p.removeDisableFile(user.ExternalUserID)
}

func (p *Provisioner) UpdateUser(ctx context.Context, user common.ProtocolUser) error {
	return p.CreateUser(ctx, user)
}

// RemoveUser writes a ccd "disable" file (blocks all future reconnects
// for this CN, no restart needed -- OpenVPN checks ccd on every
// handshake) and best-effort kills any currently-connected session for
// immediate effect. A kill failure (client not currently connected) is
// not an error -- the ccd file is what actually does the revoking.
func (p *Provisioner) RemoveUser(ctx context.Context, externalUserID string) error {
	if err := p.writeDisableFile(externalUserID); err != nil {
		return err
	}
	_, _ = p.mgmtCommand(fmt.Sprintf("kill %s", externalUserID))
	return nil
}

// SetEnabled(false) is the same as RemoveUser -- OpenVPN has no separate
// "disabled but configured" state beyond the ccd disable file. Re-
// enabling needs the original cert/key back, which this interface
// doesn't carry, so enabled=true is rejected the same way every other
// protocol's provisioner rejects it: callers re-issue CreateUser, which
// dispatch.go already routes ENABLE_USER to.
func (p *Provisioner) SetEnabled(ctx context.Context, externalUserID string, enabled bool) error {
	if !enabled {
		return p.RemoveUser(ctx, externalUserID)
	}
	return fmt.Errorf("openvpn SetEnabled(true) not supported -- use CreateUser with the user's credentials")
}

func (p *Provisioner) StatsSince(ctx context.Context) ([]common.UsageDelta, error) {
	out, err := p.mgmtCommand("status 2")
	if err != nil {
		return nil, fmt.Errorf("mgmt status: %w", err)
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	var deltas []common.UsageDelta
	seen := make(map[string]bool)
	for _, line := range strings.Split(out, "\n") {
		// status version 2 CLIENT_LIST columns: CLIENT_LIST,Common Name,
		// Real Address,Virtual Address,Virtual IPv6 Address,Bytes
		// Received,Bytes Sent,...
		if !strings.HasPrefix(line, "CLIENT_LIST,") {
			continue
		}
		fields := strings.Split(line, ",")
		if len(fields) < 7 {
			continue
		}
		cn := fields[1]
		bytesReceived := parseUint(fields[5])
		bytesSent := parseUint(fields[6])
		seen[cn] = true

		prev := p.lastSeen[cn]
		// OpenVPN's counters are cumulative for the life of the session,
		// not deltas -- diff against the last poll, same as the
		// WireGuard provisioner. A lower reading means the client
		// reconnected (fresh session, counters reset).
		deltaRx := bytesReceived - prev[0]
		if bytesReceived < prev[0] {
			deltaRx = bytesReceived
		}
		deltaTx := bytesSent - prev[1]
		if bytesSent < prev[1] {
			deltaTx = bytesSent
		}
		p.lastSeen[cn] = [2]uint64{bytesReceived, bytesSent}

		if deltaRx > 0 || deltaTx > 0 {
			// Bytes received BY THE SERVER from the client is the
			// user's uplink; bytes sent is downlink -- same convention
			// as the Xray/WireGuard provisioners.
			deltas = append(deltas, common.UsageDelta{ExternalUserID: cn, BytesUp: deltaRx, BytesDown: deltaTx})
		}
	}

	for cn := range p.lastSeen {
		if !seen[cn] {
			delete(p.lastSeen, cn)
		}
	}

	return deltas, nil
}

func (p *Provisioner) writeDisableFile(cn string) error {
	if err := os.MkdirAll(p.ccdDir, 0o755); err != nil {
		return fmt.Errorf("mkdir ccd dir: %w", err)
	}
	return os.WriteFile(filepath.Join(p.ccdDir, cn), []byte("disable\n"), 0o644)
}

func (p *Provisioner) removeDisableFile(cn string) error {
	err := os.Remove(filepath.Join(p.ccdDir, cn))
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove ccd disable file: %w", err)
	}
	return nil
}

// mgmtCommand sends a single command to OpenVPN's local Management
// Interface and returns its raw text response. The protocol is a
// simple line-oriented TCP text protocol (see OpenVPN's
// management-notes.txt); this agent only ever dials 127.0.0.1, where
// the installer binds the mgmt interface with no password
// (--management 127.0.0.1 <port>, no --management-client-auth --
// loopback-only is the access control here, see installer/lib/agent.sh).
func (p *Provisioner) mgmtCommand(cmd string) (string, error) {
	conn, err := net.DialTimeout("tcp", p.mgmtAddr, 5*time.Second)
	if err != nil {
		return "", fmt.Errorf("dial management interface at %s: %w", p.mgmtAddr, err)
	}
	defer conn.Close()

	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	reader := bufio.NewReader(conn)

	// OpenVPN's mgmt interface sends a ">INFO:..." banner line on
	// connect before it will accept any command.
	if _, err := reader.ReadString('\n'); err != nil {
		return "", fmt.Errorf("read management banner: %w", err)
	}

	if _, err := conn.Write([]byte(cmd + "\n")); err != nil {
		return "", fmt.Errorf("write management command: %w", err)
	}

	var out strings.Builder
	for {
		line, err := reader.ReadString('\n')
		out.WriteString(line)
		if strings.HasPrefix(line, "END") || strings.HasPrefix(line, "SUCCESS:") || strings.HasPrefix(line, "ERROR:") {
			break
		}
		if err != nil {
			break
		}
	}
	return out.String(), nil
}

func parseUint(s string) uint64 {
	n, _ := strconv.ParseUint(strings.TrimSpace(s), 10, 64)
	return n
}

// ConnectedAddresses maps each currently-connected client's common name to
// the virtual address OpenVPN assigned it.
//
// Needed because OpenVPN hands out addresses from a server-side pool when
// a client connects, not when the user is provisioned -- so unlike
// WireGuard there is nothing to shape at creation time, and the caps can
// only be applied once someone is actually online. The management
// interface already reports this in the same `status 2` output StatsSince
// parses, so discovering it costs one extra command rather than a
// client-connect script on disk.
//
// Clients with no virtual address yet (mid-handshake) are skipped rather
// than reported with an empty address.
func (p *Provisioner) ConnectedAddresses() (map[string]string, error) {
	out, err := p.mgmtCommand("status 2")
	if err != nil {
		return nil, fmt.Errorf("mgmt status: %w", err)
	}

	addresses := make(map[string]string)
	for _, line := range strings.Split(out, "\n") {
		if !strings.HasPrefix(line, "CLIENT_LIST,") {
			continue
		}
		// CLIENT_LIST,Common Name,Real Address,Virtual Address,...
		fields := strings.Split(line, ",")
		if len(fields) < 4 {
			continue
		}
		cn := strings.TrimSpace(fields[1])
		virtual := strings.TrimSpace(fields[3])
		if cn == "" || virtual == "" {
			continue
		}
		addresses[cn] = virtual
	}
	return addresses, nil
}
