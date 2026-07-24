# ADR 0001: mTLS upgrade evaluation for agent authentication

**Status:** Accepted — defer mTLS, close a smaller gap in the current scheme instead. Revisit under the conditions listed below.

## Context

Every VPN node runs `agentd`, which opens one long-lived outbound gRPC
stream (`AgentSync`) to the panel's backend. The backend must be
confident that whoever claims to be "node X" on that stream really is
the agent that was enrolled as node X — a forged or hijacked identity
here would let an attacker receive live `CREATE_USER`/`DISABLE_USER`/etc.
commands meant for a real node, or push fake heartbeats to keep a
compromised/offline node looking healthy.

**Current mechanism** (implemented in M2, `apps/backend/src/modules/agent-gateway/`
and `agent/internal/controlplane/`):

- **Transport**: standard one-way TLS. The backend terminates TLS with a
  real Let's Encrypt certificate (`agent-gateway.service.ts`'s
  `buildCredentials()`); the agent verifies that certificate against the
  OS trust store (`client.go`'s `dialTarget()`, `credentials.NewTLS(&tls.Config{ServerName: host})`,
  no `InsecureSkipVerify`, no client cert presented). This proves to the
  agent it's talking to the real panel; it proves nothing to the panel
  about which agent is connecting.
- **Node identity**: an Ed25519 keypair generated locally by `agentd
  enroll --init`. The private key never leaves the box. The public key
  is handed to an admin (via the enrollment token flow, M2) and stored
  on the `Node` row once claimed.
- **Per-connection auth**: on every stream open, the agent sends a
  `Hello{ nodeId, timestamp, nonce, signature }` where `signature =
  Ed25519_sign(privateKey, "{nodeId}.{timestamp}.{nonce}")`. The backend
  (`handleHello()`) looks up the claimed node's stored public key,
  checks `|now - timestamp| <= 120s`, and verifies the signature over
  exactly that string. `nonce` is 16 cryptographically random bytes
  (`crypto/rand`, `client.go:randomNonce`).

This is a real challenge-response scheme, not a bearer token — an
attacker who observes a Hello on the wire cannot forge a *new* one for a
different timestamp without the private key.

## Gap found while writing this evaluation

The `nonce` field is generated correctly but **never checked for
uniqueness** server-side — `handleHello()` only checks the timestamp
window, not whether that exact `(nodeId, timestamp, nonce)` tuple was
already used. So a Hello captured by a MITM (someone who can already see
the raw bytes — see "what this doesn't protect against" below) can be
replayed verbatim any number of times within the same 120-second window
after the original was sent, each replay opening a new stream and
authenticating as that node.

This is a narrow window (120s, and only exploitable by someone who can
already intercept the TLS-wrapped connection) but it's a real gap, and
it's **much cheaper to close than an mTLS migration would be**: track
seen `(nodeId, nonce)` pairs for 120s (a Redis `SETNX` with a 120s TTL is
enough, reusing the Redis instance BullMQ already depends on) and reject
a Hello whose nonce was already seen. This should be fixed regardless of
what this ADR decides about mTLS — it's flagged as a follow-up, not
solved here, so it doesn't scope-creep into a hardening pass about
something else.

## What mTLS would change

mTLS would move node authentication from the application layer (Ed25519
Hello) to the transport layer (agent presents a client certificate
during the TLS handshake itself, backend's gRPC server verifies it
against a trusted CA before the stream is even readable).

**What it would genuinely add over the current scheme once the nonce gap
above is fixed:**
- Authentication happens before any application bytes are exchanged,
  slightly reducing the attack surface exposed to an unauthenticated
  peer (relevant mainly against gRPC/HTTP2-implementation-level bugs,
  not against anything already possible today).
- One fewer place for identity logic to live (crypto/TLS libraries
  instead of hand-rolled challenge-response code) — marginally reduces
  the "hand-rolled auth" review burden.

**What it would cost:**
- A private CA now has to exist somewhere, issue a cert per node at
  enroll time, and that CA's own root key becomes the single most
  sensitive secret in the system (whoever holds it can mint a trusted
  node identity) — currently there is no such single point of trust;
  each node's Ed25519 keypair is independent.
- Certificate rotation/expiry becomes an operational concern across a
  fleet of independently-run, non-centrally-managed VPS boxes (Phase 1
  has no fleet-management/config-push layer beyond the `AgentCommand`
  outbox, which assumes the stream is already authenticated — it can't
  bootstrap a cert rotation on its own). A missed rotation silently
  takes a node offline until manually fixed.
- Revocation needs a real mechanism (CRL or OCSP, or a custom "is this
  cert still valid" check on every connect) — today, revoking a node's
  trust is a one-row `UPDATE` (clear `agentPubKey` or delete the Node),
  effective on its next Hello.
- grpc-js's TLS client-cert-verification path adds real implementation
  complexity to `agent-gateway.service.ts`'s `buildCredentials()`
  (currently a straightforward `createSsl(null, [...])`; mTLS needs a
  CA bundle passed in and `checkClientCertificate` wired up).

None of this is unreasonable *engineering* — it's a well-understood
pattern — but it's meaningfully more moving parts for a fleet that,
today, is admin-provisioned one VPS at a time via the bash installer,
not auto-scaled or centrally fleet-managed.

## Decision

**Defer mTLS.** Fix the nonce-replay gap in the existing Ed25519
challenge-response scheme instead (tracked as a follow-up, not part of
this ADR) — it closes the one concrete weakness found here at a fraction
of the operational cost.

Revisit this decision if any of the following becomes true:
1. **A compliance requirement mandates mutual TLS specifically** (some
   security certifications name it explicitly; app-layer challenge-
   response with equivalent guarantees sometimes isn't accepted as a
   substitute regardless of technical merit).
2. **The node fleet grows large/dynamic enough** that a real
   fleet-management/config-distribution layer gets built anyway (auto-
   provisioning, auto-rotation) — at that point a CA and cert rotation
   are close to free to add on top, and the current cost argument above
   mostly disappears.
3. **A real incident** (not a theoretical gap) involving node-identity
   spoofing or stream hijacking is observed — the calculus around "is
   this extra complexity worth it" changes immediately given concrete
   evidence of exploitation rather than a hypothetical.
4. **The transport path changes** — e.g. agent traffic starts routing
   through infrastructure NeoConnect doesn't fully control (a shared
   load balancer, a third-party CDN/proxy in front of the gRPC gateway)
   where transport-layer client identity becomes necessary because
   application-layer identity could be stripped or spoofed by an
   intermediate hop.
