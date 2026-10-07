// Package ikev2 manages IKEv2/IPsec users on strongSwan.
//
// The odd one out among the engines here: nothing ships in the client
// for it. Windows and Android both dial IKEv2 with the operating
// system's own VPN client, so this provisioner's whole job is telling
// strongSwan which username and password to accept.
//
// Users are EAP-MSCHAPv2 secrets in a swanctl config file of their own,
// separate from the connection definition, so rewriting the user list
// never touches the connection. `swanctl --load-creds` then re-reads
// them without disturbing any established SA: EAP runs once at
// authentication, so a session already up does not consult the secret
// again. That is what satisfies this project's no-interruption rule,
// the same way AlterInbound does for Xray and `wg set peer` for
// WireGuard.
package ikev2

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/neoxify/neoxify-hub/agent/internal/protocols/common"
)

// Provisioner manages the EAP secrets file and reloads strongSwan.
type Provisioner struct {
	// secretsPath is the file this owns entirely. Nothing else writes to
	// it, so the provisioner can rewrite it wholesale rather than trying
	// to edit in place -- which for a config format with no stable
	// anchors is the difference between correct and nearly correct.
	secretsPath string
	swanctl     string
	// runSwanctl runs swanctl. A field so a test can stand in for
	// strongSwan, which nothing off a node can run: the output it parses
	// and the arguments it sends are exactly the parts that went wrong.
	runSwanctl swanctlRunner

	// Guards both the in-memory set and the file, because the dispatcher
	// may apply several commands concurrently and a lost update here is
	// a customer who cannot connect.
	mu    sync.Mutex
	users map[string]string // username -> password
	// Per-CHILD_SA byte totals from the previous poll, so a delta can be
	// taken without a rekey looking like a customer using nothing.
	lastBytes map[string]saBytes
	// primed is false until the first successful read since this process
	// started; that read is the baseline and reports nothing. strongSwan
	// keeps running across an agent restart and the installer sets
	// rekey_time = 0s, so a CHILD_SA's totals can span a whole connection
	// -- and without a baseline all of it was billed again after every
	// agent rollout. See the WireGuard provisioner's primed for the full
	// story. Only a read takes the baseline: not a failed one, and not the
	// early return where IKEv2 is not served here.
	primed bool
}

// swanctlRunner runs swanctl with the given arguments and returns what it
// wrote to stdout and to stderr separately: only stdout is ever parsed,
// so nothing strongSwan logs on the way (its plugin loader is chatty) can
// land in the middle of the output being read.
type swanctlRunner func(ctx context.Context, args ...string) (stdout, stderr string, err error)

func New(secretsPath, swanctlPath string) *Provisioner {
	if swanctlPath == "" {
		swanctlPath = "swanctl"
	}
	p := &Provisioner{
		secretsPath: secretsPath,
		swanctl:     swanctlPath,
		users:       map[string]string{},
		lastBytes:   map[string]saBytes{},
	}
	p.runSwanctl = p.execSwanctl
	return p
}

// CreateUser adds an EAP identity and makes strongSwan aware of it.
func (p *Provisioner) CreateUser(ctx context.Context, user common.ProtocolUser) error {
	username, password, err := credentials(user)
	if err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	// Idempotent on purpose: the outbox replays commands after a
	// reconnect, and re-adding a user with the same credentials must be
	// a no-op rather than an error.
	p.users[username] = password
	return p.flushLocked(ctx)
}

// UpdateUser is the same write. A changed password replaces the old one;
// an unchanged one rewrites the same bytes.
func (p *Provisioner) UpdateUser(ctx context.Context, user common.ProtocolUser) error {
	return p.CreateUser(ctx, user)
}

// RemoveUser drops the identity and disconnects anyone using it.
//
// Both halves matter. Removing the secret stops the next
// authentication, but an established SA authenticated before the
// change and would otherwise keep running -- which for a deletion or a
// blown quota is exactly the session that should stop.
func (p *Provisioner) RemoveUser(ctx context.Context, externalUserID string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.users, externalUserID)
	if err := p.flushLocked(ctx); err != nil {
		return err
	}
	return p.terminate(ctx, externalUserID)
}

