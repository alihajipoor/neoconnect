package controlplane

import (
	"testing"

	"google.golang.org/protobuf/proto"

	"github.com/neoxify/neoxify-hub/agent/internal/controlplane/pb"
	"github.com/neoxify/neoxify-hub/agent/internal/dispatch"
	"github.com/neoxify/neoxify-hub/agent/internal/protocols/common"
)

// What the backend reads: the engine's count untouched, and the addresses
// behind it in the order the engine gave them. Through a real marshal, so
// a generated file that never gained field 4 fails here rather than on a
// node, where the addresses would simply never arrive.
func TestSessionsGoOnTheWireWithTheirAddresses(t *testing.T) {
	in := []dispatch.SessionCount{
		{
			ExternalUserID:  "u-1",
			Protocol:        "XRAY_VLESS_REALITY",
			DistinctSources: 3,
			Sources: []common.SourceAddress{
				{Address: "2001:db8::7", SecondsAgo: 0},
				{Address: "203.0.113.9", SecondsAgo: 41},
			},
		},
		// An engine that saw nobody's address still sends its count.
		{ExternalUserID: "u-2", Protocol: "OPENVPN", DistinctSources: 1},
	}

	wire, err := proto.Marshal(&pb.StatsBatch{Sessions: sessionsToPB(in)})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got pb.StatsBatch
	if err := proto.Unmarshal(wire, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if len(got.Sessions) != 2 {
		t.Fatalf("expected 2 sessions, got %d", len(got.Sessions))
	}
	first := got.Sessions[0]
	if first.GetExternalUserId() != "u-1" || first.GetProtocol() != "XRAY_VLESS_REALITY" || first.GetDistinctSources() != 3 {
		t.Fatalf("count not carried as given: %v", first)
	}
	sources := first.GetSources()
	if len(sources) != 2 ||
		sources[0].GetAddress() != "2001:db8::7" || sources[0].GetSecondsAgo() != 0 ||
		sources[1].GetAddress() != "203.0.113.9" || sources[1].GetSecondsAgo() != 41 {
		t.Fatalf("sources not carried in order: %v", sources)
	}
	if second := got.Sessions[1]; second.GetDistinctSources() != 1 || len(second.GetSources()) != 0 {
		t.Fatalf("a count with no addresses changed on the way: %v", second)
	}
}
