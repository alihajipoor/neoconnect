# Working in this repo

Neoxify: a commercial multi-protocol VPN. NestJS backend + Next.js panel
+ Go node agent + Tauri clients (Windows desktop, Android/iOS mobile) +
a bash installer. A large share of users are in Iran, on censored
networks.

This is the VPN, **neoxify.net**. There is a second, unrelated Neoxify
product — the hosting panel at **neoxify.com**, in the `neoxify-panel`
repo. Different codebase, different servers, different credentials. Do
not carry anything between them.

## Where this repo lives

Two checkouts, one per machine (see *Two machines again* below):

- **Windows (the main machine):** `C:\Users\aliha\Claude\neoconnect`.
  **Not** under the Desktop: on that PC the Desktop is itself a
  OneDrive folder (`C:\Users\aliha\OneDrive\Desktop`), and a synced
  folder is the wrong place for a build tree. Moving the checkout out
  of it with `Move-Item` fell back to copy-and-delete and stalled on
  pnpm's `node_modules` junctions; `robocopy /MOVE` finished it, and
  afterwards `target\` needed a `cargo clean` because Tauri's build
  output records absolute paths.
- **Mac:** `/Users/alihajipoor/Developer/neoconnect`. **Not** the old
  path under `~/Desktop/Claude/Neoxify/`.

The Mac copy was moved on 2026-09-23 because macOS syncs Desktop to
iCloud, and that actively corrupts a build tree. Two distinct failures
in one day:

- **Eviction.** Under disk pressure macOS turns file contents into
  `dataless` placeholders. 97 tracked files and part of `node_modules`
  became unreadable -- reads failing with `ETIMEDOUT` and `Unknown system
  error -81` on plainly local files, which reads as filesystem corruption
  and is not. Tracked files were recoverable with `git show HEAD:<path>`;
  `node_modules` needed a reinstall.
- **Duplication.** iCloud copies files it thinks conflict, appending
  " 2". That reached `.git/index`, `.git/refs/heads/main`, and the
  generated Xcode project -- where `mobile 2.xcodeproj` made every build
  fail with *"you have modified your package name from mobile 2 to
  mobile"*. Cleaning them was not enough: the next build produced
  `mobile 3.xcodeproj`. It was happening faster than the build could run.

The old directory may still be on the Desktop. Do not work in it.

`mv` is the wrong way to move it: macOS treats the FileProvider-backed
Desktop as a separate volume, so it copies rather than renames, and it
hung for fifteen minutes having written nothing. Clone from GitHub
instead and copy back only what is gitignored and expensive -- the Go
xcframework (`plugins/vpn/tunnel/Frameworks`) and the fetched
`seed-bundle.json`. That took two minutes.

## Two machines again — read this first

From 2026-08-30 to 2026-10-04 everything ran from the Mac, because the
old Windows box was gone. **Since 2026-10-04 there is a Windows PC
again, and it is the main machine**: the desktop client, the service,
and day-to-day work. The Mac stays for what only it can do -- Xcode,
the Apple Developer ID and the iOS signing certificates. Setting up a
new Windows machine is written down in `docs/new-machine-setup.md`.

What carries over from the one-machine period, unchanged:

- **The ownership table is retired.** No area belongs to another
  session. Nothing is "held" for anyone.
- **One journal.** See `docs/journal/README.md` — there is one log.
- **The old test rig is gone; a smaller one exists.** `Neoxify-Test2`,
  the packet captures, and the `C:/nxcme` worktree lived on the old
  Windows box. Since 2026-10-04 there is a VirtualBox guest,
  `Neoxify-Test`, on the Windows PC, with its tooling outside the repo
  in `C:\Users\aliha\Claude\vm\tools` -- see the 2026-10-04 entry in
  `docs/journal/log.md`. It proves exit IPs, teardown and what the app
  decided, and -- since 2026-10-05 -- what leaves the guest, captured at
  the NIC miniport with `pktmon --comp nics`. **Not** with VirtualBox's
  own `--nic-trace`, which silently misses the guest's outgoing global
  IPv6. The guest has IPv6 addressing but this PC has no IPv6, so
  nothing ever answers: a leak shows as packets *sent*, never as a
  reply. This matters more than anything else in this file; see *How
  work is expected to be done here* below.
- **Fleet SSH keys** (`ovh_neo`, `azs_vps`, `neo_tr1`) went with the
  old box. Node access has to be re-established before any node-side
  work.

`docs/journal/log.md` records the 2026-08-30 recovery assessment,
including what was lost and what was recovered.

### What can be built where

**On the Windows PC, everything in `apps/desktop-windows` builds and
runs its tests**, which it could not do anywhere for five weeks:

```bash
cd apps/desktop-windows
powershell -ExecutionPolicy Bypass -File src-tauri\scripts\fetch-binaries.ps1
cargo check --workspace --all-targets
cargo test --workspace
pnpm test
```

`fetch-binaries.ps1` has to have run once before `--workspace` will
check, because the Tauri crate's build script refuses to run until
every bundled resource is on disk. Two Windows-only traps:

- **`pnpm test` fails under the default shell.** Its `pretest` hook is
  written `VAR=1 node ...`, which `cmd.exe` cannot run. Point pnpm at
  Git Bash first: `$env:npm_config_script_shell = 'C:\Program
  Files\Git\bin\bash.exe'`. CI never hits this, because it runs the
  desktop JS tests on Linux. Use `pnpm test`, never `npx vitest` -- the
  hook patches generated files, and skipping it fails a capability-scope
  test on a perfectly good checkout.
