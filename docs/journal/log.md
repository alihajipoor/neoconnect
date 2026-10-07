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
`<germany-1>:2053` never completes from ir1 regardless of SNI --
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

**germany is not blocked from Iran.** `http://<germany-1>/` returns 200
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

## 2026-09-05 — turkey's flapping: their network, our alert spam

Discord filled up with turkey-1 cycling OFFLINE/ONLINE, sometimes half a
dozen times in one minute. Two separate things, and worth keeping apart.

**The link is genuinely bad, and it is the provider's.** turkey-1 logged
91 gRPC stream errors in two hours while every other node logged zero --
same agent build, same config after the migration, same workload (all six
get a 200-user re-assert every minute; turkey's 33 against the others' 30
is just the extra re-asserts after each reconnect). The panel is not the
variable: backend up since 2 September, zero restarts, no GOAWAY and no
keepalive-policy violations. The node itself is fine -- up two weeks, zero
agentd restarts, no OOM, a clean NIC. What differs is the path: RTT to the
panel 79.8ms with 13.6ms of variance against finland's 34.2/0.6, and a
cumulative TCP retransmit rate of 18.8% against finland's 1.7%. The errors
are all transport-level: TLS handshake deadline exceeded, connection reset
by peer, connection timed out, EOF.

**The three-alerts-per-blip was ours.** The stream-close path marked the
node OFFLINE the instant the stream ended, ignoring HEARTBEAT_STALE_MS
entirely, and -- unlike the sweep -- never called
suppressNextOfflineReminder, so the sweep 30 seconds later fired the
repeat as well. That is the "no heartbeat for 0h" in the alerts: a
reminder written for an outage that has persisted, firing on one that had
lasted a few hundred milliseconds. Liveness now belongs to sweepStaleNodes
alone. A node that closes and does not return still goes OFFLINE within a
sweep of the threshold, so the six-day dark outage this alerting exists
for is still caught; a reconnect faster than the threshold is now silent.

Two measurement notes for next time. ICMP said 50% loss from turkey with
0.081ms of jitter, which is the signature of ICMP rate-limiting rather
than loss -- the TCP retransmit counters were the honest number. And that
18.8% is cumulative since boot: a 30-second sample showed zero retransmits
on both nodes, so the loss is bursty, not constant. Neither number alone
would have supported the conclusion.

## 2026-09-08 — a password change that never left the process

Registration emails had not been arriving. The panel logged
`Invalid login: 535 5.7.8 authentication failed` on every send, one on
6 September, five on the 7th, three on the 8th.

The credentials were fine. Decrypting the stored password and
authenticating against the SMTP host by hand succeeded first time, on the
settings exactly as stored -- host, port 587, STARTTLS, that username.
The mail server was fine too: reachable from the panel, and `AUTH PLAIN
LOGIN` advertised after STARTTLS as expected.

What was wrong is that the new password never reached the wire. The
transporter cache keyed on `host:port:secure:username`, and a password
rotation changes none of those. The fingerprint matched, the cached
transporter came back, and it went on presenting the old secret until
something restarted the backend. The settings row showed `updatedAt`
21:55 and a send failed at 21:56:47 -- the admin had already fixed it,
correctly, and the process was ignoring them.

Worst-shaped failure available: the admin UI confirms the save, the
database shows the new value, the mail server would accept it, and every
send still fails.

Restarting the backend restored service immediately. The fix puts the
password in the fingerprint, hashed -- the string is only ever compared,
never used as a credential, and a plain copy of a password in a field
called `fingerprint` is what ends up in a log line or a heap dump. Three
tests pin it; the password-only one fails against the old fingerprint,
which is the point of having it.

Worth noting the shape for next time: "the credentials are correct" and
"the credentials are being sent" are different claims, and the log line
only ever supports the second.

## 2026-09-15 — the app was forbidden from dialling its own endpoints

Asked to check the new domains work on Android and Play. They did not,
and neither did desktop, for a reason that makes everything built this
month moot.

Tauri's HTTP plugin refuses any URL outside the capability allowlist,
before the request leaves the device. The allowlist named one domain --
the censored one. The signed bundle hands the app eight endpoints on
other domains, and the plugin rejected every one of them locally. The app
then fell through to the compiled-in list, also on the censored domain,
and a new customer in Iran could not register.

So the bundle, the seed baked into the binary, the replacement domains,
the per-node certificates and the SNI migration have all been inert on
the client since they shipped. Desktop 0.9.35 and Android 0.2.17 both
carried a correct address list they were not permitted to use.

**A test existed for exactly this and was green throughout.**
api-endpoints.scope.test.ts was written after the same gap shipped once
before -- a CDN domain added to config.ts and not to the capability, with
the same symptom reported from Iran within the hour. It compares the
capability against PRODUCTION_API_BASE_URLS. By now the addresses
customers actually use arrive in the bundle, which that list does not
contain, so the test kept passing while checking a list that no longer
mattered. A test aimed at the wrong target is worse than none: it reads
as coverage.

Fixed by generating the capability globs at build time from the seed,
next to the seed itself and the updater endpoints, so a build cannot ship
an allowlist that disagrees with the addresses it ships. The scope test
now also checks every endpoint in the bundle; reverting the generated
allowlist makes it fail, which is the property it previously lacked.
Verified in the shipped builds' own logs: "+16 glob(s) for 8 host(s)" in
both 0.9.36 and 0.2.18.

Also found while checking: germany's REALITY entry still told clients to
present `www.shatel.ir` after I changed the node's decoy to lufthansa on
2 September. The client SNI and the server's serverNames have to match,
so REALITY on that node was refused for every client for thirteen days.
Fixing the node without fixing what the panel hands clients is half a
fix, and the half I did was the invisible one.

**And I leaked the replacement domains again**, committing a mobile
capability file a local test run had already patched -- the second breach
of docs/node-address-hygiene.md in nine days, same cause both times:
staging a working copy that a generator had touched. Caught before the
branch merged, so it never reached main. There is now a CI check that
fails when a committed capability file contains anything but the legacy
host and localhost, written as a positive allowlist because a grep for
the new domains would have to contain them.

Two release-side notes. GitHub now forces Node 24 on actions built for
Node 20, and separately Google withdrew the legacy `tools` SDK package,
so setup-android exited 1 on "Failed to find package 'tools'" and took
the Android release with it; `packages: ''` skips that install and the
runner's own SDK suffices. And reading CI logs turns out to be possible
with the credential already in the keychain, which would have saved three
blind guesses at this failure.

## 2026-09-23 — iOS: the engine ports for free, the plumbing does not

Started the iOS app now that there is an organisation Apple account,
which Guideline 5.4 requires for a VPN.

**The engine needed no port.** It is 183 lines of Go behind
Start/Stop/Running, built with gomobile, and gomobile takes the platform
as an argument -- the same source that makes the Android AAR makes an
iOS xcframework. CI now builds it for device and simulator, and the app
builds too: `** BUILD SUCCEEDED **`. That is the whole of the free half.

**What does not port is the tun handover.** `Start()` takes a file
descriptor and an Android `Protector`; iOS hands a packet tunnel a
`NEPacketTunnelFlow` and there is no descriptor to give. That, inside a
NEPacketTunnelProvider extension and its memory budget, is the real
work, and none of it exists yet -- the plugin has `android/` and nothing
else.

Three things had to be fixed before any of it could be checked:

- gomobile was installed at `@latest` by reflex. build-xray-aar.sh pins
  it deliberately and explains why at length -- the binary and the bind
  runtime are two different things from the same module, and the one
  time they drifted, 15.4 MB of uncompressed DWARF went into a shipped
  APK. Reinstalled at the pinned commit.
- ci-ios.yml only fired on main, so the first engine commit produced no
  run at all. ci.yml already carries this reasoning for the desktop
  service: the work machine cannot build the target, so branches must
  reach CI. iOS has the identical problem -- gomobile and tauri both
  refuse without a full Xcode, and this box has Command Line Tools only.
  Without it, verifying the packet-tunnel work would mean merging Swift
  nobody had compiled.
- ci-ios.yml had no setup-go, so the engine step died on exit 127. Now
  pinned to 1.26.5 with GOTOOLCHAIN=local, matching the Android release.

Worth recording for the scope conversation: Apple removed VPN apps from
the Iranian App Store, so Iranian customers need a non-Iranian Apple ID
to install anything built here. It does not change the engineering, but
it does change who iOS reaches.

## 2026-09-23 — the iOS packet tunnel exists

The extension builds, in CI and on this machine, and its bundle was
checked rather than its spec: NSExtensionPointIdentifier is
com.apple.networkextension.packet-tunnel, _OBJC_CLASS_$_PacketTunnelProvider
is in the binary, libresolv and NetworkExtension are linked.

**The engine needed no port, and not by luck.** xray-core's
tun_darwin.go already reads a descriptor from `xray.tun.fd`, with a
comment saying it is for NetworkExtension. So iOS takes the same
supported path Android does, into the same Go package -- no fork, no
tun2socks, no second networking stack. The whole iOS problem reduced to
obtaining the descriptor, which NEPacketTunnelProvider does not hand out,
so TunDescriptor finds it by asking each open descriptor its interface
name.

**Four failures, each costing a build.**

Go's net package leaves _res_9_nsearch undefined until libresolv is
linked. The symbol names nothing recognisable from this codebase.

The patcher's "already present" guard read as idempotent and was not:
`tauri ios init` leaves an existing project.yml alone, so a stale spec
survived and the libresolv fix never reached the build that needed it.
It strips and re-applies now.

XcodeGen's `info.path` means "generate a plist here", not "use this one".
Pointed at a committed file it overwrote it, stripping NSExtension --
producing an extension that built, linked and would install, and that the
system would never recognise as a tunnel provider. Both plist and
entitlements are declared as properties now and generated into gen/apple,
where being overwritten is harmless.

And the app target ended up with two `dependencies:` keys. Valid YAML,
silently keeps the last, dropped Tauri's own libapp.a and SDK
frameworks.

That last one matters beyond itself: it surfaced as the app compiling
against the macOS SDK and dying in WebKit -- and so does Tauri's own
incompatibility with Xcode 27. Two unrelated causes wearing one face. A
pristine project, no extension and no patch, fails identically here,
while CI builds it with Xcode_26.6. Without that experiment the second
cause would have been invisible behind the first.

So the app build is blocked locally on toolchain, not on this work. The
answer is Xcode 26 alongside 27; CI builds the extension every run in the
meantime, which is the only place it can be built at all today.

Still never run. A packet tunnel has to carry a packet before any of this
counts, and that needs a simulator the app can actually start on.

## 2026-09-23 (later) — the whole iOS stack builds

CI (iOS) green with all four pieces: the Xray xcframework, the
packet-tunnel extension, the Swift plugin for the app process, and the
Rust side registering it. That is the first point at which iOS is a build
rather than a collection of files.

The app half had to exist because the tunnel cannot start itself. On iOS
the app process may only ask the system to run a provider; the tunnel is
a separate binary with its own entitlement. So the plugin installs the
profile, starts and stops it, and reports state -- the counterpart of the
Kotlin plugin, with a deliberately asymmetric implementation behind one
JS API. Permission there is an Activity result; here it is the user
agreeing to save a configuration, so a saved profile is the only evidence
they agreed. And there is no app list: per-app routing on iOS is the
system's.

Failures, all of the same kind -- conventions that are invisible until
violated:

`tauri::ios_plugin_binding!` rather than a hand-written extern. The
signature guessed wrong and `tauri::ios` is private, so the type cannot
be named from outside anyway. Only `cargo check --target aarch64-apple-ios`
found it: the registration is cfg-gated, so a host build says nothing.

The Swift package must be named for the *crate*, not the plugin. Tauri
links it as a native static library under the crate name, and the error
names the crate rather than the package -- pointing away from the file
that is wrong.

And `git add -A` staged the plugin's entire Rust `target/` directory,
7,008 files. Undone before pushing; the plugin now has its own .gitignore
for target/, .tauri/ and Package.resolved, none of which existed because
the plugin had never been built as its own crate before.

Twice more the same lesson in a different costume: a commit went to main
while every push named a feature branch that had not moved, so CI kept
reporting on an older commit and I read it as "no run created". Check
what branch the commit is actually on before reading CI as evidence.

Still never run. Tauri does not work with Xcode 27, so the app cannot be
built on this machine at all; CI builds it with 26.6. Xcode 26 alongside
27 is the way out, and until then nothing here has carried a packet.

## 2026-09-23 (night) — iOS reaches the app layer

The bridge was cfg'd to Android throughout, so every command returned
unavailable() on iOS -- the Swift plugin existed and nothing could reach
it. Widened for the five it implements. WireGuard, IKEv2 and tunnel_gone
stay Android-only, and list_apps has no iOS equivalent at all since
per-app routing there is the system's.

The connect ladder then had to stop offering what iOS cannot carry.
Attempting WireGuard or IKEv2 on iOS does not fail cleanly: it fails at
the system boundary with a configuration error, which a customer reads as
their own network being at fault rather than the app lacking a feature.
Skipped with a reason, like the IKEv2-with-selected-apps case it sits
beside. The protocols iOS does carry are the Xray ones, which are also
the ones that survive a filtered network, so this costs the intended
customers nothing.

iPadOS was the awkward case in platform detection: it claims to be a Mac
and is only distinguishable by reporting a touchscreen, which no real Mac
does. Tested both directions, since getting it backwards would either
hide every protocol from iPad or offer unbuildable ones to the desktop
client that shares this directory.

Also chased the Xcode 27 break to the end rather than accepting it.
Tauri's Swift package declares both macOS and iOS platforms, so the
obvious theory was that SwiftPM resolved the macOS variant -- removing
`.macOS` from the package changed nothing. The real shape is in the
compiler invocations: Tauri builds its Swift twice, once for
`arm64-apple-ios15.0-simulator` and once for `arm64-apple-macos12.0`, and
only the second fails. That second build is inside Tauri's own build
script, so there is no local fix. Xcode 26 alongside 27 stands as the
answer, and CLAUDE.md now says so rather than leaving the next person to
rediscover it.

## 2026-09-23 — the iOS client becomes something Apple could accept

Four things, and only the first was the one asked for.

**It sold inside the app.** `IS_STORE_BUILD` has existed since the Play
AAB and nothing set it for iOS, so an iPhone build shipped the checkout
call and the voucher redemption. Apple's 3.1.1 names license keys as a
prohibited unlock in its own right, so the voucher path is a violation
on its own, separate from the payment one.

The flag is now set by a script that is the only supported way to build
iOS, rather than by an env var on a workflow step that has to be
remembered. iOS has one distribution channel -- there is no sideloading
path as there is on Android -- so there is nothing to choose between.

The assertion is on absence from the bytes, not on behaviour: a route
that is merely skipped still ships the code behind it. Choosing the
marker took a measurement rather than a guess. The Android release
counts `plans.toAddress`, which in a store build still reads 2 -- the
English and Farsi i18n entries, object literals no tree-shaker can drop
and inert because nothing looks them up. That can only ever give a
relative comparison needing both builds side by side, which iOS does not
have. `checkoutUrl` and `redeem` go 4 and 1 to exactly 0, which is an
absolute claim about one bundle. Verified in both directions: the check
rejects a direct bundle.

**There was no privacy manifest.** Required since spring 2024; the
upload is rejected without one. Both files are derived rather than
chosen. The collected data types are the four the disclosure screen
already lists, so the two cannot drift apart without one looking wrong.
The accessed-API entries came from `nm -u` on the built binaries, which
found what a guess would have missed: the extension reaches
mach_absolute_time and the app does not, so they need separate manifests
rather than one shared file.

**The app has never carried its entitlements.** Found while adding the
personal-VPN one for IKEv2. The app target arrives from Tauri with
`entitlements: path: mobile_iOS/mobile_iOS.entitlements` and no
properties, so the block this repo's script inserted was a *second*
`entitlements:` key -- the same duplicate-key trap the script's own
comment documents two paragraphs further down for `dependencies:`. YAML
kept the last, and the app was signed with Tauri's empty `<dict/>`.

Nothing said so. The simulator does not enforce entitlements, so it
built, installed, launched and screenshotted exactly as it does now. It
would have failed on the first real device, or at submission, with an
error naming the provisioning profile rather than the file. The lesson
is narrower than "check entitlements": a green simulator build is not
evidence about anything that is enforced at signing, and the two failure
modes look identical from here.

