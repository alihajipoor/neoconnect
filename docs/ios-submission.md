# Submitting the iOS app

What the code now does, and what only a person with the Apple account
can do. Written because the build being correct is about a third of the
work, and the rest is spread across two Apple websites.

## What is already handled in the repo

- **No in-app selling.** `pnpm ios:build` forces `VITE_DISTRIBUTION=store`
  and then asserts the built bundle contains no checkout call and no
  voucher redemption. Guideline 3.1.1. The store build also does not
  *point* at where to buy, which the same guideline forbids separately.
- **Privacy manifests** for the app and the extension, matching the
  disclosure screen and the required-reason APIs each binary actually
  calls.
- **Entitlements**: packet-tunnel provider, personal VPN, and the app
  group, on both the app and the extension.
- **Account deletion** in Settings, reachable without a subscription.
  Guideline 5.1.1(v).
- **Data disclosure before use.** The "Before you connect" screen gates
  the whole app, including an already-signed-in session. Guideline 5.4
  requires this "prior to any user action to purchase or otherwise use
  the service".
- Extension version tracks the app version, which App Store Connect
  rejects a mismatch on.

## What only you can do

### 1. Test on a real iPhone. This is the gate.

Nothing here has carried a packet. Network Extensions do not run in the
simulator and `NEVPNManager` cannot dial from one, so all three
protocols are unproven. The extension also has a memory ceiling around
50MB, lower on some devices, and the Xray engine is the thing most
likely to exceed it.

Do not submit before a device has connected on each of Xray, WireGuard
and IKEv2 and carried real traffic.

### 2. Developer portal

Two App IDs, because the extension is its own bundle:

| Bundle ID | Capabilities |
|---|---|
| `com.neoxify.mobile` | Network Extensions, Personal VPN, App Groups |
| `com.neoxify.mobile.tunnel` | Network Extensions, App Groups |

The app group is `group.com.neoxify.mobile` and must exist on both. An
entitlement the provisioning profile does not grant is a **signing**
failure, not a runtime one, so a missing capability here shows up as an
unhelpful profile error.

Then set the team so the build can sign:

```bash
export APPLE_DEVELOPMENT_TEAM=<your team id>
```

or put it in `tauri.conf.json` under `bundle > iOS > developmentTeam`.

### 3. Export compliance

App Store Connect will ask, because `ITSAppUsesNonExemptEncryption` is
deliberately not set in the Info.plist. That is on purpose: a VPN
plainly uses encryption, so answering "no" would be untrue, and
answering "yes" in the plist commits you to a self-classification
filing. It is a legal decision, not a build setting, so it is left for
you to answer per upload — or to pin once you have taken advice.

### 4. App Store Connect metadata

- **Privacy labels** must agree with `ios/privacy/app/PrivacyInfo.xcprivacy`:
  email address, user ID, customer support and other diagnostic data;
  all linked to the user, none used for tracking.
- **Privacy policy URL** — `neoxify.net/privacy`. Note the policy still
  has placeholders to fill (invoice retention period and the registered
  address, in both locales) and the Farsi page still needs updating.
- **Demo account.** Guideline 2.1 requires one for anything behind a
  login, and review will reject without it. It needs an active
  subscription, or the reviewer sees the "no plan" screen and cannot
  test the thing the app is for.
- **Review notes.** Worth stating plainly: this is a VPN from an
  organization account, the app discloses what it collects before any
  use, and nothing is sold inside the app because the service is
  purchased on the web.

### 5. Expect a 5.4 question

VPN apps get scrutinised. The reviewer may ask what the app does with
user traffic and what the servers log. The answers are in the privacy
policy and the disclosure screen, and they should not diverge from
either.
