package controlplane

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/neoxify/neoxify-hub/agent/internal/config"
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

// countingStream records whether Send is ever entered by two goroutines
// at once, which is what grpc-go does not support and what this package
// must never do.
type countingStream struct {
	pb.AgentGateway_AgentSyncClient
	inFlight atomic.Int32
	overlaps atomic.Int32
	calls    atomic.Int32
}

func (c *countingStream) Send(*pb.AgentMessage) error {
	if c.inFlight.Add(1) > 1 {
		c.overlaps.Add(1)
	}
	// Long enough that genuinely concurrent callers would overlap here.
	time.Sleep(time.Millisecond)
	c.calls.Add(1)
	c.inFlight.Add(-1)
	return nil
}

func msg() *pb.AgentMessage {
	return &pb.AgentMessage{Payload: &pb.AgentMessage_Heartbeat{Heartbeat: &pb.Heartbeat{}}}
}

// newSender wires a sender to a stream the way runStream does, and
// returns a cancel that tears the writer down.
func newSender(t *testing.T, stream pb.AgentGateway_AgentSyncClient) (*sender, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	s := &sender{reqs: make(chan writeReq)}
	go func() { _ = writerLoop(ctx, stream, s.reqs) }()
	return s, cancel
}

// The regression. Before this, heartbeatLoop called stream.Send directly
// and a blocked window parked it forever -- which is what left two
// production nodes wedged for six days, because runStream waits on the
// first loop to return an error and no loop ever did. What matters is
// only that the call *returns*.
func TestSendGivesUpOnABlockedWrite(t *testing.T) {
	stream := &blockedStream{release: make(chan struct{})}
	defer close(stream.release)
	snd, cancel := newSender(t, stream)
	defer cancel()

	start := time.Now()
	err := snd.send(context.Background(), msg(), 50*time.Millisecond)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("blocked send returned nil; the caller would treat a wedged stream as healthy")
	}
	if elapsed > time.Second {
		t.Fatalf("took %s to give up on a 50ms budget", elapsed)
	}
}

// A second caller must not be trapped behind the first one's stuck
// write. Before the queue existed they blocked on the same mutex inside
// grpc-go with no deadline at all.
func TestSendGivesUpWhenTheQueueIsBlocked(t *testing.T) {
	stream := &blockedStream{release: make(chan struct{})}
	defer close(stream.release)
	snd, cancel := newSender(t, stream)
	defer cancel()

	// First send occupies writerLoop indefinitely.
	go func() { _ = snd.send(context.Background(), msg(), time.Minute) }()
	time.Sleep(20 * time.Millisecond)

	start := time.Now()
	if err := snd.send(context.Background(), msg(), 50*time.Millisecond); err == nil {
		t.Fatal("queued send behind a stuck write returned nil")
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("took %s to give up on a 50ms budget", elapsed)
	}
}

// A cancelled stream context must free the caller. runStream cancels
// streamCtx on teardown, and a send that ignored it would keep the old
// stream's goroutines alive across a reconnect.
func TestSendHonoursContextCancellation(t *testing.T) {
	stream := &blockedStream{release: make(chan struct{})}
	defer close(stream.release)
	snd, cancel := newSender(t, stream)
	defer cancel()

	ctx, cancelCall := context.WithCancel(context.Background())
	go func() {
		time.Sleep(10 * time.Millisecond)
		cancelCall()
	}()

	// Timeout far beyond the cancel, so a pass cannot come from the timer.
	if err := snd.send(ctx, msg(), 30*time.Second); !errors.Is(err, context.Canceled) {
		t.Fatalf("want context.Canceled, got %v", err)
	}
}

// The ordinary path must stay ordinary: no added latency, and the
// stream's own error propagated unchanged rather than masked.
func TestSendPassesThroughWhenTheWriteCompletes(t *testing.T) {
	released := make(chan struct{})
	close(released)

	snd, cancel := newSender(t, &blockedStream{release: released})
	if err := snd.send(context.Background(), msg(), time.Second); err != nil {
		t.Fatalf("successful send returned %v", err)
	}
	cancel()

	sentinel := errors.New("stream closed")
	snd2, cancel2 := newSender(t, &blockedStream{release: released, err: sentinel})
	defer cancel2()
	if err := snd2.send(context.Background(), msg(), time.Second); !errors.Is(err, sentinel) {
		t.Fatalf("want the stream's own error, got %v", err)
	}
}

// The race this refactor exists to remove. heartbeatLoop, statsLoop and
// receiveLoop all write; grpc-go supports one sender per stream and does
// not support concurrent SendMsg. Every write must arrive at the stream
// one at a time no matter how many goroutines are calling.
func TestConcurrentSendersNeverOverlapOnTheStream(t *testing.T) {
	stream := &countingStream{}
	snd, cancel := newSender(t, stream)
	defer cancel()

	const writers, each = 8, 25
	var wg sync.WaitGroup
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < each; j++ {
				if err := snd.send(context.Background(), msg(), 30*time.Second); err != nil {
					t.Errorf("send failed: %v", err)
					return
				}
			}
		}()
	}
	wg.Wait()

	if got := stream.calls.Load(); got != writers*each {
		t.Fatalf("want %d writes to reach the stream, got %d", writers*each, got)
	}
	if got := stream.overlaps.Load(); got != 0 {
		t.Fatalf("Send was entered concurrently %d times; grpc-go does not support that", got)
	}
}

// The SNI override, added 2026-09-01 after neoxify.site was SNI-blocked
// in Iran: the relay dialled the panel by IP -- correctly -- and then
// announced the blocked hostname in the handshake and was cut off anyway.
// `grpcTarget` already answered "which address"; nothing answered "which
// name".
func TestTLSServerNameDefaultsToThePanelHost(t *testing.T) {
	if got := tlsServerNameFor(&config.Config{}, "connect.example.com"); got != "connect.example.com" {
		t.Fatalf("want the panel host when nothing is set, got %q", got)
	}
}

func TestTLSServerNameOverrideIsUsedWhenSet(t *testing.T) {
	cfg := &config.Config{TLSServerName: "origin.example.net"}
	if got := tlsServerNameFor(cfg, "connect.example.com"); got != "origin.example.net" {
		t.Fatalf("want the override, got %q", got)
	}
}

// An empty override must not blank the SNI. A handshake with no server
// name is a different, worse failure: it does not select a virtual host
// and it is itself a fingerprint.
func TestEmptyOverrideDoesNotBlankTheServerName(t *testing.T) {
	cfg := &config.Config{TLSServerName: ""}
	if got := tlsServerNameFor(cfg, "connect.example.com"); got == "" {
		t.Fatal("server name was blanked")
	}
}