The same script's app-target edits were not idempotent either. The spec
had accumulated four identical PrivacyInfo entries and five identical
properties blocks. The strip has to be anchored on the app target,
because the extension's block appears first in the file and was being
stripped instead -- invisibly, since that block is rebuilt from scratch
every run.

**WireGuard and IKEv2 now work on iOS**, so it carries the same set as
Android. IKEv2 needed almost nothing: the system dials it, the Rust
command and the JS call already existed and were merely gated to
Android, and the profile needed no second shape because the iOS side
maps `server` to both the address and the remote identifier, which is
what `Ikev2VpnProfile.Builder(server, server)` already did.

WireGuard needed more. It runs inside the same extension as Xray,
because iOS allows a tunnel extension one principal class, and inside
the same Go framework, because two gomobile frameworks would link two Go
runtimes into one process. It costs almost nothing in size: xray-core
already depends on wireguard-go's device, tun and conn for its own
WireGuard outbound, so go.mod and go.sum are untouched.

The part worth remembering is why the TUN device had to be written out.
`tun.CreateTUNFromFile` opens an AF_ROUTE raw socket and sets the MTU
with an ioctl; both are denied to an app extension, so it fails before
WireGuard starts, with a permissions error that says nothing about
routing. wireguard-apple does not use it either. Two other failures of
the same kind, silent rather than loud: UAPI wants hex keys and the
backend issues base64, which is accepted as a string and handshakes with
nobody; and the network settings have to come from the profile, since
the server assigned the address and putting the phone on a different one
gives a successful handshake with nothing returning.

**What none of this proves.** No tunnel here has carried a packet.
Network Extensions do not run in the simulator and NEVPNManager cannot
dial from one, so all three protocols, and the extension's ~50MB memory
ceiling, are gated on a real iPhone. "CI is green" still means "it
compiles".

Export compliance is left unanswered on purpose. `ITSAppUsesNonExemptEncryption`
is unset: a VPN plainly uses encryption so `false` would be untrue, and
`true` commits to a self-classification filing that is a legal decision
rather than a build setting. Unset, App Store Connect asks at upload.

Two unrelated things surfaced on the way. web-portal's build typechecks
desktop-windows' shared code, which imports the generated
seed-bundle.json that web-portal never generated -- it passed only when
a neighbour's prebuild had run first, and turbo is free to serve that
neighbour from cache. It now generates its own.

And the working tree itself failed. The repo lives under the
iCloud-synced Desktop, the disk was at 93%, and 97 of 1026 tracked files
had been evicted to `compressed,dataless` placeholders that would not
materialise -- reads failing with `ETIMEDOUT` and `Unknown system error
-81` on plainly local files. `.git` was unaffected, so every one was
rewritten from `git show HEAD:`, which loses the executable bit and
needed the modes restored from the index. The real fix is to move the
repo off the synced Desktop; noted here because it reads exactly like
filesystem corruption and is not.

**Two things found after the above was written**, both worth recording
because of how they were found rather than what they were.

The first was in the WireGuard code, before it had ever run. The pure
helpers -- the base64-to-hex key conversion and the CIDR parser -- were
executed against the values the backend actually sends rather than read.
`generate-credentials.ts` puts `allowedIPs: "0.0.0.0/0, ::/0"` on every
WireGuard profile, unconditionally, and the parser split only on `/`, so
`::/0` came back as address "::" with mask "0.0.0.0". Every connection
would have built an NEIPv4Route holding an IPv6 address. It now requires
four dotted octets: returning a plausible answer for input it does not
understand was the whole failure.

The second is not fixed and is now issue #48. Chasing where the IPv6
half of that profile should go led to `engines/ipv6_block.rs`, which
records a measured leak on Windows -- packet capture outside the client,
OpenVPN and IKEv2 leaking outright -- and says of it that "the customer
is told they are protected, and the evidence the app collects agrees,
while an observer on their own network reads their traffic". The reason
it gives is that every node is IPv4-only, which is not a Windows fact.
Neither mobile client has an equivalent: Android adds one IPv4 address
and one IPv4 route, iOS sets ipv4Settings and no ipv6Settings on both
engines, and no `domainStrategy` is set anywhere so Xray runs at `AsIs`.

Left open deliberately. On iOS the remedy is a different mechanism from
the Windows one -- an app has no firewall there, so the usual approach
routes IPv6 into the tunnel, which means the packets reach the engines
rather than being dropped. That is a behaviour change on a path shared
by both engines, on two clients, one of them already on Play, and it
wants the same kind of capture the Windows numbers came from.

## 2026-09-23 (evening) — the app runs on a real iPhone

Signing, from nothing: no Apple account in Xcode, no certificate, no
profile. The team id was read out of the certificate's subject rather
than asked for -- `OU` is the team, which is worth remembering, because
Xcode does not show it anywhere obvious until a profile exists.

Three things had to be done by hand and could not be automated, which is
worth recording so nobody burns time looking for a flag. Developer Mode
is a device-side toggle requiring the passcode and a reboot; `devicectl`
exposes no verb for it, by design. Signing in to an Apple ID is a
credential operation. And a team with zero devices will not have its
first one registered by `-allowProvisioningUpdates` -- that needs the
portal once, after which automatic provisioning maintains the list.

Two bugs in the path to the device, both ours. Tauri sets
DEVELOPMENT_TEAM on the app target from the environment and knows
nothing about the extension added afterwards, so the app signed and the
extension did not. And the device picker filtered on
`reality == "physical"`, which is backwards: a real iPhone reports
`reality: null` and only simulators fill the field in, so it rejected
the phone and would have installed to a simulator -- the false success
the filter existed to prevent, with the sign flipped.

**The entitlements fix is confirmed on hardware.** The installed bundle
carries `7ZMDDWR2XH.com.neoxify.mobile` with packet-tunnel-provider,
allow-vpn and the app group. That is this morning's empty `<dict/>`,
verified where it actually matters rather than inferred from a simulator
that does not enforce entitlements at all.

`devicectl device capture screenshot` works, which changes how the rest
of this goes: the phone's screen can be read directly instead of
described. It is how the Settings rail was diagnosed.

### A correction

The icon commit claims the Play release carries Tauri's logo "because
the same directory feeds Android's generated mipmaps". **That is wrong.**
`release-android.yml` has an explicit step that re-applies
`src-tauri/icons/icon.png` after `android init`, with a comment naming
the precedent: without it, android-v0.1.0 shipped Tauri's logo. That
step exists, and `icon.png` was the Neoxify mark throughout. Play is
unaffected.

What was actually wrong was narrower: the generated `gen/apple` tree
held Tauri's placeholder icons, and nothing in the iOS path replaced
them the way the Android release does. The committed `icons/ios/` set is
now alpha-free and a test pins it, so a regenerated project picks up the
right icons and an alpha channel cannot reach a marketing icon again --
that one is rejected after upload rather than at build time.

### The tree itself

Moved to `~/Developer/neoconnect`. iCloud had gone from evicting files
to duplicating them: " 2" copies reaching `.git/index`,
`.git/refs/heads/main`, and the Xcode project, where `mobile 2.xcodeproj`
failed every build with "you have modified your package name from mobile
2 to mobile". Deleting them did not hold -- the next build produced
`mobile 3.xcodeproj`, faster than a build could run.

`mv` is the wrong tool: the FileProvider-backed Desktop is a separate
volume, so it copies rather than renames, and it hung for fifteen
minutes having written nothing. Clone from GitHub and copy back only the
expensive gitignored artefacts -- the Go xcframework and the fetched
seed bundle. Two minutes.

**Still unproven: that any tunnel carries a packet.** Nothing here
changes that.

## 2026-10-04 — a test VM on the Windows PC, and what it found

### The rig, such as it is

A VirtualBox guest, `Neoxify-Test` (Windows 11 Home, NAT, 4 vCPU/8 GB),
on the Windows PC. Its tooling lives outside the repo, in
`C:\Users\aliha\Claude\vm\tools`, and drives it entirely from the host:
`VBoxManage guestcontrol` for commands, guest-side `SetCursorPos` +
`mouse_event` for clicks (the bootstrapper is mouse-only), `controlvm
screenshotpng` to look. Installs use the branded bootstrapper built the
way `release-desktop-windows.yml` builds it, not the bare NSIS installer.

