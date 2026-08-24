# Shared — decisions and blockers affecting both machines

Append at the bottom. See `README.md` for the protocol.

---

## 2026-08-11 — Ground rules for parallel work

**Status:** done

Two machines now: **Windows** (desktop client, backend, panel,
installer, Android) and **MacBook** (iOS only). See `CLAUDE.md` for the
ownership table.

The boundary that matters: **Android and iOS are the same app.**
`apps/mobile/src/**` is one React codebase and
`apps/mobile/plugins/vpn/src/*.rs` is one Rust plugin. Those are the only
places the two workstreams genuinely collide, and the collision that
hurts merges cleanly and breaks at runtime — one side reshapes a plugin
command signature, the other still calls the old shape.

Rule: **keep the shared plugin interface additive.** Add alongside;
don't unilaterally change a signature the other platform calls.

**iOS stays on a branch, not main.** Main must be releasable at any
moment — there are live beta users on the desktop client and a hotfix
has to be cuttable immediately.

---

## 2026-08-11 — Windows is holding the Android work

**Status:** superseded by the entry below — see "Windows has taken
apps/mobile back"

Task #92 (splitting Android into Play and direct-APK flavors) was
**deliberately not started**, because it is the one Windows-side task
that collides hard with iOS in `apps/mobile`.

