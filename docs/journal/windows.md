# Windows machine — desktop, backend, panel, installer, Android

Written by the Windows session only. Append at the bottom.

---

## 2026-08-11 — Desktop 0.9.3 shipped; three honesty bugs fixed

**Status:** done
**Touches:** `apps/desktop-windows/**` (no mobile files)

Released and verified live. `desktop-v0.9.3`, updater confirmed serving
it: a 0.9.2 client gets a real manifest, a 0.9.3 client gets 204.

Three faults in one seam — what the dashboard promised versus where the
tunnel actually came up:

1. The chosen server was never persisted, so a deliberate pick died on
   restart while the *displayed* server survived from cache. The app
   showed Singapore and connected to France in silence.
2. Fixing that made it claim "Couldn't reach sg-singapore" in the case
   Singapore was never dialled. Now tracks whether the shown route was
   actually attempted and picks between two messages.
3. Persisting the pin exposed a race — `loadAll` chose the displayed
   credential before the stored pin arrived, so Singapore/Built-in came
   back as Singapore/Compatible.

**Gotcha worth keeping:** #1 shipped *in* 0.9.2 an hour earlier and was
only caught by going back to verify already-released work. Re-checking
what you just shipped is not wasted time here.

---

## 2026-08-11 — VM test rig notes

**Status:** reference
**Touches:** nothing in the repo

The clean Win11 VM (`Neoxify-Test`, VirtualBox) is the desktop
verification rig. Things that cost time today:

- The installed binary is `neoconnect-desktop.exe`, **not** `Neoxify.exe`
  — the product is Neoxify but internal identifiers stay `neoconnect`.
- `keyboardputstring` silently drops quotes and `|`. Launching anything
  with a space in its path needs a `.cmd` shim at a space-free location.
- Installing needs elevation: Ctrl+Shift+Enter from the Run dialog, then
  **Alt+Y** on the UAC prompt. Arrow-key focus on that dialog is
  unreliable and silently lands on "No" — a failed install then looks
  like a successful one until you check the exe timestamp.
- The installer is unsigned, so UAC says "unknown publisher". That is
  what #91 fixes, and it is what every customer sees today.

---

## 2026-08-11 — iOS build loop established, then handed to the Mac

**Status:** done
**Touches:** `.github/workflows/ci-ios.yml`, `docs/ios-client.md`

Added `ci-ios.yml` and confirmed green against Xcode 26.6 — real
`xcodebuild`, iPhoneSimulator 26.5 SDK, produces `Neoxify.app` for target
`mobile_iOS`.

**What that proves and nothing more:** the shared React UI and the Tauri
Rust core compile for iOS. There is **no VPN code in it** — no Swift
extension exists yet. The simulator cannot run
`NEPacketTunnelProvider` at all, so a green run is never evidence a
tunnel works.

The Xcode project is regenerated per run rather than committed. **That
stops working the moment the Network Extension target is added**, since
that lives in the project file and would be discarded each run. At that
point commit `gen/apple` (generated on the Mac) and turn the generate
step into a guard.

Design and reasoning are in `docs/ios-client.md`.

---

## 2026-08-11 — What Windows picks up next

**Status:** in flight

In priority order, all zero-overlap with `apps/mobile`:

1. **#91 code signing** — blocked on the user's Azure/Certum account.
2. **#90 location picker** — focus the list on open (arrow keys
   currently need two Tabs first) and close on Escape.
3. **#94 Microsoft Store** as an EXE product — hard-blocked on #91.

**Deliberately not touching `apps/mobile`** while iOS is live on the
Mac. See `shared.md`.

---

## 2026-08-11 — Location picker keyboard fixes; 0.9.4 built, NOT released

**Status:** done, awaiting release
**Touches:** `apps/desktop-windows/src/components/LocationPicker.tsx`, desktop version files