Ground truth is the exit country from Cloudflare's trace, **from a fresh
process every time** (see below), plus routes, NRPT, adapters, engines
and firewall rules read inside the guest. The app's own reasoning is
read by starting it with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=
--remote-debugging-port=9222` and wrapping `window.fetch`, which is
Tauri 2's IPC on Windows -- every command, its timing and its answer.
`__TAURI_INTERNALS__.invoke` cannot be wrapped: it is non-writable.

**There are no packet captures yet**, and NAT gives the guest no IPv6,
so every IPv6 check here is vacuous. Anything that needs either is
still unverified.

### Results, all on fi-finland

All eight protocols carried traffic out through the node and tore down
clean: Stealth, Fast, Compatible, Shadowsocks, Stealth Web, Built-in,
Stealth HTTPS, Stealth Lite. Disconnect replies 19ms (WireGuard) to
781ms (first Xray). Killing the app, and closing it with the window's
X, both left nothing within 3s -- in Custom mode too, including its
firewall rules and the ping block. An upgrade over a live tunnel took
it down and the relaunched app said so.

### Fixed today, found only by running it

- **A working OpenVPN was rejected on every first connect** (b5cb2cb).
  The verify asked one `/health/ip` at a time; the one made as the new
  adapter's address settled stalled past the whole six-second failover
  budget. Attempts now overlap. Before: three of three rejected. After:
  kept, proof 4.0s after connect.
- **Custom mode said "Not carrying traffic"** over a tunnel carrying the
  selected app (c329c5b) -- a stale closure in the health poll -- and
  the header said "Everything on this computer goes through Neoxify".

### Seen, not acted on

- `Neoxify-OpenVPN` disappears whenever an Xray protocol starts, and an
  upgrade removes it too, so OpenVPN recreates it far more often than
  "first connect only". About a second each time; recorded in
  `openvpn.rs`.
- With Compatible selected, a rejected first OpenVPN rung followed by an
  accepted second one is announced as "Your usual protocol didn't get
  through. Now using Compatible" -- true of the rung, odd to read.
- Once, before the OpenVPN fix, WireGuard tried right after a rejected
  OpenVPN carried nothing for 20s. **Not reproduced** by switching by
  hand; the ladder path that produced it no longer runs in that order.

### Traps that cost time

- A long-lived PowerShell `Invoke-WebRequest` loop reported "US" for a
  minute through a working tunnel: keep-alive reuses a connection made
  before the tunnel, and that connection stays on the physical NIC. Use
  `curl.exe` or `-DisableKeepAlive`.
- The guest's Widgets panel and the desktop wallpaper's "learn more"
  both open on stray clicks and steal the next ones.
- VirtualBox allows 32 guest sessions; timed-out calls leak them.
- `screenshotpng` fails with E_FAIL once the guest display sleeps; a
  Shift keypress wakes it.
- The bootstrapper's window opens somewhere different each run --
  `click-install.ps1` finds it by handle.

### Blocked

- **Gaming mode**: the test account's plan does not include it.
- CI's "TypeScript (backend + panel)" job failed once on
  `api-endpoints.scope.test` and passed on rerun with no change -- it
  reads a seed bundle fetched live, so it can flake on that.

## 2026-10-05 — captures in the VM, and DNS confined on seven engines

### The capture, and the one that lied

The rig now captures. Not where the old one did -- outside the guest,
on the host side of its vNIC -- because VirtualBox's own `--nic-trace`
turned out to **silently drop the guest's outgoing global IPv6**: an
IPv6 ping that `pktmon` inside the guest showed going out, and VirtualBox's
NAT answering "unreachable", was simply absent from its trace. IPv4 it
records fine, which is what makes it dangerous: it would have passed
every IPv6 leak test by not seeing the packets.

What is used instead is `pktmon start --capture --comp nics` in the
guest: the NIC miniport, below WFP, the Neoxify filters and WinDivert,
so anything there left the machine and anything blocked never reached
it. The tooling is `nic-leaks.ps1` / `leak-test.ps1` (IPv6 and IPv4
destinations, outliers printed in full) and `dns-bound.ps1` (below),
all in `C:\Users\aliha\Claude\vm\tools`. Every check was run once with
the VPN off first, to prove it can see a leak at all.

IPv6: this PC has none, so nothing can ever answer the guest. The guest
already had VirtualBox's ULA prefix and a default route (and got a
documentation-range address on top, active-store only); a leak shows
as packets *sent*. That is enough for "does IPv6 escape the tunnel" and
says nothing about a real dual-stack path.

### What it found

- **IPv6: nothing escapes, on all eight protocols** in full tunnel. In
  Custom mode a selected app's IPv6 is refused and `ping -6` is blocked,
  as the app says; unselected apps' IPv6 goes direct, by design.
- **IPv4 in full tunnel: only to the node**, apart from single one-byte
  TCP keep-alives on connections opened before the tunnel came up --
  the "flows already open are not re-examined" gap `ipv6_block.rs`
  already states.
- **DNS leaked on three engines -- seven of the eight protocols** (cfa67eb). Windows'
  connectivity probes query per interface, bound to the NIC's address,
  which skips NRPT and the routes: on Xray they went out in clear text.
  Asked for on purpose -- a query bound to the NIC, one to the on-link
  resolver -- WireGuard let the first out (its kill-switch permits DNS to
  its resolver on any interface) and IKEv2 the second. OpenVPN refused
  both: `block-outside-dns`. Now every engine but OpenVPN gets the same
  filters from `ipv6_block.rs`, and all eight show 0 queries at the NIC
  where 4 of 4 left with the VPN off.

### Gaming mode cannot be tested, and that is not a gap

The test account's plan lacks `GAMING_DNS`, but granting it would only
change the app's message from "not in your plan" to "no resolver":
`gaming.module.ts` says there is no node-side resolver at all and the
DNS half is a dead branch, decided 2026-08-25. Nothing was changed in
production.

### Traps

- **An upgrade hung once**, "Installing..." for 14 minutes, while the
  guest was exhausted (32 guest-control sessions leaked) and Windows
  Security showed "Threats found". Defender had **no** detection,
  quarantine or event to back that toast up, so it is not blamed. A
  power cycle mid-install left the app without its service; a clean
  reinstall took 26s and four upgrades since took 20-39s. Not
  reproduced; watch for it.
- The picker re-sorts by latency, so clicking rows by position picked
  the wrong protocol. `app-js.ps1` drives the app by label over
  DevTools (`ui.js`: `clickLabel`, `pickProtocol`).
- NRPT redirects even an explicit `Resolve-DnsName -Server 10.0.2.3`
  into the tunnel, so the resolver API cannot show this leak; only a
  raw socket can.
- VirtualBox's trace stamps frames relative to when tracing began, and
  grew ~90 MB a minute from Windows Update; it is now off in the VM's
  saved config.

## 2026-10-05 — signing out left the tunnel up, on every client

Reported from Android: connected, signed out, and the VPN stayed up and
kept carrying traffic. Read across all three clients, it was true of
every way a session ends, not only that button.

### What it was

- **Windows/macOS** (shared UI in `apps/desktop-windows/src`): Sign out,
  account deletion and a refused token refresh all ended in
  `endCustomerSession`, which cleared tokens, the credential snapshot
  and the gaming cache -- and never the tunnel. The service ends a
  tunnel only when the app *process* goes, and signing out does not end
  it, so the sign-in screen sat over a live tunnel with nothing on it
  able to disconnect. The refused refresh was worse: only the
  Dashboard's first load acted on `sessionExpired`; every other caller
  dropped it, leaving the app signed out on disk and in on screen.
- **Android/iOS** (`apps/mobile`): every route to sign-in was a bare
  `setScreen("login")`; the expired-session one did not even clear the
  cached credentials. And stopping would not have been enough: Android
  keeps the platform IKEv2 profile (username and password) under
  Settings > VPN, iOS keeps the tunnel profile with its engine config
  in `providerConfiguration` plus the IKEv2 profile and keychain
  password -- each can be switched on from system Settings with the app
  signed out.
- **macOS** is not a client yet: `vpn_connect` refuses and `vpn_status`
  says nothing is connected. It runs the shared UI, so it gets the fix
  with nothing to tear down.

### What changed (`claude/signout-ends-tunnel`)

- `endCustomerSession` takes the tunnel down **first**, credentials
  after, and returns `down` only when the platform answered that
  nothing is connected (`tunnel-teardown.ts`; bounded at 10s, re-sends
  the disconnect while the tunnel stays up). The App shows "Signing
  out..." until then, and says on the sign-in screen when it could not
  confirm.
- A session generation, bumped before the teardown starts, is checked by
  both connect ladders after every engine they bring up, so a connect
  still in flight cannot leave a tunnel up after the sign-out's teardown.
- A refused refresh (401 only) is announced to the whole app and ends
  the session wherever it happened. A refresh that merely failed --
  unreachable, 5xx, 429, a CDN's 403 -- no longer clears the tokens; it
  used to, and now that ending a session disconnects, it would have cut
  somebody's VPN over one dropped request.
- Mobile: new `vpn_forget_profiles`. Android deletes the provisioned
  IKEv2 profile; iOS empties the tunnel profile's config (kept, so no
  new consent prompt) and removes the IKEv2 profile and its keychain
  item.

### Proven, and not

- Desktop JS tests (413) and typechecks pass on Windows; the plugin
  crate passes `cargo check`; CI is green on the branch.
- **Windows in the VM: not run.** The installer is built
  (`C:\Users\aliha\Claude\vm\Neoxify-Setup-signout.exe`), but from 08:49
  to past 09:10 another session was driving `Neoxify-Test` (installing
  0.9.42, walking the picker and Settings), and this one did not take
  the VM out from under it. Unverified until it runs.
- **Android, iOS: unverified.** No SDK or device here; the Kotlin was
  not compiled at all, the Swift only by ci-ios.

### Server side, not changed

`/customer-auth/logout` bumps `tokenVersion`, which revokes the refresh
token of **every** device on the account; access tokens stay valid for
their 15 minutes. Nothing touches the protocol credentials: they are
per subscription and route, and stay valid on the nodes until the
subscription ends, so a WireGuard key or Xray UUID copied before
sign-out keeps working after it. Two consequences wanting a decision:
with this branch, signing out on one device ends the others' sessions
-- and now their tunnels -- at their next refresh; and real revocation
on sign-out needs per-device credentials (or rotating the
subscription's on "sign out everywhere"), pushed to the nodes.
## 2026-10-05 — per-ISP tags, Automatic, and the phones get the ladder

Branch `claude/isp-recommendations`, not merged, nothing deployed.

**What exists now.** `/health/ip` also returns the caller's ASN and a
signed attestation of it (`n1.<asn>.<time>.<mac>`, 24h), read from an
offline iptoasn.com table (public domain) loaded in memory and fetched
daily -- 581,644 ranges, under a second, about 40 MB of heap, measured
against the real file. Our node and mirror addresses are never anyone's
network (exact match, fails closed). Clients keep the attestation from
the *pre-connect* baseline and attach it to attempt reports and the
route-list request; ladder rungs now name their route and whether it
carried; one SESSION report goes out after ten minutes of continuous
health. Per (ASN, route) over 48h, distinct signed-in customers by
their latest attempt: "worked" needs >= 5 who got through and stayed
up and >= 60% of those who tried; "failing" needs >= 5 failures and
<= 25% getting through. Codes go out as `ispTag` on the route list; the
panel has an ISP Recommendations page.

Picker: "Automatic (recommended)" is the first row and the default for
anyone without a pin; tiles say "Automatic" until a tunnel settles,
then "Server (auto)" and where it landed. Tags sit in each row, with a
filter. In `orderCandidates` tags are a tie-break below pin, last-good,
live probe and device history, and only on a network the device has no
evidence for -- the first run. Mobile now uses last-good, history and
the TCP probe (new `probe_tcp` in the mobile Rust side), keyed on
`asn:<n>` because the phones have no gateway fingerprint.

**Proven:** backend unit tests (aggregation thresholds, ASN table incl.
IPv6 and corrupt gzip, attestation, own-node rule, DTO), desktop and
mobile JS tests, typechecks of Windows/macOS/mobile/web-portal, mobile
`cargo check` on the host. **Unverified:** everything end to end -- no
backend was run against a database here (no Postgres/Docker on this
PC), no real ASN has produced a tag, no client was run, no phone used.
Not proven either: whether the production container can reach
iptoasn.com.

**Deploy order matters:** backend (with migration
`20261005_isp_recommendations`) before clients. Clients only send the
new fields once the server has issued an attestation, so the reverse
order loses nothing -- but it also collects nothing.

## 2026-10-05 (night) — deployed, verified in the VM, released 0.9.43 and mobile 0.2.22

**Backend.** Production went from `ea3ba87` (2026-09-30) to `b8d1850`
over SSH, after a database dump. Both migrations applied, the ASN table
loaded (581,630 ranges), `/health/ip` returns an ASN and a signed
network token, and `customer_sessions` rows appear for real sign-ins.
The deploy found a six-week-old bug: compose passes an unset
`EXIT_HANDLE_SECRET` as the empty string and `??` kept it, so every
exit handle was null in production from 2026-08-26. Now `||`, with a
test.

**Desktop RC (main `2812c3a`) in the VM**, upgraded over 0.9.42 with
the session kept (service hash checked against the local build):

- Automatic is the first picker row; connecting with it settled on
  fi-finland / Stealth, "You're protected", exit FI. No ISP tags yet,
  which is expected: a tag needs five customers on one ASN in 48h.
- DNS batch, all 8 protocols: exit FI, zero DNS left the NIC.
- NIC capture, all 8 protocols: no global IPv6 sent, IPv4 only to the
  node, except the known FIN/ACK and keepalive residue on connections
  opened before the tunnel. Built-in's first capture was taken while
  disconnected (the app had died with the guest-control session that
  launched it) and is a control, not a result; the rerun connected is
  clean -- 98 packets, all to the node.
- Sign-out with Built-in up: tunnel down (exit US, no RAS connection),
  the logout request blocked locally (16 attempts -- the POST walks
  every endpoint and each failed instantly), and the server session
  untouched (`revokedAt` null). The saved session was put back and the
  app came up signed in, refresh working.

**Released** `desktop-v0.9.43` and `android-v0.2.22`. **Unverified:**
Android on a device -- nothing of mobile 0.2.22 has run on a phone
here; iOS needs the Mac. Still open: a signed-out client's VPN
credentials stay valid on the nodes until revoked server-side
(per-device credentials would fix it); node SSH access; ir1 offline
since 2026-09-12.

## 2026-10-05 (late) — per-device VPN credentials, backend (branch `claude/per-device-credentials`)

The gap the night entry left open: signing out revoked the device's
refresh session but not its VPN credentials, which were per
subscription and shared by every device. Design in
`docs/per-device-credentials.md`.

`ProtocolUser.sessionId` (nullable, FK to `customer_sessions`, RESTRICT;
migration `20261007_per_device_credentials`, additive, no backfill).
NULL is the shared credential every existing row already is. A device
whose access token carries `sid` is given its own credential on each
route of its ACTIVE subscriptions the first time it calls
`GET /customer/protocol-users` (or switch-route), and is answered with
those, any gap filled by the shared row. Sign-out revokes the session,
then `DELETE_USER`s that session's rows on every node -- no other
device's. Password reset/change and an admin-set password end the other
sessions and their credentials; a change keeps the caller's session. An
hourly `device-credentials` sweep retries failed revocations and
reclaims sessions idle 30 days *and* without traffic for 30 days.
Device cap 5 per customer (`CUSTOMER_DEVICE_CREDENTIAL_LIMIT`), LRU
eviction. WireGuard allocation now serialised per config. Usage, caps,
expiry, concurrency, re-assert and deletion all key off
`subscriptionId` and needed no change. No agent change, no client
change.

Shared credentials stay valid and provisioned (phase 1). So sign-out
does **not** yet cut off a copy of the shared credentials a device held
before its first fetch after deploy. Revoking them is phase 2 and an
owner decision; the doc has the preconditions.

**Proven:** backend typecheck, lint, and unit tests -- 78 suites, 860
tests (77/825 before), including mutation checks that the shared-only
legacy list, the signed-out-session refusal and the WireGuard lock are
each caught by a test when removed; `prisma migrate diff` from the
previous schema produces exactly the committed SQL. **Unverified:**
everything end to end. The migration has not run against a database, no
node has received a per-device user, no client has connected with one,
and no sign-out has been seen to remove one from a node. Also unproven:
that Windows' built-in IKEv2 and iOS's NEVPNManager profile pick up new
credentials on the next connect rather than reusing stored ones.

Found, not fixed: deletion, quota/expiry suspension and the concurrency
disconnect send user commands without `transport`/`inboundTag`, so on a
multi-inbound node they can miss the real inbound; an admin disabling a
customer touches no credentials.

## 2026-10-06 — per-device credentials reviewed and fixed; the plan's device limit as device slots (same branch)

**Status:** backend done on `claude/per-device-credentials`, not merged,
not deployed. Clients not started.
**Touches:** `apps/backend` (protocol-users, usage, customer-auth,
customers, agent-gateway, plans, billing, subscriptions, new
`device-slots`), `infra/docker-compose.prod.yml`, `infra/.env.example`,
`.github/workflows/ci.yml` (migration step), agent comments only,
`docs/device-slots.md` (new), `docs/per-device-credentials.md`.

**Owner decisions taken (2026-10-06), so they are not re-litigated:**
`maxConcurrentConnections` means devices *using* the VPN at the same
time (Starter 1, Pro 2, Trial 2, Ultimate/Ultimate Max unlimited).
Option A: the second device is refused before it connects, told where
Neoxify is in use, and offered "Use on this device instead"; the device
taken over is told why and does not run the ladder. Signed-in device cap
is a hidden 10 (was 5). Shared credentials stay valid for now (phase 1);
30-day idle reclaim confirmed; password change/reset revokes other
devices' credentials. **Coordinator decisions:** the node-side cut runs
in shadow mode by default (`CONCURRENCY_CUT=shadow|enforce`); device
slots on by default (`DEVICE_SLOTS=enforce|off`, only clients that claim
are affected); the control plane is never a precondition for connecting.

**Review findings fixed** (35 confirmed, many duplicates; every high and
medium, the cheap lows): cooldown replaying revoked credentials (gone --
replaced by a lease the re-assert skips); device credentials served
before a node had them (now gated on the ack, `provisionedAt`); Xray
counted five times per node (max, not sum); untargeted
delete/suspend/cut commands (one helper); plan speed-cap edit dropping
Xray users (CREATE_USER with credentials, shapeable protocols only);
migration FK breaking sign-in on rollback (SET NULL); WireGuard pool
exhaustion aborting paying customers' provisioning (device reserve,
per-route catch, invoice kept); deletion racing lazy provisioning
(customer lock, sessions revoked); session churn (10 new device sets per
hour); endSessions outside the lock; password revocation now
transactional; re-assert skipping signed-out devices; eviction by
liveness; WireGuard address on DELETE_USER; device cap settable in
production; plaintext credentials stripped from acked commands; stale
comments. Deferred ones, with reasons, are in
`docs/per-device-credentials.md`, "Known, deferred".

**Device slots** (`docs/device-slots.md` is the contract for the app
agents): `POST /customer/vpn/claim|renew|release`, 409 `DEVICE_LIMIT`
with holders (label, since, lastSeen) and never 401, renew answers
`displaced`, 90 s staleness from renewals *or* traffic, takeovers logged
past 10/h and refused past 30/h, released on sign-out, password change,
eviction, suspension/expiry and account deletion. Sessions gain `label`
and `platform` from `X-Neoxify-Device-Label/-Platform` (never a
hostname; the backend drops anything hostname-shaped).
`GET /customer/subscriptions` carries `deviceLimit`. The backstop judges
per device (shared credentials one pseudo-device), never holds a slot
holder, and in shadow mode only logs `[shadow] ... would hold device X`.

**Migrations** (all additive; `prisma migrate diff` from main's schema
produces exactly their union): `20261007_per_device_credentials` (edited
in place -- never applied anywhere: FK now SET NULL, plus
`provisionedAt`), `20261008_concurrency_holds` (`heldUntil`),
`20261008_session_labels` (`label`, `platform`). New spec
`src/migration-safety.spec.ts` fails if a pending migration drops,
renames or tightens anything; move its `LAST_DEPLOYED` when a deploy
lands.

**PROVEN (tests and CI only):** backend 84 suites / 992 tests (78 / 860
at the start of this session), typecheck and lint clean; mutation checks
that the provisioned gate, the hold filter in the re-assert, the
deletion lock, the endSessions lock, the slot-holder exclusion, the
device-set rate limit, the WireGuard reserve and slot staleness are each
caught by a test when removed; an HTTP-level spec of the slot contract
on a real Nest server with the production validation pipe; the built
backend booted locally against nothing far enough to resolve the whole
module graph and map `/customer/vpn/{claim,renew,release}`. **New CI
step** (`ci.yml`, TypeScript job): all 46 migrations applied in order to
the job's empty Postgres 16, `migrate diff` against `schema.prisma`
reported no difference, and `test/sql/rollback-check.sql` (the previous
backend's sign-in prune, with a signed-out session owning a credential)
succeeded with the credential kept as a shared one -- green on
`a9163ab`, all four jobs, Go agent included (so the comment-only agent
edits build). Desktop JS 32 files / 435 tests and typecheck, mobile JS 4
files / 34 tests and typecheck -- unchanged code, run as a baseline.
**UNVERIFIED:** everything against real nodes, devices, Redis or a
database with real data. No node has acked a device credential; no app
claims a slot; the backstop has never seen a real report;
presence-from-usage-deltas is reasoned from the agent and client code,
not measured; Xray connections open when a hold starts may survive it;
iPhone, Android in the background and an Iranian network untested.

**Second review, of the slots and the backstop (later 2026-10-06), all
twelve findings fixed on this branch:** the slot endpoints count 60
requests a minute per access token instead of the global 100 per
address (mirror and tunnel egress addresses are shared by many
customers), and the contract names exactly what stops a dial (409
`DEVICE_LIMIT`/`SUBSCRIPTION_INACTIVE`, 429 `TAKEOVER_LIMIT`); a slot
does not expire under a device that carries traffic without renewing;
new obligation 11 says what a connected device does with a refused
post-connect claim; Xray's session counts (60 s tail) no longer make a
device active; a grant lifts any hold on that device and re-asserts it
at once, a holder is never held, and a displaced device that keeps
going is held even while its taker is quiet; holding the shared
credentials spares the one a holder named; `release` names its grant's
`handle` (a re-claim gets a new one) so a late release frees nothing;
admin set-password and the hourly sweep free slots, and signed-out
holders are never counted; the re-assert never puts back a credential
switched off while it ran; `label` is a model or the user's words only
(the kind is named from `platform` in the reader's language); the
rollback note is corrected (delete unconfirmed device rows first);
IKEv2 stays on shared credentials (its per-user reload made device rows
a queue risk) and a node more than a re-assert cycle behind is named in
the log. **Contract changes the apps must follow:** send `handle` with
release; render a null `label` from `platform`; stop sending generic
English labels; obligation 11. Backend 86 suites / 1026 tests,
typecheck and lint clean; the new guards each fail a test when removed.
Unit and in-process HTTP tests only -- nothing above has run against a
node, a client or Redis.

**Next:** desktop 0.9.44 and mobile 0.2.23 implement the client side of
`docs/device-slots.md` (claim before dialling with a 3 s budget, never
blocking; the refusal card; renew; release; `concurrentLimit` class;
keep status/code in `apiRequest`). Deploy the backend first. Leave
`CONCURRENCY_CUT=shadow` for at least a week and read the `[shadow]`
lines before enforcing; the rig tests in the design (false-positive soak
per protocol, PC-then-phone, takeover with captures, censored path,
non-claiming clients, long Xray download, IKEv2, restart during a hold,
Android screen-off) gate it.

## 2026-10-06 — device slots, Windows client (branch `claude/device-slots-desktop`)

Built on `claude/per-device-credentials` (`f960994`). Not merged, not
released. Needs that backend deployed first: against today's production
backend every claim is a 404, which the client reads as "no answer, dial
anyway, stop asking" -- so the branch is harmless before the deploy, and
does nothing either.

**Where things are.** All of the platform-neutral logic is in
`apps/desktop-windows/src/lib`, for the mobile client to reuse through
`@shared`: `device-identity.ts` (the two headers; nothing from the web
portal), `device-slots.ts` (claim/renew/release, every answer turned into
an outcome; only 409 `DEVICE_LIMIT` / `SUBSCRIPTION_INACTIVE` and 429
`TAKEOVER_LIMIT` stop a dial), `device-slot-session.ts` (the state
machine, a module-level `deviceSlot`, and `slotStop` -- what to show and
report), `device-slot-notice.ts` (the card's words, en/fa),
`components/DeviceSlotCard.tsx`. `Dashboard.tsx` only wires them.

**Decisions taken here, not in the contract:**
- The claim runs alongside the config refresh rather than after it, so a
  blackholed API costs max(6 s, 3 s), not 9 s. It names the on-screen
  credential; once the ladder lands, an idempotent re-claim moves the
  slot to the one it landed on.
- A held slot is not re-claimed by an automatic reconnect while its
  renewal is current (the request would go into the tunnel just judged
  dead), but is re-claimed by any connect once overdue.
- The slot is also released after a failed or cancelled connect and when
  the tunnel is observed gone on its own -- not only on Disconnect --
  so the other device is never told "in use on Windows PC" about a PC
  that is not connected.
- A claim refused *after* dialling (the pre-dial one went unanswered)
  disconnects and shows the refusal card, like a takeover.
- `deviceLimit: null` skips the claim; an absent `deviceLimit` (older
  backend) does not.

**PROVEN (unit tests and typecheck only):** desktop JS 37 files / 526
tests (32 / 435 at `f960994`), typecheck clean; mobile
JS 4 / 34 and `tsc` clean against the changed shared files; web portal
and macOS shells `tsc` clean; the frontend bundles. The card was
rendered in a throwaway browser harness in both languages (no overflow,
100-140 px) -- outside the app.
**UNVERIFIED:** everything else. No claim, renewal or release has
reached a real backend; the dashboard wiring has not run (it needs the
Tauri runtime and two signed-in devices on a Starter account); the card
has not been seen inside the 400x640 dashboard; nothing on a censored
network. The PC-then-phone, takeover and displaced scenarios are rig
work, as is checking that a displaced device really does not run its
ladder.

## 2026-10-06 — device slots, mobile client (branch `claude/device-slots-mobile`)

Built on `claude/device-slots-desktop` (`f32c47e`), using its shared
`@shared/lib` slot files unchanged. Not merged, not released; like the
desktop branch it needs the slots backend deployed first, and before
that every claim is a 404 the app dials past.

**Where things are.** `apps/mobile/src/lib/device-slot-steps.ts` holds
what a phone adds: the claim asked alongside the config refresh,
renewal in the foreground only (`document.visibilityState`), a check as
the app returns to the front, and a teardown that says "down" only when
`tunnelGone` confirms it. `apps/mobile/src/screens/Dashboard.tsx` wires
it into `runLadder`, the toggle and the health poll. Android and iOS run
the same JS.

**Decisions taken here:**
- No background work for slots. A backgrounded phone keeps its slot
  through its tunnel's traffic; the first foreground poll after it
  returns renews, or learns it was displaced.
- The phone has no automatic ladder, so "do not run the failover ladder
  when displaced" holds by construction; `checkStanding` (obligation 9)
  is not wired, because nothing on mobile reconnects by itself.
- The orb goes busy on the press, before the claim and refresh, so a
  second press stops the pass rather than starting a second claim that
  would make the first one's refusal be ignored. A pass that dials
  nothing reads the tunnel state back from `vpn_status`.
- "Use on this device instead" waits for a teardown the slot started;
  if that teardown did not finish, nothing is dialled over it.
- The label is the generic one from `device-identity.ts` ("Android
  phone", "iPhone", "iPad"); the phone model is not added.

**PROVEN (unit tests and typecheck only):** mobile JS 5 files / 59 tests
(34 before), `tsc` clean, the bundle builds; desktop JS 37 / 526 and
typecheck unchanged. The card was rendered in a throwaway browser
harness at 360x740 in both languages, outside the app.
**UNVERIFIED:** everything else. The dashboard wiring has not run on a
phone or emulator; whether Android's WebView really reports `hidden`
when backgrounded (and so whether renewal truly stops) is not checked;
nothing has reached a real backend; nothing on a censored network. An
IKEv2 profile set as always-on could be redialled by Android after a
displaced phone disconnects, without a claim -- unexamined. PC-then-
phone, takeover, a displaced phone, and a phone in the background with
the screen off are rig work.

## 2026-10-06 — device slots, client review fixes (branch `claude/device-slots-mobile`)

Five review findings against the shared slot session, all confirmed in
the code before fixing. Both clients take them, since the session is
shared.

- **Takeover through the tunnel** (the serious one). Where the API
  answers only through the tunnel, the claim before dialling never
  arrives; the takeover the customer asked for was dropped with it, and
  the claim sent through the tunnel was refused in favour of the very
  device being replaced. "Use on this device instead" could never work
  there, and each press ran a full ladder. The takeover is now kept
  until a claim naming it is answered: the late claim, the poll's retry
  and the check before an automatic reconnect all carry it, and a late
  429 `TAKEOVER_LIMIT` stops the session rather than being ignored.
- **Release racing a renewal.** A renewal still out when Disconnect is
  pressed could be processed after the release and re-grant the slot
  (renew gives a lapsed slot back when there is room), so the other
  device was told "in use on Windows PC" about a PC that was off. The
  session now releases again once that request settles, if its answer
  was a counted grant or it got none -- never once a new connect has
  started, because the server knows the device, not the connect. A
  claim also waits for a release still on the wire (at most 1.5 s, only
  straight after a Disconnect). This also covers stop pressed during the
  claim before dialling.
- **`enforced: false` on a plan with a limit** is a new standing,
  `uncounted`, claimed again every renewal until a grant is counted and
  checked before an automatic reconnect. Only a null limit is treated
  as unlimited now.
- **Fresh means confirmed.** An unanswered renewal used to count as
  fresh. The session now keeps when the server last *confirmed* the
  slot; a held slot unconfirmed for `staleAfterSec` (read from the grant
  now, 90 s by default) is checked before an automatic reconnect.
- **The card outlives the dashboard.** A late refusal landing while the
  dashboard was in Settings tore the tunnel down and lost the card. It
  now lives in a store beside the slot (`slotNoticeStore`), read with
  `useSyncExternalStore`, and is cleared on sign-out.

**PROVEN (unit tests and typecheck only):** desktop JS 37 files / 550
tests (526 before), desktop `tsc` clean; mobile JS 5 / 60 (59 before),
mobile `tsc` clean, its bundle builds. 16 of the 22 new session tests
fail against the previous session code; the other six guard the new
behaviour's limits. **UNVERIFIED:** everything else, as before. The
dashboards' use of the store has not been rendered. Nothing has reached
a real backend, a filtered network or a phone; the takeover through the
tunnel is exactly the case that needs the rig and a censored path.

## 2026-10-06 — an engine that dies: the app kept saying "protected"

Branch `claude/engine-death-honesty`, not merged, not released.

### The measurement

In `Neoxify-Test`, desktop 0.9.43, fi-finland, Stealth (Xray), capture
at the NIC miniport (`pktmon --comp nics`) and the app's text sampled
through WebView2 DevTools on the same clock:

- **Full tunnel:** `xray.exe` killed (`Stop-Process -Force`). Traffic
  went out direct within 0.2s -- 875 packets to the probe address in
  30s -- and the dashboard said "You're protected" for **17.0s**, then
  "You're not protected" with no reconnect.
- **Custom mode** (curl.exe selected): the selected app's traffic
  failed for 4.7s, then went direct (840 packets) once the split-tunnel
  watchdog saw `neoconnect0` gone; "You're protected" until **8.1s**.
- `cleanup.log` said nothing about the engine -- only the split
  tunnel's adapter-gone stop and a DNS-rule clear.

Why: the service held no wait on any engine. A dead engine was found
only by `status()` calling `try_wait`, and `status()` ran when the app's
fifteen-second health poll asked. Until then the session stayed in the
slot -- routes, WFP filters (which permit port 53 only through the dead
adapter), NRPT rule, Custom mode pinned to a vanished adapter -- and
the screen repeated the last poll's verdict.

Fail open stays. The defect was the claim, not the fail-open: nothing
on this branch blocks traffic or reconnects.

### What changed

**Service.** `lifecycle::engine_watch`: a plain thread per session,
waiting on what the kernel signals when the engine ends, and a ledger
of generations. `begin_session` is now the only way into the slot and
always starts a watch; `Slot::end` closes the generation before the
engine is handed back, so no teardown of ours (Disconnect, a connect
clearing the decks, a Custom-mode rebuild) can read as a drop. On a
drop the pipe queues phase one (`end_dead_session`: re-check the engine
really ended, then Custom mode, routes, WFP filters, NRPT by registry --
no PowerShell) and behind it phase two (`finish_dead_session`: the
ordinary thorough `disconnect()`, only if no session has begun since).
Each drop writes one `cleanup.log` line: "the tunnel engine ended on
its own | <protocol>, exit code N, noticed by the engine watch; routes,
filters and DNS rule released Nms after it was seen". A `Status` that
falls back while the owning thread is busy answers from the ledger
first, so it says down without PowerShell.

Per engine:

| Engine | Watched by | Also changed |
|---|---|---|
| Xray: four engine profiles -- `XRAY_VLESS_REALITY` (Stealth), `XRAY_VLESS_TLS` (Stealth HTTPS, and Stealth Web when its transport is WS), `XRAY_TROJAN` (Stealth Lite), `SHADOWSOCKS` | a duplicate of `xray.exe`'s own process handle | -- |
| OpenVPN | a duplicate of `openvpn.exe`'s process handle | phase one purges its pushed half-defaults by destination, as the hard stop does |
| WireGuard | the tunnel service's process (pid from the service manager once Running), the manager re-asked every second | `tunnel_is_running` now means "registered and not Stopped"; it used to mean "can be opened", so a dead tunnel stayed `connected: true` forever (read from code, never measured). Only "no such service" (1060) is not registered; any other failure to open it is unreadable, which counts as running. Handshake reading reused for 5s |
| IKEv2 | `RasConnectionNotificationW(RASCN_Disconnection)` on the held handle, plus `RasGetConnectStatusW` once a second | -- |

`XRAY_VMESS` ("Stealth (legacy)") has a label in the app but no desktop
`ConnectProfile`, so the desktop cannot connect with it and nothing here
covers it. Stated rather than left out of the table.

**App.** A one-second liveness poll while a tunnel is shown: one
status call, no egress, no probe; skipped during a ladder pass, a press,
a Custom-mode change or the Custom-mode probe. `droppedFromPoll` decides:
an answer must have arrived (a failed call is a miss, never a drop), it
must be the service's verified "no tunnel" (`health: down`), nothing of
ours may have disturbed it, no connect/disconnect of ours in flight, and
the screen claiming a tunnel (the middle two since the review). The
headline is then "VPN connection lost / The tunnel closed, so your
traffic is now going out without Neoxify and is not protected. Connect
again to protect it." (and Persian), destructive colour. The
fifteen-second poll keeps its interval and its evidence; since the
review its "no tunnel" goes through the same rule and wording, and one
it cannot trust counts as a miss.

**One behaviour goes away, on purpose.** A WireGuard tunnel whose
service process died used to be rebuilt by the app: status kept saying
`connected: true`, the egress check then read degraded twice, and the
ladder reconnected -- the only protocol that recovered by itself, and
only because the service misreported it. Now it is reported as lost,
like the others, and nothing reconnects. Whether a dropped tunnel
should reconnect automatically is a product decision this branch does
not take; it only stops the false "connected".

**IPC: no new field or variant.** The optional `tunnel_ended` field the
plan mentioned was not added: the freeze rule says every variant and
field keeps its shape and meaning, and whether an additive field is
allowed is the rule owner's call. What the review fixes did instead (see
below) stays inside the meanings the IPC already gives: `health: down`
is "nothing is running" and `unknown` is "no trustworthy evidence", so a
status the service could not verify -- its fallback while the owning
thread is busy -- now says `connected: false` with `unknown`, and only
`down` is a drop to the app.

**Mixed versions** (corrected after review; the first version of this
entry said both directions were "unchanged", which was not true):

- *This app on a 0.9.43 service.* Xray, OpenVPN and IKEv2 deaths are
  caught at the next one-second poll, because the old service checks
  the engine on every status call (`try_wait`, RAS). WireGuard is not:
  the old service's `tunnel_is_running` means "can be opened", so a dead
  tunnel stays `connected: true` there forever, and the app says
  connected. And the old service reads the WireGuard handshake on every
  status (it has no `HANDSHAKE_REUSE_FOR`), so on WireGuard it spawns
  `wg.exe` once a second. The app cannot avoid that: `Status` carries
  no option, and the only request that names the service's version is
  `Diagnostics`, which runs netsh and PowerShell on the owning thread --
  far heavier than what it would save. It lasts while the app and
  service are out of step; the installer replaces both in one step, so
  in practice only after an install whose service step failed. A 0.9.43
  service also says `down` for its fallback's guesses, so there the app
  falls back on its own guard (it knows when it started a Custom-mode
  change or probe), and a guess during any other long operation would
  still read as a drop.
- *A 0.9.43 app on this service.* The service tears the dead session
  down within about a second and traffic goes direct (fail open), but
  the old app polls only every fifteen seconds and says "You're
  protected" until then -- the measured 17s becomes up to 15s, not 1s.

### Proven, by tests on this PC

`cargo test --workspace`: service 454 passed, 6 ignored (was 432); ipc
58; tauri lib 18 passed, 1 ignored. `pnpm test`: 451 (was 435).
`cargo check --workspace --all-targets` clean, no new warnings.

- 32 real processes killed at the same instant are each noticed by
  their own watch, for their own generation: slowest 6ms alone, 10-15ms
  under the full suite.
- 32 sessions ended on purpose report nothing and leave no watch thread
  -- including the half whose watch outlives the kill, where only the
  closed generation stands in the way.
- Each of the five process-engine labels (the four Xray profiles and
  OpenVPN), killed behind the service's back, is reported in under 2s
  and torn down exactly once; a stale report leaves a newer session
  alone; a status poll that finds the death first takes the same steps.
- 32 engines dying while a Disconnect races them, in both orders: each
  session ended exactly once, nothing left in the slot.
- Over a real pipe: a dead engine leaves the slot 65-115ms after the
  kill with nobody asking; a status while the owning thread is busy
  says down.
- WireGuard's watch against a real process with the service manager
  scripted; IKEv2's against a handle RAS never issued (no crash, no
  drop recorded).
- App: the drop rule's table, the headline table ("protected" for one
  state only), and source assertions that the liveness poll goes
  through the rule and the stamp and makes no egress or probe call.

### Unverified -- needs the VM, not done here

Nothing on this branch has carried a packet. The coordinating session
is to repeat the 2026-10-06 method (pktmon at the NIC, DevTools text on
the same clock) for: `xray.exe` killed on each of the four Xray engine
profiles, and on Stealth Web (VLESS_TLS over WS), full tunnel and
Custom mode; `openvpn.exe` killed; the
`WireGuardTunnel$neoconnect` process killed; IKEv2 dropped
(`rasdial Neoxify /disconnect`). Expected: a `cleanup.log` line within
about a second, the headline changed within about two, packets still
direct (fail open), DNS resolving afterwards, no reconnect.

Specifically unproven until then:

- That `RasConnectionNotificationW` fires for a real IKEv2 drop. If it
  does not, the once-a-second status call still catches it.
- That the WireGuard tunnel service runs as its own process whose pid
  the manager reports, and whether the manager restarts it after a crash
  (recovery actions were not checked). If it restarts it before phase
  one asks, the review fixes below take the report back and keep
  watching; if after, phase two removes it as a leftover. Shown against
  a scripted manager; not seen on a real one.
- That MOBIKE moving an IKEv2 connection takes it out of `Connected` at
  all, and if so whether `RasGetConnectStatusW` can say so in the moment
  phase one asks. Handled the same way; covered only by a stand-in
  source, since no test here has a real RAS connection.
- That a WireGuard tunnel service never reads `Stopped` between
  `/installtunnelservice` returning and starting. If it did, the watch
  would end a tunnel that was about to come up. Believed not, from
  wireguard-windows' install path; not observed.
- The INFERRED rows of the map that preceded this work: plain DNS and
  IPv6 blocked in the gap before the old poll, WireGuard staying
  "connected" after its process died, IKEv2's fallback launching
  PowerShell. The fix assumes them; no capture has shown them.

### Review fixes (two reviews of `bc3b2ca`)

1. **A drop the engine contradicts stayed on record** (both reviews).
   The watch recorded before phase one asked; when phase one found the
   engine running it returned, leaving the record -- so the Status and
   Disconnect fallbacks answered "no tunnel" for a live one -- and the
   session unwatched for good, since a watch that reports has finished.
   Triggers: a WireGuard tunnel service restarted by the manager, a
   failed service-manager query, an IKEv2 connection out of `Connected`
   while MOBIKE moves it. Now a source that can come back (the tunnel
   service, RAS) records unconfirmed, and only a confirmed drop answers
   a fallback; phase one finding the engine alive retracts the record
   and starts the watch again (at most one look a second for a source
   that keeps contradicting itself; three re-arms per session logged).
2. **Any `OpenService` failure read as "not registered".** Only 1060
   (`ERROR_SERVICE_DOES_NOT_EXIST`) does now; the rest are unreadable.
3. **The app took any `connected: false` as a verified drop.** The
   service's busy fallback now answers "nothing seen" with `health:
   unknown` (and the untracked arm of `status()` does too when PowerShell
   could not answer for IKEv2); the app says "connection lost" only on
   `down`. Within the frozen IPC: no field or variant added, both values
   keep the meanings the IPC gives them, and shipped apps read every
   `connected: false` alike. The app also marks its own disturbances --
   a Custom-mode change, which rebuilds the tunnel, and the Custom-mode
   probe, which holds the owning thread -- and sets aside any answer one
   began during, which closes the probe race (the probe starts after
   the health check's own status, so it could begin while a liveness
   look was already waiting). The fifteen-second check counts an
   untrusted "no tunnel" as a miss rather than publishing it.
4. **A stale health check could overwrite "connection lost".** The drop
   now advances the publish stamp, and the check stops once overtaken.
5. **Phase two could repeat a thorough pass** a Disconnect or the app
   going away had already run for that session. It skips it now.
6. **A drop taken over by a Disconnect, a connect or the app going away
   before phase one was never logged.** `end_session` logs it now, once.
7. **`wg.exe` once a second on a 0.9.43 service.** Not avoidable from
   the app; stated under *Mixed versions* above.
8. **A stale comment** in `status()`, and the Xray rows above (four
   engine profiles; `XRAY_VMESS` has no desktop profile).
9. **The compatibility claim** -- corrected under *Mixed versions*.

Tests after the fixes: `cargo test --workspace` service 471 passed, 6
ignored (was 454); ipc 58; tauri lib 18 passed, 1 ignored. `pnpm test`
465 (was 451). `pnpm typecheck` clean. `cargo check --workspace
--all-targets`: no new warnings.

What those prove, and what they do not: the re-arm, the retraction and
the unconfirmed record are exercised on real processes and over a real
pipe, with the service manager scripted for WireGuard; IKEv2's trigger
only through a stand-in source. The app-side rules are unit tests and
source assertions. No capture, no real rebuild, no real MOBIKE: all of
it is unverified in the sense this file uses, and belongs in the VM run
above.

### Traps

- The service tests write to `C:\ProgramData\Neoxify\cleanup.log` when
  that directory is writable -- on this PC it is, because the service is
  not installed and earlier tests created it. Every line there is test
  output. Do not read it as a field log on this machine.

## 2026-10-06 — the "Windows can't reach the API" rows were iOS

Branch `claude/control-plane-telemetry`, pushed, **not merged, nothing
deployed or tagged.**

**The finding.** Measured from `client_attempts`: desktop 0.9.29–0.9.42
recorded zero `CONTROL_PLANE_UNREACHABLE`; all 182 "windows" ones carry
mobile versions (0.2.18/0.2.20/0.2.21) -- the iOS builds, labelled
"windows" by the shared `detectPlatform` until 81508ee. So **the
commit messages of 7a5fd50 and a241741 are wrong** where they say
Windows reaches the API far less reliably than Android ("160 against
107", "162 ... against 43", "the mobile build has no seed"). Commits
cannot be edited; this is the correction. The 6s-budget-inside-8s
arithmetic in a241741 was real but bit the mobile app. The source
comments repeating the claim are fixed on the branch, and
`docs/windows-service-rewrite.md` "What this does not fix" is rewritten
with the numbers.

(This paragraph first said the mobile app "has carried the seed since
4174b7c", and c1a9689's message answers "the mobile build has no seed"
with release-android.yml alone. True of Android only: 4174b7c made the
seed required in the Android and Windows release workflows. iOS
0.2.18–0.2.21 were built on the Mac, where nothing required it until
this branch -- see below.)

Also found by reading, and fixed on the branch: resume/online
refreshes were reported as connects; a 429 dropped queued reports; and
the release prebuild could overwrite a fetched seed with the
placeholder on a transient failure.

**Correction: nothing was lost to the 400.** This entry first said, as
the commit messages of a67ea1b, c1a9689 and f6d4b52 still do, that
every unreachable report from desktop 0.9.39–0.9.43 and mobile 0.2.22
was lost -- its `apiEndpoint` hostname list (233 characters, worked out
from the code) over the DTO's 200-character limit, answered 400,
counted as delivered -- so desktop's zero meant nothing past 0.9.38.
That was reasoned from the code and never checked against the server.
Production's nginx log for the 14 days to 2026-10-06 has 1079
`POST /api/client-attempts` answered 204 and **not one 400**, and no
stored row has `apiEndpoint` set: no report carrying the hostname list
arrived at all. Desktop's zero stands for 0.9.39–0.9.42 as it does
before. The raised limit and the client's resend-cut-to-200 are still
right -- the new trace is longer than 200 and production still enforces
200 -- but they prevent a future loss, not a past one. The comments and
docs that repeated the claim are corrected on the branch.

**Deploy order:** backend first. Until it is, new clients still work --
a 400 on a long `apiEndpoint` is resent once cut to 200. No migration.

**Reading old rows** (they age out by about 2026-10-20; nothing was
rewritten): treat `platform = 'windows' AND "appVersion" LIKE '0.2.%'`
as the mobile app on iOS (or a desktop dev run), the same inference
the server now stores as `ios-inferred` / `mobile-inferred`. Split
mobile unreachable rows by reason prefix: from the new builds,
`pre-connect` / `resume` / `online` say what triggered them, and "app
was in the background during it" marks the ones iOS suspension could
explain.

**Unverified:** why iOS fails so much more than Android. The two share
the control-plane code but maybe not what was built into it, and that
is the **leading candidate**: an iOS build whose seed fetch failed on
the Mac shipped the placeholder, and with it the committed HTTP scope
of `*.neoxify.site` alone -- the domain blocked in Iran -- so it could
try only the compiled-in addresses on that domain. Not proven: no build
log is in the repo, and on an unfiltered network the fetch probably
worked. To check, on the Mac: the build output's `seed-bundle:` and
`capability-scope:` lines if any survive; `grep -a` on the executable
of a surviving 0.2.18/0.2.20/0.2.21 `.ipa` or `.xcarchive` for the
`https://` allow globs (only `*.neoxify.site` = no seed applied; the
globs do appear as plain strings in a desktop debug build); the
checkout's `seed-bundle.json` and `git diff` of
`apps/mobile/src-tauri/capabilities/default.json`, which reflect only
the latest build. Details in `docs/windows-service-rewrite.md`. The
other candidates (token-refresh chain inside the 6s budget, iOS
suspending the app, the 0.2.20 extension aborting) are readings, not
measurements. The probe's
classes were checked against live TLS from this PC only (ok, cert,
dns), never from a censored network; the Android/iOS builds of the
new Rust were not compiled here. All of it waits on a real iPhone.

