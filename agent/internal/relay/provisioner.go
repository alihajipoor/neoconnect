// Package relay provisions multi-hop Route forwarding on a node's local
// Xray process -- hot-adding an outbound to the exit and a routing rule
// that sends this route's traffic to it, using Xray-core's own JSON
// config schema (via infra/conf) rather than hand-assembling protobuf
// structs field by field. The same gRPC connection the xray protocol
// provisioner already holds is reused (see agent/internal/protocols/xray
// Provisioner.Conn), so a relay node's user-provisioning and route-
// provisioning both talk to the one local Xray process. See "Multi-Hop
// Relay Chaining" in the architecture plan for the full design.
package relay

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os/exec"
	"strings"
	"sync"

	"google.golang.org/grpc"

	hcommand "github.com/xtls/xray-core/app/proxyman/command"
	"github.com/xtls/xray-core/app/router"
	rcommand "github.com/xtls/xray-core/app/router/command"
	"github.com/xtls/xray-core/common/serial"
	"github.com/xtls/xray-core/core"
	"github.com/xtls/xray-core/infra/conf"
)

// ExitParams describes the exit node's Xray listener this route forwards
// to, plus the shared uplink credential generated once per Route (not
// per end customer -- see ProtocolUsersService on the backend).
type ExitParams struct {
	Address           string            `json:"address"`
	Port              int               `json:"port"`
	Protocol          string            `json:"protocol"`
	PublicParams      map[string]any    `json:"publicParams"`
	UplinkCredentials map[string]string `json:"uplinkCredentials"`
}

// ConfigureRoutePayload is the CONFIGURE_ROUTE AgentCommand payload. For
// an Xray-based entry protocol, EntryInboundTag names the existing
// inbound whose traffic should route to this exit. For WireGuard/
// OpenVPN entries, EntryInboundTag is empty and EntrySubnetCidr names
// the client subnet to redirect through the tun bridge instead.
type ConfigureRoutePayload struct {
	RouteID         string     `json:"routeId"`
	EntryInboundTag string     `json:"entryInboundTag"`
	EntrySubnetCidr string     `json:"entrySubnetCidr"`
	Exit            ExitParams `json:"exit"`
}

type RemoveRoutePayload struct {
	RouteID string `json:"routeId"`
}

type Provisioner struct {
	handlerConn      hcommand.HandlerServiceClient
	routingConn      rcommand.RoutingServiceClient
	tunInboundTag    string
	tunInterfaceName string

	// Fingerprint of the outbound last successfully installed for each
	// route, so a re-sent CONFIGURE_ROUTE can tell "already applied" from
	// "applied, but with different contents".
	//
	// Xray's AddOutbound refuses a duplicate tag and has no update
	// operation, so without this the two are indistinguishable and the
	// second was treated as the first: the command was acked as success
	// and the running outbound kept whatever it was built with the first
	// time, for as long as the process lived.
	//
	// Measured on ir1, 2026-08-24. finland1's REALITY serverName is
	// www.shatel.ir; the backend had been sending that in every
	// CONFIGURE_ROUTE, and every one was acked ACKED -- while ir1's eight
	// finland1 outbounds still carried "cloudflare.com" from whenever
	// they were first built. The REALITY handshake was rejected, so all
	// eight routes were dead, and the panel and the outbox both said
	// they were fine. Proven by A/B on one route: identical credential
	// and shortId, serverName cloudflare.com -> curl 35, serverName
	// www.shatel.ir -> the expected exit IP. (Node addresses are not
	// written down here; see docs/node-address-hygiene.md.)
	//
	// In-process only. An agent restart empties it, so the next
	// re-assert rebuilds each outbound once -- one brief drop per agent
	// restart, against a config that would otherwise be wrong forever.
	// Convergence is the safe direction to err in.
	mu           sync.Mutex
	appliedProxy map[string]string
}

