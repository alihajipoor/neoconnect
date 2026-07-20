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
- `installer/install.sh` — one-shot installer + management menu that turns
  a fresh Ubuntu/Debian VPS into an enrolled node.

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

## Build order

M0 repo scaffold -> M1 backend core (auth+schema+CRUD) -> M2 agent
skeleton+enrollment -> M3 Xray end-to-end -> M4 WireGuard end-to-end ->
M5 panel UI core -> M6 usage/quota pipeline -> M7 billing -> M8 OpenVPN ->
M9 Iran relay chaining -> M10 installer polish -> M11 hardening.
