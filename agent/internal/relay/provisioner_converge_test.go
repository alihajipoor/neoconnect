package relay

import (
	"context"
	"errors"
	"strings"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/protobuf/proto"

	hcommand "github.com/xtls/xray-core/app/proxyman/command"
	rcommand "github.com/xtls/xray-core/app/router/command"
	"github.com/xtls/xray-core/core"
)

// A stand-in for Xray's outbound registry, with the one property that
// caused the outage: AddOutbound refuses a tag that is already taken, and
// there is no update operation. Anything that wants to change an outbound
// has to remove it first.
type fakeHandler struct {
	hcommand.HandlerServiceClient // embedded: unused methods panic rather than lie

	outbounds map[string][]byte
	adds      int
	removes   int
	addErr    error
}

func newFakeHandler() *fakeHandler {
	return &fakeHandler{outbounds: map[string][]byte{}}
}

func (f *fakeHandler) AddOutbound(_ context.Context, in *hcommand.AddOutboundRequest, _ ...grpc.CallOption) (*hcommand.AddOutboundResponse, error) {
	f.adds++
	tag := in.Outbound.Tag
	// Duplicate-tag check first, which is the order Xray does it in --
	// putting an injected failure ahead of it would make the test
	// exercise a path the real handler cannot produce.
	if _, ok := f.outbounds[tag]; ok {
		// Xray's own wording, from app/proxyman/outbound/outbound.go.
		return nil, errors.New("existing tag found: " + tag)
	}
	if f.addErr != nil {
		return nil, f.addErr
	}
	blob, err := proto.Marshal(in.Outbound)
	if err != nil {
		return nil, err
	}
	f.outbounds[tag] = blob
	return &hcommand.AddOutboundResponse{}, nil
}

func (f *fakeHandler) RemoveOutbound(_ context.Context, in *hcommand.RemoveOutboundRequest, _ ...grpc.CallOption) (*hcommand.RemoveOutboundResponse, error) {
	f.removes++
	delete(f.outbounds, in.Tag)
	return &hcommand.RemoveOutboundResponse{}, nil
}

type fakeRouting struct {
	rcommand.RoutingServiceClient

	rules map[string]bool
}

func (f *fakeRouting) AddRule(_ context.Context, _ *rcommand.AddRuleRequest, _ ...grpc.CallOption) (*rcommand.AddRuleResponse, error) {
	// The rule half is already tolerant of its own duplicate; it is not
	// what this test is about.
	return &rcommand.AddRuleResponse{}, nil
}

func newProvisioner(h *fakeHandler) *Provisioner {
	return &Provisioner{
		handlerConn:      h,
		routingConn:      &fakeRouting{rules: map[string]bool{}},
		tunInboundTag:    "relay-tun-in",
		tunInterfaceName: "nx-tun0",
		appliedProxy:     map[string]string{},
	}
}

func payloadWithSNI(sni string) ConfigureRoutePayload {
	return ConfigureRoutePayload{
		RouteID:         "route-1",
		EntryInboundTag: "vless-in",
		Exit: ExitParams{
			Address:  "204.168.161.100",
			Port:     443,
			Protocol: "XRAY_VLESS_REALITY",
			PublicParams: map[string]any{
				"realityPublicKey": "mYq9AsSqMYjpfG2Vp36NMc8zFJcippAHvP1_R0ebzFc",
				"serverName":       sni,
				"shortIds":         []any{"e341f2050d3761d4"},
			},
			UplinkCredentials: map[string]string{
				"uuid": "00000000-0000-0000-0000-000000000001",
				"flow": "xtls-rprx-vision",
			},
		},
	}
}

const tag = "route-route-1-out"