// SetEnabled disables by removing the secret, and re-enables by putting
// it back.
//
// Re-enabling needs the password, which this holds in memory only for
// the life of the process. After a restart the agent's reconciliation
// replays CREATE_USER for everyone it should have, so the credential
// arrives again -- rather than this reaching for a copy it should not
// be keeping on disk in plaintext beyond the secrets file itself.
func (p *Provisioner) SetEnabled(ctx context.Context, externalUserID string, enabled bool) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if enabled {
		if _, known := p.users[externalUserID]; !known {
			return fmt.Errorf("ikev2: no credential held for %q; it will return with the next sync", externalUserID)
		}
		return p.flushLocked(ctx)
	}
	delete(p.users, externalUserID)
	if err := p.flushLocked(ctx); err != nil {
		return err
	}
	return p.terminate(ctx, externalUserID)
}

// notServingIkev2 reports whether there is nothing here to poll: no user
// has been provisioned on this node, and strongSwan's CLI is not even
// installed.
//
// Both halves are load-bearing, and the reason is the difference between
// two situations that look identical from inside this file.
//
// A relay or Xray-only node never serves IKEv2 and has no swanctl. It
// still registers this provisioner, deliberately -- registration is
// unconditional so that an IKEV2 command arriving at a node that cannot
// serve it fails loudly rather than being silently ignored (see the flag
// comments in cmd/agentd/main.go). But the stats poll runs every 30s
// regardless of commands, so on those nodes it produced two errors a
// minute, forever, about a protocol the node was never asked to serve.
// Measured on ir1, which has twelve protocol configs and not one of them
// IKEV2.
//
// A node that *does* serve IKEv2 and has lost strongSwan is the opposite
// case and must stay loud: its customers authenticate against a dead
// engine, or worse, its usage stops being counted while sessions carry
// on -- an unmetered path around every data cap, which is exactly the
// failure the restriction-matrix work was worried about. That node has
// provisioned users, so `len(p.users) > 0` keeps the error.
//
// The user count is the discriminator rather than the binary's absence
// alone, because after an agent restart the in-memory set is empty until
// the control plane re-asserts. On a real IKEv2 node swanctl is present,
// so the second half is false and nothing is suppressed during that
// window.
func (p *Provisioner) notServingIkev2() bool {
	p.mu.Lock()
	provisioned := len(p.users)
	p.mu.Unlock()
	if provisioned > 0 {
		return false
	}
	return !p.swanctlAvailable()
}