- **Socket teardown needs a concurrent test.** A `try_clone` of a
  socket was measured losing sight of its connection under load; a
  single-instance test passed every time while 8 to 20 of 32 concurrent
  stops failed. See `docs/split-tunnel-rewrite.md`.

**On the Mac, the Windows service type-checks and nothing more.**
`cargo check` does not link, so with the `x86_64-pc-windows-gnu` target
and mingw-w64 supplying the C cross-compiler `ring` needs:

```bash
cd apps/desktop-windows
export CC_x86_64_pc_windows_gnu=x86_64-w64-mingw32-gcc \
       AR_x86_64_pc_windows_gnu=x86_64-w64-mingw32-ar \
       CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc
cargo check --target x86_64-pc-windows-gnu -p neoconnect-service --all-targets
cargo check --target x86_64-pc-windows-gnu -p neoconnect-ipc --all-targets
```

Those two crates only -- the Tauri crate needs the bundled resources --
and `cargo test` is not an option there, since `windivert-sys` links
against `WinDivert.lib`.

iOS needs a full Xcode (not Command Line Tools). But **every release workflow runs on a
GitHub-hosted runner**, so shipping does not depend on local toolchains:

| Target | Workflow | Runner | Trigger |
|---|---|---|---|
| Windows desktop | `release-desktop-windows.yml` | `windows-latest` | tag `desktop-v*` |
| Android | `release-android.yml` | `ubuntu-latest` | tag `android-v*` |
| Node agent | `release-agent.yml` | `ubuntu-latest` | tag `v*` |
| iOS (compile only) | `ci-ios.yml` | `macos-latest` | push to `main` |
| Lint/typecheck/build/test | `ci.yml` | ubuntu + `windows-latest` | push to `main`/`claude/**`/`rig/**`, PR to `main`, `workflow_dispatch` |

`ci.yml` runs on `main`, on PRs to `main`, and on pushes to `claude/**`
and `rig/**`. A branch named anything else gets no CI at all, silently;
`workflow_dispatch` is the escape hatch, and it exists because the
desktop job once sat broken from the day it was added, only testable by
merging to main.

So the working rule for `apps/desktop-windows/**`: **verify it locally
on the Windows PC first** -- seconds, where a CI round trip is about
sixteen minutes -- then push once per meaningful chunk and read the
desktop job before merging. Windows runners bill at 2x and twenty
pushes in one session once exhausted the Actions quota mid-release.
Neither a local pass nor a green job is evidence about real traffic;
that still needs the rig.

Backend, panel, web portal and the Go agent build and test on either
machine once the toolchains are installed.

## How work is expected to be done here

**Prove it against something real.** This project's whole history is
findings that only appeared under real execution: relay chaining had two
bugs invisible from reading the source; the split-tunnel design failed
three times against real packet captures before the fourth worked; a
"Connected" indicator was lying because nothing checked whether traffic
flowed. Counters, exit codes and "no error was thrown" have all produced
false passes here. Ground truth means the server's own logs, a packet
capture, or an exit IP that matches the node.

**The rig that used to supply that proof is gone,** and the VM that
replaced it covers only part of it. Do not quietly lower the bar to
compensate. Anything the VM's capture cannot reach -- a real IPv6
path, a censored network, a physical device -- is **unverified, and
must be labelled unverified** — not downgraded to "tests pass". A finding that needs a capture is blocked,
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
- `claude/service-rewrite` is the open branch: the Windows service
  rewrite (`docs/windows-service-rewrite.md`) and, inside it, the
  split-tunnel rewrite (`docs/split-tunnel-rewrite.md`, whose *Where it
  stands* section lists what has landed). `claude/concurrent-multi-exit-v2`
  and `rig/cme-v2-verify`, named here before, are both merged.

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

Current: desktop `0.9.45`, mobile `0.2.24`, agent `v0.2.10` — each
matching its latest released tag.

