// Package realityprobe watches whether this node can still reach the
// camouflage destination its REALITY inbound forwards handshakes to.
//
// Why this exists, and why it runs on the node: REALITY forwards every
// client handshake to its `dest`. A dest the node cannot complete TLS
// with produces a node that accepts connections and serves nothing --
// the TCP handshake succeeds because Xray accepts it, and everything
// above it dies waiting on a forward that never returns. finland1 sat
// like that with the panel reporting it ONLINE, because nothing measured
// the one thing that had broken.
//
// Reachability belongs to the node-dest PAIR, not to the dest:
// www.shatel.ir was dead from Finland and fine from Germany on the same
// afternoon. So the panel cannot answer this question and the node must.
package realityprobe

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"log"
	"net"
	"os"
	"strings"
	"sync"
	"time"
)

// DialTimeout bounds one probe. Generous rather than tight: a slow dest
// is not a broken one, and a false "unreachable" would be worse than a
// late answer -- it is the input to an alert.
const DialTimeout = 15 * time.Second

// Result is the last thing the probe learned. Dest is empty when the
// node has no REALITY inbound or its config could not be read, and
// Reachable must never be read without checking Dest first: empty means
// "did not measure", not "unreachable".
type Result struct {
	Dest      string
	Reachable bool
}

type Prober struct {
	configPath string
	interval   time.Duration

	mu   sync.RWMutex
	last Result
}

func New(configPath string, interval time.Duration) *Prober {
	return &Prober{configPath: configPath, interval: interval}
}

// Snapshot is what the heartbeat reports. Cheap and lock-guarded: the
// heartbeat runs every 20s and the probe every few minutes, so the two
// are deliberately decoupled -- a heartbeat must never block on a dial.
func (p *Prober) Snapshot() Result {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.last
}

// Run probes once immediately, then on the interval, until ctx is done.
func (p *Prober) Run(ctx context.Context) {
	p.probeOnce(ctx)

	ticker := time.NewTicker(p.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			p.probeOnce(ctx)
		}
	}
}

func (p *Prober) probeOnce(ctx context.Context) {
	dest, err := DestFromXrayConfig(p.configPath)
	if err != nil || dest == "" {
		// No REALITY inbound, or no readable config. Report nothing
		// rather than guessing -- see the note on Result.Dest.
		p.store(Result{})
		return
	}

	reachable := Reachable(ctx, dest)
	prev := p.Snapshot()
	// Logged only on a change, because this runs forever and a node whose
	// dest is fine should be silent.
	if prev.Dest != dest || prev.Reachable != reachable {
		if reachable {
			log.Printf("reality dest %s is reachable", dest)
		} else {
			log.Printf("reality dest %s is NOT reachable from this node -- "+
				"clients will complete TCP and then hang", dest)
		}
	}
	p.store(Result{Dest: dest, Reachable: reachable})
}

func (p *Prober) store(r Result) {
	p.mu.Lock()
	p.last = r
	p.mu.Unlock()
}

// DestFromXrayConfig reads the camouflage destination out of the node's
// own Xray config. Exported so the probe can be pointed at a fixture.
func DestFromXrayConfig(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	var cfg struct {
		Inbounds []struct {
			StreamSettings struct {
				Security        string `json:"security"`
				RealitySettings struct {
					Dest string `json:"dest"`
				} `json:"realitySettings"`
			} `json:"streamSettings"`
		} `json:"inbounds"`
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return "", err
	}
	for _, in := range cfg.Inbounds {
		if in.StreamSettings.Security == "reality" && in.StreamSettings.RealitySettings.Dest != "" {
			return in.StreamSettings.RealitySettings.Dest, nil
		}
	}
	return "", nil
}

// Reachable answers whether this host can complete a TLS 1.3 handshake
// with dest, presenting a certificate valid for its name.
//
// The certificate IS verified rather than skipped, and the version IS
// pinned to 1.3, because that is what REALITY needs of a dest -- a host
// that answers TCP but cannot serve a modern, valid handshake is exactly
// the failure this package exists to catch, and skipping verification
// would call it healthy.
func Reachable(ctx context.Context, dest string) bool {
	host := dest
	if h, _, err := net.SplitHostPort(dest); err == nil {
		host = h
	} else {
		dest = net.JoinHostPort(dest, "443")
	}

	ctx, cancel := context.WithTimeout(ctx, DialTimeout)
	defer cancel()

	d := &tls.Dialer{Config: &tls.Config{
		ServerName: host,
		MinVersion: tls.VersionTLS13,
	}}
	conn, err := d.DialContext(ctx, "tcp", dest)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// HostOf is the dest without its port, for logging and comparison.
func HostOf(dest string) string {
	if h, _, err := net.SplitHostPort(dest); err == nil {
		return h
	}
	return strings.TrimSuffix(dest, ":")
}
