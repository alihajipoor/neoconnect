// Package common defines the shared contract every protocol engine
// (Xray, WireGuard, OpenVPN) implements, so the rest of the agent can
// manage users without knowing which engine is underneath.
package common

import "context"

// ProtocolUser is the agent-local view of a single provisioned user on a
// single protocol engine. It mirrors the control plane's ProtocolUser row.
type ProtocolUser struct {
	ExternalUserID string
	// Credentials holds protocol-specific fields (e.g. Xray UUID, WireGuard
	// pubkey/allowed-IP, OpenVPN common name) as opaque key/value pairs.
	Credentials map[string]string
}

// UsageDelta is bytes transferred since the last successful report for a
// given user, ready to be batched into a StatsBatch to the control plane.
type UsageDelta struct {
	ExternalUserID string
	BytesUp        uint64
	BytesDown      uint64
}

// Provisioner is implemented once per protocol engine (xray, wireguard,
// openvpn). Every method must apply only to the targeted user and must not
// disrupt any other active session on the same node — this is the
// no-interruption requirement the whole agent architecture is built around.
type Provisioner interface {
	CreateUser(ctx context.Context, user ProtocolUser) error
	UpdateUser(ctx context.Context, user ProtocolUser) error
	RemoveUser(ctx context.Context, externalUserID string) error
	SetEnabled(ctx context.Context, externalUserID string, enabled bool) error
	StatsSince(ctx context.Context) ([]UsageDelta, error)
}
