//go:build darwin

package neoxifyxray

// The engine's memory under a phone's load, and the budget it must stay
// in. Built after an iPhone's packet tunnel died 30 s into a Stealth
// session at 49.2 MiB (2026-11-17), against about 16 MiB in the field on
// 0.2.41.
//
// The load (appOpenLoad) is a phone opening apps right after connecting:
// about 20 new names a second, each as three lookups -- A, AAAA, HTTPS --
// from fresh UDP source ports to the tunnel's resolver address, as iOS
// sends them; about 10 QUIC packets a second to fresh destinations on
// UDP/443; 8 downloads and 4 uploads throughout.
//
// TestEngineAppOpenLoad compares the 0.2.41 config shapes
// (testdata/app-configs-0.2.41.json) with the current ones. Its lookups are
// real with NEOXIFY_LOAD_REAL_DNS=1 (the server sends traffic for the two
// public resolvers out; the names are wildcard names that resolve, each
// one new); otherwise, and always in the budget test, they are answered by
// a local resolver (hermeticDNS), with the public resolvers' DoH port
// refused, so every lookup takes the slower TCP fallback -- the harder
// case for memory, and one that needs no network.
//
//   NEOXIFY_ENGINE_LOAD=1 go test -run TestEngineAppOpenLoad -v -timeout 30m
//   NEOXIFY_ENGINE_BUDGET=1 ../../../scripts/xray-core-patch.sh go test -run TestEngineMemoryBudget -v
//
// A Mac process, not an iPhone's packet tunnel: the same Go engine and
// accounting as TestEngineMemory (phys_footprint, as iOS counts it), not
// the same kernel, allocator pressure or memory limit.

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	mrand "math/rand/v2"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/adapters/gonet"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv4"
)

// EngineFootprintBudget is the most the engine may hold -- peak
// phys_footprint, as iOS counts it -- under any load in
// TestEngineMemoryBudget, with any config the app builds.
//
// Where it comes from: the iOS packet-tunnel extension is killed at about
// 50 MiB (an iPhone died at a 49.2 MiB peak on 2026-11-17), and the engine
// asks the Go runtime to stay under 30 MiB (memory_darwin.go,
// SetMemoryLimit), a soft limit its footprint overshoots: goroutine stacks
// and memory the runtime has not yet given back count too. Measured on the
// Mac with the iOS patches, 2026-11-17, three runs: the heaviest case,
// the app-open load on Shadowsocks with the DoH resolver unreachable (every
// lookup falling back to TCP), peaked at 41.8-42.9 MiB; VLESS over
// WebSocket 38.4-39.4, Trojan 36.4-37.0, the Vision transports 30.6-34.2,
// stalled uploads and slow readers 16-24. Before the flows were bounded the
// same load reached 107-175 MiB. 46 MiB is 3 MiB over the worst run seen
// (the spread between runs was about 1 MiB) and 4 MiB under the kill: a
// regression of a few MiB fails here, before a phone finds it.
const EngineFootprintBudget = 46 << 20

// The resolver the tunnel advertises (TUN_DNS in xray-config.ts).
var tunDNS = tcpip.AddrFrom4([4]byte{1, 1, 1, 1})

// hermeticDNS, when set before startServerEnv, has the server answer the
// public resolvers' port 53 from a local resolver and refuse their DoH
// port, instead of sending either out.
var hermeticDNS bool

type loadSpec struct {
	lookups, quic       bool
	downloads, uploads  int
	slowRead, slowWrite int // bytes a second; 0: as fast as they go
}

var appOpen = loadSpec{lookups: true, quic: true, downloads: 8, uploads: 4}

