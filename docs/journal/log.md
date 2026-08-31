# Working log

One machine, one log. Append at the bottom. See `README.md` for the
protocol, and `windows.md` for the long-form history up to 2026-08-27.

---

## 2026-08-30 — The Windows machine is gone; what survived and what did not

**Status:** done — recovery assessment
**Touches:** `CLAUDE.md`, `docs/journal/README.md`, `scripts/session-start.sh`

Access to the Windows machine ended. It owned `apps/backend`,
`apps/panel`, `installer`, `agent`, `apps/desktop-windows` and Android,
plus the VirtualBox rig and the `C:/nxcme` worktree. Work continues from
a Mac, which is a **fresh machine with no toolchains installed** — no
node, pnpm, cargo, go or docker, and Xcode is Command Line Tools only.

Assessed from a clean clone of `main` (`6bfdc4f`, 2026-08-27) plus the
GitHub API. Nothing has been pushed to any branch since 2026-08-27, so
the repo is not behind — it is the newest thing that exists.

### Lost

**`claude/config-refresh-and-inbound-tag`.** `shared.md` (2026-08-23)
records it as landed on the Windows machine and **unpushed**. It is not
on origin; there are 64 remote branches and this is not among them. It
is gone, and it has to be rewritten rather than recovered. What it
contained, per that entry: `@shared/lib/connection-config.ts`
(`refreshConnectionConfig()`, `describeConfigDrift()`),
`@shared/lib/resume.ts` (`useRefreshOnResume()` over `visibilitychange` /
`focus` / `online`), additions to `credential-cache.ts`
(`SNAPSHOT_TTL_MS`, `isSnapshotStale()`, `updateSnapshotProtocolUsers()`),
and roughly fifteen lines in `apps/mobile/src/screens/Dashboard.tsx`
wiring both into `runLadder`. Additive throughout; no signature moved.

**The rig.** `Neoxify-Test2`, its packet captures, and every shim and
harness script referenced in the last entries of `windows.md`. This is
the expensive loss. The methodology in `CLAUDE.md` — prove it against
real execution — has no instrument behind it until an equivalent exists.

**Fleet SSH keys** — `ovh_neo`, `azs_vps`, `neo_tr1`. The Mac has one
SSH key, created 2026-08-30, and it belongs to the *hosting* project
(neoxify.com): its `known_hosts` holds `neoxify.com`, `us1.neoxify.com`
and the retired June-era VPN node addresses, none of which are in the
current fleet. **Do not reach for it here.** The owner has stated that
VPS and panel access still exists and can be re-established.

### Survived

**The Android signing key.** `apps/mobile/.signing/` was gitignored,
never committed, and is not on this Mac — but `release-android.yml`
signs from the repo secrets `ANDROID_KEYSTORE_BASE64` and
`ANDROID_KEYSTORE_PASSWORD`, so releases still work. **That secret is now
the only copy**, and GitHub does not allow reading it back. Noted in
`CLAUDE.md`; the owner should decide whether an offline copy is worth
the exposure of extracting one from a public repo's CI.

**Both in-flight branches were pushed.** `claude/concurrent-multi-exit-v2`
and `rig/cme-v2-verify` are the only two branches unmerged into `main`,
and both are on origin including their journal entries. The measurement
run and its findings are intact.

**Every release path.** All four release workflows run on GitHub-hosted
runners and trigger on tags: `desktop-v*` → `windows-latest`,
`android-v*` → `ubuntu-latest`, `v*` → `ubuntu-latest`, and `ci-ios.yml`
→ `macos-latest`. **Losing the Windows box did not cost the ability to
ship anything.** It cost local desktop debugging and the rig.

### Live state, checked from outside

- `https://connect.neoxify.site/api/health` → `{"status":"ok"}`. The
  Next.js admin panel serves. The control plane is up.
- `/api/health/ip` answers in the shape `main` expects.
- Client versions match their latest tags exactly: desktop `0.9.31`,
  mobile `0.2.15`, agent `v0.2.6`. No version drift.

**Not established, and worth someone with access closing:**

- **Which commit the live backend and panel are deployed from.** There
  is no version or build endpoint, so it cannot be read from outside.
  The risk is not a stale repo — it is a server hand-patched from the
  Windows box without committing, and the lost branch proves that
  happened at least once. First task with server access: diff the
  deployed tree against `6bfdc4f`.
