# Working in this repo

Neoxify: a commercial multi-protocol VPN. NestJS backend + Next.js panel
+ Go node agent + Tauri clients (Windows desktop, Android/iOS mobile) +
a bash installer. A large share of users are in Iran, on censored
networks.

This is the VPN, **neoxify.net**. There is a second, unrelated Neoxify
product — the hosting panel at **neoxify.com**, in the `neoxify-panel`
repo. Different codebase, different servers, different credentials. Do
not carry anything between them.

## One machine now — read this first

Until 2026-08-30 work ran on two machines in parallel: a **Windows** box
(desktop client, backend, panel, installer, Android) and a **MacBook**
(iOS). **The Windows machine is gone.** Everything now runs from the
Mac.

What that changes, concretely:

- **The ownership table is retired.** No area belongs to another
  session. Nothing is "held" for anyone.
- **The two-machine journal protocol is retired.** See
  `docs/journal/README.md` — there is one log now.
- **The test rig is gone.** `Neoxify-Test2` (VirtualBox), the packet
  captures, and the `C:/nxcme` worktree all lived on that machine. This
  matters more than anything else in this file; see *How work is
  expected to be done here* below.
- **Fleet SSH keys are gone** (`ovh_neo`, `azs_vps`, `neo_tr1`).
  Node access has to be re-established before any node-side work.

`docs/journal/log.md` records the full recovery assessment, including
what was lost and what was recovered.

### What can and cannot be built here

The Mac **can type-check** the Windows desktop service, and cannot build
or run it. `cargo check` does not link, so with the
`x86_64-pc-windows-gnu` target and mingw-w64 supplying the C
cross-compiler `ring` needs:

```bash
cd apps/desktop-windows
export CC_x86_64_pc_windows_gnu=x86_64-w64-mingw32-gcc \
       AR_x86_64_pc_windows_gnu=x86_64-w64-mingw32-ar \
       CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc
cargo check --target x86_64-pc-windows-gnu -p neoconnect-service --all-targets
```

That catches every type and borrow error before CI does, on a crate whose
round trip is otherwise twenty minutes. It does **not** link and does
**not** run -- `windivert-sys` links against `WinDivert.lib`, so the test
binary still needs Windows and `cargo test` here is not an option. Check
locally to know it compiles; read the desktop job to know the tests pass.

iOS needs a full Xcode (not Command Line Tools). But **every release workflow runs on a
GitHub-hosted runner**, so shipping does not depend on local toolchains:

| Target | Workflow | Runner | Trigger |
|---|---|---|---|
| Windows desktop | `release-desktop-windows.yml` | `windows-latest` | tag `desktop-v*` |
| Android | `release-android.yml` | `ubuntu-latest` | tag `android-v*` |
| Node agent | `release-agent.yml` | `ubuntu-latest` | tag `v*` |
| iOS (compile only) | `ci-ios.yml` | `macos-latest` | push to `main` |
| Lint/typecheck/build/test | `ci.yml` | ubuntu + `windows-latest` | push to `main`/`claude/**`/`rig/**`, PR to `main`, `workflow_dispatch` |

So: **releases are unaffected by losing the Windows box.** What was lost
is the ability to *debug* the desktop client locally and to *prove*
anything against real traffic.

`ci.yml` runs on `main`, on PRs to `main`, and on pushes to `claude/**`
and `rig/**`. That branch coverage is load-bearing rather than a
convenience: **CI is the only way this machine can verify a desktop
change at all.** `workflow_dispatch` covers anything on a different
branch name — that escape hatch exists because the desktop job once sat
broken from the day it was added, only testable by merging to main.

So the working rule for `apps/desktop-windows/**`: write it, push it,
and read the desktop job. Do not call such a change verified on the
strength of review alone.

Backend, panel, web portal and the Go agent all build and test locally
on the Mac once the toolchains are installed.

## How work is expected to be done here

**Prove it against something real.** This project's whole history is
findings that only appeared under real execution: relay chaining had two
bugs invisible from reading the source; the split-tunnel design failed
three times against real packet captures before the fourth worked; a
"Connected" indicator was lying because nothing checked whether traffic
flowed. Counters, exit codes and "no error was thrown" have all produced
false passes here. Ground truth means the server's own logs, a packet
capture, or an exit IP that matches the node.

**The rig that used to supply that proof is gone.** Do not quietly lower
the bar to compensate. Until an equivalent exists, anything that needs
real packets is **unverified, and must be labelled unverified** — not
downgraded to "tests pass". A finding that needs a capture is blocked,
not done. Rebuilding a capture rig is itself a work item; the traps that
cost real hours on the old one are in `docs/journal/HANDOVER-2026-08-22.md`
§7 and the final entries of `docs/journal/windows.md`.

**Say what is proven and what is not.** A green CI run means it
compiles. `ci-ios.yml` in particular builds the simulator, which cannot
run a VPN tunnel at all — never quote it as evidence one works.

**Never report a tunnel state the app has not verified.** Honesty about
connection state is a product requirement, not a nicety: users in Iran
act on it. That extends to messages — do not claim a server "couldn't be
reached" if it was never dialled.

**Never drop a protocol to make something pass.** Every transport
matters for censored networks. A platform that cannot support one (iOS
has no per-app split tunnel, for instance) is a gap to state plainly,
not a decision to make quietly.

**Live users exist.** Friends run the desktop client and Android as
their real VPN. Do not block ports on production nodes to test failover,
restart engines, or change routes/protocol configs without asking.
Client-side changes and new releases are fine.

## Branching

- **Main must stay releasable at all times.** There are live beta users
  on the desktop client and a hotfix has to be cuttable the minute it is
  needed.
- Work on a branch, push small commits often, merge when verified.
- Two branches are open and unmerged: `claude/concurrent-multi-exit-v2`
  and `rig/cme-v2-verify`. The second carries the measurement run for
  the first. Read their journal entries before touching either.

## Versions and tags

`apps/mobile` carries **one version for both platforms** — it is one
app. Release workflows validate the tag against it (`android-v*`, and
`ios-v*` when that exists), a guard that exists because a desktop
release once shipped 0.8.0 under a 0.9.0 tag. Do not add a second
version field.

Tag prefixes are load-bearing and must not be shared: `desktop-v*`,
`android-v*`, `v*` (agent). The API resolves "newest release" per
prefix, and a desktop release once hijacked the agent installer's
download URL precisely because they collided.

Current: desktop `0.9.31`, mobile `0.2.15`, agent `v0.2.6` — each
matching its latest released tag.

## Secrets

`apps/mobile/.signing/` held the Android release keystore. **That
directory is gone with the Windows machine.** The key itself survives
only as the GitHub Actions secrets `ANDROID_KEYSTORE_BASE64` and
`ANDROID_KEYSTORE_PASSWORD`, which `release-android.yml` signs from — so
Android releases still work, but **that secret is now the only copy and
GitHub will not let you read it back.** Android identifies an app by its
signing key; losing it means every existing user must uninstall and
reinstall. Treat it accordingly.

This repo is public. Never paste credentials into commits, logs, or
chat. When querying the database, select named columns — several tables
carry encrypted credential blobs.

Two credentials are known-exposed and still need rotating: turkey-1's
root password and singapore-1's `agent.json` private key. See
`docs/journal/HANDOVER-2026-08-22.md` §6.
