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

---

## 2026-08-31 — One writer owns the stream now

**Status:** done (code + tests) — **not deployed**
**Touches:** `agent/internal/controlplane/client.go`, `client_test.go`

The race flagged in the keepalive entry is closed. `heartbeatLoop`,
`statsLoop` and `receiveLoop` no longer call `stream.Send` themselves —
all three queue through a `sender`, and a single `writerLoop` goroutine
owns the send side. grpc-go supports one sender and one receiver per
stream; it does not support concurrent `SendMsg`, and three goroutines
were doing exactly that on the path that wedged.

`writerLoop` starts **before** the hello, because the hello is itself a
stream write and goes through the same queue. Its return value joins the
same `errCh` as the other loops, so a failed write still tears the stream
down and triggers a reconnect — `errCh` is now sized 4 so nothing can
block on the way out.

`send` bounds **both** waits on one timer: getting into the queue, and
the write itself. That second wait is the original hang; the first is new
and matters just as much, because before this a second caller had no
deadline at all — it blocked inside grpc-go behind the first one's stuck
write. A timeout leaves `writerLoop` parked in `Send`, which is intended:
the caller's error reaches `runStream`, which cancels `streamCtx`, which
unblocks `Send`.

### Verified

`gofmt` clean, `go vet` clean, **full agent suite passes under `-race`**,
7 packages, `-count=1` so nothing was replayed from cache.

Six tests. The new one asserts the actual invariant — 8 goroutines × 25
writes must reach the stream one at a time — and it is **proven by
reverting**: make `writerLoop` spawn each send in its own goroutine and
it reports *199 concurrent entries*; with the fix, zero. The blocked-write
and cancellation tests are unchanged in intent and still pass.

### Not verified

Still nothing on the wire. This is the same caveat as the keepalive entry
and it has not moved: no node runs this binary. The race was real by
grpc-go's documented contract and is now demonstrably gone in a test, but
whether it ever contributed to the wedge is unknown and probably
unknowable after the fact.

---

## 2026-08-31 — The alerting was never missing; it just never repeated

**Status:** done (code + tests) — **not deployed**
**Touches:** `apps/backend/src/modules/nodes/nodes.service.ts`,
`agent-gateway.service.ts`, `nodes.offline-reminder.spec.ts` (new)

Went to add node-down alerting and found it already there.
`nodes.service.setStatus` alerts on every real ONLINE<->OFFLINE
transition, `AlertingService` posts to a webhook that works against
Slack or Discord, and **`ALERT_WEBHOOK_URL` is configured on
production**. Checking the backend log for the night in question:

```
08/24/2026, 9:33:42 PM WARN [AgentGatewayService] Node ... (singapore-1) marked OFFLINE
08/24/2026, 9:33:42 PM WARN [AgentGatewayService] Node ... (germany-1)  marked OFFLINE
```

with no `Alert webhook returned` and no `Failed to send alert` anywhere.
**The alerts fired and were delivered.** Nobody was ignoring a broken
alarm; the alarm rang twice, six days ago, and then went quiet — because
it only fires on a *transition*, and after that first minute there were
no more transitions to fire on. One message six days ago is
indistinguishable from a blip that needed no action.

So the gap was never "no alerting". It was that **nothing reports a state
that is persisting**, which is the only kind of state a six-day outage
has.

`NodesService.remindAboutOfflineNodes()` now runs from the stale-node
sweep and re-alerts every 6h for anything still OFFLINE, saying how long
it has been down. `suppressNextOfflineReminder()` is called right after
the sweep marks a node OFFLINE so the transition alert and the first
reminder do not arrive together. Recovered nodes are pruned from the map,
so a node's *next* outage reports immediately instead of being silenced
by a stale timestamp.

Six hours is chosen to be impossible to mistake for a blip while staying
quiet enough that a retired node does not become noise people learn to
filter. The map is in memory deliberately: a backend restart clears it
and the next sweep re-reports everything currently down, which is the
right behaviour after a restart rather than a bug.

### Verified

Backend typecheck exit 0. **Full backend suite: 61 suites, 647 tests,
exit 0.** Six new tests covering the report, the window, the repeat after
the window, the suppression, the prune-on-recovery, and the quiet fleet.

**Proven by reverting**, with a caveat worth recording: gutting
`remindAboutOfflineNodes` to a no-op fails **4 of the 6**. The two that
still pass are the negative cases — "says nothing when the fleet is up"
and "suppression holds the first repeat back" — and a no-op satisfies
both vacuously. That is the same trap `windows.md` recorded on
2026-08-27, where a cache test passed because the request it asserted
about never happened. The four positive tests are what actually hold this
behaviour; the two negatives only guard against over-alerting once the
positives are in place.

### Also seen while checking

**ir1 was marked OFFLINE today at 09:01 UTC** and recovered on its own.
Not investigated. Under the current code that produced two alerts and no
lasting record; under the new code a blip like that still produces
exactly two, which is the intended distinction.

---

## 2026-08-31 — Dest-health monitoring: designed, deliberately not built

**Status:** blocked by choice — next piece of work, not started
**Touches:** nothing

The finland1 rebuild established that an unreachable REALITY dest turns a
node into one that accepts connections and serves nothing, while the
panel goes on calling it ONLINE because the heartbeat has no opinion
about REALITY. Nothing probes dests after install. This entry records why
that is still true at the end of the session.

**Reachability is a property of the node-dest pair**, so the probe has to
run *on each node*. That rules out anything the panel can do alone.

Getting the result back needs one of:

- a field on `Heartbeat` — additive and backward compatible in proto3,
  but a proto change, an agent change and a fleet rollout;
- a new `CommandType` so the panel can ask — `CommandType` is an enum, so
  also a proto change;
- `StateSnapshot` — carries `ProtocolUserRef` only, wrong shape.

There is no path that avoids a proto change and a new agent binary.

**Why it is not being written now.** Three changes are already queued for
the next agent rollout — keepalive, bounded sends, the single-writer
refactor — and **not one of them has been on the wire.** Adding a proto
change and a new agent behaviour to that same untested pile makes a
single deploy the first real test of four things at once, and if
something misbehaves the attribution problem is worse than the bug.

The sequencing that follows: **roll out what exists, confirm it on real
nodes, then add dest health as its own change.** It pairs naturally with
that second rollout since it needs a new binary anyway.

**Interim cover, costing nothing:** the probe already exists as
`probe_reality_dest` in the installer, and running the audit by hand
takes one command per node. It was run today and all six pass. That is
not monitoring, but it means the fleet is known-good right now rather
than assumed-good.

`fr1` on `cloudflare.com:443` remains the one to fix regardless — it
passes reachability and fails the ownership test, which is the check that
only ever runs at install time.

---

## 2026-08-31 — First CI run on a feature branch: green, all four jobs

**Status:** done
**Touches:** nothing

`caf0d87` is the first push to a `claude/**` branch that CI has ever
seen, and it passed on every job:

