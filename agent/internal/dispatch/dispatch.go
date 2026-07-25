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
	"github.com/neoxify/neoxify-hub/agent/internal/relay"
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
// map is built at startup from whatever the agent was set up to manage.
// relayProvisioner is separate -- CONFIGURE_ROUTE/REMOVE_ROUTE target a
// relay node's local Xray process directly, not a per-protocol-user
// contract, so they're routed to it before the per-protocol lookup below.
type Dispatcher struct {
	provisioners     map[string]common.Provisioner
	relayProvisioner *relay.Provisioner
}

func New() *Dispatcher {
	return &Dispatcher{provisioners: make(map[string]common.Provisioner)}
}

func (d *Dispatcher) Register(protocol string, p common.Provisioner) {
	d.provisioners[protocol] = p
}

func (d *Dispatcher) RegisterRelay(p *relay.Provisioner) {
	d.relayProvisioner = p
}

// CollectStats polls every registered protocol's provisioner for usage
// deltas since the last poll, tagging each with the protocol it came
// from (provisioners don't know their own Protocol enum string -- see
// common.UsageDelta). One protocol erroring doesn't stop the others from
// reporting; errors are logged by the caller, not returned, so a
// transient StatsSince failure on one engine never blocks the whole
// StatsBatch.
func (d *Dispatcher) CollectStats(ctx context.Context) ([]common.UsageDelta, []error) {
	var deltas []common.UsageDelta
	var errs []error
	for protocol, provisioner := range d.provisioners {
		protoDeltas, err := provisioner.StatsSince(ctx)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s StatsSince: %w", protocol, err))
			continue
		}
		for i := range protoDeltas {
			protoDeltas[i].Protocol = protocol
		}
		deltas = append(deltas, protoDeltas...)
	}
	return deltas, errs
}

// SessionReporter is implemented by provisioners that can say how many
// distinct places each user is connected from.
//
// Optional on purpose: only Xray both needs this and can answer it. The
// other engines are already self-limiting -- OpenVPN replaces a session
// when the same certificate reconnects, and a WireGuard peer holds one
// endpoint at a time -- so a shared credential doesn't buy real
// concurrency there and there's nothing to report.
type SessionReporter interface {
	SessionCounts() (map[string]int, error)
}

// SessionCount pairs a user with how many distinct sources they're
// currently active from.
type SessionCount struct {
	ExternalUserID  string
	Protocol        string
	DistinctSources uint32
}

// CollectSessionCounts asks every provisioner that can report
// concurrency. Errors are returned rather than swallowed so the caller
// can log them, but they never stop the other protocols from reporting --
// same contract as CollectStats.
func (d *Dispatcher) CollectSessionCounts() ([]SessionCount, []error) {
	var counts []SessionCount
	var errs []error
	for protocol, provisioner := range d.provisioners {
		reporter, ok := provisioner.(SessionReporter)
		if !ok {
			continue
		}
		perUser, err := reporter.SessionCounts()
		if err != nil {
			errs = append(errs, fmt.Errorf("%s SessionCounts: %w", protocol, err))
			continue
		}
		for user, n := range perUser {
			counts = append(counts, SessionCount{
				ExternalUserID:  user,
				Protocol:        protocol,
				DistinctSources: uint32(n),
			})
		}
	}
	return counts, errs
}

// Execute runs the given command against the right provisioner and
// returns the outcome for a CommandAck. Never returns a Go error itself --
// every failure mode (bad payload, unknown protocol, provisioner error)
// is reported back to the control plane as a failed ack instead, since a
// malformed single command must not tear down the whole sync stream.
func (d *Dispatcher) Execute(ctx context.Context, cmd *pb.Command) (success bool, errMsg string) {
	if cmd.GetType() == pb.CommandType_CONFIGURE_ROUTE || cmd.GetType() == pb.CommandType_REMOVE_ROUTE {
		return d.executeRouteCommand(ctx, cmd)
	}

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

func (d *Dispatcher) executeRouteCommand(ctx context.Context, cmd *pb.Command) (success bool, errMsg string) {
	if d.relayProvisioner == nil {
		return false, "this node has no relay provisioner registered (not a relay node)"
	}

	var err error
	switch cmd.GetType() {
	case pb.CommandType_CONFIGURE_ROUTE:
		var payload relay.ConfigureRoutePayload
		if unmarshalErr := json.Unmarshal(cmd.GetPayloadJson(), &payload); unmarshalErr != nil {
			return false, fmt.Sprintf("invalid CONFIGURE_ROUTE payload: %v", unmarshalErr)
		}
		err = d.relayProvisioner.ConfigureRoute(ctx, payload)
	case pb.CommandType_REMOVE_ROUTE:
		var payload relay.RemoveRoutePayload
		if unmarshalErr := json.Unmarshal(cmd.GetPayloadJson(), &payload); unmarshalErr != nil {
			return false, fmt.Sprintf("invalid REMOVE_ROUTE payload: %v", unmarshalErr)
		}
		err = d.relayProvisioner.RemoveRoute(ctx, payload.RouteID)
	}

	if err != nil {
		return false, err.Error()
	}
	return true, ""
}
