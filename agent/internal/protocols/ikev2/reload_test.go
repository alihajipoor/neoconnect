package ikev2

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/neoxify/neoxify-hub/agent/internal/protocols/common"
)

// The control plane re-asserts every credential every 60 seconds. Each
// one used to rewrite the secrets file and reload it, and strongSwan logs
// a line per stored secret per reload: with 51 customers that was 2,805
// lines a minute, 87% of everything a node logged (measured 2026-11-11).
// These tests pin both halves of the fix: an unchanged list is not loaded
// again, and nothing that does change is ever skipped.

func ikev2User(name, password string) common.ProtocolUser {
	return common.ProtocolUser{ExternalUserID: name, Credentials: map[string]string{"username": name, "password": password}}
}

// emptyFake is a provisioner with a fake strongSwan and nobody
// provisioned yet: an agent that has just started.
func emptyFake(t *testing.T) (*Provisioner, *fakeSwanctl) {
	t.Helper()
	p, f := withFake(t, "list-sas reply {}\n")
	p.users = map[string]string{}
	return p, f
}

func mustCreate(t *testing.T, p *Provisioner, name, password string) {
	t.Helper()
	if err := p.CreateUser(context.Background(), ikev2User(name, password)); err != nil {
		t.Fatalf("CreateUser(%s): %v", name, err)
	}
}

func TestTheSameCredentialSentAgainIsNotLoadedAgain(t *testing.T) {
	p, f := emptyFake(t)
	for i := 0; i < 100; i++ {
		mustCreate(t, p, "nx-a", "secret-a")
	}
	if got := f.count("--load-creds"); got != 1 {
		t.Fatalf("100 identical re-asserts must load strongSwan once, loaded %d times", got)
	}
	onDisk, err := os.ReadFile(p.secretsPath)
	if err != nil || !strings.Contains(string(onDisk), "id = nx-a") {
		t.Fatalf("the secrets file must hold the credential (err %v): %q", err, onDisk)
	}
}

func TestEveryRealChangeIsLoaded(t *testing.T) {
	p, f := emptyFake(t)
	ctx := context.Background()
	mustCreate(t, p, "nx-a", "secret-a")
	mustCreate(t, p, "nx-b", "secret-b")
	if got := f.count("--load-creds"); got != 2 {
		t.Fatalf("two new credentials are two loads, got %d", got)
	}

	mustCreate(t, p, "nx-a", "a-new-password")
	if got := f.count("--load-creds"); got != 3 {
		t.Fatalf("a changed password must be loaded, loads = %d", got)
	}
	if err := p.SetEnabled(ctx, "nx-b", false); err != nil {
		t.Fatalf("disable: %v", err)
	}
	if got := f.count("--load-creds"); got != 4 {
		t.Fatalf("a disable must be loaded, loads = %d", got)
	}
	if err := p.RemoveUser(ctx, "nx-a"); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if got := f.count("--load-creds"); got != 5 {
		t.Fatalf("a removal must be loaded, loads = %d", got)
	}
	// Every load clears first, so a removed identity is really gone.
	for _, call := range f.calls {
		if call[0] == "--load-creds" && (len(call) != 2 || call[1] != "--clear") {
			t.Fatalf("credentials must be loaded with --clear, got %v", call)
		}
	}
	onDisk, _ := os.ReadFile(p.secretsPath)
	if strings.Contains(string(onDisk), "nx-a") || strings.Contains(string(onDisk), "nx-b") {
		t.Fatalf("a removed and a disabled identity must be out of the file: %q", onDisk)
	}
}

func TestAFailedLoadIsTriedAgainEvenWhenTheListIsBackToWhatItWas(t *testing.T) {
	// `--load-creds --clear` clears first and loads second, so a run that
	// fails can leave strongSwan holding nothing. If the list then returns
	// to the text of the last good load, that text is NOT what strongSwan
	// holds, and skipping would leave every customer refused.
	p, f := emptyFake(t)
	ctx := context.Background()
	mustCreate(t, p, "nx-a", "secret-a")

	f.loadErr = errors.New("exit status 22")
	if err := p.CreateUser(ctx, ikev2User("nx-b", "secret-b")); err == nil {
		t.Fatal("a refused load must be reported, so the command is not acknowledged as done")
	}
	f.loadErr = nil

	before := f.count("--load-creds")
	if err := p.RemoveUser(ctx, "nx-b"); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if got := f.count("--load-creds"); got != before+1 {
		t.Fatalf("after a failed load the next command must load, loads went %d -> %d", before, got)
	}
	// And once that succeeded, the skip is back.
	mustCreate(t, p, "nx-a", "secret-a")
	if got := f.count("--load-creds"); got != before+1 {
		t.Fatalf("an unchanged list after a good load must not load again, loads = %d", got)
	}
}