- **`fi1.neoxify.site` times out on 443** from a US residential
  connection. Only the mirror was probed; no node was touched. Read it
  next to the `rig/cme-v2-verify` finding that finland1's VLESS+REALITY
  route completes TCP and then carries nothing while `nodes.status`
  still reports ONLINE — these may be the same fault. Unconfirmed.

### Retired in this pass

The two-machine ownership table and journal protocol, in `CLAUDE.md`,
`docs/journal/README.md` and `scripts/session-start.sh`. `windows.md`
and `macos.md` are marked archive and left in place — `windows.md` is
cited from source comments (`ipv6_block.rs`, `ipc/src/lib.rs`) and from
much of `docs/`, so moving it would break those references for no gain.

`shared.md` is kept current rather than archived: what it holds is
standing constraints, not cross-machine coordination.

### Environment: what this Mac needs before it can verify anything

Nothing is installed yet. Required: node + pnpm (backend, panel, portal,
all the vitest/jest suites), cargo (the desktop service and mobile Rust
core), go (the node agent), docker (local Postgres). A full Xcode is
needed for iOS and is not installed either — Command Line Tools only.

**macOS ships bash 3.2, and two of the three CI guard scripts will not
run under it.** `scripts/check-exit-groups.sh` uses `${row,,}` and
`scripts/check-installer-drift.sh` uses `mapfile`; both are bash 4+.
They were only ever run on Git Bash and on `ubuntu-latest`, so this is
new with the machine, not a regression:

```
check-exit-groups.sh        line 285: ${row,,}: bad substitution
check-installer-drift.sh    line 23: mapfile: command not found
```

`check-feature-drift.sh`, `check-protocol-drift.sh` and
`check-prefix-completeness.sh` pass on bash 3.2.

**CI is unaffected** — `ci.yml` runs all three on Ubuntu and they pass
there. What is lost is the ability to run them *before* pushing, which
is the whole point of a guard. `brew install bash` fixes it without
touching the scripts, since both use `#!/usr/bin/env bash`. Rewriting
them for bash 3.2 is the alternative; not done here, because two guard
scripts are a bad place to make an unverified change.

`installer/lib/panel.sh` and `installer/lib/agent.sh` use the same bash
4+ constructs. They run on Ubuntu nodes, so this does not affect them —
but it does mean the installer cannot be dry-run on this machine either.

### What a future session should pick up

Priorities carry over unchanged from `HANDOVER-2026-08-22.md` §6 — the
possible IPv6 leak on full tunnel is still first, and still inspection
rather than measurement. Two things now sit ahead of the rest of that
list because they are newly cheap or newly urgent:

- **Diff the live deployment against `main`** (needs server access).
- **`Selection::placement` in `split_tunnel/owner.rs` reports
  `fallback` for applications that are on their preferred exit.** It
  compares against the session's `egress` and has no access to
  `ExitRelays`. The routing is right and only the string is wrong, but
  the app renders that string, and this repo does not ship connection
  states it has not verified. Pure logic, testable on this Mac, no rig
  needed.

---

## 2026-08-30 — Production, read from the servers: 239 commits behind, and two nodes wedged for six days

**Status:** done (diagnosis) — **germany-1 and singapore-1 need a decision, see bottom**
**Touches:** nothing; read-only session on the panel VPS and five nodes