**The production backend tracks `main`** as of 2026-10-06 (`3bafbe0`,
the 0.9.44 / 0.2.23 release, with migrations through
`20261008_session_labels` applied; per-device credentials and device
slots are live, `CONCURRENCY_CUT` is left at its default `shadow` --
see `docs/device-slots.md` before changing it). It is deployed over SSH to the
panel host with the key at `C:\Users\aliha\.ssh\neoxify_panel`: dump the
database to `/root/db-backups/pre-<what>-<time>.sql.gz` first, then
`git pull --ff-only` in `/root/neoconnect` and
`docker compose -f infra/docker-compose.prod.yml --env-file infra/.env up -d --build`.
Migrations apply at container start. Always deploy the backend before
releasing clients that depend on it.

## iOS

The app is four pieces, and only the first is shared with Android:

| Piece | Where | Built by |
|---|---|---|
| Xray + WireGuard engines | `plugins/vpn/xray` (Go) | `scripts/build-xray-xcframework.sh` |
| Packet tunnel | `plugins/vpn/tunnel` (Swift) | the `NeoxifyTunnel` Xcode target |
| App-side plugin | `plugins/vpn/ios` (Swift) | Tauri, as a Swift package |
| Bridge | `plugins/vpn/src` (Rust) | cargo |

The engine is the same Go as Android's AAR: gomobile takes the platform
as an argument, and xray-core's darwin tun inbound already accepts a
descriptor from `xray.tun.fd` for NetworkExtension. Nothing was ported.

WireGuard lives in that same package, constrained to darwin, and
in the same framework -- two gomobile frameworks would link two Go
runtimes into one extension. It is off Android because WireGuard there
comes from `com.wireguard.android:tunnel`. It adds almost nothing:
xray-core already depends on wireguard-go for its own outbound.

Darwin rather than ios is deliberate -- gomobile builds iOS as GOOS=ios
and ios implies darwin, so what ships is the same, but a GOOS=ios binary
will not run on the build machine and darwin lets `go test` exercise the
utun framing. That framing is the only part of the iOS tunnel testable
without an iPhone. Note the constraint is in the *filename* too: Go
applies the suffix rule first, so `wireguard_ios.go` was invisible to
every non-ios build no matter what its build tag said.

**The extension target is not committed.** `tauri ios init` regenerates
`gen/apple` and would erase it, so `scripts/add-tunnel-extension.mjs`
patches the XcodeGen spec and regenerates. Run it after any `ios init`:

```bash
pnpm exec tauri ios init --ci && node scripts/add-tunnel-extension.mjs
```

**Build with `pnpm ios:build`, not `tauri ios build`.** The wrapper
regenerates the project (a new Swift file is otherwise simply not in it,
which reads as "cannot find type X in scope"), sets
`VITE_DISTRIBUTION=store`, clears Tauri's previous output -- it renames
over it and fails every rebuild after the first with "Directory not
empty (os error 66)" -- and then asserts the bundle carries no checkout
or voucher path. App Store guideline 3.1.1.

**A green simulator build says nothing about entitlements.** The
simulator does not enforce them. The app was signed with an empty
`<dict/>` for weeks and built, installed and ran throughout; it would
have failed on the first device. If you touch `add-tunnel-extension.mjs`,
check the generated `mobile_iOS/mobile_iOS.entitlements` has content.
Tauri already writes an `entitlements:` key for the app target, so
*adding* one gives a duplicate YAML key and the last silently wins --
the same trap the script documents for `dependencies:`.

**Tauri does not build with Xcode 27.** It compiles its Swift package
twice -- once for `arm64-apple-ios`, correctly, and once for
`arm64-apple-macos`, which dies on WebKit under the macOS 27 SDK. A
pristine Tauri project fails the same way, so it is not ours. CI uses
Xcode 26.6 and works. To build locally, install Xcode 26 alongside 27 and
point at it:

```bash
sudo xcode-select -s /Applications/Xcode-26.6.app/Contents/Developer
```

iOS carries the same protocols as Android, by three routes: Xray and
WireGuard share the one packet-tunnel extension (iOS allows a tunnel
extension one principal class, so the provider picks the engine from the
profile), and IKEv2 goes through the system's own client with no
extension of ours involved. Per-app routing belongs to the system.
`src/lib/platform.ts` is now a guard for whatever is added next rather
than a restriction on anything in the ladder today.

**Nothing has carried a packet.** Network Extensions do not run in the
simulator and NEVPNManager cannot dial from one, so every protocol, and
the extension's ~50MB memory ceiling, is gated on a real iPhone.

Export compliance (`ITSAppUsesNonExemptEncryption`) is deliberately
unset, so App Store Connect asks at upload. A VPN plainly uses
encryption, so `false` would be untrue, and `true` commits to a
self-classification filing that is a legal decision, not a build
setting.

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

turkey-1's root password is known-exposed (`docs/journal/HANDOVER-2026-08-22.md`
§6). Changing it is the owner's to do: they keep root password login on
purpose (2026-10-07), so do not disable or rotate it, or change any
node's sshd authentication. singapore-1's exposed `agent.json` key was
rotated on 2026-10-07 (new pair generated on the node; the old key no
longer authenticates).
