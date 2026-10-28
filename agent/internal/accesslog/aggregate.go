package accesslog

import (
	"math"
	"sort"
	"time"
)

// Destination is one user's connections to one place over a window.
type Destination struct {
	User       string
	InboundTag string
	Network    string
	Host       string
	Port       uint32
	Count      uint32 // connections opened; saturates rather than wrapping
	FirstSeen  time.Time
	LastSeen   time.Time
}

type destKey struct {
	user, tag, network, host string
	port                     uint32
}

type tally struct {
	count       uint32
	first, last time.Time
}

// Aggregator counts entries per (user, inbound, network, host, port).
//
// One row per connection would be useless and large: a single page load
// opens dozens of connections to the same few addresses, and the panel
// wants "this customer reached that site, this often, between these
// times", which is what a count with first and last seen says.
//
// The number of distinct keys is capped because the keys come from
// clients. Every destination a client names is a new key, so a scanner,
// a torrent client or someone deliberately spraying addresses could
// otherwise grow this map -- and the batch, and the database -- without
// bound. Past the cap, lines for keys already present still count;
// lines for new keys are added to dropped, which the batch carries so
// the panel can say the window was incomplete rather than imply it was
// not.
//
// There are two caps. The node-wide one bounds memory and the size of a
// batch, but on its own it lets one user spend all of it: a scanner or a
// torrent client opens thousands of new destinations a minute, fills the
// window by itself, and every other user's new destinations on that node
// then go uncounted -- holes in their history they did nothing to cause.
// Every row it does fill is also kept for seven days on the panel, which
// at a full window a minute is hundreds of millions of rows a week from
// one customer. The per-user cap is that user's share: past it, their
// new destinations are dropped and counted, and everyone else's still
// fit. "User" here is one credential, and most credentials are one
// device's, so a customer's phone and laptop each get a share of their
// own.
type Aggregator struct {
	maxKeys    int
	maxPerUser int
	counts     map[destKey]*tally
	perUser    map[string]int
	dropped    uint64
}

// NewAggregator returns an aggregator that holds at most maxKeys distinct
// destinations per window, and at most maxPerUser of them for any one
// user. Either <= 0 means no such cap, which only tests should want.
func NewAggregator(maxKeys, maxPerUser int) *Aggregator {
	return &Aggregator{
		maxKeys:    maxKeys,
		maxPerUser: maxPerUser,
		counts:     make(map[destKey]*tally),
		perUser:    make(map[string]int),
	}
}

// Add counts one entry.
func (a *Aggregator) Add(e Entry) {
	k := destKey{user: e.User, tag: e.InboundTag, network: e.Network, host: e.Host, port: e.Port}
	t, ok := a.counts[k]
	if !ok {
		if a.maxKeys > 0 && len(a.counts) >= a.maxKeys {
			a.dropped++
			return
		}
		if a.maxPerUser > 0 && a.perUser[e.User] >= a.maxPerUser {
			a.dropped++
			return
		}
		a.counts[k] = &tally{count: 1, first: e.At, last: e.At}
		a.perUser[e.User]++
		return
	}
	if t.count < math.MaxUint32 {
		t.count++
	}
	// Lines are written in order, but two connections opened in the same
	// microsecond by different goroutines in Xray can be logged either
	// way round, so neither bound assumes it.
	if e.At.Before(t.first) {
		t.first = e.At
	}
	if e.At.After(t.last) {
		t.last = e.At
	}
}

// Len is the number of distinct destinations held.
func (a *Aggregator) Len() int { return len(a.counts) }

// Take returns everything counted since the last Take and starts the next
// window empty. The destinations are sorted so that a batch split across
// several messages keeps each user's rows together, and so tests can
// compare them.
func (a *Aggregator) Take() (dests []Destination, dropped uint64) {
	dests = make([]Destination, 0, len(a.counts))
	for k, t := range a.counts {
		dests = append(dests, Destination{
			User:       k.user,
			InboundTag: k.tag,
			Network:    k.network,
			Host:       k.host,
			Port:       k.port,
			Count:      t.count,
			FirstSeen:  t.first,
			LastSeen:   t.last,
		})
	}
	sort.Slice(dests, func(i, j int) bool {
		x, y := dests[i], dests[j]
		if x.User != y.User {
			return x.User < y.User
		}
		if x.Host != y.Host {
			return x.Host < y.Host
		}
		if x.Port != y.Port {
			return x.Port < y.Port
		}
		if x.Network != y.Network {
			return x.Network < y.Network
		}
		return x.InboundTag < y.InboundTag
	})
	dropped = a.dropped
	a.counts = make(map[destKey]*tally)
	a.perUser = make(map[string]int)
	a.dropped = 0
	return dests, dropped
}
