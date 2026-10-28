package xray

import (
	"bufio"
	"fmt"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/neoxify/neoxify-hub/agent/internal/protocols/common"
)

// Xray offers no way to ask how many connections a user currently has --
// its stats API reports bytes, not sessions, and its handler API can add
// and remove users but not enumerate their connections. The access log
// is the only place that information exists, which is why this reads it
// rather than calling an API.
//
// VLESS needs this most: the same UUID can be connected from any number
// of places at once. (OpenVPN and WireGuard limit devices that share one
// certificate or key, but with per-device credentials devices no longer
// share one.)
//
// Every Xray inbound on a node has its own counter over this same log,
// and record() does not filter by inbound tag, so each user is reported
// once per inbound. The backend takes the max per user rather than the
// sum (ConcurrencyService). Counting once per Xray process instead is an
// agent change that has not been made.

// A line looks like:
//
//	2026/10/28 08:20:17.560474 from tcp:203.0.113.9:51234 accepted tcp:1.1.1.1:443 [vless-in >> direct] email: <externalUserId>
//	2026/10/28 08:21:40.118210 from 203.0.113.9:4411 accepted 198.51.100.63:443 [shadowsocks-in >> direct] email: <externalUserId>
//
// The source address and the email tag are the only parts that matter.
// Matched with a regexp rather than split on spaces because the tail of
// the line varies with routing decisions.
//
// The fraction of a second and the bare source address are both what the
// live nodes write, and this used to match neither: it wanted the time
// to end at the seconds and a "tcp:" before every source. Every line on
// every node failed it, so no Xray user ever had a device count, and the
// device-limit backstop (CONCURRENCY_CUT=enforce) had nothing to act on
// for any Xray protocol. Found on 2026-10-28 by reading a node's log; the
// owner chose to fix it knowing it starts the backstop for real.
var accessLineRe = regexp.MustCompile(`^(\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2})(?:\.\d+)? from (?:(?:tcp|udp):)?(\[[0-9a-fA-F:.]+\]|[0-9a-fA-F.:]+?):\d+ .*email: (\S+)`)

const accessTimeLayout = "2006/01/02 15:04:05"

// SessionCounter reports, per user, how many distinct client addresses
// have appeared in the access log recently.
//
// Distinct addresses rather than raw connection count: a single browser
// opens many parallel connections, so counting those would flag every
// normal user instantly. Two addresses means two places, which is the
// thing worth noticing.
type SessionCounter struct {
	path   string
	window time.Duration

	mu     sync.Mutex
	offset int64
	// user -> source address -> when it was last seen
	seen map[string]map[string]time.Time
}

func NewSessionCounter(path string, window time.Duration) *SessionCounter {
	return &SessionCounter{
		path:   path,
		window: window,
		seen:   make(map[string]map[string]time.Time),
	}
}

// Sessions reads whatever has been appended since the last call and
// returns, per user, the number of distinct recent sources and the
// sources themselves.
//
// Reading incrementally matters: an access log on a busy node grows
// quickly, and re-reading it every 30 seconds would be the most expensive
// thing the agent does. It is also why the count and the addresses come
// out of one call: the log is consumed as it is read, so a second reader
// would find nothing left.
func (c *SessionCounter) Sessions() (map[string]common.SessionReport, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.path == "" {
		return nil, nil
	}

	f, err := os.Open(c.path)
	if err != nil {
		if os.IsNotExist(err) {
			// Access logging not enabled on this node, or Xray hasn't
			// written anything yet. Reporting nothing is correct; the
			// server treats absent counts as "unknown", not "zero".
			return nil, nil
		}
		return nil, fmt.Errorf("open xray access log: %w", err)
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return nil, fmt.Errorf("stat xray access log: %w", err)
	}
	// Rotation or truncation leaves the saved offset past the end of a
	// now-shorter file; start over rather than seeking beyond EOF and
	// reading nothing forever.
	if info.Size() < c.offset {
		c.offset = 0
	}
	if _, err := f.Seek(c.offset, 0); err != nil {
		return nil, fmt.Errorf("seek xray access log: %w", err)
	}

	scanner := bufio.NewScanner(f)
	// Access lines are short; the default limit is ample, but a corrupt
	// or binary file shouldn't be able to allocate without bound.
	scanner.Buffer(make([]byte, 0, 64*1024), 256*1024)
	for scanner.Scan() {
		c.record(scanner.Text())
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read xray access log: %w", err)
	}

	if pos, err := f.Seek(0, 1); err == nil {
		c.offset = pos
	}

	return c.tally(), nil
}

func (c *SessionCounter) record(line string) {
	m := accessLineRe.FindStringSubmatch(line)
	if m == nil {
		return
	}
	ts, err := time.ParseInLocation(accessTimeLayout, m[1], time.Local)
	if err != nil {
		return
	}
	source, user := m[2], strings.TrimSpace(m[3])
	if user == "" {
		return
	}

	if c.seen[user] == nil {
		c.seen[user] = make(map[string]time.Time)
	}
	c.seen[user][source] = ts
}

// tally drops anything older than the window and counts what's left,
// so a user who moved networks an hour ago isn't still counted at both.
//
// The count is the number of raw source strings left, exactly as before
// the addresses were reported; the address list is built beside it from
// the same survivors and changes nothing about it.
func (c *SessionCounter) tally() map[string]common.SessionReport {
	now := time.Now()
	cutoff := now.Add(-c.window)
	reports := make(map[string]common.SessionReport, len(c.seen))

	for user, sources := range c.seen {
		for addr, at := range sources {
			if at.Before(cutoff) {
				delete(sources, addr)
			}
		}
		if len(sources) == 0 {
			delete(c.seen, user)
			continue
		}
		// The log's own timestamp, so an address that went quiet forty
		// seconds ago says so rather than claiming to be connected now.
		sightings := make([]common.SourceAddress, 0, len(sources))
		for addr, at := range sources {
			sightings = append(sightings, common.SourceAddress{Address: addr, SecondsAgo: common.Ago(now.Sub(at))})
		}
		reports[user] = common.SessionReport{
			Count:   len(sources),
			Sources: common.RecentSources(sightings),
		}
	}
	return reports
}
