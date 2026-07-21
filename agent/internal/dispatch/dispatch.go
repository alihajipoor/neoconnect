// Package dispatch routes an incoming Command from the control plane to
// whichever protocol provisioner it targets. Kept separate from
// controlplane so the gRPC stream plumbing doesn't need to know anything
// about protocol-specific payload shapes.
package dispatch

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/neoxify/neoxify-hub/agent/internal/controlplane/pb"
	"github.com/neoxify/neoxify-hub/agent/internal/protocols/common"
)

// commandPayload is the payloadJson shape for every command type. Not
// every field is required for every type -- see Execute.
type commandPayload struct {
	Protocol       string            `json:"protocol"`
	ExternalUserID string            `json:"externalUserId"`
	Credentials    map[string]string `json:"credentials"`
}

// Dispatcher holds one provisioner per protocol this node runs. A node
// only has the protocols its ProtocolConfigs actually configure, so this
// map is built at startup from whatever the agent was set up to manage --
// today just Xray; WireGuard/OpenVPN register here too once M4/M8 land.
type Dispatcher struct {
	provisioners map[string]common.Provisioner
}

func New() *Dispatcher {
	return &Dispatcher{provisioners: make(map[string]common.Provisioner)}
}

func (d *Dispatcher) Register(protocol string, p common.Provisioner) {
	d.provisioners[protocol] = p
}

// Execute runs the given command against the right provisioner and
// returns the outcome for a CommandAck. Never returns a Go error itself --
// every failure mode (bad payload, unknown protocol, provisioner error)
// is reported back to the control plane as a failed ack instead, since a
// malformed single command must not tear down the whole sync stream.
func (d *Dispatcher) Execute(ctx context.Context, cmd *pb.Command) (success bool, errMsg string) {
	var payload commandPayload
	if err := json.Unmarshal(cmd.GetPayloadJson(), &payload); err != nil {
		return false, fmt.Sprintf("invalid command payload: %v", err)
	}

	provisioner, ok := d.provisioners[payload.Protocol]
	if !ok {
		return false, fmt.Sprintf("no provisioner registered for protocol %q on this node", payload.Protocol)
	}

	user := common.ProtocolUser{ExternalUserID: payload.ExternalUserID, Credentials: payload.Credentials}

	var err error
	switch cmd.GetType() {
	case pb.CommandType_CREATE_USER, pb.CommandType_ENABLE_USER:
		err = provisioner.CreateUser(ctx, user)
	case pb.CommandType_UPDATE_USER:
		err = provisioner.UpdateUser(ctx, user)
	case pb.CommandType_DELETE_USER:
		err = provisioner.RemoveUser(ctx, payload.ExternalUserID)
	case pb.CommandType_DISABLE_USER:
		err = provisioner.SetEnabled(ctx, payload.ExternalUserID, false)
	case pb.CommandType_SYNC, pb.CommandType_SET_QUOTA:
		return false, fmt.Sprintf("command type %s not implemented yet", cmd.GetType())
	default:
		return false, fmt.Sprintf("unrecognized command type %s", cmd.GetType())
	}

	if err != nil {
		return false, err.Error()
	}
	return true, ""
}
