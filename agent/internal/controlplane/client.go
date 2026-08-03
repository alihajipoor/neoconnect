// Package controlplane owns the agent's side of the AgentSync stream:
// connecting, authenticating with a signed Hello, sending periodic
// heartbeats, and reconnecting with backoff whenever the stream drops.
package controlplane

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"fmt"
	"log"
	"net/url"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"

	"github.com/neoxify/neoxify-hub/agent/internal/config"
	"github.com/neoxify/neoxify-hub/agent/internal/controlplane/pb"
	"github.com/neoxify/neoxify-hub/agent/internal/dispatch"
	"github.com/neoxify/neoxify-hub/agent/internal/version"
)

const (
	heartbeatInterval = 20 * time.Second
	statsInterval     = 30 * time.Second
	initialBackoff    = time.Second
	maxBackoff        = 30 * time.Second
)

// Run connects to the control plane and keeps the AgentSync stream alive,
// reconnecting with exponential backoff on any failure. Blocks until ctx
// is cancelled.
func Run(ctx context.Context, cfg *config.Config, dispatcher *dispatch.Dispatcher) error {
	target, creds, err := dialTarget(cfg)
	if err != nil {
		return err
	}

	conn, err := grpc.NewClient(target, grpc.WithTransportCredentials(creds))
	if err != nil {
		return fmt.Errorf("create grpc client for %s: %w", target, err)
	}
	defer conn.Close()

	client := pb.NewAgentGatewayClient(conn)
	signingKey, err := cfg.SigningKey()
	if err != nil {
		return err
	}

	backoff := initialBackoff
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		if err := runStream(ctx, client, cfg.NodeID, signingKey, dispatcher); err != nil && ctx.Err() == nil {
			log.Printf("agent sync stream error: %v (retrying in %s)", err, backoff)
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
		backoff *= 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
		if err == nil {
			backoff = initialBackoff // clean disconnect (server closed stream): reset backoff
		}
	}
}

// dialTarget derives the gRPC target and transport security from the
// panel URL: https -> TLS with the system root CA pool (Let's Encrypt
// certs are publicly trusted, no pinning needed), http -> plaintext
// (local dev only). The gRPC port is separate from the panel's HTTPS
// port -- see docs/architecture.md on why this isn't proxied through
// nginx in Phase 1.
func dialTarget(cfg *config.Config) (string, credentials.TransportCredentials, error) {
	u, err := url.Parse(cfg.PanelURL)
	if err != nil {
		return "", nil, fmt.Errorf("parse panel URL %q: %w", cfg.PanelURL, err)
	}
	host := u.Hostname()
	if host == "" {
		return "", nil, fmt.Errorf("panel URL %q has no host", cfg.PanelURL)
	}

	target := cfg.GRPCTarget
	if target == "" {
		target = fmt.Sprintf("%s:50051", host)
	}

	if u.Scheme == "https" {
		return target, credentials.NewTLS(&tls.Config{ServerName: host}), nil
	}
	return target, insecure.NewCredentials(), nil
}

func runStream(
	ctx context.Context,
	client pb.AgentGatewayClient,
	nodeID string,
	key ed25519.PrivateKey,
	dispatcher *dispatch.Dispatcher,
) error {
	streamCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	stream, err := client.AgentSync(streamCtx)
	if err != nil {
		return fmt.Errorf("open AgentSync stream: %w", err)
	}

	if err := sendHello(stream, nodeID, key); err != nil {
		return fmt.Errorf("send hello: %w", err)
	}
	log.Printf("connected to control plane, node %s authenticated", nodeID)

	errCh := make(chan error, 3)
	go func() { errCh <- heartbeatLoop(streamCtx, stream) }()
	go func() { errCh <- statsLoop(streamCtx, stream, dispatcher) }()
	go func() { errCh <- receiveLoop(streamCtx, stream, dispatcher) }()

	err = <-errCh
	cancel()
	return err
}

func sendHello(stream pb.AgentGateway_AgentSyncClient, nodeID string, key ed25519.PrivateKey) error {
	nonce := randomNonce()
	timestamp := time.Now().Unix()
	message := []byte(fmt.Sprintf("%s.%d.%s", nodeID, timestamp, nonce))
	signature := ed25519.Sign(key, message)

	return stream.Send(&pb.AgentMessage{
		Payload: &pb.AgentMessage_Hello{
			Hello: &pb.Hello{
				NodeId:       nodeID,
				Timestamp:    timestamp,
				Nonce:        nonce,
				Signature:    signature,
				AgentVersion: version.Version,
			},
		},
	})
}