```
Shellcheck installer          success
Go agent                      success
TypeScript (backend + panel)  success
Desktop client tests          success   <- windows-latest
```

The branch-coverage change verified itself on its own first run, which is
the cheapest possible confirmation that it was the right change.

**What this upgrades.** The keepalive, bounded sends and single-writer
refactor are no longer "builds on my machine" — the Go agent job compiled
and tested them on a clean Linux runner. The backend keepalive options
and the still-offline reminder passed typecheck and the full jest suite
there too. And **`Desktop client tests` passing on `windows-latest`
proves the one thing this machine cannot check at all**: nothing in this
branch broke the crate the Mac cannot compile.

**What it does not upgrade.** None of it has carried a packet. CI proves
these things compile and that their tests pass; it cannot prove a
keepalive reopens a stalled stream, because that needs two real peers and
an exhausted window. The distinction is the same one `CLAUDE.md` makes
about `ci-ios.yml`, and it applies here unchanged.

---

## 2026-08-31 — placement() is not a live bug, and the fix does not belong on main

**Status:** correction — nothing changed
**Touches:** nothing

Earlier entries list `Selection::placement` reporting `fallback` for an
application on its preferred exit as an open defect, and I carried that
forward as if it affected customers now. It does not.

**`ExitRelays` does not exist on `main`.** It lives only on
`claude/concurrent-multi-exit-v2`. On main a session has exactly one
exit, so comparing an app's preferred exit against the session egress is
complete and `placement()` is correct. The defect appears only once
concurrent exits do, and that feature is unmerged and unshipped.

So the fix belongs on `claude/concurrent-multi-exit-v2` as a **merge
precondition**, not on main. Writing it here would be a signature change
with nothing to compare against.

Recorded because "known bug in placement()" reads as something to fix
next, and acting on that from main wastes the effort and risks a
gratuitous signature change to code that is currently right.

---

## 2026-08-31 — Deployed: Gaming Mode, agent v0.2.7, and two fleet-wide config gaps closed

**Status:** done — all four items shipped to production
**Touches:** production only; no repo change beyond this entry

### Gaming Mode is live

Production went from `85bfaa9` (2026-08-23) to `61a06e2` — **253
commits**. Ran to the runbook. Disk first: `docker buildx prune -af`
took `/` from 84% to 27% (6.1G → 27G free), which the backend and Next.js
builds both needed. Fresh backup taken and eyeballed (30.4 MB) before
anything moved.

`concurrent.sql` by hand first — 8 `CREATE INDEX CONCURRENTLY`, 2
`DROP INDEX CONCURRENTLY`, zero invalid indexes after. Then the swap;
the container migrated itself on boot as designed and applied
`20260824_gaming_mode` and `20260826_list_ordering_indexes`, finding
every index already present.

**All six nodes reconnected within 15s of the backend restart.** That
restart drops every agent stream, and the old agents had no keepalive —
it was the exact scenario that wedged two nodes on 2026-08-24, and
nothing wedged.

The catalogue was **empty after deploy** and needed seeding —
`node dist-seed/seed.js` in the backend container, **1,483 profiles**.
Deliberately run without `SEED_ADMIN_*`: the catalogue is upserted first
and the script then throws on the missing admin env, so the existing
admin is untouched (`updatedAt` still 07-26, confirmed after).

### Agent v0.2.7 on all six

Tagged from main, released by CI, rolled out canary-first to **tr1** and
watched for four minutes: one connect, no reconnects, **no GOAWAY, no
ENHANCE_YOUR_CALM**, zero restarts. That is the keepalive pairing between
the agent's 30s `Time` and the server's 20s
`min_ping_interval_without_data_ms` confirmed against real peers — the
one thing no unit test could establish. Then de1, fr1, sg1, fi1, and
**ir1 last**.

**ir1 could not download from GitHub** — it timed out, which on a censored
network is unsurprising. Nothing was installed, because the checksum gate
sits after the download and the download never produced a file; the node
stayed on v0.2.6, healthy, untouched. Fixed by fetching and verifying the
binary locally and pushing it over SSH. **Worth remembering: the Iran
relay cannot self-update from GitHub releases**, so any future rollout
needs that hop. Every node kept its previous binary in
`/var/lib/neoxify/agentd-rollback/`.

The version skew is also gone — the fleet was four nodes on a pre-0.2.6
build reporting `dev`, and is now uniformly `v0.2.7`.

### fr1's dest, and the landmine underneath it

`cloudflare.com:443` replaced with `www.free.fr:443` — AS12322 PROXAD,
Free SAS, **in France**, own AS, TLS 1.3 verified from fr1 itself. The
probe also confirmed `HANDOVER` §6 item 6 first-hand: **`www.leboncoin.fr`
now resolves into AWS** (AS16509, US), exactly the rot that entry
predicted.

**The change broke xray on fr1, and that was worth finding.** The new
config was written `600 root:root`; xray runs as `User=nobody` and could
not read it. Service down about a minute, restored with
`640 root:nogroup`.

The interesting part is *why the old config worked*: it was **also
`600 root:root`**, dated 2026-08-24. xray had been running for a week
only because the process held the file open from before those permissions
were set. **fr1 would have failed to come back from any restart or
reboot, silently, and nobody would have known until it happened.** Audited
the whole fleet afterwards: fr1 was the only one — the other five are
`644` and readable. Now all six are.

### subnetCidr was missing on five of six

Only ir1 had it, from when this fault was found there on 2026-08-14.
Every node's `server.conf` uses `10.77.0.0/24`, so that was merged into
the other five — **merged, not replaced**, and each response was checked
to confirm all 5 secret fields survived the write.

### One correction

An early pass reported IKEv2 inactive on five nodes. That was my check
being wrong, not the fleet: the unit is `strongswan-starter.service` on
the five older nodes and `strongswan.service` on fi1 (Ubuntu 26.04).
**All six are active and listening on UDP 500.** The naming split is real
though, and any health check keying on one name will misreport the other.

### Not verified

No customer tunnel has been carried through any of this. Every service is
up, every node is provisioned and heartbeating, and the keepalive pairing
is proven against real peers — but "a customer connected and traffic
flowed" remains untested, and the REALITY dest changes on fr1 and fi1 are
the ones where that would matter most.

---

## 2026-08-31 — A real client carried traffic through fr1 and fi1

**Status:** done — first ground-truth verification in this whole session
**Touches:** nothing; test account created and deleted

Every entry above ends with "nothing has carried a packet". This one
does not.

Method: a **dedicated test customer** (never a real customer's
credentials), plan assigned via `POST /subscriptions/assign` so it
provisioned properly, its VLESS+REALITY credentials decrypted with the
backend's own `CREDENTIALS_ENCRYPTION_KEY`, and a local
`xray 26.3.27` client built **from the panel's published params** — the
same `serverName`, `realityPublicKey` and `shortId` a real client
receives. SOCKS inbound, `curl` through it, compare the egress address.

```
direct (no tunnel)      50.34.35.228
through france-1       104.105.205.233   <- france-1's own publicIp
through finland1       204.168.161.100   <- finland1's own publicIp
```

