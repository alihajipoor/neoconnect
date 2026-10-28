package xray

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeLog(t *testing.T, path string, lines ...string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatalf("open log: %v", err)
	}
	defer f.Close()
	for _, l := range lines {
		if _, err := f.WriteString(l + "\n"); err != nil {
			t.Fatalf("write log: %v", err)
		}
	}
}

func accessLine(at time.Time, source, user string) string {
	return fmt.Sprintf("%s from tcp:%s:51234 accepted tcp:1.1.1.1:443 [vless-in >> direct] email: %s",
		at.Format(accessTimeLayout), source, user)
}

func TestCountsDistinctSourcesPerUser(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "access.log")
	now := time.Now()

	// One user connecting from two places -- the shared-credential case
	// this exists to catch -- alongside a user with many connections from
	// a single place, which is just a browser behaving normally.
	writeLog(t, path,
		accessLine(now, "203.0.113.9", "user-shared"),
		accessLine(now, "198.51.100.7", "user-shared"),
		accessLine(now, "203.0.113.20", "user-normal"),
		accessLine(now, "203.0.113.20", "user-normal"),
		accessLine(now, "203.0.113.20", "user-normal"),
	)

	counts, err := NewSessionCounter(path, time.Minute).Counts()
	if err != nil {
		t.Fatalf("Counts: %v", err)
	}
	if counts["user-shared"] != 2 {
		t.Errorf("shared credential: got %d distinct sources, want 2", counts["user-shared"])
	}
	if counts["user-normal"] != 1 {
		t.Errorf("many connections from one place should count once, got %d", counts["user-normal"])
	}
}

func TestForgetsSourcesOlderThanTheWindow(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "access.log")
	now := time.Now()

	// Someone who changed networks earlier should not look like two
	// simultaneous users forever.
	writeLog(t, path,
		accessLine(now.Add(-2*time.Hour), "203.0.113.9", "roamer"),
		accessLine(now, "198.51.100.7", "roamer"),
	)

	counts, err := NewSessionCounter(path, 5*time.Minute).Counts()
	if err != nil {
		t.Fatalf("Counts: %v", err)
	}
	if counts["roamer"] != 1 {
		t.Errorf("stale source should have aged out, got %d", counts["roamer"])
	}
}

func TestReadsOnlyWhatIsNewSinceLastCall(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "access.log")
	now := time.Now()
	counter := NewSessionCounter(path, time.Minute)

	writeLog(t, path, accessLine(now, "203.0.113.9", "u1"))
	if _, err := counter.Counts(); err != nil {
		t.Fatalf("first Counts: %v", err)
	}

	// Re-reading the whole file every poll would be the most expensive
	// thing the agent does on a busy node.
	before, _ := os.Stat(path)
	writeLog(t, path, accessLine(now, "198.51.100.7", "u1"))
	counts, err := counter.Counts()
	if err != nil {
		t.Fatalf("second Counts: %v", err)
	}
	if counter.offset <= before.Size()-1 {
		t.Errorf("offset did not advance past previously-read bytes")
	}
	if counts["u1"] != 2 {
		t.Errorf("both sources should be remembered across polls, got %d", counts["u1"])
	}
}

func TestSurvivesLogRotation(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "access.log")
	now := time.Now()
	counter := NewSessionCounter(path, time.Minute)

	writeLog(t, path, accessLine(now, "203.0.113.9", "u1"), accessLine(now, "203.0.113.10", "u2"))
	if _, err := counter.Counts(); err != nil {
		t.Fatalf("first Counts: %v", err)
	}

	// After rotation the file is shorter than the saved offset; seeking
	// past the end would silently read nothing from then on.
	if err := os.WriteFile(path, []byte(accessLine(now, "198.51.100.7", "u3")+"\n"), 0o600); err != nil {
		t.Fatalf("rotate: %v", err)
	}
	counts, err := counter.Counts()
	if err != nil {
		t.Fatalf("after rotation: %v", err)
	}
	if counts["u3"] != 1 {
		t.Errorf("should have read the rotated file, got %v", counts)
	}
}

func TestMissingLogIsNotAnError(t *testing.T) {
	// Access logging may simply not be enabled on a node. Reporting
	// nothing is correct; the server treats absent counts as unknown
	// rather than as zero.
	counts, err := NewSessionCounter(filepath.Join(t.TempDir(), "nope.log"), time.Minute).Counts()
	if err != nil {
		t.Fatalf("missing log should not error: %v", err)
	}
	if len(counts) != 0 {
		t.Errorf("expected no counts, got %v", counts)
	}
}

func TestIgnoresLinesWithoutAUser(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "access.log")
	writeLog(t, path,
		"2026/07/25 10:13:18 from tcp:203.0.113.9:51234 accepted tcp:1.1.1.1:443 [vless-in >> direct]",
		"some unrelated warning line",
	)

	counts, err := NewSessionCounter(path, time.Minute).Counts()
	if err != nil {
		t.Fatalf("Counts: %v", err)
	}
	if len(counts) != 0 {
		t.Errorf("expected no counts from unattributed lines, got %v", counts)
	}
}

// What the live nodes write (2026-10-28): microseconds after the seconds,
// and Shadowsocks' source without a "tcp:" in front. The pattern matched
// neither, so no Xray user ever had a device count.
func TestCountsTheLinesLiveNodesWrite(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "access.log")
	now := time.Now()
	stamp := now.Format("2006/01/02 15:04:05") + ".560474"
	lines := []string{
		stamp + " from tcp:203.0.113.9:51234 accepted tcp:example.com:443 [vless-in >> direct] email: user-vless",
		stamp + " from 203.0.113.10:4411 accepted 198.51.100.63:443 [shadowsocks-in >> direct] email: user-ss",
		stamp + " from 203.0.113.11:4412 accepted 198.51.100.64:443 [shadowsocks-in >> direct] email: user-ss",
		stamp + " from tcp:[2001:db8::7]:5000 accepted tcp:example.com:443 [trojan-in >> direct] email: user-v6",
		stamp + " from 203.0.113.12:1 rejected proxy/trojan: not trojan protocol",
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	counts, err := NewSessionCounter(path, time.Hour).Counts()
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]int{"user-vless": 1, "user-ss": 2, "user-v6": 1}
	for user, n := range want {
		if counts[user] != n {
			t.Errorf("%s: got %d sources, want %d (all counts %v)", user, counts[user], n, counts)
		}
	}
	if len(counts) != len(want) {
		t.Errorf("unexpected users counted: %v", counts)
	}
}