Access restored. A dedicated key (`~/.ssh/neoxify_vpn`, separate from
the hosting project's key) is installed on the panel and on de1, tr1,
fr1, sg1, ir1. **fi1 refused it** — `Permission denied (publickey,
password)`, so its root password differs from the other six. Finland is
otherwise healthy; it is only the credential that is out of step.

### The deployment is clean, and it is far behind

`/root/neoconnect` on the panel VPS is on `main` at **`85bfaa9`
(2026-08-23)** with a **completely clean working tree** — no
hand-patching, no local commits, no drift of the kind that was the worry.

It is **239 commits behind `origin/main`** (`6bfdc4f`). Undeployed: all
of Gaming Mode, the 1,480-entry catalogue, per-game exits, exit groups,
the bounded list endpoints and the panel's pager, the cron cursors and
the sort indexes. 26 of those commits touch `apps/backend`, 4 touch
`apps/panel`, 2 the agent, 12 the installer.

**Three migrations are unapplied.** The live DB's newest is
`20260823_route_uplink_health`; missing are `20260824_gaming_mode`,
`20260826_list_ordering_indexes`, and that migration's `concurrent.sql`
— the one `windows.md` records as never having been run by anyone.

Stack: Ubuntu 26.04, docker compose — backend (image built 08-24),
panel (08-18), discord-bot (08-10), postgres:16-alpine, redis:7-alpine.
Scale: **33 customers, 30 subscriptions, 6 nodes.**

### germany-1 and singapore-1 have been invisible since 2026-08-24

Both are `OFFLINE` in `nodes`, last heartbeat **2026-08-24 21:32 UTC**.
They are not down. On both boxes `neoxify-agentd` is **active**, has
**never restarted** (`NRestarts=0`, running since Aug 18/19), and xray,
wg-quick@wg0, openvpn-server and strongswan are all active. Existing
tunnels are presumably still being served.

What is actually wrong is narrower and worse: the agent process is alive
but has produced **no log output since Aug 24 21:35:03 (de1) and
21:34:53 (sg1)** — ten seconds apart — while still holding an
**ESTABLISHED TCP connection to the panel on :50051**. Send-Q 0. So this
is not a network drop and not a crash; it is a stream that died above
TCP without either end closing the socket. Compare fr1, same build, same
config, logging normally as of this session.

**They cannot recover on their own.** Re-asserts go only to nodes in the
live-stream registry, so once the stale sweep dropped these two they
stopped receiving anything at all. Nothing in the current design brings a
wedged agent back; it will sit there until someone restarts it.

*(Corrected in the root-cause entry below: the sweep does not merely stop
sending — it actively destroys the server-side call. The agent did not
notice that either, which is the more useful fact.)*

### The re-assert volume, which is the obvious suspect and is not proven

`REASSERT_INTERVAL_MS = 60_000` in `agent-gateway.service.ts:65`. Every
60 seconds the backend writes a `CREATE_USER` down the stream for
**every provisioned user on every online node** — currently **224 users
× 3 standalone nodes + 13 on the relay, every minute**, 7,200 re-assert
log lines per 24h, on the order of a million commands a day for 33
customers. These go through `writeCommand`, not `enqueueCommand`, so
they are direct stream writes with synthetic ids and no AgentCommand row.

Both dead agents' final log lines are a burst of exactly these
(`executed command reassert:<uuid> (CREATE_USER)`), all stamped the same
second, and then silence.

**That is correlation, and it is where I stopped.** I have not shown the
re-assert storm causes the hang, have not captured a goroutine dump, and
have not reproduced it. The honest statement is: two agents wedged
mid-flood, the flood is a million writes a day, and the two facts have
not been connected. Do not write this up as the cause until something
demonstrates it.

### Fleet agent skew

Four nodes run one identical binary; the relay runs a different, newer one:

```
de1  2026-08-19  sha 8cc30b52d612   agentVersion "dev"
tr1  2026-08-22  sha 8cc30b52d612   agentVersion "dev"
fr1  2026-08-18  sha 8cc30b52d612   agentVersion "dev"
sg1  2026-08-18  sha 8cc30b52d612   agentVersion "dev"
ir1  2026-08-24  sha f3a6215f13c4   agentVersion "v0.2.6"
```

Only ir1 was upgraded when v0.2.6 shipped (2026-08-24). The other four
predate the `--version` flag entirely — they return empty, which is why
the panel records them as `dev`. fi1 not sampled (no access).

### One thing I got wrong, recorded so it is not repeated

An HTTPS probe of `fi1.neoxify.site:443` timing out was briefly read as
corroborating the `rig/cme-v2-verify` finding that finland1's REALITY
route does not carry. **It is not evidence of anything.** Port 443 on
these nodes is the VLESS REALITY inbound, which by design does not
answer a plain TLS handshake from a client without the keys — fr1, a
node with no known fault, behaves identically. The finland1 data-plane
question is still open and still needs a real client, not a probe.

### Needs a decision

**Restarting `neoxify-agentd` on de1 and sg1 would very likely restore
both**, and the fleet has been at 4 of 6 usable nodes for six days.
I have not done it: `CLAUDE.md` forbids restarting engines on production
nodes without asking, and a wedged agent is also the only live evidence
of this failure mode that exists. If the cause is ever to be found,
someone should take a goroutine dump *before* the restart clears it.

---

## 2026-08-30 — Root cause of the wedged agents: a Send with no deadline on a stream with no keepalive

**Status:** done — cause proven from goroutine dumps; **fix not written**
**Touches:** nothing yet. The fix belongs in
`agent/internal/controlplane/client.go` and the backend gRPC server opts.

Both nodes were SIGQUIT'd (owner's call, `Restart=always`, back in
seconds) specifically to capture stacks before the restart destroyed
them. **All six nodes are ONLINE again**; germany-1 and singapore-1
picked up their command backlog immediately (232 executed on sg1 within
30s). Dumps: 27 goroutines / 67 KB (de1), 28 / 69 KB (sg1).