// New wraps the given connection -- callers should pass the same
// *grpc.ClientConn the local xray.Provisioner already dialed, not open a
// second one. tunInboundTag/tunInterfaceName describe the always-present,
// dormant "tun" inbound in the relay Xray config template (see
// installer/assets/xray-relay-config.json.template) -- used only when
// bridging a WireGuard/OpenVPN entry: tunInboundTag is what Xray's own
// routing rules reference, tunInterfaceName is the OS network interface
// name `ip route` operates on.
func New(conn *grpc.ClientConn, tunInboundTag, tunInterfaceName string) *Provisioner {
	return &Provisioner{
		handlerConn:      hcommand.NewHandlerServiceClient(conn),
		routingConn:      rcommand.NewRoutingServiceClient(conn),
		tunInboundTag:    tunInboundTag,
		tunInterfaceName: tunInterfaceName,
		appliedProxy:     map[string]string{},
	}
}

func outboundTag(routeID string) string {
	return "route-" + routeID + "-out"
}

// fingerprint of everything that shapes the outbound: where it dials, how
// it authenticates, and the REALITY parameters it presents. Anything that
// changes here means the running outbound is stale and has to be rebuilt.
//
// Hashed rather than compared field by field so that a field added to
// ExitParams later is covered without anyone remembering to add it here.
// The uplink credential is inside the hash and never leaves it -- the
// digest is what is stored and logged, never the payload.
func exitFingerprint(exit ExitParams) string {
	blob, err := json.Marshal(exit)
	if err != nil {
		// Unhashable means "assume changed": rebuilding an outbound that
		// did not need it costs one reconnect; skipping one that did is
		// the bug above.
		return ""
	}
	sum := sha256.Sum256(blob)
	return hex.EncodeToString(sum[:])
}

func (p *Provisioner) ConfigureRoute(ctx context.Context, payload ConfigureRoutePayload) error {
	if payload.Exit.Protocol != "XRAY_VLESS_REALITY" {
		return fmt.Errorf("relay ConfigureRoute: unsupported exit protocol %q", payload.Exit.Protocol)
	}

	outboundCfg, err := buildVlessRealityOutbound(payload)
	if err != nil {
		return fmt.Errorf("build outbound: %w", err)
	}
	tag := outboundTag(payload.RouteID)
	want := exitFingerprint(payload.Exit)

	if _, err := p.handlerConn.AddOutbound(ctx, &hcommand.AddOutboundRequest{Outbound: outboundCfg}); err != nil {
		// Resending an already-applied CONFIGURE_ROUTE (e.g. after a lost
		// ack) must be a no-op, not a failure -- same idempotency
		// contract as CreateUser in the xray protocol provisioner.
		// Xray's actual duplicate-tag error text (confirmed against
		// app/proxyman/outbound/outbound.go) is "existing tag found",
		// not "already exists" -- that phrasing is AlterInbound's, a
		// different handler.
		if !strings.Contains(err.Error(), "existing tag found") {
			return fmt.Errorf("AddOutbound: %w", err)
		}

		// The tag is taken. That is only a no-op if what is installed
		// under it matches what was asked for, and until 2026-08-24 this
		// never checked -- so a CONFIGURE_ROUTE whose exit parameters had
		// changed was acked as applied while the running outbound kept
		// the old ones indefinitely. Xray has no update operation for an
		// outbound, so converging means removing it and adding it again.
		if p.lastApplied(tag) == want && want != "" {
			return p.finishRoute(ctx, payload)
		}

		log.Printf("relay: outbound %s exists with different exit parameters; rebuilding it", tag)
		if _, err := p.handlerConn.RemoveOutbound(ctx, &hcommand.RemoveOutboundRequest{Tag: tag}); err != nil {
			return fmt.Errorf("RemoveOutbound (stale %s): %w", tag, err)
		}
		if _, err := p.handlerConn.AddOutbound(ctx, &hcommand.AddOutboundRequest{Outbound: outboundCfg}); err != nil {
			// Removed and could not re-add: the route now has a rule
			// pointing at nothing. Reported rather than swallowed --
			// the next re-assert is 60s away and this must not look
			// like success in the meantime.
			p.forgetApplied(tag)
			return fmt.Errorf("AddOutbound (rebuilding %s): %w", tag, err)
		}
	}

	p.recordApplied(tag, want)

	return p.finishRoute(ctx, payload)
}

