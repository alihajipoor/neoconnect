package neoxifyxray

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime/debug"
	"strings"
	"testing"
	"time"
)

// diagDirFor gives a test its own folder, and lets go of it afterwards:
// the crash output file stays open (Windows cannot remove an open file)
// and the heartbeat would otherwise keep writing into it.
func diagDirFor(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Cleanup(func() {
		diagMu.Lock()
		defer diagMu.Unlock()
		_ = debug.SetCrashOutput(nil, debug.CrashOptions{})
		if diagFatal != nil {
			_ = diagFatal.Close()
			diagFatal = nil
		}
		diagDir = ""
	})
	return dir
}

func readLastEnd(t *testing.T, dir string) LastEnd {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, lastEndFile))
	if err != nil {
		t.Fatalf("no %s: %v", lastEndFile, err)
	}
	var end LastEnd
	if err := json.Unmarshal(data, &end); err != nil {
		t.Fatalf("%s is not JSON: %v", lastEndFile, err)
	}
	return end
}

func TestFirstRunHasNoPreviousEnd(t *testing.T) {
	dir := diagDirFor(t)
	if got := BeginRun(dir); got != "" {
		t.Fatalf("a first run reported a previous end: %s", got)
	}
	if _, err := os.Stat(filepath.Join(dir, heartbeatFile)); err != nil {
		t.Fatalf("no heartbeat written at start: %v", err)
	}
}

func TestAStoppedRunReportsItsReason(t *testing.T) {
	dir := diagDirFor(t)
	BeginRun(dir)
	EndRun(dir, 11) // superceded
	if BeginRun(dir) == "" {
		t.Fatal("the previous run was not reported")
	}
	end := readLastEnd(t, dir)
	if end.Ended != "stopped" || end.StopReason == nil || *end.StopReason != 11 ||
		end.StopReasonName == nil || *end.StopReasonName != "superceded" || end.StoppedAt == nil {
		t.Fatalf("stopped run = %+v", end)
	}
	if end.LastHeartbeat == nil || end.LastHeartbeat.Core == "" || end.LastHeartbeat.Goroutines <= 0 {
		t.Fatalf("no usable heartbeat: %+v", end.LastHeartbeat)
	}
}

// A run that ended with no stopTunnel -- the crash or the memory kill this
// exists for -- is reported as such, with no reason invented for it.
func TestARunWithoutStopIsReportedAsSuch(t *testing.T) {
	dir := diagDirFor(t)
	BeginRun(dir)
	BeginRun(dir)
	end := readLastEnd(t, dir)
	if end.Ended != "withoutStop" || end.StopReason != nil || end.StopReasonName != nil {
		t.Fatalf("run without a stop = %+v", end)
	}
	if end.FatalSummary != "" || len(end.FatalTail) != 0 {
		t.Fatalf("a run with no fatal output reported one: %+v", end)
	}
}

func TestAFailedStartIsNamed(t *testing.T) {
	dir := diagDirFor(t)
	BeginRun(dir)
	EndRun(dir, -1)
	BeginRun(dir)
	if end := readLastEnd(t, dir); end.StopReasonName == nil || *end.StopReasonName != "startFailed" {
		t.Fatalf("failed start = %+v", end)
	}
}

