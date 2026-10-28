package accesslog

import (
	"strings"
	"testing"
	"time"
)

const testUser = "30a9cb8b-f094-4821-bc6d-d0b0cd426e60"

// A fixed zone that is not UTC, the way some nodes run on CST: a parser
// that quietly read the stamp as UTC would be eight hours out, and only
// a zone like this one shows it.
var cst = time.FixedZone("CST", 8*60*60)

func TestParseLine(t *testing.T) {
	at := func(s string) time.Time {
		t.Helper()
		v, err := time.ParseInLocation("2006/01/02 15:04:05.999999", s, cst)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}

	cases := []struct {
		name string
		line string
		want *Entry // nil: the line must be skipped
	}{
		{
			name: "vless, name, microsecond stamp",
			line: "2026/10/28 08:20:17.560474 from tcp:203.0.113.5:51752 accepted tcp:example.com:443 [vless-in >> direct] email: " + testUser,
			want: &Entry{At: at("2026/10/28 08:20:17.560474"), User: testUser, InboundTag: "vless-in", Network: "tcp", Host: "example.com", Port: 443},
		},
		{
			name: "shadowsocks, no network prefix on either side, whole-second stamp",
			line: "2026/10/28 08:21:40 from 203.0.113.5:4411 accepted 198.51.100.63:443 [shadowsocks-in >> direct] email: 2ed003d5-0000-4000-8000-000000000001",
			want: &Entry{At: at("2026/10/28 08:21:40"), User: "2ed003d5-0000-4000-8000-000000000001", InboundTag: "shadowsocks-in", Network: "tcp", Host: "198.51.100.63", Port: 443},
		},
		{
			name: "udp destination",
			line: "2026/10/28 08:22:03.004120 from tcp:203.0.113.5:51760 accepted udp:198.18.0.3:137 [vless-in >> direct] email: " + testUser,
			want: &Entry{At: at("2026/10/28 08:22:03.004120"), User: testUser, InboundTag: "vless-in", Network: "udp", Host: "198.18.0.3", Port: 137},
		},
		{
			name: "ipv6 destination loses its brackets",
			line: "2026/10/28 08:22:09.118342 from tcp:203.0.113.5:51761 accepted tcp:[2001:db8::1]:443 [vless-in >> direct] email: " + testUser,
			want: &Entry{At: at("2026/10/28 08:22:09.118342"), User: testUser, InboundTag: "vless-in", Network: "tcp", Host: "2001:db8::1", Port: 443},
		},
		{
			name: "ipv6 source does not confuse the destination",
			line: "2026/10/28 08:22:10.000001 from tcp:[2001:db8::9]:40000 accepted tcp:example.org:80 [trojan-in -> direct] email: " + testUser,
			want: &Entry{At: at("2026/10/28 08:22:10.000001"), User: testUser, InboundTag: "trojan-in", Network: "tcp", Host: "example.org", Port: 80},
		},
		{
			name: "routed by balancer arrow",
			line: "2026/10/28 08:22:11.5 from tcp:203.0.113.5:1 accepted tcp:example.net:8443 [vless-ws-in ==> exit-1] email: " + testUser,
			want: &Entry{At: at("2026/10/28 08:22:11.5"), User: testUser, InboundTag: "vless-ws-in", Network: "tcp", Host: "example.net", Port: 8443},
		},
		{
			name: "detour with no inbound names only the outbound",
			line: "2026/10/28 08:22:12 from tcp:203.0.113.5:1 accepted tcp:example.net:443 [direct] email: " + testUser,
			want: &Entry{At: at("2026/10/28 08:22:12"), User: testUser, InboundTag: "", Network: "tcp", Host: "example.net", Port: 443},
		},
		{
			name: "no detour at all",
			line: "2026/10/28 08:22:13 from tcp:203.0.113.5:1 accepted tcp:example.net:443 email: " + testUser,
			want: &Entry{At: at("2026/10/28 08:22:13"), User: testUser, InboundTag: "", Network: "tcp", Host: "example.net", Port: 443},
		},
		{
			name: "a reason between detour and email",
			line: "2026/10/28 08:22:14 from tcp:203.0.113.5:1 accepted tcp:example.net:443 [vless-in >> direct] some reason: here email: " + testUser,
			want: &Entry{At: at("2026/10/28 08:22:14"), User: testUser, InboundTag: "vless-in", Network: "tcp", Host: "example.net", Port: 443},
		},
		{
			name: "windows line end",
			line: "2026/10/28 08:22:15 from tcp:203.0.113.5:1 accepted tcp:example.net:443 [vless-in >> direct] email: " + testUser + "\r",
			want: &Entry{At: at("2026/10/28 08:22:15"), User: testUser, InboundTag: "vless-in", Network: "tcp", Host: "example.net", Port: 443},
		},

		// Skipped.
		{name: "uot pseudo-destination", line: "2026/10/28 08:23:00.1 from 203.0.113.5:4411 accepted sp.v2.udp-over-tcp.arpa:0 [shadowsocks-in -> uot-direct] email: " + testUser},
		{name: "uot v1 pseudo-destination", line: "2026/10/28 08:23:00.1 from 203.0.113.5:4411 accepted tcp:v1.udp-over-tcp.arpa:0 [shadowsocks-in -> uot-direct] email: " + testUser},
		{name: "rejected handshake", line: "2026/10/28 08:23:01 from 203.0.113.9:1 rejected proxy/trojan: not trojan protocol"},
		{name: "rejected with an email", line: "2026/10/28 08:23:01 from 203.0.113.9:1 rejected tcp:example.com:443 [vless-in >> block] email: " + testUser},
		{name: "accepted without email", line: "2026/10/28 08:23:02 from tcp:127.0.0.1:50000 accepted tcp:127.0.0.1:10085 [api -> api]"},
		{name: "empty email", line: "2026/10/28 08:23:02 from tcp:127.0.0.1:50000 accepted tcp:example.com:443 [vless-in >> direct] email: "},
		{name: "empty line", line: ""},
		{name: "not a log line", line: "Xray 26.3.27 (Xray, Penetrates Everything.) started"},
		{name: "bad date", line: "2026/13/45 08:23:03 from tcp:203.0.113.5:1 accepted tcp:example.com:443 [vless-in >> direct] email: " + testUser},
		{name: "no time", line: "2026/10/28 from tcp:203.0.113.5:1 accepted tcp:example.com:443 email: " + testUser},
		{name: "destination without port", line: "2026/10/28 08:23:04 from tcp:203.0.113.5:1 accepted tcp:example.com [vless-in >> direct] email: " + testUser},
		{name: "port out of range", line: "2026/10/28 08:23:04 from tcp:203.0.113.5:1 accepted tcp:example.com:70000 [vless-in >> direct] email: " + testUser},
		{name: "unbracketed ipv6 garbage port", line: "2026/10/28 08:23:04 from tcp:203.0.113.5:1 accepted tcp:[2001:db8::1 [vless-in >> direct] email: " + testUser},
		{name: "empty host", line: "2026/10/28 08:23:04 from tcp:203.0.113.5:1 accepted tcp::443 [vless-in >> direct] email: " + testUser},
		{name: "unix destination", line: "2026/10/28 08:23:04 from tcp:203.0.113.5:1 accepted unix:/run/x.sock [vless-in >> direct] email: " + testUser},
		{name: "host longer than any dns name", line: "2026/10/28 08:23:05 from tcp:203.0.113.5:1 accepted tcp:" + strings.Repeat("a", maxHostLen+1) + ":443 [vless-in >> direct] email: " + testUser},
		{name: "invalid utf-8 host", line: "2026/10/28 08:23:06 from tcp:203.0.113.5:1 accepted tcp:ex\xffample.com:443 [vless-in >> direct] email: " + testUser},
		{name: "control character in host", line: "2026/10/28 08:23:06 from tcp:203.0.113.5:1 accepted tcp:ex\x01ample.com:443 [vless-in >> direct] email: " + testUser},
		{name: "truncated mid-line", line: "2026/10/28 08:23:07.12 from tcp:203.0.113.5:1 accep"},
		{name: "fragment of a line", line: "ample.com:443 [vless-in >> direct] email: " + testUser},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := ParseLine(tc.line, cst)
			if tc.want == nil {
				if ok {
					t.Fatalf("want skipped, got %+v", got)
				}
				return
			}
			if !ok {
				t.Fatal("want parsed, got skipped")
			}
			if !got.At.Equal(tc.want.At) {
				t.Errorf("At = %v, want %v", got.At, tc.want.At)
			}
			got.At, tc.want.At = time.Time{}, time.Time{}
			if got != *tc.want {
				t.Errorf("got  %+v\nwant %+v", got, *tc.want)
			}
		})
	}
}