func heartbeatLoop(ctx context.Context, stream pb.AgentGateway_AgentSyncClient) error {
	ticker := time.NewTicker(heartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			// CPU/mem/active-connection sampling isn't implemented yet --
			// presence (the heartbeat arriving at all) is what M2 proves;
			// real metrics land with usage accounting (M6).
			if err := stream.Send(&pb.AgentMessage{
				Payload: &pb.AgentMessage_Heartbeat{Heartbeat: &pb.Heartbeat{}},
			}); err != nil {
				return fmt.Errorf("send heartbeat: %w", err)
			}
		}
	}
}

// statsLoop polls every registered protocol engine's own counters
// (Xray StatsService, `wg show transfer`, ...) and reports deltas since
// the last poll. Skips sending an empty batch -- most polls on a quiet
// node have nothing to report, no reason to put an empty message on the
// wire every 30s. A StatsSince error on one protocol is logged and
// otherwise ignored: a blip in one engine's counters must not stop
// heartbeats or command handling on the same stream.
func statsLoop(ctx context.Context, stream pb.AgentGateway_AgentSyncClient, dispatcher *dispatch.Dispatcher) error {
	ticker := time.NewTicker(statsInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			// Protocols that assign addresses at connect time can only be
			// shaped while a client is online, so this rides the same tick
			// that already looks at who is connected.
			dispatcher.ReconcileShaping(ctx)

			deltas, errs := dispatcher.CollectStats(ctx)
			for _, err := range errs {
				log.Printf("stats collection error: %v", err)
			}

			sessions, sessionErrs := dispatcher.CollectSessionCounts()
			for _, err := range sessionErrs {
				log.Printf("session count error: %v", err)
			}

			// Concurrency counts are worth sending even on a poll with no
			// usage to report: a credential being used from several places
			// is exactly the case where traffic may be flat while the
			// number of users is not.
			if len(deltas) == 0 && len(sessions) == 0 {
				continue
			}

			pbDeltas := make([]*pb.UsageDelta, len(deltas))
			for i, d := range deltas {
				pbDeltas[i] = &pb.UsageDelta{
					ExternalUserId: d.ExternalUserID,
					Protocol:       d.Protocol,
					BytesUp:        d.BytesUp,
					BytesDown:      d.BytesDown,
				}
			}
			pbSessions := make([]*pb.SessionCount, len(sessions))
			for i, s := range sessions {
				pbSessions[i] = &pb.SessionCount{
					ExternalUserId:  s.ExternalUserID,
					Protocol:        s.Protocol,
					DistinctSources: s.DistinctSources,
				}
			}
			if err := stream.Send(&pb.AgentMessage{
				Payload: &pb.AgentMessage_StatsBatch{
					StatsBatch: &pb.StatsBatch{Deltas: pbDeltas, Sessions: pbSessions},
				},
			}); err != nil {
				return fmt.Errorf("send stats batch: %w", err)
			}
		}
	}
}

func receiveLoop(ctx context.Context, stream pb.AgentGateway_AgentSyncClient, dispatcher *dispatch.Dispatcher) error {
	for {
		msg, err := stream.Recv()
		if err != nil {
			return fmt.Errorf("receive: %w", err)
		}
		cmd := msg.GetCommand()
		if cmd == nil {
			continue
		}

		success, errMsg := dispatcher.Execute(ctx, cmd)
		if success {
			log.Printf("executed command %s (%s)", cmd.GetId(), cmd.GetType())
		} else {
			log.Printf("command %s (%s) failed: %s", cmd.GetId(), cmd.GetType(), errMsg)
		}

		if err := stream.Send(&pb.AgentMessage{
			Payload: &pb.AgentMessage_CommandAck{
				CommandAck: &pb.CommandAck{
					CommandId: cmd.GetId(),
					Success:   success,
					Error:     errMsg,
				},
			},
		}); err != nil {
			return fmt.Errorf("send command ack: %w", err)
		}
	}
}

func randomNonce() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