### The mechanism, and every step of it is in the dumps

`runStream` (`client.go:127-132`) starts three loops and waits for the
first one to fail:

```go
errCh := make(chan error, 3)
go func() { errCh <- heartbeatLoop(streamCtx, stream) }()
go func() { errCh <- statsLoop(streamCtx, stream, dispatcher) }()
go func() { errCh <- receiveLoop(streamCtx, stream, dispatcher) }()
err = <-errCh
```

The whole reconnect design rests on one of those three returning. **None
of them can.**

- **`goroutine 1` — the main one — `[chan receive, 10233 minutes]` inside
  `controlplane.runStream`.** That is the `<-errCh` above, blocked
  7.1 days. Identical to the minute on both nodes.
- **`heartbeatLoop` is blocked inside `stream.Send()`**, in
  `transport.(*writeQuota).get` → `flowcontrol.go:60`. The HTTP/2 send
  window is exhausted and no `WINDOW_UPDATE` is coming. `Send` takes no
  deadline (`client.go:167`), so it does not time out, does not error,
  and never returns.

So the stream is dead above TCP while the socket stays `ESTABLISHED` with
Send-Q 0 — exactly what was observed — and nothing tears it down.

### Why it is permanent rather than transient

Four things have to line up, and they all do:

1. **No gRPC keepalive on either end.** The agent dials with
   `grpc.NewClient(target, grpc.WithTransportCredentials(creds))` and
   nothing else (`client.go:43`); the backend sets no server keepalive.
   Keepalive is what would notice a peer that has stopped reading, kill
   the transport, and make all three loops error out.
2. **The heartbeat `Send` has no deadline**, so the one loop whose whole
   job is proving liveness is itself the one that hangs.
3. **The server's own teardown does not reach the agent.**
   `sweepStaleNodes` is not passive: it finds ONLINE nodes with stale
   heartbeats, calls `call.destroy(new Error("heartbeat stale"))`, drops
   them from the connection registry and sets status OFFLINE. Re-asserts
   then stop, because `reassertAllConnectedNodes` iterates
   `registry.connectedNodeIds()` — the live-stream map, **not** the DB
   status field.

   So the control plane did tear its half down, days before this session,
   and the agent still sat with an `ESTABLISHED` socket and a parked
   `Send`. `call.destroy()` resets one HTTP/2 *stream*; it does not close
   the TCP connection. Whatever it emitted did not unblock
   `writeQuota.get` on the other end. That is the strongest argument for
   connection-level keepalive specifically: stream-level teardown is
   already implemented and demonstrably insufficient.
4. **systemd cannot see it.** The process is alive and healthy-looking;
   `Restart=always` never fires. `NRestarts=0` after six days of doing
   nothing.

### What is proven, and what is still only likely

**Proven:** the block is `writeQuota.get` under `heartbeatLoop`, the main
goroutine is parked on `<-errCh`, there is no keepalive, and the deployed
agent cannot recover from this state without an external kill.

**Not proven:** that the 224-users-per-node-per-minute re-assert storm is
what exhausted the window. It is the obvious pressure source on that
connection and both nodes wedged mid-flood, but nothing here demonstrates
it, and the deadlock as described would eventually happen at far lower
volume. Treat the storm as aggravating, not established as causal.

