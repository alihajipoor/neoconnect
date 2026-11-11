package controlplane

import (
	"strings"
	"testing"
	"time"
)

func TestOnlyTheRoutineReassertsAreCounted(t *testing.T) {
	// The ids of agent-gateway.service.ts. A new credential's confirmation
	// and every command a person or the system caused keep their own line.
	for id, want := range map[string]bool{
		"reassert:cku1":         true,
		"reassert-uplink:cku1":  true,
		"reassert-route:ckr1":   true,
		"reassert-confirm:cku1": false,
		"cmd_01HZX":             false,
		"":                      false,
		"reassert":              false,
	} {
		if got := routineReassert(id); got != want {
			t.Errorf("routineReassert(%q) = %v, want %v", id, got, want)
		}
	}
}

func TestTheTallyWritesOneLineAMinute(t *testing.T) {
	var tally reassertTally
	start := time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC)
	// A burst of 600 re-checks inside one second: no line.
	for i := 0; i < 600; i++ {
		if line := tally.add(start.Add(time.Duration(i) * time.Millisecond)); line != "" {
			t.Fatalf("no summary is due inside the first minute, got %q", line)
		}
	}
	// The first command of the next burst writes the line for the last.
	line := tally.add(start.Add(61 * time.Second))
	if !strings.Contains(line, "600 routine commands ok") || !strings.Contains(line, "12:00:00") {
		t.Fatalf("the summary must give the count and since when, got %q", line)
	}
	// And the count starts again with the command that triggered it.
	for i := 0; i < 599; i++ {
		if line := tally.add(start.Add(62 * time.Second)); line != "" {
			t.Fatalf("no second line for the same minute, got %q", line)
		}
	}
	if line := tally.add(start.Add(125 * time.Second)); !strings.Contains(line, "600 routine commands ok") {
		t.Fatalf("the second minute's line must count its own 600, got %q", line)
	}
}
