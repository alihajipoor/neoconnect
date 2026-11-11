package ikev2

import (
	"context"
	"errors"
	"testing"
	"time"
)

// The states the skip must not be fooled by. Each was a finding of the
// review of the first version of the change, on 2026-11-11.

func TestAStartTimeThatFlipsByASecondIsNotARestart(t *testing.T) {
	// charon works its start time out on every call from two clocks cut to
	// whole seconds, so it flips between neighbouring seconds while nothing
	// has happened: 26 readings of :29 and 14 of :30 out of 40 on one node,
	// 2 and 38 on another. Comparing the text called that a restart.
	p, f := emptyFake(t)
	f.stats = "uptime: 8 hours, since Nov 11 07:14:29 2026\n"
	mustCreate(t, p, "nx-a", "secret-a")
	for i := 0; i < 20; i++ {
		f.stats = "uptime: 8 hours, since Nov 11 07:14:30 2026\n"
		poll(t, p)
		f.stats = "uptime: 8 hours, since Nov 11 07:14:29 2026\n"
		poll(t, p)
		mustCreate(t, p, "nx-a", "secret-a")
	}
	if f.count("--load-creds") != 1 || f.count("--load-all") != 0 {
		t.Fatalf("a start time one second either way is the same start: %v loads, %v load-all", f.count("--load-creds"), f.count("--load-all"))
	}
	// A clock set back is not a restart either: a restart only ever moves
	// the start time forward.
	f.stats = "uptime: 9 hours, since Nov 11 06:14:29 2026\n"
	poll(t, p)
	mustCreate(t, p, "nx-a", "secret-a")
	if f.count("--load-creds") != 1 {
		t.Fatalf("a start time that moved back must not cause a load, loads = %d", f.count("--load-creds"))
	}
}

func TestAStartTimeInAnotherFormIsNotARestart(t *testing.T) {
	p, f := emptyFake(t)
	f.stats = "uptime: 4 days, since 07.11.2026 07:29:18\n"
	mustCreate(t, p, "nx-a", "secret-a")
	poll(t, p)
	f.stats = "uptime: 4 days, since 11.11.2026 16:40:02\n"
	poll(t, p)
	mustCreate(t, p, "nx-a", "secret-a")
	if f.count("--load-creds") != 1 || f.count("--load-all") != 0 {
		t.Fatalf("a start time this cannot parse means unknown, not restarted: %v", f.calls)
	}
	// A space-padded day is the same format and is read.
	q, g := emptyFake(t)
	g.stats = "uptime: 4 days, since Nov  7 07:29:18 2026\n"
	mustCreate(t, q, "nx-a", "secret-a")
	g.stats = "uptime: 5 seconds, since Nov  9 10:00:00 2026\n"
	poll(t, q)
	mustCreate(t, q, "nx-a", "secret-a")
	if g.count("--load-creds") != 2 || g.count("--load-all") != 1 {
		t.Fatalf("a space-padded day must be read and the restart seen: %v", g.calls)
	}
}

func TestARestartBeforeTheFirstPollIsSeen(t *testing.T) {
	// The poll's first reading only records. Without a reading taken at
	// the first load, a restart in the agent's first half minute would be
	// recorded as the start and never noticed.
	p, f := emptyFake(t)
	f.stats = upSince
	mustCreate(t, p, "nx-a", "secret-a")
	f.stats = upSinceLater
	poll(t, p)
	mustCreate(t, p, "nx-a", "secret-a")
	if f.count("--load-creds") != 2 || f.count("--load-all") != 1 {
		t.Fatalf("a restart between the first load and the first poll must be loaded: %v", f.calls)
	}
}

