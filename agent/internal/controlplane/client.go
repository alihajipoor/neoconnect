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
	"google.golang.org/grpc/keepalive"

	"github.com/neoxify/neoxify-hub/agent/internal/config"
	"github.com/neoxify/neoxify-hub/agent/internal/controlplane/pb"
	"github.com/neoxify/neoxify-hub/agent/internal/dispatch"
	"github.com/neoxify/neoxify-hub/agent/internal/realityprobe"
	"github.com/neoxify/neoxify-hub/agent/internal/version"
)

const (
	heartbeatInterval = 20 * time.Second
	statsInterval     = 30 * time.Second
	initialBackoff    = time.Second
	maxBackoff        = 30 * time.Second

	// HTTP/2 keepalive. Without it a peer that stops reading is
	// indistinguishable from an idle one: the socket stays ESTABLISHED,
	// the stream never errors, and the agent waits forever. Two nodes sat
	// like that for six days -- see docs/journal/log.md, 2026-08-30.
	//
	// keepaliveTime must not be lower than the server's
	// MinPingIntervalWithoutData or the server answers pings with GOAWAY
	// (ENHANCE_YOUR_CALM), which is a worse failure than the one being
	// fixed. Backend is configured at 20s; 30s here leaves margin.
	keepaliveTime    = 30 * time.Second
	keepaliveTimeout = 10 * time.Second

	// Ceiling on a single stream write. grpc-go's Send takes no deadline
	// of its own: when the HTTP/2 send window is exhausted it parks in
	// writeQuota.get until the peer sends WINDOW_UPDATE, with no upper
	// bound. Keepalive should catch a dead peer first; this is the
	// backstop for a peer that is alive, answering pings, and still not
	// reading -- which keepalive alone does not detect.
	sendTimeout = 30 * time.Second
)

// Run connects to the control plane and keeps the AgentSync stream alive,
// reconnecting with exponential backoff on any failure. Blocks until ctx
// is cancelled.
func Run(ctx context.Context, cfg *config.Config, dispatcher *dispatch.Dispatcher, prober *realityprobe.Prober) error {
	target, creds, err := dialTarget(cfg)
	if err != nil {
		return err
	}

	conn, err := grpc.NewClient(target,
		grpc.WithTransportCredentials(creds),
		// PermitWithoutStream because the agent must keep proving the
		// connection between streams too -- a reconnect that dials a
		// black hole should fail fast rather than hang on the next Send.
		grpc.WithKeepaliveParams(keepalive.ClientParameters{
			Time:                keepaliveTime,
			Timeout:             keepaliveTimeout,
			PermitWithoutStream: true,
		}),
	)
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

		if err := runStream(ctx, client, cfg.NodeID, signingKey, dispatcher, prober); err != nil && ctx.Err() == nil {
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
// tlsServerNameFor decides which name the handshake announces.
//
// Split out from dialTarget because it is the whole of the decision and
// the rest of that function is URL parsing: a test can pin this without
// constructing transport credentials it cannot inspect.
func tlsServerNameFor(cfg *config.Config, panelHost string) string {
	if cfg.TLSServerName != "" {
		return cfg.TLSServerName
	}
	return panelHost
}

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
	derived := false
	if target == "" {
		target = fmt.Sprintf("%s:50051", host)
		derived = true
	}
	// A derived target is the panel's own hostname, and that hostname is
	// very often behind a CDN -- which serves 443 and nothing else. The
	// dial then times out on every attempt and the node sits OFFLINE
	// while looking healthy locally: agentd running, no crash, no restart.
	// finland1 spent its whole first rebuild in exactly that state on
	// 2026-08-31, because connect.neoxify.site resolves to Cloudflare.
	//
	// Nothing here can tell a CDN address from an origin one, so this
	// does not guess -- it says what was assumed, once, so the assumption
	// is visible in the log next to the dial errors it causes.
	if derived {
		log.Printf(
			"no grpcTarget configured; derived %q from the panel URL. "+
				"If the panel host is behind a CDN this will time out -- "+
				"set grpcTarget in /etc/neoxify/agent.json to the origin's host:port.",
			target,
		)
	}

	if u.Scheme == "https" {
		// The name announced in the handshake is not always the name we
		// dial. Where a censor blocks by SNI, the two must differ: dial
		// the origin's address, present a name that is both on the
		// panel's certificate and not blocked.
		//
		// Verification is unchanged -- an override that the certificate
		// does not cover fails, which is the intended behaviour. This
		// swaps which valid name is used, it does not stop checking.
		serverName := tlsServerNameFor(cfg, host)
		if serverName != host {
			log.Printf("presenting TLS server name %q (dialling %s)", serverName, target)
		}
		return target, credentials.NewTLS(&tls.Config{ServerName: serverName}), nil
	}
	return target, insecure.NewCredentials(), nil
}

func runStream(
	ctx context.Context,
	client pb.AgentGatewayClient,
	nodeID string,
	key ed25519.PrivateKey,
	dispatcher *dispatch.Dispatcher,
	prober *realityprobe.Prober,
) error {
	streamCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	stream, err := client.AgentSync(streamCtx)
	if err != nil {
		return fmt.Errorf("open AgentSync stream: %w", err)
	}

	// The writer starts before the hello, because the hello is itself a
	// stream write and goes through the same queue as everything else.
	// errCh has room for all four so none can block on the way out.
	errCh := make(chan error, 4)
	snd := &sender{reqs: make(chan writeReq)}
	go func() { errCh <- writerLoop(streamCtx, stream, snd.reqs) }()

	if err := sendHello(streamCtx, snd, nodeID, key); err != nil {
		return fmt.Errorf("send hello: %w", err)
	}
	log.Printf("connected to control plane, node %s authenticated", nodeID)

	go func() { errCh <- heartbeatLoop(streamCtx, snd, prober) }()
	go func() { errCh <- statsLoop(streamCtx, snd, dispatcher) }()
	go func() { errCh <- receiveLoop(streamCtx, stream, snd, dispatcher) }()

	err = <-errCh
	cancel()
	return err
}

// writeReq is one queued stream write and the channel its result comes
// back on. `done` is buffered so writerLoop can always deliver the
// result, even to a caller that has already given up waiting.
type writeReq struct {
	msg  *pb.AgentMessage
	done chan error
}

// sender is the only way anything in this package writes to the stream.
//
// grpc-go supports one goroutine sending and one receiving on a stream;
// it does NOT support concurrent SendMsg. heartbeatLoop, statsLoop and
// receiveLoop all need to write, so their writes are funnelled through
// writerLoop instead of each calling Send directly.
type sender struct {
	reqs chan writeReq
}

// writerLoop owns stream.Send exclusively. It exits on the first send
// error or when the stream context is cancelled, and its return value
// joins the same errCh the other loops use, so a failed write still
// tears the stream down and triggers a reconnect.
func writerLoop(ctx context.Context, stream pb.AgentGateway_AgentSyncClient, reqs <-chan writeReq) error {
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case r := <-reqs:
			err := stream.Send(r.msg)
			r.done <- err
			if err != nil {
				return fmt.Errorf("stream write: %w", err)
			}
		}
	}
}

