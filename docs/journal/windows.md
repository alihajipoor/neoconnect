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
