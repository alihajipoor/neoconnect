package neoxifyxray

// Why the tunnel last ended, kept where the app can read it.
//
// The iPhone's packet tunnel can end three ways, and before this only one
// of them left a trace. A stop the system asks for runs stopTunnel, which
// records the reason. A Go panic in the engine (xray-core's TUN inbound
// had one until v26.6.27) and a memory kill by iOS (the extension's
// ceiling is about 50 MB) both end the process with no stopTunnel at all,
// so the app saw only "the tunnel dropped" and nobody could tell which.
//
// So the extension now keeps, in the app group container's diagnostics
// folder:
//
//   - engine-fatal.log: the Go runtime's fatal output for this run (an
//     unrecovered panic or a fatal error), through debug.SetCrashOutput.
//     Only crash output reaches it, so it stays the size of one trace;
//     the previous run's is kept as engine-fatal.prev.log, cut to its
//     last 64 KiB.
//   - engine-heartbeat.json: every few seconds, the process footprint
//     and the kernel's peak of it, what iOS says is left, the Go heap,
//     the goroutine count and the engine version. The last one written
//     before a memory kill is the evidence of it.
//   - tunnel-run.json: this run's start, and the stop reason once
//     stopTunnel gives one.
//
// At the next start, before any of that is replaced, BeginRun turns the
// previous run's files into tunnel-last-end.json for the app: how the run
// ended (a stop reason, or none), its last heartbeat, and the end of any
// fatal output with every address, host name and identifier removed. That
// file is what the app reads; the others are the extension's.
//
// None of this may fail a connect: every error here is swallowed.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"runtime/debug"
	"runtime/metrics"
	"strings"
	"sync"
	"time"

	core "github.com/xtls/xray-core/core"
)

const (
	fatalFile     = "engine-fatal.log"
	fatalPrevFile = "engine-fatal.prev.log"
	heartbeatFile = "engine-heartbeat.json"
	runFile       = "tunnel-run.json"
	lastEndFile   = "tunnel-last-end.json"

	// Kept of a previous run's fatal output.
	fatalKeepBytes = 64 << 10
	// What the app is given of it: enough for the panic line and the
	// panicking goroutine's frames, not a whole dump.
	fatalTailLines = 40
	fatalLineMax   = 300

	heartbeatEvery = 5 * time.Second
)

// Set by the darwin build, where the WireGuard engine exists.
var wireGuardRunningHook = func() bool { return false }

// Heartbeat is engine-heartbeat.json, and lastHeartbeat in the app's file.
type Heartbeat struct {
	// Unix seconds when written.
	Time int64 `json:"t"`
	// Seconds since BeginRun.
	Uptime int64 `json:"uptimeS"`
	// phys_footprint in bytes: the figure iOS kills the extension on.
	Footprint int64 `json:"footprint"`
	// The kernel's high-water mark of it for this process, bytes.
	FootprintPeak int64 `json:"footprintPeak"`
	// iOS's os_proc_available_memory: bytes left before the kill. -1
	// where unknown (macOS).
	Available int64 `json:"available"`
	// Live Go heap objects, bytes.
	Heap       int64 `json:"heap"`
	Goroutines int   `json:"goroutines"`
	// "xray", "wireguard" or "none": which engine was running.
	Engine string `json:"engine"`
	// xray-core's version, and whether the build carries the iOS TCP
	// buffer patch (scripts/xray-core-patch.sh).
	Core        string `json:"core"`
	CorePatched bool   `json:"corePatched"`
}

// runRecord is tunnel-run.json.
type runRecord struct {
	StartedAt  int64  `json:"startedAt"`
	StopReason *int   `json:"stopReason,omitempty"`
	StoppedAt  *int64 `json:"stoppedAt,omitempty"`
}

// LastEnd is tunnel-last-end.json, the file the app reads.
type LastEnd struct {
	Version int `json:"version"`
	// Unix seconds: when this record was made (the next run's start).
	RecordedAt int64 `json:"recordedAt"`
	// When the run it describes began, unix seconds. The app's key for
	// "already reported".
	RunStartedAt int64 `json:"runStartedAt"`
	// "stopped": stopTunnel ran, and stopReason says why. "withoutStop":
	// the process ended with no stopTunnel -- a crash or a kill by iOS.
	Ended string `json:"ended"`
	// NEProviderStopReason's raw value, or -1 for a start that failed;
	// null when there was no stop.
	StopReason     *int    `json:"stopReason"`
	StopReasonName *string `json:"stopReasonName"`
	StoppedAt      *int64  `json:"stoppedAt"`
	// The last heartbeat written in that run, or null.
	LastHeartbeat *Heartbeat `json:"lastHeartbeat"`
	// The first "panic:" or "fatal error:" line of its fatal output,
	// cleaned; "" when there was none.
	FatalSummary string `json:"fatalSummary"`
	// The last lines of that output, cleaned. Empty when none.
	FatalTail []string `json:"fatalTail"`
}

