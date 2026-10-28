package accesslog

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func appendTo(t *testing.T, path, s string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(s); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}

func poll(t *testing.T, tl *Tailer) []string {
	t.Helper()
	var lines []string
	if err := tl.Poll(func(l string) { lines = append(lines, l) }); err != nil {
		t.Fatalf("Poll: %v", err)
	}
	return lines
}

func expectLines(t *testing.T, got []string, want ...string) {
	t.Helper()
	if len(got) == 0 && len(want) == 0 {
		return
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got lines %q, want %q", got, want)
	}
}

// The rule the whole feature rests on: nothing written before the agent
// started is reported as if it had just happened.
func TestTailerStartsAtTheEnd(t *testing.T) {
	path := filepath.Join(t.TempDir(), "access.log")
	appendTo(t, path, "old 1\nold 2\n")

	tl := NewTailer(path, 1<<20)
	expectLines(t, poll(t, tl))

	appendTo(t, path, "new 1\nnew 2\n")
	expectLines(t, poll(t, tl), "new 1", "new 2")
	expectLines(t, poll(t, tl))
}

// A file that ended mid-line when the tailer started: the rest of that
// line is history too, and a fragment besides.
func TestTailerStartingMidLineSkipsTheFragment(t *testing.T) {
	path := filepath.Join(t.TempDir(), "access.log")
	appendTo(t, path, "old 1\nold 2 half")

	tl := NewTailer(path, 1<<20)
	appendTo(t, path, " written later\nnew 1\n")
	expectLines(t, poll(t, tl), "new 1")
}

func TestTailerLeavesAnUnfinishedLineForLater(t *testing.T) {
	path := filepath.Join(t.TempDir(), "access.log")
	tl := NewTailer(path, 1<<20)

	appendTo(t, path, "whole\nhal")
	expectLines(t, poll(t, tl), "whole")
	appendTo(t, path, "f\n")
	expectLines(t, poll(t, tl), "half")
}

// Absent at start means everything that appears later is new: read from
// the top once it exists. Absent in between is quiet.
func TestTailerFileAbsentThenCreated(t *testing.T) {
	path := filepath.Join(t.TempDir(), "access.log")
	tl := NewTailer(path, 1<<20)
	expectLines(t, poll(t, tl))
	expectLines(t, poll(t, tl))

	appendTo(t, path, "first\n")
	expectLines(t, poll(t, tl), "first")
}

// copytruncate is how the installer's logrotate rule rotates this file
// (installer/lib/agent.sh): the same file, cut back to nothing, and Xray
// carrying on writing at the new end.
func TestTailerCopytruncate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "access.log")
	tl := NewTailer(path, 1<<20)

	appendTo(t, path, "before rotation, line one\nbefore rotation, line two\n")
	expectLines(t, poll(t, tl), "before rotation, line one", "before rotation, line two")

	if err := os.Truncate(path, 0); err != nil {
		t.Fatal(err)
	}
	expectLines(t, poll(t, tl))
	appendTo(t, path, "after\n")
	expectLines(t, poll(t, tl), "after")
}

// Truncated, then grown past the old offset before the next poll. The
// size check alone cannot see it; reading on from the old offset would
// start mid-line and lose everything written before that point.
func TestTailerCopytruncateThenRegrownBetweenPolls(t *testing.T) {
	path := filepath.Join(t.TempDir(), "access.log")
	tl := NewTailer(path, 1<<20)

	appendTo(t, path, "short\n")
	expectLines(t, poll(t, tl), "short")

	if err := os.Truncate(path, 0); err != nil {
		t.Fatal(err)
	}
	// Byte 5 (the old offset - 1) is 'h' here, not the '\n' that was
	// there before.
	appendTo(t, path, "a much longer line\nand another\n")
	expectLines(t, poll(t, tl), "a much longer line", "and another")
}

// Rotation by rename: a different file now has the name. Made longer
// than the old offset so neither the size nor the byte check is what
// notices.
func TestTailerRenamedAway(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "access.log")
	tl := NewTailer(path, 1<<20)

	appendTo(t, path, "one\n")
	expectLines(t, poll(t, tl), "one")

	if err := os.Rename(path, filepath.Join(dir, "access.log.1")); err != nil {
		t.Fatal(err)
	}
	// Between the move and Xray reopening: absent, and quiet about it.
	expectLines(t, poll(t, tl))

	appendTo(t, path, "two\nthree\nfour\n")
	expectLines(t, poll(t, tl), "two", "three", "four")
}

// The same, but the new file appears before the tailer ever sees the
// path empty -- the case only the file identity check catches. "one\n"
// and "xyz\n..." both have a newline at byte 3, so the byte check
// passes too.
func TestTailerReplacedBetweenPolls(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "access.log")
	tl := NewTailer(path, 1<<20)

	appendTo(t, path, "one\n")
	expectLines(t, poll(t, tl), "one")

	if err := os.Rename(path, filepath.Join(dir, "access.log.1")); err != nil {
		t.Fatal(err)
	}
	appendTo(t, path, "xyz\nfive\n")
	expectLines(t, poll(t, tl), "xyz", "five")
}

func TestTailerDeletedAndRecreated(t *testing.T) {
	path := filepath.Join(t.TempDir(), "access.log")
	tl := NewTailer(path, 1<<20)

	appendTo(t, path, "one\n")
	expectLines(t, poll(t, tl), "one")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	expectLines(t, poll(t, tl))
	appendTo(t, path, "two\n")
	expectLines(t, poll(t, tl), "two")
}

// One poll reads at most maxRead bytes; a backlog is worked through over
// several polls, every line exactly once.
func TestTailerBoundedReads(t *testing.T) {
	path := filepath.Join(t.TempDir(), "access.log")
	tl := NewTailer(path, 32)

	var want []string
	var b strings.Builder
	for i := 0; i < 20; i++ {
		line := strings.Repeat(string(rune('a'+i)), 9) // 10 bytes with its newline
		want = append(want, line)
		b.WriteString(line + "\n")
	}
	appendTo(t, path, b.String())

	var got []string
	for i := 0; i < 20 && len(got) < len(want); i++ {
		lines := poll(t, tl)
		if len(lines) > 3 {
			t.Fatalf("one poll returned %d lines; 32 bytes holds at most 3", len(lines))
		}
		got = append(got, lines...)
	}
	expectLines(t, got, want...)
}

// A line longer than one read can never be finished by waiting. It is
// discarded, and the lines after it are still read.
func TestTailerSkipsALineLongerThanOneRead(t *testing.T) {
	path := filepath.Join(t.TempDir(), "access.log")
	tl := NewTailer(path, 16)

	appendTo(t, path, strings.Repeat("x", 50)+"\nafter\n")
	var got []string
	for i := 0; i < 10; i++ {
		got = append(got, poll(t, tl)...)
	}
	expectLines(t, got, "after")
}
