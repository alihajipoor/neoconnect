# NeoConnect Architecture (Phase 1)

Phase 1 scope: control-plane backend + admin panel, node agent, bash installer.
Website and native clients are deferred phases and are not designed in detail here.

The full decision record and build-order milestones live in the approved
project plan; this document is the in-repo reference copy of the
architecture so it evolves alongside the code. See `docs/adr/` for
individual decisions as they're revisited.

## Components

- `apps/backend` — NestJS control-plane API (auth, nodes, subscriptions,
  billing, agent gateway, usage/quota enforcement).
- `apps/panel` — Next.js admin dashboard.
- `agent/` — Go daemon (`agentd`) that runs on every VPS node, manages local
  VPN protocol engines, and syncs with the backend over gRPC.
- `packages/proto/agent.proto` — source of truth for the agent<->backend
  wire contract (generates both Go and TypeScript stubs).
- `installer/install.sh` — single entrypoint for both deployable roles on
  a fresh Ubuntu/Debian box: **Main Panel Server** (Docker Compose stack
  of backend+panel+Postgres+Redis, fronted by host nginx + Let's Encrypt
  — see `installer/lib/panel.sh`) or **VPN Agent Node** (downloads the
  compiled `agentd` binary and enrolls — see `installer/lib/agent.sh`).
  The chosen role persists in `/etc/neoxify/role`; re-running the script
  shows that role's management menu instead of re-prompting.

## Two requirements that drive every protocol decision

1. **No account change may interrupt active gaming connections.** Every
   protocol engine's user CRUD must be hot (add/remove/update a single
   user without restarting the engine or touching other users' sessions).
   See `agent/internal/protocols/common/provisioner.go` for the shared
   interface this is built around, and the per-protocol notes in the
   project plan for how each engine (Xray, WireGuard, OpenVPN) satisfies it.
2. **Iranian clients need a relay.** Some nodes are Iran-reachable "relay"
   nodes forwarding to abroad "exit" nodes. Xray/REALITY chains natively;
   WireGuard/OpenVPN are wrapped in `phantun` on the client-to-relay leg
   only. See Milestone M9.

## Data model

Full entity list and relationships: `apps/backend/prisma/schema.prisma`.

## Agent <-> backend protocol

Draft contract: `packages/proto/agent.proto`. Enrollment flow, stream
message semantics, and reconciliation-on-reconnect behavior are detailed
in the project plan and will be expanded here as Milestone M2 implements
them.

### Agent gRPC gateway TLS

Unlike the panel's HTTP API, the agent's gRPC stream is **not** proxied
through nginx — it's published directly on its own port (50051 by
default) with its own TLS termination, since blending it into 443 is
explicitly deferred (only matters for Iran-relay stealth, see M9).
`AgentGatewayService` refuses to start this gateway at all in production
if `AGENT_TLS_CERT_PATH`/`AGENT_TLS_KEY_PATH` are unset or unreadable —
deliberately, rather than falling back to plaintext — but it also
deliberately doesn't crash the rest of the backend over it, so a broken
gateway fails **silently**: the panel's HTTPS keeps working fine, and the
only visible symptom is every Node staying `PENDING` with
`lastHeartbeatAt: null` forever.

The cert files live at `/etc/neoxify/certs/{fullchain,privkey}.pem` on
the panel host — a copy of the same Let's Encrypt cert nginx uses,
world-readable (`0644`) since certbot's own `privkey.pem` is root-only
and unreadable by the backend container's non-root user. This copy is
made by `installer/lib/panel.sh`'s `sync_agent_gateway_certs()`, which
runs during the original TLS setup, on every certbot renewal (via a
deploy hook), and — as of 2026-07-24, after this exact failure mode was
hit live on a real box — on every "Rebuild and restart" (`action_update_panel`)
too, so a box whose certs go missing for any reason self-heals on the
next update instead of needing a manual fix.

**To check the connection is actually healthy**: `GET /nodes` (or the
panel's Nodes page) — look for `status: "ONLINE"` and a real, recently-
updated `lastHeartbeatAt`. A node stuck `PENDING`/`null` almost always
means this TLS setup, not the agent process itself (which will show as
happily "active (running)" in `systemctl status` while endlessly retrying
a connection that's being refused).

## Build order

M0 repo scaffold -> M1 backend core (auth+schema+CRUD) -> M2 agent
skeleton+enrollment -> M3 Xray end-to-end -> M4 WireGuard end-to-end ->
M5 panel UI core -> M6 usage/quota pipeline -> M7 billing -> M8 OpenVPN ->
M9 Iran relay chaining -> M10 installer polish -> M11 hardening.