var (
	diagMu       sync.Mutex
	diagDir      string
	diagStarted  time.Time
	diagFatal    *os.File
	heartbeatOne sync.Once
)

// BeginRun starts this run's record in dir and returns the previous run's
// end, as written to tunnel-last-end.json ("" when there was no previous
// run, or nothing could be read). Call it first thing in startTunnel,
// before the engine starts. Safe to call again in the same process.
func BeginRun(dir string) string {
	if dir == "" {
		return ""
	}
	_ = os.MkdirAll(dir, 0o700)

	now := time.Now()
	previous := ""
	if end, ok := previousEnd(dir, now); ok {
		if data, err := json.Marshal(end); err == nil {
			_ = writeAtomically(filepath.Join(dir, lastEndFile), data)
			previous = string(data)
		}
	}

	diagMu.Lock()
	diagDir = dir
	diagStarted = now
	rotateFatal(dir)
	diagMu.Unlock()

	if data, err := json.Marshal(runRecord{StartedAt: now.Unix()}); err == nil {
		_ = writeAtomically(filepath.Join(dir, runFile), data)
	}
	// A heartbeat at once, so even a run that dies in its first seconds
	// leaves one.
	writeHeartbeat()
	heartbeatOne.Do(func() {
		go func() {
			tick := time.NewTicker(heartbeatEvery)
			defer tick.Stop()
			for range tick.C {
				writeHeartbeat()
			}
		}()
	})
	return previous
}

// EndRun records why this run stopped: NEProviderStopReason's raw value
// from stopTunnel, or -1 for a start that failed. Without it the next
// BeginRun reports the run as ended without a stop.
func EndRun(dir string, reason int) {
	if dir == "" {
		return
	}
	path := filepath.Join(dir, runFile)
	var rec runRecord
	if data, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(data, &rec)
	}
	stopped := time.Now().Unix()
	rec.StopReason = &reason
	rec.StoppedAt = &stopped
	if data, err := json.Marshal(rec); err == nil {
		_ = writeAtomically(path, data)
	}
	writeHeartbeat()
}

// previousEnd reads what the last run left. ok is false when there was no
// previous run.
func previousEnd(dir string, now time.Time) (LastEnd, bool) {
	data, err := os.ReadFile(filepath.Join(dir, runFile))
	if err != nil {
		return LastEnd{}, false
	}
	var rec runRecord
	if json.Unmarshal(data, &rec) != nil || rec.StartedAt == 0 {
		return LastEnd{}, false
	}
	end := LastEnd{
		Version:      1,
		RecordedAt:   now.Unix(),
		RunStartedAt: rec.StartedAt,
		Ended:        "withoutStop",
		FatalTail:    []string{},
	}
	if rec.StopReason != nil {
		end.Ended = "stopped"
		end.StopReason = rec.StopReason
		name := stopReasonName(*rec.StopReason)
		end.StopReasonName = &name
		end.StoppedAt = rec.StoppedAt
	}
	if hb, err := os.ReadFile(filepath.Join(dir, heartbeatFile)); err == nil {
		var h Heartbeat
		if json.Unmarshal(hb, &h) == nil && h.Time >= rec.StartedAt {
			end.LastHeartbeat = &h
		}
	}
	if raw, err := readTail(filepath.Join(dir, fatalFile), fatalKeepBytes); err == nil {
		end.FatalSummary, end.FatalTail = summarizeFatal(raw)
	}
	return end, true
}

// stopReasonName is NEProviderStopReason's case name for its raw value,
// as Apple's headers number them.
func stopReasonName(reason int) string {
	names := []string{
		"none", "userInitiated", "providerFailed", "noNetworkAvailable",
		"unrecoverableNetworkChange", "providerDisabled", "authenticationCanceled",
		"configurationFailed", "idleTimeout", "configurationDisabled",
		"configurationRemoved", "superceded", "userLogout", "userSwitch",
		"connectionFailed", "sleep", "appUpdate", "internalError",
	}
	if reason == -1 {
		return "startFailed"
	}
	if reason >= 0 && reason < len(names) {
		return names[reason]
	}
	return "unknown"
}