func TestALoadThatStrongSwanDidNotConfirmIsNotRemembered(t *testing.T) {
	// `swanctl --load-creds --clear` exits 0 when the clear worked and a
	// secret after it did not load. Remembering that as "loaded" would
	// skip every re-assert while a customer is refused.
	p, f := emptyFake(t)
	mustCreate(t, p, "nx-a", "secret-a")
	mustCreate(t, p, "nx-b", "secret-b")
	loads := f.count("--load-creds")

	f.dropLoaded = 1
	p.now = func() time.Time { return time.Now().Add(reloadEvery + time.Minute) }
	// Acknowledged, as an exit 0 always was...
	mustCreate(t, p, "nx-a", "secret-a")
	// ...and loaded again by every command until strongSwan names them all.
	mustCreate(t, p, "nx-a", "secret-a")
	mustCreate(t, p, "nx-a", "secret-a")
	if got := f.count("--load-creds"); got != loads+3 {
		t.Fatalf("an unconfirmed load must be repeated by each command, loads went %d -> %d", loads, got)
	}
	f.dropLoaded = 0
	mustCreate(t, p, "nx-a", "secret-a")
	mustCreate(t, p, "nx-a", "secret-a")
	if got := f.count("--load-creds"); got != loads+4 {
		t.Fatalf("once confirmed, an unchanged list is not loaded again, loads went %d -> %d", loads, got)
	}
}

func TestAPollThatFailedMakesTheNextCommandLoad(t *testing.T) {
	// strongSwan down: the poll cannot list. An unchanged re-assert must
	// then try the load -- and fail, loudly -- not be skipped and
	// acknowledged against a dead engine for ten minutes.
	p, f := emptyFake(t)
	mustCreate(t, p, "nx-a", "secret-a")

	f.listErr = errors.New("connecting to 'unix:///var/run/charon.vici' failed")
	if _, err := p.StatsSince(context.Background()); err == nil {
		t.Fatal("the poll must report that strongSwan did not answer")
	}
	f.loadErr = errors.New("exit status 22")
	if err := p.CreateUser(context.Background(), ikev2User("nx-a", "secret-a")); err == nil {
		t.Fatal("with strongSwan down an unchanged re-assert must fail, not be skipped")
	}
	// And when it is back, the next command loads it.
	f.listErr, f.loadErr = nil, nil
	before := f.count("--load-creds")
	mustCreate(t, p, "nx-a", "secret-a")
	if got := f.count("--load-creds"); got != before+1 {
		t.Fatalf("the first command after strongSwan is back must load, loads %d -> %d", before, got)
	}
}

func TestAConfigurationLoadThatKeepsFailingIsTriedOnceAMinute(t *testing.T) {
	p, f := emptyFake(t)
	clock := time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC)
	p.now = func() time.Time { return clock }
	f.stats = upSince
	mustCreate(t, p, "nx-a", "secret-a")
	f.stats = upSinceLater
	poll(t, p)

	f.loadAllErr = errors.New("exit status 22")
	mustCreate(t, p, "nx-a", "secret-a")
	// Inside the minute: the credentials are loaded and confirmed, so the
	// routine re-asserts are skipped again, 51 of them or not.
	for i := 0; i < 51; i++ {
		clock = clock.Add(time.Second)
		mustCreate(t, p, "nx-a", "secret-a")
	}
	if f.count("--load-all") != 1 || f.count("--load-creds") != 2 {
		t.Fatalf("a failed --load-all is not retried by every command: %d load-all, %d load-creds", f.count("--load-all"), f.count("--load-creds"))
	}
	// After it: tried again, once.
	clock = clock.Add(loadAllRetryEvery)
	mustCreate(t, p, "nx-a", "secret-a")
	mustCreate(t, p, "nx-a", "secret-a")
	if f.count("--load-all") != 2 {
		t.Fatalf("a failed --load-all is tried again after a minute, load-all = %d", f.count("--load-all"))
	}
	// And once it has worked, never again for that restart.
	f.loadAllErr = nil
	clock = clock.Add(loadAllRetryEvery)
	mustCreate(t, p, "nx-a", "secret-a")
	clock = clock.Add(loadAllRetryEvery)
	mustCreate(t, p, "nx-a", "secret-a")
	if f.count("--load-all") != 3 {
		t.Fatalf("one restart is one successful --load-all, load-all = %d", f.count("--load-all"))
	}
}
