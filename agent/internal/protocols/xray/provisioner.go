// Package xray implements common.Provisioner against a locally running
// Xray-core instance's gRPC API (HandlerService for user CRUD,
// StatsService for usage counters). This is the reference implementation
// of the hot-update contract every protocol provisioner has to satisfy:
// CreateUser/RemoveUser touch exactly one client on the running inbound,
// no restart, no effect on any other connected user.
package xray

import (
	"context"
	"fmt"
	"strings"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	hcommand "github.com/xtls/xray-core/app/proxyman/command"
	scommand "github.com/xtls/xray-core/app/stats/command"
	"github.com/xtls/xray-core/common/protocol"
	"github.com/xtls/xray-core/common/serial"
	"github.com/xtls/xray-core/proxy/vless"

	"github.com/neoxify/neoxify-hub/agent/internal/protocols/common"
)

// Provisioner talks to Xray-core's local API server -- the `api` inbound
// configured in xray's config.json (dokodemo-door on 127.0.0.1, with
// HandlerService/StatsService enabled under `api.services`). It manages
// exactly one inbound, identified by tag, which is where the actual
// VLESS+REALITY listener lives.
type Provisioner struct {
	apiAddr     string
	inboundTag  string
	conn        *grpc.ClientConn
	handlerConn hcommand.HandlerServiceClient
	statsConn   scommand.StatsServiceClient
}

func New(apiAddr, inboundTag string) (*Provisioner, error) {
	conn, err := grpc.NewClient(apiAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, fmt.Errorf("connect to xray api at %s: %w", apiAddr, err)
	}
	return &Provisioner{
		apiAddr:     apiAddr,
		inboundTag:  inboundTag,
		conn:        conn,
		handlerConn: hcommand.NewHandlerServiceClient(conn),
		statsConn:   scommand.NewStatsServiceClient(conn),
	}, nil
}

func (p *Provisioner) Close() error {
	return p.conn.Close()
}

// Conn exposes the underlying connection to Xray's local API so other
// packages (agent/internal/relay) can talk to the same Xray process
// without dialing a second connection.
func (p *Provisioner) Conn() *grpc.ClientConn {
	return p.conn
}

func (p *Provisioner) CreateUser(ctx context.Context, user common.ProtocolUser) error {
	account := &vless.Account{
		Id:   user.Credentials["uuid"],
		Flow: user.Credentials["flow"],
	}
	if account.Id == "" {
		return fmt.Errorf("xray CreateUser: credentials missing uuid")
	}

	_, err := p.handlerConn.AlterInbound(ctx, &hcommand.AlterInboundRequest{
		Tag: p.inboundTag,
		Operation: serial.ToTypedMessage(&hcommand.AddUserOperation{
			User: &protocol.User{
				Level:   0,
				Email:   user.ExternalUserID,
				Account: serial.ToTypedMessage(account),
			},
		}),
	})
	if err != nil {
		// Xray errors on a duplicate email rather than upserting -- treat
		// that specific case as success so CreateUser is safely retryable
		// (e.g. after an ENABLE_USER command that re-adds an already-live
		// user because a prior DISABLE_USER's ack was lost).
		if strings.Contains(err.Error(), "already exists") {
			return nil
		}
		return fmt.Errorf("xray AlterInbound (add user %s): %w", user.ExternalUserID, err)
	}
	return nil
}

func (p *Provisioner) UpdateUser(ctx context.Context, user common.ProtocolUser) error {
	// Xray has no in-place "update a client" operation -- remove and
	// recreate. Still satisfies the no-interruption contract: only this
	// one user's session drops (briefly), everyone else on the inbound is
	// untouched throughout.
	_ = p.RemoveUser(ctx, user.ExternalUserID)
	return p.CreateUser(ctx, user)
}

func (p *Provisioner) RemoveUser(ctx context.Context, externalUserID string) error {
	_, err := p.handlerConn.AlterInbound(ctx, &hcommand.AlterInboundRequest{
		Tag: p.inboundTag,
		Operation: serial.ToTypedMessage(&hcommand.RemoveUserOperation{
			Email: externalUserID,
		}),
	})
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			return nil // already gone -- deleting twice is not an error
		}
		return fmt.Errorf("xray AlterInbound (remove user %s): %w", externalUserID, err)
	}
	return nil
}

// SetEnabled(false) removes the user (only this session drops). Xray has
// no separate "disabled but still configured" state, and re-enabling
// needs the original credentials -- which this interface doesn't carry --
// so enabled=true returns an error. Callers should issue CreateUser with
// the full credentials to re-enable a user instead of calling this.
func (p *Provisioner) SetEnabled(ctx context.Context, externalUserID string, enabled bool) error {
	if !enabled {
		return p.RemoveUser(ctx, externalUserID)
	}
	return fmt.Errorf("xray SetEnabled(true) not supported -- use CreateUser with the user's credentials")
}

func (p *Provisioner) StatsSince(ctx context.Context) ([]common.UsageDelta, error) {
	byUser := make(map[string]*common.UsageDelta)

	// A single "user>>>" pattern query matches every stat name of the
	// form user>>>{email}>>>traffic>>>{uplink|downlink} at once, both
	// directions included -- no need to query per-direction.
	resp, err := p.statsConn.QueryStats(ctx, &scommand.QueryStatsRequest{
		Pattern: "user>>>",
		Reset_:  true,
	})
	if err != nil {
		return nil, fmt.Errorf("xray QueryStats: %w", err)
	}
	for _, stat := range resp.GetStat() {
		parts := strings.Split(stat.GetName(), ">>>")
		if len(parts) != 4 || parts[0] != "user" || parts[2] != "traffic" {
			continue
		}
		email := parts[1]
		delta, ok := byUser[email]
		if !ok {
			delta = &common.UsageDelta{ExternalUserID: email}
			byUser[email] = delta
		}
		switch parts[3] {
		case "uplink":
			delta.BytesUp += uint64(stat.GetValue())
		case "downlink":
			delta.BytesDown += uint64(stat.GetValue())
		}
	}

	deltas := make([]common.UsageDelta, 0, len(byUser))
	for _, d := range byUser {
		if d.BytesUp > 0 || d.BytesDown > 0 {
			deltas = append(deltas, *d)
		}
	}
	return deltas, nil
}