// rotateFatal keeps the last run's fatal output, capped, as the previous
// one, and points the runtime's crash output at a fresh file. Called with
// diagMu held.
func rotateFatal(dir string) {
	current := filepath.Join(dir, fatalFile)
	if tail, err := readTail(current, fatalKeepBytes); err == nil && len(tail) > 0 {
		_ = writeAtomically(filepath.Join(dir, fatalPrevFile), tail)
	}
	f, err := os.OpenFile(current, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return
	}
	// The runtime duplicates the descriptor, so ours can be closed on the
	// next rotation without cutting it off.
	if err := debug.SetCrashOutput(f, debug.CrashOptions{}); err != nil {
		_ = f.Close()
		return
	}
	if diagFatal != nil {
		_ = diagFatal.Close()
	}
	diagFatal = f
}

func readTail(path string, max int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if size := info.Size(); size > max {
		if _, err := f.Seek(size-max, io.SeekStart); err != nil {
			return nil, err
		}
	}
	return io.ReadAll(io.LimitReader(f, max))
}

// summarizeFatal picks the panic line and the last lines of a fatal
// output, each cleaned of anything that identifies a person, a network or
// a server.
func summarizeFatal(raw []byte) (summary string, tail []string) {
	tail = []string{}
	var lines []string
	sc := bufio.NewScanner(bytes.NewReader(raw))
	sc.Buffer(make([]byte, 0, 4096), 1<<20)
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		lines = append(lines, line)
	}
	for _, line := range lines {
		if strings.HasPrefix(line, "panic:") || strings.HasPrefix(line, "fatal error:") {
			summary = cleanLine(line)
			break
		}
	}
	if len(lines) > fatalTailLines {
		lines = lines[len(lines)-fatalTailLines:]
	}
	for _, line := range lines {
		tail = append(tail, cleanLine(line))
	}
	return summary, tail
}