Also through finland1: `https://www.wikipedia.org` → **HTTP 200 in
1.33s**, so it is carrying ordinary traffic and not just answering one
API call.

That is the standard `CLAUDE.md` asks for — "an exit IP that matches the
node" — met for both nodes.

### What this actually settles

**finland1's REALITY route carries traffic now.** That route is the one
`rig/cme-v2-verify` recorded as completing TCP and then carrying nothing,
with the panel still reporting ONLINE. The diagnosis in this session's
earlier entry — an unreachable dest, because REALITY forwards every
client handshake to it — is now confirmed by the fix working rather than
only by the probe. That finding can be closed.

**fr1's new `www.free.fr` dest is good.** The dest changed hours ago and
nothing had connected through it since; a REALITY dest that a client
cannot handshake against is exactly the failure being fixed, so this
needed proving rather than assuming.

**And the whole deployed stack was exercised end to end** — admin API,
provisioning down to the node, the agent applying it, xray accepting a
REALITY handshake, and traffic egressing. Every layer touched today.

### What it does not settle

One client, from one US residential connection, on TCP. Nothing was
tested from Iran, nothing under censorship, no UDP, and none of the other
protocols (WireGuard, OpenVPN, IKEv2, Trojan, Shadowsocks) or the other
four nodes. The desktop client's own ladder and split-tunnel paths were
not exercised — this was a raw xray client, which proves the *node* and
the *panel data*, not the app.

### Cleanup

Test customer deleted, **0 leftover `protocol_users`** — deprovisioning
reached every node. Local configs and decrypted credentials wiped.

---

## 2026-08-31 — Fleet hygiene, and a certificate that was quietly not renewing

**Status:** done — production changes + installer fixes
**Touches:** `installer/lib/agent.sh`,
`installer/maintenance/push-agent-to-node.sh` (new),
`agent/internal/controlplane/client.go`; de1/ir1 nginx and certbot

### The nginx fingerprint is gone, after I briefly made it worse

`HANDOVER` §6 item 5: de1 and ir1 still served Ubuntu's "Welcome to
nginx". Removing the `default` site fixed the fingerprint and **broke
port 80 entirely** — because `neoxify-fallback` listens only on
`127.0.0.1:8080/8081` (it is REALITY's fallback target, not a public
vhost). The public vhost is `neoxify-http`, which fr1 had and those two
did not; they had been leaning on Ubuntu's default for port 80.

That matters more than the cosmetics: `neoxify-http` is what serves
`/.well-known/acme-challenge/`. Breaking it breaks certificate renewal.
Installed on both, `/var/www/html/index.nginx-debian.html` removed so the
welcome page cannot come back through the new vhost, and a disguise page
written with the installer's own `write_disguise_page` logic — one of
five variants plus a random marker, because a byte-identical page across
six nodes is itself a fingerprint linking them.

All six now answer 200 with a distinct page, and the ACME location is
served on every one. Also cleared: `index.nginx-debian.html` still sat on
tr1, sg1, fr1 and fi1 (harmless while `index.html` exists, but it is the
welcome page one deletion away from returning), and a stale `probe` file
from the installer's 2026-08-19 port-80 check on de1.

### ir1's certificate has not been renewable, and nothing said so

Proving the renewal still worked — after nearly breaking it — turned up
that it was **already broken, and not by me**.

ir1 has two certificates. `ir1-ikev2.conf` is on `webroot` and fine.
`ir1.neoxify.site.conf` was on **`authenticator = standalone`**, which
wants to bind port 80 itself:

```
Failed to renew certificate ir1.neoxify.site with error:
Could not bind TCP port 80 because it is already in use
```

This is exactly the trap `install_xray`'s own comment describes: a fresh
install issues before nginx exists, so standalone is what gets recorded;
nginx then arrives for the fallback site and every future renewal fails.
`ensure_port80_site` migrates those records — ir1 predates it or was
missed. Migrated to `webroot` + `/var/www/html`, config backed up first.

**The expiry is 2026-11-14, so this was ~10 weeks from an outage on the
Iran relay** with nothing reporting it. Worth noting the shape: the cert
monitoring that exists checks *expiry*, and expiry looks fine right up
until it isn't. Nothing checks that renewal can actually run.

### Two installer fixes, and one thing that was not the gap I claimed

**Corrected:** I recorded that the installer derives its gRPC target from
a CDN-fronted panel URL and fails silently. `action_install_agent` does
**not** — it probes `panel_host:50051` and prompts when it cannot reach
it. The gap is narrower and worse: **`action_reenroll_agent` had no such
probe**, and re-enrolment is what a *rebuilt* node runs. The one path
most likely to meet this was the one path that never looked, which is why
finland1 sat OFFLINE after its rebuild. The probe is now in both.

**`install_openvpn` reads `panel_url`/`node_id` back from
`agent.json`** when a caller has not set them, instead of dying under
`set -u` *after* apt has run and three prompts have been answered.

**The agent says what it assumed.** When `grpcTarget` is empty it now
logs the derived target once, next to the dial errors it will cause.

### ir1 cannot reach Cloudflare, and that is worth knowing

Measured from ir1 during this work:

```
connect.neoxify.site -> 188.114.99.0 (Cloudflare)   timeout at 45s
167.233.65.166:443   -> HTTP 200 in 0.28s
167.233.65.166:50051 -> open
```

**Cloudflare is filtered from there; the origin is not.** That is why the
relay's `grpcTarget` must be an address rather than the panel hostname,
and why its GitHub fetch failed during the v0.2.7 rollout.

The client is not exposed to this — `PRODUCTION_API_BASE_URLS` falls back
to `fi1.neoxify.site:2053` and `fr1.neoxify.site:2053`, and **both answer
200 from ir1** (0.78s and 5.8s). Iranian clients pay one failed Cloudflare
attempt and then work. Whether the CDN should still be first in that list
is a real question, and not one to answer from a single datacentre.

`installer/maintenance/push-agent-to-node.sh` does what I did by hand for
that rollout: fetch where GitHub is reachable, verify, copy over SSH,
verify again on the node, install, keep the old binary for rollback.

**Not** done by widening `/api/updates/download/:tag/:asset`. That
endpoint validates the asset against the newest desktop build precisely
so it cannot become an open redirect, and trading that for convenience
would be the wrong fix.

---

## 2026-09-01 — Dest-health monitoring, built

**Status:** done (code + tests) — **not deployed**; needs agent v0.2.8
**Touches:** `packages/proto/agent.proto`, `agent/internal/realityprobe/**`
(new), `agent/internal/controlplane/client.go`, `agent/cmd/agentd/main.go`,
`apps/backend/src/modules/{nodes,agent-gateway}/**`, one migration

The piece deferred on 2026-08-31 for being a fourth unverified change on
one rollout. That rollout has since happened and held, so this is now its
own change with its own rollout, which is what that entry asked for.

