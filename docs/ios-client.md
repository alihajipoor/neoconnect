# M24 — the iOS client

Design notes, written 2026-08-11, before any Swift exists.

This lives in the repo rather than in a planning file on one machine
because the work moves to a MacBook: iOS cannot be built from the
Windows box the rest of this was written on, and a session starting on
the Mac needs the reasoning, not just the code.

## Shape

An additional target of the existing `apps/mobile` Tauri v2 project, not
a new app. The React UI, i18n, API client, credential cache and the
failover ladder are shared TypeScript and already work. The new native
work is a Swift Network Extension standing in for the Android Kotlin
plugin.

`apps/mobile/plugins/vpn` currently has an `android/` implementation
(`NeoxifyVpnPlugin.kt`, `NeoxifyTunService.kt`, `Ikev2Engine.kt`) plus a
Go core built into an AAR. A Tauri plugin can carry an `ios/` Swift
package beside it, so the plugin boundary is already the right seam.

## The method surface to reimplement

Taken from the Kotlin plugin, which is the contract the shared UI
already calls:

| Android | iOS |
|---|---|
| `hasPermission` / `requestPermission` (`VpnService.prepare`) | `NETunnelProviderManager` profile install — one-time user consent |
| `connectWireguard` | WireGuardKit inside `NEPacketTunnelProvider` |
| `connectXray` | Go core inside the extension — the hard part, below |
| `disconnect` / `status` | `NEVPNConnection.status` |
| `listApps` | **no counterpart — see the gap below** |

**IKEv2 is nearly free here.** iOS speaks it natively via
`NEVPNProtocolIKEv2`, with no packet-tunnel extension and no bundled
engine. On Windows it cost a whole session and a `#[repr(C, packed(4))]`
struct-layout bug; on iOS it is a configuration object. Good first
protocol to land, precisely because it proves the profile-install and
status plumbing without the memory risk.

## The risk that could change the architecture

**iOS Network Extensions are memory-capped at roughly 50 MB**, and there
are credible reports of lower effective limits on some devices. Apple's
own guidance is to test rather than hard-code the figure. xray-core has
a known open issue about exactly this limit, largely from loading geo
files.

This product never needs geo routing. Every route is a full tunnel to
one chosen server, and routing decisions are made by the ladder in
TypeScript, not by the engine. **So the first hypothesis is a trimmed
xray build with geosite/geoip stripped**, with sing-box as the fallback
candidate if that is not enough.

**Prove this on a real device before building anything on top of it.**
It is the one finding that could invalidate the approach, and it follows
the precedent set by M9 (relay chaining, spiked against real xray
processes) and M18 (split tunnel, where three plausible designs died in
sequence against real packet captures). Do not build the UI first and
discover the ceiling last.

Per the standing rule that platform gaps are gaps rather than decisions,
the Xray-family protocols are not optional on iOS. If the trimmed build
does not fit, the answer is a different engine, not a shorter protocol
list.

## Confirmed platform gap: no per-app split tunnel

`listApps` has no iOS equivalent. Per-app VPN exists only for
MDM-managed apps, not consumer App Store apps. Custom mode therefore
cannot exist on iOS, and the UI must not offer it there.

State it plainly to customers rather than hiding it — same standard the
connection-state work was held to. A feature that silently does nothing
is worse than one that is absent.

## What the simulator can and cannot tell you

It runs the UI and it compiles every Swift file, extension included.
**It does not run `NEPacketTunnelProvider`**, so it can never establish
that a tunnel works, and it certainly cannot answer the memory question.

`.github/workflows/ci-ios.yml` builds the simulator target on every
push. Green there means *it compiles* — nothing more, and it should
never be quoted as more. Device claims need a device.

## Publishing gate

**App Store Review Guideline 5.4: VPN apps "may only be offered by
developers enrolled as an organization."** An individual Apple Developer
account cannot publish one. The company is planned but does not exist
yet, so build to be shippable the day enrolment completes and do not
commit to a submission date. Development and TestFlight-on-device work
are unaffected.

There is no in-app auto-update on iOS, by platform rule; the App Store
is the update mechanism. That was always the recorded exception.

## Suggested order

1. Build loop first — done, `ci-ios.yml` is green against Xcode 26.6 and
   produces `Neoxify.app` for the simulator. No VPN code in it yet.
2. The memory spike, on a real iPhone.
3. IKEv2, then WireGuard — the two known-tractable protocols.
4. The Xray family, per whatever step 2 concludes.
5. TestFlight once the company exists.
