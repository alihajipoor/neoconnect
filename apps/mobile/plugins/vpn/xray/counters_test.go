package neoxifyxray

import "testing"

// The config the app builds (xray-config.ts) asks for "stats" and a
// system "policy" counting the outbound. Both are xray-core apps that
// exist only when their packages are imported; a config naming one that
// is not is refused by core.New, and that refusal would be every Xray
// connect on both phones. These build the same two sections, with a
// direct outbound in place of a server, and read the counters back.

const countedConfig = `{
  "log": {"loglevel": "warning"},
  "stats": {},
  "policy": {"system": {"statsOutboundUplink": true, "statsOutboundDownlink": true}},
  "outbounds": [{"tag": "proxy", "protocol": "freedom"}]
}`

func TestTheAppsCountedConfigBuilds(t *testing.T) {
	inst, err := build(countedConfig)
	if err != nil {
		t.Fatalf("the counted config was refused: %v", err)
	}
	defer inst.Close()
	if got := counterOf(inst, uplinkCounter); got != 0 {
		t.Fatalf("uplink counter = %d, want 0 -- registered and nothing sent yet", got)
	}
	if got := counterOf(inst, downlinkCounter); got != 0 {
		t.Fatalf("downlink counter = %d, want 0", got)
	}
}

func TestNoCounterIsMinusOneNotZero(t *testing.T) {
	inst, err := build(`{"outbounds": [{"tag": "proxy", "protocol": "freedom"}]}`)
	if err != nil {
		t.Fatalf("a config without counters was refused: %v", err)
	}
	defer inst.Close()
	if got := counterOf(inst, uplinkCounter); got != -1 {
		t.Fatalf("uplink with no stats = %d, want -1", got)
	}
	if got := counterOf(nil, downlinkCounter); got != -1 {
		t.Fatalf("downlink with no instance = %d, want -1", got)
	}
}