**The agent measures, because only it can.** Reachability is a property
of the node-dest *pair* — `www.shatel.ir` was dead from Finland and fine
from Germany on the same afternoon — so the panel cannot answer this and
never could. `internal/realityprobe` reads the dest out of the node's own
Xray config, completes a **TLS 1.3 handshake with certificate
verification**, and caches the answer.

Probed every 10 minutes, reported on the 20-second heartbeat from cache.
The heartbeat never dials: it *is* the liveness signal, and making it wait
on the network is how it stops being one.

**Two new `Heartbeat` fields**, `reality_dest` and
`reality_dest_reachable`. Additive in proto3, so an old agent simply omits
them and an old panel ignores them. The backend loads the `.proto` at
runtime through `@grpc/proto-loader`, so only the Go side needed
regeneration — and regenerating with *no* change first proved the local
toolchain reproduces the committed files byte-for-byte apart from the
protoc version comment.

**The distinction the whole design turns on: absent is not unreachable.**
An agent below v0.2.8 sends no dest, and a node with no REALITY inbound
sends none either. Both are "did not measure" and neither writes, alerts,
or is stored as `false`. Collapsing those two would page for the entire
fleet the moment this ships, before a single node had reported anything —
so the migration's three columns are nullable with no default and no
backfill, and `recordRealityDestHealth` returns early on an empty dest.

Alerting is transition-based like `setStatus`: first bad answer alerts,
an unchanged bad answer stays quiet, recovery says so. No repeat reminder,
unlike the offline sweep — an unreachable dest makes a node useless for
REALITY, so it gets dealt with rather than lived with.

### Verified

`gofmt`, `go vet`, **full agent suite under `-race`, 8 packages, exit 0**
(`-count=1`). Backend **62 suites / 653 tests, exit 0**, typecheck clean,
all three drift guards ok.

Thirteen new tests. The agent's cover config parsing against a realistic
multi-inbound config, the REALITY-less and unreadable cases, an
immediately-closed port, and context cancellation against TEST-NET-3. The
backend's cover the write, the first bad answer, silence on repeat,
recovery, a changed dest, and the empty-dest no-op.

### Not verified

**The succeeding half of `Reachable` is deliberately not unit tested.** It
needs a dest presenting a publicly trusted certificate over TLS 1.3, and
faking that means skipping verification or injecting a root — testing a
weakened version of the check rather than the one that ships. It is
exercised by the fleet audit instead.

And nothing has run on a node. This ships in **agent v0.2.8**; until that
rollout, every node reports nothing and the panel correctly says nothing.

---

## 2026-09-01 — The API mirrors were telling clients they were tunnelled when they were not

**Status:** done — fleet-wide production fix + installer
**Touches:** `installer/lib/agent.sh`; nginx and certbot on the panel and all six nodes

`HANDOVER` §6 item 4, closed. It was worse than that entry recorded, and
the reason is the interesting part.

### What it looked like

```
                    /api/health/ip        my real address is 50.34.35.228
direct (Cloudflare) {"ip":"50.34.35.228"} correct
fr1 mirror          {"ip":"50.34.35.228"} correct
fi1 mirror          {"ip":"204.168.161.100","country":"FI"}   <- fi1's OWN address
```

A client on fi1's mirror asks where it is coming from and is told the
node's address. **That is precisely what a working tunnel looks like** —
to a customer who has no tunnel at all. It is the same class of lie as a
"Connected" indicator that never checked whether traffic flows, which
this repo already has history with.

**Five of six nodes were in that state.** Only fr1 escaped, and not
because it was fixed properly: it proxied to `connect.neoxify.com`, whose
certificate the panel does not hold, and it worked only because **nginx
does not verify upstream certificates by default**. That is the
"quietly stops verifying" outcome `HANDOVER` warned the one-line fix would
produce, sitting in production on one node.

I also caused a fresh instance of it: rebuilding fi1 ran the current
installer, which derives the mirror upstream from the panel URL — the
Cloudflare hostname — so a rebuilt node reintroduces the bug by design.

### The fix, which needed the certificate first

`HANDOVER` said the proper fix "needs a certificate first", and that was
right. `origin.neoxify.site` already resolved straight to the panel;
what was missing was a certificate covering it. Expanded the panel's cert
to `connect.neoxify.site + origin.neoxify.site` (nginx authenticator,
`/etc/letsencrypt` tarred first), added the name to the panel's
`server_name`, and confirmed a **verified** TLS handshake to it.

Then pointed all six mirrors at `origin.neoxify.site` **with
`proxy_ssl_verify on`** and a CA bundle — so the hop is authenticated as
well as encrypted, which fr1's arrangement never was. All six now return
the client's own address.

The installer takes `NEOXIFY_PANEL_ORIGIN` and writes the verification
directives; without it the mirror still works but says loudly what it is
about to do, because a silent wrong answer here reads as success.

### And a node that was one lookup from an outage

Switching de1 turned its mirror into a 502. Its nginx resolver was
`38.54.13.84` — the provider's — and it **refuses nginx's queries
outright**:

```
recv() failed (111: Connection refused) while resolving, resolver: 38.54.13.84:53
```

Not caused by the switch: the mirror re-resolves on a 30s TTL, so that
resolver had to be answering earlier and had stopped. Any panel move, or
any TTL expiry, would have taken de1's mirror down the same way with
nothing pointing at the cause. Now `8.8.8.8 1.1.1.1` — two, so one dead
server cannot do it again.

Worth noting the fleet is uneven here: sg1, fr1, fi1 and ir1 use
`127.0.0.53`, tr1 a single `8.8.8.8`. All answering, all single points of
failure except de1's.

### Verified

All six mirrors return the client address, over a verified hop. Both
panel names answer 200. The Iran relay reaches the fi1 and fr1 mirrors,
which is the path that matters most — Cloudflare is unreachable from
there, so for those customers the mirror is not a fallback, it is the
only way in.

---

## 2026-09-01 — The Xray DNS latency item: not the node

**Status:** narrowed, not closed — measurement only, nothing changed
**Touches:** nothing

`HANDOVER` §6 item 10 records Xray REALITY DNS latency at 2.0–5.6s
against WireGuard's 0.16s, "DNS-specific and unexplained". Measured what
can be measured from here.

**The node's own resolution is not slow.** On fr1, `getent hosts` for
four popular names: **0.00–0.01s each**. And Xray on that node has **no
`dns` block at all**, so it uses the system resolver — the same
systemd-resolved that just answered in a hundredth of a second.

**Per-request latency through the tunnel is flat and unremarkable.** From
a US client to the French node, with DNS resolved remotely at the node:

```
                        appconnect   total
www.wikipedia.org          0.79s     1.46s
github.com                 0.53s     1.54s
discord.com                0.52s     1.18s
store.steampowered.com     0.53s     6.65s   <- did not reproduce
```

`appconnect` — the TLS handshake to the destination — is steady at
~0.5s everywhere, so the REALITY hop is not the variable. The one
6.65s reading looked like the reported symptom, so it was repeated:
**five further runs gave 1.61, 1.83, 1.82, 1.90, 1.76s**, against a
github control at 1.47–1.50s. It was a cold one-off, not a pattern.

