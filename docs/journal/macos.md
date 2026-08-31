# MacBook — iOS

> **ARCHIVE.** The two-machine split ended 2026-08-30; nothing is
> appended here any more. The current log is `log.md`. The iOS starting
> state below still stands — no iOS work has been done since it was
> written.

Written by the Mac session, 2026-08-11.

---

## 2026-08-11 — Starting state, written from the Windows side

**Status:** handoff

Nothing has been done on the Mac yet. This entry exists so the first
session there does not start blind; replace it with real entries as work
lands.

**Read first:** `docs/ios-client.md` (the M24 design and the reasoning
behind it), then `CLAUDE.md` (ownership boundaries and how work is
verified in this repo).

**Where things stand:**

- `.github/workflows/ci-ios.yml` is green — Xcode 26.6, iPhoneSimulator
  26.5 SDK, builds target `mobile_iOS` into `Neoxify.app`. It compiles
  the shared React UI and the Tauri Rust core for iOS. **No VPN code
  exists yet.**
- The Xcode project is regenerated on every CI run and **not**
  committed. The moment a Network Extension target is added it must be
  committed instead — generated on the Mac — or every run throws it
  away. Flip the generate step to a guard at the same time.
- `apps/mobile` is **yours for now.** The Windows side is holding the
  Android flavor work specifically to keep out of your way. If that
  changes it will be announced in `shared.md` first.

**Do first, before building anything on top of it:** the extension
memory spike. Network Extensions are capped around 50 MB — lower in
practice on some devices — and xray-core has a known open issue about
exactly this, largely from geo-file loading. This product never needs
geo routing (the failover ladder decides routes in TypeScript, and every
route is a full tunnel to one server), so the first hypothesis is a
trimmed xray build with geosite/geoip stripped; sing-box is the fallback
candidate.

It needs a real iPhone. It is the one result that could change the
architecture, and this repo has a long history of designs that read
correctly and failed against real execution — relay chaining, and three
successive split-tunnel designs that died against packet captures.

**Then:** IKEv2 (nearly free via native `NEVPNProtocolIKEv2`, and it
proves the profile-install and status plumbing without the memory risk),
then WireGuard, then the Xray family per what the spike concludes.

**Two things not to get wrong by omission:**

- There is **no per-app split tunnel on iOS** — per-app VPN is MDM-only.
  Custom mode must be absent from the iOS UI, not present and inert.
- A green CI run means *it compiles*. The simulator cannot run
  `NEPacketTunnelProvider`. Never describe a tunnel as working on
  simulator evidence.

**Blocked, but not on you:** publishing needs an Apple *organization*
enrolment (guideline 5.4 — individual accounts cannot ship VPN apps).
The company is planned but does not exist yet. Development and
on-device testing are unaffected; just don't plan a submission date.
