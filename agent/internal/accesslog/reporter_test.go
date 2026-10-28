package accesslog

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
	"time"
)

func logLine(at time.Time, host string, user string) string {
	return fmt.Sprintf("%s from tcp:203.0.113.5:51752 accepted tcp:%s:443 [vless-in >> direct] email: %s\n",
		at.UTC().Format("2006/01/02 15:04:05.000000"), host, user)
}

// End to end through the real loop: history on disk before Run is not
// reported, lines appended after it are, counted per destination, and
// arrive as a batch with sensible window bounds.
func TestReporterReportsOnlyWhatIsWrittenAfterItStarts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "access.log")
	now := time.Now()
	appendTo(t, path, logLine(now.Add(-time.Hour), "history.example", testUser))

	r := New(Options{
		Path:      path,
		Window:    60 * time.Millisecond,
		ReadEvery: 10 * time.Millisecond,
		Location:  time.UTC,
	})
	started := time.Now()
	// New has fixed the position at the end; what follows is new.
	appendTo(t, path,
		logLine(now, "example.com", testUser)+
			logLine(now.Add(time.Second), "example.com", testUser)+
			"2026/10/28 08:23:01 from 203.0.113.9:1 rejected proxy/trojan: not trojan protocol\n"+
			logLine(now, "example.org", testUser))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go r.Run(ctx)

	var got []Destination
	deadline := time.After(5 * time.Second)
	for len(got) < 2 {
		select {
		case b := <-r.Batches():
			if !b.WindowEnd.After(b.WindowStart) || b.WindowStart.Before(started.Add(-time.Second)) {
				t.Errorf("window %s..%s does not look like one window after start", b.WindowStart, b.WindowEnd)
			}
			if b.Dropped != 0 {
				t.Errorf("dropped = %d, want 0", b.Dropped)
			}
			got = append(got, b.Destinations...)
		case <-deadline:
			t.Fatalf("no batch with both destinations within 5s; got %+v", got)
		}
	}

	byHost := map[string]Destination{}
	for _, d := range got {
		if d.Host == "history.example" {
			t.Fatal("a line written before the reporter started was reported")
		}
		byHost[d.Host] = d
	}
	if d := byHost["example.com"]; d.Count != 2 || d.User != testUser || d.InboundTag != "vless-in" || d.Network != "tcp" || d.Port != 443 {
		t.Errorf("example.com = %+v, want count 2 for %s on vless-in tcp/443", d, testUser)
	}
	if d := byHost["example.org"]; d.Count != 1 {
		t.Errorf("example.org = %+v, want count 1", d)
	}
}

// Nothing is ever waited on: with the queue full, a finished window is
// dropped, and the lines it held come back as the next batch's dropped.
func TestReporterFullQueueCountsLostLines(t *testing.T) {
	r := New(Options{Path: "unused", Queue: 1})
	agg := NewAggregator(100, 0)
	t0 := time.Date(2026, 10, 28, 8, 0, 0, 0, time.UTC)

	agg.Add(entry("u1", "a.example", 443, t0))
	r.flush(agg, t0, t0.Add(time.Minute)) // queued

	agg.Add(entry("u1", "b.example", 443, t0))
	agg.Add(entry("u1", "b.example", 443, t0))
	agg.Add(entry("u1", "c.example", 443, t0))
	r.flush(agg, t0.Add(time.Minute), t0.Add(2*time.Minute)) // no room: 3 lines lost

	first := <-r.Batches()
	if len(first.Destinations) != 1 || first.Destinations[0].Host != "a.example" {
		t.Fatalf("first batch = %+v", first)
	}

	agg.Add(entry("u1", "d.example", 443, t0))
	r.flush(agg, t0.Add(2*time.Minute), t0.Add(3*time.Minute))
	third := <-r.Batches()
	if third.Dropped != 3 {
		t.Fatalf("dropped = %d, want the 3 lines of the window that did not fit", third.Dropped)
	}
	if len(third.Destinations) != 1 || third.Destinations[0].Host != "d.example" {
		t.Fatalf("third batch = %+v", third)
	}
}

// Lines the stream took but could not deliver are reported the same way,
// and a window holding nothing else is still sent to say so.
func TestReporterLostLinesAreSaid(t *testing.T) {
	r := New(Options{Path: "unused"})
	agg := NewAggregator(100, 0)
	t0 := time.Date(2026, 10, 28, 8, 0, 0, 0, time.UTC)

	r.flush(agg, t0, t0.Add(time.Minute))
	select {
	case b := <-r.Batches():
		t.Fatalf("an empty window was sent: %+v", b)
	default:
	}

	r.Lost(42)
	r.flush(agg, t0.Add(time.Minute), t0.Add(2*time.Minute))
	select {
	case b := <-r.Batches():
		if b.Dropped != 42 || len(b.Destinations) != 0 {
			t.Fatalf("batch = %+v, want only dropped=42", b)
		}
	default:
		t.Fatal("a window that lost lines was not sent")
	}
}