**After review.** The probe had made a failed sign-in or resume
refresh wait up to 20s before its report was even queued -- long
enough, on iOS, for a suspended app to be killed with it. The report
is made at once again, and the probe's answer follows: added to the
queued entry, or sent as a follow-up row (`OTHER`, the original's
time) if the report has already gone. And a resume probe could run
across a connect, resume being exactly when people press Connect: it
is now not begun while the screen shows connecting, verifying or
disconnecting or within a minute of a connect starting, and one
running when a connect starts is abandoned and cancelled on the Rust
side (no new lookup, TCP handshake or ClientHello after that) --
`probe: skipped=connect` / `probe: abandoned=connect@<ms>` say so in
the report. A long trace is now cut from the middle and keeps the
probe. All unit tests (vitest, `cargo test` on this PC). The mobile
Dashboard's two refresh calls have no test of their own: the mobile
app has no DOM test environment, and the shared refresh they call is
tested in the desktop suite.

## 2026-10-06 (morning) — per-device backend deployed; the release candidate in the VM

**Deployed.** `main` at `e50a095` (merge of `claude/per-device-credentials`,
backend only; the agent diff is comments). DB dumped first
(`pre-per-device-20261006-125635.sql.gz`). Migrations
`20261007_per_device_credentials`, `20261008_concurrency_holds`,
`20261008_session_labels` applied at start; defaults left as they are:
`CONCURRENCY_CUT=shadow`, `DEVICE_SLOTS=enforce`, device cap 10. Before
that the three migrations were applied to a copy of production (every
table's schema, every table's data except `usage_records` and
`agent_commands`) in a throwaway container on the panel host: under 4s,
2,013 credential rows intact, FK `ON DELETE SET NULL`. Copy deleted.