func TestEngineAppOpenLoad(t *testing.T) {
	e2eEnabled(t, "NEOXIFY_ENGINE_LOAD")
	hermeticDNS = os.Getenv("NEOXIFY_LOAD_REAL_DNS") != "1"
	env := startServerEnv(t)
	window := 60 * time.Second
	if d, err := time.ParseDuration(os.Getenv("NEOXIFY_LOAD_WINDOW")); err == nil {
		window = d
	}
	transports := []string{"reality", "shadowsocks"}
	if v := os.Getenv("NEOXIFY_MEM_TRANSPORTS"); v != "" {
		transports = strings.Split(v, ",")
	}
	fixtures := []struct{ name, file string }{
		{"0.2.41", "testdata/app-configs-0.2.41.json"},
		{"current", "testdata/app-configs.json"},
	}
	profiles := os.Getenv("NEOXIFY_LOAD_PPROF")
	only := os.Getenv("NEOXIFY_LOAD_FIXTURES")
	for _, fx := range fixtures {
		if only != "" && !strings.Contains(","+only+",", ","+fx.name+",") {
			continue
		}
		for _, transport := range transports {
			t.Run(fx.name+"/"+transport, func(t *testing.T) {
				if profiles != "" {
					t.Setenv("NEOXIFY_ENGINE_PPROF", filepath.Join(profiles, fx.name+"-"+transport+".pprof"))
				}
				r := measureLoad(t, env, appConfigFrom(t, env.keys, transport, fx.file), appOpen, window)
				t.Logf("RESULT %-8s %-12s %s", fx.name, transport, r)
			})
		}
	}
}

// TestEngineMemoryBudget fails when the engine's peak footprint passes
// EngineFootprintBudget under the app-open load, a stalled uplink or slow
// readers, for every config in testdata/app-configs.json -- the file the
// app's own builder writes (xray-config.test.ts), so a config change is
// covered here without anyone adding it. Run with the iOS patches, as CI
// does. Fixed windows, no network.
func TestEngineMemoryBudget(t *testing.T) {
	e2eEnabled(t, "NEOXIFY_ENGINE_BUDGET")
	hermeticDNS = true
	env := startServerEnv(t)
	data, err := os.ReadFile("testdata/app-configs.json")
	if err != nil {
		t.Fatal(err)
	}
	var all map[string]json.RawMessage
	if err := json.Unmarshal(data, &all); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name   string
		spec   loadSpec
		window time.Duration
	}{
		{"app-open", appOpen, 25 * time.Second},
		{"upload8-stalled", loadSpec{uploads: 8, slowWrite: 256 << 10}, 10 * time.Second},
		{"download8-slowread", loadSpec{downloads: 8, slowRead: 256 << 10}, 10 * time.Second},
	}
	for _, transport := range e2eTransports {
		if _, ok := all[transport]; !ok {
			t.Fatalf("the fixture has no %s config", transport)
		}
	}
	for transport := range all {
		found := false
		for _, known := range e2eTransports {
			found = found || known == transport
		}
		if !found {
			t.Fatalf("the fixture has a config this test cannot run: %s -- add it to e2eTransports", transport)
		}
	}
	for _, transport := range e2eTransports {
		for _, c := range cases {
			t.Run(transport+"/"+c.name, func(t *testing.T) {
				r := measureLoad(t, env, appConfig(t, env.keys, transport), c.spec, c.window)
				t.Logf("RESULT %-14s %-20s %s", transport, c.name, r)
				if r.footprintPeak > EngineFootprintBudget {
					t.Errorf("footprint peak %.1f MiB is over the %.0f MiB budget (EngineFootprintBudget)",
						float64(r.footprintPeak)/(1<<20), float64(EngineFootprintBudget)/(1<<20))
				}
			})
		}
	}
}

type loadResult struct {
	footprintPeak, footprintEnd, heapPeak, heapEnd int64
	goroutinesPeak, goroutinesEnd                  int64
	note                                           string
}

func (r loadResult) String() string {
	mib := func(v int64) float64 { return float64(v) / (1 << 20) }
	return fmt.Sprintf("footprint peak %5.1f MiB end %5.1f  heap peak %5.1f MiB end %5.1f  goroutines peak %5d end %5d  %s",
		mib(r.footprintPeak), mib(r.footprintEnd), mib(r.heapPeak), mib(r.heapEnd), r.goroutinesPeak, r.goroutinesEnd, r.note)
}