// The real path end to end: a process that panics in a goroutine, as the
// old TUN inbound did, leaves its trace through debug.SetCrashOutput, and
// the next run reports it -- cleaned.
func TestAPanicInTheEngineIsRecordedForTheNextRun(t *testing.T) {
	if os.Getenv("NEOXIFY_DIAG_PANIC_CHILD") != "" {
		BeginRun(os.Getenv("NEOXIFY_DIAG_DIR"))
		done := make(chan struct{})
		go func() {
			defer close(done)
			panic("Net: Unknown address type 203.0.113.7:443 via node-1.example.net for 0b7c1e4a-5f2d-4d7e-9a51-2c3e4f5a6b7c")
		}()
		<-done
		return
	}
	dir := diagDirFor(t)
	cmd := exec.Command(os.Args[0], "-test.run=^TestAPanicInTheEngineIsRecordedForTheNextRun$")
	cmd.Env = append(os.Environ(), "NEOXIFY_DIAG_PANIC_CHILD=1", "NEOXIFY_DIAG_DIR="+dir)
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("the child did not crash:\n%s", out)
	}
	BeginRun(dir)
	end := readLastEnd(t, dir)
	if end.Ended != "withoutStop" {
		t.Fatalf("crashed run = %+v", end)
	}
	if !strings.HasPrefix(end.FatalSummary, "panic: Net: Unknown address type") {
		t.Fatalf("fatal summary = %q", end.FatalSummary)
	}
	all := end.FatalSummary + "\n" + strings.Join(end.FatalTail, "\n")
	for _, leaked := range []string{"203.0.113.7", "node-1.example.net", "0b7c1e4a", string(os.PathSeparator) + "Users", "home" + string(os.PathSeparator)} {
		if strings.Contains(all, leaked) {
			t.Fatalf("the record carries %q:\n%s", leaked, all)
		}
	}
	if !strings.Contains(all, "diagnostics_test.go") {
		t.Fatalf("the trace lost its frames:\n%s", all)
	}
	if _, err := os.Stat(filepath.Join(dir, fatalPrevFile)); err != nil {
		t.Fatalf("the crashed run's output was not kept as the previous one: %v", err)
	}
}

func TestCleanLine(t *testing.T) {
	cases := []struct{ in, want string }{
		{"panic: dial tcp 198.51.100.4:8443: i/o timeout", "panic: dial tcp <ip>: i/o timeout"},
		{"fatal error: lookup mirror.example.com on [2001:db8::1]:53", "fatal error: lookup <host> on <ip>"},
		{"user 0b7c1e4a-5f2d-4d7e-9a51-2c3e4f5a6b7c key mYq9AsSqMYjpfG2Vp36NMc8zFJcippAHvP1_R0ebzFc", "user <id> key <id>"},
		{"\t/Users/someone/go/pkg/mod/github.com/xtls/xray-core@v1.260327.0/proxy/tun/handler.go:113 +0x1c4", "\thandler.go:113 +0x?"},
		{"github.com/xtls/xray-core/proxy/tun.(*Handler).HandleConnection(0x14000123450, {0x10203, 0x1400})", "github.com/xtls/xray-core/proxy/tun.(*Handler).HandleConnection(0x?, {0x?, 0x?})"},
		{"created by github.com/xtls/xray-core/proxy/tun.(*stackGVisor).Start.func1 in goroutine 41", "created by github.com/xtls/xray-core/proxy/tun.(*stackGVisor).Start.func1 in goroutine 41"},
		{"goroutine 7 [running]:", "goroutine 7 [running]:"},
		{"mail me@example.org", "mail <id>"},
		{"panic: dial dest_203.0.113.7:443 failed", "panic: dial dest_<ip> failed"},
		{"panic: x203.0.113.7 and 203.0.113.7abc", "panic: x<ip> and <ip>abc"},
		{"panic: proxy https://user:pass@node.example.com/x", "panic: proxy https://<id>@<host>/x"},
		{"panic: short id 6ba85179e30d4fc2 rejected", "panic: short id <id> rejected"},
		{"panic: password Zx9kQ2mP7vL4w rejected", "panic: password <id> rejected"},
		{"panic: lookup dest_node.example.com failed", "panic: lookup dest_<host> failed"},
		{"panic: route via dest_2001:db8::1", "panic: route via dest_<ip>"},
		{"panic: Net: Unknown address type", "panic: Net: Unknown address type"},
	}
	for _, c := range cases {
		if got := cleanLine(c.in); got != c.want {
			t.Errorf("cleanLine(%q)\n  = %q\n want %q", c.in, got, c.want)
		}
	}
}

func TestHeartbeatIsSmallAndCurrent(t *testing.T) {
	hb := sampleHeartbeat(time.Now().Add(-3 * time.Second))
	data, _ := json.Marshal(hb)
	if len(data) > 400 {
		t.Fatalf("heartbeat is %d bytes", len(data))
	}
	if hb.Uptime < 3 || hb.Heap <= 0 || hb.Engine != "none" {
		t.Fatalf("heartbeat = %+v", hb)
	}
}
