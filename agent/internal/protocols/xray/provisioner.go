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
	shadowsocks2022 "github.com/xtls/xray-core/proxy/shadowsocks_2022"
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
	// Kept so a provisioner can be re-pointed at another inbound of the
	// same kind (see WithInboundTag) without the caller having to know
	// where this node writes its access log.
	accessLogPath string
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
	// Shadowsocks 2022. The account carries a per-user pre-shared key,
	// and the inbound holds a second key shared by everyone on it --
	// clients authenticate with both. Only the per-user half is set
	// here; the shared half belongs to the config file.
	kindShadowsocks2022
)

// How far back a client address still counts as "currently connected".
//
// Sixty seconds, down from five minutes, and the reason is the customer
// base rather than the protocol. Iranian mobile carriers rotate a
// subscriber's address constantly. When that happens the old address is
// still inside the window while the new one is already active, so ONE
// phone reads as two sources -- and on Starter, whose limit is one, that
// is over the limit on every poll until the window expires.
//
// At five minutes that lasted ten consecutive polls, which is far past
// the three strikes the server needs to act: a single paying customer
// on mobile data would be disconnected for changing cell. No strike
// threshold fixes that, because the window outlasts any of them; the
// window is the only lever.
//
// Sixty seconds keeps a rotated address around for about two polls,
// which cannot reach three strikes. The cost is that a genuinely idle
// second device stops being counted after a minute of silence -- so a
// sharer with two devices, one of them idle, is missed. That is the
// right way round to be wrong: a missed sharer costs bandwidth, a false
// disconnect costs a paying customer who did nothing.
const sessionWindow = 60 * time.Second

func New(apiAddr, inboundTag, accessLogPath string) (*Provisioner, error) {
	conn, err := grpc.NewClient(apiAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, fmt.Errorf("connect to xray api at %s: %w", apiAddr, err)
	}
	return &Provisioner{
		apiAddr:       apiAddr,
		inboundTag:    inboundTag,
		kind:          kindVLESS,
		ownsConn:      true,
		accessLogPath: accessLogPath,
		reportsStats:  true,
		conn:          conn,
		handlerConn:   hcommand.NewHandlerServiceClient(conn),
		statsConn:     scommand.NewStatsServiceClient(conn),
		sessions:      NewSessionCounter(accessLogPath, sessionWindow),
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
		apiAddr:       p.apiAddr,
		inboundTag:    inboundTag,
		kind:          kind,
		ownsConn:      false,
		accessLogPath: accessLogPath,
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

// ForShadowsocks is the Shadowsocks 2022 inbound on this same process.
func (p *Provisioner) ForShadowsocks(inboundTag, accessLogPath string) *Provisioner {
	return p.ForInbound(kindShadowsocks2022, inboundTag, accessLogPath)
}

// ForVless is a second VLESS inbound on this same process -- the
// certificate-presenting one, alongside the REALITY inbound this
// provisioner was built for. Same account shape, different listener:
// what differs between the two is entirely in how the inbound wraps the
// connection, which is the config file's business and not this code's.
func (p *Provisioner) ForVless(inboundTag, accessLogPath string) *Provisioner {
	return p.ForInbound(kindVLESS, inboundTag, accessLogPath)
}

// WithInboundTag re-points this provisioner at a different inbound of
// the same account kind on the same Xray process.
//
// Exists because a relay node can now run two inbounds of one protocol
// -- one per exit it forwards to -- so the protocol no longer identifies
// the listener. The control plane names the inbound in the command and
// the dispatcher calls this; nothing about the account shape changes,
// only which listener the user is added to. A user added to the wrong
// inbound gets a credential that authenticates nowhere, which is the
// same silent failure the Transport field was introduced to prevent.
func (p *Provisioner) WithInboundTag(inboundTag string) *Provisioner {
	return p.ForInbound(p.kind, inboundTag, p.accessLogPath)
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
	case kindShadowsocks2022:
		// The 2022 account type, not the original shadowsocks one. They
		// are different messages for different inbound implementations,
		// and handing the wrong one to a 2022 inbound is accepted by the
		// API and then never authenticates anybody.
		key := user.Credentials["userKey"]
		if key == "" {
			return nil, fmt.Errorf("xray CreateUser: shadowsocks credentials missing userKey")
		}
		return serial.ToTypedMessage(&shadowsocks2022.Account{Key: key}), nil
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
