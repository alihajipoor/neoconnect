package dispatch

import (
	"context"
	"testing"

	"github.com/neoxify/neoxify-hub/agent/internal/protocols/common"
)

// countingProvisioner is an identity, not a behaviour: these tests care
// only about which provisioner a key resolves to.
type countingProvisioner struct{}

func (c *countingProvisioner) CreateUser(context.Context, common.ProtocolUser) error { return nil }
func (c *countingProvisioner) UpdateUser(context.Context, common.ProtocolUser) error { return nil }
func (c *countingProvisioner) RemoveUser(context.Context, string) error              { return nil }
func (c *countingProvisioner) SetEnabled(context.Context, string, bool) error        { return nil }
func (c *countingProvisioner) StatsSince(context.Context) ([]common.UsageDelta, error) {
	return nil, nil
}

// One node can serve VLESS+TLS as a raw TCP stream and inside a
// WebSocket at the same time, sharing a port and a certificate. They are
// different Xray inbounds, so the protocol alone no longer says where a
// user belongs -- and a user created on the wrong one gets a credential
// that looks correct and never connects.
func TestProvisionerKey(t *testing.T) {
	cases := []struct {
		name      string
		protocol  string
		transport string
		want      string
	}{
		// Every command written before transports existed carries no
		// transport at all. Those must keep resolving exactly where they
		// always did, or an agent upgrade would strand every existing
		// customer on the node.
		{"absent transport is the plain protocol", "XRAY_VLESS_TLS", "", "XRAY_VLESS_TLS"},
		// Same for TCP sent explicitly: it is the default carrier, so it
		// shares the key rather than needing its own registration.
		{"explicit TCP collapses to the same key", "XRAY_VLESS_TLS", "TCP", "XRAY_VLESS_TLS"},
		{"WebSocket gets its own key", "XRAY_VLESS_TLS", "WS", "XRAY_VLESS_TLS|WS"},
		// Nothing serves this today. It is here because the separator is
		// the whole mechanism, and a future transport must not silently
		// collide with an existing protocol name.
		{"an unknown transport still separates", "XRAY_VLESS_TLS", "GRPC", "XRAY_VLESS_TLS|GRPC"},
		{"other protocols are untouched", "WIREGUARD", "", "WIREGUARD"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := provisionerKey(tc.protocol, tc.transport); got != tc.want {
				t.Fatalf("provisionerKey(%q, %q) = %q, want %q", tc.protocol, tc.transport, got, tc.want)
			}
		})
	}
}

// A node that was never configured for WebSocket should say so in a way
// an operator can act on, rather than reporting the protocol missing
// when the protocol is in fact running perfectly well over TCP.
func TestDescribeTargetNamesTheTransport(t *testing.T) {
	plain := describeTarget("XRAY_VLESS_TLS", "")
	if plain != `protocol "XRAY_VLESS_TLS"` {
		t.Fatalf("unexpected description for a plain protocol: %q", plain)
	}

	ws := describeTarget("XRAY_VLESS_TLS", "WS")
	if ws != `protocol "XRAY_VLESS_TLS" over WS` {
		t.Fatalf("unexpected description for a transport variant: %q", ws)
	}
}

// Registration under a transport must not shadow or be shadowed by the
// plain protocol -- both are real inbounds serving real customers.
func TestRegisterTransportDoesNotDisturbTheDefault(t *testing.T) {
	d := New()
	tcp := &countingProvisioner{}
	ws := &countingProvisioner{}

	d.Register("XRAY_VLESS_TLS", tcp)
	d.RegisterTransport("XRAY_VLESS_TLS", "WS", ws)

	if d.provisioners[provisionerKey("XRAY_VLESS_TLS", "")] != tcp {
		t.Fatal("a transport registration displaced the default provisioner")
	}
	if d.provisioners[provisionerKey("XRAY_VLESS_TLS", "WS")] != ws {
		t.Fatal("the WebSocket provisioner is not reachable by its own key")
	}
}