### What this does and does not settle

It moves the item from "unexplained" to **"not the node"**, which is
worth having: the node's resolver, and Xray's use of it, are ruled out.

It does **not** reproduce the reported figure, and cannot rule it out
either, because the original was measured on the Windows desktop client
and this was not. That client has its own DNS path — the split-tunnel
redirect and whatever the service does with lookups — whereas a raw
SOCKS client with `--socks5-hostname` hands the name to Xray and lets the
node resolve it. **Those are different code paths, and only the second
was tested.**

So: if the 2.0–5.6s is real, it lives on the client side of the tunnel,
not on the node. That is where to look next, and it needs the client,
which means it needs Windows.

---

## 2026-09-01 — Light theme: not attempted, and why

**Status:** declined for now — needs eyes on a running client
**Touches:** nothing

`HANDOVER` §6 item 11: "No light theme exists — `theme.css` defines
`:root` and `.dark` identically."

Confirmed, and it is more literal than it reads. `theme.css:30` is a
single rule with a shared selector list:

```css
:root,
.dark {
  /* 28 tokens, one palette */
}
```

So there is one palette, applied whether or not `.dark` is on the
element, and **no theme switch exists anywhere in the UI** — grepping the
client for a toggle, a `setTheme`, or a `classList` change on `dark`
finds nothing. Both halves are missing, not just the values.

**Not attempted deliberately.** It is designing 28 colour tokens and a
toggle for a Windows application that cannot be built, run, or looked at
from this machine. Contrast, focus rings, the RTL/Persian screens, the
connection-state colours that customers read to decide whether they are
protected — none of that can be checked by reasoning about hex values,
and a palette that merely compiles is not a light theme.

This is the same rule the rest of this session has been applying to
tunnels and packet captures, pointed at pixels: shipping it unverified
would be the substitution `CLAUDE.md` warns about, in a place where the
failure is visible to every customer rather than hidden in a log.

What would make it doable: any machine that can run the client, or a
decision that a screenshot pass in the Android client's shared UI is
close enough to design against. It is genuinely small work once it can
be seen.

---

## 2026-09-01 — The desktop crate can be type-checked here after all

**Status:** done — environment capability, corrects an earlier entry
**Touches:** `CLAUDE.md`

Two CI failures on `claude/cme-placement-fix`, twenty minutes apart, both
guessed at rather than read — the API was rate-limited and I could not
fetch the log. The second guess was wrong. That is the point at which
guessing should have stopped, so it did.

**`cargo check` does not link.** With the `x86_64-pc-windows-gnu` target
and mingw-w64 providing the C cross-compiler `ring`'s build script wants,
the service crate type-checks on macOS:

```bash
cargo check --target x86_64-pc-windows-gnu -p neoconnect-service --all-targets
```

It named the error immediately: `no_live` undefined, seventeen times.
`owner.rs` has **two** separate `#[cfg(test)]` modules; the stub went into
the first and every call site is in the second. Moved to file scope, and
both branches now `cargo check` clean at exit 0.

**This corrects what I wrote in `CLAUDE.md` yesterday** — that the Mac
"cannot compile the Windows desktop client *or run its tests*". Half of
that was wrong. It cannot **link or run** them: `windivert-sys` needs
`WinDivert.lib`, so `cargo test` still requires Windows and CI is still
the only thing that can say whether tests pass. But every type and borrow
error is now catchable locally, on the crate this session twice called
untouchable.

The rule in `CLAUDE.md` stands, narrowed: **check locally, then push and
read the desktop job.** What changed is that the compiler is no longer
twenty minutes away.

---

## 2026-09-01 — Everything merged to main; two archive statements are now superseded

**Status:** done
**Touches:** `main`

`claude/fleet-hygiene-and-installer-gaps` (fast-forward) and both
concurrent-multi-exit branches are on `main`. Nothing is left unmerged.

The feature was merged **on the owner's explicit instruction**, reversing
the hold recorded on 2026-08-27. Its precondition had been met in the
meantime: `placement()` no longer reports `fallback` for an application on
a live concurrent exit.

**Two statements in `windows.md` are now false, and are left standing
because that file is an archive of what was true when written:**

- *"`concurrent-multi-exit-v2` was not merged, as instructed"* — it is
  merged now.
- *"`placement()` is wrong for live concurrent exits and should be fixed
  before the feature is shown to a customer"* — fixed, and that fix came
  in with it.

Also settled since that entry: *"`{finland1}`'s REALITY route needs
someone with node access to look at it."* Someone did — the dest was
unreachable from that node, it is now `www.helsinki.fi`, and a real client
has carried traffic through it.

**Still open from the same entry, and not changed by merging:** the picker
→ Tauri → service path has never been driven (the rig went over the pipe),
and the free-port race was never observed in either direction. Those are
questions for whoever cuts the next `desktop-v*` tag; there are live beta
users on that client.

The merged tree was verified rather than the branches: desktop
`cargo check` clean, agent green under `-race`, backend 62 suites / 653
tests, four drift guards ok.

---

## 2026-09-01 — `neoxify.site` is being censored in Iran

**Status:** live incident — server-side mitigation in place, **client release needed**
**Touches:** panel certificate only

Found while deploying the backend: five nodes reconnected in ~15s and
**ir1 did not**. The agent was retrying correctly once a second — this is
not the wedge bug — with:

```
tls: first record does not look like a TLS handshake
```

### What is actually happening

Measured from ir1:

```
fi1.neoxify.site      -> 10.10.34.35     (Iran's block-page sinkhole)
fr1.neoxify.site      -> 10.10.34.35
origin.neoxify.site   -> 10.10.34.35

by IP, SNI = fi1.neoxify.site   -> no peer certificate
by IP, no SNI                   -> Verify return code: 0 (ok)
```

**`*.neoxify.site` is DNS-poisoned and SNI-blocked.** `www.google.com`
returns 200 from the same host, so this is targeted rather than an
outage, and it began within the last few hours — those same mirrors
answered 200 from ir1 earlier today.

### What still works, and what does not

**Tunnels are fine.** REALITY dials the node's IP with the *decoy* SNI,
and `www.helsinki.fi` / `www.free.fr` both hand back
`Verify return code: 0` from Iran. Customers already provisioned can
still connect.

**The API is not.** All three of `PRODUCTION_API_BASE_URLS` —
`connect.neoxify.site`, `fi1.neoxify.site:2053`, `fr1.neoxify.site:2053`
— are on the blocked domain. Login, config refresh and subscription
checks fail for Iranian customers.

### The architectural finding

`config.ts` argues the CDN domain is separate from the marketing site so
"a block aimed at one cannot take the other with it". That reasoning was
right and the implementation did not follow it: **all three API bases
share one registrable domain**, so one domain block took every fallback
at once. Fallbacks that differ only by hostname are not fallbacks.