// swanctlAvailable reports whether the configured swanctl can be found.
//
// Honours an explicit path as a path and a bare name as a PATH lookup,
// matching how exec.Command would resolve it -- checking only PATH would
// call a node with `-ikev2-swanctl=/usr/sbin/swanctl` unavailable, and
// stat'ing a bare name would look for "swanctl" in the working
// directory.
func (p *Provisioner) swanctlAvailable() bool {
	if strings.ContainsAny(p.swanctl, `/\`) {
		_, err := os.Stat(p.swanctl)
		return err == nil
	}
	_, err := exec.LookPath(p.swanctl)
	return err == nil
}

// StatsSince reports traffic since the last call, per user.
//
// strongSwan reports totals per CHILD_SA, and a CHILD_SA is replaced on
// every rekey and every reconnect -- so the totals restart from zero
// under a live customer. Subtracting the previous reading per *user*
// would then go negative and, clamped at zero, quietly lose everything
// since the last poll.
//
// So the counters are tracked per CHILD_SA and only summed per user after
// the delta is taken. A child that disappears between polls contributes
// its last observed growth and is then forgotten; a new one starts from
// zero, which is correct because it genuinely has carried nothing yet.
// Per CHILD_SA and not per IKE SA, because an IKE rekey moves the
// existing children, counters and all, to a new IKE SA.
func (p *Provisioner) StatsSince(ctx context.Context) ([]common.UsageDelta, error) {
	if p.notServingIkev2() {
		return nil, nil
	}
	sas, err := p.listSAs(ctx)
	if err != nil {
		return nil, err
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	// Only a successful read can be the baseline -- see primed.
	baseline := !p.primed
	p.primed = true

	perUser := map[string]*common.UsageDelta{}
	seen := map[string]bool{}
	for _, sa := range sas {
		if sa.user == "" {
			continue
		}
		for _, child := range sa.children {
			key := child.key(sa.id)
			seen[key] = true
			prev := p.lastBytes[key]
			p.lastBytes[key] = saBytes{in: child.bytesIn, out: child.bytesOut}
			if baseline {
				continue
			}

			d := perUser[sa.user]
			if d == nil {
				d = &common.UsageDelta{ExternalUserID: sa.user}
				perUser[sa.user] = d
			}
			// Into the node is the customer's upload, out of it their
			// download -- the convention the WireGuard and OpenVPN
			// provisioners use, where the server's rx is the user's
			// uplink.
			d.BytesUp += counterDelta(prev.in, child.bytesIn)
			d.BytesDown += counterDelta(prev.out, child.bytesOut)
		}
	}
	// Forget children that are gone, or this map grows for the life of
	// the process on a busy node.
	for key := range p.lastBytes {
		if !seen[key] {
			delete(p.lastBytes, key)
		}
	}

	deltas := make([]common.UsageDelta, 0, len(perUser))
	for _, d := range perUser {
		if d.BytesUp == 0 && d.BytesDown == 0 {
			continue
		}
		deltas = append(deltas, *d)
	}
	return deltas, nil
}

// counterDelta is the growth of a cumulative counter since the last
// reading. One that went backwards belongs to an SA replaced under the
// same key, so all of its value is new.
func counterDelta(prev, cur uint64) uint64 {
	if cur >= prev {
		return cur - prev
	}
	return cur
}

// SessionCounts reports how many distinct places each user is connected
// from, which is what the account-wide connection limit is evaluated
// against.
//
// strongSwan will happily run the same EAP identity from several places
// at once; without this, one credential could be shared across any number
// of devices over IKEv2 and nothing would notice. (WireGuard and OpenVPN
// limit devices that share one key or certificate, but with per-device
// credentials devices no longer share one; the backend judges the plan's
// device limit per device.)
//
// Counted by distinct remote address rather than by SA: a phone moving
// between wifi and mobile data, or simply rekeying, can briefly hold two
// SAs from the same place, and charging that against the limit would
// disconnect somebody who did nothing wrong.
//
// And only SAs that are live (see live). Nothing on the server ends a dead
// one -- the connection sets rekey_time = 0s and no DPD -- so a phone that
// died, or a PC that slept, on IKEv2 stays listed until charon restarts:
// the sample captured from a node has two, each about 21 hours old and
// silent since its first minute. Counted, each would have been a device
// in use every 30 s for as long as charon ran, keeping its device slot
// and pushing the customer's next device into a device-limit refusal.
// Found by the second 2026-10-06 review, before the parser that made the
// count possible had shipped.
func (p *Provisioner) SessionCounts() (map[string]int, error) {
	if p.notServingIkev2() {
		return nil, nil
	}
	sas, err := p.listSAs(context.Background())
	if err != nil {
		return nil, err
	}
	hosts := map[string]map[string]bool{}
	for _, sa := range sas {
		if sa.user == "" || sa.remoteHost == "" || !sa.live() {
			continue
		}
		if hosts[sa.user] == nil {
			hosts[sa.user] = map[string]bool{}
		}
		hosts[sa.user][sa.remoteHost] = true
	}
	counts := make(map[string]int, len(hosts))
	for user, set := range hosts {
		counts[user] = len(set)
	}
	return counts, nil
}

// inboundFreshFor is how recently, in seconds, a packet must have
// arrived from the client for its session to count as a device in use:
// three minutes, the window WireGuard's session count gives a handshake.
//
// It errs towards counting fewer devices. A connected client that sends
// nothing for three minutes drops out of the count, and its bytes, which
// the control plane also reads, show it again the moment it does. Its
// NAT-T keepalives and IKE liveness checks never pass through the
// CHILD_SA, so they do not keep it counted. (use-in is the kernel SA's
// last-use time; that ESP alone moves it is reasoned from strongSwan and
// the kernel, not observed on a node.)
const inboundFreshFor = 180

// live reports whether this SA is a client connected now: established --
// so user is the identity EAP proved, not one a half-open SA merely
// claims -- with a CHILD_SA that has had a packet from the client within
// inboundFreshFor.
func (sa saInfo) live() bool {
	if sa.state != "ESTABLISHED" {
		return false
	}
	for _, child := range sa.children {
		if child.useIn >= 0 && child.useIn <= inboundFreshFor {
			return true
		}
	}
	return false
}

type saBytes struct{ in, out uint64 }

// listSAs reads the live SAs out of swanctl.
//
// `--raw` rather than the human-formatted default: the pretty output is
// laid out for reading and its shape is not a promise, while the raw
// form is the VICI message itself. parse.go shows what it looks like.
//
// Loud when swanctl listed SAs and none of them could be read. That is
// the failure that went unnoticed: a parser that matches nothing returns
// an empty list, indistinguishable from nobody being connected, and
// IKEv2 becomes an unmetered path around every data cap with nothing in
// any log.
func (p *Provisioner) listSAs(ctx context.Context) ([]saInfo, error) {
	stdout, stderr, err := p.runSwanctl(ctx, "--list-sas", "--raw")
	if err != nil {
		return nil, fmt.Errorf("ikev2: could not list security associations: %w (%s)", err, joinOutput(stdout, stderr))
	}
	sas, events := parseSAs(stdout)
	if events > 0 && len(sas) == 0 {
		return nil, fmt.Errorf("ikev2: swanctl listed %d security association(s) and none could be read -- its --raw output is not what parse.go expects, and IKEv2 usage is going uncounted", events)
	}
	if len(sas) < events {
		log.Printf("ikev2: %d of %d security associations in swanctl's output could not be read", events-len(sas), events)
	}
	return sas, nil
}

// flushLocked rewrites the secrets file and reloads it.
//
// Written to a temporary file and renamed, so a crash midway leaves the
// previous list intact rather than a half-written one that strongSwan
// would refuse and every customer would fail against.
func (p *Provisioner) flushLocked(ctx context.Context) error {
	var b strings.Builder
	b.WriteString("# Managed by neoxify-agentd. Edits here are overwritten.\n")
	b.WriteString("secrets {\n")
	// Sorted so an unchanged user list produces an unchanged file, which
	// makes a diff meaningful when someone is looking for why a node
	// behaves differently from its neighbour.
	names := make([]string, 0, len(p.users))
	for name := range p.users {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		fmt.Fprintf(&b, "    eap-%s {\n        id = %s\n        secret = %q\n    }\n", name, name, p.users[name])
	}
	b.WriteString("}\n")

	dir := filepath.Dir(p.secretsPath)
	tmp, err := os.CreateTemp(dir, ".neoxify-users-*.conf")
	if err != nil {
		return fmt.Errorf("ikev2: could not stage the secrets file: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	// 0600 before any content: the file holds every customer's password
	// on this node, and the window between create and chmod is a window.
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return fmt.Errorf("ikev2: could not secure the secrets file: %w", err)
	}
	if _, err := tmp.WriteString(b.String()); err != nil {
		tmp.Close()
		return fmt.Errorf("ikev2: could not write the secrets file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("ikev2: could not close the secrets file: %w", err)
	}
	if err := os.Rename(tmpName, p.secretsPath); err != nil {
		return fmt.Errorf("ikev2: could not replace the secrets file: %w", err)
	}

	// --clear so a removed user is actually gone. Without it swanctl
	// merges the file over what is already loaded and a deleted identity
	// keeps authenticating, which is the whole failure this call exists
	// to prevent. Established SAs are unaffected: EAP is consulted at
	// authentication and not again.
	if stdout, stderr, err := p.runSwanctl(ctx, "--load-creds", "--clear"); err != nil {
		return fmt.Errorf("ikev2: strongSwan refused the credentials: %w (%s)", err, joinOutput(stdout, stderr))
	}
	return nil
}

// terminate ends every IKE SA authenticated as this identity. A user with
// no live session is the normal case, not a failure.
//
// swanctl's --terminate picks SAs by connection name or by id (--ike,
// --child, --ike-id, --child-id) and has no identity filter. This used to
// pass `--eap-id`, which swanctl rejects as an invalid option before
// sending anything to charon -- and the error was swallowed, so a
// disabled, expired or deleted IKEv2 customer stayed connected until
// their own client hung up. Nothing on the server ends it later: the
// connection sets rekey_time = 0s and no DPD. Found by the 2026-10-06
// review.
//
// So the SAs are listed, this user's picked out, and each ended by its
// own id. --force deletes it here instead of waiting for the peer to
// confirm, which for a phone that has gone away would hold this command,
// and every command queued behind it, for as long as charon waits.
// Never `--ike neoxify-ikev2` on its own: that is every customer on the
// node.
//
// A failure is returned, not swallowed, so the outbox retries. A retry is
// safe: the secret is already gone, and the list finds only what is still
// up.
func (p *Provisioner) terminate(ctx context.Context, username string) error {
	sas, err := p.listSAs(ctx)
	if err != nil {
		return fmt.Errorf("ikev2: removed %q but could not list its sessions to end them: %w", username, err)
	}
	for _, sa := range sas {
		if sa.user != username {
			continue
		}
		stdout, stderr, err := p.runSwanctl(ctx, "--terminate", "--ike-id", sa.id, "--force")
		if err == nil {
			continue
		}
		// Gone between the list and the terminate: the client hung up on
		// its own, which is the outcome wanted.
		if up, listErr := p.saUp(ctx, sa.id); listErr == nil && !up {
			continue
		}
		return fmt.Errorf("ikev2: could not end %q's session (IKE SA %s): %w (%s)", username, sa.id, err, joinOutput(stdout, stderr))
	}
	return nil
}

// saUp reports whether an IKE SA with this id is still listed.
func (p *Provisioner) saUp(ctx context.Context, id string) (bool, error) {
	sas, err := p.listSAs(ctx)
	if err != nil {
		return false, err
	}
	for _, sa := range sas {
		if sa.id == id {
			return true, nil
		}
	}
	return false, nil
}

// execSwanctl is the real runSwanctl.
func (p *Provisioner) execSwanctl(ctx context.Context, args ...string) (string, string, error) {
	cmd := exec.CommandContext(ctx, p.swanctl, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	return stdout.String(), stderr.String(), err
}

// joinOutput is both of swanctl's streams, for an error message.
func joinOutput(stdout, stderr string) string {
	return strings.TrimSpace(strings.TrimSpace(stdout) + "\n" + strings.TrimSpace(stderr))
}

// credentials pulls the two fields the control plane generates for this
// protocol, and refuses anything else rather than writing a config that
// would silently accept nobody.
func credentials(user common.ProtocolUser) (string, string, error) {
	username := user.Credentials["username"]
	password := user.Credentials["password"]
	if username == "" || password == "" {
		return "", "", fmt.Errorf("ikev2: user %q is missing its username or password", user.ExternalUserID)
	}
	// swanctl's parser has no escape for a newline inside a quoted
	// value, so one would truncate the file and take every user after it
	// with it. Generated credentials never contain one; a hand-edited
	// row could.
	if strings.ContainsAny(username, "\r\n\"") || strings.ContainsAny(password, "\r\n") {
		return "", "", fmt.Errorf("ikev2: user %q has a credential containing a newline or quote", user.ExternalUserID)
	}
	return username, password, nil
}