// The stamp is the node's local wall clock. The same text must mean a
// different instant in a different zone, or the parser is ignoring the
// zone it was given.
func TestParseLineUsesTheGivenZone(t *testing.T) {
	line := "2026/10/28 08:20:17.560474 from tcp:203.0.113.5:51752 accepted tcp:example.com:443 [vless-in >> direct] email: " + testUser
	inCST, ok := ParseLine(line, cst)
	if !ok {
		t.Fatal("not parsed")
	}
	inUTC, ok := ParseLine(line, time.UTC)
	if !ok {
		t.Fatal("not parsed")
	}
	if d := inUTC.At.Sub(inCST.At); d != 8*time.Hour {
		t.Fatalf("UTC reading minus CST reading = %s, want 8h", d)
	}
	if want := time.Date(2026, 10, 28, 0, 20, 17, 560474000, time.UTC); !inCST.At.Equal(want) {
		t.Fatalf("CST stamp = %s, want %s", inCST.At.UTC(), want)
	}
}

func TestEnabled(t *testing.T) {
	for setting, want := range map[string]bool{
		"":         true,
		"on":       true,
		"1":        true,
		"yes":      true,
		"anything": true,
		"off":      false,
		"OFF":      false,
		" off ":    false,
		"0":        false,
		"false":    false,
		"no":       false,
		"disabled": false,
	} {
		if got := Enabled(setting); got != want {
			t.Errorf("Enabled(%q) = %v, want %v", setting, got, want)
		}
	}
}