### Mitigation now live

`connect.neoxify.com` was already in the panel's `server_name` but not on
its certificate, so it completed TLS and then failed validation. Expanded
the certificate to `connect.neoxify.site + origin.neoxify.site +
connect.neoxify.com`, reloaded nginx, and:

```
https://connect.neoxify.com/api/health   ->  200 from inside Iran
```

`neoxify.com` and `neoxify.net` both resolve correctly from there;
`www.neoxify.net` returns 200, so the download page is still reachable
and customers can be given a new build.

**That path exists but nothing uses it.** The API bases are compiled into
the client, and a censored customer cannot be told anything through an
API they cannot reach — so this needs a client release, and the release
has to be fetched from the website rather than pushed by the updater.

### Not decided, and not mine to decide

Which domain the API should live on, whether `.com` is the right bet when
it is the hosting product's domain, and whether to cut an emergency
client release. The server side is ready either way.

### Follow-up, same day: the whole registrable domain, and the `.com` revert

**The poisoning is domain-wide, not per-host.** From ir1:

```
neoxify.site                          -> 10.10.34.35
www.neoxify.site                      -> 10.10.34.35
nonexistent-probe-91723.neoxify.site  -> 10.10.34.35   (no DNS record exists)
another-random-x7.neoxify.site        -> 10.10.34.35   (no DNS record exists)
```

Names that do not exist still answer with the sinkhole, so **no new
`*.neoxify.site` subdomain can escape this.** Only a different
registrable domain helps.

**The `connect.neoxify.com` mitigation is reverted.** `.com` belongs to a
separate product — a hosting and web-design agency — and the VPN must not
be entangled with it. The certificate is back to `connect.neoxify.site +
origin.neoxify.site`, nginx reloaded, panel healthy.

Worth flagging separately, because it predates this session and is not
mine: **`connect.neoxify.com` already resolves to the VPN panel
(167.233.65.166) and is already in that panel's `server_name`.** The DNS
record and the vhost entry were both there before today. That is a live
crossing between the two products and probably wants cleaning up on its
own merits.

**The domain roles, as stated by the owner:** `neoxify.net` is the main
website; the panel and agents live on `.site`. The block therefore lands
squarely on the infrastructure half, and the fix inside that architecture
is a *second* infrastructure domain — a purchase and DNS decision, not a
code one.

Measured state: `neoxify.net` is clean from Iran (74.208.24.198, 200), so
the download page still reaches customers. Tunnels still carry, because
REALITY uses the decoy SNI. The API does not, because every base is on
`.site`.

---

## 2026-09-01 — Backend deployed and agent v0.2.8 rolled; ir1 held back

**Status:** done — five of six nodes on v0.2.8, dest health live
**Touches:** production only

**Backend.** Production moved from `61a06e2` to `a214dbd` (24 commits),
`20260901_reality_dest_health` applied on boot. Panel was not rebuilt —
zero panel commits in the gap. Backup taken and verified first (32.9 MB).

**Agent v0.2.8** on tr1 (canary), then de1, fr1, sg1, fi1. Every node
reports its own dest and all five are reachable:

```
finland1     www.helsinki.fi:443       ok
france-1     www.free.fr:443           ok
germany-1    www.shatel.ir:443         ok
singapore-1  www.shopee.sg:443         ok
turkey-1     www.donanimhaber.com:443  ok
ir1          (not measured)            -- still on v0.2.7
```

**The design held where it mattered.** Between the canary and the rest,
the five nodes still on v0.2.7 showed `(not measured)` rather than
`false`, and no alert fired for any of them. That is the distinction the
whole feature turns on, and it is now demonstrated in production rather
than only in a unit test.

**germany-1's decoy is `www.shatel.ir`** — an Iranian ISP's site fronting
a German node. It answers, so it is not broken, but it is worth a look:
it is the dest that `windows.md` recorded as dead from Finland, and a
German customer's traffic claiming to head for an Iranian ISP is an
unusual shape.

### ir1 deliberately not upgraded

Its agent connects to the panel **by IP**, but `dialTarget` takes the TLS
`ServerName` from `panelUrl` — `connect.neoxify.site` — which is exactly
the name being SNI-blocked. So the agent announces the censored hostname
on every dial and the middlebox kills the handshake. That is why it has
been OFFLINE, and it is not something a new binary fixes.

Upgrading it would gain nothing and would restart the agent on a node
that is currently serving Iranian customers from config it already holds.
Held until there is an infrastructure domain that is not blocked.

**Its tunnels are unaffected** — REALITY dials the node IP with the decoy
SNI, which still handshakes fine from inside Iran.

Worth recording as a design note: **the agent has no way to separate
"which host do I dial" from "which name do I present".** `grpcTarget`
already solves the first. A censored deployment needs the second too.

---

## 2026-09-02 — The relay is back, through a censored link

**Status:** done — all six nodes ONLINE, Iranian API path restored
**Touches:** panel certificate and vhost, ir1's agent config, agent v0.2.9

### What was actually blocked, restated

Not the servers. Not the addresses. **The names.** The panel's origin
answers from Tehran in 0.28s and always did; every failure this week came
from a poisoned lookup or a blocked SNI.

That is why the fix needed no new hosting, and why moving the panel to a
hyperscaler would have changed nothing — a point settled by measurement
rather than argument: **Snapchat is hosted on Google infrastructure and is
sinkholed in Iran anyway**, because Iran blocks the name and not the host.

### The Iranian API path

A replacement domain on Cloudflare's proxy answers **HTTP 200 from inside
Iran with strict TLS**, no work on our side — Cloudflare terminates with
its own certificate. Cloudflare is *not* blocked there, which corrects
something recorded yesterday: `cloudflare.com` and `zoom.us` both answer
from ir1. The 45-second timeout that produced that wrong conclusion was
the old domain being blocked, not the CDN.

The three new panel names are now in the panel's `server_name` rather
than relying on the default vhost, and the certificate covers one of
them.

### How ir1 came back, which is the reusable part

Its agent dialled the panel **by address** — correct, and already
configurable — and then announced the blocked hostname in the handshake,
because the SNI was derived from `panelUrl`. Every dial died at the
middlebox on a link where the address itself was fine.

v0.2.9's `tlsServerName` separates the two. Set to a name the censor does
not block and the panel's certificate covers:

```
dial   -> panel origin address, port 50051   (open from Iran)
present-> {panel-alt-host}                    (not blocked, on the cert)
verify -> unchanged
```

**Verification was never relaxed.** The temptation here is to turn
certificate checking off and be done in ten seconds; that hands the
censor the connection you were protecting. The override changes *which
valid name* is presented and nothing else.

One trap on the way: the gRPC gateway holds its own copy of the
certificate, loaded at container start. Expanding the cert is not enough
— the backend has to be restarted before the new name is served on 50051.
The nginx side picked it up on reload and the gRPC side did not, which
looked exactly like the certificate not having been expanded at all.

### Also proven, and it is the shape of the bootstrap

