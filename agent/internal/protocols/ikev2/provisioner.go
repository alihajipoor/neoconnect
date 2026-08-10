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
	"context"
	"fmt"
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

	// Guards both the in-memory set and the file, because the dispatcher
	// may apply several commands concurrently and a lost update here is
	// a customer who cannot connect.
	mu    sync.Mutex
	users map[string]string // username -> password
}

func New(secretsPath, swanctlPath string) *Provisioner {
	if swanctlPath == "" {
		swanctlPath = "swanctl"
	}
	return &Provisioner{
		secretsPath: secretsPath,
		swanctl:     swanctlPath,
		users:       map[string]string{},
	}
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

// StatsSince reports nothing yet.
//
// Deliberately empty rather than approximated. strongSwan does track
// per-SA bytes and `swanctl --list-sas` exposes them, but a delta needs
// a stable per-user key across rekeys and reconnects, and getting that
// wrong bills a customer for traffic they did not use. Returning
// nothing means IKEv2 traffic is not counted against a quota, which is
// visible and safe; returning a guess would be neither.
func (p *Provisioner) StatsSince(ctx context.Context) ([]common.UsageDelta, error) {
	return nil, nil
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
	if out, err := p.run(ctx, "--load-creds", "--clear"); err != nil {
		return fmt.Errorf("ikev2: strongSwan refused the credentials: %w (%s)", err, out)
	}
	return nil
}

// terminate closes any SA belonging to an identity. Best effort: a user
// with no live session is the normal case, not a failure.
func (p *Provisioner) terminate(ctx context.Context, username string) error {
	if _, err := p.run(ctx, "--terminate", "--ike", "neoxify-ikev2", "--eap-id", username); err != nil {
		// Not returned as an error. The secret is already gone, so the
		// customer cannot re-authenticate either way, and failing the
		// whole command here would have the outbox retry a removal that
		// has in fact happened.
		return nil
	}
	return nil
}

func (p *Provisioner) run(ctx context.Context, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, p.swanctl, args...)
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
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
