// Package accesslog reports where provisioned users' connections went,
// read from Xray's access log, so the panel can show a customer's site
// history.
//
// The owner's decision of 2026-10-28: staff opening a customer see the
// sites and addresses that customer's connections opened over the last
// seven days, to diagnose "I can't reach X" and to monitor. The privacy
// page discloses it. The node keeps none of it beyond one window in
// memory; the backend keeps seven days (site_visits).
//
// What this can and cannot see. Only Xray logs destinations, so
// WireGuard, OpenVPN and IKEv2 report nothing. The nodes do not sniff
// names, so a destination is a name only where the client sent one, and
// an address otherwise. Shadowsocks UDP rides UDP-over-TCP, whose inner
// destinations Xray never routes and never logs. And nothing is read
// from before the agent started.
//
// Turned off with NEOXIFY_SITE_LOG=off (or --site-log=off) on the agent.
// Off means this package is never started: nothing is read, nothing is
// sent, and the panel shows no site history for that server.
package accesslog

import (
	"context"
	"log"
	"strings"
	"sync/atomic"
	"time"
)

const (
	// DefaultWindow is how long destinations are counted before they are
	// sent. A minute keeps a batch small on a busy node and the panel
	// close to live, and is far finer than "the last seven days" needs.
	DefaultWindow = 60 * time.Second
	// DefaultReadEvery is how often the log is read within a window.
	// Often enough that a copytruncate rotation lands between two polls
	// with little written after it, which is when Tailer's checks for it
	// are certain rather than probable.
	DefaultReadEvery = 5 * time.Second
	// DefaultMaxKeys caps distinct destinations per window. See Aggregator.
	DefaultMaxKeys = 20000
	// DefaultMaxPerUser is one user's share of that, so that a scanner or
	// a torrent client cannot fill the window for everyone on the node.
	// A minute of heavy browsing opens far fewer distinct destinations
	// than this; it bites on spraying, not on use. See Aggregator.
	DefaultMaxPerUser = 500
	// DefaultMaxReadBytes bounds one poll: 4 MiB is roughly 25,000 access
	// lines, so one poll every five seconds keeps up with about 5,000
	// connections a second -- far past what any node opens today -- and
	// a backlog is worked through in steps instead of in one allocation.
	DefaultMaxReadBytes = 4 << 20
	// defaultQueue is how many finished windows wait for the control
	// plane while it is unreachable. Five minutes of history survives a
	// panel restart; past that, windows are dropped and their lines are
	// counted into the next batch's dropped, not kept in memory without
	// limit on a small VPS.
	defaultQueue = 5
)

// Enabled reads the NEOXIFY_SITE_LOG setting. Anything but an explicit
// off is on, including the empty string an unset variable gives: the
// owner's decision is that the history exists by default. The spellings
// of off are generous so that whoever turns it off on a node is not
// surprised to find it still running because they wrote "false".
func Enabled(setting string) bool {
	switch strings.ToLower(strings.TrimSpace(setting)) {
	case "off", "0", "false", "no", "disabled":
		return false
	}
	return true
}

// Options configures a Reporter. Zero values take the defaults above.
type Options struct {
	Path         string
	Window       time.Duration
	ReadEvery    time.Duration
	MaxKeys      int
	MaxPerUser   int
	MaxReadBytes int64
	// Location is the zone Xray's timestamps are in: the node's own, so
	// time.Local, which is the default. Some nodes run on CST, not UTC.
	Location *time.Location
	Queue    int
}

// Batch is one window's destinations.
type Batch struct {
	WindowStart  time.Time
	WindowEnd    time.Time
	Destinations []Destination
	// Dropped is log lines this batch does not account for: lines past
	// the window's key caps (the node's and each user's), plus the lines of earlier windows that could
	// not be queued or sent. Said, not hidden.
	Dropped uint64
}

// Lines is how many access-log lines the batch accounts for, counted or
// dropped. It is what is lost if the batch is.
func (b Batch) Lines() uint64 {
	n := b.Dropped
	for _, d := range b.Destinations {
		n += uint64(d.Count)
	}
	return n
}

