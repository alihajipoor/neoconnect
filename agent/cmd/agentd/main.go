// Command agentd is the NeoConnect node agent: it runs on each VPS node,
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
	"syscall"

	"github.com/neoxify/neoxify-hub/agent/internal/config"
	"github.com/neoxify/neoxify-hub/agent/internal/controlplane"
	"github.com/neoxify/neoxify-hub/agent/internal/dispatch"
	"github.com/neoxify/neoxify-hub/agent/internal/enroll"
	"github.com/neoxify/neoxify-hub/agent/internal/protocols/openvpn"
	"github.com/neoxify/neoxify-hub/agent/internal/protocols/wireguard"
	"github.com/neoxify/neoxify-hub/agent/internal/protocols/xray"
	"github.com/neoxify/neoxify-hub/agent/internal/relay"
)

func main() {
	enrollInit := flag.Bool("enroll-init", false, "trade a one-time enrollment token for this node's identity, then exit")
	token := flag.String("token", "", "enrollment token issued by an admin in the panel (required with --enroll-init)")
	panelURL := flag.String("panel-url", "", "control-plane base URL INCLUDING /api -- nginx only proxies the backend under that prefix, e.g. https://connect.example.com/api (required with --enroll-init)")
	grpcTarget := flag.String("grpc-target", "", "override the gRPC host:port (default: <panel-url host>:50051)")
	configPath := flag.String("config", config.DefaultPath, "path to the agent's persisted config")
	xrayAPIAddr := flag.String("xray-api-addr", "127.0.0.1:10085", "Xray-core's local gRPC API address (see installer/assets/xray-config.json)")
	xrayInboundTag := flag.String("xray-inbound-tag", "vless-in", "tag of the VLESS+REALITY inbound in Xray's config")
	xrayAccessLog := flag.String("xray-access-log", "/var/log/xray/access.log", "Xray's access log, read to count how many places each user is connected from -- concurrency is not exposed by Xray's API. Harmless if absent: counts are simply not reported")
	wgInterface := flag.String("wg-interface", "wg0", "name of the WireGuard interface this node manages")
	relayTunInboundTag := flag.String("relay-tun-inbound-tag", "relay-tun-in", "tag of the dormant tun inbound in a relay node's Xray config (see installer/assets/xray-relay-config.json.template)")
	relayTunInterface := flag.String("relay-tun-interface", "relay-tun", "OS network interface name of that same tun inbound, used for ip route/rule when bridging WireGuard/OpenVPN entries into a Route's exit outbound")
	openvpnMgmtAddr := flag.String("openvpn-mgmt-addr", "127.0.0.1:7505", "OpenVPN server's local Management Interface address (see installer/lib/agent.sh's install_openvpn)")
	openvpnCcdDir := flag.String("openvpn-ccd-dir", "/etc/openvpn/ccd", "OpenVPN client-config-dir this node's server is configured with")
	flag.Parse()

	if *enrollInit {
		if err := runEnrollInit(*token, *panelURL, *grpcTarget, *configPath); err != nil {
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
	dispatcher.Register("WIREGUARD", wireguard.New(*wgInterface))
	dispatcher.Register("OPENVPN", openvpn.New(*openvpnMgmtAddr, *openvpnCcdDir))
	// Every node's Xray process can be a relay's exit fabric regardless
	// of which protocols it terminates -- CONFIGURE_ROUTE/REMOVE_ROUTE
	// are simply no-ops in practice on nodes that never receive them.
	dispatcher.RegisterRelay(relay.New(xrayProvisioner.Conn(), *relayTunInboundTag, *relayTunInterface))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := controlplane.Run(ctx, cfg, dispatcher); err != nil && ctx.Err() == nil {
		log.Fatalf("agent sync loop exited: %v", err)
	}
}

func runEnrollInit(token, panelURL, grpcTarget, configPath string) error {
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
		NodeID:     nodeID,
		PanelURL:   panelURL,
		GRPCTarget: grpcTarget,
		PrivateKey: base64.StdEncoding.EncodeToString(priv),
	}
	if err := cfg.Save(configPath); err != nil {
		return fmt.Errorf("save config: %w", err)
	}

	fmt.Printf("Enrolled as node %s. Config written to %s.\n", nodeID, configPath)
	return nil
}
