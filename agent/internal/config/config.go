// Package config persists the agent's identity and connection settings
// across restarts. A plain JSON file is enough here -- this is a handful
// of fields written once at enroll time and read once at process start,
// not something that benefits from a heavier config format.
package config

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

const DefaultPath = "/etc/neoxify/agent.json"

type Config struct {
	NodeID     string `json:"nodeId"`
	PanelURL   string `json:"panelUrl"`
	GRPCTarget string `json:"grpcTarget"`
	// TLSServerName overrides the SNI presented on the control-plane
	// connection. Empty means "use the panel URL's host", which is the
	// right answer everywhere the panel's hostname is not itself hostile
	// territory.
	//
	// It exists because grpcTarget already answers "which address do I
	// dial" and nothing answered "which name do I announce". On
	// 2026-09-01 those had to differ: neoxify.site was SNI-blocked in
	// Iran, so the relay dialled the panel by IP -- correctly -- and then
	// announced the blocked name in the handshake and was cut off anyway.
	//
	// Whatever is set here must be covered by the panel's certificate, or
	// verification fails. That is deliberate: the point is to present a
	// different *valid* name, not to stop checking.
	TLSServerName string `json:"tlsServerName,omitempty"`
	PrivateKey    string `json:"privateKey"` // base64, 64-byte ed25519 seed+pubkey
	Role          string `json:"role"`
}

func (c *Config) SigningKey() (ed25519.PrivateKey, error) {
	raw, err := base64.StdEncoding.DecodeString(c.PrivateKey)
	if err != nil {
		return nil, fmt.Errorf("decode private key: %w", err)
	}
	if len(raw) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("private key has %d bytes, want %d", len(raw), ed25519.PrivateKeySize)
	}
	return ed25519.PrivateKey(raw), nil
}

func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	return &c, nil
}

func (c *Config) Save(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create config dir: %w", err)
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return fmt.Errorf("encode config: %w", err)
	}
	// 0600: this file contains the agent's private key.
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}