// finishRoute installs the half of a route that is safe to re-apply
// unconditionally: the routing rule, and the OS-level bridge a
// WireGuard/OpenVPN entry needs. Split out so the "outbound is already
// exactly right" path still asserts them -- the rule can be missing while
// the outbound is present, e.g. if a previous command failed between the
// two.
func (p *Provisioner) finishRoute(ctx context.Context, payload ConfigureRoutePayload) error {
	rule, err := buildRoutingRule(payload, p.tunInboundTag)
	if err != nil {
		return fmt.Errorf("build routing rule: %w", err)
	}
	// AddRule's TypedMessage must unmarshal to *router.Config (the rule
	// list wrapper Router.AddRule expects), not a bare *router.RoutingRule
	// -- confirmed against app/router/router.go's AddRule/ReloadRules.
	if _, err := p.routingConn.AddRule(ctx, &rcommand.AddRuleRequest{
		Config:       serial.ToTypedMessage(&router.Config{Rule: []*router.RoutingRule{rule}}),
		ShouldAppend: true,
	}); err != nil {
		// Same idempotency contract as AddOutbound above, which was
		// already tolerant of its duplicate. This half was not, so
		// re-sending a CONFIGURE_ROUTE for a route that is already wired
		// failed the whole command -- and re-sending is exactly what the
		// control plane now does on every reconnect. The route was fine;
		// the outbox filled with failures that hid the real ones.
		//
		// Xray's text here is "duplicate ruleTag <tag>", from
		// app/router/router.go's AddRule -- a different phrasing from
		// AddOutbound's "existing tag found", so it needs its own match.
		if !strings.Contains(err.Error(), "duplicate ruleTag") {
			return fmt.Errorf("AddRule: %w", err)
		}
	}

	// Only WireGuard/OpenVPN entries need OS-level help -- an Xray-based
	// entry's traffic reaches the outbound purely through the routing
	// rule just added above, entirely inside the one Xray process.
	if payload.EntryInboundTag == "" {
		if err := p.ensureSubnetRoutedThroughTun(payload.EntrySubnetCidr); err != nil {
			return fmt.Errorf("ip route (bridge %s through %s): %w", payload.EntrySubnetCidr, p.tunInterfaceName, err)
		}
	}

	return nil
}

func (p *Provisioner) lastApplied(tag string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.appliedProxy[tag]
}

func (p *Provisioner) recordApplied(tag, fingerprint string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.appliedProxy == nil {
		p.appliedProxy = map[string]string{}
	}
	p.appliedProxy[tag] = fingerprint
}

func (p *Provisioner) forgetApplied(tag string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.appliedProxy, tag)
}

// RemoveRoute reverses ConfigureRoute's Xray-side wiring. Xray's own
// RemoveRule/RemoveOutbound (confirmed against app/router/router.go and
// app/proxyman/outbound/outbound.go) never error for an already-missing
// tag -- both are plain map/slice deletes that no-op on a miss -- so
// resending REMOVE_ROUTE after it already landed is naturally safe with
// no special-casing needed here.
func (p *Provisioner) RemoveRoute(ctx context.Context, routeID string) error {
	tag := outboundTag(routeID)

	if _, err := p.routingConn.RemoveRule(ctx, &rcommand.RemoveRuleRequest{RuleTag: tag}); err != nil {
		return fmt.Errorf("RemoveRule: %w", err)
	}
	if _, err := p.handlerConn.RemoveOutbound(ctx, &hcommand.RemoveOutboundRequest{Tag: tag}); err != nil {
		return fmt.Errorf("RemoveOutbound: %w", err)
	}
	// Deliberately does not remove the `ip route` added for a
	// WireGuard/OpenVPN bridge -- another route on the same entry
	// protocol's subnet may still depend on it, and re-adding it is a
	// cheap idempotent no-op on the next ConfigureRoute anyway. Stale
	// routes pointed at an idle tun interface are harmless (see the tun
	// inbound's own README: no rule referencing it means no traffic
	// actually flows).
	return nil
}

// relayRouteTable is a dedicated Linux routing table used only to steer
// relayed client subnets through the dormant tun inbound -- kept
// separate from the main table so this never touches the node's own
// default route (which Xray itself needs to reach the exit).
const relayRouteTable = "100"

