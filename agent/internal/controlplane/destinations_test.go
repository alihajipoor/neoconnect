package controlplane

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sync"
	"testing"
	"time"

	"github.com/neoxify/neoxify-hub/agent/internal/accesslog"
	"github.com/neoxify/neoxify-hub/agent/internal/controlplane/pb"
)

func window(n int, dropped uint64) accesslog.Batch {
	t0 := time.Date(2026, 10, 28, 8, 0, 0, 0, time.UTC)
	b := accesslog.Batch{WindowStart: t0, WindowEnd: t0.Add(time.Minute), Dropped: dropped}
	for i := 0; i < n; i++ {
		b.Destinations = append(b.Destinations, accesslog.Destination{
			User:       "30a9cb8b-f094-4821-bc6d-d0b0cd426e60",
			InboundTag: "vless-in",
			Network:    "tcp",
			Host:       fmt.Sprintf("host-%05d.example", i),
			Port:       443,
			Count:      2,
			FirstSeen:  t0.Add(time.Second),
			LastSeen:   t0.Add(59 * time.Second),
		})
	}
	return b
}

func TestDestinationMessagesSplitsAWindow(t *testing.T) {
	b := window(4500, 7)
	msgs := destinationMessages(b, 2000)
	if len(msgs) != 3 {
		t.Fatalf("got %d messages, want 3", len(msgs))
	}

	var rows int
	var lines uint64
	for i, m := range msgs {
		db := m.GetDestinationBatch()
		if db == nil {
			t.Fatalf("message %d is not a DestinationBatch: %v", i, m)
		}
		if n := len(db.GetDestinations()); n > 2000 {
			t.Errorf("message %d has %d rows, over the 2000 limit", i, n)
		}
		if db.GetWindowStart() != b.WindowStart.Unix() || db.GetWindowEnd() != b.WindowEnd.Unix() {
			t.Errorf("message %d window %d..%d, want every piece to carry the window", i, db.GetWindowStart(), db.GetWindowEnd())
		}
		// Dropped once, on the first piece, so a backend summing them
		// does not count it three times.
		if want := map[bool]uint32{true: 7, false: 0}[i == 0]; db.GetDropped() != want {
			t.Errorf("message %d dropped = %d, want %d", i, db.GetDropped(), want)
		}
		rows += len(db.GetDestinations())
		lines += destinationLines(db)
	}
	if rows != 4500 {
		t.Errorf("rows across messages = %d, want 4500", rows)
	}
	if lines != b.Lines() {
		t.Errorf("lines across messages = %d, want %d", lines, b.Lines())
	}

	d := msgs[0].GetDestinationBatch().GetDestinations()[0]
	want := &pb.DestinationCount{
		ExternalUserId: "30a9cb8b-f094-4821-bc6d-d0b0cd426e60",
		InboundTag:     "vless-in",
		Network:        "tcp",
		Host:           "host-00000.example",
		Port:           443,
		Count:          2,
		FirstSeen:      b.WindowStart.Unix() + 1,
		LastSeen:       b.WindowStart.Unix() + 59,
	}
	if d.String() != want.String() {
		t.Errorf("first row = %v\nwant        %v", d, want)
	}
}

func TestDestinationMessagesOnlyDropped(t *testing.T) {
	msgs := destinationMessages(window(0, 12), 2000)
	if len(msgs) != 1 {
		t.Fatalf("got %d messages, want one saying lines were dropped", len(msgs))
	}
	if got := msgs[0].GetDestinationBatch().GetDropped(); got != 12 {
		t.Fatalf("dropped = %d, want 12", got)
	}

	huge := destinationMessages(window(1, math.MaxUint32+5), 2000)
	if got := huge[0].GetDestinationBatch().GetDropped(); got != math.MaxUint32 {
		t.Fatalf("dropped = %d, want it held at MaxUint32 rather than wrapped", got)
	}
}

type fakeSites struct {
	ch   chan accesslog.Batch
	mu   sync.Mutex
	lost uint64
}

func (f *fakeSites) Batches() <-chan accesslog.Batch { return f.ch }
func (f *fakeSites) Lost(n uint64) {
	f.mu.Lock()
	f.lost += n
	f.mu.Unlock()
}
func (f *fakeSites) lostLines() uint64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lost
}

type recordingStream struct {
	pb.AgentGateway_AgentSyncClient
	mu   sync.Mutex
	sent []*pb.AgentMessage
}

func (r *recordingStream) Send(m *pb.AgentMessage) error {
	r.mu.Lock()
	r.sent = append(r.sent, m)
	r.mu.Unlock()
	return nil
}

func (r *recordingStream) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.sent)
}

func TestDestinationLoopSendsEveryPiece(t *testing.T) {
	stream := &recordingStream{}
	snd, cancelWriter := newSender(t, stream)
	defer cancelWriter()

	sites := &fakeSites{ch: make(chan accesslog.Batch, 1)}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- destinationLoop(ctx, snd, sites) }()

	sites.ch <- window(maxDestinationsPerMessage+1, 0)
	deadline := time.Now().Add(5 * time.Second)
	for stream.count() < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if n := stream.count(); n != 2 {
		t.Fatalf("sent %d messages, want 2", n)
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("loop returned %v, want context.Canceled", err)
	}
	if sites.lostLines() != 0 {
		t.Fatalf("lost %d lines on a healthy stream", sites.lostLines())
	}
}

// A window that cannot be sent costs that window, counted, and nothing
// else: the loop must not return an error, because runStream would take
// that as the stream failing and drop heartbeats and commands with it.
func TestDestinationLoopFailureIsCountedNotFatal(t *testing.T) {
	released := make(chan struct{})
	close(released)
	snd, cancelWriter := newSender(t, &blockedStream{release: released, err: errors.New("stream closed")})
	defer cancelWriter()

	sites := &fakeSites{ch: make(chan accesslog.Batch, 1)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- destinationLoop(ctx, snd, sites) }()

	b := window(3, 4)
	sites.ch <- b
	deadline := time.Now().Add(5 * time.Second)
	for sites.lostLines() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := sites.lostLines(); got != b.Lines() {
		t.Fatalf("lost = %d, want all %d lines of the window", got, b.Lines())
	}

	select {
	case err := <-done:
		t.Fatalf("loop returned %v after a failed send; it must keep going", err)
	case <-time.After(50 * time.Millisecond):
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("loop returned %v, want context.Canceled", err)
	}
}
