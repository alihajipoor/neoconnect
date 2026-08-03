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
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	hcommand "github.com/xtls/xray-core/app/proxyman/command"
	scommand "github.com/xtls/xray-core/app/stats/command"
	"github.com/xtls/xray-core/common/protocol"
	"github.com/xtls/xray-core/common/serial"
	"github.com/xtls/xray-core/proxy/trojan"
	"github.com/xtls/xray-core/proxy/vless"

	"github.com/neoxify/neoxify-hub/agent/internal/protocols/common"
)

// Provisioner talks to Xray-core's local API server -- the `api` inbound
// configured in xray's config.json (dokodemo-door on 127.0.0.1, with
// HandlerService/StatsService enabled under `api.services`). It manages
// exactly one inbound, identified by tag, which is where the actual
// VLESS+REALITY listener lives.
type Provisioner struct {
	apiAddr    string
	inboundTag string
	kind       accountKind
	ownsConn   bool
	// Whether this provisioner reports the Xray process's usage stats.
	// Exactly one may -- see StatsSince.
	reportsStats bool
	conn         *grpc.ClientConn
	handlerConn  hcommand.HandlerServiceClient
	statsConn    scommand.StatsServiceClient
	sessions     *SessionCounter
}

// Which credential shape an inbound authenticates with.
//
// Xray runs several proxy protocols in one process, and they differ only
// in the account message attached to a user -- the add/remove RPC, the
// stats keys and the no-restart guarantee are identical. So one
// provisioner serves them all, parameterised by this.
type accountKind int

const (
	kindVLESS accountKind = iota
	// Trojan authenticates with a shared secret and, on a wrong one,
	// answers exactly like the web server it is pretending to be. That
	// is its whole disguise, and it is why the password is generated
	// with real entropy rather than being a UUID.
	kindTrojan
)

// How far back a client address still counts as "currently connected".
// Long enough to span a quiet period on an idle connection, short enough
// that a user who genuinely moved networks stops looking like two.
const sessionWindow = 5 * time.Minute

func New(apiAddr, inboundTag, accessLogPath string) (*Provisioner, error) {
	conn, err := grpc.NewClient(apiAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, fmt.Errorf("connect to xray api at %s: %w", apiAddr, err)
	}
	return &Provisioner{
		apiAddr:      apiAddr,
		inboundTag:   inboundTag,
		kind:         kindVLESS,
		ownsConn:     true,
		reportsStats: true,
		conn:         conn,
		handlerConn:  hcommand.NewHandlerServiceClient(conn),
		statsConn:    scommand.NewStatsServiceClient(conn),
		sessions:     NewSessionCounter(accessLogPath, sessionWindow),
	}, nil
}

// SessionCounts reports how many distinct client addresses each user is
// active from. Empty when access logging isn't enabled on this node --
// absent counts mean "unknown" to the server, never "zero", so a node
// without logging can't cause anyone to be disconnected.
func (p *Provisioner) SessionCounts() (map[string]int, error) {
	return p.sessions.Counts()
}

// ForInbound returns a provisioner for another inbound running in the
// same Xray process, sharing this one's connection.
//
// Sharing rather than dialling again is the same reasoning behind Conn()
// below: it is one process with one API listener, and a second
// connection would be a second thing to fail and to reconnect. The
// derived provisioner does not own the connection, so closing it must
// not take the original's out from under it.
//
// Session counting is deliberately not shared -- it is derived from the
// access log, which records the inbound tag, so a Trojan inbound needs
// its own counter keyed to its own tag. Passing the same one would
// attribute Trojan sessions to VLESS users.
func (p *Provisioner) ForInbound(kind accountKind, inboundTag, accessLogPath string) *Provisioner {
	return &Provisioner{
		apiAddr:    p.apiAddr,
		inboundTag: inboundTag,
		kind:       kind,
		ownsConn:   false,
		// Deliberately false: stats are per-process, not per-inbound.
		reportsStats: false,
		conn:         p.conn,
		handlerConn:  p.handlerConn,
		statsConn:    p.statsConn,
		sessions:     NewSessionCounter(accessLogPath, sessionWindow),
	}
}

// ForTrojan is the Trojan inbound on this same process.
func (p *Provisioner) ForTrojan(inboundTag, accessLogPath string) *Provisioner {
	return p.ForInbound(kindTrojan, inboundTag, accessLogPath)
}

// ForVless is a second VLESS inbound on this same process -- the
// certificate-presenting one, alongside the REALITY inbound this
// provisioner was built for. Same account shape, different listener:
// what differs between the two is entirely in how the inbound wraps the
// connection, which is the config file's business and not this code's.
func (p *Provisioner) ForVless(inboundTag, accessLogPath string) *Provisioner {
	return p.ForInbound(kindVLESS, inboundTag, accessLogPath)
}

func (p *Provisioner) Close() error {
	if !p.ownsConn {
		return nil
	}
	return p.conn.Close()
}

// Conn exposes the underlying connection to Xray's local API so other
// packages (agent/internal/relay) can talk to the same Xray process
// without dialing a second connection.
func (p *Provisioner) Conn() *grpc.ClientConn {
	return p.conn
}

// account builds the credential message for this inbound's protocol.
//
// The missing-field checks are not defensive noise: Xray accepts an
// account with an empty id or password without complaint, and the result
// is an inbound that silently authenticates nobody. Failing here means
// the command is nacked and the control plane can say why, rather than a
// customer discovering it by not being able to connect.
func (p *Provisioner) account(user common.ProtocolUser) (*serial.TypedMessage, error) {
	switch p.kind {
	case kindTrojan:
		password := user.Credentials["password"]
		if password == "" {
			return nil, fmt.Errorf("xray CreateUser: trojan credentials missing password")
		}
		return serial.ToTypedMessage(&trojan.Account{Password: password}), nil
	default:
		id := user.Credentials["uuid"]
		if id == "" {
			return nil, fmt.Errorf("xray CreateUser: credentials missing uuid")
		}
		return serial.ToTypedMessage(&vless.Account{
			Id:   id,
			Flow: user.Credentials["flow"],
		}), nil
	}
}

func (p *Provisioner) CreateUser(ctx context.Context, user common.ProtocolUser) error {
	account, err := p.account(user)
	if err != nil {
		return err
	}

	_, err = p.handlerConn.AlterInbound(ctx, &hcommand.AlterInboundRequest{
		Tag: p.inboundTag,
		Operation: serial.ToTypedMessage(&hcommand.AddUserOperation{
			User: &protocol.User{
				Level:   0,
				Email:   user.ExternalUserID,
				Account: account,
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
	// Xray keeps usage per user, not per inbound: the "user>>>" pattern
	// below matches every user in the process whichever inbound they
	// belong to, and the query drains the counters as it reads them. So
	// exactly one provisioner may report, no matter how many inbounds
	// this process serves.
	//
	// With more than one reporting, each poll a different one won the
	// map-iteration race, drained everything, and labelled all of it
	// with its own protocol -- and the control plane dropped every delta
	// whose label did not match the user's real protocol. Roughly half
	// the node's traffic disappeared, at random, with nothing logged.
	// Found after registering a second Xray inbound for Trojan.
	if !p.reportsStats {
		return nil, nil
	}

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
