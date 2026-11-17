package neoxifyxray

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"testing"
)

// Every config the app builds (testdata/app-configs.json, written by
// xray-config.ts) must be accepted by this engine. Each section and
// outbound is an xray-core feature that exists only when its package is
// imported in xray.go, and core.New refuses a config naming one that is
// not -- which on a phone is every Xray connect failing. Unlike the
// darwin end-to-end tests this runs anywhere: the TUN inbound is left out,
// since it would open a device, and nothing is started.
func TestEveryAppConfigBuilds(t *testing.T) {
	data, err := os.ReadFile("testdata/app-configs.json")
	if err != nil {
		t.Fatal(err)
	}
	var all map[string]map[string]any
	if err := json.Unmarshal(data, &all); err != nil {
		t.Fatal(err)
	}
	if len(all) == 0 {
		t.Fatal("the fixture holds no configs")
	}
	for name, cfg := range all {
		t.Run(name, func(t *testing.T) {
			delete(cfg, "inbounds")
			// The fixture's placeholder keys are not base64, and the
			// Shadowsocks 2022 method decodes its key when built. Two
			// throwaway 32-byte keys, as the end-to-end tests put in.
			out := cfg["outbounds"].([]any)[0].(map[string]any)
			if out["protocol"] == "shadowsocks" {
				key := base64.StdEncoding.EncodeToString(make([]byte, 32))
				out["settings"].(map[string]any)["servers"].([]any)[0].(map[string]any)["password"] = key + ":" + key
			}
			b, err := json.Marshal(cfg)
			if err != nil {
				t.Fatal(err)
			}
			inst, err := build(string(b))
			if err != nil {
				t.Fatalf("the app's %s config was refused: %v", name, err)
			}
			inst.Close()
		})
	}
}