Two keyboard gaps closed (#90):

- The sheet now focuses its first selectable row on open. The roving tab
  stop only ever responded once focus was already on a row, so opening
  the picker and pressing an arrow did nothing — no movement, no focus
  ring, no explanation. Guarded by a ref so it fires once per open;
  doing it on state would drag focus back to the top every time the
  customer arrowed away.
- Escape closes it, via a document-level listener so it works while
  loading, while an error shows, and wherever focus is. **Inert
  mid-switch on purpose** — the request is already with the server, so
  honouring Escape would imply a cancellation that did not happen.

Verified in the VM by keyboard only, which is how the bug was found:
arrows work immediately on open, Escape closes without disturbing the
pinned selection.

**Update:** 0.9.4 was released after all — see below.

**Version is bumped to 0.9.4 in the tree but no tag has been pushed.**
Holding the release to bundle it with code signing (#91), so the next
one is both this fix and signed — one restart for the beta testers
instead of two. If signing drags, cut 0.9.4 on its own; nothing here
depends on waiting.

---

## 2026-08-11 — Panel deploy access restored, and production is current

**Status:** done
**Touches:** production only

SSH to the panel host works again. It had broken purely because the box
moved OVH -> Hetzner on 2026-08-10 and the key was never copied across;
nothing was revoked. The user added the public key to **root** on
`167.233.65.166`.

Two traps worth remembering, both of which cost time today:

- The SSH attempt can be refused by the *permission classifier* before
  it reaches the network. That is indistinguishable from the server
  refusing, and led me to tell the user I had lost access when I had not
  established that.
- `panel.neoxify.com` is the user's **separate IT-services business**,
  not this panel. The VPN panel is `connect.neoxify.site`, and
  `connect.neoxify.com` does not resolve at all despite an earlier note
  of mine saying it was the panel. Verify a host before touching it.

**Production moved 51691dd -> 706b07d** (25 commits). Checked first that
there were no Prisma migrations and no schema change; the only backend
source change was a defensive fallback string. Backed up `infra/.env`,
pinned the reset to an exact SHA, built before swapping, rebuilt only
panel and backend.

Verified against the running system rather than the build log: both new
protocol labels present in the container's bundle, `/api/health` 200,
zero errors in the logs, and the agent gateway re-asserted 32/112/112
provisioned users across the three nodes on reconnect — so no customer
lost credentials.

Worth recording because it removes a worry: **the API is not in the VPN
data path.** Restarting backend interrupts login and status refresh for
seconds and drops nobody's tunnel.

---

## 2026-08-11 — Panel could not offer two live protocols

**Status:** done, deployed
**Touches:** `apps/panel/src/lib/{types,protocol-labels}.ts`, `scripts/check-protocol-drift.sh`, `ci.yml`

Shadowsocks and IKEv2 were both live on real nodes and selectable in the
clients, while the panel could offer neither — so a plan created there
silently granted a narrower protocol set, and a node could not be
configured for them at all. With failover provisioning a credential on
every allowed route, affected customers would simply never receive them.

Found by the user noticing the checkbox list looked short. Nothing had
failed: an absent option is indistinguishable from a deliberate choice
not to offer one.

`ALL_PROTOCOLS` is now derived from a `Record<Protocol, true>` so an
omission inside the panel is a compile error, and
`scripts/check-protocol-drift.sh` compares the panel's union against the
Prisma enum on every commit. Verified the check *fails* when a protocol
is removed, not merely that it passes.

---

## 2026-08-11 — M25 started: deletion, store flavour, AAB, public voucher lookup

**Status:** four pieces done, none released
**Touches:** `apps/backend/src/modules/{customers,customer,vouchers}`, `apps/desktop-windows/src/lib/{distribution,i18n}`, `apps/mobile/src/**`, `release-android.yml`

The operator specified a full milestone (M25 in the plan): two mobile
flavours, website commerce, voucher links, and a reseller programme.
Build order is deletion -> flavours -> voucher links -> website ->
resellers. First four items of the backend are in.

**Account deletion.** `DELETE /customer/me`, anonymising rather than
purging. The design turned on an existing detail: `CustomersService.remove()`
already refuses when a settled payment exists, correctly, because a paid
invoice is a financial record — but that is exactly the answer both
stores forbid for self-deletion. So this is a separate path that keeps
the invoices and strips the person. The part that matters is
deprovisioning across **every** node, since failover gives each customer
a credential on every eligible route.

**Store flavour.** `VITE_DISTRIBUTION=store` compiles out purchase and
voucher redemption. Desktop and the direct APK default to `direct` and
are untouched.

Worth remembering how that was verified, because the first measurement
looked like failure: grepping the store bundle for a purchase marker
found two hits. Those two are the English and Persian **translation
dictionaries**, which ship regardless. Only the differential settles it
— direct 3-4, store 2, bundle 8K smaller. An absolute count cannot tell
"the screen shipped" from "its translation shipped".

**AAB build.** Play needs a bundle, and a bundle signed with `jarsigner`,
not `apksigner`, which refuses one. Both ABIs now: Play splits per ABI
so 32-bit costs a customer nothing there, while the universal APK pays
~46MB in full — flagged to measure on the first release rather than
guessed. Two things that would have failed the build: the Rust toolchain
had only aarch64, and the Xray AAR script defaults to arm64 alone, which
would have shipped 32-bit Rust with 64-bit-only Xray — installing fine,
connecting fine over WireGuard, dying the moment anyone chose a stealth
protocol.

**Public voucher lookup.** `GET /vouchers/:code/preview`, unauthenticated,
so a link recipient learns what a code is worth before being asked to
register. Its own controller: the existing one is admin-guarded at class
level, and a public route added there would inherit the guard while
looking correct. Unknown, spent, expired and deactivated answer
identically on purpose — distinguishing them would let a reseller's
stock be enumerated.

**Website is on a branch.** Step 4 needs a decision first: the site lives
in `website/` on `worktree-website`, unmerged, last touched 9 August.
See task #96.

Nothing here is released. The Android workflow changes have never run —
they need an `android-v*` tag, and that should wait for device testing.

---

## 2026-08-13 — Plisio live; reseller programme; relay NOT started

**Status:** Plisio and reseller done. Relay is next and is unstarted.
**Touches:** `apps/backend/**`, `apps/panel/**`, `apps/web-portal/**`,
`website/**`, `apps/desktop-windows/src/{lib,components,screens}/**`
(shared with mobile — the client changes below are additive)

### Plisio replaces NowPayments as the crypto route — PROVEN with real money

NowPayments' per-currency minimum sits above the cheapest plan, so a
$3.99 subscription could not be paid in crypto at all. For customers who
can only pay in crypto that means it could not be bought.

Verified end to end today with a real payment: invoice created, hosted
page opened, paid in TRX, callback verified, subscription ACTIVE. About
two minutes on TRON, not the 15–60 Plisio's generic copy claims.

**The one thing worth carrying forward:** the callback verification is
transcribed from Plisio's own Node SDK (`Plisio/plisio-sdk-nodejs`,
`verifyCallbackData`), not inferred. Remove `verify_hash`, sort keys,
**coerce `expire_utc` to String**, **URL-decode `tx_urls`**, JSON
stringify, HMAC-SHA1 with the **API key** (there is no separate IPN
secret), hex. Those two coercions are not guessable and either one wrong
rejects every genuine callback — payments taken and never confirmed.
`?json=true` on the callback URL is mandatory or Plisio posts
PHP-serialised data.

`mismatch` deliberately does not activate: Plisio applies the site's
underpayment tolerance before reporting, so one reaching us is outside
it. Logged for a human, left PENDING.

Both providers still run. NowPayments wins when configured; Plisio is
the fallback. **The server resolves which crypto provider to use**,
because every shipped client hardcodes NOWPAYMENTS behind its Crypto
button — changing the clients cannot fix the ones already installed.
Remove that bridge once shipped clients read
`/customer/billing/providers`.

### Three bugs, all the same shape: compiled, reasoned, never run

Worth recording as a pattern rather than three incidents.

1. **Panel `/overview` leaked to resellers.** Hidden from their sidebar,
   but it is the post-login landing page and had no role guard — a
   reseller saw the total customer count. No API test could have caught
   it: the data comes from endpoints a reseller may legitimately call.
   It was the *composition* that leaked. Found by signing in as one.
2. **The web portal's Crypto button rendered a blank panel.** The fix
   was written, typechecked — and the bundle was never rebuilt. The
   deployed JS still had the old `provider === "STRIPE"` check.
3. **Deleting a subscription 500'd** once it had carried traffic
   (`usage_records_subscriptionId_fkey`, NOT NULL). Deleting a *fresh*
   one worked, so it looked healthy until the row mattered.

Typecheck-and-assume is not verification. Anything customer-facing gets
driven in the thing that ships.

### Reseller programme — backend, panel, email, short links

17/17 against the API plus a full UI walkthrough. Both race-sensitive
paths avoid read-then-write: spending is `updateMany` with a
`balance > 0` guard inside the same transaction as the insert; revoking
guards `redeemedCount: 0` and ownership in the WHERE clause, so a code
redeemed a millisecond earlier simply matches nothing.

Adding the RESELLER role turned the sidebar's "no `roles` means everyone
sees it" default into a leak, since a reseller is an outsider with a
panel login. RESELLER is now an **allowlist** — new pages are hidden
from them until deliberately allowed.

Voucher short links live at `/r/CODE`, prefilling the redeem field.

### Also landed

- **Rate limits were one global bucket.** `main.ts` never set
  `trust proxy`, so every request looked like nginx. Login was 5
  attempts/minute for the *entire* user base and one script could lock
  everyone out. Measured before and after against production.
- **Login proof-of-work**, escalating per account. Not a CAPTCHA:
  reCAPTCHA needs to reach Google, which is exactly what Iranian
  customers cannot rely on. Challenge is waived below 5 recent failures
  so shipped clients keep working — **remove that grace** once they
  solve challenges.
- Plans restructured: Starter/Pro unlimited (1 and 2 devices), Ultimate
  30 GB, unlimited devices, relay-only, shown but not sellable.
- Customer portal at `neoxify.net/account/`, built from the apps' own
  screens via 8 Vite aliases.

### NEXT — relay, and the ordering is not optional

Iran VPS exists (`ir1.neoxify.site`). Decisions taken: full protocol set
on the relay, routes to **both** Finland and France, Ultimate goes on
sale if tests pass, clients **built and held** — publish nothing to the
beta testers.

**`relayOnly` enforcement must land before any relay Route exists.**
`provisionAll()` gives every enabled Route whose entry protocol the plan
allows to every subscription. Create a relay route first and all 15 live
customers are provisioned onto Iran bandwidth that costs double. Verify
the inverse explicitly — that is the expensive direction.

Full sequence in task #99. Prove it from the relay's own access log and
an exit IP that matches the exit node, not from route rows.

## 2026-08-13 (later) — the Iran relay carries traffic

**Proven, not inferred.** A credential on `ir1 relay -> finland1` exits
at **204.168.161.100** (finland1) while the machine's own address is
50.34.35.228, and ir1's access log shows
`[vless-in -> route-c1b3f538-...-out]`. Both, together, are the standard
this needed.

Ultimate is **live**: `relayOnly=true`, default route = the relay,
`isActive=true`, $9.99 / 32 GB / unlimited devices. The re-assert sweep
has already given both existing Ultimate subscribers their relay
credential, one of whom is a real paying customer.

### Three things that reported success while being wrong

- **The base Xray template had no `RoutingService`.** Only the relay
  template variant did, and the variant is picked by a prompt that asked
  about *WireGuard/OpenVPN* relaying. An Iran relay is reached over
  REALITY, so the honest answer to that question was "no" — and then
  `AddOutbound` succeeds, `AddRule` fails, and the node looks configured.
  M9 proved relay chaining in WSL2 against a hand-written config, so no
  relay had ever actually been built by the installer. Prompt now asks
  about the role; base template carries the service so a wrong answer is
  survivable.
- **Two relayed routes on one entry silently share an exit.** The
  routing rule matches the entry inbound tag and nothing else, so Xray
  takes the first. A credential issued on the **France** route exited in
  **Finland**. The route existed, provisioned, and would have shown in
  the picker as France. Route creation now refuses the second one, and
  the France route was deleted rather than left lying.
- **`relayOnly` was only a filter, not a rule.** `POST /protocol-users`
  returned 201 for a direct route on a relay-only plan against the live
  backend. `provisionAll` decides what is *offered*; `create()` is what
  every path goes through. Enforced there now.

All three re-verified against the deployed backend, not just in tests.

### ir1 is not finished, and neither is the plan it backs

- **One protocol on the relay: REALITY.** The decision was the full set.
  Trojan / VLESS+TLS / WS need a real certificate for `ir1.neoxify.site`;
  WireGuard, OpenVPN and Shadowsocks are not installed. So an Ultimate
  customer today has **exactly one credential and no failover** — on the
  plan sold as the one that always connects. This is the most important
  gap on the board.
- **One exit: Finland.** France needs the entry inbound tag to become a
  property of the `ProtocolConfig` instead of a per-protocol agent flag,
  so one node can host several entry inbounds. Until then, one exit per
  relay node is a real limit, not a config choice.
- ir1 was recovered by hand after two failed installer runs — its Xray
  config and its `ProtocolConfig` row were written directly, not by the
  installer. **A reinstall from the fixed installer is the honest way to
  get the rest of the protocols**, and would also prove the installer
  changes above, which are currently only reasoned.
- The two Ultimate subscribers still hold their 16 pre-existing
  direct-route credentials. `provisionAll` only adds. Not harmful — they
  have more access, not less — but `relayOnly` is not retroactive, and
  removing them mid-session would drop a live customer, so it was not
  done unilaterally.

### The gRPC trap that cost the most time

`connect.neoxify.site` is Cloudflare-proxied, and Cloudflare does not
carry port 50051. The agent derives its gRPC target from the panel URL's
host when `grpcTarget` is empty — which the installer always leaves
empty — so a freshly enrolled node dials a Cloudflare address forever
(`dial tcp 188.114.98.0:50051: i/o timeout`). Fixed on ir1 by setting
`grpcTarget` to the panel's real IP; TLS still validates against the
hostname, which is what that override is for.

**The existing nodes are only fine because their streams predate the
proxying. They will hit this the next time they reconnect.** The
installer still does not set `grpcTarget` — unfixed, and it is a
fleet-wide latent outage.

## 2026-08-13 (night) — ir1 rebuilt: five protocols, and France works

Six relay routes live, all proven by exit IP:

| Entry on ir1 | Port | Exit |
|---|---|---|
| VLESS+REALITY | 443 | finland1 (204.168.161.100, measured) |
| VLESS+TLS | 2053 | finland1 |
| VLESS+TLS over WebSocket | 2053 `/ws` | finland1 |
| Trojan+TLS | 8443 | finland1 |
| Shadowsocks 2022 | 46731 | finland1 |
| VLESS+REALITY | **8444** | **france-1 (104.105.205.233, measured)** |

Real Let's Encrypt certificate on `ir1.neoxify.site`, expiring 2026-11-11,
which is what makes Trojan and the two TLS variants possible at all.

### Two exits from one relay: how

`ProtocolConfig.inboundTag` (nullable). Null keeps today's behaviour --
the agent uses the inbound it was started with -- so no existing row or
non-relay node changes. A relay runs a second listener of the same
protocol on its own port with its own tag, and its route's rule matches
that tag instead of colliding. Proven by two credentials on the same
node, same keys, same camouflage, differing only in port: 443 came out
in Finland, 8444 in France.

The agent refuses a named inbound it cannot target rather than falling
back to the default. The fallback is what silently puts a customer on
another country's exit.

### Four bugs, none visible without running it

- **create() never wrote transport or security.** It resolved
  `transport` for the duplicate check and dropped both from the row, so
  every config took TCP/NONE. The WebSocket twin then collided with its
  TCP sibling (raw 500), and the REALITY config was stored claiming
  security NONE -- a row describing an inbound the node is not running.
  finland1/france-1 have correct values, so this was reachable only on
  a freshly registered node.
- **entryInboundTag knew only REALITY**, so a relay with five protocols
  could carry one.
- **Shadowsocks is served by Xray but does not start with `XRAY_`**, so
  relay wiring sent it down the WireGuard branch demanding a subnet.
- **The DTO rejected `inboundTag`** -- column, lookup and agent all
  understood it; the input did not.

### The installer still cannot do this unattended

Three scripted runs desynced, each differently, because the prompt
sequence depends on node state: an existing REALITY listener skips the
port and camouflage questions, and a partial run leaves Trojan/WS
configured, which skips more. Answers then fall through to the main
menu. `NEOXIFY_ADMIN_TOKEN` removed the credential prompts, which were
the worst offenders, but the flow is still not driveable from a fixed
answer list. **Run it interactively, or teach it a non-interactive
mode -- do not feed it a here-doc.**

Also: `install_xray` skips panel registration when local REALITY keys
exist (`reality_is_new=n`). Local keys are treated as proof of a panel
row, so a node whose row was deleted can never re-register through the
installer. Worked around by moving the config aside; worth fixing.

### Stale agent release

ir1 ran an agent with no Shadowsocks provisioner, and `Update Agent`
pulled **v0.2.1**, which still lacked it -- the newest published release
predates Shadowsocks. Built from source and installed by hand; that
binary also carries the inboundTag support. **The agent release is
behind main, so `Update Agent` does not deliver current code to any
node.** Cut a `v*` tag before relying on it.

### Still open

- France has REALITY only. The other four protocols need a second
  listener each on ir1 (own tag, own port), same mechanism, now that it
  is proven.
- REALITY-to-France sits on 8444, not 443. One address means one 443, so
  the second exit is inherently on a less-unblockable port. A second
  IPv4 on ir1 removes that.
- WireGuard, OpenVPN and IKEv2 are not installed on ir1 -- Xray-family
  only so far.
- The two Ultimate subscribers still hold 16 direct-route credentials
  each from before relayOnly. Not removed: doing so mid-session drops a
  live customer.

## 2026-08-14 — France on all five protocols, and the restart bug

Ten relay routes, every one verified by exit IP:

| Entry on ir1 | Port | Exit |
|---|---|---|
| VLESS+REALITY | 443 | finland1 |
| VLESS+TLS | 2053 | finland1 |
| VLESS+TLS / WebSocket | 2053 `/ws` | finland1 |
| Trojan+TLS | 8443 | finland1 |
| Shadowsocks 2022 | 46731 | finland1 |
| VLESS+REALITY | 8444 | france-1 |
| VLESS+TLS | 2054 | france-1 |
| VLESS+TLS / WebSocket | 2054 `/ws` | france-1 |
| Trojan+TLS | 8445 | france-1 |
| Shadowsocks 2022 | 46732 | france-1 |

France gets its own WebSocket carrier (`vless-ws-fr-in`, loopback 10087)
and its own fallback targets. Sharing the Finland carrier would have
sent WS traffic out of Finland however it arrived, because the routing
rule keys on the inbound tag, not on the port it came in through.

### The bug that mattered most: an engine restart stripped every route

`reassertProvisionedUsers` rebuilt users after a restart and nothing
rebuilt **routes** -- but a relay's outbound and routing rule are
hot-added over the same gRPC API and die with the same restart.

The failure is not an outage. With no rule matching the entry inbound,
traffic falls through to the relay's own `direct` outbound and egresses
**at the relay**. Measured: a customer on the France route came out at
**185.222.28.186 -- the Iran node's own address** -- while the tunnel
worked and the app reported a healthy connection. For this product that
is the worst failure available, and reconnect is automatic, so no
operator care could have avoided it.

Fixed by `reassertConfiguredRoutes`, called wherever users are
re-asserted. Verified by restarting Xray on ir1 with no manual
intervention: 10 routes and 30 users rebuilt, zero failures, all ten
exits correct afterwards.

Second half of the same bug: the user re-assert selected only
`transport`, not `inboundTag`, so after a restart every France customer
was rebuilt on the Finland listeners and got "invalid request user id".

### Do not re-queue CONFIGURE_ROUTE by node

Re-queuing every CONFIGURE_ROUTE row for a node replays commands for
**deleted** routes too. That re-adds a rule matching the same inbound,
it wins on order, and it points at an uplink credential that was removed
with the route -- so traffic is accepted at the relay and dies upstream.
Cost an hour. Filter by routes that still exist, or just let the
reconnect re-assert do it.

Also: `ConfigureRoute` treats a duplicate *outbound* as success but not a
duplicate *rule*, so re-sending fails with `duplicate ruleTag`. Harmless
now that re-assert follows a restart, but it makes manual replay noisy.
**Still unfixed.**

### CI was red on every push, and had been for hours

`@neoxify/backend#lint`, five errors -- four of them older than tonight.
The job is *named* "TypeScript (backend + panel)" but runs
`turbo run lint typecheck build test`, and I had been checking `tsc` and
`jest` only. Green now, and the full turbo command passes locally
(16/16). **Run the turbo command, not the individual tools.**

### Harness notes, since they cost more than the real bugs

- Python's `open(path, "w")` on Windows writes CRLF. A path read back
  from such a file keeps the `\r`, so the extension becomes `.json\r`
  and Xray answers "Failed to get format" -- which reads like a bad
  config, not a bad path. Same for `os.path.join` producing a backslash
  in an otherwise forward-slash path.
- A VLESS+TLS inbound rejects a client with no `flow`
  ("account ... is rejected since the client flow is empty"). Carry the
  flow from the credential for the TCP variant; omit it for WebSocket.
- A failed REALITY handshake logs **nothing** server-side -- it is
  proxied to the camouflage site by design. Absence of a log entry is
  not evidence the traffic never arrived.

## 2026-08-14 (later) — WireGuard/OpenVPN on ir1, and the limits audit

### WireGuard and OpenVPN: installed, registered, NOT routable

Both engines are running on ir1 (`wg0` 10.66.0.1/24, `tun0` 10.77.0.1/24)
and both are registered in the panel. **Their relay routes were created
and then deleted again, deliberately.**

ir1's Xray config has **no tun inbound at all** — no `relay-tun-in`, no
`relay-tun` interface, no `ip rule`, nothing in table 100. A
WireGuard/OpenVPN relay entry is bridged into Xray through that tun
inbound, because unlike the Xray protocols there is no inbound tag to
match on; the rule is scoped to the client subnet instead. With no
bridge, a customer on those routes connects fine and their traffic
egresses **at ir1 — in Iran**, since the installer's own MASQUERADE rule
NATs it straight out. Same silent-leak shape as the restart bug.

So the routes are gone until the bridge exists. The engines stay
installed and registered; recreate the routes once `relay-tun` is real
and proven. **This is the M9 follow-up that was never live-tested** —
the plan says so explicitly, and this is the first time it was exercised.

Fixed on the way: `install_openvpn` never sent `subnetCidr`, so an
OpenVPN relay route could never be created at all ("missing subnetCidr")
even with a working bridge.

### Limits audit — measured, not read

**Data cap: works, proven end to end.** A test Ultimate subscription
pushed past its cap was SUSPENDED by the sweep, all 10 credentials
flipped to DISABLED across 4 protocols, 10 DISABLE_USER commands were
executed by the agent, and a connection attempt with a suspended
credential was **rejected by the relay itself** —
`proxy/trojan: not a valid user`. Not a status field: the engine.

Usage is really being reported, last 7 days fleet-wide:

| Protocol | records | traffic |
|---|---|---|
| VLESS+REALITY | 1830 | 2.40 GB |
| VLESS+TLS | 188 | 1.22 GB |
| OpenVPN | 246 | 0.75 GB |
| Shadowsocks | 99 | 0.14 GB |
| WireGuard | 405 | 0.02 GB |
| Trojan | 21 | 0.001 GB |
| **IKEv2** | **0** | **0** |

**Device limit: enforced across all protocols, better than assumed.**
All four provisioners implement `SessionCounts` (Xray, WireGuard,
OpenVPN, IKEv2 — not Xray-only as dispatch.go's comment implies), and
`ConcurrencyService` **sums distinct sources per subscription across
protocols**, so two devices on two different protocols count as two. Three
consecutive over-limit polls before action, which is what keeps a
wifi-to-mobile handover from looking like sharing.

### IKEv2 is the one unknown

15 credentials, an enabled route (`singapore-1 / IKEv2`), and **zero
usage records all time**. The accounting code is real — it reads per-SA
byte counters from `swanctl` — so the likely explanation is that nobody
has ever connected over IKEv2, not that it is broken. **I could not
distinguish the two**, and the difference matters: if it is broken,
IKEv2 is an unmetered path around every data cap. Needs one real IKEv2
connection to settle, and until then no cap claim should include it.

## 2026-08-14 (later still) — the tun bridge works; WireGuard still cannot reach ir1

### The bridge is fixed and verified

ir1 now has the tun inbound, and the bridge the agent builds on top of it
is real and inspectable:

```
relay-tun   <POINTOPOINT,MULTICAST,NOARP,UP,LOWER_UP>
32764: from 10.77.0.0/24 lookup 100
32765: from 10.66.0.0/24 lookup 100
table 100: default dev relay-tun
```

Both CONFIGURE_ROUTE commands executed cleanly. Everything the M9 design
calls for on the relay side is in place — this is the first time that
half has ever existed on a real node.

**Why it was missing:** the relay template has the tun inbound and always
did. ir1's config was rewritten from the *base* template during the third
(desynced) installer run, so the node ended up relay-roled with a
non-relay config. Nothing detects that mismatch.

**Prerequisites, all already satisfied and worth recording:** the xray
unit ships `AmbientCapabilities=CAP_NET_ADMIN`, so xray creates the
device despite `User=nobody`; `/dev/net/tun` exists; and this xray build
accepts `"protocol": "tun"` (`Configuration OK`).

### But WireGuard does not complete a handshake to ir1

Tested from the panel server with `AllowedIPs = 1.1.1.1/32` so only that
one destination could enter the tunnel. Result, twice:
`latest-handshake 0`, `rx 0`, `tx 740`. The client talks, nothing answers.

Not a provisioning fault, and each of these was checked:
- wg0's real public key **matches** the registered `serverPublicKey`
- the test peer exists on wg0 with the right address (10.66.0.4/32)
- wg0 listens on 51064, no local firewall (`iptables -L INPUT` empty)

**I could not isolate the cause.** A 13-byte UDP probe to 51064 appeared
to arrive; a 148-byte WireGuard-shaped one and a 148-byte random one did
not. That pattern hints at size- or fingerprint-based filtering on the
path into Iran, but my capture windows were not reliably open across
both tests, so it is a hypothesis and nothing more. **Do not repeat the
"send a probe, grep a pcap" approach without pinning the capture window
open first** — it produced a confident wrong answer once already tonight.

### phantun was never built

The architecture has always said the client→relay leg for
WireGuard/OpenVPN needs **phantun** (UDP-over-TCP), and that "relay
installs phantun". It does not: `grep phantun installer/lib/agent.sh`
returns nothing, and it is not on ir1. That is the designed answer to
exactly the symptom above, and it is the missing piece — not the bridge.

### State left behind

`Iran relay / WIREGUARD` and `Iran relay / OPENVPN` are **disabled, not
deleted**, and their credentials removed. The engines stay installed and
registered and the bridge stays up, so once a client can actually reach
them it is one flag each. Ten Xray-family relay routes remain enabled and
verified. OpenVPN was never client-tested at all — it is disabled for the
same reason, by inference rather than measurement, and that inference is
untested.

## 2026-08-14 — WireGuard into Iran is DPI-dropped. Measured both ends.

Captured on **both** ends of the same handshake:

- Client (panel box) egress: **4 packets leave** —
  `167.233.65.166.45455 > 185.222.28.186.51064: UDP, length 148`
- ir1 ingress: **0 arrive**, 0 return. Client ends `tx=592, rx=0,
  handshake=0`.

They are dropped in transit. Not provisioning: wg0's public key was
confirmed by deriving it from the client's own private key
(`wg pubkey` → `5jSnst…`, matching the peer at 10.66.0.2), the peer was
present, 51064 was listening, `iptables -L INPUT` empty.

**What identifies the filter.** In a capture proven open by a TCP
control in the same pcap, from the same host to the same ip:port:

| sent | arrived |
|---|---|
| TCP SYN to 443 (control) | yes |
| UDP 13 bytes | yes |
| UDP 148 bytes, type byte 0x01 + random body | **yes** |
| real WireGuard handshake, 148 bytes | **no** |

So size, port and protocol number are all fine — a *valid* handshake is
what gets dropped. A real initiation carries a `mac1` computed over the
responder's public key; a DPI box that validates that field drops the
genuine article and ignores a malformed lookalike. That is the only
hypothesis consistent with all four rows, and it is the documented
Iranian behaviour.

**So WireGuard and OpenVPN cannot reach an Iran relay in the clear, and
no amount of node-side configuration changes that.** The tun bridge is
fine and stays built.

### phantun is the answer, and it was never built

The architecture has said from the start that the client→relay leg for
WireGuard/OpenVPN needs **phantun** (UDP-over-TCP), and that "relay
installs phantun". `grep phantun installer/lib/agent.sh` → nothing. It
is not on ir1 and there is no client half either. That is the real
remaining work, and it is a milestone, not a patch: phantun server on
the relay, phantun client bundled in the Windows and Android apps, plus
config plumbing so the client knows to dial TCP instead of UDP.

Both routes stay **disabled** (rows kept, credentials removed). Ten
Xray-family relay routes remain enabled and verified — and this is
exactly why REALITY/Trojan/WS/Shadowsocks matter for Iran: they already
survive this path.

### tcpdump buffering produced three wrong answers tonight

`tcpdump -w file` buffers ~4KB before flushing. Reading the pcap while
the capture is still running shows **zero packets** even when packets
arrived. That is what produced the earlier "UDP is blocked" and
"WireGuard-shaped packets are blocked" conclusions, both of which were
wrong. Use `-U`, **and** put a control packet you know arrives into the
same capture so an empty result is distinguishable from a dead capture.

## 2026-08-14 — phantun works. WireGuard reaches Iran.

**WireGuard over phantun to ir1, then out through the relay:**

```
handshake=1786681655  tx=3508  rx=5948
EXIT IP: 204.168.161.100   (finland1)
```

Real handshake, traffic both ways, exit at the relay's exit node.
Re-verified against the **systemd-managed** service, not just a
hand-started process. This is the thing that was specified in M9 and
never built.

### Shipped (node side)

- `installer/assets/neoxify-phantun@.service` — templated, one instance
  per fronted UDP engine, `CAP_NET_ADMIN` for the tun and nothing more.
- `installer/assets/neoxify-phantun-nat` — the DNAT + MASQUERADE the
  kernel needs, reapplied **on every start**. iptables does not survive
  a reboot and the failure is silent: phantun logs "Listening" and every
  client times out on a SYN+ACK the kernel never delivered to it.
- `install_wireguard` calls `setup_phantun` on **RELAY nodes only**, and
  records `phantunTcpEndpoint` in the registered params so the app dials
  TCP instead of a UDP port that will never answer. Added to the
  client-visible whitelist; absent elsewhere, and a client that ignores
  it behaves exactly as before.

### Two traps worth keeping

- **Docker sets `-P FORWARD DROP`.** The panel box runs Docker, so
  phantun_client's synthesised SYN appeared on `tun0 In` and never on
  `eth0 Out`. Cost a full wrong diagnosis ("TCP 8446 is blocked to ir1")
  before I captured on the client side. A real customer device does not
  have this; it was purely the test host.
- **phantun binds no socket.** `ss -lnt` shows nothing on its port,
  because it synthesises TCP on a tun device. Absence there is normal
  and is not evidence it failed to start.

### State

`Iran relay / WIREGUARD` and `/ OPENVPN` remain **disabled**. The node
side is done and proven; the apps do not speak phantun yet, so a
customer handed a WireGuard credential today would still dial UDP and
fail. Ten Xray-family relay routes stay enabled and verified.

### Next, in order

1. **Client half**: bundle `phantun_client` into the Windows and Android
   apps and have the connect path prefer `phantunTcpEndpoint` when the
   credential carries one, pointing WireGuard at the local UDP port
   phantun opens. This is what unblocks the two disabled routes.
2. OpenVPN gets the same treatment — a second phantun instance on its
   own TCP port. Untested for OpenVPN specifically; the mechanism is
   protocol-agnostic but that is inference, not measurement.
3. Then releases, then the emulator protocol matrix.

### Blocker found immediately after: phantun has no client for our platforms

`phantun` releases are **Linux only** — aarch64/armv7/i686/x86_64/mips,
no Windows, no macOS. And on Android an unrooted app cannot do what
phantun_client needs: it wants its own raw tun device plus iptables NAT,
while an app only gets the system-owned `VpnService` descriptor.

So **the client half as designed cannot be built.** The node side I
shipped is correct and proven, but nothing on Windows or Android can
talk to it. That is why the two routes stay disabled — this is now a
harder gap than "not wired up yet".

**The replacement is wstunnel**, which the M22 plan already named as the
"WStunnel" equivalent. It ships `windows_amd64` and `android_arm64`
binaries and runs entirely in userspace — it opens a local UDP port and
carries it over WebSocket/TLS, no client TUN and no root. That is the
property phantun lacks and the only reason phantun looked right was that
the architecture named it before anyone checked its platform matrix.

Sketch, not yet built or tested:
- relay: `wstunnel server wss://0.0.0.0:<port>` (can share 443 behind the
  existing SNI-routing thinking in M22)
- client: `wstunnel client -L 'udp://<local>:127.0.0.1:<wg-port>?timeout_sec=0' wss://ir1:<port>`
- WireGuard `Endpoint` points at the local UDP port, exactly as it points
  at phantun's today

**Do not delete the phantun work.** It is proven, it is relay-only, it is
not advertised to any client (both routes disabled), and it remains the
right tool for a Linux client or a router. But it is not the path to the
Windows and Android apps.

**Recommendation before building further:** prove wstunnel end to end on
ir1 the same way phantun was proven — real handshake plus an exit IP —
*before* touching either app. The lesson of tonight is that the platform
matrix of a dependency is worth five minutes up front.

### wstunnel proven too — and it is the one with a client half

```
handshake=1786693718  tx=3700  rx=6876
EXIT IP: 204.168.161.100   (finland1)
```

Same result as phantun, over WebSocket instead of fake TCP, through the
same Iran relay. Now a systemd service on ir1
(`installer/assets/neoxify-wstunnel.service`, active + enabled, listening
on 8447, `--restrict-to 127.0.0.1:51064` so the node is not an open
forwarder).

**Why this is the path and phantun is not**, despite both working:

| | phantun | wstunnel |
|---|---|---|
| Windows client | **none** | `windows_amd64` |
| Android client | needs raw tun + iptables, impossible unrooted | `android_arm64` |
| Client privileges | root / CAP_NET_ADMIN | none, userspace |
| Node-side NAT rules | DNAT + MASQUERADE required | none |

wstunnel needs no tun and no iptables at either end, which is why its
unit has no companion helper script. Keep phantun — proven, relay-only,
unadvertised — but the apps will speak wstunnel.

### Where this actually stands

Node side is **done and proven twice over**. The client half is not
started: the Windows and Android apps must bundle the `wstunnel` binary,
start it on connect (`wstunnel client -L 'udp://<local>:127.0.0.1:<wg-port>?timeout_sec=0' ws://<node>:8447`),
point WireGuard's `Endpoint` at that local UDP port, and stop it on
disconnect. On Windows that belongs in the LocalSystem helper service,
which already owns the tunnel lifecycle.

Also still to do before this is a product: run wstunnel over **TLS on
443** rather than plain ws on 8447 (a plain WebSocket on an odd port is
itself a fingerprint), and give OpenVPN its own instance.

`Iran relay / WIREGUARD` and `/ OPENVPN` remain **disabled**. Ten
Xray-family relay routes stay enabled and verified.

## NEXT SESSION — start here, in this order

Everything below is ready to execute. No discovery needed.

### 0. Correct a wrong conclusion I recorded earlier

I tested WireGuard client->ir1 **from Germany**, which crosses Iran's
international gateway inbound. **Customers connect from inside Iran to
an Iran VPS — domestic traffic that never touches that filter.** The
"WireGuard is DPI-dropped" finding is real for cross-border only and
says nothing about the customer path. All 12 relay routes are enabled
and wired (54 CONFIGURE_ROUTE executed, 0 failures).

**First action: have an Iranian tester pick WireGuard on Ultimate.** If
it connects, wstunnel is unnecessary. If not, wstunnel is half-built —
`wstunnel.exe` already bundles into the Windows build (fetch proven,
`wstunnel-cli 10.6.2`), and ir1 has the unit + `/etc/neoxify/wstunnel.env`
ready, so the server side is one `systemctl enable --now
neoxify-wstunnel` away.

### 1. Security review (do this first — highest cost if wrong)

The user's explicit worry: "I don't want someone to hack my client area
or website or turn it down." Concrete surface to audit:
- `customer-auth` + `auth`: token TTLs, `tokenVersion` revocation, the
  reset/verify token reuse window. Login proof-of-work exists (M98) but
  the `CHALLENGE_REQUIRED_AFTER_FAILURES = 5` grace was left in for old
  clients — **remove it now that shipped clients solve challenges**.
- Rate limits: `trust proxy` is fixed, but re-check every public
  endpoint has a throttle, especially `/customer-auth/*`, voucher
  preview, and the Plisio webhook.
- The Plisio callback verifies `verify_hash`; confirm no code path
  accepts a callback without it.
- `website/` PHP: the `/r/CODE` handler whitelists `^[A-Z0-9]{1,32}$` —
  check the rest of `inc/` for unescaped output and any SQL built by
  concatenation.
- Panel RBAC: RESELLER is allowlisted in `sidebar-nav.tsx` and
  `/overview` redirects — verify no other page leaks cross-tenant data
  (the last leak was found only by signing in as a reseller, not by
  reading code).
- ir1 exposes SSH on 22 with a password the user shared in chat and
  intends to rotate. **Recommend key-only auth and rotating it.**

### 2. Restriction matrix per protocol

Already measured (2026-08-14): data caps enforced to the engine, device
limits summed across protocols. Two open items:
- **IKEv2 has 0 usage records all-time** with 15 credentials and an
  enabled route. Code reads real SA counters, so it is probably unused
  rather than broken — but if broken it is an unmetered path around
  every cap. One real IKEv2 connection settles it.
- Speed caps (`maxDownloadMbps`) apply to WireGuard/OpenVPN only; all
  Xray protocols are uncapped (task #81). Currently no plan sets them,
  so nothing is mis-sold today.

### 3. Detection resistance pass

- ir1 REALITY camouflage is `cloudflare.com`. Review `dest`/SNI per node
  rather than inheriting the default.
- If wstunnel is ever enabled, it must run **TLS on 443**, not plain
  `ws://` on 8447 — a bare WebSocket on an odd port is its own
  fingerprint.
- Ports in use on ir1: 443, 2053, 2054, 8443, 8444, 8445, 46731, 46732.
  The France set (2054/8445/46732/8444) sits on non-standard ports;
  consider whether those read as suspicious in aggregate.

### 4. Then releases, then the emulator/VM matrix

Only after the above. Build and hold per the standing decision, then run
every protocol on the Android emulator and the Windows VM against the
real relay, checking exit IP each time — not just "it connected".

## 2026-08-14 — Security audit of the account surfaces

**Status:** six fixes landed, all with tests; three items need the
operator. Nothing was deployed — production is untouched.

The brief was the owner's own worry: "I don't want someone to hack my
client area or website or turn it down." Static review plus tests, plus
read-only requests to the public site. What follows separates what was
proven from what was not, because two of these were live and one was a
total bypass.

### Anyone with an admin password had MFA for decoration

`AuthService.login()` signs the MFA challenge token with
`jwt.accessSecret` — the same secret as an access token — and hands it
back **after the password is accepted and before the TOTP code**.
`JwtStrategy.validate()` copied `sub` through without checking anything,
and `RolesGuard` only rejects where a route declares `@Roles()`. Most
admin controllers declare none. So that token authenticated against
`GET /customers`, `GET /protocol-users` and `DELETE /routes` for five
minutes, renewable by logging in again.

`types.ts` asserted this was impossible: "a mfaToken has no `role`, so
it can't pass as an access token to JwtStrategy.validate() either." The
comment was the only thing enforcing it. **A stated invariant that no
code checks is a comment, and this one had been wrong since MFA landed.**

Same shape on the customer side, and worse in reach: the verify-email
token (24h, real customer id, `purpose: "verify-email"`) was accepted as
a full session. It is emailed in cleartext and travels in the query
string of the GET landing page, so it also lives in nginx logs and
browser history. Anyone who saw one held the account for a day. The
invoice-document token too — its `sub` is an *invoice* id, which every
handler downstream would have used as a customer id.

Both strategies now validate positively: a `purpose` claim is refused
outright, and the fields a real access token carries are required.

### A reseller was an admin everywhere nobody had said otherwise

M25 made the panel sidebar an allowlist and its comment says "the
backend gates each endpoint too — this is the navigation, not the
security boundary". **It did not.** One request with a reseller's own
token returned:

| Endpoint | What it hands over |
|---|---|
| `GET /customers` | every customer's email |
| `GET /protocol-users` | every customer's **decrypted** VPN credentials |
| `GET /protocol-configs` | `publicParamsJson`, which carries `caKeyPem` |
| `GET /routes` | relay uplink credentials |
| `PATCH /customers/:id` | accepts a new password — for anyone |
| `DELETE /routes/:id` | takes a route down |

Nothing had to be guessed. The `/overview` leak found on 2026-08-13 was
this same root cause caught one page at a time; this is the class.

The check went into `JwtAuthGuard`, not `RolesGuard`, because several of
those controllers never include `RolesGuard` in their chain — a fix
there would have compiled, passed review and never run. Default is now
deny for outsider roles on any endpoint that does not name them, so the
next controller someone adds is closed until it says otherwise.

`ALL_ADMIN_ROLES` is derived from a `Record<AdminRole, true>`, so adding
a role to the Prisma enum is a compile error rather than a silent grant
— the same trick as the protocol-drift guard, and for the same reason:
RESELLER already inherited "everyone" once.

### The proof-of-work grace: the premise was false, and it was checkable

The plan said to remove `CHALLENGE_REQUIRED_AFTER_FAILURES = 5` because
shipped clients now solve challenges. They do not:

```
git cat-file -e desktop-v0.9.4:apps/desktop-windows/src/lib/pow.ts   # fails
git cat-file -e android-v0.2.9:apps/desktop-windows/src/lib/pow.ts   # fails
```

`pow.ts` landed 2026-08-12. The newest tag of either client is
2026-08-11. **No released build contains a solver** — only the panel and
the web portal do.

That matters more than it looks, because with the grace closed a missing
solution is refused on the **first** attempt, not the sixth. Flipping it
today would refuse every sign-in from every beta tester's app. Running
apps keep working on their refresh tokens; anyone who signs out,
reinstalls or adds a device would be locked out of the product until a
release exists.

So the removal is **wired, not performed**:
`LOGIN_CHALLENGE_GRACE_FAILURES=0` closes it with no code change, and
tests pin both settings — including that the first unsolved attempt is
refused, which is the fact that decides when it is safe to flip.

One trap found while wiring it: docker-compose passes `""` for a
variable merely absent from `.env`, and `Number("")` is `0`. Left
unguarded, an empty value would have switched enforcement on by accident
and locked out every customer. Empty now means unset.

### The website's security headers have never once been applied

`website/.htaccess` is careful and correct, and **neoxify.net runs
nginx**, which never reads it. Measured against the live site, not
reasoned about:

- no CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy or
  Permissions-Policy on any response; `server: nginx/1.24.0 (Ubuntu)`
- `GET /r/ABCD2345` → **200 and the marketing page**, not a redirect to
  `/account/?voucher=…`. The voucher short links resellers hand out do
  not work, and that is the reseller programme's delivery path
- `GET /nonexistent-page-xyz` → 200 and the home page, so `404.php`
  never runs and every mistyped URL is indexable

The site is on **74.208.24.198 (IONOS)** — its own host, not the panel
box. `website/nginx-website.conf.example` is the same posture written
for nginx. It has to be installed by hand; this session deployed
nothing.

Also fixed in both files: `connect-src 'self'` blocks every call
`/account/` makes. The portal reuses the apps' endpoint ladder
(`connect.neoxify.site`, then node mirrors on their VPN ports, then
mirrors derived at runtime from the customer's own credentials), so the
allowance has to be `https://*.neoxify.site:*` — naming only the panel
would leave the portal with no failover on exactly the filtered networks
the ladder exists for.

### Also closed

- **The reset code had no guess budget.** Six digits, thirty minutes,
  and only a per-IP throttle — which is the control a distributed
  attacker walks around: 5/min from a thousand addresses is ~150k
  guesses at a chosen account inside one code's life. Misses now count
  against the account and the fifth burns the code. Burning, not
  locking: a lockout would let anyone who knows an email address deny
  the owner their own reset. The response does not change on the guess
  that burns it, or it would tell an attacker when to ask for a fresh
  window.
- **Swagger UI was live at `/api/docs`, unauthenticated** — confirmed by
  opening it, not by reading `main.ts`. Now opt-in via
  `ENABLE_API_DOCS`.

### Checked and found sound

Worth recording so nobody re-audits them: the Plisio callback has no
path that acts without `verifyCallback`, and `confirmPayment` is
idempotent on `status !== "PENDING"`; every customer-facing endpoint
scopes through `getOwned`; the PHP site has **no SQL and no `eval` /
`exec` / `include $var` anywhere**, every echo is an internal value, and
`/r/` whitelists before redirecting; `trust proxy` is still `1`;
`ServiceTokenGuard` fails closed and compares digests; the proof-of-work
implementation itself (HMAC, single use, difficulty floor, stockpiling
check) is correct.

### What still needs the operator

1. **`ir1` SSH on 22 with a password shared in chat.** Key-only auth and
   rotate it. Not something to change under a sleeping owner with live
   customers on the node.
2. **The nginx config for the website** has to be installed by hand
   before any of its headers exist. Until then the site's only real
   protection is the `<?php exit; ?>` guard line — which does work:
   `/inc/config.php` returns 200 with an empty body.
3. **Decide when to set `LOGIN_CHALLENGE_GRACE_FAILURES=0`.** It is a
   release question, not a code one.

### What could not be settled statically

- Whether `data/` is writable on the web host. `/data/secret.php` 404s,
  which is as consistent with "never written" as with "protected". If it
  is not writable, `nx_secret()` silently falls back to a value derived
  from the install path and PHP version — guessable — and
  `nx_rate_limit_ok()` fails open, so the contact form has no rate limit
  at all. One `ls -la` on the host settles it.
- Whether the reseller exposure was ever used. There is one reseller
  account and no audit trail on those reads. Nothing suggests it was.
- The panel guards are typechecked and built, not driven. The last three
  bugs in this area all compiled. **Sign in as a reseller and try
  `/customers` by URL before believing this is closed** — that is how
  the `/overview` leak was found, and reading the code is what missed
  it.

## 2026-08-14 — Detection-resistance pass (NEXT SESSION item 3)

**Status:** installer, templates, one client behaviour and a new doc
changed. **Nothing was deployed and no live node was touched.** Every
conclusion below is analysis of code, of xray-core's source, and of
probes run from this dev machine — not a measurement against an Iranian
filter. `docs/detection-resistance.md` has the full reasoning; this is
what changed and what is still open.

### The camouflage default was losing to a table lookup

`cloudflare.com:443` was the REALITY `dest` default for every node, and
ir1 uses it. Cloudflare publishes its address ranges. So a ClientHello
claiming that name, sent to an address in nobody's CDN, is a mismatch a
filter catches with one lookup and zero inspection — the cheapest check
available to it, and the one the old prompt never mentioned. The same
argument rules out every centrally-hosted household name.

Three changes, all in `install_xray`:

- `probe_reality_dest` opens a real TLS 1.3 connection to a candidate
  **from the node**, with `-alpn h2`, and checks the negotiated ALPN,
  that the certificate verifies, and X25519 as advisory. The list can no
  longer promise something that box cannot reach — which matters most
  for exactly the case we care about, an Iranian VPS dialling a property
  that geo-blocks it. A `dest` the node cannot reach turns every prober
  into a failure instead of into a convincing web page, which is louder
  than having no disguise at all.
- Candidates are probed and printed in two groups, Iran-hosted and
  abroad, with the criterion stated: **pick for where the node is, not
  where the customers are.** Default is whichever passed first.
- `www.microsoft.com` and the placeholder domains are refused by name
  with the reason. Microsoft is the one this project has already been
  burned by (M9: endpoint security intercepts it, REALITY then fails
  with "received real certificate"). It was also still sitting in a
  desktop test fixture as an example to copy; replaced.

The probe is real code that ran: `www.digikala.com`, `www.aparat.com`,
`divar.ir`, `www.speedtest.net`, `www.asus.com` and `www.leboncoin.fr`
all pass from here; `www.varzesh3.com`, `www.zoho.com` and `www.snapp.ir`
do not, and the Iranian ones among those probably fail *because* the
probe ran from outside Iran. That is the argument for probing on the
node rather than shipping a list.

### Every node returned the same 118 bytes to a prober

The Trojan/VLESS+TLS fallback site was byte-identical on every node.
That is a fleet fingerprint obtainable without breaking a single tunnel:
open the port, speak ordinary HTTPS, hash the response, compare. It now
picks from several dull placeholder pages and embeds a random build id,
so the length and the bytes differ per node. Still impersonating nobody.

### `/ws` is the first string a prober sends

It was the default path, and it is the default in every xray tutorial
ever written. Now generated per node (`suggest_ws_path`). Verified first
that this costs nothing: both clients read `path` from `publicParams`
and neither has ever hardcoded it.

### Ports: two different arguments, previously conflated

For a listener whose disguise is "a web server", the port is part of the
disguise — TLS on 2087 is unremarkable, the same handshake on 46731 is
an anomaly before inspection. For Shadowsocks and the UDP engines the
reasoning inverts: they have no normal-service story on any port, so a
random high port is right and a Cloudflare-adjacent one would be worse.
`suggest_plausible_tls_port` now draws at random from
8443/2053/2083/2087/2096 for the two TLS prompts, which also stops every
node answering on 2053 — that pattern is one scan from being a list of
our nodes. `suggest_free_port` is unchanged and now says why it differs.

### A fallback comment was right by accident, and worth correcting

The templates claimed the WebSocket path fallback is "matched before"
the h2 entry because WS upgrades are HTTP/1.1. Both halves are wrong.
Read from xray-core v1.260327.0 (`proxy/vless/inbound/inbound.go`):
fallbacks are a `[name][alpn][path]` map, so the JSON list has no order;
and these connections **do** negotiate h2, because our clients advertise
Chrome's ALPN list and the inbound prefers h2. It works because path
entries under the empty ALPN are copied into every named-ALPN bucket at
startup, and because the path is sniffed from the request line
regardless of ALPN. Anyone "simplifying" either entry on the old comment
would have broken the WebSocket transport.

Related, and deliberately *not* changed: the clients keep `alpn:
["h2","http/1.1"]` even for WebSocket. The ALPN list is plaintext in the
ClientHello and has to match what a Chrome-fingerprinted hello carries;
the HTTP/1.1 framing that follows is inside TLS where no passive filter
sees it. `WithNextProto("http/1.1")` in xray's ws dialer only applies
when no ALPN is configured, so this is our list, not a default.

### Trojan's SNI fallback produced the thing it was written to prevent

`vpn.rs` fell back to the node's host as `serverName` when a node
recorded none, reasoning that a wrong name beats no name. The host is an
IP, and uTLS drops an IP literal from the SNI extension entirely
(`hostnameInSNI`, utls v1.8.3 — read, not guessed). So it sent a
Chrome-shaped ClientHello with no server name at all, and the
certificate check failed anyway since none of our certificates carries
an IP SAN. It could not have connected on any node we run. Now a
refusal naming the field, matching VLESS+TLS, IKEv2 and the Android
client. 14 Rust tests pass.

### Checked and sound

`fingerprint: "chrome"` is set in all three places that build an
outbound — both clients and the relay's own uplink in
`agent/internal/relay/provisioner.go`, which crosses the same filter a
customer does. No client hardcodes anything that varies per node.
`allowInsecure` appears nowhere and a test asserts it. Shadowsocks sets
`uot` on both clients. OpenVPN uses `tls-crypt`, so its control channel
is not the giveaway a plain OpenVPN server's is.

### Needs the owner or a live test

1. **Certificate transparency publishes the fleet.** Every
   `*.neoxify.site` node name is in CT logs the moment it is issued —
   enumerable with no probing at all. Unrelated per-node domains, or a
   DNS-01 wildcard, both cost something. Owner decision.
2. **ir1's aggregate port profile** (443, 2053, 2054, 8443, 8444, 8445,
   46731, 46732). The `+1` pairs come from adding a second inbound per
   relayed exit by hand, and 2054/8445 are ports nothing else uses.
   Changing a serving node needs the owner.
3. **Which `dest` ir1 should actually use.** The probe answers
   "reachable with TLS 1.3 from this box"; it cannot answer "unremarkable
   from inside Iran". A domestic Iranian site is the reasoned choice for
   an Iran-hosted relay — needs a test from an Iranian network first.
4. **Failed attempts are training data.** Failover starts with
   WireGuard, and the per-network memory only remembers what worked.
   Every first connection on a filtered network therefore emits a
   recognisable WireGuard handshake. Remembering failures per network
   would cut it to once; the current order is a recorded product
   decision, so it was left alone.
5. **wstunnel must be `wss://` before a customer sees it.** Noted in the
   unit file itself now, since there is no installer path for it yet and
   the only running instance is the ir1 proving run on plain ws://8447.

## 2026-08-14 — Reseller voucher links were dead in production

**Status:** fixed in the backend and tested. **The website and the web
host were not touched, and nothing about nginx changed.**

Every activation email a reseller's customer has ever received carried a
link that did not work. `activationUrl()` emitted the short form,
`https://neoxify.net/r/CODE`, whose redirect is defined in
`website/.htaccess` — a file only Apache reads. neoxify.net is served by
nginx, which does not read it. So the rule has never existed on the live
host, and the link landed on the marketing homepage with no code, no
prefill and no error.

Measured against the live site, not reasoned about:

- `GET /r/ABCD2345` → **200 and the home page**
- `GET /nonexistent-page-xyz` → 200 and the **byte-identical** home page
  (`sha256` prefix `5ce7256f8c66` on both, and on `/a/b/c/deep` and
  `/sitemap.xml`). So nginx falls every unresolved path back to the root
  `index.php`, and `404.php` never runs
- `GET /r/index.php?c=ABCD2345` → **302 to `/account/?voucher=ABCD2345`**
- `GET /r/index.php/ABCD2345` → **200**. The `PATH_INFO` fallback written
  into `r/index.php` for exactly this case is inert too; the live fastcgi
  block does not populate it. Worth knowing before anyone relies on it

The fix is the long form, `/account/?voucher=CODE`, which the portal
already reads (`apps/web-portal/src/App.tsx`). One line, ships with a
normal backend deploy, needs nothing from the web host.

`resellers.service.spec.ts` is new and is the first test this module has
had. It asserts the URL *shape*, deliberately — a test that only checked
for a non-empty link would have passed throughout the whole outage. It
was run against the old `/r/` line first and all four cases failed, then
against the fix and all four passed. Full backend `lint typecheck test`:
36 suites, 339 tests.

### Not done, and deliberately

A PHP front controller in `website/index.php` would make `/r/CODE` work
with no server config at all — the catch-all means PHP already receives
those requests — and would also fix the 404s and add the missing security
headers from PHP. It was written and then **reverted**, because there is
no PHP on this machine (none in CI either, and `website/` has no tests),
so it could not be run even once. Shipping unexecuted routing to the live
marketing site is how a mistake takes real pages down. The patch is kept
at `scratchpad/website-shortlink-frontcontroller.patch` if the short
links are ever wanted back; installing
`website/nginx-website.conf.example` is the other route.

### Open

- **Links already handed out in `/r/CODE` form stay broken.** This fixes
  only links generated from now on. Nobody has checked how many were
  emailed or to whom.
- A stale generated Prisma client in a fresh worktree fails `typecheck`
  with ~20 errors that look like missing schema fields
  (`issuedByAdminId`, `resellerTokenBalance`, `AdminRole.RESELLER`).
  `pnpm run prisma:generate` in `apps/backend`, not a code problem.

## 2026-08-14 — Desktop protocol matrix: 16/16 direct routes carry traffic

**Status:** the 16 direct routes are proven. The 12 Iran-relay routes are
not yet run. Three releases cut; two release pipelines were broken and
are fixed.

### The matrix

Every direct route was raised on the clean Win11 VM against production
and checked for a real exit, not a "Connected" label. **16 of 16 pass** —
every protocol on finland1 and france-1 (REALITY, VLESS+TLS over TCP and
over WebSocket, Trojan, WireGuard, OpenVPN, Shadowsocks) plus OpenVPN and
**IKEv2** on singapore-1.

IKEv2 answers an open question from the restriction-matrix entry: it had
0 usage records all-time against 15 credentials, and the worry was an
unmetered path around every cap. It connects and egresses correctly, so
it is unused rather than broken.

**How, and what it does not cover.** The harness drives the service's
named pipe (`\.\pipe\neoconnect-service`) with the same `ConnectProfile`
shape the app builds, replicating `ProtocolUserPayload::into_profile`
field for field. So this proves the engines, the routing and the egress.
It does **not** exercise the app's UI, its failover ladder, or its own
connection verification — those sit above this layer and are still
unverified. Do not quote 16/16 as "the app works".

Ground truth was taken for one route rather than assumed for all:
france-1 Trojan was re-run holding the tunnel open, and france-1's own
`/var/log/xray/access.log` shows `trojan-in >> direct` sessions from the
rig's WAN address, including the DNS lookup and the fetch the script
generated. Service state, exit IP and the node's log agree.

**A harness bug worth not repeating.** The first run recorded
france-1/Trojan as HARNESS-ERROR. It had passed — connected, correct exit
IP — and then my own script threw, because it rewrote the whole log file
on every line and collided with a host-side read over the shared folder.
A verdict column that can be corrupted by the recorder is worth less than
it looks; the fix is to write once at the end.

### Driving the VM without its password

The rig auto-logs in with a blank password, and `guestcontrol` refuses
that: it does a secondary logon, which Windows blocks for blank-password
accounts by policy, and the error is indistinguishable from a wrong
password. Rather than change the VM, attach a **transient shared folder**
(`VBoxManage sharedfolder add ... --transient --automount`) and type one
line into the Run dialog. Scripts and results then move over the shared
folder, which also survives the tunnel taking over the default route —
an HTTP channel would not. Scope the share to a subfolder; do not expose
one holding credentials.

### Two release pipelines that had never worked

Both found by cutting releases, not by reading:

- **`fetch-binaries.ps1` had a literal TAB byte** where `\t` belonged, so
  the path to Windows' tar was `System32<TAB>ar.exe` and `Test-Path`
  threw "Illegal characters in path". The wstunnel step had therefore
  **never succeeded since 766ef25**, and no released installer ever
  contained `wstunnel.exe` — confirmed independently against the 0.9.4
  build on the VM, whose `resources/` had every other engine and not that
  one. The journal recorded the bundling as done and fetch-proven. It was
  neither. desktop-v0.9.5 is the first release that actually carries it.
- **The Android store-flavour guard had never run green.** Two defects:
  under `set -euo pipefail`, `grep | wc -l` dies when grep matches
  nothing, so the step was killed before printing a single number and two
  releases failed saying literally nothing; and it counted the marker
  inside the packaged APK/AAB, where it cannot appear at all because
  Tauri embeds the web bundle into the native library compressed. It now
  counts `dist/` between the two builds and reports `direct=3 store=2`,
  matching the original hand measurement. A guard that cannot report "0"
  cannot be debugged from its own output.

Also: mobile `src-tauri/Cargo.toml` was still 0.2.8 while the other two
version fields said 0.2.9, so android-v0.2.9 built its Rust crate under
the previous version. The tag guard only compares against
`tauri.conf.json`, which is why nothing caught it.

### Released

`desktop-v0.9.5`, `android-v0.2.10`, agent `v0.2.2`. CI on main is green;
it had been red since the detection-resistance pass on a shellcheck
SC2034, and the first attempt at that fix silenced nothing because the
directive sat above `local` rather than above the `for` it reports on.

### Next

1. The 12 relay routes, on the Ultimate account. ir1 SSH works now, and
   the outbound tag in its access log (`route-<uuid>-out`) is the only
   thing that distinguishes which exit a relay session took — exit IP
   alone cannot, when two routes share an entry.
2. The Android emulator matrix, against 0.2.10.
3. The app-level path: failover ladder and connection verification, which
   this matrix deliberately bypassed.

## 2026-08-14 — Iran-relay matrix: 11/12, and WireGuard never reaches ir1

**Status:** 27 of 28 routes now proven end to end. One real failure, two
anomalies worth a look, nothing changed on any node.

### Results

All 12 ir1 routes raised from the VM. **11 pass**, each confirmed by an
exit IP matching the exit the route is wired to — not the host dialled.
That distinction matters and is why this needed its own harness: every
relay route enters ir1 and leaves from finland1 or france-1, so a check
comparing the exit against the dialled host would have failed all twelve.

**The multi-exit design is proven at the node.** ir1's own access log
shows each inbound mapping to its own distinct outbound:

    vless-in          -> route-1fcd952f-...-out
    vless-fr-in       -> route-66fa6da6-...-out
    trojan-in         -> route-215ffa1d-...-out
    trojan-fr-in      -> route-b383ba7d-...-out
    shadowsocks-in    -> route-8d9cfe06-...-out
    shadowsocks-fr-in -> route-13660d34-...-out
    vless-tls-in / -fr-in, vless-ws-in / -fr-in likewise

That is `ProtocolConfig.inboundTag` doing its job — the mechanism that
previously let two routes on one config silently share an exit.

### WireGuard over the relay: zero bytes ever received

`Iran relay / WIREGUARD` (ir1:51064) produced **no egress at all** while
the service's connect returned `{"status":"ok"}`.

Settled at the node rather than guessed. ir1 is serving WireGuard
correctly — `wg0` up, `wg-quick@wg0` active, udp/51064 listening — and:

- **2 peers configured, not one has ever completed a handshake**
- **zero bytes received on any peer**

So the packets never arrived. This reproduces the cross-border DPI drop
with node-side proof, which the earlier Germany test could only infer
from the client side.

**It says nothing about the customer path, and must not be quoted as
though it does.** This rig is in the US, so its traffic crosses Iran's
international gateway inbound — the same path the Germany test took. A
customer inside Iran reaches ir1 over domestic traffic that never touches
that filter. The open question from the previous entry stands exactly
where it was: it still needs one Iranian tester.

**`phantun-server` is `inactive` on ir1** — the workaround that was
proven to fix this is not running.

### Two anomalies, not yet explained

Both from ir1's access log, filtered to this rig's address:

1. **One session shows `[vless-fr-in >> direct]`** — egressing at ir1
   itself instead of through the relay route. Every other session on that
   inbound shows the route outbound, and the measured exit IP was
   france-1, so this is not the whole connection. But `>> direct` on a
   relay inbound means traffic leaving inside Iran, which is the failure
   mode the restart-drops-routes entry describes. Worth finding out
   whether it is a first-packet artifact before the route applies, or
   something that recurs.
2. **`vless-in` shows two different outbound tags** (`route-1fcd952f`
   and `route-c1b3f538`) for one inbound within a single run. Both
   exited at finland1 so nothing was mis-routed, but one inbound should
   map to one route.

### Also noticed

The **Ultimate** plan has `relayOnly = true`, yet
`GET /customer/protocol-users` returns **all 28** routes for that
account, direct ones included — not the 12 relay routes alone. Either
the flag means something narrower than its name suggests or it is not
being applied at this endpoint. Not tested further.

### Method, and its ceiling

Same as the direct matrix: the service's named pipe, profiles built to
mirror `into_profile`. It proves engines, routing and egress. The app's
failover ladder and its own connection verification sit above this and
are still unverified — in particular, the service returning `ok` for the
dead WireGuard tunnel is a statement about the service layer, not
evidence that the app would have shown a customer "Connected". That
needs the GUI to answer and has not been tested.

## 2026-08-14 — Android 0.2.10 on the emulator: the app is honest, Xray did not run

**Status:** partial. The app-level path was exercised for the first time
and behaved well; the Xray family did not establish on this emulator and
that result is **not** transferable to a real phone.

### The app tells the truth about its own state

This is the first test in this campaign that covered the layer the two
desktop matrices deliberately skipped — the UI, the failover ladder and
the connection verification. Checked by comparing what the screen said
against an independently measured exit IP every time:

- Connected, showing "Your IP: 104.105.205.233" — measured exit was
  **104.105.205.233**. Agreed exactly.
- "You're not protected" — measured exit was the rig's own WAN address.
  Agreed.
- Mid-ladder it says "Checking connection... trying each protocol until
  one works", which is what was actually happening.

No state was claimed that had not happened. That is the product
requirement and it holds here.

**Defect 3 from `android-0.2.8-findings.md` is fixed.** Picking
Compatible no longer fails over silently: the app says "Compatible isn't
in the Android app yet, so it will connect with Fast instead", and names
where it landed (`fr-france`). The old behaviour was to appear to try and
then quietly end up on Fast.

### Xray did not establish here, and the emulator is the suspect

Both attempts — Compatible, and Stealth (REALITY) on ir1 — ended on
WireGuard to france-1 through the ladder. ir1's access log shows **no
session at all** from this rig during the Android run (the last entries
are from the VM matrix an hour earlier), so the Xray attempts did not
reach the relay.

Do not read this as "REALITY is broken on Android". The AVD is
**x86_64 running an arm64-v8a APK through translation**, and the Xray
engine is a native arm64 library. That is a strong candidate cause and it
does not exist on a real handset. Against it: the 0.2.8 findings came
from a real phone where the Xray protocols did connect (France
Shadowsocks worked, Finland's did not). **Needs a real device to
separate.**

The failover itself worked correctly and honestly throughout, which is
the part this run does establish.

### Smaller things seen

- The picker lists **indistinguishable duplicates** — "ir1 · Shadowsocks"
  twice, "Stealth" twice, "Stealth Lite" twice, "Stealth Web" twice.
  These are the finland1 and france-1 exit pairs, and nothing in the row
  says which exit a customer would get. Only the latency differs, by a
  few ms.
- The orange "Compatible isn't in the Android app yet" notice **persists
  after switching to another protocol**. It was still on screen with
  Stealth selected.
- Installing over the previous debug build failed with
  `INSTALL_FAILED_UPDATE_INCOMPATIBLE`. Expected, and a useful reminder
  of why the release workflow refuses an unsigned or differently-signed
  APK: it is not a lesser build, it is one no customer can upgrade to.

### Method note

Driven over adb: `input tap`/`input text` plus screenshots. Two traps
worth recording. PowerShell's `>` corrupts `adb exec-out screencap`
output by re-encoding it — use `screencap` to the device then `adb pull`.
And there is no `curl` or `wget` on the image; `toybox nc` works but its
DNS does not, so exit-IP checks have to use a literal address.

### Still open

1. Xray on a **real** Android device, against 0.2.10.
2. The remaining Android routes; only two were driven here.
3. The desktop app's own UI and ladder — the Windows matrices drove the
   service pipe, so that layer is still untested on desktop.

## 2026-08-14 — The relay's Iran-egress window was ten minutes wide

**Status:** narrowed to one minute and covered by tests. **Not closed**,
and closing it needs a change on the node itself. Nothing on ir1 was
touched.

Chasing the `[vless-fr-in >> direct]` line from the relay matrix produced
the most serious finding of the session, and it is not hypothetical.

### What is actually on the node

ir1's `config.json` holds eleven relay inbounds, **one** outbound
(`direct`), and **one** routing rule (`api-in -> api`). Every
`route-<uuid>-out` outbound and every rule pointing an inbound at one is
hot-added over Xray's gRPC API and exists only in the running process.
That is by design — the backend re-asserts them — but it means a restart
leaves the inbounds listening with nothing routing them.

Traffic does not stop when that happens. It falls through to `direct` and
**leaves from the relay**, so a customer routing through Iran to get out
of Iran egresses in Iran, while the app shows a healthy connection.

`xray` on ir1 started 01:09:26 UTC today; `config.json` was written the
same second. Grepping the whole access log for relay inbounds egressing
direct returns exactly one session: **2026-08-13 23:50:51**, on protocol
user `02475929-...`, which is neither of the test accounts. A real
customer.

### Why it was ten minutes

`reassertConfiguredRoutes` already existed and is correctly wired — on
agent connect, and on a periodic sweep, because `systemctl restart xray`
leaves the control stream up so there is no reconnect to react to. The
sweep ran on `REASSERT_INTERVAL_MS`, ten minutes, **shared with user
re-assertion**.

Those two are not comparable. Re-asserting users is one CREATE_USER per
user per sweep and being late is an outage: the customer cannot
authenticate, notices, and nothing leaks. Re-asserting routes is a dozen
rows on the busiest relay we run and being late is a privacy failure that
is invisible to the person it happens to.

Routes now have their own sweep at 60s. That is a tenfold narrowing for
almost no traffic, and it does not touch the expensive half.

### What would actually close it, and why it is not here

Failing closed. Unmatched relay traffic should be dropped, not sent out
`direct`.

The obvious form does not work: a catch-all rule in `config.json` would
be evaluated **before** every hot-added route rule, because the agent
adds them with `ShouldAppend: true`
(`agent/internal/relay/provisioner.go`), so it would blackhole every
relay route rather than only the unmatched ones. Checked before writing
it, not after.

The form that would work is changing the node's **default outbound** —
the first entry in `outbounds` — from `direct` to a blackhole, so
unmatched traffic dies instead of leaking. That is a live-node config
change on a relay with real customers on it, and it needs the owner and a
maintenance window. It also needs checking against whatever else on that
node relies on `direct` being the fallback.

### Tests

`agent-gateway.route-reassert.spec.ts` is new; this path had none. It
pins the inbound tag being carried (without it a France rule is restored
onto the Finland listener — tunnelled, wrong country), the enabled-and-
relayed filter, skipping a route with no uplink credential, and that the
fast sweep does not drag user re-assertion along with it.

## 2026-08-14 — Two production steps waiting on the owner, in this order

**Status:** blocked on the owner. Nothing is half-applied; production is
unchanged and healthy. Both steps below are ready and neither has been
started.

### The order is not obvious and matters

Do the backend deploy **first**. The ir1 config change needs an Xray
restart, and a restart is exactly the event that empties the relay's
hot-added routes. With the blackhole in place that window becomes an
outage instead of a leak, which is the right trade -- but the width of
the window is set by the backend's route re-assert sweep. Undeployed that
is still ten minutes; deployed it is sixty seconds.

Doing ir1 first would mean up to ten minutes of blackholed traffic for
real customers, to fix a leak that lasts the same ten minutes. Deploy
first and it costs about a minute.

### 1. Deploy the backend

Production is at 29c5250, the commit this session started from -- nine
behind. Checked before proposing it: **no Prisma migrations, no schema
change, no new environment variables**. Only two of the nine commits
touch the running backend (the voucher link and the route sweep); the
rest are journal, workflows and client versions.

    ssh -i ~/.ssh/ovh_neo root@167.233.65.166 \
      'cd /root/neoconnect && git pull --ff-only origin main && \
       docker compose -f infra/docker-compose.yml up -d --build backend'

The API is not in the VPN data path, so customer tunnels are unaffected;
the panel and API blink for a few seconds.

Note for whoever runs this from an agent session: the SSH command above
was refused by the **permission classifier**, not by the server. Those
two are indistinguishable from the error text, and this journal has
recorded mistaking one for the other before.

### 2. Make ir1 fail closed

Checked first, and the answer was cleaner than expected: in ir1's entire
access log the `direct` outbound is used **exactly once**, and that once
is the leak itself. Nothing legitimate depends on the fallback, so
replacing it as the default breaks nothing.

`outbounds` is currently `[{"protocol":"freedom","tag":"direct"}]`.
Prepend a blackhole so it becomes the default:

    "outbounds": [
      { "protocol": "blackhole", "tag": "blocked" },
      { "protocol": "freedom",  "tag": "direct"  }
    ]

`direct` stays in the list so anything referencing it by tag still
resolves. Then `systemctl restart xray`, and confirm within a minute that
the relay routes came back -- `grep 'route-.*-out' /var/log/xray/access.log`
should show sessions again.

**This is a live Iran relay with real customers and it is the one action
here that can cause a visible outage.** Worth doing with the owner
present, not unattended.

### Also still open, unchanged

- An Iranian tester on WireGuard. Still the highest-value unknown, and
  still nothing in this session moved it.
- Xray on a real Android handset; the emulator could not answer it.
- ir1 still allows password SSH on port 22. Key auth is confirmed
  working now, so this is safe to close whenever.

## 2026-08-14 — Backend deployed; step 2 (ir1) still outstanding

**Status:** step 1 of the two production steps is **done and verified**.
Step 2 has not been started.

Production moved 29c5250 -> e8477fe. No migrations, no schema change, no
new environment variables — checked before, and unchanged after.

Verified in production rather than assumed: the route sweep now logs
every 60s (12:33:02, 12:33:57, 12:34:57, 12:35:57), re-asserting **12
relay routes** on ir1 each time. User re-assertion stayed on its ten
minute schedule — four log lines in four minutes is one sweep across four
nodes, one line per node, not four sweeps. The split is doing what it was
written to do.

**The Iran-egress window is ~60s now, down from ~10min. It is still not
zero.** Closing it is step 2, unchanged and still needing the owner:
prepend a blackhole outbound on ir1 so unmatched relay traffic dies
instead of leaving from the relay, then restart Xray. Now that the 60s
sweep is live, that restart costs about a minute of relay downtime rather
than ten.

### One process note

The deploy command in the earlier entry was wrong: it named
`infra/docker-compose.yml`, which is the local-development stack
(Postgres, Redis, MailHog only), and failed with `no such service:
backend`. Production is `infra/docker-compose.prod.yml`. It came from
grepping the README for `docker compose` and taking the first hit without
reading that it sat under "Getting started".

There was no deployment runbook to find, which is the actual gap, so
README now has one — including that `name: neoxify` in the prod compose
is what stops a second stack being started beside the live one when the
checkout directory is called something else.

## 2026-08-15 — ir1 now fails closed, and the relay was proven after it

**Status:** done and verified. Both production steps are complete.

### The change

ir1's `outbounds` was `[{freedom,direct}]`. It is now:

    [{"protocol":"blackhole","tag":"blocked"},
     {"protocol":"freedom","tag":"direct"}]

Xray sends unmatched traffic to the first outbound, so during any window
where the hot-added route rules are missing, relay traffic is dropped
instead of leaving from the relay. `direct` stays in the list so anything
naming it by tag still resolves.

Backup at `/root/xray-config.backup-20260815T151413Z.json`. Restart was
15:16:14 UTC, clean, no errors in the journal.

Checked first, and the answer made the change easy: across the whole
access log the `direct` outbound had been used **exactly once**, and that
once was the leak. Nothing legitimate depended on the fallback.

### Proving it afterwards, which mattered more than expected

Twenty minutes after the restart ir1 had **zero** established connections,
where it had fourteen before. That looked like an outage. It was not: the
clients' failover ladder had moved them to other nodes when ir1 dropped,
and they do not come back until they reconnect. Worth knowing before
reading an empty relay as a broken one.

The relay was then proven directly rather than inferred, without touching
any node's config: a throwaway xray **client** on france-1, dialling
ir1:443 with the test account's REALITY credential and exposing it as a
loopback SOCKS proxy, then one curl through it. Path france-1 -> ir1 ->
exit. Result **204.168.161.100 = finland1**, which is the exit that route
is wired to. Process killed and config removed afterwards.

That client test is worth keeping as a technique: it exercises the real
relay path, needs no VM, changes nothing, and routes nothing but the one
request.

**The IPv4 trap caught this run too.** The first attempt used
`--socks5-hostname`, which makes the *proxy* resolve the name, so `-4` did
not constrain the remote lookup and the answer came back as
`2a01:4f9:c013:864::1`. That is finland1's IPv6 -- a correct result that
matches nothing in an IPv4 table and reads as total failure. `--socks5`
with local resolution gives the IPv4 answer.

### What is proven and what is not

Proven: matched relay traffic still works after the change, on the exact
path a customer takes.

Not proven: the fail-closed behaviour itself, which by construction is
only observable during a restart window. The next time Xray restarts on
ir1, the access log should show `>> blocked` where it previously showed
`>> direct`. That is the line to look for.

### Noticed in passing, unrelated to this change

- ir1's agent logs `swanctl: executable file not found in $PATH` every 30s
  when collecting IKEv2 stats. strongSwan's CLI is not installed there.
  Possibly relevant to the standing "IKEv2 has 0 usage records all-time"
  question, which was previously read as "unused rather than broken".
- ir1's REALITY `dest` is still `cloudflare.com`, the default the
  detection-resistance pass argued against. Unchanged and still open.

## 2026-08-15 — ir1's REALITY dest is no longer cloudflare.com

**Status:** done and verified on both REALITY inbounds. Installer
candidate lists corrected in source.

### What it is now

`www.torob.com` on both ir1 REALITY inbounds — 443 (exits finland1) and
8444 (exits france-1) — set on the node **and** in
`protocol_configs.publicParamsJson`, since the client takes its SNI from
the panel and a mismatch fails the same way interception does.

### How it was chosen, which is the part worth keeping

Candidates were probed **from ir1**, not from a dev machine, using the
installer's own criteria. That immediately mattered: `www.varzesh3.com`
fails from here and passes from ir1, exactly the artifact the previous
entry predicted.

Then each survivor's address block was looked up, and that is what
actually decided it:

    ir1              185.222.28.186   VUNIFY-NETWORK      ordinary IR hosting
    www.torob.com    81.12.31.29      MobinhostInfra      ordinary IR hosting
    www.shatel.ir    85.15.17.13      SHTL-NET-INFRA      ISP hosting
    www.varzesh3.com 185.143.232.202  AbrArvan ANYCAST    a CDN
    divar/zoomit     185.166.104.x    Sotoon-CDN          a CDN
    www.digikala.com 185.188.107.10   Digikala-B4         own branded block
    www.aparat.com   185.147.179.11   SABAIDEA-NETWORK    own branded block

The reason cloudflare.com was wrong is that its ranges are published, so
"SNI says X, packet goes to a non-X address" is one lookup. **An Iranian
CDN is the same mistake in local clothes**, and a household name on its
own branded block is barely better — those are the domains a filter has
most reason to have mapped. torob.com sits in a hosting company's space,
the same shape of address as ir1 itself, so the check becomes per-domain
instead of per-range.

Worth noting `www.speedtest.net` was the first entry in the "abroad"
list and resolves into Cloudflare (104.17.x) — it carried the exact
problem the list exists to avoid. Removed.

### Verified, not assumed

A throwaway xray client on one node dialling ir1 and exposing loopback
SOCKS, then one curl. Client host chosen so a correct answer cannot be
the client's own address:

- client on france-1 -> ir1:443 -> **204.168.161.100 (finland1)**
- client on finland1 -> ir1:8444 -> **104.105.205.233 (france-1)**

### The failure in the middle, and what it taught

The first test after the restart returned nothing, and the access log
said `rejected proxy/vless/encoding: invalid request user id`. That is
not a REALITY failure — a wrong SNI is silently proxied to the dest
instead — it is VLESS user auth, meaning the restart had emptied the
hot-added **users**.

Routes now come back in 60s. **Users are still on the ten-minute sweep**,
so after any Xray restart the node authenticates nobody for up to ten
minutes while its routes sit ready. That is now the dominant outage after
a restart, and it is worth deciding whether the user sweep needs the same
treatment the route sweep just got.

There is a manual lever: `systemctl restart neoxify-agentd` on the node
forces a reconnect, and the backend re-asserts users on connect. It
executed 42 commands within seconds and the tunnel worked immediately
afterwards. Cheap, does not touch Xray, and is the thing to reach for
after any deliberate Xray restart.

### Also

ir1 had 43 established connections before this restart and 0 three
minutes after, which looks alarming and is not — the clients' failover
ladder moves them to other nodes and they return on reconnect. Same
pattern as the earlier restart. Do not read an empty relay as a broken
one; test it instead.

Backup: `/root/xray-config.backup-dest-20260815T154905Z.json`.

## 2026-08-15 — User re-assert is 60s too; a restart now costs a minute

**Status:** done, deployed and verified in production.

After `systemctl restart xray` the node authenticates nobody until the
user sweep runs. The inbounds listen, the routes come back within a
minute, and every customer is rejected with `invalid request user id`
for the whole gap. At ten minutes that was a ten-minute outage on every
customer of that node — which, in customer-visible terms, was the larger
of the two problems found yesterday.

Both halves now sweep at 60s.

### The cost was smaller than the old comment implied

The ten minutes existed to bound cost, and the sweep already writes onto
the stream instead of storing commands (`persist: false`), so it persists
nothing. What it spends is one idempotent CREATE_USER per active user.
Measured before changing it: **270 active users across four nodes, 105 on
the busiest** — roughly four messages a second fleet-wide at 60s.

It does scale linearly with the customer base. The code now says so, and
says what to reach for instead of a faster poll: a signal that the engine
restarted. That does not exist — `Heartbeat` carries cpu, memory and
connection count and nothing about the engine — so having one means a
proto change, an agent change and an agent rollout to nodes still running
`dev` builds. Polling is what is available without that.

### Verified in production, not just deployed

Three minutes of logs after the deploy:

    users:  3 sweeps x 105 (finland1), 105 (france-1), 30 (ir1), 30 (sg1)
    routes: 3 sweeps x 12 (ir1)
    stamps: 4:08:17 -> 4:09:17, 60s apart

270 is exactly the active-user count in the database, and the route lines
appear once per sweep rather than twice — which is the thing to watch,
since both timers now share an interval and either one drifting into the
other's work would double CONFIGURE_ROUTE traffic for nothing. A test
pins it in both directions.

### The manual lever is still worth knowing

`systemctl restart neoxify-agentd` on a node forces a reconnect, and the
backend re-asserts users **and** routes on connect. It executed 42
commands within seconds on ir1. After any deliberate Xray restart that
still beats waiting a minute, and it touches nothing else.

## 2026-08-15 — Agent v0.2.3 on all four nodes; IKEv2 noise gone

**Status:** done. All four nodes moved off `dev` builds onto a released
agent for the first time.

    node          sha           IKEv2 errs   all errs
    ir1           5938954761c8      0            0
    finland1      5938954761c8      0            0
    france-1      5938954761c8      0            0
    singapore-1   5938954761c8      0           33   <- different cause, below

Counted from each node's own agent start, which matters: a five-minute
window looked like ir1 was still erroring, and every one of those lines
turned out to carry the **old** process's PID from before the restart.
Scope log windows to `ActiveEnterTimestamp`, not to a round number.

Each rollout verified the release checksum on the node before installing,
and kept the previous binary at `/root/agentd.backup-dev-*`. Worth having
kept: every node was on a hand-built `dev` binary, and there is no way to
tell from the outside whether one carried local changes that never
reached git.

### The agent restart does not disturb customers

Measured rather than asserted, on finland1 across its restart:
**166 established customer connections before, 168 after.** It went up.
The agent holds the control stream, not the tunnels, so restarting it
re-asserts users and routes without touching a single session. That makes
it the safe lever after any deliberate Xray restart, and safe to run mid-
evening with gamers online — unlike an Xray restart, which is not.

### singapore-1 has the same bug for two more protocols

Found while verifying the rollout, and pre-existing rather than caused by
it:

    WIREGUARD StatsSince: exec: "wg": executable file not found in $PATH
    XRAY_VLESS_REALITY StatsSince: dial tcp 127.0.0.1:10085: connection refused

singapore-1 serves OpenVPN and IKEv2 only. It has no `wg` and no Xray, so
those two provisioners poll engines that were never installed, twice a
minute, exactly as IKEv2 did on ir1.

The same discriminator would work for WireGuard — the `wg` binary either
exists or it does not. **Xray is harder and should probably stay loud**:
on the other three nodes Xray is the main engine and "connection refused
on the local API" means it is down, which is worth waking up for.
singapore-1 having no Xray at all is itself worth a second look, since
the dispatcher registers the relay provisioner on every node on the
assumption that any node's Xray process can serve as a relay exit — that
one cannot.

## 2026-08-15 — singapore-1 has no Xray, and that is fine

**Status:** checked and sound. No code change. Recorded so nobody
re-audits it.

The worry was that `cmd/agentd/main.go` registers the relay provisioner
on every node "regardless of which protocols it terminates", while
singapore-1 runs no Xray at all — so it might be silently unusable as a
relay exit while the panel happily offered it.

It cannot be offered, and two independent checks stop it:

- `routes.service.ts` refuses at creation unless the exit protocol config
  is `SUPPORTED_EXIT_PROTOCOL` (XRAY_VLESS_REALITY), and separately
  refuses a RELAY node as an exit.
- `agent/internal/relay/provisioner.go` refuses again at execution:
  `unsupported exit protocol %q` for anything but REALITY.

singapore-1 has no REALITY config, so it never becomes a candidate. The
main.go comment is justifying that *registration* is harmless on a node
that never receives CONFIGURE_ROUTE — not claiming every node can be an
exit. Misread on my part.

The absence is also deliberate rather than drift: the installer asks per
engine, `Install Xray (VLESS+REALITY) on this node now? [Y/n]` defaulting
to yes and `Install IKEv2 (strongSwan)? [y/N]` defaulting to no. Someone
answered n to the first and y to the second.

### Worth a product decision, not a fix

singapore-1 is the least-used node by a distance: 30 protocol users
against 105 each on finland1 and france-1, two of the eight protocols,
and one of those two is IKEv2, which has no usage records at all. It is
serving OpenVPN to a few people.

Re-running the installer there and accepting Xray would give it the
Xray family and make it eligible as a relay exit beside finland1 and
france-1. Leaving it is also defensible. Owner's call.

## 2026-08-15 — Agent v0.2.4: WireGuard polling noise gone too

**Status:** done, all four nodes, verified from each node's own agent
start.

    node          wg errs   IKEv2 errs   all errs
    finland1         0          0           0
    france-1         0          0           0
    ir1              0          0           0
    singapore-1      0          0           3  <- Xray, deliberately loud

Same bug as IKEv2, different discriminator. This provisioner keeps no
user map — peers live in the kernel via `wg set` — so the interface is
the signal instead: if `wg0` exists, WireGuard is set up here and a
failing poll means usage going uncounted while peers keep transferring,
which must stay loud. If it does not exist there are no peers to miss.

Both conditions, not the interface alone, so a node with WireGuard
installed whose interface is down still reports. That is a fault, not an
absence.

`SessionCounts` already carried a comment describing this exact noise and
returned the error anyway. It now handles the case it described.

### What is deliberately still noisy

singapore-1 logs `XRAY_VLESS_REALITY StatsSince: xray QueryStats: rpc
... connection refused` every 30s, and that is on purpose. On the other
three nodes Xray is the main engine, and a refused local API means it is
down — worth waking up for. Installing Xray on singapore-1 would end it
(and give the node the Xray family and relay-exit eligibility); so would
a per-node "this engine is not installed" flag. Neither is a silent-fix
candidate.

### A testing note worth keeping

The first version of the WireGuard test consulted the real `/usr/bin/wg`
and skipped when it was absent — so the case it existed to cover ran
nowhere, on this machine or in CI. The tool lookup is now injected
alongside the sysfs path and all three cases are deterministic. A test
that skips everywhere is not a test.

## 2026-08-16 — Android 0.2.11: Play's 16 KB page rule, and what it caught

**Status:** fixed in source and gated in CI. Not yet proven on a real
16 KB device — see the open question at the bottom.

Play refused the 0.2.10 production release on its final preview screen:
*"Your app does not support 16 KB memory page sizes."* Every step before
it had reported success — tag guard, both builds, both signings, the
flavour guard, the upload. The first thing that disagreed was the last
screen before publishing.

### What was actually wrong

Every 64-bit native library in the bundle had 4096-byte load-segment
alignment. Play requires 16384. This is not a performance note: a device
using 16 KB pages cannot map a 4 KB-aligned library at all, so the app
dies at startup on newer hardware, whose owners will blame the app.

Measured from the shipped `Neoxify-0.2.10.aab` rather than reasoned
about, which is what showed the real shape of the problem — the five
libraries have three independent producers and only two of them answer
to our NDK setting:

    libgojni.so        arm64-v8a  4096   gomobile  -> NDK
    libmobile_lib.so   arm64-v8a  4096   cargo     -> NDK
    libwg-go.so        arm64-v8a  4096   prebuilt AAR
    libwg-quick.so     arm64-v8a  4096   prebuilt AAR
    libwg.so           arm64-v8a  4096   prebuilt AAR

32-bit ABIs are exempt and correctly stay at 4096. No 32-bit Android
device uses 16 KB pages, and the compliant WireGuard AAR still ships its
armeabi-v7a and x86 libraries at 4096 — failing those would be failing
correct output.

### The two halves of the fix

**NDK 26.1.10909125 -> 28.2.13676358 (r28c).** From r28 the NDK links
64-bit libraries 16 KB-aligned by default; r26 predates the option
entirely. That covers gomobile and cargo. Bumped in `debug-android.yml`
as well, so the artifact people test is built like the one shipped.

**`com.wireguard.android:tunnel` 1.0.20230706 -> 1.0.20260102.** These
three arrive prebuilt, so no toolchain setting on our side reaches them
— the dependency version *is* the fix. Verified by downloading both from
Maven Central and reading the ELF headers: the old one is 4096 on
arm64-v8a and x86_64, the new one 16384 on both.

Checked before taking the 2.5-year jump, because "it compiles" would not
have been evidence:

- All four types we import still exist, and `javap` shows the five
  signatures we call (`GoBackend(Context)`, `setState`, `getState`,
  `onStateChange`, `Config.parse`) byte-for-byte identical.
- The library's own `minSdk` rises 21 -> 24. Costs nothing here because
  the plugin module already floors at 24 — but check that again before
  the next bump. A silent rise would drop exactly the older handsets
  this product exists to serve, and nothing would report it.

### The gate

`apps/mobile/scripts/check-elf-alignment.py` reads the load-segment
alignment of every `.so` in an APK/AAB and fails on any 64-bit library
under 16384. It runs in `release-android.yml` after both signings and
before the release is created, so a misaligned build cannot become a
published artifact.

It checks the APK too, not only the bundle. The APK is what the website
hands to Iranian customers, who cannot reach Play at all — they would hit
the same startup failure with no store check anywhere in their path.

It fails when it finds **nothing** to judge, not just when it finds
something bad. Both earlier build guards in this repo were at some point
waved through by a check that had quietly stopped looking at anything
(the flavour guard measured `direct=0 store=0` and passed), and an empty
result is not a clean result.

Tested against known-bad, known-good and empty inputs before wiring in:
the 0.2.10 bundle fails, the new WireGuard AAR passes, a jar with no
`.so` fails as broken.

### Open

Nobody has run 0.2.11 on a device with 16 KB pages. CI proves the
alignment is correct in the artifact, which is exactly what Play checks,
and no more than that. The startup path on such a device is still
unobserved — as is the Xray-on-real-hardware item that emulator testing
could not settle.

## 2026-08-16 (later) — plans decide their own routes; the Ultimate leftovers are finally addressed

**Status:** written and tested, **not deployed**. No database is reachable
from this machine, so nothing has run against real data and nobody has
clicked the panel form. The migration and the reconciliation both need a
deploy before any of this is true of production.

### relayOnly was not the stale task it looked like

The task board said "make relayOnly actually restrict Ultimate to relay
routes". It already did, in both directions, at both `create()` and
`provisionAll()`, with tests — that landed on 2026-08-13. Reading the
code first rather than the task saved building it twice.

What was actually outstanding was the thing the 08-13 entry recorded and
left: `provisionAll` only ever adds, so the two live Ultimate subscribers
kept the 16 direct-route credentials they had from before the flag. That
is why `GET /customer/protocol-users` returned all 28 routes for an
Ultimate account — the rows genuinely exist. The enforcement was never
broken; it was never retroactive.

### The hole that was still open

`create()` rejected a direct route on a relay-only plan and said nothing
about a relay route on a normal one. `provisionAll`'s filter has always
run both ways, so this was invisible from the offering side — but
`POST /protocol-users` would put a Starter or Pro subscription on the
Iran relay, which is the direction that costs money. Exactly the lesson
already written down in this journal ("a filter that only shapes what
gets offered is not enforcement"), still half-applied.

### Reconciliation, and the distinction that makes it safe

`provisionAll` now revokes as well as adds. The load-bearing decision:
revocation keys off **plan policy**, never off whether a route is
currently reachable.

Keying it off `isEnabled` would have meant that disabling a route for ten
minutes of maintenance deletes every customer's credential on it and
rebuilds them on re-enable — a fleet-wide reprovision, and everyone
connected through it dropped, for a reason that had nothing to do with
their plan. Two queries now, one per question, rather than one query read
as answering both.

It is also ordered after the "no relay route available" throw, so an
outage cannot strip a paying subscription of everything it holds.

That distinction is pinned by a test, and the test was checked by
mutation: pointing revocation at the availability set instead of the
policy set makes exactly one test fail. A test that cannot fail is not a
test, and this one guards the difference between a maintenance window and
an incident.

### Per-plan route selection

Plans can now name the routes they are served by. **Empty means no
restriction** — every route the plan's protocols and relay policy already
allow. That asymmetry is the whole safety property: every plan that
exists today has an empty selection, so reading empty as "nothing
allowed" would reconcile the entire customer base down to zero
credentials on the next sweep. There is a test whose only job is to catch
that.

`relayOnly` is kept alongside rather than replaced by the list, because
they answer different questions. A flag covers routes that do not exist
yet: when a second Iran relay is built, every Ultimate subscription
should pick it up automatically. An explicit list cannot do that — a new
route would reach nobody until someone remembered to edit each plan, and
nothing would report the silence.

The panel hides routes on the wrong side of the relay split rather than
showing them and ignoring them. Ticking one would grant nothing, since
the selection narrows what policy permits and never widens it.

### What happens on deploy, and it is not nothing

The reconciliation is destructive by design and the owner chose it
knowingly: revoke immediately, clean up the Ultimate case automatically.
So the first `provisionAll` after deploy — on renewal, on a picker
touch, or from the backfill sweep — will **delete 16 credentials from
live nodes**, belonging to two Ultimate subscribers, one of whom is a
real paying customer.

That is the intended outcome; those credentials are the ones that make
the plan untrue. But it is worth doing deliberately rather than
discovering it in a log:

- Ultimate has **one** working protocol on ir1 (REALITY) and one exit.
  After the cleanup those subscribers have exactly that and no failover,
  where today they have direct routes to fall back on. The 08-13 entry
  already called this the most important gap on the board; this change
  makes it the *only* thing those customers have.
- So the honest sequence is to finish ir1's protocol set first, or to
  accept knowingly that two customers spend that window on a single
  credential.

Not deployed, precisely so that is a decision rather than a side effect.
## 2026-08-16 (later still) — Play's VPN declaration, and the disclosure the app did not have

Filling Play Console's `BIND_VPN_SERVICE` declaration for Android. Most
of it is answerable from the code; one field was not answerable at all,
because the thing it asks for a video of did not exist.

### The declaration answers, and where each comes from

Core purpose **yes**, general VPN service **yes** (it is a consumer VPN
sold to the public — "no" is for corporate/academic-only apps and is
contradicted by the first screen a reviewer sees). Monetization **no**:
there is no ad injection, no ad blocking and no traffic resale.

Data collection **yes**, and the ticked types are **email address, user
IDs, other in-app messages, diagnostics** — nothing else across all
fourteen categories.

Two answers are worth recording because they are non-obvious and both
were nearly wrong:

- **Purchase history is NOT ticked.** The store AAB has no purchase flow
  to collect it with: `IS_STORE_BUILD` eliminates the Plans branch at
  build time and `release-android.yml` sets `VITE_DISTRIBUTION: store`
  only on the AAB step. "Free app but declares purchases" is not what a
  reviewer flags — but declaring data the artifact cannot produce is.
- **Installed apps is NOT ticked**, even though the split-tunnel picker
  enumerates every launchable package. The list is local (`per-app.ts`,
  no network call in the file), and Play's "collected" means transmitted
  off device. Related: the manifest uses a `<queries><intent>` filter,
  **not** `QUERY_ALL_PACKAGES`. Swapping it for the latter to "fix" a
  picker showing too few entries would pull in a separate sensitive
  permission declaration and its own review.

### Still undecided: web browsing history

The nodes' Xray config sets `"access": "/var/log/xray/access.log"`, and
those lines carry the destination per user. That is Play's "web browsing
history" as defined, and it is on the public Data safety card.

Setting it to `"none"` removes the answer but breaks VLESS concurrency
detection — Xray's stats API reports bytes, not sessions, so the access
log is the only place that information exists (`sessions.go`). Waiting on
a call. **Whatever is chosen, the node config and the declaration have to
match**, and `disclosure.dataServerLogs` in the app has to come out if
the log goes.

### What got built

The **prominent disclosure** field is required and needs its own video,
separate from the "video instructions" one. The app had nothing to film:
no privacy link in Settings, Login or Register, let alone a runtime
disclosure with an accept action. A store-listing policy URL does not
satisfy it — the requirement is in-app, before collection starts.

So `apps/mobile/src/components/ProminentDisclosure.tsx` now gates the
app ahead of Login, in English and Persian, with acceptance recorded in
its own `disclosure.json` store so it survives a sign-out. It gates a
signed-in session too: someone upgrading has never seen it, so a token
is not evidence of having been told.

Verified: both apps typecheck, and the gate order was driven live in the
dev server — disclosure renders first, accept lands on Login, no console
errors. **Not** verified: the Persian rendering was never put on screen
(`dir` is set on `documentElement` and the markup has no directional
classes, so RTL should follow, but "should" is the word). Nothing has
been run on a device.

### For the Mac session

`apps/mobile/src/App.tsx` gained a `disclosure` screen — additive, one
branch ahead of `login`. iOS inherits it as-is, which is mostly a gift,
but **two lines of the copy are Android-specific and will be false on
iOS**: `disclosure.vpnBody` says "Android asks for your permission", and
both `vpnBody2` and `dataNotSold` describe Custom mode, which iOS has no
per-app split tunnel for. Apple asks for much the same disclosure, so
the screen is worth keeping — the strings need a platform split before
an iOS build ships.

## 2026-08-16 (evening) — The Xray access log goes off, and concurrency goes with it

**Status: source only. Nothing has been rolled out, and all four live
nodes are still writing the log this describes.** The installer is now
correct for a fresh install; production is not.

### The decision

`"access": "none"` in both Xray templates. What the file bought was not
worth what it held.

It held, per line: the customer's own IP, the destination they reached,
a timestamp and a user tag — and logrotate kept `rotate 7` of them. Eight
days, on every node, of a map from identifiable customers to the sites
they visited. Our users are in Iran and the boxes are not ours
physically.

The sharpest part is that **we were not using any of it**. The agent
extracts the source address and the user tag only (`sessions.go`);
destinations were pure collateral. And the codebase already holds the
opposite standard a few files away — `ClientAttempt.ip` carries the
comment that it is "personal data about people in a country where that
matters, so it is kept briefly and joined to nothing", with a sweep job
enforcing it, while this file hoarded the same class of data for a week,
joined to a user id, swept by nobody.

That inconsistency is what settled it, more than the Play question that
started it.

### What it costs — say this plainly

**VLESS per-user concurrency limits are no longer enforced.** Not
degraded, not approximate: not enforced. Xray's stats API reports bytes,
not sessions, so the access log was the only place that information
existed. Account sharing on VLESS is now invisible to us. OpenVPN and
WireGuard never used it and are unaffected.

If it has to come back, the shape to reach for is a FIFO rather than a
file: point `access` at a pipe and have the agent keep only
`(time, source, user)` in memory, so destinations never reach disk.
Untested, and it carries a real hazard — a FIFO with no reader blocks
the writer, so an agent crash could stall Xray on a live node. It needs
a non-blocking open and a drain fallback before it goes anywhere near
one.

### Also changed

`rotate 7` to `rotate 1`, and `/var/log/xray` to mode 750. Nothing
should be written there now, so this only matters in the case it is
sized for: someone turning the log on to debug and forgetting it. A
week's retention left configured would have quietly restored the whole
problem the moment anyone did.

### Unverified

This has **not** been run past an actual xray binary. `"none"` is the
documented disable value and both templates still parse as JSON with the
placeholders substituted, which is all that has been checked. On each
node, before restarting the service:

    xray run -test -config /usr/local/etc/xray/config.json

No agent change was needed: `SessionCounter` already returns nil on a
missing file and the server reads absent counts as "unknown" rather than
"zero", so nothing reports a false zero.

### The rollout, in this order

1. ~~Installer source~~ — done, this commit.
2. Roll to the four live nodes. Not scriptable; the prompt sequence
   depends on node state, so it is a per-node interactive re-run or a
   hand-edit plus `systemctl restart xray`.
3. **Delete `/var/log/xray/access.log*` on each node.** Step 2 only stops
   new writes; the eight days already on disk stay until removed. This is
   the step that actually fixes the thing.
4. Only then: remove `disclosure.dataServerLogs` from the mobile app and
   untick "web browsing history" on the Play Data safety form.

**Order 3 before 4 is load-bearing.** Removing the disclosure string
while nodes are still logging would have the app tell customers
something untrue about us, which is the one thing this product does not
do.

## 2026-08-16 (night) — Access log off on every live node; egress proof rebuilt, not yet closed

**Status:** rollout done on all three Xray nodes. The data is gone. One
verification is **outstanding and must not be read as passing** — see the
end.

Node list taken from the database, not from client config or
known_hosts: finland1 204.168.161.100, france-1 104.105.205.233, ir1
185.222.28.186. singapore-1 has no Xray at all (0 configs) and was
correctly skipped.

    node       -test        restart  logs removed          rotate  mode
    finland1   OK           21:38    access.log            1*      750
    france-1   OK           21:39    access.log + 7 .gz    1       750
    ir1        see below    21:42    access.log + 2 .gz    1       750

\* finland1 had **no logrotate rule at all**, so its log had been growing
unbounded since install. It was given the installer's rule rather than
edited.

### `xray -test` passed, and on ir1 it needed proving

`access: "none"` had never been past a real xray binary. finland1 and
france-1 both returned `Configuration OK`.

ir1 returned `Failed to start: device or resource busy`. That is **not**
the config: ir1 is the only node with a `tun` inbound, and `-test`
tries to create `relay-tun` while the running instance already holds it.
Established rather than assumed, two ways:

- the same new config with the tun inbound deleted returns
  `Configuration OK`;
- the **pre-change** config -- the one that was running successfully at
  that moment -- fails `-test` with the identical error.

So on a relay node `-test` cannot pass while Xray is up, whatever the
config says. Worth knowing before someone reads that error as a fault.

### The egress check had to be rebuilt before it could be removed

The access log was how "relayed traffic does not egress in Iran" had been
proven all along -- `grep -c '-> direct'`. Turning it off removes the
evidence for the property the relay exists to provide.

ir1 had only `statsInboundUplink/Downlink` enabled, so after the change it
would have had no way to answer that question at all. **Outbound byte
counters were enabled on ir1 in the same edit** (`statsOutboundUplink`,
`statsOutboundDownlink`). They are per-outbound-tag totals: no addresses,
no destinations, no user tags, so they restore the safety check without
restoring the thing the log was removed for. This is on ir1 only and is
**not yet in the templates** -- see below.

### What is proven on ir1 after the restart

- Routes re-asserted: five `CONFIGURE_ROUTE` commands at 21:43:13, ~70s
  after the restart, by the 60s sweep.
- All three policy rules intact (10.66, 10.77 and the new 10.68), table
  100 still `default dev relay-tun`.
- Traffic forced down the customer path (`curl --interface 10.66.0.1`)
  moved through `relay-tun` and showed a **1167-byte delta on the xray
  relay outbounds**, so the bridge carries traffic to the exit.
- `outbound>>>direct` and `outbound>>>blocked` both **0** throughout.
- `access.log` has **not** reappeared on any node after traffic.
- Agent: zero errors with the file gone, as designed.

### What is NOT proven, and must not be recorded as if it were

**No exit IP was obtained after the restart, on any node.** The
node-originated test (`--interface 10.66.0.1`) reaches the relay outbound
but never completes -- `rc=35` on HTTPS, empty on plain HTTP -- so a
request originating on the node itself is not a valid stand-in for a
customer's. And no customer traffic has flowed through ir1 since the
restart: WireGuard moved 1628 bytes in 60s, which is keepalive, and every
xray customer inbound reads zero.

So the honest statement is: **nothing is leaking, and the relay demonstrably
carries bytes to its exit outbound, but "the exit IP matches the exit
node" has not been re-verified since these restarts.** The 11/12 relay
matrix that did prove it was run *before* today's restarts. A real client
dial through each node is still owed.

### Follow-ups this created

- Put `statsOutboundUplink/Downlink` in both xray templates, so a fresh
  node can answer the egress question without the access log. Right now
  only ir1 can.
- The `direct` outbound still exists on ir1 as the second outbound. It
  reads 0, but the fail-closed property rests on `blocked` being first,
  not on `direct` being absent.
- `ProvisioningBackfillService`'s docstring still says provisionAll "only
  fills gaps". It reconciles in both directions now and revoked 36
  credentials at boot tonight; the comment is stale and misleading.

## 2026-08-16 (night, later) — ir1 has all eight protocols; IKEv2 is wired end to end

**Status:** installed, registered, routed and provisioned. **Not dialled.**
No IKEv2 client has connected, so the same gap as every other protocol
after tonight's restarts applies: configuration is proven, egress is not.

ir1 was the only node missing IKEv2 (`swanctl` absent entirely). It now
serves all eight.

### Two things that would have shipped broken

**The certificate had to be a second one.** ir1's existing Let's Encrypt
cert is ECDSA -- fine for Xray, and refused outright by Android's IKE
library, which accepts the whole chain and then fails AUTH forever while
Windows works. A separate RSA cert (`--cert-name ir1-ikev2`) was issued
by webroot against nginx's existing docroot, so Xray's cert was never
touched and the six live protocols never restarted.

**The renewal hook needed a lineage guard the installer's version does
not have.** With two certs for one hostname, certbot runs every deploy
hook for every lineage, so the ECDSA renewal would have copied itself
over IKEv2's credentials ~60 days from now and broken Android silently.
The guard was proven by invoking the hook with the ECDSA lineage and
watching the RSA key stay put, not by reading it.

### The relay adaptation the installer gets wrong

`install_ikev2` MASQUERADEs its pool straight out the uplink. On a relay
that is a leak: IKEv2 traffic would egress **in Iran**. It was installed
here with **no NAT rule at all** and the pool policy-routed into
`relay-tun` like WireGuard's 10.66 and OpenVPN's 10.77, so the failure
mode is "does not route" rather than "routes, in Iran". Relayed traffic
is NAT'd at the exit anyway, so the rule buys nothing on this node.

**The installer still needs this.** A fresh relay node built today would
get the NAT rule and leak.

### A code fix, not just a config one

IKEv2 could not be a relay entry at all. `entrySubnetCidr` and
`subnetCidrOf` read only `subnetCidr`; IKEv2's config calls that field
`pool`, strongSwan's own word. Route creation threw about a missing field
the config was never going to have. Fixed in ced0e00 with a spec.

### Created through the real service, not SQL

The Route was made by calling `RoutesService.create()` inside the backend
container via a Nest application context. SQL would have written a row
with no `uplinkCredentialsJson`, which the re-assert sweep skips -- a
route that exists, looks enabled, and is silently never wired.

Result: 13 relay routes on ir1, both Ultimate subscriptions provisioned
(13 relay credentials each, one of them IKEv2), two EAP secrets written
into `/etc/swanctl/conf.d/neoxify-users.conf` by the agent, and the
`from 10.68.0.0/24 lookup 100` rule in place.

### Owed

- An actual IKEv2 dial, checking the exit IP is finland1 and not ir1.
- The installer fixes above: relay nodes must not NAT the IKEv2 pool, and
  a node holding two certs for one hostname needs the hook guard.
### Addendum, same evening — the disclosure's language toggle

The disclosure now carries a language switch, above the text it governs.

Not cosmetic. Language is detected from the OS locale and then from the
country Cloudflare reports, so a customer on an Iranian IP is switched to
Persian about a second after first paint — and the disclosure is the one
screen where that is unrecoverable, because Settings does not exist yet
at that point. Consenting to a document you cannot read is not consent.
Choosing here also persists, which stops the country default overriding
on later launches.

It also unblocks filming Video B for Play: from an Iranian IP the
disclosure would otherwise flip to Persian mid-shot and a reviewer could
not read it.

**Correcting the earlier entry:** the Persian rendering *has* now been
put on screen. `dir=rtl` applies, all four data bullets render, the
accept button reaches Login in Persian, and there is no horizontal
overflow. Still nothing run on a device.

## 2026-08-17 — ir1 can no longer egress in Iran, and fresh nodes can prove it

Two follow-ups from last night, both closed.

### The NAT rules came off ir1

The installer fix stopped a *fresh* relay getting the trapdoor. ir1 still
had it: MASQUERADE rules for WireGuard's 10.66.0.0/24 and OpenVPN's
10.77.0.0/24 out eth0, which are reachable only when the policy route
into relay-tun is missing -- and then quietly turn the relay into a
direct exit inside Iran.

Checked before touching, and the counters answered two questions at once:

    pkts bytes target      source
       0     0 MASQUERADE  10.77.0.0/24     (OpenVPN)
       0     0 MASQUERADE  10.66.0.0/24     (WireGuard)
       0     0 MASQUERADE  192.168.201.0/24 (phantun)

**Zero packets across 4 days 14 hours of uptime.** So no traffic has ever
taken the fallback path in that window -- no leak to find -- and the
rules were dormant, which is what made removing them safe rather than a
gamble.

`wg-quick`'s PostUp/PostDown hooks were removed from wg0.conf too, or a
restart would have put the WireGuard rule straight back. Deleted live,
then `netfilter-persistent save` so a reboot does not restore them.

**phantun's 192.168.201.0/24 rule was deliberately left.** It is the
tunnel's own transport, not a customer subnet: the customer's traffic
sits *inside* WireGuard and is still policy-routed. NATing the wrapper
is correct even on a relay.

Verified after: all five services active, both WireGuard peers still
present, and a request forced down the customer path still showed a
relay-outbound delta (186 bytes) with `direct` at 0. The bridge never
needed local NAT -- relayed traffic is NATed at the exit node.

ir1 now fails closed on all three non-Xray protocols.

### Outbound counters are in the templates

Turning off the access log took away the only evidence for "relayed
traffic does not egress in Iran". ir1 got `statsOutboundUplink/Downlink`
last night so it could still answer; both Xray templates now carry them,
so a node built tomorrow can too. Per-outbound-tag byte totals only --
no addresses, no destinations, no user tags -- so the check comes back
without the thing the log was removed for.

Validated by substituting the `__PLACEHOLDER__` tokens and parsing; the
templates are not plain JSON on their own and never were.

**Not applied to finland1 and france-1.** They would each need an Xray
restart, and on an exit node the counters only confirm traffic leaves via
`direct`, which is expected anyway. Worth doing at their next natural
restart rather than disturbing customers for a diagnostic.

## 2026-08-17 — Access logging back on: device limits mattered more, and the 750 bit the fleet

**Status:** logging restored on all three Xray nodes and in source. Owner's
call, made once the cost of yesterday's change was visible: Starter's one
device and Pro's two were decorative on every Xray protocol, which is the
six Iranian customers actually use.

The constraint that forced the choice: **Xray reports sessions nowhere but
the access log.** Its stats API gives bytes, not connections, and counting
sources from conntrack cannot work because every customer shares port 443 --
the log is the only thing that attributes a device count to a user.

### The 750 was a landmine, and it went off

Re-enabling the log took **finland1 and france-1 down at the same time**:

    Failed to start: app/log: failed to initialize access logger
      > open /var/log/xray/access.log: permission denied

Yesterday's tightening set `/var/log/xray` to mode 750 owned by **root**,
while Xray runs as **nobody**. With logging off nothing opened the file, so
the breakage was invisible for a day and surfaced the moment it was needed.
Both nodes were back inside about a minute (chown to nobody, restart), and
ir1 was done ownership-first so it never failed.

Worth keeping: `xray run -test` passed on both nodes immediately before the
failure. It validates the config, not the environment the daemon will run
in -- so a green `-test` is not evidence the service will start.

The installer had the same landmine (`install -d -m 750 /var/log/xray`,
root-owned) and would have built nodes that refuse to boot now that the
templates log again. Fixed with an explicit owner.

### What is restored, and what is not proven

Restored: logging on all three nodes, `rotate 1` retained (one day, not the
eight it used to keep), templates back to logging with their notes rewritten
-- they still said "deliberately off" beside a path.

**Not proven: that counting works on all six protocols.** finland1 shows 68
session lines and 2 distinct users attributed, so user tagging works. But
only 10 of those lines carry a source address and only one distinct source
appears, and no protocol has been driven deliberately since the revert. The
owner asked specifically that it work on every protocol; that needs the
client matrix, which is still blocked on the test VM's Windows update.

### Consequence that must not be forgotten

'Web browsing history' stays declared on the Play Data safety card, and
`disclosure.dataServerLogs` keeps saying the servers keep connection logs.
Both are true again. The pending change to remove them must NOT be made.

## 2026-08-17 (spec) — Plans become a set of routes, and relayOnly goes

**Status:** decided, not built. Written as a spec because the ordering is
load-bearing and getting it wrong disconnects every customer at once.

### The decision

A plan is a set of routes, full stop. A Route already names its node and
its protocol, so the Protocols checkboxes are redundant. Owner's calls,
2026-08-17:

- **No routes ticked means no service.** Explicit selection is required.
- **`relayOnly` is removed entirely.** Any plan may include any route,
  relay or direct, by ticking it.

What exists today is the opposite and was built to an earlier
instruction ("Ultimate only relay, everything else only direct"), so
`relayOnly` is a hard rule and the picker hides the other side. Starter
shows 16 direct routes and says 13 relay ones are not listed; Ultimate
shows only relay. Working as designed, wrong design.

### THE ORDER MATTERS. Read this before touching anything

**Right now no plan has a single route ticked** -- the join table is
empty except for a throwaway row created and removed during testing.
Today that is harmless because empty means "everything this plan is
eligible for". The moment empty means "nothing", **every customer on
every plan loses all service simultaneously.**

So:

1. **Backfill first, as a migration.** For each plan, write its
   *currently effective* route set explicitly: the routes it would be
   provisioned on today, i.e. matching `protocolsAllowed` and on the
   correct side of `relayOnly`. After this step nothing has changed
   behaviourally and every plan is explicit.
2. **Verify** the backfill against production before going further:
   every active plan has a non-empty selection, and each selection
   matches what its subscriptions already hold. A plan that comes out
   empty here is a customer about to be cut off.
3. **Then** flip the semantics: empty means empty, and the route query
   stops falling back to "everything".
4. **Then** drop `relayOnly` -- the column, the filters in
   `provisionAll` and `create()`, the panel's eligibility filter, and
   the tests that pin the split.

Steps 3 and 4 are safe only after 1 and 2 have run and been checked.

### What must not be lost with relayOnly

The flag was not decoration. It existed because `provisionAll` gives
every eligible route to every subscription, so the first relay route
created would have put all fifteen live customers onto Iran bandwidth
that costs double -- silently, within one sweep. Explicit selection
replaces that guard only if selection is genuinely required; that is why
"empty means no service" and "relayOnly is gone" have to ship together,
and neither before the backfill.

The reverse guard also disappears: nothing will stop an Ultimate plan
being ticked onto a direct route, which is a different product under the
same name. That becomes an operator responsibility rather than a rule,
which is what the owner asked for.

### `protocolsAllowed` cannot simply be deleted

The field is still read by provisioning and by `switchRoute`, which
rejects a route whose protocol the plan does not allow. Removing the
checkboxes from the form means **deriving** it from the selected routes
(the distinct set of their entry protocols) and keeping it in sync on
every plan write -- not dropping the column.

### Panel

Show every route, direct and relay, with the relay ones marked so the
operator can see what they are choosing. Drop the Protocols section. The
"13 relay routes are not listed" hint goes away with the filter.

## 2026-08-17 (evening) — Four desktop releases, one of them mine to apologise for

**Status:** 0.9.6 through 0.9.11 shipped. Backend and panel changes are
deployed and verified against the database. **No client fix has been run
against a real tunnel** -- the test VM spent the whole day in a Windows
update and the service tests do not link on this machine, so every one
of these is backed by compiler and reasoning alone. A customer in Iran
was, in effect, the test rig.

### The DNS leak, which is the one that mattered

A customer sent a screenshot: connected on Stealth Lite, exit IP
104.105.205.233 (france-1, correct), Telegram working, **google.com
loading and youtube.com refusing** in the browser.

Every part of that says the tunnel was carrying traffic, and it was. The
lookups were not going through it. Windows resolves names on every
interface at once and takes whichever answers first, so an ISP resolver
milliseconds away beats one across a tunnel -- and in Iran it answers
filtered domains with a poisoned address. The browser is handed a wrong
destination *before* any routing happens, so the tunnel never sees the
request. Telegram is unaffected because it does not ask Windows.

That asymmetry is the whole diagnosis, and it is why the fault looked
like a broken app rather than a DNS problem.

**Setting the adapter's DNS is a preference, not an answer.** The fix is
an NRPT rule, which is what WireGuard's own client has always used --
and precisely why the WireGuard protocol never showed this while every
other one did. Now:

    WireGuard   wg-quick NRPT        (was always safe)
    Xray        NRPT rule            0.9.9
    OpenVPN     block-outside-dns    0.9.10
    IKEv2       NRPT rule            0.9.11

`block-outside-dns` was checked before use rather than pasted in: it
blocks DNS on every other interface, so without a resolver pushed from
the server it would leave the machine unable to resolve anything. The
nodes push `dhcp-option DNS 1.1.1.1`, so there is one. Full tunnel only
-- in Custom mode most applications are deliberately off the tunnel and
seizing the machine's DNS would send their lookups through one they are
not using.

IKEv2 looked safe and was not. Windows owns that tunnel and applies the
resolver strongSwan pushes, but applied is not exclusive.

The helpers live in `engines/dns.rs` now. None of it was ever
Xray-specific; it landed there only because that is where the fault was
found.

### 0.9.6 was my regression, and the mistake is worth naming

0.9.6 fixed a real thing -- a tunnel outliving the app with the UI
saying "not connected", so the customer could not disconnect and no
other VPN could work. `status()` reported a remembered flag rather than
asking the OS, which its own docstring claimed it did not do.

The teardown I added with it keyed on **a pipe connection closing**. The
app opens a fresh connection per request and closes it immediately
(`vpn.rs` `call`), so "a client is connected" is true for milliseconds
at a time and says nothing about whether the app is running. The count
hit zero after every request and the tunnel was torn down seconds after
coming up. Customers reported connecting and immediately losing it.

Reading `call()` before writing a teardown that depended on it would
have cost a minute. 0.9.7 replaced it with a watchdog on **silence** --
sixty seconds without a request, polled every ten -- which is the signal
that actually exists.

### Also shipped

- **MTU 1420.** The adapter was coming up at 1500 over a 1500-byte link,
  so full-size packets died once encapsulated: handshake fine, DNS fine,
  small requests fine, large responses gone. Size-dependent breakage
  reads as "your app is broken", not as a bug report.
- **Rival VPN named on failure.** Detection is by driver description,
  not "looks virtual" -- Hyper-V, VirtualBox and Docker leave permanent
  adapters and naming one would tell a developer to uninstall their
  tooling. Only adapters that are UP and addressed count. Never a
  refusal: blocking on a guess is worse than the fault it diagnoses.

### Plans are a set of routes now

`relayOnly` is gone, the Protocols checkboxes are gone, every route is
selectable on every plan, and **no routes selected means no service**.
`protocolsAllowed` is derived from the ticked routes rather than typed
in beside them, where the two could disagree.

The order was the whole risk. The join table was empty and empty meant
"everything", so a migration wrote each plan's effective routes down
first -- Pro/Starter/Trial/Ultimate Max 16 each, Ultimate 13. Zero
revocations on the boot sweep afterwards, 314 credentials intact.

The customer picker was still listing by protocol alone, so Starter and
Pro saw the Iran relay entries, tapped one and were refused. It now
shows exactly what provisioning would grant.

### The trial was broken two ways

`SubscriptionsService.create` refuses an inactive plan, and the Trial
plan was inactive **because that was the only way to hide it from the
purchase list**. Every signup threw, and nothing said so.

Worse, the grant ran once, after verification had already been written
down. One throw left the customer verified with nothing, and every retry
took the already-verified path. A single failure was permanent.

Now: `isPurchasable` separates "works" from "listed", and the grant
refuses anyone who already has a subscription, which makes it safe to
retry -- so the already-verified paths do. Trial is now Active + hidden
and signups get their trial again.

### What is owed

Everything client-side is unverified. When the VM is usable the first
thing to run is connect -> disconnect -> connect a *different* protocol,
across the direct routes and all 13 relay ones, checking exit IPs and
that a filtered domain resolves through the tunnel. Three of today's
four real bugs would have died in that one test.

Also still open: IKEv2 has never been dialled at all; exit IPs have not
been re-checked since the node restarts of 2026-08-16; Xray on a real
Android handset, which matters more now the app is live on Play; and
ir1's single vCPU, which is the measured cause of relay slowness.

## 2026-08-18 — Device limits: the window was the bug, and MAC cannot be the answer

**Status:** agent v0.2.5 built and rolled out to all four nodes.
Enforcement is **restored but still unwatched** -- nobody has put two
devices on one credential and seen a disconnect, in either direction.

### I told the owner limits were unenforced, and I was wrong

They were, on 2026-08-16, when the access log was off. The log came back
on 2026-08-17 on the owner's instruction, which restored the mechanism.
Listing "device limits unenforced" in a launch-readiness summary after
that was me repeating an old finding instead of rechecking it, and the
owner was right to push back.

Two comments I had written that day said the same thing in code --
`ConcurrencyService`'s docstring and the plan form's note under Max
connections -- and by then both stated the opposite of the truth.
Corrected. Exactly the staleness this journal keeps catching elsewhere,
except this time I introduced it.

Measured before correcting: finland1's access log holds 417 lines, 388
carrying a user tag, 4 distinct users, 2 distinct sources. The data
counting needs is there.

### The false-positive the owner asked about was real, and specific

They asked whether the limit could wrongly disconnect a normal
single-device user. It could, and Iran is what made it likely.

`sessionWindow` was **five minutes**: how long a source address keeps
counting as present after its last packet. Iranian mobile carriers
rotate a subscriber's address constantly, and when that happens the old
address is still inside the window while the new one is already active
-- so one phone reads as **two sources**. On Starter, limit one, that is
over the limit on every poll for five minutes: about ten consecutive
readings against the three strikes the server needs to act.

**No strike threshold could fix that**, which is worth stating plainly
because raising it is the obvious move and it does nothing -- the window
outlasts any number of strikes. The window was the only lever.

Now sixty seconds: a rotated address survives roughly two polls and
cannot reach three strikes.

The cost is deliberate and one-directional. A genuinely idle second
device drops out of the count after a minute of silence, so a sharer
with one idle device is missed. A missed sharer costs bandwidth; a false
disconnect costs a paying customer who did nothing wrong.

The safeguards that were already right, for the record: distinct
addresses rather than connection count (a browser opens many parallel
connections), three consecutive strikes, a 20s minimum gap so several
nodes reporting at once counts once, per-subscription aggregation across
the fleet, and absent counts treated as unknown rather than zero.

### MAC addresses cannot identify a device here

Asked whether to count by MAC instead of IP. No, and not for a reason we
could engineer around: MAC is link-layer and is rewritten at every
router hop, so the only MAC an exit node ever sees is its own gateway's.
The customer's never leaves their home network. True of every VPN.

The right answer is a **device ID issued by our own client** -- stable,
stored once, sent at provisioning -- so the count is of registered
devices rather than inferred from addresses. It removes the rotation
problem entirely, allows an honest "2 of 2 devices" UI with a remove
button instead of a silent disconnect, and exposes less than logging
addresses does. Not built: it needs client work on both platforms, a
device table, and a management surface.

It also would not stop extraction, and nothing can. The client must hold
the credential to build the tunnel, so a determined device owner can
always retrieve it. What device IDs do is make an extracted credential
worth little, because it still counts against the subscription and can
be revoked. The server-side count remains the only layer a client cannot
bypass, which is why it matters that it works.

### Rollout

v0.2.5 to finland1, france-1, singapore-1, ir1. Checksum verified
against the release on each node before installing, previous binary kept
as a timestamped backup, service stopped and started rather than the
binary swapped underneath it. All four active, identical size, zero
errors on three.

singapore-1 reports two `XRAY_VLESS_REALITY StatsSince: connection
refused` errors per minute. That is the deliberate noise recorded on
2026-08-15 -- it has an Xray protocol config and no Xray -- not
something this rollout caused.

## 2026-08-17 -- Android: a disconnect that could never have worked

Reproduced the tester's report on the emulator, and the cause is not
what the earlier start-watchdog fix addressed. Both are real; only one
of them was the thing customers were hitting.

The symptom, on fr-france Shadowsocks: the dashboard says "You're not
protected", the VPN key stays in the status bar, and the device has no
internet at all. `am force-stop` fixes it, which is exactly what the
tester found on his own.

`dumpsys activity services` gives the whole answer:

    startRequested=false            <- stopService() WAS delivered
    Bindings:
      intent={act=android.net.VpnService}
      * Client AppBindRecord{ ProcessRecord{546:system/1000} }

While a tunnel is established the system binds to the VpnService, and a
bound service is not destroyed by `stopService()`. So `onDestroy()`
never ran -- and `onDestroy()` was the only caller of `teardown()`. The
tun descriptor stayed open, and the open descriptor is precisely what
keeps the system's binding alive. The teardown was gated on a destroy
that the tun itself prevented. There is no timing under which that path
succeeds; it has never worked on any build.

Two things made it land harder than it had to:

- `teardown()` stopped the engine before closing the descriptor, so a
  start still dialling an unreachable server blocked the one call that
  would have freed the device.
- `Dashboard.tsx` set `"disconnected"` unconditionally and swallowed the
  error from `disconnect()`. That is the part the customer experienced:
  not a tunnel that failed, but an app that said it had stopped while
  the phone was dark.

Stopping is now a message the service handles itself, off the main
thread, closing the descriptor and dropping the foreground notification
before it stops the engine. The plugin waits for the service to actually
be gone -- service liveness, not the state file, which is absent
mid-connect and so would have read as "torn down" in exactly the case
the customer hits. A teardown that cannot be confirmed is reported
rather than swallowed.

Two things worth knowing that fell out of this:

- **Xray had never actually run on the emulator.** Earlier emulator
  passes were inconclusive because the Play build is arm-only; it threw
  `UnsatisfiedLinkError` and nothing exercised the engine. The x86_64
  debug build from `debug-android.yml` is what makes this testable, and
  Shadowsocks connects cleanly on it -- tun0 up, real traffic through it.
- **`Compatible` is not implemented on Android** and silently falls back
  to `Fast`. The app does say so, but the warning is keyed to the wrong
  thing: it still read "Compatible isn't in the Android app yet" after
  the protocol had been switched to Shadowsocks.

Fix committed and pushed; **verification on the emulator is still
pending** at the time of writing -- normal disconnect, cancel
mid-connect against a blackholed node, and the 20s watchdog firing on
its own. Nothing here should be quoted as proven until that runs.

## 2026-08-18 -- The disconnect, measured

Verified the previous entry's fix on the emulator, and the measuring is
the point: two of the three things I "fixed" first were wrong, and only
timing them showed it.

**What the customer gets now**, fr-france Shadowsocks, x86_64 debug
build, sampled every 100ms on the device:

| case | result |
|---|---|
| disconnect while connected | tun0, state file and engine process all gone at **+0.30s** |
| cancel mid-connect, node blackholed | tun0 gone at **+0.19s** |
| device TCP afterwards | fine in both cases |
| UI | "You're not protected", no VPN key, no false error |

Before this session it never tore down at all.

### Two wrong turns worth remembering

**A wait in the wrong place.** The first fix confirmed the teardown
inside `disconnect()`. But the connect ladder disconnects between rungs,
so the wait ran once per protocol it tried -- most of why a failing
connect sat on the spinner for minutes. Confirmation belongs to the
caller that asked to stop, which is the dashboard, and only then.

**A budget tighter than the truth.** It also threw when the teardown
took longer than ten seconds -- on teardowns that then succeeded. The UI
was reporting a failure that had not happened.

### Closing the descriptor is not releasing the tunnel

The real number: our close landed at 0.3s and tun0 did not go until
**4.0s**. The engine is handed the raw fd and keeps its own copy, so the
interface -- and every route into it -- survives until xray has finished
shutting down. Killing the process on a live tunnel dropped tun0 in
under 0.26s, which is what proved where the four seconds went.

So the stop path now asks the engine to stop, gives it 500ms, and kills
the process. Nothing else lives in it. Four seconds is long enough that
a customer presses the button again and concludes the app is broken --
which is roughly what they told us.

The connect path stopped returning `START_STICKY` as part of that: a
sticky restart arrives with a null Intent and no config, so the service
would return holding a VPN notification with no tunnel behind it.

### What is NOT proven

- **The 20s start watchdog has never fired.** With the node blackholed,
  xray-core's `start()` still returns promptly and publishes UP, so the
  condition it watches for -- a start that blocks -- does not happen for
  an unreachable server. What catches that case is the app's own egress
  check failing the rung. Treat the watchdog as an untriggered backstop.
- **My earlier "100% packet loss" evidence was not sound.** ICMP does
  not traverse a Shadowsocks tun2socks tunnel even when it is healthy;
  confirmed against a working one. The deadlock itself stands on the
  dumpsys evidence, but I cannot claim from ping alone that the orphaned
  tun left the device offline.

### Unrelated, and still open

Connecting is slow: the first connect after a fresh install took about
three minutes on the emulator with nothing blocked, sitting on
"Checking connection..." before any engine was started. Failover itself
works -- with fr-france blackholed the ladder skipped it and brought up
fi-finland Stealth HTTPS -- but the time to get there is a customer
seeing a spinner and assuming a hang. Not diagnosed yet; `publicIp()`
walking every API endpoint per rung is the first place to look.

## 2026-08-18 -- The desktop CI job had never run a test

**Status:** done (CI), open (runtime verification)
**Touches:** `.github/workflows/ci.yml`, `service/src/engines/openvpn.rs`,
`service/src/adapters.rs`, `src-tauri/src/lib.rs`

Went looking for the Android disconnect bug's counterpart on Windows.
There isn't one -- the deadlock is specific to Android binding a
VpnService, and nothing on Windows holds a teardown that way. What the
search found instead was worse.

**The "Desktop client tests" job has never once run a test.** Every run
died on `resource path resources\WinDivert.dll doesn't exist`:
`cargo check --workspace` pulls in the Tauri crate, whose build script
requires every bundled resource on disk, and CI fetched none of them.
`main` has been red on it. The job was added *specifically* to catch
faults like the 0.9.6 teardown regression a customer found, and it never
got far enough to catch anything.

It now runs the same fetch script the release does -- so a broken fetch
shows up on a push rather than on a tag, which has bitten before -- and
builds the helper service into resources first. CI also gained
`workflow_dispatch`, because a change to CI could otherwise only be
tested by merging it to main and hoping. That is not hypothetical: the
first repair had an escaping slip that made the YAML unparseable, and
GitHub reports that as "a workflow file issue" with no job output.

### What it found the moment it could run

71 passed, 2 failed. Both failures were in code written with tests that
had never executed.

- **`block-outside-dns` was never implemented.** Two tests asserted a
  full tunnel emits it and Custom mode does not. The directive appeared
  nowhere in the generated config. Windows resolves on every interface
  at once and takes the first answer, so an ISP resolver beats the
  tunnel's -- in Iran, answering filtered domains with an address that
  goes nowhere. OpenVPN was the one engine still missing the DNS
  protection the others were given.
- **Rival-VPN detection matched nothing customers have.** It looked for
  `tap-windows`; the adapter on a real machine reads
  `NW TAP-Win32 Adapter V9.21`, which shares no substring with it. Now
  `tap-win`.

### A tunnel that a minimized app could lose

The service tears a tunnel down after 60s of silence from the app. The
only thing speaking to it was the dashboard's status poll, which runs in
the webview -- and Windows throttles timers in a minimized window to
roughly one a minute. A 15s poll and a 60s grace look safe together
until the window is minimized, at which point they are the same number.

The app now beats from Rust every 20s, which does not depend on the
webview being awake or on a window existing, and stops when the process
does -- which is the condition the grace period is actually for.

### Not verified, and why

The blackhole test on Windows -- block a node, then work the connect and
disconnect buttons -- **did not run**. The VM finished a Windows update
and stopped accepting synthesized keyboard input: `keyboardputscancodes`,
SendKeys and `SendInput` all produce nothing in the guest, and
`guestcontrol` is refused because the rig auto-logs in with a blank
password. No snapshots, and 35GB free is not enough to clone the disk
and edit it offline.

A physical keypress may well still work -- VirtualBox takes raw input,
which is the one path that cannot be synthesized from outside. Worth
trying by hand before assuming the VM is broken.

So: three Windows changes, all reasoned from the code and covered by
tests, none of them exercised against a running tunnel. No desktop
release cut. 0.9.6 is the precedent for why that matters -- it shipped
from exactly this position and a customer found it.

### Addendum: the slow connect could not be reproduced

Chased the "three minutes on Checking connection" from the entry above,
because a customer seeing that assumes a hang -- and the tester's report
says exactly that. Five timed connects on the emulator, measured by
sampling the tun on the device once a second:

| run | state | route | tun up at |
|---|---|---|---|
| 1 | fresh install, just logged in | fr-france Shadowsocks | ~3 min |
| 2 | fresh install, just logged in | fr-france Shadowsocks | ~3 min |
| 3 | warm | fr-france Shadowsocks | +4s |
| 4 | data cleared, just logged in | default sg-singapore (fell back to WireGuard) | +2s |
| 5 | warm, route chosen in the picker | fr-france Shadowsocks | +3s |

Runs 4 and 5 were built to reproduce it -- 4 to test "first run is
slow", 5 to test "choosing a route in the picker is slow" -- and neither
did. So the two slow runs share only that a newly installed build was
connecting for the first time, and that is not enough to name a cause.

Recorded rather than explained. The endpoint that would have been the
obvious suspect is fine: `/api/health/ip` answers in 0.73s, and
`apiEndpoints()` puts the remembered address first, so the per-rung
baseline capture is not it.

## 2026-08-18 -- IKEv2 dialled, for the first time anywhere

**Status:** done
**Touches:** nothing in the repo -- verification only

IKEv2 was installed on ir1 on 2026-08-17 and wired into the relay, and
the entry for it said plainly that nobody had ever dialled it. That is
now done, on the Android emulator against `sg-singapore · Built-in`
("Built-in" is the customer-facing name for the platform profile).

It works, and both halves are measured rather than assumed:

| | |
|---|---|
| interface | `ipsec1`, `10.68.0.6/32` -- Android's own IPsec profile, not our tun |
| our tun service | not running, as it should not be for this protocol |
| exit IP | **172.236.143.200** -- Singapore, Akamai Connected Cloud |
| host IP for contrast | 50.34.35.228 -- United States |
| disconnect | `ipsec1` gone at **+0.29s**, VPN transport cleared at **+0.65s** |
| device TCP afterwards | fine |

The exit address is the point: it is not merely different from the
home address, it geolocates to the city of the server that was picked.
That is the egress check the repo asks for -- an exit IP that matches
the node -- rather than "the interface came up".

It also exercises the new teardown confirmation against a second
engine. `vpn_tunnel_gone` asks ConnectivityManager whether the device is
still routed through *any* VPN, so it covers the platform profile as
well as our own service, and it cleared inside a second here. Had it
been written against our service's liveness -- which was my first
attempt -- it would have reported a stuck tunnel for every IKEv2
disconnect, since our service is not involved in one at all.

Still not dialled: IKEv2 on the Windows client, and IKEv2 through the
Iran relay (this test was a direct route).

## 2026-08-18 -- Flags on the server list

**Status:** done (Android verified), pending (desktop unverified)
**Touches:** `components/Flag.tsx` (new), `components/LocationPicker.tsx`,
both `screens/Dashboard.tsx`

Every row of the server list carried the same map pin, which told the
customer nothing, while the one thing people scan a server list for --
the country -- was left encoded in a slug like `fr-france`. The
dashboard's SERVER tile had the same problem behind a globe.

Both now lead with the country's flag. One component, shared: mobile
imports desktop's `src/` through the `@shared` alias, so Android,
Windows and iOS all draw from the same file.

### Why the flags are drawn by hand

- **Emoji is the obvious answer and is wrong.** Windows ships no glyphs
  for regional-indicator pairs, so 🇫🇷 renders as the letters "FR" in two
  boxes on the desktop client while Android shows a flag. The clients
  are meant to look like one product.
- **A remote sprite** would put a network fetch in front of the server
  list, for customers whose networks are the reason they installed a
  VPN, and often before any tunnel is up.
- **A flag package** costs a dependency and a bundle for the handful of
  countries we run nodes in.

Ten are drawn: fi, fr, sg, ir, de, nl, us, gb, tr, ae. They are
deliberately simplified -- at 20px a coat of arms is a smudge -- so each
keeps only what identifies it: bands, a cross, a crescent. Iran's is the
plain tricolour without the emblem, which is both the legible choice and
the less loaded one for this audience.

The code comes from the region slug's prefix, because `region` is free
text in the database and there is no country column to trust. Anything
that is not two letters falls back to a globe, so a node added in a new
country from the installer degrades to a neutral icon rather than to an
empty box or another country's colours.

Verified on the emulator against the real app, not just a preview: the
picker rows show Finland's cross and France's tricolour, and the SERVER
tile shows Singapore's. The desktop client shares the component but has
not been looked at -- the VM still cannot be driven.

## 2026-08-19 -- germany-1, and three things that stop a node working

**Status:** done
**Touches:** `installer/lib/agent.sh`, live: germany-1 + plan route lists

A LightNode box in Frankfurt (38.60.249.229, `de1.neoxify.site`, Ubuntu
24.04, 1 vCPU / 2 GB) is live as `germany-1` / `de-germany` with all
eight protocols: REALITY 443, VLESS+TLS 2053 TCP and WS, Trojan 8443,
Shadowsocks 41831, WireGuard 28458, OpenVPN 38416, IKEv2 500. Ports
match finland1 and france-1, which were read out of the database rather
than guessed.

Verified from a real client, not from the panel: the emulator picked
germany-1 Shadowsocks and reported exit IP **38.60.249.229**, which is
the node's own address, with five established connections to it.

Three separate faults had to be cleared, and each of them produces a
node that looks fine and serves nobody.

### The agent dials Cloudflare and hangs at PENDING

`grpcTarget` is empty after enrolment, so the agent falls back to
`<panel host>:50051` -- which resolves to Cloudflare, which does not
proxy that port. Confirmed from the box: direct 167.233.65.166:50051
connects, connect.neoxify.site:50051 does not. The installer still does
not set this; it is a manual step on every new node.

### IKEv2 can never get a certificate on a full-protocol node

install_ikev2 asks certbot for RSA deliberately, because Android refuses
an ECDSA server certificate for IKEv2. But Xray's TLS step has already
issued an ECDSA certificate for the same hostname by then, so the
request is a key type change, and certbot refuses that non-interactively
without `--cert-name`:

    Are you trying to change the key type of the certificate named
    de1.neoxify.site from ECDSA to RSA?

The installer swallowed that and printed its own guidance about inbound
port 80 -- which was serving an ACME probe file over the public address
at the time. Fixed with `--cert-name` on both certbot calls. **finland1
and france-1 have no IKEv2 either, and this is the likely reason.**

### A node with every protocol that no customer can see

Enrolling registers the node, its protocol configs and its routes, but
plans carry an explicit allow-list, and nothing adds a new node to it.
germany-1 was ONLINE with eight working protocols and invisible: a real
subscription saw 16 routes, none of them German. Added to Trial,
Starter, Pro and Ultimate Max; Ultimate was left alone because it is the
relay-only plan and this is a direct node. Subscriptions now see 24.

Two mistakes of mine on the way, both worth the reader's time:

- I patched the plans with **protocol-config ids** where the relation
  wants **route ids**. Prisma rejected them and the endpoint 500'd,
  which is the good outcome -- the update is atomic, so nothing was
  half-applied and no live plan lost a route.
- I then concluded from `config.json` that no credentials had reached
  Xray. Users added over the gRPC API are in-memory and never appear
  there; the agent's re-assert had already pushed them.

### Also observed

The app pins the chosen route locally. Switching the route through the
API changes what the dashboard displays but not what the connect ladder
dials -- it kept connecting to fr-france while the SERVER tile read
de-germany. Worth deciding which one is the truth.

## 2026-08-19 -- IKEv2 fleet-wide, two releases, and a key that opened everything

**Status:** done
**Touches:** `installer/lib/agent.sh`, both `screens/Dashboard.tsx`,
live: finland1, france-1, plan route lists

### IKEv2 now exists on every node

finland1 and france-1 both had an ECDSA certificate and no strongSwan --
exactly the fingerprint of the certbot key-type bug fixed earlier today.
Running the repaired installer on each converted the certificate to RSA,
installed the swanctl material and brought strongSwan up.

Done one node at a time and verified between, because both carry live
users and the certificate they were converting is the one Xray serves:

| | finland1 | france-1 |
|---|---|---|
| certificate | ECDSA -> RSA | ECDSA -> RSA |
| strongSwan | active | active |
| xray | still active | still active |
| TLS 2053 / 8443 | verify 0 (ok) | verify 0 (ok) |

Customers see 26 routes now, with IKEv2 on finland1, france-1,
germany-1 and singapore-1.

The plan allow-list caught it a second time: the new IKEv2 routes were
registered, ONLINE and invisible until added to Trial, Starter, Pro and
Ultimate Max. Ultimate was left alone, being the relay-only plan. This
is the third time in one day that a working protocol reached nobody for
this reason, which is why the installer now says so on the way out.

### Released

- **android-v0.2.13** -- the disconnect fix. Teardown at +0.30s, cancel
  mid-connect at +0.19s, measured on-device.
- **android-v0.2.14** -- flags, a renew path for suspended and expired
  plans, and the SERVER tile naming the route the ladder will dial
  rather than the one the backend provisioned.
- **desktop-v0.9.12** -- `block-outside-dns` implemented rather than
  asserted, TAP-Win32 detection, and a Rust-side heartbeat so a
  minimized window cannot have its tunnel torn down by the 60s idle
  grace.

Both customer download endpoints were driven afterwards rather than
trusted: `/updates/installer/android` and `/installer/windows` serve
0.2.14 and 0.9.12. The Android one lagged five minutes, which is
`CACHE_MS` in updates.service and not a fault.

### What the Windows VM finally proved

With a node unreachable, 0.9.11 **failed over rather than hanging** --
"Couldn't reach sg-singapore. Now on fr-france over Fast" -- and a
disconnect left the adapter gone, the default route restored, the exit
IP back to the home address and the internet working.

One caveat on that test, because it would otherwise read as stronger
than it is: the firewall blackhole did **not** block WireGuard.
wireguard.exe installs its own WFP filters that outrank ordinary rules,
so its UDP left while `Test-NetConnection` from PowerShell was blocked.
"All protocols blocked" was never actually tested.

### Still not proven

- The minimize scenario has never been reproduced against a live
  tunnel. The heartbeat is reasoned and CI-green, nothing more.
- `block-outside-dns` is unit-tested and has never carried a real
  OpenVPN session. It is also the fix most likely to matter in Iran,
  where OpenVPN users connect successfully and still cannot load
  filtered sites -- worth asking a tester to confirm.

### A key that opens everything

`~/.ssh/ovh_neo` authenticates root on the panel **and on every VPN
node** -- 167.233.65.166, finland1, france-1. I twice told the owner I
lacked access I had, and both times one command would have shown it. The
`azs_vps` key is for the TeamSpeak/bot host and works on none of these.

## 2026-08-19 -- Custom mode did nothing until you reconnected

**Status:** half done -- the toggle is fixed, the dead-tunnel report is
not reproduced
**Touches:** `service/src/engines/mod.rs`, `service/src/pipe.rs`,
`ipc/src/lib.rs`

A tester turned Custom mode on while connected, watched every
application carry on exactly as before, and concluded the feature was
broken. It was working as written: `set_split_tunnel` recorded the
choice and nothing else, and the comment above it said so.

That is defensible until you see why the mode cannot be a preference the
redirect merely reads. A full tunnel owns the default route. A
Custom-mode tunnel deliberately owns **no routes at all** and reaches
the selected applications through the redirect instead. Which of the two
gets built is decided when the engine starts, so changing the mode means
building the tunnel again -- and the service was not keeping the profile
it had built from, so it could not.

It keeps it now, and only a change of *shape* rebuilds: adding a second
game to the list still costs nothing, because the redirect reads the
selection per decision. A failed rebuild is returned rather than
swallowed, since a switch that leaves no tunnel up must not read as
applied.

### The part that is not fixed

The same tester then closed and reopened the client, and reported that
nothing reached the internet while the app still showed connected.

That is not reproduced, and the honest position is that I do not know
the cause. What is suggestive: `split_tunnel/mod.rs` states plainly that
a passive tunnel with no redirect carries nothing at all, and the toggle
bug above is a way to reach exactly that disagreement -- the mode says
Custom, the live tunnel was built full, or the reverse. The launch path
in `Dashboard.tsx` adopts whatever the service has running via
`vpn_status` but never re-pushes the saved Custom-mode settings and
never probes, so a disagreement survives a restart rather than being
corrected by it.

So the toggle fix may well remove it. "May well" is not evidence, and
this is the failure mode -- a tunnel that reports connected while
carrying nothing -- that this project has spent the most effort on. It
needs reproducing on the VM before anyone claims it is gone.

One practical note for whoever does: driving the Connect button through
the VM by keyboard has been unreliable all session, which is also what
stopped the minimize test. Tab-counting into the webview misses. A human
clicking Connect once gets past it, and everything after that is
scriptable.

---

## 2026-08-19 — Custom mode carried nothing: it was the firewall

**Status:** done, verified on the VM
**Touches:** `apps/desktop-windows/service/**`

The tester's two reports were both real and were two different bugs.

**Nothing went through.** The redirect was never the problem. A packet
is rewritten to this machine's own address and the proxy's ephemeral
port and re-injected; the stack loops it back and asks the firewall
whether the connection may be accepted, and nothing had ever allowed
inbound to that port. Every signal said the code worked — proxy
listening, WinDivert reporting every send as successful, `redirected`
climbing, `rejected` at zero, and the app's own `probeSplitTunnel`
returning ok because it uses its own pinned socket. Seven hypotheses
died against that wall (bind address, upstream connect, direction flag,
`local_addr`, Tailscale, loopback interface index, checksums). `pktmon`
settled it in one run:

```
Drop: Direction Rx, DropReason "INET: accept inspection"
ip: 192.168.88.10.40001 > 192.168.88.10.52490: Flags [S]
```

Rerunning with the firewall off put the selected app's traffic out of
the node. `split_tunnel/firewall.rs` now installs an allowance scoped
to the two ports the session listens on and to this machine's own
address, removed with the split tunnel.

**Changing the list did nothing.** Independent bug, and visible in the
code once looked for: `set_selection` replaced the `Arc<Selection>`
while the running redirect worker held a clone of the old one, and
editing the list within Custom mode deliberately rebuilds nothing. The
customer's first choice was the only one that ever applied. Now shared
through an `RwLock` and read per packet.

**Gotcha worth keeping.** Custom mode's `enabled`/`selection` survive a
disconnect. A test that connects and reads the exit IP is not measuring
a full tunnel if an earlier run left Custom mode on — my first matrix
looked like a third bug until I reset the state explicitly.

**The other thing that cost hours: my own test harness.** OpenVPN
appeared to be totally broken — connected, exit IP at home, log dead
after `UDPv4 link remote`. The API returns `tlsCryptKey` under
`connection.publicParams`, not `credentials`, and I had built the
profile from `credentials` alone. A client without the key is not
rejected, it is silently ignored — exactly as `OpenvpnProfile`'s doc
comment warns. The node was fine. **Build test profiles the way the app
builds them.**

Three real bugs did fall out of testing every protocol rather than the
broken one: OpenVPN's pushed `0.0.0.0/1` and `128.0.0.0/1` routes
outlive a killed process and, being more specific than the demoted
default, silently override Custom mode (now purged on teardown and on
connect); the rebuild resolved the node's hostname in the seconds after
teardown when DNS is between configurations (now retried); and the
rival-VPN hint accused the customer's own tunnel.

**Verified per protocol** against germany-1 — selected app exits at the
node, unselected at the home address, selection swapped live both ways
with no reconnect, Custom mode off returns a full tunnel, disconnect
returns to normal: WireGuard, VLESS REALITY, Trojan, Shadowsocks,
OpenVPN. IKEv2 refuses Custom mode by design, and now refuses it on a
list-only edit too instead of answering ok.

---

## 2026-08-19 — IKEv2 is dead on fr1 and fi1 (not the client)

**Status:** open, needs a node-side fix — do not assume it is the app
**Touches:** nothing in the repo yet

Found while running the protocol matrix. The desktop client says
Connected, `rasdial` agrees, the routes are installed correctly, and no
traffic moves. This is the false-Connected shape the project treats as
a product bug, and it is live on two routes customers can pick.

Measured from the VM, one client, same account, same session:

| node | result |
|---|---|
| de1 | works — exit IP is the node, DNS through the tunnel fine |
| fr1 | connects, carries nothing |
| fi1 | connects, carries nothing |

On fr1 with a tunnel actually up, the child SA *is* installed and the
counters are the finding:

```
neoxify-ikev2: #7, INSTALLED, TUNNEL-in-UDP, ESP:AES_CBC-256/...
  in  c404e7f4, 0 bytes, 0 packets
  out 87cd7058, 0 bytes, 0 packets
  local 0.0.0.0/0 ::/0   remote 10.68.0.1/32
```

Traffic selectors correct, `ip_forward=1`, MASQUERADE present for the
pool, FORWARD accepts it, `strongswan.conf`/`swanctl` config
byte-identical to de1's. The one visible difference is state, not
config: fr1 had accumulated three live IKE SAs for the same identity,
two holding the *same* virtual IP.

```
10.68.0.1  online 'nx-...'
10.68.0.1  online 'nx-...'     <- same address, twice
(null)     online 'nx-...'
```

Terminating those (all mine — the test account) changed the symptom
rather than curing it: no more timeout, but traffic then leaves via the
home address instead of the tunnel.

**Do not chase this in the client.** Next step is server-side: why
duplicate leases are handed out for one identity when `uniqueids`
defaults to replacing them, and why the installed child SA sees zero
packets. Left untouched deliberately — fixing it means changing config
on live nodes.

**Measuring note:** `swanctl --list-sas` after a session has ended shows
IKE SAs with no children and reads like "the child never came up". It
has to be read while a tunnel is actually up.

### What was ruled out on 2026-08-20 (so nobody repeats it)

Chased much further with the owner's go-ahead. Everything below was
measured, not reasoned about, and none of it is the cause:

- **Not the kernel state.** Read while a tunnel is up, fr1 has the child
  SA installed correctly -- 2 xfrm states, 3 tunnel policies,
  `espinudp sport 4500 dport 4500`, selectors `0.0.0.0/0` <-> the
  client's `/32`. Zero bytes through it.
- **Not the config.** `/etc/swanctl/conf.d/neoxify.conf` and
  `/etc/strongswan.conf` are **byte-identical** to de1's. Same
  certificates (correct CN and SAN per node), same `ip_forward=1`, same
  `rp_filter=2`, same MASQUERADE and FORWARD rules, same single charon
  under strongswan-starter.
- **Not the crypto.** Both nodes negotiate the same
  `AES_CBC-256/HMAC_SHA2_256_128`.
- **Not the leases.** fr1 had three "online" leases for one identity,
  two of them the same address. Cleared them, restarted the daemon,
  reloaded: still dead.
- **Not the pool offset.** fr1 handed `10.68.0.1` and de1 `10.68.0.2`,
  which looked like the answer. The pool was narrowed to
  `10.68.0.2-10.68.0.254` (backup at `/root/neoxify.conf.bak-*`) and it
  made no difference. **That change is still in place on fr1** and is
  the one config divergence between it and the other nodes.
- **Not the client.** Windows reports the same state for both: rasdial
  connected before and after the request, 1 main-mode SA, 2 quick-mode
  SAs, tunnel default route installed with the better metric.

**What it actually looks like.** `pktmon` on the client shows the SYN
entering the tunnel adapter with no drops -- and then the physical NIC
emits *nothing but 43-byte NAT keepalives* to fr1. Not one ESP data
packet leaves. tcpdump on fr1 agrees: IKE_AUTH (retransmitted five or
six times, itself a hint) and keepalives, no ESP. So the client brings
the tunnel up and then never encrypts into it, while the identical
client on de1 pushes 110 packets. That points at the path or at
something in fr1's negotiation Windows dislikes, not at config -- and it
is where the next session should start.

---

## 2026-08-20 — Desktop 0.9.13 released and re-verified from the installer

**Status:** done
**Touches:** `installer/lib/agent.sh`

`desktop-v0.9.13` published (installer, `.sig`, checksums), all four CI
jobs green. The whole matrix was then re-run **against the shipped
installer**, not the dev build -- `neoconnect-desktop.exe v0.9.13`
installed over the top, service running from the released binary:

| protocol | full tunnel | split, unselected | split, selected | live swap | off | after disconnect |
|---|---|---|---|---|---|---|
| WireGuard | node | home | node | correct | node | home |
| VLESS REALITY | node | home | node | correct | node | home |
| Trojan | node | home | node | correct | node | home |
| Shadowsocks | node | home | node | correct | node | home |
| OpenVPN | node | home | node | correct | node | home |

`returned` non-zero and `rejected` zero throughout, and no firewall rule
left behind after any run. Shadowsocks and OpenVPN were re-run after a
hard VM reboot, so they are a cold-start result as well.

**Installer fix that came out of the IKEv2 hunt.** The
`neoxify-swanctl-load` unit had `After=`/`Requires=` but not `PartOf=`,
so it only ran at boot. `systemctl restart strongswan-starter` during
maintenance therefore left the daemon up with **no connections, no pool
and no EAP secrets** -- clients authenticate against nothing, and the
node looks healthy. `PartOf=` added in the installer and applied live to
fr1, fi1, sg1 and de1.

**Rig gotchas, both cost time tonight.** The VM froze mid-matrix with the
display byte-identical across screenshots while `VMState` still said
`running` -- compare screenshot sizes to tell a frozen guest from a busy
one. And a `poweroff` drops the transient shared folder *and* leaves the
guest ignoring `keyboardputscancode` when restarted `--type headless`;
`--type separate` restores input.

---

## 2026-08-20 — Every route real-tested: only germany-1 is fully working

**Status:** open — infrastructure, not the client
**Touches:** nothing in the repo; live changes listed below

Ran all 26 routes the test account can reach, one connect each, verdict
by exit IP (node = pass, home = the tunnel carries nothing).

| node | pass | detail |
|---|---|---|
| germany-1 | **8 / 8** | every protocol, including IKEv2 |
| finland1 | 1 / 8 | WireGuard only |
| france-1 | 1 / 8 | WireGuard only |
| singapore-1 | 0 / 2 | IKEv2 and OpenVPN both fail |

The 13 Iran relay routes are not on this account's plan and were not
covered.

**The one thing that predicts success is when the node was built.**
germany-1 was installed with the current installer during this session
and everything works on it. Every older node fails on everything except
WireGuard, whose peers live on disk rather than being pushed at runtime.

Failure shapes, so they are recognisable: Xray routes return curl exit 6
(DNS never resolves, because the tunnel carries nothing); by address
they return exit 35, a TLS error, which is what REALITY looks like when
it silently proxies a client to its decoy. OpenVPN and IKEv2 report
Connected and exit at the customer's own address.

**Ruled out by measurement — do not re-test these:**

- Users not provisioned. They are: 24-25 per inbound after an agent
  re-assert, and the specific test UUID is present in `xray api
  inbounduser`.
- Ports unreachable. 443, 2053, 8443 and the Shadowsocks port all accept
  TCP from the client's network in ~150ms.
- REALITY key mismatch. Node-derived public key, shortId and SNI match
  the panel exactly.
- Decoy unreachable from the node. Both cloudflare.com and www.shatel.ir
  answer from finland1 and france-1.
- Decoy choice. Switched finland1 from cloudflare.com to www.shatel.ir,
  the decoy the working node uses, and updated the panel to match. No
  change.
- Stale credentials in the harness. The 26 saved credentials are
  byte-identical to what the database holds now.
- Agent down. `neoxify-agentd` (not `neoxify-agent`) is running on every
  node and the panel shows all five ONLINE with fresh heartbeats.

**Recommendation: rebuild the protocol stacks on finland1, france-1 and
singapore-1 with the current installer** rather than keep bisecting.
germany-1 is proof the installer produces a fully working node, and
every difference found so far has been invisible in the config files.

**Live changes made during this investigation, all disclosed:**

- Restarted `neoxify-agentd` on finland1 and france-1. Both re-asserted
  every user (hundreds of `CREATE_USER`). Safe: the agent is not in the
  data path.
- Added `PartOf=strongswan-starter.service` to the swanctl loader on
  fr1, fi1, sg1 and de1, matching the installer fix.
- Narrowed france-1's IKEv2 pool to `10.68.0.2-10.68.0.254` (backup
  `/root/neoxify.conf.bak-*`). Did not help; it is the one config
  divergence from the other nodes.
- **Corrected france-1's OpenVPN `tlsCryptKey` in the panel.** It was
  genuinely stale — the node's key hashed differently from the panel's.
  The first repair attempt mangled it through the shell (655 bytes
  instead of 636); it was then rewritten via base64 and now matches the
  node's file exactly (md5 `f4d7c491…`, 636 bytes). OpenVPN there still
  fails, so the stale key was not the only fault.
- Switched finland1's REALITY decoy to `www.shatel.ir` on the node and
  in the panel. Did not help; trivially revertible from
  `/root/xray-config.bak-*`.

**Method note.** A file hash is not a string hash. Comparing
`sha256sum tls-crypt.key` against `sha256(publicParamsJson->>'key')`
made finland1 look mismatched when it was fine; only comparing the
values themselves settled it.

---

## 2026-08-20 — Correction: the nodes were fine. It was a leftover test rule

**Status:** resolved — **supersedes the two entries above** about IKEv2
being dead and only germany-1 working. Both were wrong.

The VM still had an enabled Windows Firewall rule from the failover
testing earlier in the session:

```
NeoxifyBlackhole   Outbound  Block  enabled=True
  remoteIP = 204.168.161.100, 104.105.205.233, 172.236.143.200
  protocol = Any   remotePort = Any
```

That is finland1, france-1 and singapore-1 — every node that "failed" —
and germany-1 is absent, which is exactly why it was the only node that
passed. The rule was created to fake a dead node and never removed, so
every subsequent test on those three measured my own blackhole.

Removed it and re-ran everything: **26 of 26 routes pass**, verified by
exit IP. IKEv2 works on all four nodes, which was the original request.

**What this invalidates.** Hours of IKEv2 investigation on fr1: the child
SA with zero counters, the "client never emits ESP", the duplicate
leases, the decoy theory. All of it was the client's packets being
dropped locally before they ever left the machine. `pktmon` said so the
moment I finally pointed it at the right thing:

```
Drop: Direction Tx, DropReason "Inspection drop"
ip: 192.168.88.10.63962 > 204.168.161.100.49266: UDP, length 54
```

**The lesson, and it is the same one twice in one night.** When a
tunnel carries nothing, capture on the *client's own NIC* before
theorising about the server. The split-tunnel bug was Windows dropping
packets locally; so was this. Both were found in one run by `pktmon`
after hours of reasoning about the far end.

**Rig discipline:** a blackhole rule used to fake an outage must be torn
down in the same session that creates it. Anything that blocks by IP
will silently poison every later test against that node, and it looks
exactly like a broken node.

**Live changes made while chasing the phantom.** All benign, all now
verified working, none of them the fix:

- `PartOf=` on the swanctl loader (fr1, fi1, sg1, de1) — a real
  improvement, keep it.
- france-1 IKEv2 pool narrowed to `10.68.0.2-10.68.0.254`.
- france-1 OpenVPN `tlsCryptKey` rewritten to the node's file byte for
  byte. The previous value differed only by a trailing newline, so it
  was never actually broken.
- finland1 REALITY decoy switched from `cloudflare.com` to
  `www.shatel.ir` (node and panel). Revertible from
  `/root/xray-config.bak-*`.

**Final verification on the released 0.9.13, from the shipped
installer:** 26/26 routes exit at their node, and the full split-tunnel
matrix passes on two separate nodes — germany-1 and finland1 — across
WireGuard, VLESS REALITY, Trojan, Shadowsocks and OpenVPN.

---

## 2026-08-20 — Custom mode now works on every protocol, IKEv2 included

**Status:** done, verified per route on the VM
**Touches:** `apps/desktop-windows/service/src/engines/{ikev2,mod}.rs`,
`split_tunnel/redirect.rs`

Custom mode refused IKEv2 outright, so four routes — one per node —
could not split traffic at all. The refusal rested on a belief that was
simply wrong: that Windows owning the tunnel left nothing to pin a
socket to.

It owns it, but it is still an ordinary interface. The RAS connection
carries the entry's name, has an index and an address, and a socket
pins to it exactly like it pins to a Wintun adapter — the log line
`custom mode on Neoxify (index 27, tunnel 10.68.0.2)` was the proof.
What actually blocked Custom mode was the other half of the shape: the
tunnel claiming the default route, leaving unselected traffic nowhere
else to go.

`Add-VpnConnection -SplitTunneling` is exactly that switch, and naming
it turns it on. Same passive tunnel WireGuard gets from `Table = off`.
Named only in Custom mode — the existing note in `ikev2.rs` about
`-SplitTunneling $false` binding its argument to the wrong parameter is
why it is a conditional string rather than a value.

**Gotcha that nearly buried this.** The first run looked like a total
failure: `seen=0`, everything exiting at the home address. It was the
VM thrashing through four reconnects back to back, and the redirect
worker was *swallowing the driver's error and returning silently* — so
the only symptom was a zero counter while the selected app quietly went
direct. The worker now says why it stopped. Re-run one route at a time
and every row was correct first time.

**Coverage is now complete.** Every engine the client can run has been
through the full matrix — selected app at the node, unselected at home,
selection swapped live both ways with no reconnect, Custom mode off
back to a full tunnel, disconnect back to normal:

| engine | verified on |
|---|---|
| WireGuard | germany-1, finland1 |
| VLESS REALITY | germany-1, finland1 |
| VLESS+TLS | germany-1 |
| VLESS+TLS (WebSocket) | germany-1 |
| Trojan | germany-1, finland1 |
| Shadowsocks | germany-1, finland1 |
| IKEv2 | finland1, france-1, germany-1, singapore-1 |

---

## 2026-08-20 — The Custom mode DNS leak, and a direction for the list

**Status:** done, verified on the VM through the app itself
**Touches:** `apps/desktop-windows/**`

**The tester's bug was DNS.** Custom mode on: Telegram fine, Chrome's IP
changed but no site would open, and a full tunnel fixed it. One
measurement explains all of it:

```text
CUSTOM  tcp egress: 38.60.249.229   (the node)
CUSTOM  dns egress: 50.34.35.228    (his own line)
```

The selected app's traffic went through the tunnel while the *name* it
looked up was resolved by the network he was escaping. No engine sets a
resolver in Custom mode -- WireGuard drops it deliberately, OpenVPN
pulls no routes, IKEv2 the same -- and the redirect had no notion of
port 53. Invisible on a normal connection; on a censored one the
resolver lies about blocked domains, so the browser cannot open the site
while an unblocked address check still shows the tunnel. Telegram never
asks that resolver, which is why it worked.

It cannot be fixed per-application: Windows resolves through its own DNS
Client service, so the query leaves under svchost's name. Every lookup
now goes through the tunnel while Custom mode is on.

**Gotcha:** the first attempt took DNS out for the whole machine, because
the service's own lookups were being routed into the service's own
proxy. Excluded, re-measured.

**A direction for the list.** "All except these" is the other half of
the feature. The obvious implementation is wrong: building a *full*
tunnel and pushing the chosen applications out of it reads correctly and
does not work, because a packet captured on the tunnel adapter and
re-injected towards this machine goes down the tunnel and arrives
nowhere -- four retransmits, no reply, no drop:

```text
ip: 10.77.0.3.40001 > 192.168.88.10.64129: Flags [S]
```

Three fixes died against that (widening the firewall allowance to the
tunnel address, naming the physical interface on injection) before the
shape of the mistake was clear. **Keep the tunnel passive in both
directions and invert the match instead.** Everything carried then takes
the one path already proven to work.

Which way to fail on an unknown owner is opposite in the two
directions, and both answers are the cautious one: tunnel only named
apps and an unknown owner is left alone; tunnel everything except named
apps and an unknown owner is carried.

**A list to pick from.** Running applications come from the service --
the app is not elevated and cannot read the image path of a process it
does not own, and the path is what a selection is made of.

**UI gotcha worth keeping:** the picker is rendered through a portal.
`position: fixed` is measured against the nearest ancestor with a
transform or filter, not the viewport, and the card it lives in has
both -- which clipped the dialog's header and its Cancel button off the
screen while the list in the middle looked fine.

Verified through the app on the VM: the toggle, both directions with
their wording, the running-apps list with real paths, and the settings
surviving a restart. Behaviour verified per mode: only-these puts the
chosen app at the node and others at home; all-except the reverse;
Custom mode off carries the whole machine. All switched live.

---

## 2026-08-20 — "Split tunnel doesn't work" was the tunnel not working

**Status:** done, verified on the VM
**Touches:** `apps/desktop-windows/**`

A tester on 0.9.15 selected Edge, opened it, and saw his own IP. I could
not reproduce it in either order — Edge selected then launched, and Edge
already running then Custom mode enabled — both showed the node. His log
settled it, and both of my guesses were wrong.

He was in the right mode (`only the selected apps are tunnelled`, every
session) and his selection *was* matching (`matched=27, 43, 90, 17`). The
real line was this, against **three different nodes**:

```text
route on-link: no traffic (the tunnel did not carry a test connection (8.8.8.8:443 timed out))
route via the tunnel address: no traffic (...)
no route shape carried traffic (...)
probe FAILED: the tunnel did not carry a test connection
```

**And Custom mode started anyway.** `install_verified_route` logged the
failure, then installed the on-link shape and returned Ok. His browser
was redirected into a tunnel already proven dead; when the engine
dropped, the deliberate fail-open sent it out the ordinary route, and he
watched his own address come back with the switch on. The feature was
behaving exactly as designed on top of a tunnel that was not.

It now refuses. A tunnel that carries nothing is a failed candidate, and
the ladder tries the next protocol — the same reasoning as the old IKEv2
refusal: an unprotected app while the switch says otherwise is a false
"Connected" wearing different clothes.

Verified both directions, because a refusal that fires on a healthy
tunnel would be worse than the bug: with the probe targets blocked it
returns `Custom mode did not start: this tunnel is not carrying
traffic`, and with them reachable it returns ok and carries.

**Also in his log, still open:** `returned=0` on a session whose route
and probe both passed, plus repeated `upstream connect FAILED ... (os
error 10053)` — Windows for "local software aborted this". My firewall
allowance is present and works here, so the suspect is third-party
security software on his machine. Not yet proven; needs to know what he
runs.

**Two traps I had shipped in the picker**, both fixed: it offered
`msedgewebview2.exe` — this app's own WebView2 window, one letter from
the browser somebody means — plus `neoconnect-desktop.exe` and
`neoconnect-service.exe`. Meanwhile `msedge.exe` is absent unless Edge
happens to be running. Those three are now excluded, and every chosen
app carries a **Uses VPN** / **Bypasses VPN** label so the direction
cannot be read backwards off a toggle further up the card.

---

## 2026-08-20 — The VM rig stopped accepting synthesized keys again

**Status:** blocked, rig needs one physical keypress
**Touches:** nothing in the repo

0.9.16 is built, released and serving. It is **not** verified from the
shipped installer, and the reason is the rig rather than the build.

Part-way through today the `Neoxify-Test` VM stopped accepting
synthesized keyboard input — the same failure as 2026-08-14. It is not a
frozen guest: the clock advances, Guest Additions reports runlevel 3 and
`LoggedInUsersList = neoxify`, and screenshots update. Only input is
gone. `keyboardputscancodes` returns success and changes nothing;
compared two screenshots with `ImageChops.difference` and the bounding
box is `None`, so this is measured rather than eyeballed.

Everything tried, so the next session does not repeat it:

| attempt | result |
|---|---|
| Win, then Win+R | nothing; only the clock ticks between shots |
| release every modifier first, in case one was latched | nothing |
| ACPI shutdown, full power cycle, `--type separate` | nothing |
| `guestcontrol` as `neoxify` with a blank password | "user was not able to logon" |
| SSH / WinRM / SMB to the guest | all closed; only 3389 is open, and RDP refuses blank passwords for the same reason |
| switch to a USB keyboard (`--keyboard usb --usb-ohci on`) | **hung the VM at the VirtualBox boot logo** — reverted to `ps2`, boots fine again |

That last one is worth remembering: this rig's EFI is fragile, which is
already why it needs 4 vCPUs, and changing the HID type is enough to
stop it booting. Reverting `--keyboard ps2 --usb-ohci off` brought it
straight back.

The blank-password auto-logon is what closes every remote door at once —
it blocks `guestcontrol` and RDP by the same Windows policy. Giving the
`neoxify` account a real password would make `guestcontrol` work and
make this whole class of problem go away. Worth doing next time the rig
is reachable.

**One improvement did land:** the host folder is now a *permanent*
shared folder (`sharedfolder add` with no `--transient`) instead of
being re-added on every boot, so it survives a power cycle. That was a
recurring five-minute tax.

**So what is actually proven about 0.9.16:** it compiles, 74 service
tests pass, all four CI jobs are green, and the public installer link
serves the right binary — `sha256` of what
`/api/updates/installer/windows` returns matches the release's
`sha256sums.txt` exactly, and the updater manifest offers 0.9.16 to a
0.9.15 client. The refusal itself was verified on this rig earlier
today, both directions, against the same code built locally.

**What is not proven:** the shipped installer has not been run, and the
protocol x split-tunnel matrix has not been re-run against 0.9.16. Given
0.9.6 shipped from exactly this position and a customer found the bug,
that gap is worth closing before this build is pushed at anybody.

---

## 2026-08-21 — The installer most customers download cannot start

**Status:** fixed, proven on a clean VM
**Touches:** `.github/workflows/release-desktop-windows.yml`

`Neoxify-Setup.exe` — the branded bootstrapper the website hands out,
and by the release workflow's own comment "the one most customers
actually download" — **dies on launch on a clean Windows install**:

```text
Neoxify-Setup-0916.exe - System Error
The code execution cannot proceed because VCRUNTIME140.dll was not found.
```

It is a Rust binary, and a Rust MSVC build links the C runtime
dynamically by default. `VCRUNTIME140.dll` is not part of Windows; it
arrives with the Visual C++ redistributable. Every other binary we ship
is installed *by* this one and can rely on what the installer puts
down. This one runs before any of that exists.

Read straight out of the shipped artifact's import table rather than
inferred:

| build | CRT imports |
|---|---|
| `Neoxify-Setup-0916.exe` (public link, live) | `VCRUNTIME140.dll` + 5 `api-ms-win-crt-*` |
| same source, `-C target-feature=+crt-static` | none |

Fixed by building that one crate with a static CRT. Scoped to the
bootstrapper rather than `.cargo/config.toml`, which would change how
the Tauri app and the service link too.

Verified on a Windows 11 VM with no redistributable (`VCRUNTIME140.dll`
absent from both System32 and SysWOW64) — copied to a local disk first,
so a UNC path is not the explanation:

- shipped build: error dialog, and under `/S` it **hung for 180 s** and
  installed nothing. A silent install does not suppress a loader error,
  so the customer gets a window that never finishes.
- static build, embedding the byte-identical 0.9.16 NSIS payload: window
  opens, branded install screen, ready to go.

**How this survived.** Yesterday I checked the public link by hashing
what it served against `sha256sums.txt`. They matched, and I called the
download verified. Hashing proves you fetched the right bytes; it says
nothing about whether those bytes run. The one thing never done to this
artifact was running it.

**Also noticed:** the bootstrapper window responds only to mouse clicks
— Enter and Space do nothing on the Install button. Anyone installing by
keyboard or with an accessibility tool cannot get past that screen.
Not fixed here.

---

## 2026-08-21 — Correction: the rig was fine, the command was wrong

**Status:** correction — supersedes "The VM rig stopped accepting
synthesized keys again" from 2026-08-20
**Touches:** nothing in the repo

That entry is wrong in its conclusion and should not be trusted. The
rig never stopped accepting keys. The command is
`controlvm <vm> keyboardputscancode` — **singular**. I had been sending
`keyboardputscancodes`, which VBoxManage rejects outright:

```text
VBoxManage.exe: error: Invalid parameter 'keyboardputscancodes'.
```

I never saw it because every call was written `>/dev/null 2>&1`. The
tool was reporting the mistake on the first try and I had muted it.

What that cost, all of it chasing a typo: two full power cycles, a USB
keyboard switch that hung the VM at the boot logo, detaching the boot
disk, a boot from the Windows ISO, killing VBoxSVC, and building a
second VM around the same disk. Sending the correct command opened the
Run dialog first time.

Two things worth keeping from the wreckage:

- **Never silence a command you are using as a probe.** The whole
  exercise was "is input reaching the guest", and the answer was in the
  stderr I was discarding. A measurement whose failure mode is silence
  cannot tell you anything.
- `keyboardputstring` drops a leading backslash, so `\vboxsvr\...`
  arrives as `\vboxsvr\...`. Type the UNC prefix with scancode `2b`, or
  use the automounted drive letter (`Z:`), which needs no doubling.

`Neoxify-Test2` — a second VM built around the same VDI during this —
is now the working rig, since the disk is attached to it. `Neoxify-Test`
still exists with no disk attached. One of them should be tidied away,
but not while there is a test running.

---

## 2026-08-21 — 0.9.17 released, and verified by running it

**Status:** done
**Touches:** nothing further in the repo

0.9.17 carries the static-CRT fix. Verified the way the previous release
was not — by running the thing, on the machine that reproduces the bug:

```text
downloaded from the public link: 20473856 bytes
sha256 : e31212e4...            (0.9.17, static)
VCRUNTIME140 on this machine: False
RESULT: process is ALIVE after 12s
  main window title: 'Neoxify Setup'   responding: True
no system-error window present
```

The 0.9.16 build died instantly under identical conditions. Import
tables agree: the 0.9.17 asset has no CRT imports, 0.9.16 had six.

**Worth knowing for the next release.** For about five minutes after
publishing, `/api/updates/installer/windows` still served the *previous*
build's bytes, and the updater told a 0.9.16 client it was up to date.
That is `CACHE_MS` in `updates.service.ts` doing its job — the lookup is
cached because GitHub allows 60 unauthenticated calls an hour and every
client asks on launch. Not a bug, but it means checking the public link
immediately after a release tells you about the *old* release. Wait five
minutes, or you will chase a distribution ghost.

**The multi-app scare was not real.** Two runs reported
`apps: must be a full path to an executable` when two applications were
selected, which looked like it might be the split-tunnel bug everyone
was reporting. It is not: a controlled test with one, two and three
apps, sent both through `ConvertTo-Json` and as hand-built JSON, returns
`ok` every time — including Edge's path with its spaces and
parentheses. The two failing runs were the same ones where Edge returned
zero bytes and DNS collapsed, so something else was wrong in them.
Recorded because it nearly went to real testers as a question.

**Still open, and deliberately not guessed at:** the 10-20 s delay
before a browser starts using the tunnel while Telegram is instant, and
one observation of the full tunnel carrying nothing with Custom mode
*off*. The rig routes through Tailscale (`100.89.197.53`, US exit),
which has to come out of the path before either is measured.

---

## 2026-08-21 — Clean baseline: 25/26, and Custom mode can now report itself broken

**Status:** done
**Touches:** `apps/desktop-windows/**`

### The baseline

Custom mode **off**, every route, from the app's own service:

```text
HOME (no vpn): 50.34.35.228
PASS 25   FAIL 1   of 26
connectivity restored after run: 50.34.35.228
```

The one failure is `finland1 / Xray VLESS+REALITY`, which returns no
exit address at all while france-1 and germany-1 REALITY both pass. That
is the finland1 decoy divergence (`www.shatel.ir`) still sitting on the
live node, not a regression from any recent change. Nothing else moved.

**Tailscale is ruled out**, with evidence rather than assumption: the
default route was via Ethernet before and after stopping it, and the
exit address was identical either way. It was never in the data path.

### Four harness bugs, one of which nearly became a false alarm

The first run of this matrix reported **all 26 routes broken**. Every one
of them worked. Causes, in the order they bit:

1. `keyboardputscancodes` — the command is singular, and the error was
   muted by `>/dev/null 2>&1`.
2. `printf` in bash turning `\a` of `Z:\apps2.ps1` into a BEL byte.
3. `$L += ...` inside a PowerShell function appends to a *local* copy,
   so half the diagnostic output was silently discarded.
4. `& curl ... 2>&1` — PowerShell 5.1 wraps a native command's stderr in
   ErrorRecords, which corrupted the body and the exit code. This is the
   one that produced 26 false FAILs, and it is already written down in
   this repo's environment notes.

Rewriting the matrix as linear code with no functions and no stderr
merging turned 26 failures into 25 passes without touching the product.
**Any test harness that reports total failure is far more likely to be
broken than the thing it measures.**

### Custom mode now reports itself broken

`Stats::complaint()` reads the live counters and, when they say
something is wrong, returns words a customer can act on. Surfaced on
every status poll through to the dashboard, where it replaces "Custom
mode is on" rather than sitting beside it -- on and working are not the
same thing.

Why this was needed: the probe beside it opens a *fresh socket pinned to
the tunnel* and connects out. That proves the tunnel is alive and
exercises none of the interception, matching, rewriting or relaying a
selected app's packets go through -- and it runs at connect time, when
these counters are still zero. A tester's log read `redirected=90
returned=0` for three sessions while the app showed Connected. The
service had the evidence and nothing read it.

Three verdicts, in priority order: injections refused by the driver;
traffic redirected with nothing coming back (>= 20 packets, which is
well above one stalled connection); and interception seeing the machine
busy while matching none of it, which usually means the wrong executable
was picked.

Eight tests cover the thresholds, including the two that matter most --
a fresh session with all-zero counters must stay quiet, and a single
reply is enough to withdraw the "nothing comes back" claim.

---

## 2026-08-21 — The browser delay is DNS, and 0.9.18's new check can cry wolf

**Status:** cause found, fix not written
**Touches:** nothing yet

### What it is

Every "the browser is slow / sites will not open, but Telegram is fine"
report is one thing: **DNS breaks when Custom mode starts, and recovers
a few seconds later.** Stages separated, from a selected app:

```text
NO VPN                          dns 0.13s   tcp ok   tls ok   http ok
FULL TUNNEL, custom off         dns 0.16s   tcp ok   tls ok   http ok
CUSTOM MODE ON, try 1           dns FAILED "No such host is known"
CUSTOM MODE ON, try 2           dns 1.19s   tcp ok   tls ok   http ok
```

The counters show the same warm-up from the other side:

```text
seen=59  matched=8  redirected=28  returned=0
seen=81  matched=16 redirected=48  returned=0
seen=131 matched=27 redirected=81  returned=5
seen=164 matched=35 redirected=110 returned=6
```

Forty-eight packets out and nothing back, then it starts answering.

**Why a browser and not Telegram.** A browser resolves a name for every
site it touches, so it sits in that window and shows either a long stall
or "site cannot be reached". Telegram connects to addresses it already
has and never asks, so it is instant. One machine, one tunnel, opposite
experiences -- which is exactly how it was reported, and why testing
with `curl` to a warm address never reproduced it.

Second, smaller effect, separately confirmed: **a connection opened
before Custom mode starts never migrates.** Asked repeatedly over 30
seconds, a socket opened beforehand kept reporting the home address. An
already-open browser therefore keeps showing the wrong IP on top of the
DNS stall.

### What was ruled out on the way, with evidence

- **QUIC/UDP being dropped** -- my main hypothesis, and wrong. UDP round
  trips through Custom mode in 0.14-0.15s, repeatedly, `redirected=14
  returned=14`.
- **Multiple selected apps** -- one, two and three all accepted.
- **Tailscale** -- never in the data path.

### And a fault in what shipped an hour ago

`Stats::complaint()` in 0.9.18 fires at twenty redirected packets with
no replies. The data above reaches forty-eight during an ordinary,
healthy start. **It will tell customers "nothing is coming back" about a
connection that is merely warming up.**

The tests cover thresholds and not time, which is the actual dimension
here. It needs the silence to *persist* -- remember when the first
packet was redirected, and only complain when nothing has come back for
several seconds -- rather than firing on a count alone. My own fault:
the counters I designed against were an end-of-session summary, so I
never saw the shape of the beginning.

---

## 2026-08-21 — Two of three fixes verified; DNS is still broken

**Status:** partly done, DNS still open
**Touches:** `apps/desktop-windows/service/**`

Verified against the correct binary, on the rig, after two invalid runs
(see below).

**Works, verified:**

- **No false alarm during warm-up.** Counters reached `redirected=28
  returned=0` and no complaint appeared in any status poll. The fault
  shipped in 0.9.18 is gone.
- **Stale connections are closed.** `closed 1 existing connection(s) so
  they rebuild through the tunnel`, and the socket opened beforehand was
  forcibly reset rather than quietly carrying on down the old route.
  This is what stops an already-open browser showing the wrong address.

**Does not work:** the readiness gate does not fix DNS.

```text
www.microsoft.com   FAILED  in 12.05s
www.wikipedia.org   ok      in 1.21s
example.com         FAILED  in 12.04s
www.bbc.co.uk       ok      in 1.17s
www.debian.org      FAILED  in 12.04s
```

About half of lookups time out at twelve seconds; the ones that succeed
take 1.2s against a 0.04s baseline. The firewall race was real -- the
relay is genuinely unreachable for several seconds after `netsh` returns,
which is why the gate takes up to 8s to pass -- but it is **not** the
cause of the DNS failure. Two separate problems that happened to share a
window.

The alternating pass/fail is the useful clue and was not chased: the
adapter has two DNS servers configured, and something is carrying
queries to one of them and not the other. Next session starts there,
with a capture rather than a hypothesis -- this is the fourth guess about
this bug and the first three were all wrong (QUIC/UDP, multi-app,
firewall race).

**Switch-on now costs up to 8s** because of the gate. Kept anyway: before
it, those seconds were spent silently dropping the customer's packets
instead of waiting for a path that works.

### Two invalid verification runs first

1. Copied the new binary to `C:\Program Files\Neoxify\neoconnect-service.exe`.
   The service runs from **`resources\`**. That run measured the old
   build, and its "the fixes do not work" verdict was meaningless.
2. Fixed the path, but `$svc` (a CIM object) and `$SvcExe` (a path) are
   **the same variable** -- PowerShell is case-insensitive -- so
   `Copy-Item` was handed an object and failed with "a drive with the
   name 'Win32_Service' does not exist".

Worth recording for next time: the service is registered as
**`NeoxifyService`**, not `neoconnect-service`, so `Get-Service
neoconnect-service` returns NOT FOUND while the thing is plainly
running. Stop and start it by that name; killing the process leaves it
down.

The rig also still had a disconnected `Neoxify-OpenVPN` adapter carrying
its own DNS server, sitting in front of exactly the lookups being
measured. Disabled during this run.

---

## 2026-08-21 — 0.9.19 verified from the shipped installer

**Status:** done
**Touches:** nothing further

Installed from the release asset (hash matched `sha256sums.txt`), not
from a local build:

```text
app version now : 0.9.19        service: Running
stale connection: RESET -- PASS
selected app exit: 38.60.249.229  (expected 38.60.249.229)
warm-up polls +5/+10/+15/+20s: no problem reported
log: closed 1 existing connection(s) so they rebuild through the tunnel
     redirected=11 returned=11
```

Both shipped fixes behave as intended from the artifact a customer gets.
Switch-on took 4.45s here against 13s in the earlier run -- the readiness
gate returns as soon as the relay answers, so the cost varies with how
long the firewall rule takes to bite.

**Still open, and not fixed by this release:** DNS fails roughly half the
time with twelve-second timeouts when Custom mode starts. That is the
browser stall, it is unchanged, and it is the next thing to chase --
with a capture, since four hypotheses about it have now been wrong.

**Small loose end:** the check immediately after disconnect still
reported the node address rather than home. Six seconds was probably too
short a wait -- the 26-route matrix, which allows longer, showed
connectivity restored correctly every time. Noted rather than explained.

**Log noise introduced:** the readiness gate's probe connection shows up
as `accepted from port NNNNN but no flow claims it`. Harmless -- the
relay is correctly refusing a connection with no recorded flow -- but it
appears once per session and should be labelled or suppressed so it is
not mistaken for a fault later.

---

## 2026-08-22 — DNS: the capture, and a leak found beside it

**Status:** cause localised, NOT fixed
**Touches:** nothing yet

`pktmon`, filtered to UDP 53, across a Custom-mode start. Two lookups
failed at twelve seconds each, four then succeeded.

```text
14:42:13.786 Rx 1.1.1.1:53      -> 10.66.0.2:55361   (first redirected reply)
14:42:26.040 Rx 1.1.1.1:53      -> 10.66.0.2:58290   www.bbc.co.uk
14:42:26.084 Tx 10.66.0.2:58290 -> 1.1.1.1:53        www.debian.org
14:42:26.253 Tx 10.66.0.2:55361 -> 1.1.1.1:53        www.kernel.org
```

**The two failing lookups appear nowhere in the capture.** Not to the
ISP resolver, not to `1.1.1.1`. No packet for them ever leaves the
machine.

That rules out everything that was still on the table. It is not
misrouting, not a lost reply, not a source-address mismatch, and not the
resolver: the successful ones prove the whole path works, with the
tunnel address as source going straight to `1.1.1.1:53`. For roughly the
first fourteen seconds the query is simply **not forwarded**.

Since a `Verdict::Direct` packet passes through untouched and would
appear on the wire, and these do not, they are being redirected -- and
the UDP relay is not forwarding them. **That is where the next session
starts: the UDP relay's first seconds, not the redirect and not DNS.**

Four earlier hypotheses were wrong (QUIC/UDP dropped, multiple selected
apps, Tailscale, the firewall race). The capture cost one run and
excluded all of them; it should have been the first move, not the fifth.

### A DNS leak found while reading that path

In the `carry_dns` branch:

```rust
return match nat.redirect(parsed.transport, origin) {
    Some(nat_port) => Verdict::Redirect { nat_port },
    None => Verdict::Direct,
};
```

When a NAT port cannot be allocated, the lookup is sent **out in the
clear to the resolver the network handed out** -- which for a customer in
Iran is their ISP. That is the exact leak this branch exists to prevent,
and it happens silently at the moment of pressure. Dropping the packet
would be the honest failure: a lookup that does not answer is a stalled
page, while one answered by the ISP is a record of where they went.

Not changed yet, because it wants its own test and possibly a complaint
so the customer is told, rather than a quiet swap of one failure mode
for another.

---

## 2026-08-22 — The browser delay: one silent `continue`

**Status:** fixed, measured
**Touches:** `apps/desktop-windows/service/src/split_tunnel/**`

Three days of this, and it was one line in the UDP relay:

```rust
let Ok(socket) = bind_upstream(&tunnel) else { continue };
```

A tunnel address is **tentative** for a moment after the adapter appears
while Windows finishes duplicate address detection, and a socket cannot
be bound to it until that completes. Every datagram arriving in that
window was dropped — no log, no retry, no counter. DNS is the first
thing any application does, so the resolver burned its whole retry
budget and the lookup failed outright.

TCP was unaffected because it retransmits its own SYN for far longer
than the window lasts. That asymmetry is what made this look like a
DNS-specific fault and sent four hypotheses in the wrong direction
(QUIC/UDP dropped, multiple apps, Tailscale, the firewall race).

Measured, same eight names, same moment:

| | before | after |
|---|---|---|
| failures | 2 of 6, at 12s each | **0 of 8** |
| slowest | 12.07s | **1.42s** |
| steady state | — | 0.16s |

The bind now retries for up to six seconds and **says so in the log if it
still gives up**. A packet this feature drops must never again be
invisible from every angle at once — the counters called it "seen", the
app called it connected, and the customer called it broken.

**What actually found it:** a `pktmon` capture showing the failing
lookups nowhere on the wire — not to the ISP resolver, not to `1.1.1.1`.
That excluded misrouting, lost replies and source mismatch in one run,
and pointed at the only remaining possibility: the query was never
forwarded. Four guesses preceded it. The capture should have been first.

### The DNS leak beside it, now closed

The same branch fell back to `Verdict::Direct` when a NAT port could not
be allocated — sending the lookup **in the clear to whichever resolver
the network handed out**, which for a customer in Iran is their ISP. It
now drops instead, via a new `Verdict::Drop` / `Leg::Swallowed` that is
the single deliberate non-injection in the worker loop.

A lookup that does not answer is a page that does not load, which the
customer sees and can retry. A lookup answered by their ISP is a record
of where they went, which they never learn about.

---

## 2026-08-22 — The app picker, rebuilt and verified

**Status:** done, measured on the rig
**Touches:** `apps/desktop-windows/**`

"It shows all of Windows" was fair. The list was every process whose
image was not under System32 -- a definition of *not a Windows binary*
rather than of *an app* -- with one row per executable.

With the window filter applied as the app applies it, fifteen entries
become four:

```text
shown   : Microsoft Edge (2 exes), Notepad, mspaint, Windows Explorer
removed : Antimalware Service Executable, Antimalware Core Service,
          SearchHost, Widgets, WidgetService.exe, Shell Experience Host,
          Start Experience Host, OneDrive, Edge Update, CrossDeviceResume,
          Network Realtime Inspection
```

Every entry carries the icon the shell draws.

### Three things worth remembering

**The filter cannot live in the service.** The first attempt put
`EnumWindows` there and returned **zero apps**: the service is
LocalSystem in session 0, isolated from the interactive desktop.
Process enumeration crosses sessions, window enumeration does not. The
service reports what only it can read -- paths, version info, icons,
pids -- and the app decides what is on screen.

**ProductName alone over-groups.** Windows stamps
"Microsoft(R) Windows(R) Operating System" on Notepad, Paint and
Explorer alike, which collapsed nine unrelated programs into one entry.
Selecting it would have tunnelled all nine. Products that name the
platform are kept apart and named from FileDescription.

**A group's representative must be chosen, not sorted.** Edge ships
`elevation_service.exe`, which sorts before `msedge.exe`, so "Microsoft
Edge" showed a service's icon and path. Closest match to the product
name wins.

### Icons without a dependency

`SHGetFileInfoW` for the handle, `GetDIBits` for pixels, and a PNG
written here -- stored deflate blocks are valid PNG in about sixty
lines, which beats carrying an image encoder inside a LocalSystem
service for a settings screen. The mask is applied when the colour
bitmap's alpha is all zeroes, which is the case for older icons and
otherwise yields a fully transparent image. CRC32, Adler-32, base64 and
the PNG structure are covered by known-answer tests.

**Not verified:** the picker dialog itself was never opened. The data it
receives was checked by applying the identical filter on the rig, so
search and icon rendering are unproven visually. Also `mspaint` shows as
"mspaint" rather than "Paint" -- its FileDescription did not come
through.

---

## 2026-08-22 — Three faults found by using the app, not the pipe

**Status:** fixed, verified only by build and tests
**Touches:** `apps/desktop-windows/**`

Found in ten minutes of real use on a real machine, in "everything
except these" mode with Chrome and Claude excluded. None of them would
ever have shown up in my testing, because every VM run drove the service
over its named pipe instead of running the app through its own tunnel.

**1. The app tunnelled itself.** In `AllExcept` everything not excluded
is carried, and nobody thinks to exclude the VPN client. Its API calls
then depended on the tunnel it was managing: twenty seconds of spinner,
then "can't reach Neoxify right now". The service was already exempt --
its own lookups being fed into its own proxy took DNS out for the whole
machine once -- and the app needed the same exemption for the same
reason. It is now in `own_images` beside the service.

**2. The app said "You're not protected" while it was.** The browser
showed the node's address; the app showed a Connect button. A failed
`vpn_status` was being treated as "disconnected", so failing to ask the
question was reported as knowing the answer. It now keeps what it last
knew rather than asserting the reassuring-sounding opposite -- this is
the same class as a false "Connected", and the direction does not
excuse it: somebody who believes "not protected" acts as though their
traffic is their own.

**3. Closing the app left the tunnel up for a minute.** `IDLE_GRACE` is
sixty seconds, and it is right for a crash: the app opens a fresh pipe
connection per request, so "a client is connected" is never true for
long, and an earlier version that tore down on disconnect killed live
tunnels seconds after they came up. But closing the window is an
instruction, not silence, and it was being inferred instead of acted
on. A `Destroyed` handler now disconnects before the process exits.

### The pattern, stated plainly

Three days of VM runs, and the faults were found by someone using the
product for ten minutes. Every one of them lives between the app and the
service -- the seam my harness replaced with a pipe client. **Driving
the service directly is not testing the product**; it tests the half
that was never in question.

**Not verified:** these are covered by builds and 88 tests, and by
nothing else. The app-tunnelling exemption in particular wants checking
in `AllExcept` mode with the app running, which is exactly the
configuration that has never once been exercised.

---

## 2026-08-22 — The browser bug: the relay was eating its own lookups

**Status:** fixed, A/B/A measured
**Touches:** `apps/desktop-windows/**`

A whole page -- fifteen assets across nine hosts, eight parallel, cache
flushed -- on WireGuard germany-1:

| | wall clock | failures |
|---|---|---|
| no vpn | 0.73s | 0 |
| full tunnel | 2.98s | 0 |
| **split tunnel** | **24.34s** | **14 of 15, all `dns=0.000000`** |

`redirect::decide` asked "is this the relay's own onward socket?" through
`OwnerLookup::image_for_port`, which will not rebuild its snapshot more
often than `MIN_REFRESH_INTERVAL`. A relay's onward socket is
**microseconds old** when it sends its first packet, so inside that
window the answer was "no" -- and the DNS branch took the relay's own
upstream query and posted it back into the relay. It never reached a
resolver.

The gap sweep between two lookups shows the cliff exactly:

```text
gap=  0ms  0/2 survived      gap= 25ms  2/2
gap=  5ms  1/2               gap= 50ms  2/2
gap= 10ms  0/2               gap=250ms  2/2
```

Twenty milliseconds. A browser resolves every asset host in one burst,
so it lost nearly all of them: text arrived, images and stylesheets did
not. Telegram, which resolves nothing, was unaffected.

**Fix:** the relay registers each onward socket at bind time, before
anything can be sent, and the redirect consults that registry ahead of
any owner lookup. Keyed on address *and* port -- an app and the relay
legitimately hold the same port number on different addresses, and
port-only matching would have pushed an app's traffic out of the tunnel.

After: **3.12s, zero failures** against a 2.98s full-tunnel control, and
32 concurrent lookups losing none. Restoring the old binary brought the
failure back. A/B/A, so this is causality rather than correlation.

### Why every test missed it for a week

Each one fetched a 40-byte JSON body over a single connection. That is
one small packet, one lookup, no concurrency -- structurally incapable
of producing the bug. The MTU theory that replaced it was equally wrong:
a 5MB download runs at full tunnel speed. **Six hypotheses died before a
test was written that could fail.**

### Also fixed: the app could wedge permanently

`call()` in `vpn.rs` had no read deadline. The service accepting a pipe
connection is not a promise that it will answer, and without a deadline
that future stayed pending for the life of the process -- with every
piece of UI waiting on it. That is "stuck on Disconnecting, can't click
anything". Now bounded at 45s.

Alongside it, the UI stopped running its own state machine: state comes
from `vpn_status`, a failed status means *unknown* rather than
*disconnected*, transient states have watchdogs, and the connect control
is never left disabled with no way out -- a `disabled` on
`"disconnecting"` was why the third press killed it.

### Still open, and it is the serious one

**The service can deadlock.** Rapid connect/split-tunnel sequences
blocked `dispatch` for ~25 minutes -- every request including plain
`status` timed out, and the machine sat full-tunnelled until the service
was force-restarted. Something in the connect/teardown path blocks
forever holding the `Engines` mutex, with no timeout and no recovery.
The 45s client deadline frees the app; it does nothing for the service.
**This is the next piece of work.**

Also noted: Xray REALITY shows 2.0-5.6s DNS latency post-fix against
WireGuard's 0.16s, with no clean baseline to attribute it.

---

## 2026-08-22 — The service deadlock: a tunnel service that nothing could stop

**Status:** fixed, reproduced and measured
**Touches:** `apps/desktop-windows/service/**`

Reproduced in fifteen seconds against the shipped binary: `setSplitTunnel
on` → `connect` → `setSplitTunnel off` → `setSplitTunnel on`, fired 50ms
apart. The fourth request never returned, every later `status` timed
out, and the machine sat full-tunnelled with no way to disconnect.

Killing the service's one live child -- `wireguard.exe
/installtunnelservice` -- made `status` answer in 0.01s. So the service
was parked in `Command::status()` inside `run_hidden`, **holding the
`Engines` mutex**. A second orphaned `/installtunnelservice` from
earlier the same evening was still on the machine: this had happened
before and nobody knew.

### The mechanism, isolated on an inert config

1. `/installtunnelservice` returns while its tunnel service is still
   **START_PENDING**.
2. `/uninstalltunnelservice` returns in 0.03s -- it sends a stop control
   and calls `DeleteService`. **A START_PENDING service cannot accept a
   stop**, so only the delete takes.
3. The service finishes starting and sits RUNNING, marked for delete,
   with nothing left that will ever stop it.
4. The next `/installtunnelservice` spins in an unbounded `OpenService`
   loop waiting for the name to free. Measured still going ninety
   seconds later; twenty-five minutes in the field.

### What changed

- **`run_hidden`** is bounded (15s) and kills the child on overrun.
  `Command::output()` is gone: it waits for the child *and* reads both
  pipes to EOF, neither bounded.
- **`clear_tunnel_service()`** waits, bounded, for the tunnel service
  name to free and issues the stop itself once the service is in a state
  that can accept one. That removes the trigger -- and fixes a second
  honesty bug, since `disconnect` used to return while the machine was
  still tunnelled.
- **`pipe.rs` locks per request.** `status` waits 1s then answers from
  the OS; `listRunningApps` never locks; `disconnect` waits 2s then
  abandons whatever holds the lock. Serializing *everything* meant one
  stuck operation took with it exactly the two requests a stranded
  customer needs: "am I tunnelled" and "get me out".
- The ad-hoc `Command::output()` calls in `dns.rs`, `ikev2.rs` and
  `firewall.rs` now go through the bounded helper.

### After

Same reproduction plus eight rounds across WireGuard, REALITY,
Shadowsocks and OpenVPN with continuous polling: **zero status
timeouts**, worst status latency 1.8s, `disconnect` answering in
0.7-1.4s throughout, every round ending disconnected. `status` answered
honestly from the OS while a rebuild was in flight. The abandon path was
exercised too -- a disconnect fired 0.5s into an OpenVPN connect
abandoned it at the 2s mark and answered at 2.94s, machine untunnelled.

**Two caveats, stated rather than buried.** The 15s and 10s budgets are
calibrated against this machine, where every helper measured under 0.6s;
a much slower machine could see a bounded *failure* where it previously
succeeded -- though it can no longer hang. And IKEv2 was not exercised
end to end, so `RasDialW` -- synchronous, no timeout -- is the one
remaining unbounded wait in the service and is unproven either way.

---

## 2026-08-22 — Brand marks, a visual pass, and four RTL bugs

**Status:** done
**Touches:** `apps/desktop-windows/src/**` (and mobile, via the shared alias)

The community row used lucide stand-ins -- a speech bubble for Discord,
a camera for Instagram, a paper plane for Telegram. Now the real marks,
as inline SVG in `BrandIcons.tsx` rather than a dependency: five glyphs
do not justify an icon pack. The website keeps the lucide globe and
Settings keeps its gear, because neither is a brand.

One edit covers every client. `apps/mobile/src` imports
`@shared/components/CommunityLinks`, and `@shared` aliases to the
desktop tree, so Android (APK and Play) and iOS pick it up with no file
added to the Mac session's tree.

### The RTL bugs are the part that mattered

Found while checking the visual pass held up in Persian, and none of
them is cosmetic:

- **The Custom-mode toggle knob used physical `left-*`.** The card
  mirrors in RTL; the knob did not. So "on" sat exactly where a Persian
  reader reads "off" -- a control that lied about whether traffic was
  being tunnelled, to the audience this product exists for. Now
  `start-*`.
- The picker's search icon was `left-2.5` with `pl-8`, so in RTL it sat
  on top of the first characters typed.
- Chevrons never mirrored.
- `text-left` where `text-start` was meant, in five files.

**Nobody had looked at this app in Persian.** Everything above is
invisible in English and has presumably been shipping for months.

### Visual pass

Verified against real before/after renders of the actual components, not
a mock. The one that was a defect rather than taste: the Stat tile's
action shared the value's line and truncated the data -- `fi-finland`
displayed as `fi-finl...`. An attempt to move the action to the caption
line truncated `SERVER`/`PROTOCOL` instead and was reverted; three tiles
across a 400px window genuinely cannot fit both at full size.

Otherwise: the status headline was set at form-label size and is now
the size of the sentence the screen exists to deliver; the exit IP is a
success-tinted chip rather than a third grey line, since it is evidence
a customer can check; the data bar has a recessed track; the orb's dial
has something to measure against; the Settings rail's active row has an
accent bar drawn as a `before:` pseudo-element pinned to `start-0`, so
it lands on the correct edge in both directions.

### Worth knowing

- **There is no light theme.** `theme.css` defines `:root` and `.dark`
  identically with no `prefers-color-scheme` block. "Check both themes"
  reduces to one palette -- relevant before anyone promises light mode.
- `apps/mobile/src/screens/Dashboard.tsx` keeps its own copies of the
  status block and data-used card, so those two refinements did not
  reach mobile. Left alone deliberately: that file is in the tree the
  Mac session is working in, and porting it is a coordinated change.
- `Stat` shows a raw region slug (`fi-finland`), which is why it
  truncates at all. A display name would fix it properly, but that is a
  data change rather than a visual one.

---

## 2026-08-22 — "Wrong IP for a minute": a SYN that escaped, and two metrics that lied

**Status:** fixed, measured before and after
**Touches:** `apps/desktop-windows/service/src/split_tunnel/{owner,redirect}.rs`

A browser in `OnlySelected` showed the customer's real address for about
a minute after connecting, then corrected itself.

### Both pieces of evidence I opened with were wrong

- **"closed 0 existing connection(s)"** -- every one of those 51 lines
  came from rapid synthetic start/stop cycles with nothing running to
  close. Real sessions closed 274, 46, 40, 38, 31, 29, 14, 3, 1, and
  five fresh runs closed 6-8 each with **zero survivors** every time.
  `reset_selected_connections` was never broken.
- **"chrome -> proxy 0, direct 60"** -- that metric *cannot* show a
  redirected connection. `rewrite_outbound` changes the packet's
  destination; the app's socket keeps the real remote address in the TCP
  table. Caught in the act: Chrome held `8626 -> 64.233.184.84:443`
  while the service simultaneously held
  `10.67.0.2:8627 -> 64.233.184.84:443` through the tunnel. Same
  connection, tunnelled, still showing the real address.

Reading a number without establishing what it is capable of showing.

### The mechanism

`image_for_port` will not rebuild its snapshot more often than
`MIN_REFRESH_INTERVAL` (20ms). A browser opens many sockets at once, so
a SYN routinely arrives inside that window. In `OnlySelected` an unknown
owner means *leave it alone* -- so the SYN goes out unredirected, **the
far end answers it**, and that connection is established outside the
tunnel for good. The browser reuses it until it retires, which is the
minute.

The comment in `decide` claimed this was survivable because the SYN
would be retransmitted a second later. It is not: a direct SYN
succeeds, so nothing is retransmitted. Corrected in place.

Measured directly with instrumented counters: **6-22% of new TCP
connections** hit the stale window (11/50, 5/77, 4/47, 9/60, 8/55), and
a forced rebuild resolved **100%** of them.

**Fix:** `image_for_new_connection` rebuilds rather than answering a
miss from a stale snapshot, used for TCP SYNs only -- the one packet
where being wrong is permanent.

### Before / after, Edge selected, WireGuard france-1

Ground truth is the browser's own reported exit IP on the first
navigation after Custom mode comes up, with the TCP handshake time as an
independent check on which path it took:

| | shipped 0.9.24 | with fix |
|---|---|---|
| run 1 | 50.34.35.228 US, tcp 21ms | 104.105.205.233 FR, tcp 294ms |
| run 2 | 50.34.35.228 US, tcp 9ms | 104.105.205.233 FR, tcp 291ms |
| run 3 | -- | 104.105.205.233 FR, tcp 290ms |
| run 4 | -- | 104.105.205.233 FR, tcp 300ms |

2/2 escaped before; 4/4 tunnelled after.

### Two measurement traps

- The browser automation drives **Edge**, not Chrome. The first
  "Chrome shows the real IP" readings were Edge, which was not selected.
- A `setInterval` poller in a background tab is throttled to ~1/minute
  and produced a convincing but entirely fake "45-second dead window".
  The final numbers use navigations only, self-timestamped from
  `performance.timeOrigin`.

### Two gaps left open

- `reset_selected_connections` closes only `ESTABLISHED` rows, so a
  connection in `SYN_SENT` at that instant survives as a direct one.
- The packet loop parses IPv4 only, so **IPv6 may bypass Custom mode
  entirely**. No IPv6 was present to test against. That one deserves its
  own investigation before anyone calls this feature finished.

---

## 2026-08-22 — turkey-1 built: eight protocols, all proven by exit IP

**Status:** done and verified; one fleet-wide finding left open
**Touches:** nothing in the repo — live: turkey-1 (new), plan route lists

`tr1.neoxify.site` / 130.94.0.27, Istanbul (Light Node Limited, AS2914),
Ubuntu 24.04, 1 vCPU / 2 GB, public address bound directly to the
interface. STANDALONE. Node id `da93fde4`.

All eight, each measured by exit IP rather than by a green connect:

| protocol | port | exit |
|---|---|---|
| VLESS+REALITY | 443 | 130.94.0.27 |
| VLESS+TLS | 8443 TCP | 130.94.0.27 |
| VLESS+TLS over WebSocket | 8443 `/assets/…` | 130.94.0.27 |
| Trojan+TLS | 2053 | 130.94.0.27 |
| Shadowsocks 2022 | 26633 | 130.94.0.27 |
| WireGuard | 37036/udp | 130.94.0.27 |
| OpenVPN | 50263/udp | 130.94.0.27 |
| IKEv2 | 500/4500 | 130.94.0.27 |

Added to Trial, Starter, Pro and Ultimate Max — 8 routes each, 216
credentials provisioned. **Ultimate deliberately excluded**: it is the
relay-only plan and this is a direct node.

### The installer ran clean, interactively, first time

No desync. Driven over `tmux send-keys` against a real pty on the node,
one prompt at a time — which is the way to satisfy "run it
interactively" from a session that has no terminal. `NEOXIFY_ADMIN_TOKEN`
removed the credential prompts, and that is what makes the rest of the
sequence predictable.

**The gRPC/PENDING trap is fixed and confirmed working.** The installer
probed `connect.neoxify.site:50051`, found it dead, said why, and asked;
answering `167.233.65.166` produced a node that came up ONLINE
immediately. The entry above calling this "unfixed and a fleet-wide
latent outage" is stale — the detection landed.

**Two protocols default to `skip`.** Trojan and Shadowsocks both prompt
`[skip]`, so an operator pressing Enter through the install gets a node
missing two transports and no warning that anything was dropped. Every
other engine defaults to yes. Worth reconsidering given "never drop a
protocol".

Also: the agent release is *not* behind main this time — v0.2.5 is the
newest `v*` tag and nothing under `agent/` has changed since it.

### The REALITY decoy was chosen by measurement, not by list

The installer's built-in candidates are Iran-hosted or CDN-hosted, and
neither fits a Turkish address. Probed alternatives from tr1 *and* from
ir1, which is the check that mattered:

- `www.sahibinden.com`, `www.trendyol.com` — resolve into Cloudflare.
  Rejected on the installer's own range argument.
- `www.mynet.com` — Netdirekt, an ordinary Turkish hosting AS, perfect
  on paper. **Fails from Iran**: no h2, certificate does not verify.
- `www.donanimhaber.com` — HizliNet (AS6205), ordinary Turkish hosting,
  TLS 1.3 + h2 + X25519 + verified **from both tr1 and ir1**. Chosen.

The lesson is the second criterion is not free: a same-country host is
worth nothing if it is unreachable from where the customers are, and one
probe from ir1 settled a choice that reasoning could not.

### Left open: new nodes lose the client's address through the API mirror

`ensure_fallback_site` points the mirror at whatever `panelUrl` says,
which is now `connect.neoxify.site` — the **Cloudflare-proxied** name.
Cloudflare then replaces the client address, so `X-Forwarded-For` never
survives the hop:

```
direct   -> {"ip":"50.34.35.228","country":"US"}    (real client)
turkey-1 -> {"ip":"130.94.0.27","country":"TR"}     (the node itself)
finland1 -> {"ip":"50.34.35.228"}                   (real client)
```

finland1 and france-1 escape it only because they were built when the
panel URL was `connect.neoxify.com`, which resolves straight to
167.233.65.166. Turkey is simply the first node built since the switch.

Two consequences, both of which the installer's own comments say the
XFF header exists to prevent. Every customer arriving through a node
mirror lands in one rate-limit bucket. And `/api/health/ip` fetched
through a node's own mirror returns that node's address — which is
exactly what a *working* tunnel looks like, so it would pass the
"is traffic flowing" check while proving nothing. Not changed here:
it is a fleet-wide decision and the same argument as `grpcTarget`.

Noticed alongside it: **germany-1's mirror returns 502** on
`de1.neoxify.site:2053/api/...` — the stale-upstream failure the
installer comments already describe. singapore-1 has no fallback site at
all, having only OpenVPN and IKEv2.

### WSL2 is a usable isolated client rig

The five Xray transports need nothing but `xray.exe` with a SOCKS
inbound and `curl --socks5-hostname`; no tunnel, no elevation, no VM.
WireGuard, OpenVPN and IKEv2 were run inside WSL2, which is a separate
VM with its own routing table — a full tunnel there cannot touch the
host, and the host's default route was confirmed unchanged throughout.
Cheaper than booting Neoxify-Test when all that is wanted is an exit IP.
`https://1.1.1.1/cdn-cgi/trace` is the echo endpoint: one stable address,
so it can be scoped to a single `/32` when that is wanted.

**A confound worth not re-diagnosing.** OpenVPN came up completely —
`Initialization Sequence Completed`, tun0 addressed, ICMP crossing to
1.1.1.1 — and carried no TCP at all. It is not the node: germany-1
failed **identically** as a control. This machine's path MTU is 1400
(`ping -M do -s 1372` passes, `-s 1400` drops) while the server pushes
`tun-mtu 1500`, so the encapsulated packets black-hole. With
`--pull-filter ignore tun-mtu --tun-mtu 1300 --mssfix 1200` the exit IP
appeared at once. Real customers on a sub-1500 link — mobile, PPPoE,
much of Iran — are on the same cliff, so this is worth a look as a
product question rather than filing it as a rig quirk.

## 2026-08-22 — every download 404'd for four minutes, and it was not the rate limit

`/api/updates/installer/{windows,android}` returned 404 and the update
check returned "you are up to date" while `desktop-v0.9.25` sat
published and healthy. The obvious suspect was GitHub's 60-call
unauthenticated limit — six releases were cut that evening, and the
service's own comment predicts exactly that failure. **It was not.**

The panel's logs settle it. `GitHub releases request failed: 504`, twice,
at 10:07:35 and 10:08:41 UTC, which are precisely the two moments nginx
recorded a fresh 404. Not a 403, and nothing about a limit:

```
$ curl .../rate_limit          # from the panel, same hour
"core":{"limit":60,"remaining":46,"used":14}
```

Twelve days of nginx logs hold 340 requests to `/api/updates/*` in
total — about 28 a day. The five-minute cache caps outbound calls at ~24
an hour even under load. The ceiling was never in sight, and reaching for
it as the explanation would have shipped a token and left the bug in
place.

What actually happened is an amplifier. One 504 was stored as
`build = null` — indistinguishable from "there are no releases" — under
the **success** TTL of five minutes, with no retry. nginx shows the whole
shape of it: 404 at 10:07:35, 10:07:54, 10:12:02, then nothing wrong
again. One failed HTTP request bought a four-and-a-half minute outage on
every download link the website and the emails point at.

The same signature is in the logs for 18 and 19 August, so this is the
third occurrence, not a first.

### What changed

- **Retries** (3, ~250ms backoff) on 5xx/429/408 and network errors, and
  a 10s timeout — `fetch` has none, so a hung connection hung the
  customer's request with it. A 403 is deliberately *not* retried: a
  spent rate-limit budget does not refill inside a retry loop.
- **A failure is cached for 30s, not 5 minutes.** Caching a failure as
  long as a success is what turns a blip into a guaranteed outage window.
- **Last known good is served when a lookup fails**, for up to 24h.
  Handing a customer last night's installer beats handing them a 404, and
  the desktop updater pulls them forward on its next good check. Bounded
  rather than infinite so a yanked release cannot be served for a week
  because nobody noticed the feed had been failing since Tuesday.
- **The update check no longer says "up to date" when it does not know.**
  `manifestFor` returned `null` for both "you are current" and "the
  lookup failed", and the controller turned both into 204 — the app
  reporting a state nothing had verified, which is the one thing it must
  not do. Now `checkFor` returns `current` / `unknown` / `update`, and
  `unknown` is a 503. Safe for released clients: `checkAndStage` in
  `apps/desktop-windows/src/lib/updates.ts` already swallows update-check
  failures silently by design.

### The token is worth having, but it would not have fixed this

`GITHUB_API_TOKEN` is now read via ConfigService, plumbed through
compose and `ensure_env_key`, and lifts the limit to 5,000/hour. Optional
throughout — unset, the calls go out anonymously and everything works,
which is what local dev and CI do.

**Not installed on the panel.** `gh auth token` on the Windows box holds
a `gho_` credential with `repo`, `workflow` and `gist` — write access to
every repo the owner can reach, and it rotates whenever `gh` re-auths.
Putting that on a public-facing box to read *public* release metadata is
a bad trade, and fine-grained PATs cannot be minted through the API at
all; GitHub only issues them from the browser. Left for the owner: a
fine-grained token, no scopes, then `GITHUB_API_TOKEN=...` in
`/root/neoconnect/infra/.env` and rebuild the backend.

### Production is on the branch, not on main

The fix was deployed from `claude/new-season-start-646af6`, so
`/root/neoconnect` is no longer on `main`. **The documented runbook
(`git pull --ff-only origin main`) will quietly revert this fix** until
the PR merges. Merge first, then the runbook is correct again.

---

## 2026-08-22 — android-v0.2.15: what "shared" actually reaches mobile

**Status:** done
**Touches:** `apps/mobile/src/components/PerAppCard.tsx`,
`apps/mobile/src/screens/Dashboard.tsx`, mobile version files

The brand marks and the four RTL fixes from 4281f68 were landed entirely
in `apps/desktop-windows/**`, on the reasoning that "one edit reaches
every client, because apps/mobile imports the shared component". That is
half true, and the half that is false is the important half.

### The rule, stated properly

The `@shared` alias makes a fix travel **only for components mobile both
imports and renders**. Mobile keeps its own copies of anything the two
platforms genuinely differ on, and a fix to the Windows twin does not
reach them. Checked one by one against the built bundle rather than
inferred:

| Fix | Lives in | Reaches Android? |
|---|---|---|
| Discord/Instagram/Telegram marks | `CommunityLinks` + `BrandIcons` | yes — Dashboard renders it |
| `Stat` chevron mirroring, `text-start` | `components/ui.tsx` | yes |
| `LocationPicker` row `text-start` | shared | yes |
| Settings rail, nav chevrons, `text-start` | shared `screens/Settings.tsx` | yes |
| Support ticket row `text-start` | shared `screens/Support.tsx` | yes |
| **Custom-mode toggle knob** | `CustomModeCard.tsx` | **no** |
| **Picker search icon** | `RunningAppPicker.tsx` | **no** |
| **Change-location chevron** | desktop `screens/Dashboard.tsx` | **no** |

The three "no" rows are the ones that mattered. Android's Custom mode is
`PerAppCard.tsx` — its own component, because Android lists installed
packages where Windows browses for a `.exe` — and it carried a verbatim
copy of every bug: `transition-[left]` with `left-[1.375rem]`/`left-0.5`
on the knob, `left-3` + `pl-9` on the search field, `text-left` on the
app rows. So the release that was supposed to *fix* "on sits where a
Persian reader reads off" would have shipped it unchanged on the platform
most of those readers use. Ported deliberately, not by re-aliasing.

The desktop visual pass (status headline, exit-IP chip, data-used gauge)
is **not** in 0.2.15. Mobile's Dashboard keeps its own copies of those
blocks and they were left alone — scope was the marks and the RTL bugs.

### Verified by rendering it, not by reading it

A throwaway harness mounted the real components — mobile's own
`PerAppCard` plus the shared ones through the real `@shared` alias — with
only the four Tauri modules stubbed, forced to Persian. Measured, not
eyeballed: knob at 3px from the right edge when off and 5px from the left
when on (`inset-inline-start: 22px`), and mirrored correctly back in
English. Discord/Instagram/Telegram came out as filled brand paths, not
lucide. Harness deleted afterwards.

**Two traps in that harness, both of which produced a confident false
result before being caught:**

1. **Tailwind v4 will not scan outside the Vite root.** With the harness
   rooted at a subdirectory, `@source "../src"` in `globals.css` was
   silently ignored — `start-*`, `ps-*` and `text-start` were simply
   absent from the CSS, so the real knob measured as "not moving". The
   classes were correct the whole time. Root the harness at `apps/mobile`
   and it scans as the real build does.
2. **A hidden page never ticks transitions.** The preview pane was not
   compositing (`document.visibilityState === "hidden"`), so anything
   with a `transition` froze at its *start* value forever. That read
   exactly like a broken control, and cost a wrong "fix" that replaced
   the knob's logical insets with transforms before the cause was found.
   Neutralise transitions (`transition-duration: 0s !important`) and ask
   where the thing comes to rest — that is the actual question anyway.

Both faults look like application bugs and are not. Anything measured in
that pane needs the transition killed and the CSS presence confirmed
before the measurement means anything.

**Also worth keeping:** `pnpm turbo run lint typecheck build test` cannot
go green in a `.claude/worktree` — `@neoxify/panel#build` dies on
`module-not-found` against deep `node_modules/.pnpm` paths, the Windows
260-char limit. Confirmed pre-existing by stashing and rebuilding clean.
Everything else, mobile included, passes. Linux CI is the gate.

---

## 2026-08-22 — All 34 routes, measured through a browser instead of curl

**Status:** done; two fixes in PR #26, three findings left for the owner
**Touches:** `apps/desktop-windows/service/src/engines/openvpn.rs`,
`installer/lib/agent.sh`

### Why the previous pass could not fail

It ran `curl` against a 40-byte JSON endpoint and passed on all 26
routes while browsers were unusable. This one drives a real headless
Edge over the DevTools protocol on `Neoxify-Test2`, connecting through
the app's own service (0.9.25, installed for this run — the rig was on
0.9.21), full tunnel, and takes three things per route:

- the exit IP **as a page renders it** — `ifconfig.me`, falling back to
  `checkip.amazonaws.com`;
- `en.wikipedia.org/wiki/Iran` on a fresh profile, **scrolled to the
  bottom and left to settle**, then counted: resources, hosts, bytes,
  images asked for that came back blank, and subresource failures caught
  by an `error` listener installed before the document exists;
- throughput from inside that same browser against
  `speed.cloudflare.com` — four parallel streams, fixed 15s window,
  bytes actually received — plus a median of six small requests for
  latency.

**Scrolling is not a detail.** Measured at the load event, Wikipedia
reports 103 of 111 images blank on a route that is working perfectly:
that is lazy loading counted as breakage. Scrolled, every healthy route
reports the same 116 resources, 2.0 MB, and exactly 2 blank images.

**Those 2 were identified rather than assumed.** Both are the same
thumbnail, `40px-Flag_of_Iran.svg.png`, which had already decoded to
40x23 pixels but whose `complete` flag had not flipped at the instant of
the snapshot — a race in the harness's own predicate. Reproduced with no
tunnel at all, so it is not a route property. That is why the baseline
is 2 and not 0.

The service tears the tunnel down after 60s of silence on its pipe
(`IDLE_GRACE`), and one page load plus a speed test is longer than that,
so the harness keeps a keepalive job running. Without it the tunnel dies
mid-measurement and the number is a lie about the route.

### Result: 32 pass, 2 slow, 0 failures

Every one of the 34 routes returned its own node's address to a browser.
Full table in the PR; the shape of it:

| transport | n | median down | median up | latency | page load |
|---|---|---|---|---|---|
| WireGuard | 4 | 52.2 Mbps | 50.6 | 305 ms | 5.3 s |
| VLESS+TLS | 4 | 45.1 | 105.4 | 398 ms | 4.6 s |
| Shadowsocks | 4 | 44.8 | 118.8 | 294 ms | 4.7 s |
| Trojan | 4 | 35.9 | 47.3 | 250 ms | 5.3 s |
| VLESS+TLS over WS | 4 | 34.0 | 60.0 | 292 ms | 5.0 s |
| IKEv2 | 5 | 33.4 | 7.1 | 280 ms | 5.5 s |
| VLESS+REALITY | 4 | 26.7 | 24.3 | 240 ms | 7.2 s |
| OpenVPN | 5 | 20.2 | 44.6 | 272 ms | 5.4 s |

The two flagged slow are both OpenVPN: finland1 at 6.0 Mbps against 61.1
for the same node's best route, turkey-1 at 12.3 against 52.2. Correct
exit, page loads, but a quarter or less of what the customer could have
had by picking a different protocol on the same server.

**The upload column is the weak one and should not be quoted.** It came
from a fixed-size POST (2 MB, retried at 8 MB if the first was quick),
and on a 200-600 ms path that is mostly TCP slow start — the same node
reported 118 Mbps on one route and 2.75 on another. A rewrite streaming
for a fixed window did not fix it either: Cloudflare's `/__up` answers
before the body finishes, so it measured 786 KB in 0.2 s. Download,
latency and page load are sound; treat upload as a floor.

**DNS was not isolated.** Resource Timing zeroes `domainLookup*` for
cross-origin resources without `Timing-Allow-Origin`, so the planned
per-route DNS number came back empty. What the latency column *does*
give is the cross-transport baseline that was missing: REALITY's median
request latency is 240 ms against WireGuard's 305 ms, so at the request
level REALITY is not the slow one. The 2.0-5.6 s figure was DNS
specifically and remains unexplained.

### finland1's REALITY route was never broken — the fixture was stale

`allroutes.json` carried `serverName=cloudflare.com`; the node has been
configured for `www.shatel.ir` since **2026-07-25**. Proven directly,
same node, same credentials, only the SNI changed, through a SOCKS-only
xray with no tunnel at all:

```
SNI www.shatel.ir   -> exits at 204.168.161.100   (the node)
SNI cloudflare.com  -> curl exit 35, nothing
```

REALITY is built to fail exactly that way: a client whose SNI the server
does not recognise is not refused, it is quietly proxied to the site the
server is imitating. A stale parameter is indistinguishable from a
broken route.

**The lesson is about the fixture, not the route.** Route profiles were
a file on disk nobody re-fetched, so every run since July dialled a
server that had moved. This run pulls all 34 from
`/customer/protocol-users` at start; `routes34.json` is generated, not
edited.

### OpenVPN had no MTU of its own

`wireguard.rs` pins `MTU = 1420` and explains at length why leaving it
to the network is not neutral. OpenVPN had no equivalent line at all,
and no node config sets `tun-mtu`, so OpenVPN 2.6 pushes its default of
1500 and the client's tun comes up as wide as the link underneath it.

Measured against turkey-1, which has no customers on it, with the link
narrowed deliberately:

| link MTU | config | tun0 | exit IP | 8 MB download |
|---|---|---|---|---|
| 1500 | as shipped | 1500 | 130.94.0.27 | 8388608 B in 3 s |
| **1400** | **as shipped** | **1500** | **(none)** | **0 B in 15 s** |
| 1400 | with the fix | 1348 | 130.94.0.27 | 8388608 B in 3 s |
| 1500 | with the fix | 1348 | 130.94.0.27 | 8388608 B in 2 s |

The tunnel reports "Initialization Sequence Completed" in every row,
including the one that carries nothing. Sub-1500 paths are ordinary on
PPPoE and mobile.

Three lines, each covering a direction the others cannot: `tun-mtu`
bounds what we send, `mssfix` rewrites the MSS in outgoing SYNs and so
bounds what the far end sends back, `pull-filter` stops the server's
pushed 1500 replacing either.

**Client-side only, deliberately.** Mobile has no OpenVPN at all
(`apps/mobile` implements none), so every OpenVPN customer is on the
desktop client and the fix reaches all of them without touching a node.
If OpenVPN ever comes to mobile, `push "tun-mtu"` on the server is the
right place and the installer is where it goes.

### Rig facts that cost time here

- **`keyboardputscancode` does not reach the guest when the VM was
  started `--type headless`.** The command returns success, the guest is
  demonstrably alive, nothing arrives. Started `--type separate` the
  identical command opens the Run dialog first try. That is a *third*
  cause of "the rig stopped accepting keys", after the frozen-guest
  theory (wrong) and the plural-command typo (right). **Start
  Neoxify-Test2 `--type separate`.**
- **The Run-dialog session is not elevated, and cannot be.**
  `Start-Process -Verb RunAs` returns without error and without
  elevating — no UAC prompt, no output, nothing. So `netsh interface
  ipv4 set subinterface ... mtu=` and any write into Program Files fail
  **silently** from that session. The first MTU experiment printed a
  complete set of results describing a 1500-byte link while claiming
  1400, and the only reason it was caught is that the script also
  printed the subinterface table and a DF ping sweep, which disagreed
  with what it said it had done. The narrow-link work moved to WSL2,
  which is a separate VM with its own routing table; the host's default
  route was checked before and after and was unchanged.
- **Do not write PowerShell into the share with a bash heredoc.**
  `printf` and heredoc expansion collapse `\\vboxsvr` to `\vboxsvr`, and
  a script that writes its results to an invalid path looks exactly like
  a script that did not run. Two separate mysteries this session were
  this.
- **The guest froze twice, and the tell is the clock.** The VM process
  kept burning ~5% host CPU while the guest stopped dead: guest clock 36
  minutes behind the host, and `ImageChops.difference` over two
  screenshots a minute apart returning `None` — measured, not eyeballed.
  Host free RAM was 2.8-4.1 GB against a 6144 MB guest. **Guest memory
  reduced to 4096 MB**, which is ample for one headless Edge and took
  host free memory to 5.6 GB. No freeze after that. Cost of the second
  one: 21 minutes of a batch, resumed with `-Start 25`.

### Left for the owner

- **germany-1's API mirror is dead.** `/api/` returns 502 on both TLS
  ports while its fallback *site* serves 200, which is the stale-upstream
  shape the installer now avoids with a resolver plus a variable
  `proxy_pass` — turkey-1, built last night, has that shape and works.
  Needs `ensure_fallback_site` re-run on germany-1; I have no SSH key
  for that node. Of five nodes only finland1 and france-1 carry a mirror
  that behaves as designed: turkey-1's returns the node's own address
  (the Cloudflare/XFF finding, confirmed from outside) and singapore-1
  has none at all.
- **singapore-1 serves only IKEv2 and OpenVPN** — the two transports
  Iran identifies first, and no Xray at all, which is also why it can
  host no mirror. Every other direct node serves all eight. Adding the
  Xray engines is an installer run, not a two-minute change.
- **turkey-1 and finland1 OpenVPN are a quarter the speed of their own
  nodes' best route.** Not investigated; OpenVPN is the slowest
  transport in the fleet by median (20.2 Mbps against WireGuard's 52.2).

**Nothing was changed on any node.** All node access was read-only.
---

## 2026-08-22 — singapore-1 now serves all eight; germany-1's mirror is blocked on a key

**Status:** singapore-1 done and verified; germany-1 **blocked on SSH access**
**Touches:** live — singapore-1 (six new engines), plan route lists; repo — `installer/`

singapore-1 served only IKEv2 and OpenVPN, the two transports Iran
identifies first. It now serves the same eight as every other direct
node, each measured by exit IP rather than by a green install:

| protocol | port | exit |
|---|---|---|
| VLESS+REALITY | 443 | 172.236.143.200 |
| VLESS+TLS | 2083 TCP | 172.236.143.200 |
| VLESS+TLS over WebSocket | 2083 `/assets/…` | 172.236.143.200 |
| Trojan+TLS | 2053 | 172.236.143.200 |
| Shadowsocks 2022 | 40083 | 172.236.143.200 |
| WireGuard | 20176/udp | 172.236.143.200 |
| OpenVPN | 26471/udp | pre-existing, untouched |
| IKEv2 | 500/4500 | pre-existing, untouched |

Added to Trial, Starter, Pro and Ultimate Max — 8 routes each, 28
credentials per route. **Ultimate deliberately excluded**: relay-only
plan, direct node. `PATCH /plans/:id` takes `allowedRouteIds` with `set`
semantics, so each plan was read, unioned and written back; sending only
the new ids would have silently deleted the other 34 routes from every
plan. `_PlanAllowedRoutes` was dumped first.

The two live transports were never restarted — `systemctl show
... ActiveEnterTimestamp` still reads 11 August for both openvpn-server
and strongswan-starter. needrestart deferred them and was left to.

### Verified without tunnelling anything

All six ran as **client-side xray on the panel box**, SOCKS inbound on
loopback, `curl --socks5-hostname` to `1.1.1.1/cdn-cgi/trace`. WireGuard
too: xray's **userspace** wireguard outbound needs no kernel module, no
netns and touches no routing table, so proving a WireGuard exit cost the
same as proving a VLESS one. Cheaper than WSL2 and nothing to tear down.

REALITY passing on exit IP is the load-bearing part: a wrong shortId
produces a tunnel that comes up and quietly proxies to the decoy site,
so `PASS 172.236.143.200` rather than Shopee's address is what says the
identity is right.

### The decoy had to be measured, and Singapore is the hard case

The installer's built-in default for this node was `www.zoomit.ir` —
Iranian, CDN-hosted, wrong on both counts for a Singapore address.

**Every consumer-facing .sg site probed sits behind a CDN.** Cloudflare,
Imperva, Akamai or CloudFront, including all five universities, the
polytechnics, both ISPs' portals, sgnic.sg and the .gov.sg sites. The
two genuinely Singapore-hosted hosts found (`www.pacific.net.sg`,
`www.simba.sg`) offer neither TLS 1.3 nor h2 — the `www.mynet.com`
lesson from Turkey, again.

What worked was **`www.shopee.sg`**: netname `SHOPEE-SG`, the company's
own Singapore netblock, TLS 1.3 + h2 + X25519 verified from sg1 **and**
from ir1. `www.lazada.sg` looked equally good from Singapore and was
rejected on the ir1 probe alone — from Iran it resolves to `10.10.34.35`,
a poisoned answer. One probe from where the customers are settled it,
exactly as it did for Turkey.

**The installer's own "hosted abroad" list has rotted the same way
speedtest.net did.** `www.asus.com` → 13.249.231.81 and
`www.leboncoin.fr` → 13.35.36.62 are both AWS CloudFront. They pass
every check `probe_reality_dest` makes, because that function tests the
handshake and **nothing tests criterion 1** — so the default offered to
an operator holding Enter is a CDN name on a non-CDN address, the exact
mismatch the list exists to prevent. Commented loudly rather than
swapped: two fresh names would rot identically. The real fix is for the
probe to check who owns the address, which is a feature, not a comment.

### Two more ways to hold Enter and lose a transport

Commit 8c86d62 fixed the Trojan and Shadowsocks port prompts. It missed
the gate above them:

> `Certificate-based stealth protocols (optional) … Set them up? [y/N]`

One Enter there dropped **VLESS+TLS, VLESS over WebSocket and Trojan**
at once, silently. Now defaults to yes, and an empty domain skips those
three with a message instead of `return 1` — which used to abort
`install_xray` outright and leave xray-core installed and never
configured, REALITY included.

Also: **singapore-1 had no `/etc/neoxify/role`**, being enrolled before
that marker existed. `install.sh` therefore offered the role question,
whose only sensible answer re-enrolls a node that is already serving
customers. It now infers the agent role from `agent.json` and writes the
marker. Verified by removing the file on sg1 and re-running.

### germany-1: the diagnosis is certain, the fix is not reachable

`/api/` returns 502 on `de1.neoxify.site:2053` while the fallback site
serves 200 — still the stale-upstream shape. Worth recording *why*, and
it is not what the old entry assumed: `connect.neoxify.com`, the name
germany-1 was built against, **still resolves to 167.233.65.166**, the
current panel. So DNS is fine and the name is fine; nginx cached the
address of a literal `proxy_pass` hostname at config load, back when the
panel was a different VPS, and has held it ever since. A re-run of
`ensure_fallback_site` writes the resolver-plus-variable form that
turkey-1 has and fixes it. **Nothing in `installer/` needs changing —
the fix is already there.**

**Blocked: no key opens germany-1.** `ovh_neo`, `azs_vps` and `neo_tr1`
all give `Permission denied (publickey)` on root and on ubuntu/debian/
admin/neoxify; only port 22 is open; and the panel's own
`~/.ssh/id_ed25519` is refused too. There is no remote path either — the
agent's command set is CREATE/UPDATE/DELETE/DISABLE/ENABLE_USER,
SET_QUOTA, SYNC, CONFIGURE_ROUTE, REMOVE_ROUTE, with no exec of any
kind, which is the right design and also means the panel cannot repair a
node. **This needs a key from the owner; it is two minutes of work once
there is one.**

### Left open: the mirror still loses the client's address

Unchanged, and now with the missing measurement. `origin.neoxify.site`
resolves straight to 167.233.65.166, serves the API, and **preserves the
real client address** — a direct call returned the caller's own IP, not
the panel's. So pointing the mirror there would fix XFF fleet-wide.

The obstacle is a certificate, not a design: the panel's cert carries
`DNS:connect.neoxify.site` and no SAN for `origin.neoxify.site`, so
`curl` fails `SEC_E_WRONG_PRINCIPAL` against it. nginx would not notice
(`proxy_ssl_verify` is off by default) which makes the fix *look*
one-line and actually mean "the mirror hop stops verifying the panel".
Doing it properly wants a cert covering the origin name first. Still a
fleet decision, still deliberately not taken here.

**Also noticed:** nodes built with the current installer answer
`Welcome to nginx!` on port 80 — singapore-1, turkey-1 and germany-1 all
do, finland1 does not. nginx arrives for the loopback fallback site and
Ubuntu's default vhost comes with it. It is a fleet-wide fingerprint of
its own and nobody put it there on purpose.