func measureLoad(t *testing.T, env *e2eEnv, config string, spec loadSpec, window time.Duration) loadResult {
	t.Helper()
	e := startEngine(t, config)
	time.Sleep(time.Second)
	from := time.Now().UnixMilli()
	note := runLoad(e, spec, window)
	endAt := time.Now().UnixMilli()
	time.Sleep(time.Second)
	if !e.alive() {
		t.Fatalf("engine died: %v\n%s", e.exitErr, tail(e.out(), 30))
	}
	r := loadResult{note: note}
	var last sample
	for _, s := range e.samplesSince(from) {
		r.footprintPeak = max(r.footprintPeak, s.footprint)
		r.heapPeak = max(r.heapPeak, s.heap)
		r.goroutinesPeak = max(r.goroutinesPeak, s.goroutines)
		if s.ms <= endAt {
			last = s
		}
	}
	r.footprintEnd, r.heapEnd, r.goroutinesEnd = last.footprint, last.heap, last.goroutines
	return r
}

func runLoad(e *engine, spec loadSpec, window time.Duration) string {
	deadline := time.Now().Add(window)
	var wg sync.WaitGroup
	var asked, answered, slow atomic.Int64
	var lost [3]atomic.Int64 // A, AAAA, HTTPS
	var down, up atomic.Int64

	for i := 0; i < spec.downloads; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, err := e.dial(80)
			if err != nil {
				return
			}
			defer c.Close()
			req := make([]byte, 9)
			req[0] = 'D'
			binary.BigEndian.PutUint64(req[1:], 1<<40)
			_, _ = c.Write(req)
			buf := make([]byte, 64<<10)
			if spec.slowRead > 0 {
				buf = buf[:16<<10]
			}
			start := time.Now()
			var total int64
			for time.Now().Before(deadline) {
				_ = c.SetReadDeadline(deadline)
				k, err := c.Read(buf)
				total += int64(k)
				down.Add(int64(k))
				if err != nil {
					return
				}
				if spec.slowRead > 0 {
					time.Sleep(time.Until(start.Add(time.Duration(float64(total) / float64(spec.slowRead) * float64(time.Second)))))
				}
			}
		}()
	}
	for i := 0; i < spec.uploads; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, err := e.dial(80)
			if err != nil {
				return
			}
			defer c.Close()
			req := make([]byte, 13)
			req[0] = 'U'
			binary.BigEndian.PutUint32(req[1:], uint32(spec.slowWrite))
			binary.BigEndian.PutUint64(req[5:], 1<<40)
			if firstWrite(c, req) != nil {
				return
			}
			buf := make([]byte, 64<<10)
			for time.Now().Before(deadline) {
				_ = c.SetWriteDeadline(deadline)
				k, err := c.Write(buf)
				up.Add(int64(k))
				if err != nil {
					return
				}
			}
		}()
	}

	if spec.lookups {
		// 20 names a second, three lookups each from fresh source ports.
		wg.Add(1)
		go func() {
			defer wg.Done()
			tick := time.NewTicker(50 * time.Millisecond)
			defer tick.Stop()
			run := mrand.Uint32()
			n := 0
			for now := range tick.C {
				if now.After(deadline) {
					return
				}
				n++
				name := fmt.Sprintf("n%d-%d.10.%d.%d.%d.nip.io.", run, n, n>>16&255, n>>8&255, n&255)
				for qi, qt := range []dnsmessage.Type{dnsmessage.TypeA, dnsmessage.TypeAAAA, dnsmessage.Type(65)} {
					wg.Add(1)
					go func() {
						defer wg.Done()
						asked.Add(1)
						start := time.Now()
						if lookup(e, name, qt) {
							answered.Add(1)
							if time.Since(start) > time.Second {
								slow.Add(1)
							}
						} else {
							lost[qi].Add(1)
						}
					}()
				}
			}
		}()
	}

	if spec.quic {
		// 10 QUIC packets a second to fresh destinations.
		wg.Add(1)
		go func() {
			defer wg.Done()
			tick := time.NewTicker(100 * time.Millisecond)
			defer tick.Stop()
			payload := make([]byte, 1200)
			n := 0
			for now := range tick.C {
				if now.After(deadline) {
					return
				}
				n++
				dst := tcpip.AddrFrom4([4]byte{198, 19, byte(n >> 8), byte(n)})
				uc, err := gonet.DialUDP(e.stack, nil, &tcpip.FullAddress{NIC: 1, Addr: dst, Port: 443}, ipv4.ProtocolNumber)
				if err != nil {
					continue
				}
				_, _ = uc.Write(payload)
				// Held as an app holds a QUIC attempt before giving up on it.
				go func() { time.Sleep(3 * time.Second); uc.Close() }()
			}
		}()
	}

	wg.Wait()
	secs := window.Seconds()
	note := fmt.Sprintf("down %.0f Mbit/s up %.0f Mbit/s", float64(down.Load())*8/1e6/secs, float64(up.Load())*8/1e6/secs)
	if spec.lookups {
		note = fmt.Sprintf("lookups %d/%d answered (%d over 1 s; unanswered A %d AAAA %d HTTPS %d); ",
			answered.Load(), asked.Load(), slow.Load(), lost[0].Load(), lost[1].Load(), lost[2].Load()) + note
	}
	return note
}