// The outage, reduced to its mechanism.
//
// finland1's REALITY serverName is www.shatel.ir. The backend had been
// sending that in every CONFIGURE_ROUTE and every one came back ACKED,
// while ir1's eight finland1 outbounds still carried "cloudflare.com"
// from whenever they were first built. The REALITY handshake was refused,
// so all eight routes were dead, and both the panel and the command
// outbox reported them healthy.
//
// Proven on ir1 by A/B, 2026-08-24: same credential, same shortId,
// serverName cloudflare.com -> curl exit 35; serverName www.shatel.ir ->
// exit IP 204.168.161.100.
func TestConfigureRouteRebuildsAStaleOutbound(t *testing.T) {
	h := newFakeHandler()
	p := newProvisioner(h)
	ctx := context.Background()

	if err := p.ConfigureRoute(ctx, payloadWithSNI("cloudflare.com")); err != nil {
		t.Fatalf("first ConfigureRoute: %v", err)
	}
	first := append([]byte(nil), h.outbounds[tag]...)
	if len(first) == 0 {
		t.Fatal("no outbound installed by the first call")
	}

	// The exit's parameters change. This is the case that used to be
	// acked as success and applied to nothing.
	if err := p.ConfigureRoute(ctx, payloadWithSNI("www.shatel.ir")); err != nil {
		t.Fatalf("second ConfigureRoute: %v", err)
	}

	second := h.outbounds[tag]
	if len(second) == 0 {
		t.Fatal("the outbound was removed and never re-added")
	}
	if string(second) == string(first) {
		t.Fatal("outbound still holds the old exit parameters: a changed CONFIGURE_ROUTE was swallowed as a no-op")
	}
	if h.removes != 1 {
		t.Fatalf("expected exactly one RemoveOutbound to make room, got %d", h.removes)
	}
}

// The other half of the contract, and the reason this cannot simply
// remove-and-add every time: the route re-assert sweep runs every 60s, so
// an unconditional rebuild would drop every relay session once a minute.
func TestConfigureRouteLeavesAnUnchangedOutboundAlone(t *testing.T) {
	h := newFakeHandler()
	p := newProvisioner(h)
	ctx := context.Background()

	payload := payloadWithSNI("www.shatel.ir")
	for i := 0; i < 5; i++ {
		if err := p.ConfigureRoute(ctx, payload); err != nil {
			t.Fatalf("ConfigureRoute #%d: %v", i, err)
		}
	}

	if h.removes != 0 {
		t.Fatalf("an unchanged route was torn down %d time(s); that is a dropped session per sweep", h.removes)
	}
	if len(h.outbounds) != 1 {
		t.Fatalf("expected exactly one outbound, got %d", len(h.outbounds))
	}
}

// After an agent restart the fingerprint map is empty, so the first
// re-assert cannot tell "already correct" from "stale". It must converge
// rather than assume: one rebuild per agent restart, against a config
// that would otherwise stay wrong for the life of the process.
func TestConfigureRouteConvergesAfterAgentRestart(t *testing.T) {
	h := newFakeHandler()
	ctx := context.Background()

	if err := newProvisioner(h).ConfigureRoute(ctx, payloadWithSNI("cloudflare.com")); err != nil {
		t.Fatalf("pre-restart ConfigureRoute: %v", err)
	}
	stale := append([]byte(nil), h.outbounds[tag]...)

	// New Provisioner, same Xray: exactly what an agent restart looks like.
	if err := newProvisioner(h).ConfigureRoute(ctx, payloadWithSNI("www.shatel.ir")); err != nil {
		t.Fatalf("post-restart ConfigureRoute: %v", err)
	}

	if string(h.outbounds[tag]) == string(stale) {
		t.Fatal("a restarted agent left the stale outbound in place")
	}
}

// A rebuild that removes the old outbound and then fails to install the
// new one leaves the route's rule pointing at nothing. That must surface:
// it is the exact shape of the bug being fixed -- an assert that did not
// happen, reported as one that did.
func TestConfigureRouteReportsAFailedRebuild(t *testing.T) {
	h := newFakeHandler()
	p := newProvisioner(h)
	ctx := context.Background()

	if err := p.ConfigureRoute(ctx, payloadWithSNI("cloudflare.com")); err != nil {
		t.Fatalf("first ConfigureRoute: %v", err)
	}

	h.addErr = errors.New("connection refused")
	err := p.ConfigureRoute(ctx, payloadWithSNI("www.shatel.ir"))
	if err == nil {
		t.Fatal("a failed rebuild was reported as success")
	}
	if !strings.Contains(err.Error(), "rebuilding") {
		t.Fatalf("error does not say what failed: %v", err)
	}
}

var _ = core.OutboundHandlerConfig{}