func TestAFailedLoadIsRetriedByTheNextIdenticalCommand(t *testing.T) {
	// The plain retry: the same re-assert a minute later.
	p, f := emptyFake(t)
	f.loadErr = errors.New("exit status 22")
	if err := p.CreateUser(context.Background(), ikev2User("nx-a", "secret-a")); err == nil {
		t.Fatal("a refused load must be reported")
	}
	f.loadErr = nil
	mustCreate(t, p, "nx-a", "secret-a")
	if got := f.count("--load-creds"); got != 2 {
		t.Fatalf("the retry must load, loads = %d", got)
	}
}

func TestAFileChangedUnderneathIsPutRightByTheNextCommand(t *testing.T) {
	// strongSwan loads from this file by itself too: at start, and when a
	// certificate renewal hook reloads credentials. So a file that was
	// edited or restored by hand must not sit there until something else
	// changes.
	p, f := emptyFake(t)
	mustCreate(t, p, "nx-a", "secret-a")
	good, _ := os.ReadFile(p.secretsPath)

	if err := os.WriteFile(p.secretsPath, []byte("secrets {\n}\n"), 0o600); err != nil {
		t.Fatalf("could not overwrite the file: %v", err)
	}
	mustCreate(t, p, "nx-a", "secret-a")
	if got := f.count("--load-creds"); got != 2 {
		t.Fatalf("a changed file must be rewritten and loaded, loads = %d", got)
	}
	now, _ := os.ReadFile(p.secretsPath)
	if string(now) != string(good) {
		t.Fatalf("the file must be put back:\n%q\nwant\n%q", now, good)
	}

	if err := os.Remove(p.secretsPath); err != nil {
		t.Fatalf("could not remove the file: %v", err)
	}
	mustCreate(t, p, "nx-a", "secret-a")
	if got := f.count("--load-creds"); got != 3 {
		t.Fatalf("a missing file must be rewritten and loaded, loads = %d", got)
	}
}

const upSince = "uptime: 4 days, since Nov 07 07:29:18 2026\nworker threads: 16 total, 11 idle, working: 4/0/1/0\n"
const upSinceLater = "uptime: 12 seconds, since Nov 11 16:40:02 2026\nworker threads: 16 total, 11 idle, working: 4/0/1/0\n"

func poll(t *testing.T, p *Provisioner) {
	t.Helper()
	if _, err := p.StatsSince(context.Background()); err != nil {
		t.Fatalf("poll: %v", err)
	}
}

func TestAStrongSwanRestartIsLoadedByTheNextCommandNeverByThePoll(t *testing.T) {
	p, f := emptyFake(t)
	f.stats = upSince
	mustCreate(t, p, "nx-a", "secret-a")
	poll(t, p) // first sight of the start time: recorded, nothing else
	poll(t, p)
	mustCreate(t, p, "nx-a", "secret-a")
	if got := f.count("--load-creds"); got != 1 {
		t.Fatalf("an unchanged start time must not cause a load, loads = %d", got)
	}

	f.stats = upSinceLater
	before, _ := os.ReadFile(p.secretsPath)
	poll(t, p)
	if f.count("--load-creds") != 1 || f.count("--load-all") != 0 {
		t.Fatalf("the poll itself must load nothing: %v", f.calls)
	}
	after, _ := os.ReadFile(p.secretsPath)
	if string(after) != string(before) {
		t.Fatal("the poll must not write the secrets file")
	}

	// The next routine re-assert, unchanged, does the loading: everything
	// first (connection and pool, which a starter-run strongSwan does not
	// get back by itself), then the credentials with --clear.
	mustCreate(t, p, "nx-a", "secret-a")
	var order []string
	for _, call := range f.calls {
		if call[0] == "--load-all" || call[0] == "--load-creds" {
			order = append(order, call[0])
		}
	}
	want := []string{"--load-creds", "--load-all", "--load-creds"}
	if strings.Join(order, " ") != strings.Join(want, " ") {
		t.Fatalf("after a restart: want loads %v, got %v", want, order)
	}
	// Once, not on every command after it.
	mustCreate(t, p, "nx-a", "secret-a")
	poll(t, p)
	mustCreate(t, p, "nx-a", "secret-a")
	if f.count("--load-creds") != 2 || f.count("--load-all") != 1 {
		t.Fatalf("one restart is one reload: %v", f.calls)
	}
}