**Per-device credentials, end to end (proven).** The VM's 0.9.43 client
fetched after the deploy: its session got 70 credentials of its own
(REALITY, VLESS-TLS TCP+WS, Trojan, WireGuard, OpenVPN, Shadowsocks on
the five live nodes), every one `provisionedAt` from a node's ack.
IKEv2 stays on the shared credential by design. A Stealth session moved
15 MB that `usage_records` puts on the device credential, not the
shared one.

**Release candidate `claude/rc-0.9.44`** (main + device slots + engine
death + control-plane telemetry), built locally and installed over
0.9.43 in the VM; the running service's hash matches the build.

- **Engine death, re-measured** with the same method as the baseline
  (pktmon at the NIC + dashboard text over DevTools, one clock). Traffic
  still fails open, by design; the claim is what changed. "You're
  protected" after the engine died:

  | protocol (engine) | 0.9.43 | RC |
  |---|---|---|
  | Stealth / Xray, full tunnel | 17.0s | 1.05s |
  | Stealth / Xray, Custom mode | 8.1s | 2.0s |
  | Fast / WireGuard | never (until Windows restarted the tunnel ~2 min later) | 1.9s |
  | Compatible / OpenVPN | 3.7s | 0.67s |
  | Built-in / IKEv2 (RAS hang-up) | 9.5s | 0.80s |

  Each then shows "VPN connection lost". In Custom mode the selected app
  now goes direct at 0.3s instead of black-holing for 4.7s first,
  because phase one releases Custom mode at once.
- **Custom mode at the NIC** on the RC: selected app (curl) 0 packets
  direct while connected, unselected control 13. Exit FI vs US.
- **Device slot, one device, live backend (proven):** a connect claims
  (`slots:<subscription>` holds the VM's session, platform windows),
  renews, and a Disconnect releases it (key gone within seconds).
- **A one-device plan, live:** the owner's Pro subscription was moved to
  Starter for the test with an UPDATE of `planId` only (both plans: same
  routes, no data cap) and moved back afterwards (confirmed Pro). The VM
  connected and stayed "You're protected", never refused. The shadow
  backstop saw "2 devices active against a limit of 1" -- the VM on its
  device credential holding the slot, and another of the owner's devices
  idling on the shared WireGuard credential (keepalives only, ~10 KB in
  6 min) -- and logged "would hold the shared credentials", i.e. the
  device without a slot, never the slot holder. Nothing was sent.

**Not done here, and why.** The two-device refusal ("in use on ...",
"Use on this device instead") needs a second signed-in device of one
account; Claude does not create accounts or sign in with passwords, so
it waits for the owner. IKEv2 sign-out revocation is still per-account
until the agent change. Nothing of this has run on a censored network
or a phone.

## 2026-10-06 — device slots, clients aligned with the revised contract (branch `claude/device-slots-mobile`)

The backend's second review changed `docs/device-slots.md`; this branch
now carries that revision (`claude/per-device-credentials` merged in,
no conflicts) and both clients follow it. All of it is in the shared
code in `apps/desktop-windows/src/lib`, so Windows and the phones take
it together.

- **Release names its grant.** Every claim answers with a new `handle`,
  even one made while holding the slot, and the server frees a slot on
  release only under the handle it is held by now. The session keeps
  the latest counted grant's handle (claim, or a renewal that gave a
  lapsed slot back), per subscription, until sign-out, and every
  release sends it. A release that would name no grant is never sent:
  without a handle the server frees whatever the device holds, a newer
  connect's slot included. The cost: a claim sent and never answered,
  that did arrive, is left to go stale (90 s after its traffic stops).
