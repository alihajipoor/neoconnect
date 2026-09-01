// Command agentd is the Neoxify node agent: it runs on each VPS node,
// manages local VPN protocol engines, and syncs state with the control plane.
package main

import (
	"context"
	"encoding/base64"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"github.com/neoxify/neoxify-hub/agent/internal/config"
	"github.com/neoxify/neoxify-hub/agent/internal/controlplane"
	"github.com/neoxify/neoxify-hub/agent/internal/dispatch"
	"github.com/neoxify/neoxify-hub/agent/internal/enroll"
	"github.com/neoxify/neoxify-hub/agent/internal/protocols/ikev2"
	"github.com/neoxify/neoxify-hub/agent/internal/protocols/openvpn"
	"github.com/neoxify/neoxify-hub/agent/internal/protocols/wireguard"
	"github.com/neoxify/neoxify-hub/agent/internal/protocols/xray"
	"github.com/neoxify/neoxify-hub/agent/internal/realityprobe"
	"github.com/neoxify/neoxify-hub/agent/internal/relay"
	"github.com/neoxify/neoxify-hub/agent/internal/shaper"
	"github.com/neoxify/neoxify-hub/agent/internal/version"
)

func main() {
	showVersion := flag.Bool("version", false, "print the agent build version and exit. The same string the agent reports to the control plane as agentVersion, so this is how you confirm a node actually took a rollout without waiting for it to reconnect")
	enrollInit := flag.Bool("enroll-init", false, "trade a one-time enrollment token for this node's identity, then exit")
	token := flag.String("token", "", "enrollment token issued by an admin in the panel (required with --enroll-init)")
	panelURL := flag.String("panel-url", "", "control-plane base URL INCLUDING /api -- nginx only proxies the backend under that prefix, e.g. https://connect.example.com/api (required with --enroll-init)")
	grpcTarget := flag.String("grpc-target", "", "override the gRPC host:port (default: <panel-url host>:50051)")
	tlsServerName := flag.String("tls-server-name", "", "override the TLS server name (SNI) presented to the control plane. Default: the panel URL's host. Needed only where that hostname is blocked by SNI -- dial the origin with --grpc-target and announce a different name here. It must be on the panel's certificate; verification still applies.")
	configPath := flag.String("config", config.DefaultPath, "path to the agent's persisted config")
	xrayConfigPath := flag.String("xray-config", "/usr/local/etc/xray/config.json", "Xray's config file, read to learn which camouflage destination the REALITY inbound forwards handshakes to. Absent or REALITY-less is fine: the node simply reports no dest.")
	xrayAPIAddr := flag.String("xray-api-addr", "127.0.0.1:10085", "Xray-core's local gRPC API address (see installer/assets/xray-config.json)")
	xrayInboundTag := flag.String("xray-inbound-tag", "vless-in", "tag of the VLESS+REALITY inbound in Xray's config")
	xrayTrojanTag := flag.String("xray-trojan-inbound-tag", "trojan-in", "tag of the Trojan+TLS inbound in Xray's config. Registered unconditionally: a tag that does not exist simply nacks any Trojan command with Xray's own error, which is clearer than the node silently not offering the protocol")
	xrayVlessTlsTag := flag.String("xray-vless-tls-inbound-tag", "vless-tls-in", "tag of the VLESS+TLS inbound in Xray's config. Registered unconditionally for the same reason as the Trojan tag above")
	xrayShadowsocksTag := flag.String("xray-shadowsocks-inbound-tag", "shadowsocks-in", "tag of the Shadowsocks 2022 inbound in Xray's config. Registered unconditionally for the same reason as the Trojan tag above")
	xrayVlessWsTag := flag.String("xray-vless-ws-inbound-tag", "vless-ws-in", "tag of the VLESS+TLS-over-WebSocket inbound in Xray's config. Same account shape as the TCP VLESS inbound -- only the stream differs -- so it is registered as the WS transport of XRAY_VLESS_TLS, and a node without that inbound simply nacks any WS command with Xray's own error")
	xrayAccessLog := flag.String("xray-access-log", "/var/log/xray/access.log", "Xray's access log, read to count how many places each user is connected from -- concurrency is not exposed by Xray's API. Harmless if absent: counts are simply not reported")
	wgInterface := flag.String("wg-interface", "wg0", "name of the WireGuard interface this node manages")
	relayTunInboundTag := flag.String("relay-tun-inbound-tag", "relay-tun-in", "tag of the dormant tun inbound in a relay node's Xray config (see installer/assets/xray-relay-config.json.template)")
	relayTunInterface := flag.String("relay-tun-interface", "relay-tun", "OS network interface name of that same tun inbound, used for ip route/rule when bridging WireGuard/OpenVPN entries into a Route's exit outbound")
	openvpnInterface := flag.String("openvpn-interface", "tun0", "OpenVPN server tun interface, shaped for per-plan speed caps")
	openvpnMgmtAddr := flag.String("openvpn-mgmt-addr", "127.0.0.1:7505", "OpenVPN server's local Management Interface address (see installer/lib/agent.sh's install_openvpn)")
	openvpnCcdDir := flag.String("openvpn-ccd-dir", "/etc/openvpn/ccd", "OpenVPN client-config-dir this node's server is configured with")
	ikev2Secrets := flag.String("ikev2-secrets", "/etc/swanctl/conf.d/neoxify-users.conf", "swanctl file this agent owns and rewrites as customers come and go (see installer/lib/agent.sh's install_ikev2)")
	ikev2Swanctl := flag.String("ikev2-swanctl", "swanctl", "path to swanctl, if it is not on PATH")
	flag.Parse()

	// Before anything that reads config or dials: --version has to work
	// on a freshly downloaded binary, on a node that is not enrolled,
	// and without touching a running agent.
	if *showVersion {
		fmt.Printf("agentd %s (%s/%s)\n", version.Version, runtime.GOOS, runtime.GOARCH)
		return
	}

	if *enrollInit {
		if err := runEnrollInit(*token, *panelURL, *grpcTarget, *tlsServerName, *configPath); err != nil {
			log.Fatalf("enroll-init failed: %v", err)
		}
		return
	}

	cfg, err := config.Load(*configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "agentd: no config at %s -- run `agentd --enroll-init --token <token> --panel-url <url>` first\n", *configPath)
		os.Exit(1)
	}

	xrayProvisioner, err := xray.New(*xrayAPIAddr, *xrayInboundTag, *xrayAccessLog)
	if err != nil {
		log.Fatalf("connect to xray api: %v", err)
	}
	defer xrayProvisioner.Close()

	dispatcher := dispatch.New()
	dispatcher.Register("XRAY_VLESS_REALITY", xrayProvisioner)
	// Same Xray process, different inbound and a different credential
	// shape -- so it shares the connection rather than dialing a second
	// one. See Provisioner.ForTrojan.
	dispatcher.Register("XRAY_TROJAN", xrayProvisioner.ForTrojan(*xrayTrojanTag, *xrayAccessLog))
	// The certificate-presenting VLESS inbound. Same account shape as the
	// REALITY one above -- only the listener differs -- so it is a second
	// tag on the same process rather than anything new.
	dispatcher.Register("XRAY_VLESS_TLS", xrayProvisioner.ForVless(*xrayVlessTlsTag, *xrayAccessLog))
	// The same VLESS+TLS protocol carried inside a WebSocket -- the
	// "WStunnel" shape. Identical account, different inbound, so it is a
	// transport variant of XRAY_VLESS_TLS rather than a new protocol: the
	// control plane sends transport "WS" and the dispatcher routes it
	// here, to the ws inbound, instead of to the TCP one above.
	dispatcher.RegisterTransport("XRAY_VLESS_TLS", "WS", xrayProvisioner.ForVless(*xrayVlessWsTag, *xrayAccessLog))
	// Shadowsocks 2022, on the same process again. A different credential
	// shape -- a pre-shared key pair rather than a UUID -- but the same
	// hot-add RPC and the same no-restart guarantee, verified live before
	// this was built: a user added while another was mid-download did not
	// disturb them.
	dispatcher.Register("SHADOWSOCKS", xrayProvisioner.ForShadowsocks(*xrayShadowsocksTag, *xrayAccessLog))
	dispatcher.Register("WIREGUARD", wireguard.New(*wgInterface))
	// Per-user speed caps, WireGuard only for now: each peer has its own
	// address assigned at provisioning time, which is what a tc rule needs
	// to target one customer. OpenVPN assigns from a pool at connect time
	// and Xray has no per-user address at all -- see RegisterShaper.
	dispatcher.RegisterShaper("WIREGUARD", shaper.New(*wgInterface))
	openvpnProvisioner := openvpn.New(*openvpnMgmtAddr, *openvpnCcdDir)
	dispatcher.Register("OPENVPN", openvpnProvisioner)
	// OpenVPN hands out addresses from a pool when a client connects, so
	// its shaper cannot act at provisioning time -- it needs the address
	// discovered while the client is online. The tun interface it shapes is
	// the one OpenVPN was configured with.
	dispatcher.RegisterShaper("OPENVPN", shaper.New(*openvpnInterface))

	// IKEv2, served by strongSwan. No shaper: unlike WireGuard there is no
	// address assigned at provisioning time to target, and unlike OpenVPN
	// there is no management interface to discover one from -- addresses
	// come from strongSwan's own pool at connect time. Speed caps
	// therefore do not apply to this protocol, the same gap the Xray ones
	// have.
	dispatcher.Register("IKEV2", ikev2.New(*ikev2Secrets, *ikev2Swanctl))
	dispatcher.RegisterAddressDiscoverer("OPENVPN", openvpnProvisioner)
	// Every node's Xray process can be a relay's exit fabric regardless
	// of which protocols it terminates -- CONFIGURE_ROUTE/REMOVE_ROUTE
	// are simply no-ops in practice on nodes that never receive them.
	dispatcher.RegisterRelay(relay.New(xrayProvisioner.Conn(), *relayTunInboundTag, *relayTunInterface))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Probed every 10 minutes rather than per-heartbeat: a dest does not
	// rot on a 20-second timescale, and a dial on the heartbeat path
	// would make the liveness signal depend on the network it is meant
	// to be reporting about.
	prober := realityprobe.New(*xrayConfigPath, 10*time.Minute)
	go prober.Run(ctx)

	if err := controlplane.Run(ctx, cfg, dispatcher, prober); err != nil && ctx.Err() == nil {
		log.Fatalf("agent sync loop exited: %v", err)
	}
}

func runEnrollInit(token, panelURL, grpcTarget, tlsServerName, configPath string) error {
	if token == "" || panelURL == "" {
		return fmt.Errorf("--token and --panel-url are required")
	}

	pub, priv, err := enroll.GenerateKeypair()
	if err != nil {
		return fmt.Errorf("generate keypair: %w", err)
	}

	nodeID, err := enroll.Claim(panelURL, token, pub)
	if err != nil {
		return fmt.Errorf("claim enrollment token: %w", err)
	}

	cfg := &config.Config{
		NodeID:        nodeID,
		PanelURL:      panelURL,
		GRPCTarget:    grpcTarget,
		TLSServerName: tlsServerName,
		PrivateKey:    base64.StdEncoding.EncodeToString(priv),
	}
	if err := cfg.Save(configPath); err != nil {
		return fmt.Errorf("save config: %w", err)
	}

	fmt.Printf("Enrolled as node %s. Config written to %s.\n", nodeID, configPath)
	return nil
}