Windows was doing only zero-overlap work meanwhile: code signing (#91),
desktop picker fixes (#90), backend.

---

## 2026-08-11 — Windows has taken `apps/mobile` back

**Status:** in flight — **Mac read this before starting iOS**

Priorities changed: Google Play listing moved ahead of iOS, because it
needs no company (iOS publishing does, and the company is ~6-8 weeks
out once D-U-N-S and Apple verification are counted).

So **Windows is now working in `apps/mobile`** on #92 — the AAB build
and the Play/direct-APK flavor split. This reverses the entry above.

**Mac: coordinate before touching `apps/mobile/src/**` or
`apps/mobile/plugins/vpn/src/*.rs`.** Nothing has been written on the
iOS side yet, so there is no conflict *right now*, and the iOS-only
paths (`plugins/vpn/ios/**`, `gen/apple/**`, `ci-ios.yml`) stay clear
either way. If iOS work starts in earnest, say so here and Windows will
stop.

Reminder of the rule that matters: keep the shared plugin interface
additive. The flavor split should not change any signature the iOS side
will need to implement.

---

## 2026-08-11 — One version for both mobile platforms

**Status:** decided

`apps/mobile` carries a single version covering Android and iOS — it is
one app. Release workflows validate the tag against it (`android-v*`,
and `ios-v*` when it exists). That guard exists because a desktop
release once shipped 0.8.0 under a 0.9.0 tag.

Do not add a second version field without agreeing it across both
machines. Tag prefixes must stay distinct (`desktop-v*`, `android-v*`,
`v*` for the agent) — the API resolves "newest release" per prefix, and
a desktop release once hijacked the agent installer's download URL by
sharing one.

---

## 2026-08-11 — Live beta users: what not to do

**Status:** standing constraint

Friends are running desktop 0.9.3 and Android as their real VPN for
about a week from 2026-08-11. Outages must stay to seconds.

Rules out, on production nodes: blocking a protocol's port to test
failover (the established technique — it drops real users), restarting
engines, changing routes or protocol configs.

Fine: client-side changes, and shipping releases. The updater restart
costs a few seconds and is within budget.

---

## 2026-08-11 — Blocked on the user, not on code

**Status:** blocked

- **Windows code signing (#91): account created, identity validation
  submitted 2026-08-11, status In Progress.** Azure Artifact Signing,
  Basic tier (~$10/mo), account `neoxify-signing` in resource group
  `neoxify-signing`, **region West US 2**. Endpoint read off the account
  overview rather than guessed: **`https://wus2.codesigning.azure.net/`**
  — that is the `AZURE_SIGNING_ENDPOINT` value, and it is region-specific,
  so the East US one would fail. Validating as an **individual**, so the
  publisher shown to customers will be a personal legal name until the
  company exists.

  **Status 2026-08-11: Action Required, not failed.** The Azure record is
  complete and stored; what is outstanding is the ID check at
  credentials.microsoft.com, which returns "No access" — its anti-VPN /
  anti-VM classifier rejecting a connection that is demonstrably clean
  (no tunnel adapters, no engines running, ordinary US residential IP,
  confirmed by checking rather than assuming). Resume via the "complete
  your verification" link on the validation panel; **do not create a
  second identity validation**, the existing one is fine. If it keeps
  refusing, the documented path is to wait 24h then contact support with
  the transaction ID.

  Two Azure gotchas worth not rediscovering: the subscription had to be
  upgraded from free credit to Pay-As-You-Go first (Artifact Signing
  refuses free/trial/sponsored, and the Upgrade button lives on the
  *billing account* Summary tab, not the subscription blade); and
  creating an identity validation needs the **Artifact Signing Identity
  Verifier** role assigned explicitly — subscription Owner is not
  enough. That is a *different* role from the **Certificate Profile
  Signer** one the CI principal needs later.

  Certum OV + SimplySign remains the fallback if Azure ever sours; no
  free option exists for anything Windows actually trusts.
- **Microsoft Store (#94):** viable as an **EXE** product (not MSIX —
  MSIX cannot carry the drivers). Hard-blocked on signing above.
- **Apple organization enrolment:** App Store guideline 5.4 means an
  individual account cannot publish a VPN app. Company is planned, does
  not exist yet. Build iOS to be shippable the day it completes; do not
  commit to a submission date.
- **Play App Signing:** account exists. At first upload, hand Google the
  existing `apps/mobile/.signing/neoxify-release.jks` rather than
  letting it generate a key — otherwise Play builds and sideloaded APKs
  are different identities and users must uninstall to switch. Roughly
  one-way once set.

---

<<<<<<< HEAD
## 2026-08-23 — Mobile Rust is now pinned, and the pin is shared

**Status:** decided — **Mac: this changes your build, nothing else**

Two files under `apps/mobile/src-tauri` now affect iOS as well as
Android. Both were needed to fix a 15 MB size regression in the direct
APK (detail in `windows.md`); neither changes any interface.

**1. New `apps/mobile/src-tauri/rust-toolchain.toml`, channel
`1.97.1`.** It is next to the crate rather than at the repo root so the
desktop client keeps its own compiler. But cargo honours it from
whichever machine runs in that directory, so **the iOS build now
compiles on 1.97.1 instead of whatever `stable` was that day.**

`aarch64-apple-ios-sim` is listed in its `targets` deliberately —
without it the pin would have installed a compiler with no iOS target
and broken `ci-ios.yml`. rustup installs everything named there on first
use, so nothing should need changing on your side.

**Adding a target is additive; do it freely** — `aarch64-apple-ios` when
there is a Network Extension to build. **Changing `channel` is not** —
that moves both platforms at once, so agree it here first.

**2. `[profile.release]` added to `apps/mobile/src-tauri/Cargo.toml`**
(`strip = "symbols"`, `lto = true`, `codegen-units = 1`,
`opt-level = "s"`). There was none, so both platforms were on stock
cargo defaults. No signatures, no dependencies, no features touched.

Two consequences for iOS specifically:

- **`strip = "symbols"` will strip your binary too.** Measured on
  Android, this is 12.5 MB of symbol table. If iOS crash symbolication
  needs those, say so here and it can be narrowed to a
  target-conditional rather than reverted.
- **It may help the extension memory spike.** `docs/journal/macos.md`
  flags the ~50 MB Network Extension cap as the thing that could change
  the architecture. `lto` + `codegen-units = 1` + `opt-level = "s"`
  shrink the Rust core; that is on-disk size, not necessarily resident
  memory, so treat it as possibly-helpful, not as a fix. The xray
  geo-file hypothesis in your entry is still the one to test.

`panic = "abort"` was considered and rejected — Tauri uses
`catch_unwind`, and killing the process on a recoverable panic is a bad
trade in the app whose job is honest connection state.

None of this is verified by a build. Android cannot be built on the
Windows machine and iOS cannot be built there at all; the next run of
each workflow is what confirms it.
=======
## 2026-08-23 — Two new shared client modules, and one line added to mobile's connect path

**Status:** landed on `claude/config-refresh-and-inbound-tag` (Windows),
unpushed — **Mac read this before the next iOS build of the shared UI**

Windows added a pre-connect config refresh. It is additive, but it lives
in `apps/desktop-windows/src/lib/`, which mobile aliases as `@shared`, so
iOS compiles it too.

**New files (nothing renamed, nothing re-signatured):**

- `@shared/lib/connection-config.ts` — `refreshConnectionConfig()`,
  `describeConfigDrift()`.
- `@shared/lib/resume.ts` — `useRefreshOnResume()`, a hook over
  `visibilitychange` / `focus` / `online`.
- `@shared/lib/credential-cache.ts` gained `SNAPSHOT_TTL_MS`,
  `isSnapshotStale()` and `updateSnapshotProtocolUsers()`. Existing
  exports are unchanged; `loadSnapshot()` still returns a snapshot of any
  age, which is deliberate and load-bearing.

**In `apps/mobile/src/screens/Dashboard.tsx`** (the shared file): a
`useRefreshOnResume` call and, at the top of `runLadder`, a
`refreshConnectionConfig` call whose result feeds the candidate list.
Roughly fifteen lines, no signature moved.

**Why iOS should care rather than just merging it.** The whole point of
the resume hook is the case where a mobile OS keeps the WebView alive
across backgrounding while the tunnel keeps running — which is Android
today and will be iOS the moment a Network Extension exists. The three
DOM events it listens on are the portable way to notice a resume from
inside a WebView, but **this has been verified on neither platform's
hardware.** If the iOS WebView turns out not to raise `visibilitychange`
around suspension, that is a real gap for iOS and the fix belongs in
`resume.ts` as an added listener, not as a per-platform fork of the hook.

Nothing here touches `plugins/vpn/src/*.rs`, the plugin command surface,
or the mobile version.
>>>>>>> origin/main
