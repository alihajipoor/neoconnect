package controlplane

import (
	"context"
	"crypto/ed25519"
	"net"
	"strings"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/test/bufconn"

	"github.com/neoxify/neoxify-hub/agent/internal/controlplane/pb"
	"github.com/neoxify/neoxify-hub/agent/internal/dispatch"
)

// silentServer accepts the Hello, optionally sends server heartbeats,
// and otherwise reads and never answers or ends the stream: what the
// backend left seven agents on, 2026-11-14 -- a stream nobody serves, on
// a connection that is perfectly healthy.
type silentServer struct {
	pb.UnimplementedAgentGatewayServer
	// heartbeats is how many ServerHeartbeats to send, every `every`,
	// before going quiet; -1 for forever.
	heartbeats int
	every      time.Duration
}

func (s *silentServer) AgentSync(stream pb.AgentGateway_AgentSyncServer) error {
	if _, err := stream.Recv(); err != nil {
		return err
	}
	go func() {
		for i := 0; s.heartbeats < 0 || i < s.heartbeats; i++ {
			if err := stream.Send(&pb.ControlMessage{Payload: &pb.ControlMessage_ServerHeartbeat{ServerHeartbeat: &pb.ServerHeartbeat{SentAtUnix: time.Now().Unix()}}}); err != nil {
				return
			}
			time.Sleep(s.every)
		}
	}()
	for {
		if _, err := stream.Recv(); err != nil {
			return err
		}
	}
}

func shortWatchdog(t *testing.T) {
	t.Helper()
	limit, tick := serverSilenceLimit, watchdogTick
	serverSilenceLimit, watchdogTick = 300*time.Millisecond, 20*time.Millisecond
	t.Cleanup(func() { serverSilenceLimit, watchdogTick = limit, tick })
}

// runAgainst runs the real runStream against srv for at most `budget`,
// and reports what it returned and when.
func runAgainst(t *testing.T, srv pb.AgentGatewayServer, budget time.Duration) (error, time.Duration) {
	t.Helper()
	lis := bufconn.Listen(1 << 20)
	gs := grpc.NewServer()
	pb.RegisterAgentGatewayServer(gs, srv)
	go func() { _ = gs.Serve(lis) }()
	t.Cleanup(gs.Stop)

	conn, err := grpc.NewClient("passthrough:///bufnet",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) { return lis.DialContext(ctx) }),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	_, key, _ := ed25519.GenerateKey(nil)
	ctx, cancel := context.WithTimeout(context.Background(), budget)
	defer cancel()
	started := time.Now()
	err = runStream(ctx, pb.NewAgentGatewayClient(conn), "node-1", key, dispatch.New(), nil)
	return err, time.Since(started)
}

// The incident, against a backend that sends server heartbeats: the
// stream goes quiet and the agent gives it up instead of waiting forever.
func TestADeadStreamOnAHealthyConnectionIsGivenUp(t *testing.T) {
	shortWatchdog(t)
	err, took := runAgainst(t, &silentServer{heartbeats: 1}, 5*time.Second)
	if err == nil || !strings.Contains(err.Error(), "dead link") {
		t.Fatalf("runStream returned %v after %s, want a dead-link error", err, took)
	}
	if took > 2*time.Second {
		t.Fatalf("gave up after %s, want about the %s limit", took, serverSilenceLimit)
	}
}

// Today's backend sends no server heartbeats, and a node with no users
// and no routes is sent nothing at all. The watchdog must never arm on
// such a stream: it would cut a healthy one every limit.
func TestTheWatchdogStaysOffAgainstABackendThatSendsNoHeartbeats(t *testing.T) {
	shortWatchdog(t)
	err, took := runAgainst(t, &silentServer{heartbeats: 0}, 1500*time.Millisecond)
	if err == nil || strings.Contains(err.Error(), "dead link") || took < 1400*time.Millisecond {
		t.Fatalf("runStream returned %v after %s; want it to run until the test's own deadline", err, took)
	}
}

// A backend that keeps talking keeps its stream.
func TestAStreamThatKeepsHearingFromTheServerStaysUp(t *testing.T) {
	shortWatchdog(t)
	err, took := runAgainst(t, &silentServer{heartbeats: -1, every: 50 * time.Millisecond}, 1500*time.Millisecond)
	if err == nil || strings.Contains(err.Error(), "dead link") || took < 1400*time.Millisecond {
		t.Fatalf("runStream returned %v after %s; want it to run until the test's own deadline", err, took)
	}
}

// A command that takes long to execute is not the server going quiet.
func TestTimeSpentExecutingIsNotSilence(t *testing.T) {
	var w linkWatch
	w.arm()
	w.waiting(time.Now().Add(-time.Hour))
	w.busy()
	if got := w.silentFor(time.Now()); got != 0 {
		t.Fatalf("silent for %s while executing, want 0", got)
	}
}

func TestJitterOnlyShortensTheWait(t *testing.T) {
	for i := 0; i < 1000; i++ {
		got := jittered(10 * time.Second)
		if got > 10*time.Second || got < 8*time.Second {
			t.Fatalf("jittered(10s) = %s, want within [8s, 10s]", got)
		}
	}
	if jittered(0) != 0 {
		t.Fatal("jittered(0) != 0")
	}
}