One caveat on the reading: the deployed binaries are the 2026-08-18/19
build and the source read here is `main`. The stack frames match that
source exactly (`client.go:168` → `heartbeatLoop` → `SendMsg`), so this
is the code that ran, but the two are not byte-identical.

### The fix, in the order it matters

1. **Keepalive on both ends.** Agent:
   `grpc.WithKeepaliveParams(keepalive.ClientParameters{Time: 30s,
   Timeout: 10s, PermitWithoutStream: true})`. Backend: matching server
   params and an `EnforcementPolicy` with `PermitWithoutStream: true`, or
   the server will GOAWAY clients it thinks are pinging too often. This
   alone converts a permanent hang into a reconnect.
2. **A deadline on the heartbeat send**, so the liveness prober cannot
   itself block forever even if keepalive is misconfigured.
3. **Alert on it.** Two of six nodes vanished for six days and the only
   reason anyone knows is a manual `select` against `nodes`. A heartbeat
   older than a few minutes should be loud.
4. **Reconsider the re-assert rate** (`REASSERT_INTERVAL_MS = 60_000`,
   every user, every node, every minute) independently of this bug.

None of this is written. Nothing on any node was changed beyond the two
restarts.

---

## 2026-08-31 — Keepalive and bounded sends, written and verified locally; not deployed

**Status:** done (code + tests) — **not deployed to any node or the panel**
**Touches:** `agent/internal/controlplane/client.go`,
`agent/internal/controlplane/client_test.go` (new),
`apps/backend/src/modules/agent-gateway/agent-gateway.service.ts`

Fixes 1 and 2 from the entry above. Fix 3 (alerting) and 4 (the
re-assert rate) are not written.

**Agent.** Dials with `keepalive.ClientParameters{Time: 30s, Timeout:
10s, PermitWithoutStream: true}`. Every stream write — hello, heartbeat,
stats — now goes through `sendWithTimeout`, which runs `Send` on its own
goroutine and gives up after 30s, because grpc-go's `Send` accepts no
deadline of its own.

**Backend.** `new grpc.Server({...})` with matching keepalive:
`keepalive_time_ms 20s`, `keepalive_timeout_ms 10s`,
`keepalive_permit_without_calls 1`,
`http2.min_ping_interval_without_data_ms 20s`,
`http2.max_pings_without_data 0`.

**The two sides are coupled and must be changed together.** If the
server's `min_ping_interval_without_data_ms` ever exceeds the agent's
30s `Time`, the server answers the agent's keepalive with
GOAWAY/ENHANCE_YOUR_CALM and severs healthy connections — a worse
failure than the hang being fixed. `max_pings_without_data 0` is
similarly load-bearing: the agent pings on idle connections by design,
and the default of 2 would drop it for that alone. Both constraints are
in the comments at both ends.

### Verified

Toolchains had to be installed first (Go 1.27, node 26.8.1, pnpm 9.15) —
this Mac had none.

- `gofmt` clean, `go build ./...` and `go vet ./...` clean, **full agent
  suite passes** (7 packages, exit 0).
- Backend **typecheck exit 0**, and the three agent-gateway suites pass
  (19 tests, exit 0). Note `prisma generate` must run before typecheck or
  ~15 unrelated errors appear in `usage.service.ts` and `vouchers/` from
  missing generated types; they are environmental, not code.
- Three new tests in `client_test.go`. **Proven by reverting**: with
  `sendWithTimeout` gutted back to a bare `stream.Send`, the suite hangs
  and panics on the 20s test timeout — the production failure, reproduced
  in a unit test. Restored, it passes in 0.4s.

### Not verified

**Nothing has been deployed and nothing has been proven on the wire.**
No node runs this binary; the panel runs the old server. Keepalive
behaviour in particular cannot be shown by a unit test — it needs two
real peers and a stalled window. Until then this is a fix that compiles,
passes tests, and is argued from a goroutine dump. That is not the same
as fixed.

Deploying it means a new agent binary on all six nodes plus a backend
release, which is a rollout decision. The fleet is already on skewed
pre-v0.2.6 binaries (four nodes on one 08-18/19 build, ir1 alone on
v0.2.6), so a rollout is arguably overdue independently of this.

