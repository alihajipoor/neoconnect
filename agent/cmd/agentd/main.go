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
	"github.com/neoxify/neoxify-hub/agent/internal/enroll"
)

func main() {
	enrollInit := flag.Bool("enroll-init", false, "trade a one-time enrollment token for this node's identity, then exit")
	token := flag.String("token", "", "enrollment token issued by an admin in the panel (required with --enroll-init)")
	panelURL := flag.String("panel-url", "", "control-plane base URL, e.g. https://connect.example.com (required with --enroll-init)")
	grpcTarget := flag.String("grpc-target", "", "override the gRPC host:port (default: <panel-url host>:50051)")
	configPath := flag.String("config", config.DefaultPath, "path to the agent's persisted config")
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

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := controlplane.Run(ctx, cfg); err != nil && ctx.Err() == nil {
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