// send queues one write and waits up to d for it to complete.
//
// grpc-go's Send takes no deadline of its own: when the HTTP/2 send
// window is exhausted it parks in writeQuota.get until the peer sends
// WINDOW_UPDATE, with no upper bound. That is what left two nodes wedged
// for six days (docs/journal/log.md, 2026-08-30). Both waits below are
// bounded by the same timer, so a caller cannot be stuck longer than d
// whether the queue is backed up or the write itself is blocked.
//
// A timeout leaves writerLoop parked in Send. That is intended and is
// not a leak: the caller returns the error to runStream, which cancels
// streamCtx, which unblocks Send and lets the goroutine exit.
func (s *sender) send(ctx context.Context, msg *pb.AgentMessage, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()

	req := writeReq{msg: msg, done: make(chan error, 1)}
	select {
	case s.reqs <- req:
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return fmt.Errorf("stream write queue blocked for %s", d)
	}

	select {
	case err := <-req.done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return fmt.Errorf("stream write blocked for %s (send window exhausted)", d)
	}
}

func sendHello(ctx context.Context, snd *sender, nodeID string, key ed25519.PrivateKey) error {

	nonce := randomNonce()
	timestamp := time.Now().Unix()
	message := []byte(fmt.Sprintf("%s.%d.%s", nodeID, timestamp, nonce))
	signature := ed25519.Sign(key, message)

	return snd.send(ctx, &pb.AgentMessage{
		Payload: &pb.AgentMessage_Hello{
			Hello: &pb.Hello{
				NodeId:       nodeID,
				Timestamp:    timestamp,
				Nonce:        nonce,
				Signature:    signature,
				AgentVersion: version.Version,
			},
		},
	}, sendTimeout)
}

func heartbeatLoop(ctx context.Context, snd *sender, prober *realityprobe.Prober) error {
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
			// The probe runs on its own schedule; this only reads its
			// last answer. A heartbeat must never block on a dial --
			// the heartbeat IS the liveness signal, and making it wait
			// on the network is how it stops being one.
			hb := &pb.Heartbeat{}
			if prober != nil {
				if r := prober.Snapshot(); r.Dest != "" {
					hb.RealityDest = r.Dest
					hb.RealityDestReachable = r.Reachable
				}
			}
			if err := snd.send(ctx, &pb.AgentMessage{
				Payload: &pb.AgentMessage_Heartbeat{Heartbeat: hb},
			}, sendTimeout); err != nil {
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
func statsLoop(ctx context.Context, snd *sender, dispatcher *dispatch.Dispatcher) error {
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
			if err := snd.send(ctx, &pb.AgentMessage{
				Payload: &pb.AgentMessage_StatsBatch{
					StatsBatch: &pb.StatsBatch{Deltas: pbDeltas, Sessions: pbSessions},
				},
			}, sendTimeout); err != nil {
				return fmt.Errorf("send stats batch: %w", err)
			}
		}
	}
}

func receiveLoop(ctx context.Context, stream pb.AgentGateway_AgentSyncClient, snd *sender, dispatcher *dispatch.Dispatcher) error {
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

		if err := snd.send(ctx, &pb.AgentMessage{
			Payload: &pb.AgentMessage_CommandAck{
				CommandAck: &pb.CommandAck{
					CommandId: cmd.GetId(),
					Success:   success,
					Error:     errMsg,
				},
			},
		}, sendTimeout); err != nil {
			return fmt.Errorf("send command ack: %w", err)
		}
	}
}

func randomNonce() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