### Found while fixing, not fixed: three goroutines share one stream

`runStream` starts `heartbeatLoop`, `statsLoop` and `receiveLoop`
concurrently, and **all three call `Send` on the same
`AgentGateway_AgentSyncClient`** (client.go:233, 298, 327). grpc-go's
contract is one sender and one receiver per stream; concurrent `SendMsg`
from multiple goroutines is explicitly not supported.

This predates today's change — the same three sites called `stream.Send`
directly before it — and `sendWithTimeout` neither introduces nor worsens
it, since each caller still blocks until its own write resolves. But it
is a real race against a documented contract, it lives on the exact code
path that wedged, and it is worth suspecting as a contributor to the
exhausted window rather than treating as unrelated. The fix is a single
writer goroutine fed by a channel. Not attempted here: it restructures
all three loops, and doing it in the same change as the hang fix would
make both harder to judge.

---

## 2026-08-31 — finland1 rebuilt from a wiped host, and why its REALITY route was never carrying

**Status:** done — node fully restored and serving
**Touches:** `installer/maintenance/restore-openvpn-from-panel.sh` (new)

The Finland host was reprovisioned with a fresh OS and no data. It is back:
**ONLINE, agent v0.2.6, 232 provisioned users** across all seven protocol
rows, every engine active, every customer port listening.

Rebuilt against the **existing** node record rather than a new one. The
enrollment claim (`POST /nodes/:id/enrollment-tokens`, then
`agentd --enroll-init`) rotates `agentPubKey`/`agentVersion`/`publicIp`
and keeps the node id, so its users and routes survived and the panel's
own re-assert sweep pushed all of them back. Creating a fresh node would
have orphaned 29 customers' worth of provisioning.

### The finland1 dead-route mystery is solved, and it was never the client

`rig/cme-v2-verify` recorded that finland1's VLESS+REALITY route completes
TCP and then carries nothing — "2 SYN, 2 SYN-ACK, 12 packets out, 10 in,
and then nothing" — while `nodes.status` said ONLINE. It was filed as
unexplained and needing node access.

**Its REALITY dest was `www.shatel.ir:443`, and this node cannot reach
it.** The installer's own probe, run from the box during this rebuild:

```
www.shatel.ir -- REJECTED: no TLS handshake from 85.15.17.13 --
this server cannot reach it, or nothing there speaks TLS
```

REALITY forwards the client handshake to its dest on every connection. A
dest the node cannot complete TLS with produces exactly the capture that
was recorded: the TCP handshake succeeds because that is Xray accepting
the connection, and everything above it dies waiting on a forward that
never completes. Nothing about the client, the keys or the transport was
ever wrong.

It is now `www.helsinki.fi:443` — AS1741 FUNETAS, hosted in Finland, its
own AS, not a CDN, and verified reachable from this node by the probe.

**Two things to take from this beyond finland1.** A dest that stops being
reachable turns a node into one that accepts connections and serves
nothing, and the panel goes on reporting it ONLINE because the heartbeat
has no opinion about REALITY. Nothing monitors dest reachability. And
`HANDOVER-2026-08-22.md` §6 item 6 is now worth re-reading — **the other
nodes' dests have not been re-probed**, and `fr1` is on
`cloudflare.com:443`, which this installer's ownership check would reject
outright as CDN-fronted.

### A fresh install cannot reach the control plane, and the failure is silent

`grpcTarget` was empty after enrolment, so the agent derived it from the
panel URL: `connect.neoxify.site` → **104.21.21.89:50051** → a Cloudflare
address. Cloudflare does not carry 50051, so every dial timed out and the
node sat OFFLINE while looking healthy locally.

Every working node has it set explicitly — `167.233.65.166:50051` on de1
and ir1, `origin.neoxify.site:50051` on fr1. Set to the IP here, matching
the majority. `dialTarget` keeps SNI as the panel hostname regardless of
target, so the certificate still verifies.

**This is an installer gap, not a one-off.** Any node enrolled against a
CDN-fronted panel URL lands in the same state. `NEOXIFY_GRPC_TARGET`
exists; nothing prompts for it or warns when the derived host resolves to
a CDN.