// lookup sends one question from a fresh source port and waits up to 5 s
// for an answer to it, as the phone's resolver does.
func lookup(e *engine, name string, qt dnsmessage.Type) bool {
	uc, err := gonet.DialUDP(e.stack, nil, &tcpip.FullAddress{NIC: 1, Addr: tunDNS, Port: 53}, ipv4.ProtocolNumber)
	if err != nil {
		return false
	}
	defer uc.Close()
	id := uint16(mrand.Uint32())
	msg := dnsmessage.Message{
		Header:    dnsmessage.Header{ID: id, RecursionDesired: true},
		Questions: []dnsmessage.Question{{Name: dnsmessage.MustNewName(name), Type: qt, Class: dnsmessage.ClassINET}},
	}
	b, err := msg.Pack()
	if err != nil {
		return false
	}
	_ = uc.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := uc.Write(b); err != nil {
		return false
	}
	reply := make([]byte, 1500)
	for {
		k, err := uc.Read(reply)
		if err != nil {
			return false
		}
		var p dnsmessage.Parser
		h, err := p.Start(reply[:k])
		if err == nil && h.ID == id && h.Response {
			return true
		}
	}
}

// startFakeResolver answers every A question with 10.0.0.1 and anything
// else with an empty answer, over UDP and TCP on one port.
func startFakeResolver(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	pc, err := net.ListenPacket("udp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close(); pc.Close() })
	go func() {
		buf := make([]byte, 1500)
		for {
			n, addr, err := pc.ReadFrom(buf)
			if err != nil {
				return
			}
			if out := fakeAnswer(buf[:n]); out != nil {
				_, _ = pc.WriteTo(out, addr)
			}
		}
	}()
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				for {
					var size [2]byte
					if _, err := io.ReadFull(c, size[:]); err != nil {
						return
					}
					q := make([]byte, binary.BigEndian.Uint16(size[:]))
					if _, err := io.ReadFull(c, q); err != nil {
						return
					}
					out := fakeAnswer(q)
					if out == nil {
						return
					}
					framed := binary.BigEndian.AppendUint16(nil, uint16(len(out)))
					if _, err := c.Write(append(framed, out...)); err != nil {
						return
					}
				}
			}()
		}
	}()
	return port
}

func fakeAnswer(q []byte) []byte {
	var p dnsmessage.Parser
	h, err := p.Start(q)
	if err != nil {
		return nil
	}
	question, err := p.Question()
	if err != nil {
		return nil
	}
	b := dnsmessage.NewBuilder(nil, dnsmessage.Header{ID: h.ID, Response: true, RecursionDesired: h.RecursionDesired, RecursionAvailable: true})
	_ = b.StartQuestions()
	_ = b.Question(question)
	_ = b.StartAnswers()
	if question.Type == dnsmessage.TypeA {
		_ = b.AResource(dnsmessage.ResourceHeader{Name: question.Name, Class: dnsmessage.ClassINET, TTL: 300}, dnsmessage.AResource{A: [4]byte{10, 0, 0, 1}})
	}
	out, err := b.Finish()
	if err != nil {
		return nil
	}
	return out
}
