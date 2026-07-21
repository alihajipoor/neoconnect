// Package enroll handles the one-time agent identity setup: generating the
// Ed25519 keypair used to authenticate the AgentSync stream, and trading a
// one-time admin-issued token for a Node ID via the control plane's
// /enrollment/claim HTTP endpoint.
package enroll

import (
	"crypto/ed25519"
	"crypto/rand"
)

// GenerateKeypair creates a fresh Ed25519 identity for this agent. Called
// exactly once, at `agentd --enroll-init` time; the result is persisted by
// the caller (see config.Config) and reused for every AgentSync Hello
// afterwards.
func GenerateKeypair() (ed25519.PublicKey, ed25519.PrivateKey, error) {
	return ed25519.GenerateKey(rand.Reader)
}