func TestAnAgentThatJustStartedLoadsNothingUntilACommandArrives(t *testing.T) {
	// After an agent restart the list in memory is empty until the control
	// plane re-asserts. Nothing but a command may write or load in that
	// state, whatever the poll sees -- an empty list loaded with --clear
	// refuses every IKEv2 customer on the node. withFake has customers in
	// memory so the poll runs at all; no command has been executed.
	p, f := withFake(t, "list-sas reply {}\n")
	f.stats = upSince
	poll(t, p)
	f.stats = upSinceLater
	poll(t, p)
	p.now = func() time.Time { return time.Now().Add(3 * reloadEvery) }
	poll(t, p)
	if f.count("--load-creds") != 0 || f.count("--load-all") != 0 {
		t.Fatalf("the poll must never load: %v", f.calls)
	}
	if _, err := os.Stat(p.secretsPath); !os.IsNotExist(err) {
		t.Fatalf("the poll must never write the secrets file (stat err %v)", err)
	}
}

func TestAStartTimeThatCouldNotBeReadIsNotARestart(t *testing.T) {
	p, f := emptyFake(t)
	f.stats = upSince
	mustCreate(t, p, "nx-a", "secret-a")
	poll(t, p)
	for _, unreadable := range []string{"", "worker threads: 16 total\n", "uptime: 4 days\n"} {
		f.stats = unreadable
		poll(t, p)
		f.stats = upSince
		poll(t, p)
	}
	mustCreate(t, p, "nx-a", "secret-a")
	if f.count("--load-creds") != 1 || f.count("--load-all") != 0 {
		t.Fatalf("a missing uptime line means unknown, not restarted: %v", f.calls)
	}
}

func TestAConfigurationLoadThatFailsStillLoadsTheCredentials(t *testing.T) {
	p, f := emptyFake(t)
	f.stats = upSince
	mustCreate(t, p, "nx-a", "secret-a")
	poll(t, p)
	f.stats = upSinceLater
	poll(t, p)

	f.loadAllErr = errors.New("exit status 22")
	mustCreate(t, p, "nx-a", "secret-a")
	if f.count("--load-all") != 1 || f.count("--load-creds") != 2 {
		t.Fatalf("the credentials must be loaded even when --load-all fails: %v", f.calls)
	}
	// It is tried again with the next load, here the ten-minute one.
	f.loadAllErr = nil
	p.now = func() time.Time { return time.Now().Add(reloadEvery + time.Minute) }
	mustCreate(t, p, "nx-a", "secret-a")
	if f.count("--load-all") != 2 || f.count("--load-creds") != 3 {
		t.Fatalf("a failed --load-all must be tried again with the next load: %v", f.calls)
	}
}

func TestAnUnchangedListIsLoadedAgainAfterTenMinutes(t *testing.T) {
	// The bound on what this process cannot see: credentials cleared by
	// another tool, or a restart the poll could not read.
	p, f := emptyFake(t)
	clock := time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC)
	p.now = func() time.Time { return clock }
	mustCreate(t, p, "nx-a", "secret-a")
	clock = clock.Add(reloadEvery - time.Second)
	mustCreate(t, p, "nx-a", "secret-a")
	if got := f.count("--load-creds"); got != 1 {
		t.Fatalf("inside ten minutes an unchanged list is not loaded again, loads = %d", got)
	}
	clock = clock.Add(2 * time.Second)
	mustCreate(t, p, "nx-a", "secret-a")
	mustCreate(t, p, "nx-a", "secret-a")
	if got := f.count("--load-creds"); got != 2 {
		t.Fatalf("after ten minutes the next command loads once, loads = %d", got)
	}
}

func TestCommandsAndThePollShareTheListSafely(t *testing.T) {
	// The dispatcher applies commands concurrently and the poll runs
	// beside them. Run with -race.
	p, f := emptyFake(t)
	f.stats = upSince
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 50; i++ {
			_ = p.CreateUser(context.Background(), ikev2User("nx-a", "secret-a"))
			_ = p.CreateUser(context.Background(), ikev2User("nx-b", "secret-b"))
		}
	}()
	for i := 0; i < 50; i++ {
		p.mu.Lock()
		p.noteDaemonSinceLocked("Nov 07 07:29:18 2026")
		p.mu.Unlock()
		p.mu.Lock()
		_ = p.flushLocked(context.Background())
		p.mu.Unlock()
	}
	<-done
}