// Reporter tails the access log, counts a window at a time, and offers
// each finished window on Batches. It never waits on its consumer: a
// window that does not fit the queue is dropped and counted.
type Reporter struct {
	opts Options
	tail *Tailer
	out  chan Batch
	// lost is lines from windows that never reached the control plane,
	// carried into the next batch's Dropped. Atomic because the stream's
	// loop adds to it from another goroutine.
	lost atomic.Uint64
	// full is whether the last window was turned away, so a long outage
	// logs once rather than every minute. Only Run's goroutine uses it.
	full bool
}

// New returns a reporter for the log at opts.Path, positioned at the
// log's current end: that is the moment from which there is anything
// to report. Nothing is read until Run.
func New(opts Options) *Reporter {
	if opts.Window <= 0 {
		opts.Window = DefaultWindow
	}
	if opts.ReadEvery <= 0 {
		opts.ReadEvery = DefaultReadEvery
	}
	if opts.MaxKeys <= 0 {
		opts.MaxKeys = DefaultMaxKeys
	}
	if opts.MaxPerUser <= 0 {
		opts.MaxPerUser = DefaultMaxPerUser
	}
	if opts.MaxReadBytes <= 0 {
		opts.MaxReadBytes = DefaultMaxReadBytes
	}
	if opts.Location == nil {
		opts.Location = time.Local
	}
	if opts.Queue <= 0 {
		opts.Queue = defaultQueue
	}
	return &Reporter{
		opts: opts,
		tail: NewTailer(opts.Path, opts.MaxReadBytes),
		out:  make(chan Batch, opts.Queue),
	}
}

// Batches is where finished windows appear. The channel outlives any one
// control-plane stream, so windows finished while the panel is
// unreachable are sent once it is back, up to the queue's size.
func (r *Reporter) Batches() <-chan Batch { return r.out }

// Lost records lines the consumer took but could not deliver, so the
// next batch says they are missing.
func (r *Reporter) Lost(lines uint64) {
	if lines > 0 {
		r.lost.Add(lines)
	}
}

// Run reads and counts until ctx is cancelled. Call it once.
func (r *Reporter) Run(ctx context.Context) {
	tail := r.tail
	agg := NewAggregator(r.opts.MaxKeys, r.opts.MaxPerUser)
	loc := r.opts.Location
	add := func(line string) {
		if e, ok := ParseLine(line, loc); ok {
			agg.Add(e)
		}
	}

	ticker := time.NewTicker(r.opts.ReadEvery)
	defer ticker.Stop()

	windowStart := time.Now()
	var lastErr string
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}

		// Logged when it changes, not every five seconds: a log the
		// agent cannot read stays unreadable until someone fixes it, and
		// the same line 17,000 times a day would bury everything else.
		err := tail.Poll(add)
		switch {
		case err != nil && err.Error() != lastErr:
			log.Printf("site history: %v", err)
			lastErr = err.Error()
		case err == nil && lastErr != "":
			log.Printf("site history: reading %s again", r.opts.Path)
			lastErr = ""
		}

		if now := time.Now(); now.Sub(windowStart) >= r.opts.Window {
			r.flush(agg, windowStart, now)
			windowStart = now
		}
	}
}

// flush ends a window and offers it on the queue without waiting. An
// empty window is not sent -- most minutes on a quiet node have nothing
// to say -- unless lines were lost, which is itself worth saying.
func (r *Reporter) flush(agg *Aggregator, start, end time.Time) {
	dests, dropped := agg.Take()
	dropped += r.lost.Swap(0)
	if len(dests) == 0 && dropped == 0 {
		return
	}

	b := Batch{WindowStart: start, WindowEnd: end, Destinations: dests, Dropped: dropped}
	select {
	case r.out <- b:
		r.full = false
	default:
		r.lost.Add(b.Lines())
		if !r.full {
			log.Printf("site history: %d windows already waiting for the control plane; dropping new ones and counting their lines", cap(r.out))
			r.full = true
		}
	}
}