// ensureSubnetRoutedThroughTun redirects traffic *sourced from* a client
// subnet through the relay's dormant tun inbound, without touching
// traffic addressed *to* that subnet -- WireGuard/OpenVPN still needs
// the normal route back to deliver replies to those same clients. This
// is "Approach 2" from xray-core's tun inbound README: a dedicated route
// table whose only route is a default via the tun interface, activated
// only for packets matching an `ip rule ... from <subnet>`. Idempotent:
// `ip route replace` overwrites the table's own default route, and the
// rule is only added if an equivalent one isn't already present.
func (p *Provisioner) ensureSubnetRoutedThroughTun(subnetCIDR string) error {
	if subnetCIDR == "" {
		return fmt.Errorf("missing entrySubnetCidr")
	}

	if out, err := exec.Command("ip", "route", "replace", "default", "dev", p.tunInterfaceName, "table", relayRouteTable).CombinedOutput(); err != nil {
		return fmt.Errorf("ip route replace default table %s: %w (%s)", relayRouteTable, err, strings.TrimSpace(string(out)))
	}

	existing, err := exec.Command("ip", "rule", "show").Output()
	if err != nil {
		return fmt.Errorf("ip rule show: %w", err)
	}
	ruleSpec := fmt.Sprintf("from %s lookup %s", subnetCIDR, relayRouteTable)
	if !strings.Contains(string(existing), ruleSpec) {
		if out, err := exec.Command("ip", "rule", "add", "from", subnetCIDR, "table", relayRouteTable).CombinedOutput(); err != nil {
			return fmt.Errorf("ip rule add: %w (%s)", err, strings.TrimSpace(string(out)))
		}
	}

	return nil
}

func buildVlessRealityOutbound(payload ConfigureRoutePayload) (*core.OutboundHandlerConfig, error) {
	uuid := payload.Exit.UplinkCredentials["uuid"]
	if uuid == "" {
		return nil, fmt.Errorf("uplink credentials missing uuid")
	}
	flow := payload.Exit.UplinkCredentials["flow"]
	publicKey, _ := payload.Exit.PublicParams["realityPublicKey"].(string)
	serverName, _ := payload.Exit.PublicParams["serverName"].(string)
	shortID := firstShortID(payload.Exit.PublicParams["shortIds"])

	outboundJSON, err := json.Marshal(map[string]any{
		"protocol": "vless",
		"tag":      outboundTag(payload.RouteID),
		"settings": map[string]any{
			"vnext": []map[string]any{
				{
					"address": payload.Exit.Address,
					"port":    payload.Exit.Port,
					"users": []map[string]any{
						{"id": uuid, "flow": flow, "encryption": "none"},
					},
				},
			},
		},
		"streamSettings": map[string]any{
			"network":  "tcp",
			"security": "reality",
			"realitySettings": map[string]any{
				"fingerprint": "chrome",
				"serverName":  serverName,
				"publicKey":   publicKey,
				"shortId":     shortID,
			},
		},
	})
	if err != nil {
		return nil, err
	}

	var detour conf.OutboundDetourConfig
	if err := json.Unmarshal(outboundJSON, &detour); err != nil {
		return nil, err
	}
	return detour.Build()
}

func buildRoutingRule(payload ConfigureRoutePayload, tunInboundTag string) (*router.RoutingRule, error) {
	rule := map[string]any{
		"type":        "field",
		"ruleTag":     outboundTag(payload.RouteID),
		"outboundTag": outboundTag(payload.RouteID),
	}
	if payload.EntryInboundTag != "" {
		rule["inboundTag"] = []string{payload.EntryInboundTag}
	} else {
		rule["inboundTag"] = []string{tunInboundTag}
		rule["source"] = []string{payload.EntrySubnetCidr}
	}

	ruleJSON, err := json.Marshal(rule)
	if err != nil {
		return nil, err
	}

	built, err := (&conf.RouterConfig{RuleList: []json.RawMessage{ruleJSON}}).Build()
	if err != nil {
		return nil, err
	}
	if len(built.Rule) != 1 {
		return nil, fmt.Errorf("expected exactly one routing rule, got %d", len(built.Rule))
	}
	return built.Rule[0], nil
}

func firstShortID(v any) string {
	arr, ok := v.([]any)
	if !ok || len(arr) == 0 {
		return ""
	}
	s, _ := arr[0].(string)
	return s
}