- **A device with no label is named from its platform**, in the app's
  language: "a Windows PC", "a Mac", "a Linux PC", "an Android phone",
  "an iPhone" (Persian: "یک رایانهٔ ویندوزی", "یک مک", "یک رایانهٔ
  لینوکسی", "یک گوشی اندروید", "یک آیفون"); "another device" only with
  neither. A label is shown as sent; one that is only a kind, from an
  older server, is read the backend's way.
- **Headers: the platform always, a model or nothing.** No more "Windows
  PC" / "Android phone" / "iPhone" labels. A PC, a Mac and an iPhone
  send the platform alone; an iPad sends "iPad"; an Android phone sends
  the model from its WebView user agent ("Pixel 7"), and nothing if the
  agent is reduced to `K` or cannot be read with confidence.
- **Obligation 11.** Both dashboards already tore down without the
  ladder on a claim refused after connecting. Now that refusal (and a
  late `TAKEOVER_LIMIT`) reports no second CONNECT attempt -- the dial
  worked and was reported as a success when it happened, and that
  report and the remembered route stand, being true of the network --
  and the refusal card waits until the tunnel is confirmed down instead
  of showing over a tunnel still coming down.
- **Three answers stop a dial**, written as that list. A renewal 409
  carrying `SUBSCRIPTION_INACTIVE` used to tear the tunnel down; every
  renewal answer but a 200 (and a sign-out) now keeps it. After a 404 or
  a codeless 409 before dialling, the claim through the tunnel is now
  made once, as obligation 2 asks.

**PROVEN (unit tests, typecheck, bundle):** desktop JS 37 files / 576
tests (550 before), `tsc` clean; mobile JS 5 / 65 (60 before), `tsc`
clean; both bundles build; web portal and macOS `tsc` clean. 42 tests
(36 desktop, 6 mobile) fail against the code before these commits.
**UNVERIFIED:** everything that is not a unit test. The Android model
parse is tested against sample user agents, not a phone's WebView;
whether this WebView still carries the model is unchecked. The card's
new wording has not been rendered. Nothing has reached the real
backend, a filtered network or a phone; obligation 11 is exactly the
censored-path case that needs the rig.

## 2026-10-06 — released desktop 0.9.44 and mobile 0.2.23

From `main` `3bafbe0` (merge of `claude/rc-0.9.44`): per-device
credentials and device slots (backend + both clients), engine-death
honesty (Windows service + app), control-plane telemetry. The backend
was deployed from the same commit first (dump
`pre-0944-20261006-143327.sql.gz`; no new migrations beyond the
morning's). Before tagging: desktop 727 / mobile 72 / backend 1,041
tests, service 471 + ipc 58 + Tauri 29 Rust tests, all on this PC; CI
green on the candidate (Go agent, shellcheck, desktop tests,
TypeScript); the VM regression on the candidate: DNS on all 8 protocols
with 0 queries leaving the NIC, the NIC leak capture on all 8 with no
IPv6 and IPv4 only to the node apart from the known pre-tunnel
keepalives (to germany-1's API mirror), Custom mode at the NIC, engine
death re-measured on every engine, and the slot claimed on connect and
released on disconnect. The installed 0.9.44 smoke test: engine death
reported in 0.91s, slot claim and release.

`release-android.yml` published straight to `neoxify-releases` for the
first time (the change from 2026-10-06); `/updates/installer/android`
serves 0.2.23 without a hand copy. The desktop update feed offers 0.9.44
to 0.9.43.

**Unverified:** the two-device refusal and takeover (needs a second
signed-in device of one account); anything on a phone (Android 0.2.23
and the iOS build); a censored network. The VM froze twice under guest
control (2026-10-05 and 2026-10-06, both as a WireGuard or IKEv2 test
began) and needed a hard reset; cause unknown, no product effect seen.

## 2026-10-06 — backend review fixes (branch `claude/review-fixes-backend`)

**Status:** done on the branch and pushed; not merged, not deployed.
**Touches:** `apps/backend` (billing, customer-auth, customers,
protocol-users, subscriptions, auth, agent-gateway, routes, health,
client-attempts, the global throttle guard), migrations
`20261009_admin_mfa_last_step` and `20261010_route_entry_health`, one
comment in `installer/lib/agent.sh`.

The 31 confirmed backend findings of the full review, which come down
to 20 distinct problems, plus M33 (WebSocket session counts). One commit
per problem; the commit messages say why. The ones touching money and
live access: `provisionAll` minting working credentials for
PENDING/CANCELLED/EXPIRED/SUSPENDED subscriptions (da575bb); a declined
Stripe attempt writing off the PaymentIntent so the later success was
dropped (771a0d4); StoreKit JWS accepted on any chain to Apple Root
CA - G3 (90332ed); the unauthenticated verify-email-code branch granting
a trial and returning decrypted credentials (a974423).

### What a deploy does -- read before deploying

Backend only. No client or agent release depends on it, and no client
needs it first. Both migrations are two nullable columns between them,
and `migration-safety.spec.ts` checks both; their SQL matches what
`prisma migrate diff` generates from main's schema.

- **First boot switches off unpaid access.** The backfill removes the
  ACTIVE credentials of PENDING and CANCELLED subscriptions and disables
  those of EXPIRED and SUSPENDED ones, and logs the counts at warn. Anyone
  using one loses that tunnel at deploy, which is the fix. Count first,
  read-only:
  `SELECT s.status, count(*) FROM protocol_users pu JOIN subscriptions s ON s.id = pu."subscriptionId" WHERE pu.status = 'ACTIVE' AND s.status <> 'ACTIVE' GROUP BY s.status;`
- **Customers disabled before this deploy keep their node credentials**
  until each is saved as DISABLED again in the panel (85f082b). Their
  refresh is refused from the deploy, so their apps lose the API within
  15 minutes, but a connected tunnel keeps working. Which ones:
  `SELECT c.id FROM customers c WHERE c.status = 'DISABLED' AND EXISTS (SELECT 1 FROM protocol_users pu JOIN subscriptions s ON s.id = pu."subscriptionId" WHERE s."customerId" = c.id AND pu.status = 'ACTIVE');`
- **Relay routes read OFFLINE** in the route list until their entry node
  acks a CONFIGURE_ROUTE. How long that takes is not measured, and "at
  most a minute" (said here before) is not proven: on reconnect the
  route goes out only after the outbox replay and the full user
  re-assert, and the agent works through commands one at a time, so a
  relay with many users -- IKEv2 ones reload every secret per user --
  can take longer. The status is display and a tiebreak in the apps
  (desktop 0.9.44 also labels a custom exit on that route as down); it
  blocks no connection.
- **Rolling back re-enables everyone disabled after the deploy.**
  Disabling leaves credential rows ACTIVE on purpose (switchOffCustomer);
  main's re-assert has no customer filter, so within a minute of a
  rollback it puts every such customer's credentials back on the nodes.
  No worse than main today, but after a rollback re-disable them by hand.
- **Stripe must send two events it may not be subscribed to.** A Stripe
  payment is now marked FAILED only on `checkout.session.expired` or
  `payment_intent.canceled` (771a0d4); `payment_intent.payment_failed`
  leaves it PENDING because Checkout retries on the same PaymentIntent.
  Check the endpoint in the Stripe dashboard lists both. If not, no
  Stripe row is marked FAILED again -- harmless (they stay PENDING), but
  the payments list stops showing failures.
- **iOS purchases:** before `APPLE_BUNDLE_ID` is given to the production
  container, redeem one sandbox purchase from a real iPhone. The new chain
  check was only run against Apple-shaped chains under a throwaway root.

### Proven, on this PC

Backend 99 suites / 1,182 tests, typecheck and lint clean. Each fix
has a test that fails on the code before it; the commit message says how
many. `bash -n installer/lib/agent.sh`; shellcheck is not installed here.
After the review fixes below: 99 suites / 1,188 tests, typecheck and
lint clean; each of the three new fixes' tests was run against the code
before it and failed.

### Unverified

- Nothing ran against production, a node, Stripe, Apple, Plisio or
  NowPayments. The Stripe retry-on-one-PaymentIntent fix is unit-tested
  on the webhook handler, not replayed from Stripe's test mode; the
  Plisio reconcile follows the documented API and was never called.
- That `req.ip` is the node's address for mirror and tunnel traffic is
  from reading the code and the panel nginx template, plus the
  reviewer's local proxy-addr run. The production panel nginx is
  hand-maintained and was not read.
- `/health/ip` now signs a network only for the address nginx saw, or
  Cloudflare's header when that address is a Cloudflare edge. A
  customer whose baseline goes through a node mirror pointed at the
  origin (`NEOXIFY_PANEL_ORIGIN`) gets no token now. Whether any
  production mirror is set up that way is not known.
- The relay entry health assumes every agent acks CONFIGURE_ROUTE
  success. Read from the code: every command is acked, and re-asserts
  have been idempotent since b267f5f (in v0.2.9). The nodes' versions
  were not checked.
- No query here has met a real Postgres. The unit tests mock Prisma, and
  CI's Postgres only applies the migrations. So the new `where` filters
  (the live-credential and plan filters among them) are checked as
  objects, not as rows they select, and admin delete's handling of the
  foreign keys is checked against the schema, not against a database.

### Not fixed, and why

- **Sign-in, sign-up, password reset, the sign-in challenge and
  LoginGuard's per-source counters still count per address.** Customers
  behind one node mirror still share those buckets, and anyone can empty
  them. Signed-in requests and refresh no longer share (00b27cc), nor do
  signed-in attempt reports and App Store redemptions (ab0a942); an
  anonymous attempt report still counts per address. The real
  client is in X-Forwarded-For, but tunnel traffic arrives from the same
  node address with a header the customer wrote. Trusting it would give
  every connected customer a fresh sign-in budget per forged header. The
  fix is for the mirror to authenticate its hop (a per-node secret header
  or a client certificate). That is an installer change and a rollout to
  every node: an owner decision.
- grpc-js `call.destroy()` sends the agent no status on any close path
  (noted in c289e79); its own change.
- Re-signing up with the same Apple ID after deleting an account needs
  Apple's token revocation (noted in d240bbe).
- The relay Xray template's default outbound is still `direct`, so a new
  relay would not fail closed the way ir1 does by hand. That is a node
  config question, not a backend one.
- **A password sign-in grants a trial to any verified account with no
  subscription.** Eligibility is "has no subscription at all", so if an
  operator deletes a customer's trial subscription, the next sign-in
  grants a new one. Main already did this through the unauthenticated
  verify-code branch (a974423 closed that route, and sign-in is where the
  retry lives now), so it is not a regression. Making a trial once per
  account needs a persisted marker -- a product call, not made here.

### After the adversarial review

The review of `ec83104` found one blocking defect and eight lows.

- **Fixed, blocking (8045019): one plan's speed cap went to every
  plan.** `reapplyRateLimits` spread `liveCredentialWhere()` after
  `subscription: { planId }`; da575bb gave that helper a `subscription`
  key of its own, which replaced the plan filter. An admin editing
  Starter's cap would have shaped every live WireGuard and OpenVPN
  customer on every plan to Starter's speed, with nothing to undo it.
  Never deployed. The spec had built its expected value with the same
  spread, so it asserted the bug.
- **Fixed (1aec444): re-enabling a credential put a disabled customer
  back on the nodes.** A renewal or a reactivation called
  `setEnabled(true)`, which sent ENABLE_USER whatever the account's
  status. It now asks liveCredentialWhere (minus the row's own status)
  first and leaves the row off its node until it is live.
- **Fixed (ab0a942):** attempt reports and App Store redemptions count
  per signed-in session (above).
- **Documented:** rollback re-enables disabled customers; the relay
  OFFLINE window is not bounded; the Stripe event subscription (all in
  the deploy notes above). The trial-on-sign-in note (above).
- **Not real:** "switch-route can return a PENDING or CANCELLED
  subscription's leftover credential". Its only caller,
  `POST /customer/subscriptions/:id/route`, refuses any subscription
  that is not ACTIVE before calling it.

## 2026-10-06 — agent and installer review fixes (branch `claude/review-fixes-agent`)

Built on `claude/node-private-egress` (181fe0d: customers reaching a
node's loopback -- the Xray API, OpenVPN management -- through their own
tunnel; not redone here). Not merged, not deployed, no agent released.
Each commit message carries its finding; this is the state around them.

**Must land before the next agent rollout -- and is in this branch:**
the usage baseline (6bd4300). Every agent restart billed every WireGuard
peer's lifetime counter, and every connected OpenVPN/IKEv2 session's
total, a second time; 27 subscriptions have data caps. Rolling out
*any* agent build without it re-bills on every node at once.

**Deploy order.**
- Backend (8919b62, 37ea43c) can go before or after the agent release.
  37ea43c sends plan speed caps on every re-assert only to nodes
  reporting agentVersion >= `REASSERT_CAPS_FROM_AGENT` = "0.2.10"
  (agent-gateway.service.ts). **If the agent release carrying 381de16
  is not v0.2.10, change that constant first** -- an older agent
  rebuilds a capped WireGuard user's tc rules every 60 s.
- Agent release (next `v*` tag) after merge: everything under
  `agent/`. Caps come back on a node only once it runs it.
- Installer changes take effect on the next installer run; nothing on
  live nodes changes by itself.
- Node-side, each needing the owner's go-ahead, none done:
  `installer/maintenance/isolate-tunnel-clients.sh` (dry run by default)
  on each WireGuard/OpenVPN/IKEv2 node; `block-private-egress.sh` from
  the parent branch; and, only after the new agent is on every OpenVPN
  node and a re-assert has run, `ccd-exclusive` in server.conf
  (installer + restore script) -- before that it cuts off every OpenVPN
  customer.
- Panel host: production is deployed with git pull + compose, so the
  certbot deploy hook (now restarting the backend, 814ed0b) has to be
  regenerated there by hand once; and `APPLE_BUNDLE_ID` set in
  `infra/.env` when App Store purchases go live (cf50278 passes it).

**Proven.** Go agent: CI on 37ea43c green (vet, build, `go test ./...`,
every package ok) -- there is no Go toolchain on this PC, so CI is the
only place it ran; the branch head was pushed for the same. 81 Go test
functions (55 before; 4 replaced, 30 added). The IKEv2 parser now reads
`swanctl --list-sas --raw` output captured from a live node today
(redacted, `agent/internal/protocols/ikev2/testdata/`), which the old
parser returned nothing for. Backend: 1,043 tests, typecheck, lint, on
this PC. Installer: `bash -n`; shellcheck in CI. The isolation script's
remote half was run against a fake root with a stub iptables.

**Unverified -- needs a node, labelled so in the commits:**
- A usage row appearing after a real IKEv2 dial on the new agent; the
  IKE-rekey case (per-CHILD_SA keying is reasoned from how strongSwan
  rekeys).
- DISABLE_USER ending a live IKEv2 session (`swanctl --terminate
  --ike-id N --force`); the old `--eap-id` failing is from strongSwan's
  source, not a run.
- That no rollout double-bills: watch dataUsedBytes across the first
  agent restart on a node with active WireGuard peers.
- Caps returning after a wg-quick restart and after an agent restart
  with OpenVPN clients connected.
- Every installer path: the Xray carry-over and `xray run -test`
  rollback, the role lookup from menu 5, the WireGuard/OpenVPN re-run
  guards, the cert hook restart, the FORWARD isolation (nothing should
  change for customers; a client pinging another client's 10.66.x
  address should now get nothing).

**Not fixed, and why.**
- Mirror rate-limit buckets (one client exhausting sign-in for everyone
  behind a node mirror): needs the hop authenticated -- a secret the
  mirror sends and the backend checks -- which is backend design work
  (in the backend review's list) plus a node nginx change after it.
  Only the false nginx comment was corrected (e8ed802).
- `ccd-exclusive` itself: owner decision and ordering, above. Hard-
  deleted OpenVPN rows on a rebuilt node stay accepted until it is on.
- Requiring `subnetCidr` for OPENVPN in the backend: a stale installer
  checkout on a node would then fail its tls-crypt PATCH, which is
  worse than what it guards.
- `agentd --enroll-init` refusing to overwrite without `--force`: the
  installer (from main) and the binary (from the latest release) skew,
  and an older binary rejects an unknown flag.
- IKEv2 `dpd_delay`/`reauth_time` as a server-side backstop for ending
  revoked sessions: a live config change, owner decision.

## 2026-10-06 — agent review fixes, second round (branch `claude/review-fixes-agent`)

A second, adversarial review of the branch above found three medium
defects -- one new behaviour the branch caused, two claimed fixes that
did not work -- and twelve lows. Not merged, not deployed, no agent
released, no node or production server contacted.

**Blocking, all three fixed.**
- *Dead IKEv2 sessions counted as devices in use* (8b859b2, on d9c939a).
  The fixed parser made IKEv2 session counts real, counting every SA
  strongSwan lists, and nothing on the server ends one (no DPD,
  rekey_time = 0s). The captured sample's two SAs had had nothing from
  their clients for about 21 hours. Each would have kept a device slot
  and fed the backstop. The agent now counts only ESTABLISHED SAs with
  inbound traffic in the last three minutes (half-open SAs, whose
  identity is only claimed, drop out too), and the backend puts IKEV2 in
  COUNTS_IGNORED and goes by bytes -- both, because production runs main
  and either could ship first.
- *`xray run -test` could never pass on a running relay* (596813c, on
  the no-change refactor 544bcbf). -test creates the tun inbound's device,
  which the live Xray holds ("device or resource busy", measured on ir1
  2026-08-16), so every install_xray re-run on a live relay put the old
  config back and blamed the config. A running relay's config is now
  tested without its tun inbound. block-private-egress.sh (parent branch)
  had the same test under pipefail and could never apply on ir1; fixed
  the same way.
- *Nothing retried a failed IKEv2 terminate* (24f559c). A failed command
  is marked FAILED and never resent; the re-assert sends only credentials
  that should be on. The provisioner now ends any SA still listed under
  an identity it removed or disabled, on every stats poll, until none is.
  Forgotten across an agent restart.

**Lows.**
- Fixed: a changed OpenVPN cap forgot where the user was shaped, so a
  client that left before the next pass left its old cap on that pool
  address for the next customer (84e2815; two older shaping tests that
  could not fail were tightened, 10ab7ae). Reconnect backoff capped at
  15 s, under the backend's 30 s first stale sweep, so a deploy cannot
  mark nodes OFFLINE (472b054). A WireGuard re-run now defaults to, and
  insists on, the panel's subnetCidr -- on a rebuilt node Enter used to
  pick 10.66.0.0/24 whatever the panel said (ef22da0).
- Owner decision: **billing IKEv2 usage at all.** docs/ikev2-node.md
  used to call leaving it uncounted deliberate; the parser fix turns it
  on. Written into that doc. Approve or hold before the agent release.
- Deploy note, added below.
- Not a defect: the moved prompts "breaking answer-file installs" --
  answer files are already recorded as unsupported (windows.md, "do not
  feed it a here-doc"), and a full install takes the relay role from the
  role question.
- Deferred: the backend gating caps on agentVersion "0.2.10" rather than
  a capability the agent declares in Hello (a proto change, and no Go
  toolchain here to regenerate it; the deploy note above covers it);
  every agent restart rebuilding each relay rule once (a brief leak
  window only on a relay still defaulting to `direct`; the author's
  known trade-off).
- Unanswered: who captured the IKEv2 fixture "from a live node" -- the
  repo does not say. Its redaction looks complete (addresses, ids, SPIs
  replaced; only NAT source ports and counters left).

**Deploy order, added to the above.** Rolling the agent *back* to any
build without 6bd4300 -- the installer's rollback to a v0.2.9 backup in
/root/agent-rollback included -- re-bills every connected customer's
totals once, as a forward rollout without it would. The backend change
(IKEV2 ignored in the backstop) is safe before or after the agent.

**Proven.** Every new Go and installer test was run against the code
before its fix: CI run 37562880092 on a throwaway branch
(`claude/review-fixes-agent-red`: the old code plus only the two
no-change prep commits and the new tests) failed exactly the seven new
Go tests written to fail plus the changed backoff expectation, in
ikev2, dispatch and controlplane, every other package ok; the installer
gate test failed 3 of its 12 checks on "device or resource busy" with
the runner's real jq. (That run's TypeScript job failed in
apps/mobile's capability-scope test, which this branch does not touch:
desktop-windows' build fetches the real seed bundle while mobile's
pretest has already generated its capability file from the placeholder,
a race inside turbo; the backend branch's run passed it 15 minutes
earlier.) The backend test fails on the old code locally. Backend:
1,045 tests, typecheck, lint, on this PC. Go: 90 test functions (81
before; 9 added, 4 changed) -- still no Go toolchain here, so CI is the
only place they run.

**Unverified -- needs a node.** That `use-in` moves only with ESP
traffic; an IKEv2 terminate on a live session, and the retry; install_xray
on a live relay end to end; block-private-egress.sh's remote half
(syntax-checked only); the WireGuard subnet guard; a backend restart with
nodes reconnecting inside the first sweep.

## 2026-10-06 — desktop review fixes (branch `claude/review-fixes-desktop`, off `main` `1cd85c6`)

**Status:** pushed, not merged, not released. Fourteen confirmed
findings from the full review of the desktop area; thirteen fixed, one
partly. Commit messages carry the detail; this records what is proven
and what is not.

### Fixed

- **Control-plane outage tore down working tunnels** (high). The egress
  check now tells an HTTP answer of any status from our own endpoints
  (`00e9ffe`) and, when nothing of ours answers at all, a TCP handshake
  with 1.1.1.1 / 8.8.8.8:443 through the tunnel (`4189cc4`, new
  `probe_ipv4_egress`) apart from a dead tunnel: both are now
  `indeterminate`, so the poll falls back to the handshake, counts no
  strike and runs no ladder. With no baseline, every rung is judged on
  its handshake rather than rejected, and the wait for proof that cannot
  come ends at once (`4f2123a`). **The TCP probe was wrong for every
  Xray protocol** -- xray's tun answers the handshake itself -- and is
  now a verified TLS handshake; see the follow-up entry below.
- **"You're protected" on a dual-stack machine while IPv4 bypassed**
  (medium). `/health/ip` is asked over IPv4 only on Windows (new
  `health_ip_v4` command, reqwest bound to `0.0.0.0`, installed from
  `main.tsx`), and two readings of different families are never
  compared (`9ad2458`). The mobile app keeps the plugin's fetch and gets
  only the family guard.
- Remount over a live tunnel showed "not protected" (high) and a pass
  outliving the screen (medium): `44dfcd5` (`lib/ladder-pass`, sync
  before loading ends). Unbounded egress walks (medium): `e226923`.
  Snapshot written after sign-out (low, both clients): `90393c7`.
  IPv6 alarm in Custom mode (medium): `25d148c`. Mirror 502 winning the
  race (medium, shared with mobile): `b2167a7`. Verify-email deep link
  (low): `33135db`. Repair survey order (low): `8fafe35`, which also
  raises `REPAIR_WORST_CASE` 735s → 885s and the app's deadline to 900s
  (ten idle-arm spawns were never itemised), and fixes the JS repair
  wrapper, left at 205s when the Rust deadline went to 750s. Stop vs
  app watch (low): `07754b1`. Disconnect vs a queued Connect (low):
  `e14de8b`. Pipe: ArmGaming refused, running-app list limited to the
  caller's session (low): `a738dc8`.

### Partly fixed

- **Capability scope fixed at build time** (medium), `d82b640`: a domain
  the seed uses for two or more hosts now gets a wildcard, so a node
  added later on an existing mirror domain is in scope for builds from
  now on; `bundle.mjs sign --previous <last signed bundle>` warns about
  hosts installed clients will refuse. **Not done:** extending the scope
  at runtime from a signature-verified bundle in Rust. A new domain or a
  bare IP still needs a client release, and every build up to desktop
  0.9.44 / mobile 0.2.23 still scopes exact hosts only.

### Proven, on this PC

Desktop `pnpm test` 770 passed in 50 files (725 in 44 before), `pnpm
typecheck` clean; mobile vitest 72 passed, `tsc --noEmit` clean;
`cargo test --workspace` Tauri 35 passed (2 ignored), ipc 58, service
477 (6 ignored); `cargo check --workspace --all-targets` with no new
warnings. Every fix has a test shown to fail on the old code, except
the pure-source orderings, which assert the wiring. Two are
measurements rather than models: `health_ip.rs` shows on this machine's
loopback that the pinned request makes no IPv6 connection where an
unpinned client answers over `[::1]`; and the queued-Connect test
drives the real pipe and fails without the fix (the connect ran and
reported the missing wireguard.exe). `apply-capability-scope.mjs` and
`bundle.mjs sign --previous` were run end to end on a synthetic,
documentation-names-only seed.

### Unverified

- Everything about real traffic: no VM run of this branch. The outage
  case (backend down under a live tunnel), the remount/adopt flow, the
  repair CLI on a machine with residue, and a service stop with the app
  open all need the rig.
- Dual-stack behaviour against the real CDN: this PC has no IPv6. Also
  whether the CDN treats `health_ip_v4`'s requests as it treats the
  plugin's (same User-Agent string on purpose; not observed).
- Whether 1.1.1.1 / 8.8.8.8:443 answer through every protocol from a
  censored network.

### Deploy order

None of it needs the backend, an agent release or a node change. The
app and the service ship in one installer and must: `REPAIR_WORST_CASE`
is compiled into both. The operator should start passing `--previous`
when signing the next endpoint bundle.

## 2026-10-06 — review of the desktop fixes: the IPv4 probe and the lows (same branch)

**Status:** pushed to `claude/review-fixes-desktop`, not merged, not
released. An adversarial review of the entry above found one blocking
defect and eleven lows. The blocking one is fixed and measured; seven
lows are fixed, two are recorded as deferred, two needed no code.

### The blocking finding, measured

`probe_ipv4_egress` asked for a TCP handshake with 1.1.1.1 / 8.8.8.8 on
443. Under VLESS-REALITY, VLESS-TLS, Trojan and Shadowsocks that is
answered by xray.exe itself: its `tun` inbound is a gVisor stack that
completes the three-way handshake before handing the connection to the
outbound (`proxy/tun/stack_gvisor.go` in the bundled v26.1.23). So the
probe said yes whenever xray.exe ran, and a node blocked mid-session --
the common failure in Iran -- read as "our API is down": no strike, no
failover, "Connected, not confirmed" over a dead tunnel; with no
baseline the ladder stopped on a dead Xray rung.

Measured on `Neoxify-Test` with the bundled xray.exe, a `tun` inbound on
its own adapter and host routes for both resolvers into it (the app was
not involved; the probe ran as the Tauri crate's test binary):

| xray outbound | TCP handshake (old probe) | verified TLS (new probe) |
|---|---|---|
| none (no tunnel) | yes | yes |
| VLESS to a working relay (xray on the host, loopback) | yes | yes, 20ms |
| VLESS to 192.0.2.1 (never answers) | **yes** | no, at the 5s limit |

The relay's own log showed both probes' connections arriving and dialled
out. A first attempt with a `freedom` outbound looped back into the tun
(its dial to 1.1.1.1 followed the host route) and is not evidence of
anything. The probe is now a TLS handshake whose certificate verifies
for `one.one.one.one` / `dns.google`, using the control-plane probe's
handshake and roots (`16c8050`). It also decides whenever no endpoint
gave an address, not only when none answered: the connected node's own
mirror is on the node's address, routed around the tunnel, so its 502
said nothing about the tunnel. Where the command does not exist (mobile)
an error page from ours still counts as traffic flowing.

### The lows

- Writes stop at an HTML 502 or 520 as at 504/524 (`5b43d08`): nginx's
  502 also means the upstream closed mid-request, and 520 an unreadable
  origin answer, so a resent purchase or redemption could run twice.
- App watch: a thread the OS would not start is `Unwatchable` and tears
  down, instead of sharing `WatchAbandoned` with the service stop
  (`057e4e9`).
- The egress baseline lives in the ladder-pass store, so a screen
  remounted mid-connect compares against the pass's baseline; the guard
  is renewed at every rung, so a long ladder no longer outlives
  `LADDER_MAX_MS` (`66362a2`).
- A new state's first health check runs once the one in flight ends,
  instead of waiting up to fifteen seconds (`ffdfe9f`).
- `health_ip_v4` refuses every loopback host in a release build; its
  HTTPS path was run against two public HTTPS hosts that are not ours
  (404 in 49ms and 323ms) (`f0bc90c`).
- A flaky test from `e226923` (1 failure in 5 runs) was a real edge: a
  timer firing a millisecond early let the walk ask the next endpoint
  with a 1ms budget (`2c6d322`).
- Mobile, through the shared code: an error page from every endpoint is
  "no verdict", which mobile shows as "Connected" (it was "degraded"),
  and on a dual-stack phone an IPv6 baseline against an IPv4 reading is
  no longer proof, so `saveLastGood` does not save on it. Both are the
  intended rules; neither has a mobile-side test.
- Deferred: the baseline walk capped at two endpoint timeouts (a bare
  network that black-holes the first two endpoints in order gets no
  baseline, so bypass is undetectable for that session; unverified how
  often), and `bundle.mjs --previous` standing in for what shipped
  clients allow (a host first added in that bundle is not warned about;
  knowing each build's seed needs the release to record it, or #11's
  runtime scope).

### Unverified

Everything in the entry above still is, and: the new probe through
WireGuard, OpenVPN and IKEv2 (kernel tunnels, so a TCP handshake did
cross them, but the TLS one has not been run through them); the 5s limit
on a slow censored path; whether a node's network reaches 1.1.1.1 and
8.8.8.8 on 443 (both are also the tunnel's DNS, so a node that cannot is
already broken for customers).

## 2026-10-07 — node fixes from the full review, applied to the fleet

All on the five live nodes (finland1, france-1, germany-1, singapore-1,
turkey-1), one node at a time, finland1 first with the VM checking real
traffic through it after every change. The owner approved restarts.

- **Customers could reach a node's own loopback through their tunnel**
  (the review's critical: the Xray API on 127.0.0.1:10085 and OpenVPN
  management on 127.0.0.1:7505). `installer/maintenance/block-private-egress.sh`
  applied: private and loopback destinations go to a blackhole, routing
  `IPIfNonMatch`. Xray restarted on each node; the 60 s re-assert put all
  343 credentials per node back. Through finland1 afterwards: all five
  Xray protocols connect, exit FI, 0 DNS at the NIC.
- **Tunnel clients could reach each other and private ranges.**
  `isolate-tunnel-clients.sh` applied (FORWARD DROP from each tunnel
  subnet to private ranges, saved, wg0 hooks). No restarts. france-1's
  IKEv2 pool is a range, which aborted the first run; fixed (c484d0d)
  and re-run. Fast, Compatible and Built-in through finland1 afterwards:
  exit FI, 0 DNS at the NIC.
- **Agent v0.2.10** rolled out to all five; every engine's MainPID
  unchanged. On finland1 first: WireGuard usage after the restart was
  0.01 MB in total (no re-billing), and a 10 MB download over Built-in
  produced IKEv2 usage rows of 10.01 MB down / 0.20 MB up -- the first
  IKEv2 usage ever recorded (the parser never matched before, and had
  the directions swapped). IKEv2 is therefore now billed against caps.
- **OpenVPN revocation enforced.** Every live OpenVPN credential (40 per
  node) had its ccd file and every other file (23-34 per node) carries
  `disable`; then `ccd-exclusive` added and OpenVPN restarted. Compatible
  through finland1 afterwards: exit FI.
- **finland1's API mirror answered HTTP/1.1 clients with 404**: its
  vless-tls-in default fallback pointed at the WebSocket inbound
  (127.0.0.1:10086) instead of nginx (127.0.0.1:8080). Corrected; all
  five mirrors now answer `/api/health/ip` 200 on :2053 with a verified
  certificate (germany-1's old 502 was already gone). Stealth Web and
  Stealth HTTPS through finland1 afterwards: exit FI.
- **Panel host**: the certbot deploy hook now restarts the backend, so
  the agent gateway picks up a renewed certificate (current one expires
  2026-12-01).
- **singapore-1's agent key rotated** (it had been shown in a terminal):
  a new Ed25519 pair generated on the node, only the public half written
  to `nodes.agentPubKey`; the agent authenticated with it. The old key no
  longer authenticates.

Backend `main` `7533211` deployed first (dump
`pre-review-fixes-20261007-031145.sql.gz`): it removed the credentials
of 5 CANCELLED subscriptions (200 rows; 2 customers were still using
their old Pro subscription's credentials and have an ACTIVE one).

**Still open:** turkey-1's exposed root password (needs the owner: they
may log in with it); the HTTP/1.1 vs h2 question for the other nodes'
mirrors was checked only from one uncensored client.

## 2026-10-06 — mobile review fixes (branch `claude/review-fixes-mobile`)

The confirmed mobile findings of the full review, fixed on a branch off
`main` `1cd85c6` and rebased onto `7533211` (the merged backend, agent
and desktop review fixes). 15 findings, 11 after removing duplicates (the two
IPv6 ones, the two Custom-mode ones, the two IAP ones, and the
stale-state critical with its high twin). Not merged, not deployed, not
released.

**Done, one commit each:**

- **Critical/high, Android stale `xray-state`** (`a1e876b`). `readStatus`
  now believes "up" only while the `:xray` process is in
  `runningAppProcesses` and the system has a VPN network; a dead
  process's file is deleted. Also cleared in `onRevoke`, and by a
  service the system starts with no configuration (always-on after a
  reboot), which now stops instead of sitting in the foreground with a
  "Connected" notification. The JS half is `21484b3` below: even with a
  stale file, an adopted tunnel with no baseline can no longer read
  "You're protected".
- **High/medium, Android Custom mode never connects** (`2c9ddad`). The
  app's own package joins the allow-list (Xray when at least one chosen
  app was added; WireGuard's `IncludedApplications`).
- **Medium, Android social sign-in cancels itself** (`e0cc4f7`). The
  Custom Tab opens from the first `onResume`, not `onCreate`.
- **Medium, indeterminate egress shown as protected** (`21484b3`).
  Rules moved to `apps/mobile/src/lib/tunnel-evidence.ts`; mobile now
  has the `unverified` state ("Connected, not confirmed") the Windows
  client has. Non-last rungs ask only the baseline's endpoint; every
  rung after the first waits for the last tunnel to be gone before its
  baseline; the poll asks the baseline's endpoint first.
- **Medium x2, iOS IAP `finishAll`** (`0d49640`). The sweep finishes
  each transaction by the id in its JWS; `iapFinish` with no id rejects;
  `finishAll` is gone.
- **Medium x2, iOS IPv4-only capture** (`ab6bf85`, issue #48). Both
  engines set `NEIPv6Settings` (`fd18:6e78:0:1::1/64`, default route).
- **Medium, iOS WireGuard hostname endpoint** (`12315bd`). Resolved with
  `getaddrinfo` in `startTunnel`, before the settings are applied.
- **Medium, iOS connect resolves before the extension starts**
  (`046aee4`). `ProviderStart.waitUntilConnected`; failures are worded
  as local so the ladder does not file them against the route.
- **Low, iOS `.reasserting` read as down** (`046aee4`).
- **Medium, social handoff not bound to the client** (`8cd9190`
  backend, `ceaa5c8` clients). PKCE S256: optional `challenge` at
  `/start`, optional `verifier` at `/exchange`; a bound code needs its
  verifier, an unbound code with a verifier is refused (injection), an
  unbound code with none is still accepted for released clients.

**Partly done:** the low "unreachable control plane rejects working
tunnels" finding. The merged desktop fixes made the shared
`verifyEgress` call an error page from our own endpoints (a redeploy's
502) "indeterminate"; with this branch's rules that now reads
"unverified" on the poll instead of "NOT protected", lands a ladder
with no baseline as "unverified", and (`f3b335d`) is no longer
recorded against the route when a non-last rung moves on. Total
silence from every endpoint is still "unreachable" -- a dead panel and
a black-holing tunnel look the same from our own API, and the
Windows client's second instrument (`probe_ipv4_egress`) has no mobile
equivalent yet. Not done, because no finding required them and each
touches live Android users: the optional Xray DNS
`queryStrategy: "UseIPv4"`, and a mobile IPv6 egress probe.

**PROVEN (unit tests and typecheck, this PC, on the rebased tree):**
mobile 7 files / 101 tests (72 before, +29), `tsc` clean; desktop JS 52 /
792 (+13 new), `tsc` clean; backend 99 suites / 1,200 tests (+8 new),
`tsc` and eslint clean; web portal `tsc` clean. Failing against the old code:
5 of the 22 `tunnel-evidence` tests (checked by putting the old rules
back), all 7 `iap` tests, and the 8 PKCE specs (the old service does not
compile against them; behaviourally it gave the session to anyone
holding the code).

**COMPILED, in CI on `601d467` (compiles, nothing more):** the Kotlin,
in a `debug-android.yml` run dispatched on this branch (x86_64 debug
APK, throwaway key, private 7-day artifact; run 37567159371); the Swift,
in `CI (iOS)` run 37567119411 -- the tunnel extension for the simulator
and for a device, and the app with the plugin for the simulator, no
warnings in the touched files. `ci.yml` green on the same commit.

**UNVERIFIED -- not run:**
- **All Kotlin** (no JVM or Android SDK on this PC). Needs an emulator:
  Xray up, `adb shell am force-stop`, reopen -> "not protected" and no
  `files/xray-state`; the same across a reboot. Custom mode with one
  Xray protocol and Fast: exit IP equals the node, node log shows the
  session. Social sign-in: logcat order onCreate, onResume (tab),
  onPause, onNewIntent, and `vpn_open_auth_session` resolving with the
  handoff URL. That `runningAppProcesses` lists `:xray` is the
  platform's documented behaviour, not observed on any OEM build.
- **All Swift** (the Mac builds iOS from `main`). For that session:
  the extension now waits for nothing new, but the app's Xray and
  WireGuard connects wait up to 20 s for `.connected`; what
  `fetchLastDisconnectError` (iOS 16+) says for an extension that
  failed is unobserved. The IPv6
  capture needs a real iPhone on an IPv6 network with a capture outside
  the device -- including whether Xray's local TCP accept makes IPv6
  connections look open and then fail instead of falling back to IPv4.
  **iOS still has not carried a packet; gate any iOS release on that
  test.**
- The PKCE flow against Google/Facebook and a device. Old backend plus
  new client is a 400 at `/exchange` (`forbidNonWhitelisted`).

**Deploy order:** backend first (`8cd9190`; no migration, in-memory
state only), then clients. Making the PKCE challenge required is a
later step, once desktop 0.9.44 and mobile 0.2.23 are gone; until then
those clients stay exposed. The Android fixes reach nobody until an APK
release; the iOS ones ship with the first iOS build.

### The review of these fixes, and what it changed (same day)

An adversarial review of `c451e1a` reproduced the counts and found two
blocking problems, both in the new egress rules; each was reproduced
here with the real shared `verifyEgress` and only the network stood in
for, then fixed.

- **Dual-stack phones rejected every working tunnel but the last**
  (`566136f`). Mobile left `/health/ip` to tauri-plugin-http, so on a
  network with IPv6 the baseline was the phone's IPv6 address, while
  every reading through either platform's tunnel is IPv4. `verifyEgress`
  refuses to compare families, so every rung was "indeterminate": torn
  down if another was left, "not confirmed" for the session otherwise,
  and the poll never proved anything. On `main` the same mismatch read
  as connected. Fixed the Windows way: `health_ip.rs` compiled into the
  mobile crate by path, `health_ip_v4` registered, `ipv4OnlyHealthIp`
  installed in `main.tsx`. An IPv6-only network without CLAT now has no
  baseline, so it lands "not confirmed".
- **A self-reporting mirror's baseline made working tunnels leaks**
  (`60407bc`). A mirror proxying through the CDN answers with its node's
  address; as the baseline (CDN blocked before connecting), asking it
  again through a working tunnel gave the same address --
  `bypassingTunnel`, held against the route, and "NOT protected" on the
  poll, which asks the baseline's endpoint first. `captureBaselineIp`
  now takes `nodeAddresses` and passes over such a reading; the mobile
  dashboard gives it every credential's `connection.host` (the node's
  `publicIp`). Not covered: a bundle mirror on a node the customer has
  no credential for. Whether any live mirror reports itself is unknown
  -- not checked, no node access. **The Windows ladder has the same
  exposure on its non-last rungs and does not pass the option yet.**

Also: the social exchange retries once without `verifier` when an old
backend refuses the field by name (`7aef13d`), so a client released
before `8cd9190` no longer breaks Google/Facebook sign-in -- backend
first is still the order; an iOS start failure is classified by its
wrapper, so a system reason saying "timed out" is not filed against the
route (`96b115c`); the Swift comment on captured IPv6 no longer calls
Xray's TCP handling a blackhole (`d802ba0`, comment only).

Deferred, from the review's lows: ProviderStart failing on
`.disconnected` after its 1 s grace even if `.connecting` was never seen
(Swift, needs a device to know which way is wrong); Android
`xrayTunnelLive` reporting down when the process list or network state
cannot be read, and a late "up" from a dying `:xray` (Kotlin, rare, and
the egress check still catches a dead tunnel); iOS WireGuard resolving
its endpoint once (needs path monitoring); each rung waiting the full
12 s through an API outage. Beta users should hear that an adopted
Android Xray tunnel, and any connect with no baseline, now reads
"Connected, not confirmed" for the session.

**PROVEN (this PC):** mobile 9 files / 118 tests (+17), `tsc` clean;
desktop JS 53 files / 800 tests (+8), `tsc` clean; mobile `cargo check
--all-targets` clean, and `health_ip`'s 7 tests pass inside the mobile
crate (Windows host). Against the old code 14 of the new tests fail
(10 mobile, 4 desktop); the rest are controls that reproduce the review
or pin behaviour that did not change.

**COMPILED, in CI on `6fa282e` (compiles, nothing more):** the mobile
crate with `health_ip` and reqwest for Android, in a `debug-android.yml`
run dispatched on this branch (aarch64, throwaway key, private 7-day
artifact; run 37571589242), and for the iOS simulator in `CI (iOS)` run
37571567114. `ci.yml` green on the same commit (run 37571567156).

**UNVERIFIED:** none of it on a phone. That `health_ip_v4` connects, and
asks over IPv4, on a real Android or iOS network stack; the dual-stack
fix on a real IPv6 network; the retry against a real old backend.

## 2026-10-06 — panel review fixes (branch `claude/review-fixes-panel`)

**Status:** done on the branch and pushed; not merged, not deployed.
**Based on `claude/review-fixes-backend`**: five of the panel-area
findings were backend findings that branch already fixes, and the rest
touch the same backend files. *Since then* that branch reached main
(5ab1683, 7533211) and main was merged into this one, so this branch now
merges into main on its own -- see the second-round entry below.
**Touches:** `apps/panel` (sign-in, infra pages, route and reseller
screens; gains vitest), `apps/backend` (protocol-config and route reads,
route list, vouchers, resellers; one comment in `main.ts`),
`apps/web-portal` (sign-out; gains vitest), `apps/discord-bot` (tickets).
No migration.

The 17 confirmed panel-area findings come down to 11 problems. Fixed
here: the admin lockout (01545f4), secrets in admin page payloads
(c8a2ee6), the route delete dialog (e9bb5cc), retired-plan vouchers
(2f06d05), the portal's 10 s sign-out (db635c1), the public ticket
fallback (76b5d07). Already fixed on the base branch, checked present
and left alone: staff role gates on routes, protocol users and POST
/subscriptions (35e5ce1), MFA setup while on (4a5e967), the per-admin
TOTP budget (2eba314), DISABLED revoking access (ebd2520, 85f082b) --
this branch only adds the panel's hint for the last (767bb04).

### What a deploy does -- read before deploying

Backend and panel go out together (`docker compose ... up -d --build`
rebuilds both); neither needs the other first -- the panel works against
main's backend, and the new backend fields are optional to the panel.

- **Production nginx must set both headers on `location /`**, as
  `installer/assets/nginx-panel.conf.template` does:
  `X-Real-IP $remote_addr` and `X-Forwarded-For $proxy_add_x_forwarded_for`.
  The production panel nginx is hand-maintained and was not read.
  Read-only check on the panel host:
  `grep -n "X-Real-IP\|X-Forwarded-For" /etc/nginx/sites-enabled/*`.
  Without them the panel sends no address, sign-ins share one bucket as
  before, and the panel logs once:
  `docker compose -f infra/docker-compose.prod.yml logs panel | grep "no trustworthy client address"`.
- **Behind Cloudflare** the panel takes `CF-Connecting-IP` only when
  nginx's peer is a published Cloudflare edge (the backend's list,
  copied; a test fails if the two drift).
- **`restore-openvpn-from-panel.sh` now needs a SUPERADMIN token.** GET
  /protocol-configs returns `serverKeyPem` to SUPERADMIN only and
  `caKeyPem` to nobody. *Corrected in the second round:* as first
  written, a lesser token did **not** stop the script -- `jq -r` printed
  "null", which passed its non-empty check and was installed as
  server.key. From fd1f986 it stops with "no server.key from the panel
  -- the server key needs a SUPERADMIN token". The installer's own POST
  is unchanged.
- **The web portal** is a static build inside the website zip: its fix
  reaches customers only when the website is rebuilt and uploaded. **The
  Discord bot** needs its container rebuilt (`--profile discord`).
- **Existing OpenVPN CA keys** were readable by every staff role until
  this deploys. Rotating means reissuing every client cert on a node;
  only worth it if a SUPPORT or BILLING account has ever existed --
  `SELECT role, count(*) FROM admin_users GROUP BY role;` says.

### Proven, on this PC

- Backend 103 suites / 1,206 tests (base branch: 99 / 1,188), typecheck
  and lint clean. Panel 6 files / 39 tests, typecheck, lint (two old
  warnings) and `next build` clean. Portal 1 file / 2 tests, `tsc -b`
  clean. Bot 48 tests, typecheck and lint clean. Each fix's tests were
  run against the code before it and failed (counts in the commits).
- **The sign-in chain, run for real except nginx and Postgres.** The
  built panel (`next build`, `next start`) in the desktop app's browser
  pane; the backend's own AuthController, LoginGuard and
  ClientThrottlerGuard from `dist`, behind `trust proxy 1`, with only the
  password check stubbed; a small proxy setting the template's two
  headers, one port per pretend client. A stranger's five wrong
  passwords: five challenges solved in the browser, five 401s counted
  against the stranger's address, the sixth refused 429 with "Too many
  sign-in attempts from your address". The operator, from another
  address, signed straight in. Then five failures against the admin's
  email from five addresses: a challenge-less sign-in with the right
  password got the 400 that locked admins out before; through the panel
  the browser solved the 15-bit challenge and the operator got in.
  Forged X-Real-IP, X-Forwarded-For and CF-Connecting-IP sent through
  the proxy were ignored.
- Portal: the shared sign-out code under the portal's own shims took
  10,020 ms before the fix (the review's verifier measured the same) and under a
  second after.

### Unverified

- Real nginx, real Cloudflare, and the production nginx config (above).
  The CF-Connecting-IP path is unit-tested only.
- **The panel believes both headers if a request reaches it without
  nginx and sets both alike** -- run directly against `next start`, that
  is what happened. Production publishes the panel on 127.0.0.1:3000, so
  that needs a foothold on the host.
- How long a real browser takes at the top difficulty (21 bits, only for
  an account under sustained attack). Measured in Node only: 244k
  hashes/s batched, about 9 s expected; a challenge lives 2 minutes.
- The redacted reads, the route count and the voucher refusal are
  checked against mocked Prisma, not a database; the restore script was
  not run; the portal sign-out was not run in a browser; the bot was not
  run against Discord.

### Not fixed, and why

- **A plan retired between redeem's check and the subscription create**
  still burns the code. Closing it needs the claim and the create in one
  transaction (SubscriptionsService.create taking a tx client).
- **Operators can still create vouchers for an inactive plan** (resellers
  cannot). Left open on purpose: preparing codes before a launch is
  plausible, and redeem no longer spends them.
- **Customer delete stays open to SUPPORT.** The verifier rated it a
  policy choice, not a defect; the settled-payment check guards it.
- **publicParamsJson still stores the private keys.** Reads no longer
  return them; moving them to an encrypted column (2026-08-31 entry) is
  the durable fix, and a migration.
- **The panel never refreshes an admin's token**, so operators sign in
  every 15 minutes -- which is what made the lockout bite so fast. Not a
  finding here; worth its own change.
- **The apps' solver awaits one hash at a time**
  (`apps/desktop-windows/src/lib/pow.ts`: about 40 s at 21 bits in Node,
  against 9 s batched). The panel's is batched; the apps' is not changed
  here.

## 2026-10-06 — panel review fixes, second round (same branch)

**Status:** pushed to `claude/review-fixes-panel`; not merged, not
deployed. Main is merged in (c1a5c56), so the branch merges into main on
its own; the journal was the only conflict.

The adversarial review of `f4076ca` found one blocking regression and
six lows. Fixing the blocking one turned up a second regression from the
same change (01545f4 moved the submit into `onSubmit`), which the review
had not seen. Neither was ever deployed.

- **Blocking, fixed (0f1bbd5): a submit before hydration put the admin
  password in the URL.** The server-rendered form had no method and no
  action, so a native submit was `GET /login?email=…&password=…` -- into
  nginx's access log. `action={formAction}` is back beside `onSubmit`.
  Against `next start`: the served form is `method="POST"` with the
  action's hidden fields; a native submit of that server-rendered form
  (the reviewer's method: a clone with no React listeners) reached a
  backend stand-in as a challenge-less sign-in and left no query string;
  after hydration one submit sent one challenge request and one sign-in
  carrying the solved challenge -- React did not also run the action.
- **Found while fixing it, fixed (0f1bbd5): the admin password shown in
  clear in the code box.** React resets a form only after an action it
  runs itself; `onSubmit` dispatching by hand lost that, and React reused
  the password `<input>` for the code step as `type="text"`. Seen in the
  browser pane against `next start`: the "Authentication code" box held
  the password. `onSubmit` now calls `requestFormReset` in its
  transition, as React did, and the steps are keyed. After: the box is
  empty, and a code submit reaches `/auth/mfa/verify` once.
- **Low, fixed (fd1f986): the restore script installed "null" as
  server.key** with a non-SUPERADMIN token (jq prints `null` for a
  missing key; the non-empty check passed it). Corrected in the first
  entry above.
- **Low, fixed (0ae5224):** the 429 and proof-of-work refusals said
  "from your address" when the panel had no trustworthy address and the
  backend counted every sign-in in one bucket.
- **Low, fixed (bad7291):** the panel's solver paused for the page with
  `setTimeout`, which browsers throttle in hidden tabs; it now yields
  through a MessageChannel.
- **Low, fixed (ea7b213):** the web portal's pretest was `VAR=1 node …`,
  which cmd.exe refuses; reproduced, then fixed with a small script.
- **Low, fixed (2faa3d1):** the route delete dialog said credentials are
  revoked "on the node immediately"; they are queued commands, replayed
  to an offline node when it reconnects.
- **Low, fixed (c1a5c56):** the first entry's "merge the backend branch
  first" was out of date; that branch is in main.

### Counts, on the merged tree (this PC)

Backend 103 suites / 1,210 tests (main's additions included), typecheck
and lint clean. Panel 7 files / 46 tests (was 6 / 39), typecheck clean,
lint 0 errors and the 2 old warnings, `next build` passes. Web portal 1
file / 2 tests under both cmd.exe and Git Bash, `tsc -b` clean. Discord
bot 48 tests, typecheck clean, lint 0 errors. New tests that fail on the
code before them: `login-form.test.tsx` 3 of 3 (one renders the form
through react-dom/server with a real server reference; two are source
checks, the suite having no DOM), `actions.test.ts` 2, `pow.test.ts` 1,
`delete-warning.test.ts` 1. Desktop and mobile were not touched.

### Unverified

- How often operators really submit before hydration.
- Hidden-tab timer throttling in a real Chrome. The desktop app's pane
  does not throttle (50 chained `setTimeout(0)` in a hidden tab took
  217 ms), so the fix is checked only for working there: a hidden tab
  solved an 18-bit challenge from the built panel in about 0.55 s.
- The restore script's change was not run with jq or on a node (no jq on
  this PC); its check loop, copied out, refused a "null" and an empty
  server.key and passed real PEM files.
- Everything the first entry lists as unverified still is.