### `publicParamsJson` holds private keys — and I put finland1's in a transcript

Reading that column for the OpenVPN row returned **caKeyPem, serverKeyPem
and tlsCryptKey**. The name says public params. `CLAUDE.md` already says
to select named columns because tables carry credential blobs; the column
whose name promises otherwise is the one that catches you.

finland1's OpenVPN CA key, server key and tls-crypt key should be treated
as exposed. They were regenerated as part of this rebuild in the sense
that the node was wiped — but **the panel's stored copies are the same
ones**, and they are what clients use. Rotating them means reissuing
every client cert on this node, which is why it is being flagged rather
than done. **Renaming the column, or splitting the secret half out, is
the fix that stops this recurring.**

### OpenVPN could not be reinstalled, and the refusal was right

`install_openvpn` POSTs to `/protocol-configs`, and the panel is what
generates the CA and returns it. On a node whose config already exists the
POST is refused, the CA never comes back, and the function exits before
writing anything — so a rebuilt node gets no OpenVPN at all. The panel's
message is explicit that deleting the config to get past this invalidates
every client cert issued against that CA.

Nothing is lost, though: the panel stores the CA, server cert/key and
tls-crypt key. `installer/maintenance/restore-openvpn-from-panel.sh`
fetches them and puts the node back **with the same CA**, so existing
client certs keep working. That path did not exist and now does.

### Smaller things this turned up

- **`install_openvpn` cannot be called standalone.** It reads `panel_url`
  and `node_id`, which only `action_engines_agent` sets; calling the
  function directly dies with `panel_url: unbound variable` *after* the
  apt install and the prompts.
- **Sourcing `lib/agent.sh` outside `install.sh` needs `SCRIPT_DIR`
  exported**, or it fails at the config template with an unbound variable.
- **strongSwan's unit is `strongswan.service` on Ubuntu 26.04**, not
  `strongswan-starter.service` as on the older nodes. Anything checking
  the old name will report IKEv2 down on a node where it is running.
- **finland1's OpenVPN config has no `subnetCidr`.** The installer's own
  comment says route creation fails with "missing subnetCidr" without it —
  the same fault recorded on ir1 on 2026-08-14. Not fixed here; it
  predates the rebuild.
- The certificate step **auto-migrated its renewal to webroot**, so the
  standalone-then-nginx renewal trap the installer comments describe —
  and which it names finland1 as being in — is handled on this box now.

### Not verified

**No tunnel was carried.** Every protocol is listening and every user is
provisioned, but nothing has connected as a customer and no traffic has
been put through this node. In a repo whose history is designs that read
correctly and failed under real execution, that distinction is the whole
point: this node is *restored*, not *proven*. The REALITY dest fix in
particular is argued from the installer's probe, not from a client that
completed a handshake through it.

---

## 2026-08-31 — Fleet-wide dest audit: all six pass, and shatel.ir is not the villain

**Status:** done — audit only, nothing changed
**Touches:** nothing

Probed each node's own REALITY dest **from that node**, TLS 1.3:

```
de1  www.shatel.ir:443        OK        tr1  www.donanimhaber.com:443  OK
fr1  cloudflare.com:443       OK        sg1  www.shopee.sg:443         OK
ir1  www.torob.com:443        OK        fi1  www.helsinki.fi:443       OK
```

**This corrects the entry above.** `www.shatel.ir` is *not* a dead dest —
de1 completes a TLS 1.3 handshake with it right now. What was true is
narrower and more useful: **the Finland host could not reach it**, and
dest reachability is a property of the node-dest pair, not of the dest.
The finland1 diagnosis stands; the generalisation "shatel.ir has rotted"
would have been wrong, and a future session acting on it would go looking
in the wrong place.

That makes the monitoring gap sharper rather than softer. A dest has to
be probed **from each node that uses it**, because the pair is what
breaks, and nothing does that after install.

**`fr1` on `cloudflare.com:443` is still worth fixing, for a different
reason.** It passes reachability and would fail the installer's
*ownership* check — it is CDN-fronted, which is the mismatch
`HANDOVER-2026-08-22.md` §6 item 6 describes a filter catching at line
rate. Reachable and unsuspicious are not the same test, and only the
first one currently gets run after install.
