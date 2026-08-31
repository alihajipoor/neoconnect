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

**They cannot recover on their own.** The backend only re-asserts to
nodes it considers ONLINE, so the moment these two were marked OFFLINE
they stopped receiving anything at all. Nothing in the current design
brings a wedged agent back; it will sit there until someone restarts it.

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
