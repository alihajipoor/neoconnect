package openvpn

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"sync"
	"testing"
)

// fakeMgmt is as much of OpenVPN's management interface as `status 2`
// needs: a banner on connect, then a canned reply to the one command, then
// the connection closes. A reply without END is a truncated one.
type fakeMgmt struct {
	mu    sync.Mutex
	reply string
}

func (f *fakeMgmt) set(reply string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reply = reply
}

func startFakeMgmt(t *testing.T) (string, *fakeMgmt) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })
	f := &fakeMgmt{}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				fmt.Fprint(c, ">INFO:OpenVPN Management Interface Version 5 -- type 'help' for more info\r\n")
				if _, err := bufio.NewReader(c).ReadString('\n'); err != nil {
					return
				}
				f.mu.Lock()
				reply := f.reply
				f.mu.Unlock()
				fmt.Fprint(c, reply)
			}(conn)
		}
	}()
	return ln.Addr().String(), f
}

// status builds a `status 2` reply in OpenVPN's own layout, one client
// per entry: common name, bytes received, bytes sent.
func status(clients [][3]any, complete bool) string {
	s := "TITLE,OpenVPN 2.6.12 x86_64-pc-linux-gnu\r\n" +
		"TIME,2026-10-06 12:00:00,1791374400\r\n" +
		"HEADER,CLIENT_LIST,Common Name,Real Address,Virtual Address,Virtual IPv6 Address,Bytes Received,Bytes Sent,Connected Since,Connected Since (time_t),Username,Client ID,Peer ID,Data Channel Cipher\r\n"
	for i, c := range clients {
		s += fmt.Sprintf("CLIENT_LIST,%s,203.0.113.%d:51000,10.77.0.%d,,%d,%d,2026-10-06 10:00:00,1791367200,UNDEF,%d,%d,AES-256-GCM\r\n",
			c[0], i+5, i+2, c[1], c[2], i, i)
	}
	if complete {
		s += "GLOBAL_STATS,Max bcast/mcast queue length,0\r\nEND\r\n"
	}
	return s
}

func byUser(t *testing.T, p *Provisioner) map[string][2]uint64 {
	t.Helper()
	deltas, err := p.StatsSince(context.Background())
	if err != nil {
		t.Fatalf("StatsSince: %v", err)
	}
	out := map[string][2]uint64{}
	for _, d := range deltas {
		out[d.ExternalUserID] = [2]uint64{d.BytesUp, d.BytesDown}
	}
	return out
}

func TestAnAgentRestartDoesNotBillSessionTotalsAgain(t *testing.T) {
	// OpenVPN keeps running across an agent restart, so a connected
	// client's session totals are still there when the new process first
	// polls -- and were reported again, in full.
	addr, mgmt := startFakeMgmt(t)
	p := New(addr, t.TempDir())

	mgmt.set(status([][3]any{{"cn-1", uint64(30_000_000_000), uint64(40_000_000_000)}}, true))
	if got := byUser(t, p); len(got) != 0 {
		t.Fatalf("the first poll after a start must be a baseline, got %v", got)
	}

	mgmt.set(status([][3]any{{"cn-1", uint64(30_000_001_000), uint64(40_000_002_000)}}, true))
	if got := byUser(t, p); len(got) != 1 || got["cn-1"] != [2]uint64{1000, 2000} {
		t.Fatalf("expected only the growth since the baseline, got %v", got)
	}

	// A client that connects after the baseline has a fresh session, so
	// all of it is new.
	mgmt.set(status([][3]any{
		{"cn-1", uint64(30_000_001_000), uint64(40_000_002_000)},
		{"cn-2", uint64(500), uint64(700)},
	}, true))
	if got := byUser(t, p); len(got) != 1 || got["cn-2"] != [2]uint64{500, 700} {
		t.Fatalf("expected the new session counted in full, got %v", got)
	}
}

func TestATruncatedStatusIsNotReadAsComplete(t *testing.T) {
	// A reply cut off before END used to come back as a complete answer.
	// The clients missing from it looked disconnected, their counters were
	// forgotten, and the next full read billed their whole session again.
	addr, mgmt := startFakeMgmt(t)
	p := New(addr, t.TempDir())
	both := [][3]any{
		{"cn-1", uint64(1_000_000), uint64(2_000_000)},
		{"cn-2", uint64(5_000_000), uint64(9_000_000)},
	}

	mgmt.set(status(both, true))
	byUser(t, p) // baseline

	mgmt.set(status(both[:1], false))
	if _, err := p.StatsSince(context.Background()); err == nil {
		t.Fatal("a reply that never reached END must be an error")
	}

	mgmt.set(status(both, true))
	if got := byUser(t, p); len(got) != 0 {
		t.Fatalf("nobody used anything, but got %v", got)
	}
}
