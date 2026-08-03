package xray

import (
	"testing"

	"github.com/neoxify/neoxify-hub/agent/internal/protocols/common"
)

// Xray accepts an account with an empty id or password without
// complaining, and the result is an inbound that authenticates nobody.
// These check the guard that turns that into a nacked command instead.
func TestAccountRejectsMissingCredentials(t *testing.T) {
	cases := []struct {
		name string
		p    *Provisioner
		user common.ProtocolUser
	}{
		{"vless without uuid", &Provisioner{kind: kindVLESS}, common.ProtocolUser{Credentials: map[string]string{}}},
		{"trojan without password", &Provisioner{kind: kindTrojan}, common.ProtocolUser{Credentials: map[string]string{}}},
		{
			// A Trojan user carrying VLESS credentials means the control
			// plane and the node disagree about the protocol; provisioning
			// an empty password would be far worse than failing.
			"trojan given a uuid instead",
			&Provisioner{kind: kindTrojan},
			common.ProtocolUser{Credentials: map[string]string{"uuid": "abc"}},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := tc.p.account(tc.user); err == nil {
				t.Fatal("expected an error, got none")
			}
		})
	}
}

func TestAccountBuildsEachProtocol(t *testing.T) {
	vless := &Provisioner{kind: kindVLESS}
	if _, err := vless.account(common.ProtocolUser{
		Credentials: map[string]string{"uuid": "u-1", "flow": "xtls-rprx-vision"},
	}); err != nil {
		t.Fatalf("vless: %v", err)
	}

	trojan := &Provisioner{kind: kindTrojan}
	if _, err := trojan.account(common.ProtocolUser{
		Credentials: map[string]string{"password": "s3cret"},
	}); err != nil {
		t.Fatalf("trojan: %v", err)
	}
}

// The derived provisioner must not close the connection it borrowed --
// doing so would take the VLESS inbound's API connection down with it.
func TestForTrojanDoesNotOwnTheSharedConnection(t *testing.T) {
	base := &Provisioner{kind: kindVLESS, ownsConn: true}
	derived := base.ForTrojan("trojan-in", "")

	if derived.ownsConn {
		t.Fatal("derived provisioner claims ownership of a shared connection")
	}
	if derived.kind != kindTrojan {
		t.Fatal("derived provisioner is not a trojan provisioner")
	}
	if err := derived.Close(); err != nil {
		t.Fatalf("closing a borrowed connection should be a no-op, got %v", err)
	}
}