From inside Iran, straight to the origin **address** with the unblocked
name as SNI and full verification: **HTTP 200**. No DNS, no CDN, no
cooperation from anything in the middle. That is precisely the IP+SNI
entry the signed bundle is built to carry.

### State

Six of six ONLINE, ir1 on v0.2.9 reporting its dest healthy. The relay is
back on the control plane over a link that is still censored.

**Not done:** the two remaining panel domains are still delegated to the
registrar's nameservers, so their records are not authoritative yet. And
`origin.neoxify.site` still exists and still publishes the origin address
the proxy is meant to hide — it stays only until the node mirrors are
repointed, then it goes.

## 2026-09-02 — the bundle reached nobody

Finished the censorship work: every node's certificate now covers its new
mirror name, the published bundle addresses mirrors by hostname, and the
clients ship with that bundle baked in.

**Mirrors were addressed by IP, and no client could ever have used one.**
The first bundle went out with `https://<ip>:2053/api` for all six nodes.
A client verifies certificates; the node's certificate is for its name.
Every one of those entries would have been rejected at the handshake.
My own verification used `curl -k` throughout and reported six healthy
mirrors. The fix is `Node.mirrorHost`, and the draft now asks only for
nodes that have one, so a node whose certificate covers no useful name
contributes nothing rather than something broken. A test now asserts no
emitted URL is ever an address -- the check that would have caught it.

**The bundle mechanism was inert.** Two independent reasons. `refreshFrom`
was defined and never called from anywhere, so no client fetched a
published list; and `cachedBundle` read only stored state, so a fresh
install had no bundle and fell through to the compiled-in bases --
`connect.neoxify.site`, `fi1`, `fr1`, every one on the domain that is now
DNS-poisoned and SNI-blocked in Iran. A first-time Iranian customer had
literally no reachable address. That is the tester's "Could not reach
Neoxify", and it was never a client bug in the way we guessed: the app
was correct and had nowhere to go.

Builds now bake the published bundle in (fetched at build time, never
committed -- it names the fleet), and a successful request refreshes it
once per run. `cachedBundle` takes the newer of stored and seed, because
after an upgrade the seed is fresher and after a rotation the stored one
is, and only the version knows. Both release workflows set
`NEOXIFY_REQUIRE_SEED=1`: a silent fallback would ship an installer that
cannot reach the service and looks perfectly healthy. Android shares
these modules through `@shared`, so it shared the bug and gets the fix.

**Cloudflare is not a path into Iran.** Measured from ir1: both proxied
panel bases resolve to 188.114.98.0 / 188.114.99.0, TCP opens on both,
and the TLS handshake never completes -- on either address, for either
name, 0 of 5 attempts. `{panel-alt-host-2}` answered 200 once and I
reported it as working; it does not hold. The node mirrors are the real
Iranian path, and the bundle's ordering has to keep them prominent.

**germany-1's mirror is dead from Iran at the IP layer.** Handshake to
`38.60.249.229:2053` never completes from ir1 regardless of SNI --
including `www.google.com` -- while the same test against finland
succeeds immediately. TCP opens on 22/80/443 too. Not a name block. Kept
in the bundle since it is fine everywhere else, but it is dead weight for
the audience that needs the list, and it costs an Iranian client one
8-second timeout during failover.

**Still open.** Five of six mirrors work from Iran; the panel bases do
not, so an Iranian client's only paths are node mirrors -- if those were
blocked there is no third tier. `origin.neoxify.site` still resolves and
publishes the origin the proxy hides; it should go. `{cdn-host}`
is still on GoDaddy nameservers.

### Two ways I misled myself today

`curl -k` in every mirror check. It made a certificate defect invisible
and produced six confident green rows for endpoints no client could use.

A deploy that reported success while doing nothing: `git fetch` failed
transiently inside a `set -e` script, so every later step -- build,
restart, migrate -- was skipped, and the health check I ran afterwards
returned 200 from the *old* container. I reported the deploy as done. Now
each step prints its own exit code, and the migration is confirmed in
`_prisma_migrations` rather than inferred from a healthy endpoint.

## 2026-09-02 (later) — germany, and how nearly I got it wrong

**germany-1's REALITY decoy was `www.shatel.ir`, which germany cannot
reach.** Same defect as finland's, and it had been sitting there
reporting `realityDestReachable=false` since the probe shipped. Replaced
with `www.lufthansa.com`, verified reachable from germany *and*
unblocked from Iran before applying. All six nodes now report reachable.
Its config was `644 root:root`; rewriting it fresh would have produced a
file xray could not read after a restart, which is exactly how fr1 was
broken for a week, so ownership is restored explicitly after the rewrite.

**germany is unreachable from Iran on every protocol.** TLS fails on
2053, 443, 8443, 2083, 2087, 2096 and 9443 alike, so it is not a port
choice; UDP probes to 51820/500/4500/1194 never arrive either. The TCP
handshake completes genuinely -- SYN, SYN-ACK and ACK all captured on
germany -- and then the client's TLS ClientHello is dropped in path. The
block is one-directional: germany reaches ir1 fine (TLS, ping, HTTP 200).
That asymmetry means a germany-initiated reverse relay through ir1 would
work, but the clean fix is a new IP for that node.

Everything else is healthy: six agents ONLINE and heartbeating, xray,
agentd, wireguard, ipsec and openvpn up on all six, five of six mirrors
serving from Iran, and login through an Iranian mirror returning a
correct 401.

### Three measurements I had to throw away

I reported germany blackholed on the strength of a packet capture that
recorded nothing. tcpdump was not installed on that host, and running it
through `setsid nohup ... &` swallowed the "command not found" -- so the
capture was empty by construction and I read that as proof. Installing it
showed the opposite: packets arrive, the handshake completes, only the
ClientHello is dropped.

I then read a traceroute that reached germany at hop 10 as contradicting
the capture, when the capture was simply broken.

And I checked the released APK for the seed bundle by grepping for
hostnames, which found nothing -- but the bundle is base64, and Tauri
compresses the frontend into the native library, so even
`connect.neoxify.site` is not greppable in a working build. The check
could not have succeeded either way. Verified properly by building the
frontend and decoding the payload out of `dist/`: v3, all eight
endpoints, inlined.

The pattern in all three: a check that cannot fail is not evidence, and I
only noticed by testing the method against something already known.

## 2026-09-02 (later still) — the panel is reachable from Iran after all

Chased germany's block to the end and found something more useful on the
way.

**It is the Cloudflare addresses that are blocked, not the names.** ir1's
own agent has been reaching the panel this whole time using
`{panel-alt-host}` as its SNI -- a name I had written off as
blocked. Dialled at the panel origin instead of Cloudflare, every one of
these names is answered from Iran: all seven replacement
domains. What fails is
`188.114.98.0` and `188.114.99.0`, on either name, every attempt.

