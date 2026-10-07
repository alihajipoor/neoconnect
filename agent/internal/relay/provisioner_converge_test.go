package relay

import (
	"context"
	"errors"
	"strings"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/protobuf/proto"

	hcommand "github.com/xtls/xray-core/app/proxyman/command"
	"github.com/xtls/xray-core/app/router"
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

// A stand-in for Xray's router with the same property as the outbound
// registry: AddRule refuses a ruleTag that is already taken, in Xray's
// own words (app/router/router.go), and there is no update. It keeps the
// inbound tags each rule matches, which is what a stale rule gets wrong.
type fakeRouting struct {
	rcommand.RoutingServiceClient

	rules   map[string][]string // ruleTag -> inbound tags it matches
	removes int
}

func newFakeRouting() *fakeRouting {
	return &fakeRouting{rules: map[string][]string{}}
}

func (f *fakeRouting) AddRule(_ context.Context, in *rcommand.AddRuleRequest, _ ...grpc.CallOption) (*rcommand.AddRuleResponse, error) {
	msg, err := in.Config.GetInstance()
	if err != nil {
		return nil, err
	}
	cfg, ok := msg.(*router.Config)
	if !ok || len(cfg.Rule) != 1 {
		return nil, errors.New("fake router: expected a router.Config with one rule")
	}
	rule := cfg.Rule[0]
	if _, taken := f.rules[rule.RuleTag]; taken {
		return nil, errors.New("duplicate ruleTag " + rule.RuleTag)
	}
	f.rules[rule.RuleTag] = append([]string(nil), rule.InboundTag...)
	return &rcommand.AddRuleResponse{}, nil
}

func (f *fakeRouting) RemoveRule(_ context.Context, in *rcommand.RemoveRuleRequest, _ ...grpc.CallOption) (*rcommand.RemoveRuleResponse, error) {
	f.removes++
	delete(f.rules, in.RuleTag)
	return &rcommand.RemoveRuleResponse{}, nil
}

func newProvisioner(h *fakeHandler) *Provisioner {
	return newProvisionerWith(h, newFakeRouting())
}

func newProvisionerWith(h *fakeHandler, r *fakeRouting) *Provisioner {
	return &Provisioner{
		handlerConn:      h,
		routingConn:      r,
		tunInboundTag:    "relay-tun-in",
		tunInterfaceName: "nx-tun0",
		appliedProxy:     map[string]string{},
		appliedRule:      map[string]string{},
	}
}

func payloadWithSNI(sni string) ConfigureRoutePayload {
	return ConfigureRoutePayload{
		RouteID:         "route-1",
		EntryInboundTag: "vless-in",
		Exit: ExitParams{
			Address:  "203.0.113.40",
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
// the expected exit IP. The address below is an RFC 5737 documentation
// address; real node addresses are not committed, see
// docs/node-address-hygiene.md.
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

// The rule's version of the outage. An admin moves a relay entry to a
// dedicated inbound -- the documented repair for a wrong tag -- and the
// sweep sends CONFIGURE_ROUTE with the new tag. AddRule says "duplicate
// ruleTag", which was taken as "already applied": the live rule kept
// matching the old inbound, the command was acked every 60s, and the
// customers re-provisioned onto the new inbound matched no rule at all.
func TestConfigureRouteRebuildsARuleWhoseInboundChanged(t *testing.T) {
	r := newFakeRouting()
	p := newProvisionerWith(newFakeHandler(), r)
	ctx := context.Background()

	payload := payloadWithSNI("www.shatel.ir")
	if err := p.ConfigureRoute(ctx, payload); err != nil {
		t.Fatalf("first ConfigureRoute: %v", err)
	}
	if got := r.rules[tag]; len(got) != 1 || got[0] != "vless-in" {
		t.Fatalf("expected the rule to match vless-in, got %v", got)
	}

	payload.EntryInboundTag = "vless-fr-in"
	if err := p.ConfigureRoute(ctx, payload); err != nil {
		t.Fatalf("second ConfigureRoute: %v", err)
	}
	if got := r.rules[tag]; len(got) != 1 || got[0] != "vless-fr-in" {
		t.Fatalf("the rule still matches %v: a changed CONFIGURE_ROUTE was acked and applied to nothing", got)
	}
}

// And, as for the outbound, an unchanged rule is left alone: a rebuild is
// a moment in which that inbound's new connections match nothing, and
// the sweep runs every 60s.
func TestConfigureRouteLeavesAnUnchangedRuleAlone(t *testing.T) {
	r := newFakeRouting()
	p := newProvisionerWith(newFakeHandler(), r)
	ctx := context.Background()

	for i := 0; i < 5; i++ {
		if err := p.ConfigureRoute(ctx, payloadWithSNI("www.shatel.ir")); err != nil {
			t.Fatalf("ConfigureRoute #%d: %v", i, err)
		}
	}
	if r.removes != 0 {
		t.Fatalf("an unchanged rule was torn down %d time(s)", r.removes)
	}
}

// After an agent restart nothing says what the live rule matches, so it
// is rebuilt once rather than assumed right.
func TestARuleConvergesAfterAgentRestart(t *testing.T) {
	h, r := newFakeHandler(), newFakeRouting()
	ctx := context.Background()

	stale := payloadWithSNI("www.shatel.ir")
	if err := newProvisionerWith(h, r).ConfigureRoute(ctx, stale); err != nil {
		t.Fatalf("pre-restart ConfigureRoute: %v", err)
	}

	fresh := stale
	fresh.EntryInboundTag = "vless-fr-in"
	if err := newProvisionerWith(h, r).ConfigureRoute(ctx, fresh); err != nil {
		t.Fatalf("post-restart ConfigureRoute: %v", err)
	}
	if got := r.rules[tag]; len(got) != 1 || got[0] != "vless-fr-in" {
		t.Fatalf("a restarted agent left the stale rule in place: %v", got)
	}
}

var _ = core.OutboundHandlerConfig{}
