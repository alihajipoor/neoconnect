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