var (
	// Where a left boundary is needed it is a character that cannot be part
	// of the thing, kept by the replacement ("${1}"). \b is not used there:
	// it fails next to a letter or an underscore, and let
	// "dest_203.0.113.7" through whole. The app's cleaner
	// (run-diagnostics.ts) is the same.
	reUUID = regexp.MustCompile(`(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)
	// A URL's user part ("user:pass@"), before the e-mail pattern, which
	// would take only what follows its colon.
	reUserinfo = regexp.MustCompile(`[^\s/@]*:[^\s/@]*@`)
	reEmail    = regexp.MustCompile(`[\w.+-]+@[\w-]+(?:\.[\w-]+)+`)
	reIPv4     = regexp.MustCompile(`(^|[^\d.])\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?`)
	// What is left of an IPv6 address whose first group sat against a word
	// character, so that reIPv6 began after it.
	reIPv6Head = regexp.MustCompile(`(?i)[0-9a-f]{1,4}<ip>`)
	// 8 or more hex digits with nothing alphanumeric before them: a REALITY
	// short id (up to 16), part of a key or a token.
	reHexRun = regexp.MustCompile(`(^|[^0-9A-Za-z])[0-9a-fA-F]{8,}`)
	// Shorter key-like runs: 12 or more, with a letter and a digit.
	reMixed = regexp.MustCompile(`[A-Za-z0-9+/_=-]{12,}`)
	// Two colons or more between hex groups: an IPv6 address (and, as a
	// cost, a clock time). A Go frame's "file.go:123" has one.
	reIPv6 = regexp.MustCompile(`(?i)\[?\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}\b\]?(?::\d+)?|\[?::(?:[0-9a-f]{1,4}:?){0,7}\]?`)
	// A path to a source file: only its name is kept. Build paths name the
	// machine's user.
	rePath = regexp.MustCompile(`(?:[A-Za-z]:)?(?:[/\\][^\s/\\:()]+)+[/\\]([^\s/\\:()]+\.(?:go|s|c|h|m|swift))`)
	// Long runs of key-like characters: keys, tokens, short IDs, UUIDs
	// without dashes.
	reSecret = regexp.MustCompile(`[A-Za-z0-9+/_=-]{20,}`)
	reHex    = regexp.MustCompile(`\b0x[0-9a-fA-F]+\b`)
	// A host name: labels joined by dots ending in a letters-only label.
	reHost = regexp.MustCompile(`(?i)(^|[^a-z0-9.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b`)
	// A Go traceback line: a frame ("pkg.Func(args)", or "created by
	// pkg.Func in goroutine N") or its source line ("\tfile.go:123 +0x1c").
	reFrame = regexp.MustCompile(`^(?:created by \S+|\S+\(.*\))(?: in goroutine \d+)?$|^\t\S+\.(?:go|s|c):\d+`)
	// Module paths in frames: public code, kept, but their versions go.
	reModVer = regexp.MustCompile(`@v[0-9][^/\s]*`)
)

// cleanLine removes addresses, host names and identifiers from one line
// of fatal output. Traceback lines keep their package and function names,
// which are public code and the whole value of a trace; every other line
// (the panic message, anything an engine printed) loses anything that
// looks like a host name too.
func cleanLine(line string) string {
	frame := reFrame.MatchString(line)
	line = rePath.ReplaceAllString(line, "$1")
	line = reUserinfo.ReplaceAllString(line, "<id>@")
	line = reEmail.ReplaceAllString(line, "<id>")
	line = reUUID.ReplaceAllString(line, "<id>")
	line = reIPv4.ReplaceAllString(line, "${1}<ip>")
	line = reIPv6.ReplaceAllStringFunc(line, func(s string) string {
		// "file.go:123:" style and lone "::" in Go syntax are not
		// addresses; anything with a hex group on both sides of two colons
		// is treated as one.
		if strings.Count(s, ":") < 2 || strings.Trim(s, ":[] ") == "" {
			return s
		}
		return "<ip>"
	})
	line = reIPv6Head.ReplaceAllString(line, "<ip>")
	line = reHex.ReplaceAllString(line, "0x?")
	line = reHexRun.ReplaceAllString(line, "${1}<id>")
	if frame {
		line = reModVer.ReplaceAllString(line, "")
	} else {
		line = reHost.ReplaceAllString(line, "${1}<host>")
		line = reSecret.ReplaceAllString(line, "<id>")
		line = reMixed.ReplaceAllStringFunc(line, func(s string) string {
			if strings.ContainsAny(s, "0123456789") && strings.IndexFunc(s, func(r rune) bool { return (r|0x20) >= 'a' && (r|0x20) <= 'z' }) >= 0 {
				return "<id>"
			}
			return s
		})
	}
	if len(line) > fatalLineMax {
		line = line[:fatalLineMax]
	}
	return line
}

var heartbeatSamples = []metrics.Sample{
	{Name: "/memory/classes/heap/objects:bytes"},
	{Name: "/sched/goroutines:goroutines"},
}

// writeHeartbeat writes engine-heartbeat.json. Small and allocation-light:
// it runs every few seconds for the life of the extension.
func writeHeartbeat() {
	diagMu.Lock()
	dir, started := diagDir, diagStarted
	diagMu.Unlock()
	if dir == "" {
		return
	}
	data, err := json.Marshal(sampleHeartbeat(started))
	if err != nil {
		return
	}
	_ = writeAtomically(filepath.Join(dir, heartbeatFile), data)
}

var heartbeatMu sync.Mutex

func sampleHeartbeat(started time.Time) Heartbeat {
	heartbeatMu.Lock()
	metrics.Read(heartbeatSamples)
	heap := int64(-1)
	if heartbeatSamples[0].Value.Kind() == metrics.KindUint64 {
		heap = int64(heartbeatSamples[0].Value.Uint64())
	}
	goroutines := runtime.NumGoroutine()
	if heartbeatSamples[1].Value.Kind() == metrics.KindUint64 {
		goroutines = int(heartbeatSamples[1].Value.Uint64())
	}
	heartbeatMu.Unlock()

	now := time.Now()
	fp, peak := footprint()
	engine := "none"
	if Running() {
		engine = "xray"
	} else if wireGuardRunningHook() {
		engine = "wireguard"
	}
	return Heartbeat{
		Time:          now.Unix(),
		Uptime:        int64(now.Sub(started) / time.Second),
		Footprint:     fp,
		FootprintPeak: peak,
		Available:     availableMemory(),
		Heap:          heap,
		Goroutines:    goroutines,
		Engine:        engine,
		Core:          core.Version(),
		CorePatched:   corePatched(),
	}
}

var (
	corePatchedOnce  sync.Once
	corePatchedValue bool
)

// corePatched reports whether xray-core was replaced at build time, which
// only scripts/xray-core-patch.sh does: the evidence, from a phone, that
// the build carries the TCP buffer cap.
func corePatched() bool {
	corePatchedOnce.Do(func() {
		info, ok := debug.ReadBuildInfo()
		if !ok {
			return
		}
		for _, dep := range info.Deps {
			if dep.Path == "github.com/xtls/xray-core" && dep.Replace != nil {
				corePatchedValue = true
			}
		}
	})
	return corePatchedValue
}

// writeAtomically replaces path whole, so the app (or the next run) never
// reads half a file -- the process can be killed at any instant.
func writeAtomically(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