I had also concluded `{panel-alt-host-2}` was burned because it
returned nothing when pointed at the origin. It was a certificate
mismatch: the panel cert covered connect, origin and the first
replacement name but not the second, and curl was correctly refusing it. Expanded the panel
certificate to all four names; from Iran both panel names now return 200
for `/health` and for `/endpoints/bundle` when resolved to the origin.

So the remaining step is a DNS toggle: grey-cloud those two names so they
resolve to the panel origin, and Iranian clients regain a direct panel
path instead of depending entirely on node mirrors. That closes the gap
flagged this morning -- that if the mirrors went, Iranian clients had no
third tier. The cost is publishing the origin address, which
`origin.neoxify.site` already does today.

**germany is comprehensively filtered from Iran**, and no transport
choice avoids it. TCP connects on 80, 443, 2053 and 22, and on every one
of them not a single byte comes back -- including SSH, whose banner is
server-initiated. Finland answers the identical probe normally. New IP,
or a germany-initiated relay through ir1, are the only two options; the
direction germany->ir1 is clean.

Also confirmed no agent dials `origin.neoxify.site` any more -- all six
use `connect.neoxify.site` -- so retiring that record is safe whenever
the DNS is to hand.

## 2026-09-02 (correction) — ir1 is not Iran

Retracting two conclusions from earlier today. Both were measured only
from ir1, and ir1's network filters differently from the consumer ISPs
customers actually use. Measured again from six Iranian ISP vantage
points via check-host:

**germany is not blocked from Iran.** `http://38.60.249.229/` returns 200
from ir1..ir8 in ~0.15s, and the mirror
`https://{node-mirror}/api/health` returns 200 from four
Iranian nodes. What is true is narrower and much less interesting: ir1
cannot reach germany. Everything I wrote about comprehensive filtering,
about no transport choice avoiding it, and about needing a new IP or a
relay, was wrong. germany needs nothing.

**Cloudflare is a fine path into Iran.** Both proxied panel bases return
200 from Iranian nodes. So the advice to grey-cloud them was wrong too,
and would have traded away the origin-hiding the proxy provides for
nothing. Do not un-proxy them.

**What does hold, and it is the part that matters:**
`connect.neoxify.site` fails from all six Iranian nodes -- refused or
timed out -- while control nodes get 200. `neoxify.site` is genuinely
blocked in Iran. The move to separate domains, the signed bundle, and
shipping it inside the binary were all aimed at the real problem, and the
release stands.

The error was treating a single Iranian datacenter as representative of
Iranian consumer networks. It is a VPS in an IDC with its own upstream
filtering, and it disagrees with residential ISPs in both directions. Any
future "is this blocked in Iran" question gets multiple vantage points
before it gets an answer, and ir1 alone is never sufficient evidence.

The germany REALITY decoy fix from earlier stands on its own -- that dest
was genuinely unreachable from germany and is now `www.lufthansa.com`.
The panel certificate expansion to cover `{panel-alt-host-2}` is
harmless and kept.

## 2026-09-03 — agents moved off neoxify.site

All six agents now reach the control plane on the replacement domain.
Each config went from

    panelUrl      https://connect.neoxify.site/api
    grpcTarget    167.233.65.166:50051  (fr1, sg1: origin.neoxify.site:50051)
    tlsServerName unset

to `panelUrl https://`{panel-alt-host}`/api`, the same origin
address for gRPC, and `tlsServerName `{panel-alt-host}` stated
explicitly rather than left to default off the panel URL.

gRPC stays pointed at the origin address on purpose. Cloudflare proxies
443 and nothing else, so a CDN name as the gRPC target times out on every
dial and leaves the node OFFLINE while agentd looks healthy locally --
finland1 spent its first rebuild in exactly that state. The API half goes
through Cloudflare, which is fine and keeps the origin hidden for it.

Migrated one node at a time, each verified reconnected (heartbeat newer
than 30s) before touching the next, with automatic rollback to the backup
config on failure. Nothing needed rolling back; every node was back within
about fifteen seconds.

**Two things found while checking the node side.** Every node had two
stale `.bak` entries in `sites-enabled`, symlinks to the same file as the
live config, so nginx parsed it three times and discarded the duplicates
with "conflicting server name" on every reload. Mine, from earlier edits.
Removed. de1 had a real file rather than a symlink there -- an older copy
still pointing at `origin.neoxify.site` with public DNS resolvers; nginx
was already ignoring it in favour of the live config, and it is now out of
`sites-enabled` and kept in /root. de1's live upstream was also still
`origin.neoxify.site` and is now the origin address like the rest.

Node-side `neoxify.site` references across agent configs and nginx: zero.

**What still depends on it, and the order to retire it in.** Clients at
0.9.33 and earlier carry `connect/fi1/fr1.neoxify.site` compiled in as
their only addresses, so deleting those records strands every customer who
has not updated. SSH access to the fleet is also by `<node>.neoxify.site`.
The sequence is: let clients take 0.9.34 / 0.2.17, which ship the seed
bundle and no longer need the compiled-in list; then cut a release whose
compiled-in fallbacks are on the new domains; then retire the records.
`origin.neoxify.site` is the exception and can go now -- nothing dials it
any more.

## 2026-09-03 — the updater could not reach the people it was for

Asked whether the auto-updater still worked. It did, and it did not, and
the second half was the interesting one.

**Verified working, cryptographically.** For a client on 0.9.33 the
manifest offers 0.9.34, the download URL resolves through the panel to the
release asset, the served bytes match `sha256sums.txt` exactly, the
manifest signature is byte-identical to the `.sig` CI published, and that
signature validates as Ed25519 against the public key compiled into the
shipped client. Same chain re-verified for 0.9.35.

**But the updater kept its own endpoint list**, separate from the API
bases, and all three entries were on the censored domain -- the panel plus
two node mirrors, every one of them on the name six Iranian ISPs refuse.
So the customers each release exists for were the ones who could never be
offered it: client healthy, release published, and the single channel that
would carry the fix sitting behind the block. 0.9.34 shipped the seed
bundle, fixed the API path, and left this untouched, because the bundle
does not reach here -- Tauri reads this list from its own config.

0.9.35 generates it at build time from the published bundle's panel
entries, new ones first, committed ones kept underneath as the last
resort. Not committed, for the reason below. Desktop only: the mobile app
has no in-app updater, so Play covers store builds and direct APK users
download from the site.

The circularity is worth stating plainly: an existing install behind the
block still needs 0.9.35 fetched by hand. The update that repairs the
update channel cannot travel down it.

### I leaked the replacement domains into this file

`docs/node-address-hygiene.md` was extended yesterday to cover the
replacement names, with the reasoning spelled out -- the old ones are
burned, the new ones are worth something only while nobody holds a list,
and a git grep enumerates them as well as the scrape that found the last
set. I then spent the day writing them into the journal: both panel
alternates, a node mirror hostname, and one line listing seven registrable
domains together, which is precisely the list.

Twelve lines, redacted forward to placeholders. History not rewritten, the
same call as the node addresses in August. Noting it here because writing
the rule and then breaking it within a day says the rule needs to be
checked before committing, not remembered.
