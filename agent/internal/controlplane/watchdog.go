package controlplane

import (
	"context"
	"fmt"
	mrand "math/rand/v2"
	"sync/atomic"
	"time"
)

// The receive watchdog: a dead-link detector for the one failure
// keepalive cannot see.
//
// On 2026-11-14 the backend stopped reading seven agents' streams after a
// database pool timeout, without ending them (call.destroy in grpc-js
// sends no status and no RST_STREAM). The HTTP/2 connection stayed
// healthy and answered every keepalive ping, heartbeats are too small to
// fill the stream's flow-control window within sendTimeout, and Recv has
// no deadline. So no loop errored, and each agent sat on a dead stream,
// silent, for eight minutes, until the backend was restarted.
//
// The control plane now writes a ServerHeartbeat on every stream every
// 20 s. Once one has arrived, Recv waiting longer than serverSilenceLimit
// means the stream is dead whatever the connection says, and the watchdog
// ends it so Run redials with its backoff.
//
// It arms only on the first ServerHeartbeat, which keeps it compatible
// with a backend that sends none (every backend before this change): a
// node with no users and no routes is sent nothing at all by those, and
// a deadline would cut its healthy stream every few minutes.
var (
	// serverSilenceLimit is four missed server heartbeats and then some:
	// long enough for a busy backend, short enough to come back well
	// before an operator would reach for a restart.
	serverSilenceLimit = 90 * time.Second
	// watchdogTick is how often the watchdog looks.
	watchdogTick = 5 * time.Second
)

// linkWatch is shared by receiveLoop, which reports what it is doing,
// and watchdogLoop, which reads it. Atomics, because they run on
// different goroutines.
type linkWatch struct {
	armed atomic.Bool
	// waitingSince is when receiveLoop entered its current Recv, in unix
	// nanoseconds; 0 while it is executing a command, so a slow engine
	// call is never mistaken for a silent server.
	waitingSince atomic.Int64
}

func (w *linkWatch) waiting(now time.Time) { w.waitingSince.Store(now.UnixNano()) }
func (w *linkWatch) busy()                 { w.waitingSince.Store(0) }
func (w *linkWatch) arm()                  { w.armed.Store(true) }

// silentFor reports how long Recv has waited, if the watchdog is armed
// and Recv is waiting; 0 otherwise.
func (w *linkWatch) silentFor(now time.Time) time.Duration {
	if !w.armed.Load() {
		return 0
	}
	since := w.waitingSince.Load()
	if since == 0 {
		return 0
	}
	return now.Sub(time.Unix(0, since))
}

// watchdogLoop returns an error once the server has been silent past the
// limit; runStream then cancels the stream, which unblocks Recv.
func watchdogLoop(ctx context.Context, w *linkWatch, limit, tick time.Duration) error {
	ticker := time.NewTicker(tick)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if silent := w.silentFor(time.Now()); silent > limit {
				return fmt.Errorf("dead link: nothing from the control plane for %s (limit %s)", silent.Round(time.Second), limit)
			}
		}
	}
}

// jittered takes up to a fifth off a redial wait, so agents cut off
// together -- seven at once on 2026-11-14 -- do not all redial in the same
// instant. Only ever shorter, so every bound nextBackoff's tests pin
// still holds.
func jittered(d time.Duration) time.Duration {
	if d <= 0 {
		return d
	}
	return d - time.Duration(mrand.Int64N(int64(d)/5+1))
}
