package xray

import (
	"bufio"
	"fmt"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Xray offers no way to ask how many connections a user currently has --
// its stats API reports bytes, not sessions, and its handler API can add
// and remove users but not enumerate their connections. The access log
// is the only place that information exists, which is why this reads it
// rather than calling an API.
//
// Only Xray needs this. OpenVPN replaces an existing session when the
// same certificate reconnects, and a WireGuard peer holds one endpoint at
// a time, so neither gives a shared credential real concurrency. VLESS
// does: the same UUID can be connected from any number of places at once.

// A line looks like:
//
//	2026/07/25 10:13:18 from tcp:203.0.113.9:51234 accepted tcp:1.1.1.1:443 [vless-in >> direct] email: <externalUserId>
//
// The source address and the email tag are the only parts that matter.
// Matched with a regexp rather than split on spaces because the tail of
// the line varies with routing decisions.
var accessLineRe = regexp.MustCompile(`^(\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}) from \S+?:([0-9a-fA-F.:\[\]]+):\d+ .*email: (\S+)`)

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

// Counts reads whatever has been appended since the last call and returns
// the number of distinct recent sources per user.
//
// Reading incrementally matters: an access log on a busy node grows
// quickly, and re-reading it every 30 seconds would be the most expensive
// thing the agent does.
func (c *SessionCounter) Counts() (map[string]int, error) {
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
func (c *SessionCounter) tally() map[string]int {
	cutoff := time.Now().Add(-c.window)
	counts := make(map[string]int, len(c.seen))

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
		counts[user] = len(sources)
	}
	return counts
}
