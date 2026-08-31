package controlplane

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/neoxify/neoxify-hub/agent/internal/controlplane/pb"
)

// blockedStream models the failure this package exists to survive: a
// Send that never returns because the HTTP/2 send window is exhausted
// and the peer is sending no WINDOW_UPDATE. Only Send is implemented --
// the embedded interface is nil, so any other call panics loudly rather
// than quietly returning a zero value.
type blockedStream struct {
	pb.AgentGateway_AgentSyncClient
	release chan struct{}
	err     error
}

func (b *blockedStream) Send(*pb.AgentMessage) error {
	<-b.release
	return b.err
}

func msg() *pb.AgentMessage {
	return &pb.AgentMessage{Payload: &pb.AgentMessage_Heartbeat{Heartbeat: &pb.Heartbeat{}}}
}

// The regression itself. Before sendWithTimeout, heartbeatLoop called
// stream.Send directly and a blocked window parked it forever -- which
// is what left two production nodes wedged for six days, because
// runStream waits on the first loop to return an error and no loop ever
// did. What matters here is only that the call *returns*.
func TestSendWithTimeoutGivesUpOnABlockedWrite(t *testing.T) {
	stream := &blockedStream{release: make(chan struct{})}
	defer close(stream.release)

	start := time.Now()
	err := sendWithTimeout(context.Background(), stream, msg(), 50*time.Millisecond)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("blocked send returned nil; the caller would treat a wedged stream as healthy")
	}
	if elapsed > time.Second {
		t.Fatalf("took %s to give up on a 50ms budget", elapsed)
	}
}

// A cancelled stream context must also free the caller. runStream
// cancels streamCtx on teardown, and a send that ignored it would keep
// the old stream's goroutines alive across a reconnect.
func TestSendWithTimeoutHonoursContextCancellation(t *testing.T) {
	stream := &blockedStream{release: make(chan struct{})}
	defer close(stream.release)

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(10 * time.Millisecond)
		cancel()
	}()

	// Timeout far beyond the cancel, so a pass cannot come from the timer.
	err := sendWithTimeout(ctx, stream, msg(), 30*time.Second)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("want context.Canceled, got %v", err)
	}
}

// The ordinary path must stay ordinary: no added latency, and the
// stream's own error propagated unchanged rather than masked by the
// timeout wrapper.
func TestSendWithTimeoutPassesThroughWhenTheWriteCompletes(t *testing.T) {
	released := make(chan struct{})
	close(released)

	if err := sendWithTimeout(context.Background(), &blockedStream{release: released}, msg(), time.Second); err != nil {
		t.Fatalf("successful send returned %v", err)
	}

	sentinel := errors.New("stream closed")
	err := sendWithTimeout(context.Background(), &blockedStream{release: released, err: sentinel}, msg(), time.Second)
	if !errors.Is(err, sentinel) {
		t.Fatalf("want the stream's own error, got %v", err)
	}
}
