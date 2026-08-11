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

**Status:** in flight — sequencing decision

Task #92 (splitting Android into Play and direct-APK flavors) is
**deliberately not started**, because it is the one Windows-side task
that collides hard with iOS in `apps/mobile`.

Windows is doing only zero-overlap work meanwhile: code signing (#91),
desktop picker fixes (#90), backend.

**Mac: you have `apps/mobile` to yourself for now.** If that changes,
this entry gets updated first.

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

- **Windows code signing (#91):** needs an Azure Artifact Signing
  account (~$10/mo; open to US/Canada individuals, no company needed) or
  Certum OV + SimplySign as the cheaper alternative. No free option
  exists for anything Windows actually trusts. User is comparing prices.
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
