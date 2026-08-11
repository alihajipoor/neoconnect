# Working in this repo

Neoxify: a commercial multi-protocol VPN. NestJS backend + Next.js panel
+ Go node agent + Tauri clients (Windows desktop, Android/iOS mobile) +
a bash installer. A large share of users are in Iran, on censored
networks.

## Two sessions at once — read this first

Work currently runs in parallel: a **Windows** machine (desktop client,
backend, panel, installer, Android) and a **MacBook** (iOS only, because
iOS cannot be built anywhere else). Neither session sees the other's
context, so the boundaries have to live here.

### Who owns what

| Area | Owner |
|---|---|
| `apps/desktop-windows/**`, `release-desktop-windows.yml` | Windows |
| `apps/backend/**`, `apps/panel/**`, `installer/**`, `agent/**` | Windows |
| `apps/mobile/plugins/vpn/ios/**`, `src-tauri/gen/apple/**`, `ci-ios.yml`, `docs/ios-client.md` | Mac |
| `apps/mobile/src/**`, `apps/mobile/plugins/vpn/src/*.rs`, mobile `package.json` / `tauri.conf.json` / `Cargo.toml` | **shared — coordinate** |

Android and iOS are the *same app*. `apps/mobile/src/**` is one React
codebase and `plugins/vpn/src/{lib,commands}.rs` is one Rust plugin, so
"Android work" and "iOS work" are not naturally isolated.

The conflicts git reports are the easy ones. The dangerous kind merge
cleanly and fail at runtime — one session reshapes a plugin command for
its platform while the other still calls the old shape. **Keep the
shared plugin interface additive.** Do not unilaterally refactor a
signature the other platform calls; add alongside instead.

### Branching

- **iOS work goes on a branch, never straight to main.** Main must stay
  releasable at all times: there are live beta users on the desktop
  client, and a hotfix has to be cuttable the minute it is needed.
- Pull before starting, push small commits often. A long-lived divergent
  branch on shared mobile files is the expensive case.

### Versions and tags

`apps/mobile` carries **one version for both platforms** — it is one app.
Release workflows validate the tag against it (`android-v*`, and
`ios-v*` when that exists), a guard that exists because a desktop
release once shipped 0.8.0 under a 0.9.0 tag. Do not add a second
version field without agreeing it across both sessions.

Tag prefixes are load-bearing and must not be shared: `desktop-v*`,
`android-v*`, `v*` (agent). The API resolves "newest release" per
prefix, and a desktop release once hijacked the agent installer's
download URL precisely because they collided.

## How work is expected to be done here

**Prove it against something real.** This project's whole history is
findings that only appeared under real execution: relay chaining had two
bugs invisible from reading the source; the split-tunnel design failed
three times against real packet captures before the fourth worked; a
"Connected" indicator was lying because nothing checked whether traffic
flowed. Counters, exit codes and "no error was thrown" have all produced
false passes here. Ground truth means the server's own logs, a packet
capture, or an exit IP that matches the node.

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

**Live users exist.** Do not block ports on production nodes to test
failover, restart engines, or change routes/protocol configs without
asking. Client-side changes and new releases are fine.

## Secrets

`apps/mobile/.signing/` holds the Android release keystore and its
password. It is gitignored and has never been committed — **keep it that
way; this repo is public.** Android identifies an app by its signing
key, so losing or leaking it is unrecoverable.

Never paste credentials into commits, logs, or chat. When querying the
database, select named columns — several tables carry encrypted
credential blobs.
