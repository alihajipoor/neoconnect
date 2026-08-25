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

---

## 2026-08-22 — Custom mode leaked every IPv6 packet, and the full tunnel still does

**Status:** Custom-mode leak fixed and measured, PR #29; the full-tunnel
case is **inferred, not measured** — see below before acting on it
**Touches:** `apps/desktop-windows/service/src/split_tunnel/`{`redirect.rs`,`owner.rs`,`divert.rs`},
`apps/desktop-windows/src/lib/i18n.tsx`

Custom mode's packet loop parses IPv4 only. Nobody had ever run it on a
machine with IPv6, so nobody had seen what that does. It leaks —
completely and silently.

Reproduced on `Neoxify-Test2` (bridged, so it takes the router's
`fd00::/64` RA) with a global-unicast prefix routed off-box for good
measure. One 22-second window:

```
PRODUCTION FILTER delivered: ipv4=25 ipv6=0
ALL-IPV6 observer saw:       ipv4=0  ipv6=8
```

Eight IPv6 packets left the machine and the filter handed over none. A
listener on this box caught the payload: `GET /BEFORE-ula HTTP/1.1`,
plaintext, from the guest's own address, while the app said Custom mode
was on.

**Fixed by blocking, not carrying.** Carrying is not reachable from the
client: the tunnel adapter has no IPv6 address (`Address = 10.77.0.8/32`,
`AllowedIPs = 0.0.0.0/0`) and every route the client installs is v4, so
there is nowhere to send a v6 packet. Giving it one means the node hands
out v6 addressing — **server-side work, not started, not decided.** If
anyone picks that up, that is the blocker to solve first; the client-side
parts (v6 NAT table, v6 rewrite, `IPV6_UNICAST_IF` with its host-order
index) are ordinary work behind it.

### The thing that is NOT fixed and is bigger — and is NOT proven

**Read this line before repeating the claim anywhere: nothing in this
section was measured.** It is a reading of the source, and the whole
reason the Custom-mode leak above went unnoticed is that reading the
source is exactly what everyone had done.

What *is* established, by grep and by opening the files:

- `engines/routing.rs` contains zero occurrences of `ipv6`/`Ipv6`. The
  full tunnel installs `0.0.0.0/1` + `128.0.0.0/1`; the passive route is
  a real `0.0.0.0/0`. All IPv4.
- `engines/wireguard.rs` sets `allowed_ips: "0.0.0.0/0"`, and the tunnel
  address is a v4 `/32`, so the adapter has no IPv6 address at all.
- Nothing in the client runs `netsh interface ipv6` or installs a `::/0`.

What that **suggests**, and what nobody has yet seen happen: on a
dual-stack network an ordinary connect — Custom mode entirely off —
leaves IPv6 going out in the clear. That is the default path, so it
would affect every customer rather than only Custom-mode users.

What would settle it: connect normally on a rig with working IPv6 and
watch whether v6 still leaves the physical adapter — a WinDivert sniff
handle on `outbound and ipv6 and (tcp or udp)`, plus a listener on
another machine to confirm plaintext arrival. It needs a real node, which
is why it was not done here. **Measure it first; do not fix it on the
strength of this note.**

Note also that the fix above does **not** cover it. The block lives in
the redirect packet loop, which only runs while Custom mode is on. Both
Custom-mode directions (`OnlySelected` and `AllExcept`) are covered
because both go through that loop. A plain connect does not.

### Techniques worth reusing

- **`WinDivertHelperEvalFilter` answers "what is this filter blind to".**
  A packet the driver never delivers leaves no trace, so "we saw none"
  and "none were sent" are indistinguishable in the counters — which is
  exactly why this went years unnoticed. The evaluator is userspace and
  needs no driver and no admin, so it turns that question into a unit
  test. `divert::eval_filter`, test-only.
- **`ip` in a WinDivert filter means IPv4 only.** `ipv6` is a separate
  keyword. Any filter here that opens `outbound and ip and ...` is
  covering half the traffic and saying nothing about it.
- **To prove a packet was *dropped*, sniff below the loop.** A second
  WinDivert handle at priority -1000 sees only what the real handle let
  past. Before: it counted the escaping packets. After: zero. The
  service's own counter could not have shown that — it reports intent.
- **Scope was proven with the same binary twice.** `curl.exe` selected,
  a copy at another path not: 21 v6 packets in, 5 blocked, 16 out, same
  destination on both sides. Cheaper and far more convincing than
  reasoning about `should_tunnel`.

### Rig gotchas that cost time

- **A test binary built for the VM needs `+crt-static`.** The VM has no
  VC++ redist; without it every exe dies with `0xC0000135`
  (`STATUS_DLL_NOT_FOUND`) and looks like a missing `WinDivert.dll`.
- **`cargo build` fails in the scratchpad for the same MAX_PATH reason
  the panel build does** — `LNK1104: cannot open file ...`. Build from a
  short path (`C:\Users\aliha\v6p`).
- **`keyboardputstring` lands in the Start *search box* if the menu is
  not where you think**, and Enter then opens a Bing search in Edge
  rather than running anything. Screenshot between the keystrokes; do
  not fire the whole sequence blind.
- **Opening a WinDivert handle from a temp directory registers the
  driver service pointing at that path.** Deleting the directory
  afterwards leaves a `WinDivert` service whose `ImagePath` no longer
  exists, which would break the real client's Custom mode on that box.
  `sc delete WinDivert` before removing the files — done here, VM
  verified clean and powered off.

The customer-facing line changed with it: `dash.customActive` now says
IPv6 is blocked rather than sent outside the tunnel. Deliberately *not*
in `Stats::complaint()` — that counter climbs from the first second on
any dual-stack network, so a complaint keyed on it would be permanently
lit, and this codebase already decided (see `WARMUP`) that a standing
false alarm is worse than silence.

---

## 2026-08-22 — The full-tunnel IPv6 leak was real; blocked in our code on the three engines that leaked

**Status:** written and building; **the rig re-run is NOT done** — see
"What still has to be measured" before quoting this anywhere
**Branch:** `claude/full-tunnel-ipv6` (not pushed, no PR)
**Touches:** `apps/desktop-windows/service/src/engines/`{`ipv6_block.rs` (new), `mod.rs`},
`service/src/pipe.rs`, `ipc/src/lib.rs`, `src-tauri/src/`{`vpn.rs`,`lib.rs`},
`src/lib/`{`egress.ts`,`i18n.tsx`}, `src/screens/Dashboard.tsx`

The section above said the full-tunnel case was inferred and told the
next session to measure it before fixing it. It was measured, and the
inference held.

Client 0.9.25, node germany-1, dual-stack guest, capture taken **host
side at the vNIC** — outside anything the client can influence. Plain
full tunnel, split tunnel **off**, clear-text public-destination IPv6
packets:

```
OpenVPN             13 (disconnected)  ->  14   LEAK
IKEv2               13                 ->  14   LEAK
Xray VLESS-REALITY  13                 ->  smaller, non-zero   LEAK
WireGuard           13                 ->   0   blocked
```

In every leaking case the app said `connected: true` and the v4 exit
address was the node's. That is the combination that hid this: IPv4
genuinely tunnelled, IPv6 in the clear, and every instrument the app
owned agreeing that the customer was protected.

**REALITY's smaller number is not partial protection.** Xray captures
DNS, so a v6-only hostname never resolves and never produces a packet.
Raw v6 — literal addresses, cached `AAAA` — still egressed; ICMPv6 and
inbound TCP 443 were both seen.

### WireGuard was safe, and not because of us

`wireguard.exe` arms its own WFP kill-switch. The capture read it
directly: provider **"WireGuard"** owning a BLOCK filter named
`Block all outbound (IPv6)` at `FWPM_LAYER_ALE_AUTH_CONNECT_V6`, the
matching inbound one, and permits for NDP, DHCP, loopback, its TUN
interface and its service.

So the mechanism was already proven on customers' machines by a binary
we already ship. The fix is that shape, in our code, for the engines
that do not bring one — `engines/ipv6_block.rs`. Ten filters: BLOCK at
`ALE_AUTH_CONNECT_V6` and `ALE_AUTH_RECV_ACCEPT_V6` at weight 0, and at
weight 12 above them, per layer, permits for loopback (both the `::1`
address form and `FWP_CONDITION_FLAG_IS_LOOPBACK`), `fe80::/10` and
`ff00::/8`. The last two are what keep NDP, RA, DAD and DHCPv6 alive —
without them this does not stop internet IPv6, it stops the machine
talking to its own router.

### Things worth knowing before touching it

- **User-mode WFP is enough.** `fwpmu.h`, no driver. User mode may add
  PERMIT/BLOCK at the ALE layers; only *redirection* needs a kernel
  callout. Nothing here redirects.
- **The session is `FWPM_SESSION_FLAG_DYNAMIC`, and that is the whole
  safety argument.** Every object belongs to the engine handle, so the
  kernel removes them when the process dies — killed, crashed, or
  stopped. No persistent filter, nothing boot-time, nothing that can
  strand a customer's networking. Removal is "close the handle"; there
  is deliberately no per-filter delete loop that could miss one.
- **Everything goes in inside one transaction.** A half-installed set is
  worse than nothing: the ordering that fails first leaves the
  machine-wide BLOCK up with the permits missing, which takes the LAN
  down.
- **Gates.** WireGuard is exempt (its own kill-switch; two providers
  blocking the same thing is a debugging trap). Custom mode is exempt —
  `redirect.rs` already handles v6 there *per application*, and a
  machine-wide block would change unselected apps' behaviour, which
  nobody asked for. Residual gap, stated: in `AllExcept`, the excluded
  apps and everything else keep their IPv6.
- **`ALE_AUTH_CONNECT_V6` classifies at flow establishment.** A v6
  connection already open when the tunnel comes up is not re-examined.
  WireGuard's kill-switch has the same property.
- **Struct layouts are windows-sys generated bindings, not hand-written.**
  `FWPM_FILTER0` is a nest of unions and this repo has already paid for
  hand-declaring a Windows structure once (three wrong RAS layouts, one
  of which dialled and then killed the service from inside RASAPI32).

### The blind spot that hid it, and what replaced it

`egress.ts` compared the address `/health/ip` saw before and after
connecting. On every node that is an IPv4 conversation, so a machine
leaking v6 beside a working v4 tunnel came back `throughTunnel`. The
check was not wrong; it could not see half the machine.

New question, `vpn::probe_ipv6_egress`: can a public IPv6 *literal* be
reached from here? Literal, because a hostname is resolved by Windows and
may answer with an `A` record. Two operators (`2606:4700:4700::1111`,
`2001:4860:4860::8888`, TCP 443, concurrent, 2.5s) so one filtered
anycast address does not read as "no IPv6".

**It had to be native.** The app's HTTP permission is scoped to
`*.neoxify.site` in `src-tauri/capabilities/default.json`, so a `fetch`
to any probe address is refused by Tauri's own ACL before a packet
leaves — a check that always answers "no IPv6" and can never fail. That
was caught by reading the capability file, not by running it; worth
remembering for any future probe written in the frontend.

A baseline is taken **before** connecting, because most machines have no
public IPv6 at all. Without it, "the probe failed" cannot tell a blocked
machine from one that never had any, and either would be a false alarm
on the common case.

A leak is surfaced and deliberately does **not** mark the tunnel
degraded: that hands it to the failover ladder, which tears down a
working connection for the next protocol — which leaks identically — and
cycles every candidate before ending where it started.

### What still has to be measured

Nothing below has been run. `cargo build`, `cargo check --workspace
--all-targets`, `cargo test --workspace`, `tsc`, `vite build` and
`vitest` all pass, and that means it compiles.

1. **Re-run the matrix.** Same rig, same node, split tunnel off, capture
   host-side. Baseline vs connected clear-text public-v6 counts must go
   13 -> 0 for OpenVPN, IKEv2 and REALITY, the way WireGuard already
   does. Anything above zero is the fix not working, whatever the log
   says.
2. **Crash test.** Kill the service while connected (`taskkill /F`, not
   a stop). The filters must vanish — `netsh wfp show filters` should
   have no `Neoxify` provider — and IPv6 must come back without a
   reboot. This is the claim the dynamic session makes and it is the one
   that hurts customers if it is wrong.
3. **LAN survival.** With the block up, confirm NDP/RA still work: the
   machine keeps its link-local neighbours and does not lose its router.
   The permits are what this tests.
4. `wfp_accepts_the_whole_filter_set_then_it_is_aborted` (in
   `ipv6_block.rs`) hands the real filter set to the real engine inside a
   transaction and aborts it, so WFP validates every structure without
   filtering a packet. **It skipped locally** — adding filters needs
   administrator and this shell is not elevated (`FwpmTransactionBegin0`
   returned `0x5`). CI's Windows runner is elevated, so it runs there.

### Still the interim

Blocking is not the destination. Every node is IPv4-only — the server
configs carry no v6 addressing, no tunnel adapter gets a v6 address, and
every route the client installs is v4 — so there is nowhere to send a v6
packet. The real fix is IPv6 on the nodes, after which this module
should carry v6 rather than drop it and `dash.fullTunnelIpv6Blocked`
should go with it.

Until then it is a stated gap, not a silent one: the dashboard says IPv6
is blocked while connected, in English and Persian, and says it only
when the service reports a block is actually installed.

## 2026-08-23 — 0928 verified on the wire: IPv6 fixed, the uninstall was not

**Status:** three rig-found defects fixed on `claude/integration-0928`;
**none of the three fixes has itself been through the rig** — see "What
a re-test has to do"
**Branch:** `claude/integration-0928` (not pushed, no PR)
**Touches:** `src-tauri/nsis-hooks.nsh`,
`service/src/split_tunnel/`{`owner.rs`,`mod.rs`,`redirect.rs`},
`service/src/engines/dns.rs`

The 0928 integration branch — teardown/janitor, split-tunnel wave 1,
full-tunnel IPv6 block — went to the VM with packet captures. What
follows is what the wire said, then the three things it said were
wrong.

### IPv6: the claim held, and it is now zero

The previous entry left "re-run the matrix" as the outstanding
measurement. It was run, host-side at the vNIC, split tunnel off.
Clear-text public-destination IPv6 packets, connected:

```
OpenVPN             LEAK  ->  0
IKEv2               LEAK  ->  0
Xray VLESS-REALITY  LEAK  ->  0
WireGuard              0  ->  0   (never ours; see below)
```

The crash test passed too: `taskkill /F` on the service while
connected, and the filters are gone — no `Neoxify` provider in WFP —
with IPv6 back without a reboot. That is the one claim the dynamic
session makes that would hurt customers if it were wrong, and it is now
measured rather than argued.

**WireGuard is exempt on purpose and stays exempt.** `wireguard.exe`
arms its own kill-switch and the capture reads it directly under
provider "WireGuard". Two providers blocking the same thing is a
debugging trap, not defence in depth.

### The split-tunnel wave

**B-1, the activation race: 20 of 20.** What makes that number worth
anything is not the counters — this file's whole history is counters
reading healthy through a leak — it is that each trial ended with an
exit-IP check that had to come back as the node. A pass is "the
connection that survived activation is demonstrably inside the tunnel",
not "nothing threw".

**B-2, the browser: 219 -> 0.** Plaintext UDP/443 datagrams from Chrome
before activation, and after. A real QUIC client holds its socket open,
so the second datagram is always attributable and the first is caught
by `image_for_new_connection`.

**And the gap that is left.** A UDP socket closed microseconds after
its send still egresses in clear text from a selected app: Windows
drops the port from the endpoint table when the socket closes, so by
the time the owner lookup rebuilds there is no row naming the owner,
and in `OnlySelected` an unknown owner means leave alone. 13 of 15 in
one run, 14 of 15 in the next. Reproducible, not a race retrying wins,
and **not fixable by asking harder** — the fact the lookup needs is
already gone. It needs the B2 WFP `ALE_APP_ID` filter, classified in
the sending process at send time. Written down at the decision point in
`redirect.rs`; nothing about it changed.

### The three defects, and what was done about them

**1. Uninstall left `NeoxifyService` registered. This was the real
failure of the session.** On a machine where `resources\WinDivert.dll`
is missing the service binary cannot load at all — no stdout, no
stderr, no exit code — and `NSIS_HOOK_PREUNINSTALL` removed the service
*only* by running that binary. `uninstall.exe /S` exited 0 and left a
registered service pointing at a deleted binary. Everything else in the
same test passed: NRPT gone from both registry locations, firewall rule
gone, `Neoxify-OpenVPN` adapter gone, RAS entry gone, ARP entry gone,
WinDivert gone.

That is the exact field state the "removals that do not go through our
service" section was written for, and it was the one removal still
inside it. `NSIS_HOOK_PREINSTALL` has done the right thing since the
rename — unconditional `sc.exe stop` + `sc.exe delete` for both
`NeoxifyService` and `NeoConnectService` — which is why upgrading over
a broken install recovers where uninstalling did not. The uninstall
hook now makes the same four calls. `sc.exe delete NeoxifyService`
returns SUCCESS immediately in that state; checked by hand on the rig.

Also found: an orphaned `C:\Program Files\Neoxify\neoconnect-service.exe`
from the pre-`resources\` layout, beside the live one, months stale,
surviving uninstall. Nothing runs it — but anyone diagnosing a machine
reads its version first and is then debugging a build that is not
installed. Deleted on both install and uninstall now.

**2. The activation convergence loop was closing connections it had
just carried.** With zero selected processes running before activation
and dialling started only after `split_tunnel_active`, the log still
said `activation reset settled after 12 rescan(s): 30 connection(s)
closed in total`. All thirty had been carried successfully.
`reset_selected_connections` filtered only by remote address, so by the
second rescan a freshly redirected connection is indistinguishable from
a stale one. It now takes the same `carried` predicate the escape audit
takes (`Nat::has_flow`, non-refreshing — `lookup_flow` would renew every
entry it read and stop `expire_idle` retiring anything).

**3. `dns::clear()` never looked at the GPO registry location on the
normal path.** It returned the moment PowerShell reported a clean `0`,
which is what normal operation reports — so the registry sweep only ever
ran on the fallback. A rule of ours under
`HKLM\SOFTWARE\Policies\...\DNSClient\DnsPolicyConfig` survived every
ordinary disconnect. `Get-DnsClientNrptRule` does not enumerate that
location, so a clean cmdlet report says nothing about it. The sweep is
unconditional now; the resolver poke stays gated on something actually
having been removed.

**The PowerShell fallback is not going anywhere.** The rig watched the
removal blow the 15s helper budget three times under load. "The cmdlets
answered" is not something to build on.

### What a re-test has to do

None of the three fixes above has been measured. Specifically:

1. **The uninstall.** Restore `pre-0928`, install, delete
   `resources\WinDivert.dll`, run `uninstall.exe /S`, then
   `sc.exe query NeoxifyService` — must be "does not exist" — and check
   `$INSTDIR\neoconnect-service.exe` is gone. This one **cannot be
   proven any other way**; there is no unit test for an NSIS macro.
2. **The convergence loop.** Same shape as the run that found it: no
   selected process before activation, dial after `split_tunnel_active`,
   read the settle line. It must report 0 closed, and a selected app's
   exit IP must still be the node afterwards — a reset that closes
   nothing because it now skips everything would look identical.
3. **`dns::clear()`.** Plant a rule carrying our comment at the GPO
   location, connect, disconnect, and confirm it is gone and the
   cleanup log names it as one the cmdlets did not report.

The hook edits were compiled with Tauri's own makensis
(`%LOCALAPPDATA%\tauri\NSIS`) through a harness that inserts the three
macros into sections the way the generated `installer.nsi` does. That
proves they parse. `cargo build -p neoconnect-service`,
`cargo check --workspace --all-targets` and `cargo test --workspace`
all pass, and that means it compiles.

### Rig traps that cost real time this session

- **The guest CAN elevate.** Older notes in this file say otherwise.
  They are wrong; do not plan around them.
- **Defender blocks hidden PowerShell launched from the `Z:` share.**
  Copy the script into the guest first, or it dies with nothing useful
  on screen.
- **`keyboardputstring` eats `\`, `>` and `|`.** Every path and every
  redirect typed that way arrives mangled. Base64 the command, or type
  it somewhere it can be checked before running.
- **VirtualBox under Hyper-V wedges the guest.** AHCI reset followed by
  a heartbeat flatline, with the host disk idle — so it is not I/O
  pressure and waiting does not help.
- **Live snapshots fail** with `VERR_VM_UNEXPECTED_UNSTABLE_STATE`.
  Power off first and take them offline.
- **The v6net NAT answers every v6 SYN with a local `ACK|RST` in about
  350us.** "Got a reply" therefore proves nothing at all about
  reachability. Read the capture, not the connect result.
- **UDP to TEST-NET ranges stops leaving the guest** once the NAT starts
  answering with ICMP. Use a fresh routable destination for each phase
  or the second phase measures nothing.
- **Searching WFP filters by display name gives false all-clears.**
  Group by provider key instead; that is how the WireGuard set was found
  and how ours is confirmed gone after a crash.

### Snapshots on the VM

- **`pre-0928`** — clean install of the pre-integration build. The
  starting point for the uninstall re-test, and the only state in which
  the `NeoxifyService` failure reproduces.
- **`pre-verify2`** — taken after the IPv6 matrix and before the
  split-tunnel runs, so the B-1/B-2 measurements can be repeated without
  redoing the matrix.

Both are offline snapshots, for the reason above.

## 2026-08-23 — the three fixes went back through the rig, and all three hold

**Status:** done — this **supersedes** the previous entry's "none of the
three fixes has itself been through the rig". That was true when it was
written; it is no longer. The re-test in "What a re-test has to do" has
been run in full, plus an IPv6 regression check.
**Branch:** `claude/integration-0928`
**Touches:** nothing in the tree — measurement only

The installer under test was `Neoxify_0.9.27_x64-setup.exe`, built from
`38f4fe4` at `C:\nx0928`, SHA-256
`2b7068447868c5b8371630301f4cdac5941208f6f2f7a0771e6dc52463a3986e`.

**Confirming the new build was actually the one installed took work.**
Both the old and new builds report 0.9.27 — the version bump lands in
`a3322bd`, after the hooks — so the version string cannot tell them
apart and reading it would have been a false pass. Binary hashes before
and after were compared instead, and the stale root-level
`C:\Program Files\Neoxify\neoconnect-service.exe` was absent after the
install, which only the new PREINSTALL hook does.

### 1. Uninstall on a service that cannot load — PASS, against a negative control

The OLD build was put through the identical broken state first and **did
leave the service registered**: `sc query NeoxifyService` →
`SERVICE_NAME: NeoxifyService  STATE: 1 STOPPED`, the key still there
with `ImagePath` naming the deleted binary. That control is the whole
point: without it a clean "does not exist" only proves the test never
reproduced the failure.

New build, same state: `sc query NeoxifyService` → `FAILED 1060: The
specified service does not exist`, the same for `NeoConnectService`,
both registry keys absent, `C:\Program Files\Neoxify` gone, NRPT clear
in the cmdlets *and* both registry locations, firewall rule gone,
`Neoxify-OpenVPN` adapter gone, `rasphone.pbk` absent, and
`sc query WinDivert` → 1060.

**Two false-pass traps were found while building this test, and both
would have produced a green result on a broken build:**

- **Deleting `WinDivert.dll` while the service is running fails
  silently.** The process holds the handle, the delete does not take,
  and the binary then loads perfectly well and removes its own service —
  the exact scenario the test exists to break. Stop the service first
  and confirm the file is actually gone before running the uninstall.
- **The RAS check was unfalsifiable.** The service removes that entry on
  every disconnect, so `rasphone.pbk` being absent after an uninstall
  says nothing about the uninstall at all. An entry was planted back in
  before each run, in both the control and the test, so the check could
  fail.

### 2. Activation reset — PASS, twice

`activation reset settled after 12 rescan(s): 0 connection(s) closed in
total`, with `redirected` still climbing — 68/38 and 60/30
seen/matched/redirected/returned across the two runs — and the selected
app's exit IP reading `38.60.249.229` while an unselected app read
`50.34.35.228`. The counter alone would not have been evidence: a reset
that closes nothing because it now skips everything reports the same 0.
The exit IPs are what make it mean something.

Run twice deliberately, because the old build's closed-count varied run
to run (30 / 120 / 124 / 128). One 0 could have been luck.

### 3. NRPT GPO-location sweep — PASS

A rule of ours was planted at
`HKLM\SOFTWARE\Policies\Microsoft\Windows NT\DNSClient\DnsPolicyConfig`
**while connected**, alongside two foreign rules. After a normal
disconnect — not the fallback path — ours was gone, both foreign rules
survived with their comments intact, and `cleanup.log` recorded
`removed 1 rule(s) from the registry that the cmdlets did not report`.
`Get-DnsClientNrptRule` was empty for the whole run, which is the point:
the cmdlets never saw any of it, so a clean cmdlet report proves nothing
about that location.

### 4. IPv6 regression — PASS

The hook and DNS changes are nowhere near the WFP code, but the same
build was checked rather than assumed. `analyze6.py`: baseline 13 egress
/ 10 ingress disconnected, **0 / 0** connected. WFP provider key
`{a1e1f9c2-6b7d-4f4a-9c33-2d5b8e7a41d0}`: 0 filters disconnected → 10
connected (5 per layer) → 0 after disconnect.

**On the two sets of IPv6 numbers in this file — both are right.** The
"13 → 14 / 14 / smaller" figures are the *original leak measurement* on
client 0.9.25. The "13 egress / 10 ingress" figures are the
*disconnected baselines* of this verification run on the fixed build,
where every connected count is 0. Different runs, different instruments;
neither supersedes the other and neither should be quoted as if it did.

### Defender flags the unsigned local build

Windows Defender detects the locally built, **unsigned** installer as
`Trojan:Win32/Bearfoos.B!ml` (threatID 2147731849) and quarantined it on
a second install attempt. `!ml` is the machine-learning bucket — an
unsigned Tauri/NSIS binary with an installer hook that shells out to
`sc.exe` is a textbook false positive. CI-signed releases are not
affected. **No Defender settings were changed** to get the run done; if
this bites again, restore the snapshot and copy the installer in fresh
rather than turning protection off.

### Snapshots on the VM

Now `pre-0928` → `pre-verify2` → `pre-verify3`. `pre-verify3` is the
state the uninstall control and test both start from. All offline
snapshots, for the reason in the previous entry.

---

## 2026-08-23 — the redirect loop that outlived its tunnel, and took the machine's DNS with it

**Status:** fixed and proven on the rig; **not released**, not pushed.
**Branch:** `claude/fix-orphaned-redirect` (off `81875bb`)
**Touches:** `apps/desktop-windows/service/src/{engines/mod.rs,
split_tunnel/{mod.rs,redirect.rs,firewall.rs}}`

### The report

A beta user, on Custom mode with a browser selected: Telegram fine,
browsers very slow, YouTube would not load at all. He disconnected and
closed the app — and his networking stayed dead. Browsers still loaded
nothing. He connected a **different, unrelated VPN app** and still
nothing. Then he found `neoconnect-service` in Task Manager, ended it,
and everything worked immediately.

The first symptom is very likely the UDP/QUIC attribution race 0.9.28
already fixes (YouTube is QUIC, Telegram is TCP) and was not chased
here. Symptoms 2–4 are this entry.

### The mechanism, reproduced before it was believed

The service being resident is normal — it is LocalSystem auto-start.
What mattered was that **killing the process fixed it instantly**, and
almost nothing this product installs behaves that way. Routes, NRPT
rules and persistent WFP filters all survive a process death. Two
things do not: dynamic-session WFP filters, and the **WinDivert
handle**, because the driver stops intercepting when the last handle
closes. That narrowed it to interception before a line of code was read.

`Engines::status()` reports live state rather than a remembered flag, so
when a WireGuard tunnel dies on its own it noticed, wrote `self.active =
None`, and answered "disconnected". Correct as far as it went. What it
did **not** do was stop the split tunnel. The redirect loop carried on
with the dead adapter's index still pinned in it.

That would be survivable if it only affected selected apps. It does not:
**Custom mode carries every process's DNS**, not just the selected ones
(`redirect.rs`, the `carry_dns && is_dns(parsed)` branch sits *above*
the `if !selected` test, deliberately, so a lookup is never handed to
the customer's ISP). So from that moment every lookup on the machine was
redirected into a relay whose upstream socket could no longer bind.
`split-tunnel.log` on the rig, several times a second:

```text
upstream attach FAILED for 1.1.1.1:53: An invalid argument was supplied.
  (os error 10022) (interface 20, source 10.66.0.2)
upstream bind failed for udp flow: An invalid argument was supplied. (os error 10022)
```

Interface 20 and 10.66.0.2 are the WireGuard adapter that no longer
exists. That is the whole bug in two log lines.

Everything else in the report follows from it:

- **Disconnect did nothing** — the app had already been told
  "disconnected", so it showed Connect and never sent one.
- **Closing the app did nothing** — same reason.
- **A different VPN did not help** — we were taking the packets
  underneath it, at the WinDivert layer.
- **The 60s idle watchdog never fired** — `pipe.rs` gates it on
  `if !up { continue; }`, and `up` was false. The one thing designed to
  reap an abandoned session skipped precisely the state that needed it.
- **End Task fixed it instantly** — last handle closed.

Two more holes in the same shape, found while tracing and fixed with it:
the `Active::Ikev2` arm did not even clear the slot when Windows dropped
the tunnel, so a dead IKEv2 session kept intercepting for as long as the
app stayed open; and `set_split_tunnel` returned `Ok` early whenever no
engine was live, so **turning Custom mode off — the customer's most
obvious move — reported success and stopped nothing.**

`detach_tunnel()`, which the `Active::Child` arm did call, was never a
fix for any of this: it clears the interface index and leaves the loop
and the handle exactly where they were.

### Rig evidence

`Neoxify-Test2`, snapshot `pre-verify3`. Its installed build is
byte-identical to `main` for the service, `src-tauri` and the frontend
(`git diff 38f4fe4..81875bb -- ...` is empty), so the shipping code was
under test with no rebuild. Harness `vmx6/f1.ps1` (OnlySelected) and
`f3.ps1` (AllExcept); the fixed binary was swapped in by hash, not by
version string, because both builds report the same version.

Shipping build `8669C855...`, fixed build `E3F3BC0B...`, swap confirmed
in-guest (`swap took : True`).

**OnlySelected, WireGuard, browser selected.** Tunnel killed with
wireguard.exe's own `/uninstalltunnelservice` -- the product's own call,
so the machine state is genuine. No Disconnect is ever sent afterwards,
which is the field report's "app is gone":

| after the tunnel died | BEFORE `8669C855` | AFTER `E3F3BC0B` |
|---|---|---|
| `connected` | false | false |
| `split_tunnel_active` | **true** | **false** |
| `seen=` over the next 100s | **570 -> 1264** | **99 -> 99** |
| machine DNS | **FAIL, 12s timeout** | **OK, 7ms / 8ms** |
| `Invoke-WebRequest` | **FAIL: name could not be resolved** | OK |
| selected app | no answer | `50.34.35.228` (its own connection) |

A frozen `seen` counter is the direct evidence that the loop stopped;
the DNS latency is what the customer would feel. On the before build,
End Task then restored DNS at 12ms, immediately, exactly as reported. On
the after build there was nothing left for End Task to fix.

Traffic really was carried first, so this is a broken tunnel and not a
tunnel that never worked: selected-app exit IP `50.34.35.228`
disconnected -> `38.60.249.229` (the node) connected.

**The backstop fired, and said so.** `cleanup.log` on the fixed build:

```text
2026-08-23 14:17:32 | stop Custom mode after its tunnel disappeared | the
tunnel adapter neoconnect (interface 20, 10.66.0.2) is gone, but Custom
mode was still intercepting this machine's packets -- interception has
been stopped so traffic can flow normally again
```

Worth being exact about which mechanism won: the watchdog polls every 3s
and needs two strikes, so it got there at ~6s, before the harness's
status poll at 8s. Both layers ran -- the watchdog stopped interception,
the status poll's `Verdict::Dead` then tore the session down, which is
why `split_tunnel_active` reads false rather than merely idle. The
layering is the design, not a redundancy that happened to trigger.

**AllExcept, same treatment.** Before: `split_tunnel_active` true,
`seen` 252 -> 812 over 75s, DNS timing out at 12s -- and the **excluded**
application, the one deliberately kept out of the VPN, got no answer
either, because DNS is carried for every process regardless of mode.
After: `split_tunnel_active` false, `seen` **304 -> 304**, DNS 6-7ms,
and a subsequent connect still works.

**`sc query WinDivert` turned out to be a bad instrument and is not
quoted above.** It read PRESENT immediately after End Task while DNS had
already recovered, and PRESENT at the *baseline* of a later run from a
previous session's driver load. The driver service lingers independently
of whether anything holds a handle. The `seen` counter and DNS latency
are the measurements that mean something.

### The fix

**The invariant is now structural, not remembered.** The bug was one
missing call; the next one was one `self.active = None` away in whatever
engine arm gets added next, and a comment asking people to remember is
not a mechanism. `Engines::active` is now a `session::Slot` whose inner
`Option` is private to its module, and the only way to empty it is:

```rust
pub(super) fn end(&mut self, split_tunnel: &mut SplitTunnel) -> Option<Active> {
    split_tunnel.stop();
    self.0.take()
}
```

It does not need the `SplitTunnel` to empty an `Option`. It takes it so
that emptying the slot **cannot be written without it**. `status()` had
to be restructured around this — the borrow checker will not lend out
the slot and the split tunnel at once — so the arms that discover a dead
engine now fall out to one `Verdict::Dead` path instead of clearing the
slot where they noticed. That restructuring is the fix working as
intended, not a cost of it.

Also in:

- **A backstop watchdog inside the session.** Every 3s it checks the
  adapter it was pinned to is still there, up, and still holding the
  address the relays bind to; two consecutive misses and it stops
  interception, clears the interface, and writes to `cleanup.log`. It
  cannot take the session apart — joining the redirect workers from a
  thread the session owns would deadlock the teardown that is joining
  *it* — but stopping interception is what gives the machine back.
- **`liveness()` is three-valued on purpose.** `Alive` / `Gone` /
  `NoEvidence`. An adapter enumeration that *failed* says nothing about
  the adapter, and reading it as death would let one unlucky syscall
  drop a working customer out of their tunnel — a self-inflicted outage
  of exactly the kind the backstop exists to prevent.
- **`set_split_tunnel` with no engine live now stops an orphaned loop**
  instead of returning success.
- **The IPv6 block comes down after the engine, not before.** The old
  order left a window with the tunnel still up and IPv6 already
  unblocked; on WireGuard's `/uninstalltunnelservice` that window is
  seconds. It is also now outside the result match, so a failed engine
  teardown cannot leave a machine-wide filter behind.
- **Fail-open throughout.** No tunnel means selected apps use the
  ordinary connection. Never a blackout — that is the product stance and
  it is what the old code violated.

### AllExcept does NOT build a full tunnel — the comments were wrong

Two comments (`split_tunnel/mod.rs` at the `TunnelInterface`
construction, `firewall.rs` above `add_rule`) claimed "everything except
these" builds a **full** tunnel with redirected connections pinned to
the **physical** link. It does not, and a teardown fix built on that
belief would have been built on sand — so it was settled with a
measurement rather than a reading.

Code first: `mode` reaches exactly two places in `split_tunnel/mod.rs` —
the selection it is stored in, and a log header. There is no branch that
could build a different shape, and `TunnelInterface::new(tunnel_adapter
.index, tunnel_address)` is unconditional.

Then the rig, and this is where a crude test would have given the wrong
answer. The tunnel adapter *does* own a `0.0.0.0/0` route in Custom
mode, so "has a default route" says nothing at all. The **metric** is the
tell:

```text
Custom mode on (either mode) :  if4 Ethernet metric 0  |  if20 neoconnect metric 9999
Custom mode off, full tunnel :  if4 Ethernet metric 0  |  if20 neoconnect metric 0
```

Same adapter, same protocol, same machine, minutes apart. The passive
shape installs a deliberately *losing* default route so that sockets
**pinned** to the interface have somewhere to go while ordinary routing
still prefers the physical link. Custom mode gets 9999; a plain full
tunnel gets 0. The comments have been corrected to what the code does.

One honesty note on that second row: at metric 0 the two default routes
are tied, and Windows breaks the tie on *interface* metric, which the
harness does not read -- so the script's own "which wins" label is
unreliable there and is not relied on. The 9999-versus-0 difference is
the evidence, and it is unambiguous.

AllExcept was also confirmed to do what it advertises: excluded app
`50.34.35.228` (its own connection), non-excluded `38.60.249.229` (the
node), simultaneously.

### Measured while in there, NOT fixed — the AllExcept activation reset

`reset_selected_connections` in AllExcept closed **37 of 45** established
TCP connections on the machine at activation on the first run
(established count 45 -> 6; the log says "activation reset settled after
12 rescan(s): 37 connection(s) closed in total"). A later run on a
quieter machine closed 6 of 6. In OnlySelected the comparable figure is
0.

That is correct by the letter of the feature -- in AllExcept almost
everything *should* be rebuilt through the tunnel -- but it is a very
wide blast radius, and on a machine reached over RDP it would drop the
session the customer is sitting in. The 0.9.28 activation grace-window
drop was deliberately **not** applied to AllExcept, so those connections
are closed with nothing refusing their replacements during the window.
Neither was touched here; both are stated so the next person does not
have to rediscover them, and so that if the beta user's first AllExcept
session reports "everything disconnected for a moment", this is the
first place to look.

### The installer half — argued against, not closed

The user later rebooted, updated to 0.9.28, and reports Custom mode
working. That is consistent with a stale service binary rather than a
0.9.28 defect, so the upgrade path was read carefully.

It is **less likely than it first looked**. `NSIS_HOOK_PREINSTALL`
(`nsis-hooks.nsh:26-43,130-133`) does far more than `sc stop`: it polls
`tasklist` for 10s and then runs `taskkill /F /IM neoconnect-service
.exe`, elevated, before any `File` is written. A merely wedged
user-mode process does not survive that. And because PREINSTALL also
does `sc.exe delete` while POSTINSTALL re-`install`s, a survivor would
be an unregistered **orphan process**, not a registered old service.

But it is not closed, and the gaps are real:

- `WaitForProcessGone` **never re-checks after the `taskkill`** — it
  sleeps 1s and exits the loop unconditionally. Every exit code in the
  hook is `Pop $0`'d and discarded.
- In the same macro, if `nsExec` fails to *launch*, it pushes the string
  `"error"`, which satisfies `${If} $0 != 0` and is read as **"process
  is gone"**.
- There is no `SetOverwrite` / `ClearErrors` / `IfErrors` anywhere in
  `installer.nsi`, and **no post-copy verification of the binary at
  all** — no hash, version, size or timestamp.
- The one POSTINSTALL check is `sc.exe query NeoxifyService`, which
  succeeds identically for a new binary, an old un-overwritten one, and
  a registration in `MARKED_FOR_DELETE`.
- The updater runs `"installMode": "quiet"` (`/S`). **What stock NSIS
  does with a failed `File` under `/S` — skip and continue, or abort —
  is the pivot of the whole hypothesis and is not determinable from this
  tree.** Skip-and-continue produces exactly "new app, old service,
  installer reported success".
- There is **no app↔service version handshake** in `ipc/src/lib.rs`, so
  a skewed service surfaces only as `"malformed request: …"`. Nobody,
  including us, can currently tell a customer which service build they
  are running.

Worth connecting: an orphaned old process holding the WinDivert handle
is *exactly* the shape of this entry's field report, and the new
watchdog would now stop such a process intercepting even if the
installer left one behind.

**The cheapest discriminator, if the user can be reached:** hash
`C:\Program Files\Neoxify\resources\neoconnect-service.exe` against the
0.9.28 artifact. Version strings cannot distinguish builds — the
2026-08-23 verification entry above hit that same wall and had to
compare hashes by hand.

### What is proven and what is not

**Proven:** the mechanism, before and after, on the rig, for **both**
Custom modes on WireGuard; that traffic was genuinely carried first
(selected-app exit IP = the node); that the machine's DNS dies and
recovers exactly with the redirect loop; that the backstop fires and
writes to `cleanup.log`; that AllExcept builds a passive tunnel and
otherwise does what it advertises.

**Not proven:**

- **Xray IS covered** (`f2.ps1`, run after the above was first
  written). `xray.exe` killed under Custom mode: `split_tunnel_active`
  went false on the next poll, `seen` froze at **186 -> 186** over 45s,
  DNS stayed at 14ms, the selected app fell open to its own address, and
  the watchdog logged the Xray adapter by name -- `neoconnect0
  (interface 7, 198.18.0.1)`. **OpenVPN was still not exercised**; it
  shares the `Active::Child` arm with Xray, so this is now a small gap
  rather than an untested branch.
- **The crash and reconnect variants pass.** Service killed with a
  WireGuard tunnel up: DNS back at 16ms immediately, selected app on its
  own address -- the kernel closing the handle is doing the work, as
  designed. A fresh service then reconnected cleanly, selected-app exit
  IP back to `38.60.249.229`, and a normal Disconnect left the machine
  at 10ms DNS.
- **Not proven: the exact path the user's own session took.** An
  explicit Disconnect always did stop the split tunnel, even before this
  fix. What is proven is that a tunnel dying on its own strands the
  machine and that *nothing* then reaps it. Whether his tunnel died, his
  app was killed, or his service was a stale binary cannot be
  established from here.
- **Not proven: any claim about the installer under `/S`.** See above.
- **Not proven: that his one good 0.9.28 session means anything.** One
  working session is not evidence that either half of this is resolved.
- **Not proven: that the 0.9.28 QUIC fix resolves symptom 1.** Not
  investigated.

### Rig traps, added to the pile

- **The VM aborted twice mid-run**, once wedging at the VirtualBox EFI
  splash for 7+ minutes and once dropping to `VMState="aborted"` with a
  run in flight. The stalled run's in-guest heartbeat stopping is the
  tell — check `heartbeat2.txt`'s age before believing a stalled output
  file means anything. Power-cycle and restore; it came up in 32s the
  next time.
- **PowerShell 5.1 has no try-*expression*.** `(try { … } catch { … })`
  parses `try` as a command name and fails at runtime with "The term
  'try' is not recognized". It cost one run its final disconnect and one
  its last line. Use a function.
- **`sc query WinDivert` is not an instant read of "handle closed".**
  It still reported PRESENT immediately after End Task while DNS had
  already recovered. The DNS recovery is the operative measurement; the
  driver service lingers.
- **`wireguard::tunnel_is_running()` is true if the service can be
  *opened*,** so `sc stop` does not simulate a dead tunnel. Use
  `wireguard.exe /uninstalltunnelservice neoconnect` — the product's own
  call — to get the genuine state.
- `pre-verify3`'s image has **no `selapp.exe`**; one whole run produced
  no selected-app reading because of it. `f0.ps1` now plants one.

---

## 2026-08-23 — 0.9.29 is out; the rig VM is gone and one branch is stranded by it

**Status:** released (`desktop-v0.9.29`, PR #34, merge `fccace2`)

Two things went in: `claude/fix-orphaned-redirect` (the redirect loop
that outlived its tunnel — mechanism and rig numbers are in the two
entries above) and `claude/connect-intent` (the Connect button rendering
"Disconnecting" and needing three or four presses). They merged with no
conflicts at all: one is service Rust, the other is app TypeScript, and
the IPC surface between them did not move.

The parts worth carrying forward, none of which git records:

- **The rig VM has been deleted.** Every hardware claim in this file up
  to and including the 0.9.29 split-tunnel numbers was measured on
  `Neoxify-Test2` / `pre-verify3`, and there is now nothing to measure
  on. Anything touching the tunnel from here is unproven until a rig
  exists again. Rebuilding one is the prerequisite for the item below,
  not an optional tidy-up.
- **`claude/selected-apps-ipv6` is built, unmerged and stranded.** It is
  deliberately not in 0.9.29: it has never run on the rig, and it
  changes the same subsystem 0.9.29 exists to stabilise. Do not merge it
  on the strength of a green CI run — CI compiles it, nothing more.
- **The connect-button fix shipped unverified against a real tunnel.**
  Its evidence is a unit suite over pure functions that fails against
  the 0.9.28 Dashboard and passes against this one. That is a controlled
  test and worth something, but nobody has pressed Connect on a censored
  network with it. If the "three presses" report comes back, that is the
  first thing to doubt — and note the underlying connects really were
  failing, so a report of *failing* connects is a different bug and not
  a regression of this one.
- **OpenVPN under Custom mode is still unexercised.** It shares the
  `Active::Child` arm with Xray, which was covered on the rig, so it is
  a small gap rather than an untested branch — but it is the one arm of
  the fix nothing has run.
- **Still unsigned.** 0.9.24–0.9.29 have all shipped without
  Authenticode because `AZURE_CLIENT_ID` is unset; identity validation
  is blocked with Microsoft support. The release workflow says so in an
  annotation on every run, so a green release is not evidence signing
  came back.

---

## 2026-08-23 — "Connected" now means verified, and the Custom-mode probe can finally fail

**Status:** landed on branch `claude/honest-connected-0930`, **not
released, not proven on hardware**
**Touches:** `apps/desktop-windows/src/**`,
`apps/desktop-windows/service/src/split_tunnel/{proxy,mod}.rs`

### The defect

Custom mode on an Xray protocol showed a green "Connected" indefinitely
with nothing flowing. Three abstentions rendered as proof, and they
compound:

1. `Engines::status` reports `TunnelHealth::Unknown` for Xray, OpenVPN
   and IKEv2 for as long as the process has not exited
   (`engines/mod.rs`, `Active::Child` / `Active::Ikev2`). Honest — there
   is no cheap handshake to read. `stateFromStatus` swallowed it into
   "connected" via a `default:` arm.
2. The health poll's Custom-mode branch computed the probe result and
   **discarded it** whenever the engine reported up. The one instrument
   that could catch this was skipped exactly when it was the only one.
3. The full-tunnel branch counted `indeterminate` egress — "no
   comparison was possible" — as carrying traffic. Reopening the app
   over a service-kept tunnel takes no baseline, so that session is
   `indeterminate` forever.

### The probe could false-positive, not only false-negative

The false negatives were already documented. The other direction was
not. `proxy::probe` was a bare TCP `connect()` — no payload, no read —
and **Xray on Windows runs its own `tun` inbound**, a userspace TCP
stack inside xray.exe. The SYN is answered by that stack, not by
1.1.1.1. It completes as soon as xray.exe is up with a live Wintun
adapter, regardless of whether the VLESS session exists. Nothing was
sent afterwards, so the outbound was never asked to carry anything.

Second false-positive path, on every protocol: **REALITY proxies an
unknown SNI to its decoy site rather than refusing it.** A stale
`serverName` against a changed `dest` hands the customer to a
third-party website while the outer TLS keeps looking perfectly healthy.

Also worth keeping: the probe only shares the *tunnel-attachment leg*
with a selected app's path. It skips WinDivert, the NAT table and the
local relay entirely, so a redirect capturing nothing is invisible to
it. The doc comment claiming "the exact path a selected app's traffic
takes" was wrong and has been corrected in place.

### What changed

- Rules moved to `src/lib/connection-evidence.ts`, pure and tested. The
  dashboard needs Tauri + service + network, so these had only ever been
  checked by reading them.
- New `unverified` state — "Connected, not confirmed", brand cyan.
  Deliberately **not** `degraded`: a false "not protected" gets someone
  in Iran to disconnect. A failed split-tunnel probe still never causes
  a failover; it just no longer produces green.
- Poll gained a leading-edge run, throttled to one check per 5s, so
  `unverified` resolves in ~1s rather than 15.
- `verifyEgress` now records **which endpoint answered** and refuses to
  compare a CDN reading against a mirror reading. This is HANDOVER §6
  item 4 turned into code: turkey-1's mirror answers with the node's own
  address, which is what a working tunnel looks like.
- **Service-side, flagged:** `proxy::prove_carries` sends a real TLS
  ClientHello and requires a TLS record header back.
  `split_tunnel::probe` calls it; **route selection still uses the old
  `proxy::probe`** deliberately — it asks a different question and
  making it stricter risks breaking route installation on a path nobody
  can test right now.

### What this still cannot prove

- **Custom mode**: `prove_carries` proves *a socket pinned to the
  tunnel* reached a real TLS server. It does **not** prove the chosen
  apps' packets are being redirected — that is the WinDivert/NAT leg,
  which the probe skips. The service's own packet counters
  (`splitTunnelProblem`) remain the only signal measured on the real
  path, and they need 12s of warm-up and 20 redirected packets before
  they say anything.
- **Full tunnel with no baseline** (app reopened over a live tunnel)
  stays `unverified` for the session. There is no honest comparison
  available. The obvious follow-up — persisting an exit IP once proven
  through a baseline and matching against it later — was scoped out, not
  rejected.
- The mirror-XFF hazard is *guarded*, not fixed. If both readings come
  through the same broken mirror the addresses match and it reads as a
  leak. The real fix is a certificate for `origin.neoxify.site`
  (HANDOVER §6 item 4), which is backend work.

### The rig experiment this needs (rig is being rebuilt — do it later)

The unit tests prove the decision rules and the reply check. **They
prove nothing about a tunnel.** On the rebuilt VM:

1. Custom mode + `XRAY_VLESS_REALITY`, one app selected. Connect,
   confirm green and that the selected app's exit IP is the node's while
   an unselected app's is not.
2. **Break the far end without touching a live node** — ask before
   changing anything on production. Simplest safe version: edit the
   client's stored `serverName` to a name the node does not serve, so
   REALITY hands the session to the decoy. Expect: the orb goes to
   "Connected, not confirmed", the split-tunnel log records
   `probe FAILED: the tunnel completed a connection but carried no reply
   from …`, and **no failover is triggered**.
3. Control, and this is the one that matters: build with `prove_carries`
   swapped back to `probe` and repeat step 2. The old build must show
   green. Without that the test proves nothing.
4. Regression: WireGuard and OpenVPN full tunnel, connect and confirm
   the orb still reaches green (not stuck on "not confirmed") and the
   exit-IP chip still appears.
5. Confirm the `unverified` copy renders correctly in `fa` (RTL) — it is
   the longest new string on the screen.

---

## 2026-08-23 — The two things blocking a REALITY decoy change, and what each fix can actually promise

**Status:** built on `claude/config-refresh-and-inbound-tag`, unpushed,
**not verified against a node or a real tunnel**

france-1's REALITY decoy is `cloudflare.com` — the weakest disguise
available, since the decoy *is* the CDN. Changing it was blocked by two
separate things, both fixable in source, and both now fixed. Neither fix
has been exercised against a live node, and the rig VM is still gone, so
what follows is what the code does and what it is entitled to claim.

### Blocker 1 — clients held a stale SNI forever

`getProtocolUsers()` had exactly one call site: the dashboard's initial
load, plus retry and server-switch. No poll, no TTL, no expiry on the
disk cache. On Windows the window ends when the window closes; **on
Android it does not end at all** — the WebView survives backgrounding,
the screen adopts the running tunnel on open, `loadAll` never runs a
second time, and toggling the VPN off and on re-dials the values already
in memory. Nothing short of a force-stop refetched.

Now: `refreshConnectionConfig` in `apps/desktop-windows/src/lib/` (which
mobile aliases as `@shared`), called at the top of both clients'
`runLadder`, plus a `useRefreshOnResume` hook for the Android case.

The parts worth not re-deriving:

- **The refresh runs *above* the teardown, on purpose.** Run from the
  health poll there is still a tunnel up, and on a filtered network that
  tunnel is the likeliest way to reach the control plane at all. Tearing
  it down first throws away the route to the answer.
- **The TTL is a freshness horizon, not an expiry.** Ten minutes.
  Nothing ever discards a snapshot for age and `loadSnapshot` still hands
  back a week-old one; the TTL only decides whether the connect path owes
  the server a question. A cache that expired itself would reintroduce
  the exact outage it was written to end (panel filtered in Iran, product
  dead for everyone there on every protocol).
- **The refresh has its own six-second budget, not the API's.**
  `apiRequest` walks every endpoint at up to 8s each; paying that on the
  connect path would add tens of seconds of nothing-happening before the
  first tunnel packet. The in-flight request is not cancelled, only
  stopped being waited for, so a late answer still writes the cache and
  the next connect is already paid for.
- **A failed refresh never blocks connecting.** It falls back to the
  held credentials and dials. It reports `CONTROL_PLANE_UNREACHABLE` with
  the cache's age in minutes and warns to the console, so a stale-config
  connect is visible rather than silent. Existing enum members,
  deliberately — a new `ClientAttemptKind` would need a schema migration
  to record one line of context.
- **A live session is not reconnected when the config moves.** A VPN
  that drops itself unasked is indistinguishable, from inside Iran, from
  one that has been blocked. The next connect picks up the new values,
  which bounds the stale window at one connect instead of one reinstall.

### Blocker 2 — `inboundTag` could not be set through the API

`UpdateProtocolConfigDto` carried only `listenPort`, `publicParamsJson`
and `isEnabled`, and the app-wide pipe runs `whitelist` +
`forbidNonWhitelisted` — so a PATCH naming `inboundTag` came back 400.
Correcting one meant SQL, because `remove()` refuses while any customer
or route references the config.

**What the validation can guarantee:** shape; the reserved relay tun
inbound; another protocol's default tag; and uniqueness across the node
by *effective* tag — so a sibling reaching the same inbound through its
node default counts as a clash even though its column is null. That last
one is the case a column-level unique check misses entirely, and it is
the one that has a relay's second exit country silently egressing
through the first's.

**What it cannot guarantee, and this is the important half:** that the
tag names an inbound the node actually has. There is no agent RPC for it
— `packages/proto/agent.proto` has `Hello`, `Heartbeat`, `StatsBatch`,
`CommandAck`, `StateSnapshot` and a user/route command set, and nothing
that enumerates inbounds. The agent does not know either: it is started
with one tag per protocol as a flag (`--xray-inbound-tag` and friends)
and never reads Xray's config. So a tag naming a listener that was never
created is accepted by the API and fails on the node at connect time, as
"invalid request user id". Closing that gap means an agent change, which
was deliberately not attempted here — `agent/` and the route-reassert
path were being worked on concurrently for a live relay outage.

**The interlock nobody should remove:** changing the tag on a config with
provisioned customers is refused unless the caller sends
`confirmReprovision`, and the refusal names the count. Their credentials
live on the old inbound and moving the config does not move them. This
is a warning made into a gate on purpose, because a warning is what the
panel already had.

### The third copy of the default-tag table

`defaultInboundTagFor` in `protocol-configs/inbound-tags.ts` is now a
*third* copy of the same protocol→tag mapping — `entryInboundTag` in
`RoutesService` and `defaultInboundTag` in `AgentGatewayService` are the
other two, and neither is exported. Consolidating means editing both of
those files, which are where the concurrent relay work is; that merges
cleanly and fails at runtime, which is the failure mode `CLAUDE.md`
warns about. `defaults match the installer's templates` in
`inbound-tag.spec.ts` pins the copy so a divergence is a red test rather
than a wrongly-matched route. **Worth consolidating once the relay work
lands.**

### What is proven

- The backend and panel jobs CI runs (`turbo run lint typecheck build
  test`) pass, from a short path outside `.claude/worktrees` because the
  panel still cannot build inside one (MAX_PATH).
- Every assertion was run against a deliberately broken control. The
  client suite: seven of its cases fail with `refreshConnectionConfig`
  reduced to "return what is held". The backend suite: six fail with the
  service's tag write and both guards removed, and two more fail with
  `inboundTag`'s decorators stripped from the DTO — that second one runs
  the real `ValidationPipe` rather than bare `validate()`, because
  `whitelist` is the mechanism that was dropping the field and a plain
  `validate()` call would pass either way and prove nothing.

### What is not proven

- **Nothing has touched a node.** No config was changed, no decoy was
  moved, no client dialled anything. The refresh path has never run
  against a real API, and the inbound-tag validation has never rejected
  or accepted a real operator's change.
- **Whether a six-second budget is right on a censored network.** The
  number is reasoned, not measured. If beta users report the Connect
  button feeling slower, that is the first thing to look at, and it is
  one constant.
- **The resume refetch has not been seen on Android hardware.** It is
  three DOM event listeners and a staleness check; the claim that
  Android's WebView raises `visibilitychange` around backgrounding comes
  from the platform's documented behaviour, not from a device in hand.
- **The panel dialog has not been opened in a browser.** It typechecks
  and builds.

---

## 2026-08-24 — every relay route was dead, for two independent reasons

**Status:** fixed and proven on the fleet. All thirteen relay routes now
reach the internet at their exit node's address.
**Branch:** `claude/relay-uplink-reassert`, with `main` merged in so it
carries 0.9.29
**Touches:** `apps/backend` (schema + migration + agent-gateway +
routes), `agent/internal/relay`, `installer/lib/agent.sh`

### What was actually broken, and what it was not

**An outage, not a leak.** This matters more than the fix. The
deanonymisation case — a relay customer egressing at ir1, in Iran — is
the one this system is built to prevent, and it did not happen. ir1's
routing rules and its blackhole default were intact throughout: the
relay's onward connection was refused at the exit, so the customer's
connection failed. Proven, not reasoned — france-1's own access log reads
`rejected proxy/vless/encoding: invalid request user id`, and a probe
driven through ir1's live outbound died at the client's TLS handshake
rather than returning a page from ir1's egress address (31.171.x.x).

**Thirteen routes, not five. One customer, not five.** The five
`-> France` routes were the visible half; the eight exiting at finland1
were dead too. All thirteen belong to a single Ultimate (relay-only)
subscription — one paying customer, who had no working server at all.

**Duration floor:** the France routes dead since france-1's Xray restart,
2026-08-19 04:00:23 UTC. Total blackout since finland1's, 2026-08-20
02:21:37 UTC — three days twenty-one hours. That customer's last measured
usage on ir1 is 2026-08-15 15:52, which suggests it was already failing
earlier for a reason not established here; both exits' journals have
rotated past it.

### Cause one: only half a route was ever re-asserted

A relay route is two hot-added things on two different nodes. The entry
holds the outbound and the routing rule; the exit holds one shared
credential, `route:<id>`, on its inbound. Both live only in the running
Xray process.

Only the entry half was re-asserted. The uplink is created once, by
`RoutesService.create`, and has no `ProtocolUser` row, so the user sweep
could not see it either. An Xray restart on an exit deleted it forever.
On 2026-08-23 both exits held exactly their 29 direct customers and zero
`route:` users, while ir1 held every outbound and rule, faithfully
re-asserted every 60s, aimed at a credential neither exit recognised.

Fixed by having the route sweep assert all of a route. Not by giving the
uplink a `ProtocolUser` row: that model requires a `subscriptionId`, and
the uplink belongs to no subscription — faking one would put a synthetic
customer into quota, usage and concurrency accounting.

### Cause two: a changed route never converged

Restoring the uplink fixed the five France routes and **not** the eight
finland1 ones. That is where the second bug was.

Xray's `AddOutbound` refuses a duplicate tag and has no update operation,
so "already applied" and "applied with different contents" arrive as the
same error. The agent swallowed both as success. finland1's REALITY
`serverName` is `www.shatel.ir`, the backend had been sending that in
every `CONFIGURE_ROUTE` — thirteen of them ACKED at 00:12:08 that
morning — and ir1's eight finland1 outbounds still carried
`cloudflare.com` from whenever they were first built.

Isolated by A/B on one route with everything else held constant: same
credential, same shortId; `cloudflare.com` → curl exit 35,
`www.shatel.ir` → exit IP 204.168.161.100.

The agent now fingerprints the exit parameters it last installed per
route. A matching duplicate is the genuine no-op; a differing one is
removed and re-added. Not an unconditional rebuild — the sweep runs every
60s, so that would drop every relay session once a minute.

### The instruments, and the two that lied first

- **The probe reported total failure on all thirteen routes before it
  worked at all.** Two harness bugs in sequence: `xray api lso` returns
  the internal protobuf form, not client-config JSON, so the first
  version produced `CONFIG-INVALID` everywhere; then the fixed script was
  never re-uploaded, so a positive control ran against the stale copy and
  "failed" with a credential that was fine. A harness reporting total
  failure is still the likeliest thing to be broken.
- **The positive control is what made the negatives mean anything.** A
  throwaway user added to france-1's `vless-in` and removed straight
  after: exit IP 104.105.205.233, and france-1's log naming it. Without
  that, thirteen FAILs prove nothing.
- **Credentials never left the nodes.** The probe reads the live
  outbound, builds its client config and curls, all on ir1; only the exit
  IP comes back.

### Health reporting: a relay route can now say it is down

`nodeStatus` was the entry node's heartbeat, which says nothing about the
exit. ir1 was up and heartbeating the entire time. `Route` now carries
`uplinkAssertedAt` / `uplinkLastError`, stamped from the exit's own ack,
and a relayed route with no confirmation inside three sweeps reports
OFFLINE. Never-asserted counts as unhealthy, not unknown.

`handleCommandAck` also tested `startsWith("reassert:")` — the user
sweep's prefix alone — so a failed *route* re-assert matched neither that
branch nor an `AgentCommand` row and vanished silently.

### The certificate time bomb, and the measurement that changed the fix

The certbot deploy hook ran `systemctl reload xray || systemctl restart
xray`. `CanReload=no` on every node, so the reload could never succeed
and the `||` hid it: every renewal was a restart. france-1 renews around
18 Oct.

The first fix was an honest, verified restart. Then the measurement came
in: **Xray re-reads `certificateFile`/`keyFile` from disk by itself,
hourly** — swapped at 00:06:16 on a throwaway loopback instance, new
certificate served between +55 and +60 min, no signal, no restart. So the
hook now syncs and stops. The five-second version of that same test
showed no reload and would have sent this the other way.

Also measured: **Xray does not handle SIGHUP — it terminates.** So
`ExecReload=/bin/kill -HUP $MAINPID` would have been a restart under
another name, and `ExecReload=/bin/true` worse: a renewal reporting
success while serving the old certificate to expiry.

`neoxify-xray-restart` stays for restarts that are genuinely unavoidable.
It snapshots the live inbound tags, restarts, waits for the API and
compares, exiting non-zero on anything that did not come back. Its
detection was exercised on ir1 with `systemctl` stubbed to a no-op: clean
run exit 0; one tag hidden from the post-restart listing → named, exit 1.

### Also done

france-1's `vless-reality-free-in` on port 2083 is gone, from the running
process (`xray api rmi`, no restart) and from `config.json` (validated
with `xray run -test` first, backup kept). Zero users, no database row,
and the only traffic it ever carried was `e2e-probe@neoxify.test` on
2026-08-23 — a leftover from another session's probe. An unmanaged open
port is a fingerprint on a product whose value is not looking like a VPN.

### What is NOT proven

- **The agent fix is not deployed.** `agent/internal/relay` is committed
  and unit-tested but needs an agent rollout. Until then the convergence
  bug is live on every node: any change to an exit's REALITY parameters
  will silently fail to reach the relays again. The eight stale outbounds
  were cleared by hand (`xray api rmo`; the sweep re-added them in ~40s).
- **The backend fix is deployed from an unmerged branch.**
  `claude/relay-uplink-reassert` is checked out on the panel and built,
  so `/root/neoconnect` is no longer on `main`. It needs a PR and a
  re-deploy from main.
- **The customer has not been contacted**, and nobody has confirmed the
  route works from an actual client in Iran. The proof here is from ir1
  outward.
- **Why usage stopped on 2026-08-15**, four days before the earliest
  restart that explains anything, is unexplained.
- The installer changes are source-only; no node has been re-installed.

---

## 2026-08-24 — the relay fix is merged and the panel is back on `main`

**Status:** done for the backend; **the agent half is still unrolled.**
**PR:** #38, merge commit `85bfaa9`
**Supersedes:** the previous entry's "the backend fix is deployed from an
unmerged branch" and "it needs a PR and a re-deploy from main". Both are
now false. What is still true is everything under *the agent fix is not
deployed*.

### What the panel was, and is

It was checked out on `claude/relay-uplink-reassert` at `cbf52fe` —
a feature branch, built and running in production, which is the thing
this was cleaning up. It is now `main` at `85bfaa9`, clean tree.

Captured before touching it, in case a roll back was needed:

| | |
|---|---|
| branch | `claude/relay-uplink-reassert` |
| commit | `cbf52fe1cbe482ac40f911abe89dfdbc72cd3345` |
| tree | clean |
| backend image | built 2026-08-24T00:11:50Z |
| `/health` | 200 |
| DB backup | `/var/backups/neoxify/neoxify-backup-20260824-041951.tar.gz` |

Rolling back never became necessary.

### The deploy

`main` merged into the branch first (only conflict was this file), then
the documented runbook: `git checkout main`, `git pull --ff-only`,
`docker compose -f infra/docker-compose.prod.yml --env-file infra/.env
up -d --build backend`. Build runs before the recreate, so the API was
down for the container swap only — **healthy again 5s after compose
returned**. Backend only; nothing this PR touched is in `apps/panel`.

**The migration was already applied.** `20260823_route_uplink_health`
recorded `finished_at = 2026-08-24 00:12:03`, `rolled_back_at` null, from
when the branch was deployed by hand. So `migrate deploy` on this rollout
was a no-op and the schema never moved. Both columns confirmed present,
nullable. There is **no down migration** — reversing it is
`ALTER TABLE "routes" DROP COLUMN "uplinkAssertedAt", DROP COLUMN
"uplinkLastError";` by hand. Rolling the *code* back needs no schema
change: nothing outside those two fields reads them.

### Verified after

- `https://connect.neoxify.site/api/health` → 200. (Note for next time:
  the public `/health` is the *panel's* Next.js 404, not the API. The API
  is behind `/api/` — nginx strips the prefix.)
- All **13/13** enabled relay routes fresh, age 27s, `uplinkLastError`
  null on every one. Zero never-asserted.
- Deployed commit is the merge commit, both parents as expected.

### CI

All four jobs green on #38: TypeScript 1m52s, Go agent 33s, Shellcheck
9s, Desktop 3m21s. Locally beforehand: 41 suites / 382 tests, shellcheck
clean at warning severity over all 8 installer scripts, both drift checks
pass. Green means it compiles and the units pass — it is not evidence a
tunnel works.

### The gotcha worth keeping

`git worktree add` refuses a branch that is already checked out
elsewhere, and this repo has ~12 live worktrees. Parking the main
checkout on `main` first is the cheap way through.

Also: **the fleet is six nodes, not five** — finland1, france-1,
germany-1, ir1, singapore-1, turkey-1, all ONLINE and heartbeating inside
7s. And every one of them reports `agentVersion=dev`, so the panel cannot
tell you which commit any node's agent is running. That matters for the
rollout below: there is no version to compare against, only the binary's
mtime on each box.

### The agent rollout — NOT done, needs the owner

The Go convergence fix is merged but **runs nowhere**. Until it ships,
any change to an exit's REALITY parameters will again be acked as
applied and silently ignored by the relay. Today's fleet is correct by
hand (`xray api rmo` on the eight stale outbounds), not by code.

What the release needs, established from the files rather than assumed:

- **`agent/` on `main` differs from the last agent release `v0.2.5`
  (2026-08-17) by exactly this fix and nothing else** — 2 files,
  `provisioner.go` + its test. A `v0.2.6` tag is a single-purpose
  release with no unrelated cargo.
- `release-agent.yml` triggers on `v*`, builds linux amd64+arm64 via
  `make build-linux-{amd64,arm64}`, writes `sha256sums.txt` and attaches
  all three to a GitHub release. That is exactly what the installer's
  `fetch_agent_binary` downloads and checksum-verifies.
- **Only ir1 needs it.** It is the sole relay entry node — all 13 routes
  hang off it. The relay provisioner does not run on an exit. The other
  five nodes can take the update whenever; they do not fix anything.
- Per node the operation is installer menu option **2**
  (`action_update_agent`): `fetch_agent_binary` then
  `systemctl restart neoxify-agentd`. It explicitly does not touch the
  engines, and the code agrees — the agent shells out only to `ip`,
  `wg`, `swanctl` and `tc`, and never to `systemctl`. **No engine
  restarts, so no inbound/user/route is wiped and direct customer
  tunnels are untouched.**

**The one real cost, and it is on ir1:** `appliedProxy` is in-process, so
a freshly started agent knows nothing about what is already installed.
Xray keeps running across an agent restart, so all 13 outbound tags are
still taken — and none of them match a fingerprint the new process has.
Every one is therefore treated as changed and rebuilt
(`RemoveOutbound` + `AddOutbound`).

This happens **at reconnect, within seconds**, not on the 60s sweep:
`handleHello` calls `replayQueuedCommands` → `reassertProvisionedUsers`
→ `reassertConfiguredRoutes` straight after the Ed25519 check. So the
relay customer's sessions drop once, quickly, and re-establish. That is
the designed trade in the code comment — convergence is the safe
direction — but it is a real interruption for the one customer this
whole fix exists for, and it is why this is an owner decision rather
than quiet maintenance.

For context on how mild an agent restart otherwise is: measured across
finland1's, **166 established customer connections before, 168 after.**
The agent holds the control stream, not the tunnels.

Two things option 2 will *not* do for you:

- **It keeps no backup of the outgoing binary.** `fetch_agent_binary`
  ends in `install -m 755` straight over `/usr/local/bin/agentd`. The
  v0.2.3 rollout saved `/root/agentd.backup-dev-*` by hand and the entry
  called that worth having kept. Copy it aside first.
- **It resolves the release by GitHub's API ordering, not semver** —
  `jq '... | first'` over `/releases?per_page=50`. A re-cut or
  out-of-order tag can win. For a controlled rollout, pin it:
  `AGENT_RELEASE_URL_BASE=https://github.com/alihajipoor/neoconnect/releases/download/v0.2.6`.

And the installer is interactive (`read -r -p`, `set -euo pipefail`), so
this is one hands-on SSH session per node, not a scripted loop.

**Gap found while checking:** `agent/Makefile`'s release targets build
with `-ldflags="-s -w"` and never set
`-X .../internal/version.Version`, so a released binary still reports
`dev` — which is why all six nodes show `agentVersion=dev` and why the
panel cannot tell a v0.2.6 node from a v0.2.5 one. Worth fixing in the
same release, otherwise there is no way to confirm the rollout landed
except by checking the binary's sha256 on each box — which is what the
v0.2.3 rollout had to do, for the same reason.

Also worth correcting while here: an older entry says "users are still on
the ten-minute sweep, so after any Xray restart the node authenticates
nobody for up to ten minutes." **The code no longer matches that** —
`REASSERT_INTERVAL_MS` and `ROUTE_REASSERT_INTERVAL_MS` are both 60_000,
and the connect-time re-assert usually beats them. Worst case is ~60s.
Trust the constants.

---

## 2026-08-24 — 0.9.30 is out; two traps it walked into on the way

**Status:** released (`desktop-v0.9.30`, PR #39, merge `33adc28`).
Unsigned, like every build since 0.9.24.

Contents are described in the two entries above — the honest-connected
work and the config-refresh/inboundTag work — so this is only what the
integration itself turned up.

### The turbo cache produced a false pass, and CI caught it

A local `pnpm turbo run lint typecheck build test` reported **16/16
green** while `@neoxify/mobile#build` was served from cache and never
actually ran. CI failed on the same tree. Re-run with `--force` and it
failed locally too.

Another variant of the class this repo keeps hitting: local ≠ CI, and
green ≠ ran. **Before quoting a turbo run as evidence, pass `--force`**,
or read the `Cached: N/16` line and believe it — `16 successful` beside
`13 cached` means three tasks actually ran.

### A shared TypeScript module broke the other platform

Exactly the case CLAUDE.md's coordination section warns about, and it is
worth recording that it was a *type* break rather than a plugin
signature.

`src/lib/egress.ts` lives under `apps/desktop-windows` but is aliased
into the mobile app as `@shared`. The honest-connected work changed
`captureBaselineIp` to return an `IpReading` — the address **plus the
endpoint that reported it**, so `verifyEgress` can refuse to compare two
readings that measured different things — and
`apps/mobile/src/screens/Dashboard.tsx` still typed the baseline as
`string`. Desktop CI and **`ci-ios.yml` failed with the identical five
TS2345 errors**.

Worth noting *which* guard caught it. The iOS simulator build cannot run
a tunnel and proves nothing about one, but it does compile the shared
React tree — and that is precisely what it caught. It is the cheap half
of the coordination CLAUDE.md asks for, and it worked.

Fixed by threading `BaselineIp` through mobile rather than widening the
shared signature back to `string`. Mobile is exposed to the same
node-mirror hazard (a node's API mirror answers `/health/ip` with the
node's own address, which is indistinguishable from a working tunnel),
so keeping a bare-string entry point alive for one caller would have
left the false positive a way back in.

**Mobile runtime behaviour is unchanged** — its poll still treats
`indeterminate` as carrying, and it has no `unverified` state. Bringing
the honest third state to Android and iOS is real, unstarted work on a
file the Mac session shares, and it should be agreed across both
sessions before either starts it.

### Still not proven, and this is the part that matters

Nothing in 0.9.30 has been verified against a real tunnel. The rig VM is
still being rebuilt. The unit suites establish the decision rules and the
TLS reply check; they establish nothing about a tunnel. A green release
means the code compiles and bundles.

The experiment that gives the probe change its meaning is still the
control described in the entry above: build with `prove_carries` swapped
back to `probe`, break the far end, and confirm the **old** build shows
green where the new one does not. Until that runs, "the probe can now
fail" is reasoned, not demonstrated.

Held back from this release for the same reason — both built, neither
exercised on hardware:

- `claude/selected-apps-ipv6`
- `claude/repair-my-network`, whose elevated steps have never run at
  all; the WFP sweep has not executed once.

### Rig checklist for 0.9.30, when the VM exists

In addition to the five steps in the honest-connected entry:

1. Connect on a stale config. Change a node's REALITY `serverName`
   server-side (**ask first — live users**), confirm a client already
   holding the old value refetches on the next Connect and dials the new
   one, and that a client with the control plane blocked still connects
   on the held value and reports the stale-config connect.
2. Confirm a config change does **not** drop a live session.
3. Android: background the app for longer than the ten-minute freshness
   horizon, foreground it, and confirm the resume refetch fires. This has
   never run on a device.

## 2026-08-23 — Two fingerprints nobody chose: rotted REALITY decoys, and the default nginx page

**Status:** installer fixed and proven; **the live fleet is not fixed —
five items below need an owner decision**
**Touches:** `installer/lib/agent.sh`, `installer/lib/deps.sh`,
`installer/maintenance/**`, `docs/detection-resistance.md`. No node was
changed. Everything below marked "measured" is read-only: DNS, TLS
handshakes, HTTP GETs, and `ssh` commands that only print.

Branch `fix/reality-dest-ownership-and-port-80`, commits `70d909b`
(REALITY probe) and `9134f7d` (port 80).

### The decoy probe was testing the wrong thing, and now is not

`probe_reality_dest` checked TLS 1.3, ALPN h2, X25519 and "the
certificate verifies". Every one of those passes for a CDN-fronted
decoy, which is why `www.asus.com` and `www.leboncoin.fr` went on being
offered as the installer's defaults long after they moved into
CloudFront. `Verify return code: 0 (ok)` was also doing less than it
looked: it says the chain is trusted, never that the name on it is the
name we are about to claim.

The probe now resolves the name, connects to *that* address, and asks
who announces it — Team Cymru over DNS for the origin AS, the CNAME
chain, and the edge headers in the site's own replies. Three signals
because each is evadable alone, and because two of them survive on a
node with no `dig`. When the DNS half cannot run it prints
"criterion 1 is UNVERIFIED" rather than passing quietly, which is the
behaviour the old probe should have had.

Two more checks came out of upstream's own docs rather than from us:
`-verify_hostname`, and a chain-size ceiling — REALITY's server side
abandons the handshake above 8192 bytes and the customer sees a bare
reset (XTLS/Xray-core#6356).

**Proven, not inferred.** `installer/maintenance/reality-dest-audit.sh
--self-test` is the control case, committed so it can be re-run:
`www.torob.com` (AS215708 Mobin Arvand) passes, `www.asus.com`
(AS16509 AMAZON-02, `x-amz-cf-pop`) does not. Both passed identically
before. The degraded path was tested too, by shadowing `dig` with a
stub: CloudFront is still caught on the header signal, and `torob`
comes back flagged UNVERIFIED instead of clean.

**Three outcomes now, not two.** Usable / weak disguise / will not work.
Only a clean result is ever a default; a weak one has to be typed and
confirmed. That is deliberate — refusing a weak dest outright would drop
REALITY on a node with no clean option, and taking a transport away from
Iranian customers to win an argument about tidiness is the wrong trade.
The hardcoded `www.speedtest.net` fallback is gone; it has been
Cloudflare for over a year, so the one path that fired when everything
else failed was guaranteed to produce the exact mismatch the rest of the
function exists to prevent.

### What the fleet is actually wearing

Measured from this machine on 2026-08-23, so **the CDN verdicts are
durable and the specific addresses are not** — DNS answers depend on
where you ask. Re-run the audit on the node before acting.

| node | dest | verdict |
|---|---|---|
| finland1 | `www.shatel.ir` | sound — AS31549 Aria Shatel, IR |
| france-1 | **`cloudflare.com`** | worst case: AS13335, `server: cloudflare` |
| germany-1 | `www.shatel.ir` | works, but an Iranian ISP's name on a German address — **and the same dest as finland1** |
| singapore-1 | `www.shopee.sg` | sound — AS138341 Shopee Singapore |
| turkey-1 | `www.donanimhaber.com` | sound — AS6205 HizliNet, TR |

france-1's dest was read from `/usr/local/etc/xray/config.json` over
SSH. germany-1 refuses every key we hold, so its dest was recovered from
*outside* instead: open a plain TLS connection to `:443` with an SNI
REALITY will not authenticate, and it proxies you to the dest, which
hands back the dest's own certificate. Useful trick, and worth knowing
it works against us too.

Replacements measured clean the same day, per region:
`www.helsinki.fi` (FI, AS1741 FUNET), `www.heise.de` (DE, AS12306
Plus.line), `www.web.de`/`www.gmx.net` (DE, AS8560 IONOS), `www.free.fr`
(FR, AS12322 Proxad). The rejections are recorded in
`docs/detection-resistance.md` so nobody re-proposes them.

**Changing a live node's dest is not a client-side change.** The SNI
comes from the panel's Protocol Config; both ends move together or every
customer on that node fails exactly the way an intercepted domain does.
Owner decision, with a window.

### "Welcome to nginx!" — and it is four nodes, not three

The handover said singapore-1, turkey-1 and germany-1. **france-1 has it
too.** All four return the same 615 bytes with
`Server: nginx/1.24.0 (Ubuntu)` on it, so the version and the distro are
being volunteered as well. finland1 refuses the connection outright —
`ECONNREFUSED`, not a timeout, so nothing is listening rather than a
firewall dropping it.

**Why finland1 escaped:** `/etc/nginx/sites-available/default` is still
on the box; only the `sites-enabled` symlink is missing. Somebody removed
it there by hand and it never landed in the installer. `panel.sh` has
done `rm -f /etc/nginx/sites-enabled/default` since forever; `agent.sh`
never did. This is the "a hotfix on a live box is not done until a fresh
install is correct" rule, in the wild.

**Port 80 has to stay open, and this nearly went the other way.**
Renewal, not issue, is what needs it: certbot replays the authenticator
recorded per certificate. Read off the nodes —

| node | authenticator | consequence |
|---|---|---|
| france-1 | `webroot /var/www/html` | renews *through the default vhost being removed* |
| turkey-1 | `webroot /var/www/html` | same |
| finland1 | `standalone` | fine today; port 80 is free there |
| singapore-1 | `standalone` | **already broken** — nginx holds 0.0.0.0:80, so nothing can bind it |

So closing 80 breaks france-1 and turkey-1 immediately, and the failure
would not surface for ninety days, at which point Xray refuses a config
whose certificate it cannot read and the node loses *every* TLS inbound
at once. Redirecting to https is wrong for a different reason: 443 is
REALITY, so a 301 walks the scanner into a handshake returning a
certificate for somebody else's domain — louder than the page we are
removing.

`ensure_port80_site` therefore serves a deliberate page: the same dull
per-node text as the loopback fallback, `server_tokens off`, and an ACME
location out of `/var/www/html`. Proven on a throwaway Ubuntu with
nginx, from the "Welcome to nginx!" state to:

```
GET /                                   200, Server: nginx  (no version)
GET /.well-known/acme-challenge/probe   200, text/plain, exact token
GET a missing challenge                 404
```

and on the rollback path — a second vhost also claiming `default_server`
— it returns 1, says why, and puts the old link back, because a port 80
answering *nothing* is worse than one answering badly.

The `standalone` → `webroot` migration was proven by certbot's own
parser: after the rewrite it reads back
`'authenticator': 'webroot', 'webroot_path': ['/var/www/html'],
'webroot_map': {...}`. **What is NOT proven is a real renewal** — the rig
had no live certificate. `certbot renew --dry-run` is the ground truth
and the script tells the operator to run it rather than claiming it
works.

### Still to do, per node, and none of it done

Nothing on any node was touched. In the order I would do it:

1. **france-1's dest is `cloudflare.com`.** Worst case in the fleet and
   the one the code comments have argued against for months. Needs a
   panel Protocol Config change and a node change together.
   `www.free.fr` measured clean for it.
2. **germany-1 and finland1 share `www.shatel.ir`.** One dest across two
   nodes is one signature across two nodes. `www.heise.de` or
   `www.web.de` for germany-1. Blocked on germany-1's SSH key either
   way — `ovh_neo`, `azs_vps` and `neo_tr1` were all refused again
   today, so that key is now blocking two open items.
3. **`fix-node-port-80.sh --apply` on france-1, germany-1, singapore-1
   and turkey-1.** Run it without `--apply` first; the report tells you
   which of the two renewal states that node is in. Then
   `certbot renew --dry-run`, then `curl -sI http://<ip>/` from off the
   node.
4. **singapore-1's certificate renewal is already broken** and item 3
   fixes it as a side effect. Worth doing on its own schedule if item 3
   slips.
5. **finland1 needs nothing for the fingerprint** — but if anything ever
   puts nginx on its port 80, its `standalone` renewal breaks the same
   way singapore-1's did. `ensure_port80_site` migrates it if the
   installer is ever re-run there, which is the safe outcome, but it is
   worth knowing before that happens rather than after.

## 2026-08-23 — Port 80 taken back on three live nodes, and the probe that failed everything

Applied `fix-node-port-80.sh --apply` to the live fleet. france-1,
singapore-1 and turkey-1 are done and verified from outside.
**germany-1 was not touched — `ovh_neo`, `azs_vps` and `neo_tr1` were all
refused again.** That key now blocks three items: the 502 mirror, its
shared `www.shatel.ir` dest, and now this.

| node | pre-apply state | after | `certbot renew --dry-run` |
|---|---|---|---|
| france-1 | default vhost, `webroot /var/www/html` | `Server: nginx`, 188-byte page | **success** |
| singapore-1 | default vhost, `standalone` | `Server: nginx`, 188-byte page | **failed before, success after** |
| turkey-1 | default vhost, `webroot /var/www/html` | `Server: nginx`, 203-byte page | **success** |
| germany-1 | default vhost | untouched | not run — no SSH |
| finland1 | nothing on 80 at all | untouched | not run |

`certbot renew --dry-run` had never been run against a real renewal
before today. It passes on all three. The `standalone` → `webroot`
migration is now proven end to end and not just by certbot's parser.

**singapore-1's renewal was already broken, and now it is proven both
ways.** Before the change: `Could not bind TCP port 80 because it is
already in use`. After: `all simulated renewals succeeded`. The
certificate expires 2026-11-09, so this was a real outage due in about
eleven weeks — every TLS inbound on the node at once — not a theoretical
one.

finland1 was confirmed rather than assumed: nginx *is* installed there,
but only `neoxify-fallback` is enabled, nothing binds 80, and the port
refuses from outside. Its `standalone` renewal works *because* 80 is
free, which is the same coin singapore-1 landed on tails.

Nothing was restarted anywhere. Every engine's `ActiveEnterTimestamp`
still predates the change, and `agentd` on all three was seen executing
`reassert:… (CREATE_USER)` from the panel within a minute of it.

### The probe rejected every dest on every node

`reality-dest-audit.sh --self-test` **failed its own control case** the
first time it was run on a node — `www.torob.com`, the name the test
exists to accept, came back `BAD  negotiated , and REALITY requires TLS
1.3`. So did `cloudflare.com`, which had just completed a TLS 1.3
handshake from this machine.

Note the empty version in that message. `probe_reality_dest` read the
version out of the `SSL-Session:` summary block (`Protocol  : TLSv1.3`),
and Ubuntu's OpenSSL 3.0.13 **does not print that block** when the peer
closes first — which is every probe it makes, because stdin is
`/dev/null`. Only `New, TLSv1.3, Cipher is …` is reliably there. The
check therefore failed for *everything*, on the exact platform every
node runs.

This never showed up locally because the dev machine's openssl does
print the block. It would have shipped as: the installer offers no clean
candidate on any node, and the operator either types a weak dest past
the warning or drops REALITY there — the precise outcome commit
`70d909b` was written to prevent. Fixed by reading whichever of the two
lines exists. After the fix, on france-1: `www.torob.com` OK,
`www.asus.com` WEAK, self-test passes.

A harness reporting total failure is more likely broken than the thing
it measures. That is now twice this month.

**Second gotcha, smaller:** the `== Proof, from this node ==` block
inside `--apply` prints `Server: nginx/1.24.0 (Ubuntu)` even on a
successful run. It is racing its own `systemctl reload` — an old worker
still holding the listening socket answers it, and serves the *new*
index.html because the file on disk already changed, so the output looks
like a half-applied change and is not one. From outside, seconds later,
it is `Server: nginx`. Do not debug that line; check from off the node.

The ACME path was also proven from outside, through whatever firewall
each provider has in front: a token written into
`/var/www/html/.well-known/acme-challenge/` comes back byte-exact over
both the IP and the FQDN on all three nodes, and a nonexistent token
returns 404 rather than the index page.

### france-1's decoy: measured, and NOT applied

`www.free.fr` re-verified **from france-1 itself** with the repaired
probe: `212.27.48.10 is AS12322 PROXAD - Free SAS in FR`. Clean, and it
agrees with the earlier reading from this machine. `cloudflare.com`
confirmed WEAK from the node: AS13335, `server: cloudflare`.

The change was **not made**, because measuring the blast radius turned up
two things that are worse than "customers briefly reconnect":

1. **france-1's REALITY config is the exit for five ir1 relay routes** —
   Trojan, Shadowsocks, VLESS+REALITY, VLESS+TLS and VLESS+WS, each with
   its own `inboundTag`. The relay's uplink outbound is built from the
   *exit's* `publicParamsJson` (`agent-gateway.service.ts:430` →
   `relay/provisioner.go:213`). So this is not a france-1 REALITY change;
   it is a change to five protocols on a node in Iran. Routes reassert
   every 60s and should self-heal, but the failure mode while they do not
   is the one already in the journal: unmatched relay traffic egresses
   **at the relay**, in Iran.
2. **Mobile clients never refetch.** `getProtocolUsers()` has exactly one
   call site — `loadAll`, on mount / retry / server-switch. No poll, no
   TTL, no refetch on resume, and `credential-cache.json` has no expiry
   (`savedAt` is read only to render a label). Android keeps the WebView
   alive across backgrounding and adopts a running tunnel on open, so a
   stale `serverName` survives until the app is restarted. Toggling the
   VPN off and on inside the same session re-dials with the same dead
   SNI.

Add the desktop split-tunnel case: `Dashboard.tsx:933` short-circuits the
egress check to `connected` whenever `fromStatus === "connected"`, and
Xray's status is *always* `connected` (`engines/mod.rs:681` returns
`Unknown`). A Custom-mode user with a mismatched dest sees a green orb
over dead traffic, indefinitely. REALITY does not refuse an unknown SNI —
it proxies the customer to the decoy, so the handshake keeps succeeding.

Desktop full-tunnel is the only well-behaved path: two strikes, ~30s,
then the ladder moves them to another protocol — but `runLadder` re-reads
the same stale `protocolUsers`, so REALITY specifically stays dead until
a `loadAll`.

29 protocol_users hold a france-1 REALITY credential; the route is on
Trial, Starter, Pro and Ultimate Max.

**Sequencing, when it is approved.** Node first, panel second, and the
gap is what costs: node-side is `dest` + `serverNames` in
`/usr/local/etc/xray/config.json` and takes effect only on an Xray
restart, which is the one thing that cannot be done casually here. Panel
side is one PATCH to `protocol_configs.publicParamsJson` (the whole blob
is replaced; `dest` and `serverName` move together atomically). Ordering
node-then-panel keeps the disagreement to the seconds between them for
*new* connections, but that is not the number that matters — the number
that matters is how long a mobile customer keeps the old SNI, and that is
unbounded.

The honest options are (a) do it and accept mobile users are broken until
they restart the app, (b) ship a client that refetches before connecting
first, or (c) stand up the new dest on a second REALITY inbound on
another port, move the panel row, and retire the old one once nobody is
on it. (c) costs a port and no customer.


## 2026-08-23 — france-1's second REALITY inbound is up and proven; the panel row did NOT move

Option (c) from the previous entry: stand the new decoy up beside the old
one rather than swapping under live customers. The node half is done and
proven. **The panel half is not, and must not be done as specified** —
see "why it stopped" below.

### What is live on france-1 now

A second REALITY inbound, `vless-reality-free-in`, on **2083**,
`dest`/`serverNames` = `www.free.fr`. It reuses the *existing* keypair and
shortId deliberately, so `realityPublicKey` and `shortIds` in the panel
row stay byte-identical — the panel's stored public key hashes to the same
12 hex chars as the one derived from the live private key. Only
`serverName` and `port` would ever change client-side.

No restart. `xray api adi` over the local API at 127.0.0.1:10085
(`HandlerService` was already enabled). `xray` still reports
`ActiveEnterTimestamp` of 2026-08-19 04:00:23 UTC throughout, and all
eight protocols stayed up.

Rehearsed before doing it: `adi` a dokodemo-door on 127.0.0.1:19999,
confirm the socket, `rmi` it, confirm it is gone, confirm the six
production inbounds are still listed. `rmi <tag>` is the rollback and it
is proven, not assumed.

**Port 2083, and the warning that came with it.** Free on this node (TCP
in use: 22, 53, 80, 443, 2053, 7505, 8080, 8081, 8443, 10085, 10086,
37651), a conventional HTTPS-alt port, and consistent with what this node
already looks like from outside — it already answers TLS on 2053 and
8443, so 2083 adds one more port to a cluster a scanner already reads as
"host with several HTTPS endpoints" rather than a new *kind* of signal.

But Xray itself said, on the way in:

```
[Warning] infra/conf: REALITY: Listening on non-443 ports may get your IP blocked by the GFW
```

That is upstream's own warning and it cuts against the entire point of
the change. `www.free.fr` does not serve its site on 2083, so the decoy
is now port-inconsistent in a way `cloudflare.com:443` at least was not.
**There is no way around it on this node:** one global IPv4
(104.105.205.233), and xray's existing inbound binds `*:443`, which
covers v6 too — measured, not assumed. A second REALITY on 443 here is
impossible. So the honest framing of option (c) is *better decoy
identity, worse port*, and whether that trade is worth taking is the
owner's call, not mine.

### Proven end to end, from a vantage that could have said no

A real client, not a handshake:

| check | result |
|---|---|
| TLS from outside, SNI `www.free.fr` | `CN=free.fr`, Sectigo — byte-identical issuer/subject to the real site |
| wrong SNI (`example.org`) to 2083 | still `CN=free.fr` — prober gets the decoy, not a reset |
| **exit IP through the tunnel** | **104.105.205.233** |
| the client host's own IP | 172.236.143.200 |
| 1 MB payload | 1048576 bytes in 1555 ms |
| HTTPS to a third host | `example.com` → HTTP 200 |

Run from **singapore-1**, deliberately: a client on france-1 would report
france-1's address whether or not the tunnel carried anything. Separate
`xray run` process, loopback socks, killed afterwards; neither node's
xray service was touched. Test user removed after — the new inbound now
has **zero** users.

**Persisted.** `xray api adi` does not write to `config.json`, and nothing
in this repo re-adds an inbound after a restart — the 60s sweeps restore
*users* and *routes*, never *inbounds*. So the inbound was merged into
`/usr/local/etc/xray/config.json`, `xray run -test` first (it refused a
bad candidate once and left the live file untouched, which is the guard
working). Runtime and file now list the same seven tags.

That mattered more than it looks: **`xray.service` has no `ExecReload`**,
and `/etc/letsencrypt/renewal-hooks/deploy/reload-xray.sh` ends in
`systemctl reload xray 2>/dev/null || systemctl restart xray`. So a
certificate renewal *restarts* Xray on every node. fr1 expires
2026-11-17, i.e. renews around 18 October. A hot-added inbound would have
silently vanished then, with customers pointed at a dead port.

### Why the panel row did not move

Three things, any one of which is enough.

**1. It would break all 29 direct REALITY customers.** The new inbound
has a new tag. `protocol_configs.inboundTag` for france-1 is empty, and
with it empty the backend omits the key
(`protocol-users.service.ts:454-456`) and `agentd` falls back to its
`--xray-inbound-tag` default of `vless-in`
(`agent/cmd/agentd/main.go:34`; the unit passes no flags). So the 60s
reassert would keep writing all 29 users onto the **old** inbound while
their clients dialled 2083. Setting that column is the fix — but
`UpdateProtocolConfigDto` accepts only `listenPort`, `publicParamsJson`
and `isEnabled`, so `inboundTag` **cannot be set through the API at
all**. It needs direct SQL, which is a bigger decision than "move the
panel row".

**2. The five ir1 relay routes would not follow, and would say they
had.** The uplink outbound tag is `route-<routeId>-out`, derived from the
route id alone — it encodes nothing about the exit
(`relay/provisioner.go:80-82`). Xray's `AddOutbound` rejects a duplicate
tag rather than replacing it, and the agent swallows exactly that error
as success (`relay/provisioner.go:93-104`). So the sweep would send the
new port every 60s, ir1 would ack five healthy routes, and every one of
them would still be dialling 2083's predecessor. A green panel over an
unchanged reality — the exact failure mode this journal keeps recording.

**3. Retirement is off the table anyway.** 29 users sit on the old
inbound right now. It stays.

### A live problem found on the way: the relay uplinks are already gone

Looking for the uplink credentials turned up none. On france-1's
`vless-in`: **29 users, zero whose email starts with `route:`** — the
29 are exactly the 29 direct `protocol_users`.

The five `-> France` relay routes were created **2026-08-13**. france-1's
xray restarted **2026-08-19 04:00 UTC**. The uplink user is created
*once*, at route creation (`routes.service.ts:268-277`), has no
`ProtocolUser` row, and `reassertProvisionedUsers` reads only
`protocolUser` — so **nothing re-asserts it, ever**. The restart wiped
all five and they have not come back.

Each of those five routes has 1 ACTIVE customer, and they are Iran-relay
customers. This predates today's work by five days and I did not cause
it, but it is almost certainly a live outage. **Not yet confirmed from
ir1's side** — I have no key for ir1 and did not go looking for one. That
confirmation is the first thing to do next.

It also explains something that would otherwise be puzzling later: even a
*correct* panel move would not have restored these, because the code path
that creates them never runs again.

### Gotchas worth the next session's minutes

- `xray api adu` needs `port` and `listen` on the inbound stanza you hand
  it, or it fails with `Listen on AnyIP but no Port(s) set in
  InboundDetour` and cheerfully reports `Added 0 user(s)`.
- `xray api rmu` takes `-tag=<tag>` plus bare emails — it does **not**
  take the same JSON file `adu` does, and given one it says `inbound tag
  not specified`.
- `xray run -test -config <file>` needs the filename to **end in
  `.json`**, otherwise `Failed to get format` — which looks exactly like
  a malformed config and is not.
- `xray x25519 -i` wants the key as an argument; `-i /dev/stdin` silently
  yields nothing.


## 2026-08-23 — The releases are not signed either

**Status:** done (correction) / blocked (the signing itself)
**Touches:** `docs/journal/windows.md` only

Correcting the previous entry. It said Defender's
`Trojan:Win32/Bearfoos.B!ml` hit "affects the locally built, unsigned
installer" and that "CI-signed releases are not affected". The second
half is wrong, and wrong in the direction that matters: **there are no
CI-signed releases.** Every published installer is unsigned, including
the one on the download page right now.

### Signing has never run once

Not "since 0.9.24" — never. The steps went in with 74ccf1a on
2026-08-11, and the first release after that, `desktop-v0.9.4`, already
skipped them. So has every release since. Checked all 25 release runs
from 0.9.4 to 0.9.28, individually: each one emitted

> AZURE_CLIENT_ID is not set, so this build is NOT Authenticode-signed.

The whole block is gated on one expression at line 39 of
`release-desktop-windows.yml`:

    SIGNING_ENABLED: ${{ secrets.AZURE_CLIENT_ID != '' }}

and `Azure login`, `Sign the installer`, `Re-sign the updater payload`,
`Sign the bootstrapper` and `Verify both binaries are signed and
timestamped` are each `if: env.SIGNING_ENABLED == 'true'`. `gh secret
list` returns four secrets — the two `TAURI_SIGNING_*`, the two
`ANDROID_KEYSTORE_*`. No `AZURE_*` anything, and no repo variables at
all. All six Azure secrets the workflow reads (`AZURE_CLIENT_ID`,
`AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_SIGNING_ENDPOINT`,
`AZURE_SIGNING_ACCOUNT`, `AZURE_CERT_PROFILE`) have never existed.

The degrade-instead-of-fail behaviour is deliberate and documented in
the file, and the `Verify` step does guard against a signing step that
silently no-ops. But that guard is itself gated on `SIGNING_ENABLED`,
so with no credentials there is nothing asserting anything — the
release goes out green and unsigned, which is exactly what has happened
twenty-five times.

**Why:** shared.md's 2026-08-11 entry has it. The Azure Artifact
Signing account exists (`neoxify-signing`, West US 2), but identity
validation stalled at credentials.microsoft.com with "No access" and
was never resumed. It is still Action Required, not failed. Nothing is
wrong with the workflow; the enrolment was never finished, so the
secrets were never created. Resume via the existing validation's
"complete your verification" link — **do not start a second one.**

### Defender does not flag the published 0.9.28 assets

Measured, not assumed, on the host (Win11, real-time protection on,
signatures 1.457.304.0 from 2026-08-22). Downloaded both assets from
the release, verified against `sha256sums.txt` (both OK), then:

- `Get-MpThreat` / `Get-MpThreatDetection` — nothing.
- `Start-MpScan -ScanType CustomScan` over the directory — clean.
- `MpCmdRun.exe -Scan -ScanType 3` per file — "found no threats",
  exit 0, both.
- Both files still on disk afterwards with unchanged hashes. Nothing
  was quarantined.

`Get-AuthenticodeSignature` on both: `Status: NotSigned`,
`SignerCertificate: <null>`. So the released `Neoxify-Setup.exe` and
`Neoxify_0.9.28_x64-setup.exe` are in exactly the state the Bearfoos
entry assumed they were not.

**The scan was a real negative, not a false pass.** A 40 MB custom
scan returning in one second is the shape of a result this repo has
been burned by before, so it got a control: an EICAR test file written
into the same scratch directory was caught in seconds as
`Virus:DOS/EICAR_Test_File` (2147519003), and both `Get-MpThreat` and
`Get-MpThreatDetection` reported it **from the same unelevated shell**
that had just returned empty. That proves three things at once — the
directory is not excluded, real-time protection is live on it, and the
cmdlets do surface detections without elevation. The empty result on
the installers is therefore a true negative. Control file deleted
afterwards; no exclusions were added and no protection was disabled.

**What this does not prove.** One host, one signature version, one
point in time. `!ml` verdicts are per-file-hash and cloud-scored, and
they move — the VM hit a real detection on a locally built installer
with these same characteristics. A clean scan today is not a promise
about tomorrow's build, and it says nothing about third-party AV. It
only refutes the specific claim that release assets are protected by a
signature they do not have.

### What being unsigned costs

Every customer gets "Unknown publisher" on the UAC prompt and a
SmartScreen block on first download — for a VPN, downloaded by people
in Iran who are already taking a risk running a binary from a stranger,
on a product asking for money. That is the actual cost, and it is being
paid on every install today. AV detection is the second-order risk:
unproven against the shipped asset, demonstrated against a local build.

Unsigned SmartScreen reputation is not a way out. It accrues per
certificate, and per file hash absent one — this project has shipped a
new installer nearly every day for two weeks, so each release starts
from zero and never reaches the threshold.

Fix path is unchanged and still #91: finish the Azure identity
validation. Certum OV + SimplySign stays the fallback. Worth noting for
the driver question on the roadmap — a WFP callout driver cannot be
covered by any of this. Kernel-mode needs EV plus Microsoft Partner
Center attestation signing, which is a separate enrolment from
Authenticode, not an upgrade to it.

### The fix path, costed

Researched against Microsoft's current docs, because two things
everybody "knows" about this are out of date.

**Eligibility is about where *we* are, not where customers are.** Azure
Trusted Signing was renamed **Azure Artifact Signing** (docs moved to
`/azure/artifact-signing/`, CLI is `az artifact-signing`; the resource
provider is still `Microsoft.CodeSigning`). Public Trust certificates
are open to organisations in the US, Canada, EU, UK and a handful of
others — but **individual developers must be in the US or Canada**
([quickstart prerequisites][ts-qs]). We validate as an individual and
we are US-based, so the individual path is open. Iran is where the
users are; it has no bearing on eligibility.

**Option 1 — finish Azure Artifact Signing. $9.99/month, Basic.**
5,000 signatures/month, far beyond a daily release. No hardware token,
works from GitHub Actions, which is what the workflow is already built
against. Requires a Pay-As-You-Go subscription (free/trial/sponsored
are refused — shared.md already hit that). Individual validation is
AU10TIX Verified ID: government photo ID, phone, proof of address, then
a Verified ID card presented back from Microsoft Authenticator. It is
an interactive same-session flow, minutes rather than the 1–20 business
days the organisation path quotes.

**Option 2 — a conventional OV certificate.** **$150–300/yr**
([code-signing-options][cso]), plus a hardware token or cloud HSM:
since June 2023 the CA/B Forum requires **OV as well as EV** keys to
live in a FIPS 140-2 Level 2 (or CC EAL4+) module, so there is no "put
the .pfx in a secret" option any more. Certum + SimplySign, already
noted in shared.md, is this shape. Microsoft frames OV as the option
for people who *cannot* use Artifact Signing on geography — which is
not us.
Strictly worse than option 1 on both cost and CI ergonomics; it is the
fallback if Azure sours, not the plan.

**Option 3 — stay unsigned and build reputation. Not viable, and worth
being definite about.** Microsoft: *"When a file is not signed,
SmartScreen reputation must build for each new version of your files,
starting with zero reputation. Reputation cannot transfer from previous
versions unless both were signed using the same publisher identity"*,
and it *"can take several weeks and hundreds of clean installs from a
wide audience"* ([smartscreen-reputation][ss]). We have shipped 25
installers in twelve days. Every one starts at zero and none will ever
reach the threshold. There is also **no submission mechanism** for
consumer SmartScreen — the WDSI portal is an enterprise-admin path
only. Doing nothing is a permanent choice, not a delay.

### Two things in this repo that are now wrong

**The 460-day figure is misattributed.** The workflow comment (lines
148–153) and shared.md both tie it to the Azure certificate. It is
actually the CA/Browser Forum cap on *conventional* code-signing certs
issued from 2026-03-01. Artifact Signing certificates are **renewed
daily and valid for 72 hours** ([cert management][ts-cert]). The
conclusion the comment draws is still right and in fact stronger —
without `timestamp-rfc3161` a signature dies in three days — but the
reason is the 72-hour cert, not a 460-day one. Not fixing it here; this
task is investigation plus this correction.

**"Do not create a second identity validation" may no longer hold.**
The docs say validation email links **expire in seven days**, and that
if email verification fails you must start a new request. Ours was
created 2026-08-11 — twelve days ago. Whoever picks this up should
check whether the existing link is still live before assuming it can be
resumed; the shared.md advice was written when it was fresh. Flagging
rather than asserting — I could not verify the link's state without the
Azure portal.

### EV buys nothing here, and the driver is a separate purchase

Worth killing an assumption before it costs money. **EV certificates no
longer bypass SmartScreen** — Microsoft removed that in 2024 and now
says plainly that *"paying a premium for EV solely to avoid SmartScreen
warnings is no longer justified"* ([smartscreen-reputation][ss]).
Nothing gives instant trust except shipping through the Microsoft Store
(re-signed by Microsoft, no warning at all) — which #94 already
identified as EXE-viable and blocked on exactly this signing work.

For the prospective WFP callout driver, none of the above helps.
Artifact Signing **cannot sign kernel drivers and will never issue EV
certificates**; kernel-mode goes through Partner Center attestation
signing, which requires a real **EV cert ($400+/yr)** *and* an
organisation-level registration — you register as a **global
administrator of an organisation's Entra tenant**, and the EV cert is
needed to register at all, independently of signing the driver. That is
company-gated, and the company does not exist yet. Two consequences: the driver cannot be costed as an upgrade to
whatever we do now, and the current user-mode WFP kill-switch
(`fwpmu.h`, no driver — only *redirection* needs a callout) is worth
protecting precisely because it keeps us out of that gate.

**Recommendation: finish option 1.** It is $9.99/month against a
half-finished enrolment, it is the only option that makes reputation
accumulate across releases instead of resetting daily, and it is the
one the workflow is already wired for — six secrets and nothing else.
It will not stop the SmartScreen warning on day one; nothing will. What
it changes is that the warning starts decaying instead of resetting,
and that a customer in Iran deciding whether to trust a VPN binary sees
a real legal name instead of "Unknown publisher". For this product that
is the whole point, and it is currently blocked on a phone, an ID
document and twenty minutes — not on money or engineering.

### Two loose ends, flagged rather than buried

**The Store path does not dodge signing.** #94's EXE route still
requires the installer to be Authenticode-signed with a certificate
chaining to a Microsoft Trusted Root Program CA — only *MSIX* gets
re-signed by Microsoft for free. So the Store is downstream of this
work, not an alternative to it.

**SignPath Foundation offers free OV-level signing for qualifying
open-source projects** ([code-signing-options][cso]). This repo is
public, but Neoxify is commercial, and I have not checked their
eligibility rules. Worth ten minutes before paying for anything —
recorded as a lead, not a plan.

**On sourcing.** The dollar figures above are Microsoft's own published
comparison, not estimates. An earlier draft of this entry carried
invented ranges for the OV and EV costs; they were wrong in both
directions and are corrected here. Numbers in this section that are not
followed by a citation should be treated as unverified.

[ts-qs]: https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart
[ts-cert]: https://learn.microsoft.com/en-us/azure/artifact-signing/concept-certificate-management
[ss]: https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation
[cso]: https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options
[csc31]: https://www.digicert.com/blog/understanding-the-new-code-signing-certificate-validity-change

## 2026-08-23 — The 15 MB APK regression was uncompressed DWARF, not a bigger app

**Status:** fix written, **unverified — needs a CI run to confirm**

The direct-download APK went 125.8 MB (0.2.13, 0.2.14) → 141.2 MB
(0.2.15) with no repository change beyond version strings. Attributed by
downloading all three published artifacts and diffing them, not by
reading the build.

**Where it went.** Every byte is in one file:

| component | 0.2.14 | 0.2.15 | delta |
|---|---|---|---|
| `lib/armeabi-v7a/libgojni.so` | 43,836,044 | 59,876,164 | **+16,040,120** |
| `lib/arm64-v8a/libgojni.so` | 46,137,880 | 46,137,872 | −8 |
| everything else (dex, res, assets, wg, mobile_lib) | — | — | ±60 KB |

**What actually changed inside it: nothing.** `.text` (14,956,152),
`.gopclntab` (10,917,198), `.noptrbss`, `.symtab`, `.strtab` and
`.rel.dyn` are byte-for-byte identical between the two builds. Both
report `go1.26.5` and `clang/LLD 19.0.1`.

The difference is that in 0.2.14 all twelve `.debug_*` sections carried
`SHF_COMPRESSED` and in 0.2.15 they do not — same DWARF, stored raw.
The uncompressed sizes match *exactly* across the two builds
(`.debug_info` 11,807,810; `.debug_line` 5,505,438; `.debug_loclists`
4,568,306; `.debug_frame` 1,416,716; `.debug_rnglists` 1,370,235;
`.debug_addr` 159,320). 24,858,735 raw vs 8,818,508 compressed =
**16,040,227 bytes**, which is the whole regression to within ~100 bytes
of section-header churn. arm64 kept compression and is unchanged.

So it is pure toolchain drift in the link line, and the link line is
gomobile's — which was installed `@latest`, unpinned, *and* skipped
entirely if any gomobile was already on PATH. The one new string in the
0.2.15 armv7 binary and not the 0.2.14 one is `ndk/28.2.13676358`,
consistent with a differently-constructed link.

**Do not chase which gomobile commit flipped the compression bit.** The
right answer makes it moot: we should never have been shipping DWARF.

**Measured headroom, from 0.2.15's own artifacts:**

- `.debug_*` + `.symtab`/`.strtab` across all native libs: **54,794,330
  bytes (52.26 MiB)**. Stripping it takes the APK 141.17 → **88.92 MiB**,
  i.e. 37 MB *below* the pre-regression baseline.
- `libgojni.so` accounts for 42.3 MB of that; `libmobile_lib.so` (Rust)
  another 12.5 MB, all of it symbol table — it ships no DWARF because
  cargo already defaults `debug = false`.
- `libwg-go.so` has zero of either. The WireGuard AAR arrives already
  stripped by its vendor, which is the standard we were not meeting.

**What was changed:** `-ldflags="-s -w" -trimpath` on `gomobile bind`;
gomobile pinned to the same x/mobile pseudo-version go.mod already uses
for the bind runtime; Go pinned to 1.26.5 with `GOTOOLCHAIN=local` in
both Android workflows (there was no `setup-go` step in either at all);
Rust pinned via a new `apps/mobile/src-tauri/rust-toolchain.toml`; a
`[profile.release]` added to the mobile crate.

**Predicted, not measured: ~89 MB.** Nothing here was built — an Android
build cannot be produced on this machine. The strip figures are exact
because they are section sizes read off shipped binaries, but the LTO /
`opt-level = "s"` effect on `libmobile_lib.so` is a guess and the next
CI run is what settles it. Compare against 148,031,919 bytes.

**Debuggability, stated rather than buried.** Go tracebacks are
unaffected: they come from `.gopclntab`, which the runtime requires and
`-s -w` does not touch. The real loss is Rust-side — `strip = "symbols"`
means a hard signal crash in `libmobile_lib.so` returns bare addresses.
Rust panics still carry message and location. If field symbolication
starts mattering, archive the unstripped `.so` as a CI artifact rather
than shipping symbols to every user.

**Two things found and deliberately NOT done:**

1. **Native libs are `STORED`, not deflated** — 146.5 MB of the 148.0 MB
   APK is uncompressed. Deflating them would save a further ~87 MB of
   download. It is not free: uncompressed is what makes the 16 KB
   load-segment alignment work and what `check-elf-alignment.py` guards,
   and flipping it doubles on-device storage. Worth a deliberate
   decision with a real build behind it, not a drive-by.
2. **Per-ABI APKs as extra release assets.** armv7 is 73 MB of the 141
   MB, and the splits are already built and thrown away. But
   `/updates/installer/android` matches on `.apk$` — publishing
   `Neoxify-x.y.z-arm64.apk` beside the universal one risks handing a
   32-bit phone a 64-bit APK. The API matcher has to be fixed first.
   The universal APK stays the download-page default regardless: a
   website link cannot ask which chip the phone has.

**Still unpinned, knowingly:** `runs-on: ubuntu-latest`, all `uses:` at
floating major tags, and `@tauri-apps/cli: "^2"` — which is the big one,
because the CLI generates the entire uncommitted `gen/android` Gradle
project (AGP, wrapper, minify, `debugSymbolLevel`, packaging). The
lockfile holds it at 2.11.4 today, so it is latent rather than active
drift, but it means those Gradle settings are unreviewable in this repo.

## 2026-08-24 — agent v0.2.6 is on ir1, and the fleet can finally be read

**The relay convergence fix is live on ir1 and no longer needs a human.**
ir1 runs `v0.2.6` (sha256 `f3a6215f…`); the other five nodes are
untouched on v0.2.5 and do not need it — ir1 is the sole relay entry for
all 13 relay routes, and the relay provisioner never runs on an exit
node. The eight stale outbounds that were cleared by hand with
`xray api rmo` stay cleared, but the reason they could accumulate is gone:
a changed `CONFIGURE_ROUTE` now converges instead of being acked.

**agentVersion is no longer a lie, and this is the useful part.** Every
release up to v0.2.5 linked with `-s -w` and never set
`-X …/version.Version`, so all six nodes reported `agentVersion=dev` and
the only way to tell one build from another was sha256 per node. The
Makefile stamps it now, `release-agent.yml` passes `github.ref_name`
rather than trusting `git describe` in a shallow checkout, and there is
an `agentd --version` flag. **The panel currently shows ir1 as `v0.2.6`
and the other five as `dev` — that is the honest state, not a bug.** They
will keep saying `dev` until each one is rolled forward, because the
string is baked in at link time.

Use `--version`: it works on a downloaded binary before it is installed
and on a node that is not enrolled, which is how the ir1 rollout was
checked before anything was overwritten. The release workflow now runs
it on the amd64 artefact and fails the release if it does not report the
tag.

**Two installer traps, still there, still worth knowing.** Menu option 2
(`action_update_agent` → `fetch_agent_binary`) does `install -m 755`
straight over `/usr/local/bin/agentd` and keeps **no backup** — copy the
outgoing binary aside yourself first. And `resolve_agent_release_base`
picks the release with `jq '… | first'`, which is GitHub's API ordering
(created_at desc), not semver: it happens to be right today, but a
re-published or back-dated release would quietly hand a node the wrong
build. Pin `AGENT_RELEASE_URL_BASE` for anything deliberate. The v0.2.5
binary from ir1 is at `/root/agent-rollback/agentd-v0.2.5-8cc30b52` on
that box.

**What the rollout proved, and what it did not.** Restarting the agent
reconnects with an empty `appliedProxy`, so all 13 outbound tags are
taken by an Xray that never restarted and none match a fingerprint the
new process holds: 13 rebuild lines at 14:02:09, 13 distinct route tags,
then every 60 s sweep after it produced **zero**. That is both halves of
the contract observed on production — the refusal is surfaced instead of
swallowed, and an unchanged route is still left alone, which is what
stops the sweep dropping a session a minute. All 13 routes came back
with fresh `uplinkAssertedAt` and no `uplinkLastError`.

**Not proven on production: a backend-originated parameter change.**
Every field of `ExitParams` is load-bearing — address, port, protocol,
the REALITY `publicParams`, the uplink credential — so there is no field
that can be altered on a live route as a test without changing a real
exit's config or rotating the relay customer's uplink. The empty-map
case after restart exercises the same branch, and
`TestConfigureRouteRebuildsAStaleOutbound` covers the literal
cloudflare.com → www.shatel.ir change, but if you want it end-to-end on
production the test is: change one exit's REALITY `serverName` in the
panel, watch for one `rebuilding it` line naming that route's tag, then
confirm the exit IP through it still matches the exit node. That needs
an owner decision, because it is a live protocol config.

**The agent still touches no engine.** Confirmed again here: xray's
`ActiveEnterTimestamp` stayed 2026-08-17, wg-quick and openvpn stayed
2026-08-14, and established connections were 6 before and 6 after.

---

## 2026-08-24 — The two option-2 traps are now the installer's problem, not the operator's

**Status:** landed on `claude/installer-agent-update-safety`, unpushed,
**never run against a node**
**Touches:** `installer/lib/agent.sh` only

The two traps the v0.2.6 rollout entry left standing — no backup of the
outgoing binary, and release resolution by GitHub's API ordering — are
fixed in source. Nothing here has touched a production node; the whole
thing was exercised against a throwaway Linux box with the network
stubbed.

**What a rollout should actually run first.** This is proved against
synthetic input, not against a node, so the first real use is still the
test. On a node, before trusting it:

```
/usr/local/bin/agentd --version       # before
# menu option 2
/usr/local/bin/agentd --version       # must equal the tag it printed
ls -l /root/agent-rollback/           # the outgoing binary must be there
cd /root/agent-rollback && sha256sum -c <name>.sha256
```

If option 2 aborts, the point is that it aborts *before*
`systemctl restart` — so `systemctl status neoxify-agentd` should show
an uptime that predates the attempt. That is the half worth watching.

**The failure the version check catches, and why the existing checksum
does not.** A re-published or mis-tagged release ships its own
`sha256sums.txt`. The checksum step proves the download was not
corrupted; it says nothing about whether it is the build that was asked
for. Fed a release that answers to `v0.2.6` and contains `v0.2.4`, the
code on main installs it and returns 0 — the caller then restarts the
service onto a silent downgrade. That is not arithmetic on paper, it is
what the stubbed run does.

**A window problem worth knowing about.** `per_page` went 50 → 100 (the
API maximum). The live list is 66 releases and only 8 of them are the
agent's — desktop ships roughly thirty releases per agent release. At
per_page=50 the window already stops before `v0.2.1`. It does not fail
loudly when it stops containing *any* agent release; it just says "could
not find an agent release" and the operator has no reason to suspect
paging. 100 buys headroom, not a fix. If the agent goes quiet for
another hundred desktop releases this needs `per_page` + `page`, or
`/releases/tags/<tag>` with the tag computed some other way.

**Left alone deliberately:** the menu, the prompt sequence, and every
engine path. `action_update_agent` still does fetch-then-restart and
still touches no engine.

**Not verified, and cannot be from here:** that `install -m 755` over a
*running* agentd behaves on a node the way it does in the test — the
stand-in binary is not a running service — and that `/root/agent-rollback`
sits on a partition with room for five ~20MB binaries. Both are one look
on the first node that takes an update.
## 2026-08-24 — the website branch was rendered for the first time, and six faults fell out

`claude/website-redesign` is pushed and **open as a PR, not merged**. The
site is a PHP site under `website/` and stays one; nothing about this
touches the desktop client, the agent or the installer.

**The thing worth carrying forward is the method, not the diff.** The
branch had been written, committed and never loaded in a browser. It
passed `scripts/check-site.php` — which renders all eighteen pages
through the real include path and catches missing translation keys,
duplicate titles and over-long descriptions — cleanly, first try, before
any of the fixes below. Every one of them was invisible to it, because
it renders markup and does not lay anything out. **Rendering is a
separate check from templating, and this repo now has evidence of how
much only the second one sees.**

What only a browser showed:

- **The mobile drawer never closed.** `.mobile-nav` sets `display: grid`,
  which outranks the UA stylesheet's `[hidden] { display: none }`, so
  `site.js` setting `drawer.hidden = true` did nothing. Every page below
  56rem shipped with the whole navigation expanded under the header.
  Measured at 375px: `hidden === true`, computed display still `grid`,
  456px tall. The JS was right; the author rule silently won.
- **`30 GB` in a Persian sentence rendered as `GB 30`.** Neutral digits
  plus a Latin unit inside an RTL paragraph, reordered by the bidi
  algorithm — unit first, read right to left. It was on the Persian home
  page, the plan cards and the comparison table. Fixed by not mixing
  scripts at all: `nx_format_data()` puts the amount through `nx_num()`
  and names the unit from the catalogue, so Persian gets
  `۳۰ گیگابایت`. **Same class of bug as the Custom-mode toggle that once
  showed "on" where a Persian reader reads "off".** Any Latin token
  dropped into Persian copy needs checking in a browser, not in a diff.
- A `.bento` nested inside `.split__media` resolved to three columns
  inside a half-width container, because grid media queries ask the
  viewport and know nothing about the box they are in. One cell came out
  170px wide, one word per line.
- `.lead` caps its measure at 46ch with no auto inline margins, so under
  a centred `h1` it sat against the start edge — 170px off, and mirrored
  in Persian. `text-align: center` centred the lines inside the box,
  which is why it looked almost right.

Two content faults of the honesty kind, also only visible side by side
on screen:

- The hero mockup badged macOS **"Soon"** while `/download/` says, in as
  many words, that an app which does not exist is not "coming soon".
- The Persian download page still said macOS and iOS were **در حال
  توسعه** — in development — months after the English had been corrected
  to "not built yet, and we are not putting a date on either". The
  softer claim was the one facing the audience most likely to act on it.
  **Assume the Persian catalogue lags the English one** whenever a claim
  changes; nothing links the two.

**A deploy-blocking bug in `nginx-website.conf.example`.** It carried a
`location ~* \.php$` block holding only a `Cache-Control` header, above
the block that calls `fastcgi_pass`. nginx tries regex locations in file
order and stops at the first match, and that block has no
`fastcgi_pass`, so nginx falls back to serving the file from disk —
every page of the site, plus `404.php` and `sitemap.php`, as PHP source
text. Fixed. **It has not been through `nginx -t`**: there is no nginx on
this machine and Docker Desktop would not come up. Run `nginx -t` before
reloading, and treat that as a real gate rather than a formality — this
same file has now had one fault that would have taken the site down and
was found by reading.

### Environment, for whoever renders this next

- The site serves locally with `php -S 127.0.0.1:8123 -t website
  <router>`; the router in the scratchpad emulates the two things the
  server does that the built-in one does not — the `/sitemap.xml`
  rewrite and `ErrorDocument 404 -> /404.php`. Without it every unknown
  path 200s, which is the exact production defect being fixed, so a
  local check without the router will report the bug as absent.
- **Ports 8615-8714, 8747-8946, 9196-9395 and 9460-9863 are reserved by
  Hyper-V on this box** and `bind()` fails on them with a permissions
  error that reads like a sandbox denial and is not. `netsh interface
  ipv4 show excludedportrange protocol=tcp` lists them. `.claude/
  launch.json` in the worktree points at **8791, which is inside one of
  those ranges** and cannot bind — pick something outside them.
- Screenshots were driven over CDP against headless Chrome. **Capturing
  a full page with `captureBeyondViewport` on an RTL document is not
  faithful** — it produced a page shifted ~300px with the right-hand
  side clipped, on a document whose `scrollWidth` equalled the viewport.
  It looks exactly like a broken RTL layout and is not one; it cost a
  real detour. Capture viewport-sized strips and stitch them instead.

### Open, and needing the owner rather than more work

- **Persian still has not had a native review.** `fa.php` says so in its
  own header and that caveat stands. Missing keys fall back to English,
  so any line that reads badly can be deleted rather than patched.
- **Ultimate Max is `isActive = false` and `isPurchasable = true`** — on
  sale at $50 while not usable. It is deliberately absent from the site.
  Activate it or stop offering it; the website cannot decide that.
- The site publishes no server count and no uptime figure, and makes no
  no-logs, kill-switch, auto-connect, refund or signed-installer claim.
  That is deliberate and load-bearing. `website/README.md` now lists it
  as a convention so the next pass does not "improve" it back.

---

## 2026-08-24 — Website rebuilt as "The Ladder", and four faults nothing was looking for

The marketing site is redesigned and shipped on `claude/website-ladder`.
The concept the owner approved was a single HTML file with hash routing;
it is now ported into the existing PHP architecture — real per-locale
URLs, the partials, the content files, both language files, all intact.
`build/neoxify-website.zip` is the deliverable.

### Things that were broken and are not any more

**Every account-deletion request was being thrown away.** `nx_form_open()`
built its action from `nx_url($form)`. The form is named `deletion`, the
route key is `delete-account`, and `nx_url()` falls back to the home page
for a key it does not know — so the form rendered `action="/"` and posted
to a page with no handler. Silently. For however long it has been there.
That page is a **Play Console data-safety requirement**, so it is the one
form where failing quietly is expensive. `check-site.php` passed clean
throughout: it renders pages and never looks at a form action. If you add
a form, add an action assertion with it.

**`/account/` could not load at all on a correctly-configured host.** The
portal is a compiled SPA with only `index.html`, and all three server
configs listed `index.php` as the sole directory index. `/account/` → 403
on Apache and nginx, 404 under the dev router, *while every file inside
`/account/assets/` served 200*. That asymmetry is why it looks fine: the
bundle is reachable, the page that loads it is not. On the live nginx box
this depends on the hand-written config — **check `index` there before
assuming the portal works in production.**

**Every icon on the site was unsized.** `nx_icon()` emitted `viewBox` and
no `width`/`height`, and the old stylesheet's sizing rule did not survive
the restyle. An inline SVG with only a viewBox has no intrinsic size, so
as a flex item it takes the container's width: the alert glyph beside the
unsigned-installer warning measured **331×331** and crushed the sentence
beside it to 52px. All three emitters now carry explicit dimensions.

**Flag emoji do not render on Windows at all.** `nx_flag()` returns
regional-indicator pairs; Windows ships no flag font, so every location
showed as bare letters in a box — on the platform the desktop client
targets. Replaced with inline SVG flags on a 3×2 viewBox, with the emoji
kept as the fallback for a country not drawn yet.

### The class of bug that dominated this pass

`body { overflow-x: clip }` means a too-wide element **does not scroll,
it silently disappears**. Nothing looks broken; the sentence just ends
early. Six separate instances, every one found by measuring rather than
reading:

- flex children with no `min-width: 0` (the automatic minimum is
  min-content, not zero)
- grid tracks written `1fr` instead of `minmax(0, 1fr)`
- `.notice` used two ways on the download page — icon+body *and*
  heading+list — where the two-column rule gave the heading 173px of a
  320px screen and left the install steps 58px
- the Persian header row, 14px over at 375px, quietly clipping the menu
  button

**If you touch this stylesheet, re-run the width sweep.** Checking
`scrollWidth` is not enough on its own; walk the text nodes, and check
`left < 0` too, because in RTL the overflow escapes leftward.

### Two judgement calls worth knowing about

**The interactive panel publishes no numbers.** The approved concept had
a per-protocol latency column — invented figures, chosen to look
plausible. Dropped, and the panel says in both locales that it is an
illustration that contacts nothing. Same reasoning as `down_mbps` being
null in `plans.php`: a number beside a protocol name reads as a
measurement. What stayed is the `blocked_by` mapping, which is traceable
from how each transport looks on the wire.

**Lanes are ordered by a new `try_order` field, not the content file's
order.** `protocols.php` lists REALITY first, and REALITY is stopped by
none of the conditions — so listed that way the top lane survives
everything, the handover counter is nailed to zero, and the one thing the
panel exists to demonstrate never happens. `try_order` is explicitly *not*
a speed or quality ranking and no page presents it as one.

### Counts are gone from the copy

At the owner's instruction: no "eight protocols", no "five countries", no
Persian equivalent. Thirteen strings per locale, including two `<title>`s,
four meta descriptions and two JSON-LD descriptions — the places where a
stale number is worst and least visible. **The protocol names stayed**;
those are the search terms worth having. `home.stats.*` and the counted
stat strip are deleted. `nx_protocol_count()` and `nx_location_count()`
still exist but are now unused — leave them, or remove them deliberately.

### Environment notes that cost time

- **`zip` is not installed on this box.** `make-zip.sh` now falls back to
  Python. It must never fall back to `Compress-Archive`: that writes
  **backslash** separators, which unpack fine on Windows and produce a
  flat pile of files named `inc\bootstrap.php` on a Linux host.
- **`python3` on Windows is a Microsoft Store stub.** It satisfies
  `command -v`, then prints "Python was not found" and exits non-zero.
  Probe candidates by actually running them, not by name resolution.
- **A stale `php -S` from another session was already bound to 8123** and
  answering my requests with the *old* site. Two processes were listening
  on the same port and `curl` got whichever won. Three locale tests
  "failed" against code I had already fixed. Check `netstat -ano | grep
  :<port>` before believing a negative result, and prefer an unused port.
- The browser pane's `resize_window` did not change layout width —
  `innerWidth` stayed at its native value while `clientWidth` reported the
  requested one. Measuring against `clientWidth` invents overflow that is
  not there. **Same-origin iframes at a fixed pixel width worked**, and
  made an 18-page × 4-width sweep one call instead of 72.

### Open

- **`account/` is gitignored build output.** It is not in the repo, so a
  worktree does not have it, and `make-zip.sh` picks it up only because
  `zip`/the Python fallback walk the directory rather than git. **Copy it
  in, or rebuild it, before packaging** — otherwise the archive ships with
  no customer portal and nothing warns you.
- Persian still has not had a native review; that caveat stands.
- Ultimate Max is still `isActive = false` / `isPurchasable = true` and
  still absent from the site. Owner decision, unchanged.
- The display faces the design was drawn with (Bricolage Grotesque,
  Instrument Sans, Martian Mono) are **not vendored** and are not linked
  from Google Fonts — that would be a third-party request on exactly the
  networks this product exists for. The stacks fall back to the
  self-hosted Vazirmatn plus the platform UI and mono faces. To adopt them
  properly, vendor the woff2 files into `assets/fonts/` and put the family
  first in the three custom properties at the top of `site.css`; the
  comment there says so.

### Follow-up the same day: the display faces are now vendored

The first pass shipped without Bricolage Grotesque / Instrument Sans /
Martian Mono, on the grounds that linking Google Fonts is a third-party
request on exactly the networks this product exists for. That reasoning
was right and the conclusion was wrong: the answer is to **self-host
them**, which keeps both the design and the rule. Done.

All three are SIL OFL 1.1 — checked per font rather than assumed, and
each licence now ships beside the file. Keep `--name-IDs=0,1,2,3,4,5,6,13,14`
in the subsetting step: pyftsubset drops name records by default, and 0,
13 and 14 are the copyright and licence the OFL requires to travel with
the font.

**Per-page weight is what matters, not the total on disk.** The three
files are 156 KB, but no page loads all four faces:

| | before | after |
|---|---|---|
| English page | 109 KB | 156 KB (+47) |
| Persian page | 109 KB | 125 KB (+16) |

Two measurements drove that, and both were invisible until the network
panel was open:

- **An English page was downloading Vazirmatn.** The two Persian letters
  «فا» in the language switch pulled the entire 111 KB Persian face —
  40% of the page's font weight, for two glyphs. `html[lang="en"]
  .lang-switch__opt[lang="fa"]` now uses the platform's Arabic font.
- **A Persian page was downloading Bricolage.** The concept keeps prices
  and the marquee in the Latin display face, which reads well and costs
  110 KB on every Persian page for an aria-hidden marquee and three price
  figures. Persian now renders those in Vazirmatn. 235 KB → 125 KB.

**Axis pinning is most of the subsetting saving**, more than the character
subset: Instrument Sans 60 → 30 KB and Martian Mono 37 → 16 KB, purely by
pinning `wdth`, which the stylesheet never varies. Bricolage keeps `opsz`
and `wdth` because varying them is the entire reason the design chose it.

**The font swap moved the page 84px and the fix had to be measured.**
Bricolage at `wdth 92` is about 13% narrower than Segoe UI, so the hero
headline wrapped to an extra line in the fallback and pushed everything
below it down 83px. Fixed with metric-matched fallback `@font-face` rules
that load no file (`size-adjust: 87%` and `103.5%`, ascent/descent from
each font's own hhea, ratios measured on a canvas). Above-the-fold shift
is now **0px in both locales**.

One related trap worth remembering: **a `ch` measure rewraps on font
swap by definition**, because `ch` is the advance of "0" in the *current*
font. `.lede` was `max-width: 46ch` and contributed 26px of the jump on
its own. It is `rem` now. Everything below the fold keeps its `ch`
measure — better typography, and nothing visible moves down there.

**Regenerating.** `python3 scripts/make-fonts.py --check` re-derives the
character inventory from the rendered pages and says whether the shipped
subset still covers it; without `--check` it rebuilds. **Run the check
after any copy change**, because a missing glyph does not break anything
— it falls through to the platform font and looks subtly wrong in one
place, which is the kind of fault that survives for months. Neither the
script nor `scripts/fonts-unicodes.txt` ships; `scripts/` is excluded
from the archive.

Deploy archive is now **751 KB** (was 584 KB), 78 entries.

## 2026-08-24 — the fire-and-forget UDP leak is closed in source, and the WFP filter that was going to close it cannot

**Status:** in flight — in source and unit-tested, **never run on a rig**
**Touches:** `apps/desktop-windows/service/src/split_tunnel/owner.rs`,
`.../redirect.rs`, on branch `claude/fix-udp-fire-and-forget-leak`
(off `main` at `522299e`, pushed, not merged)

This is the leak the 0928 entry measured and wrote into the `None =>`
arm of `decide`. It is **not** the leave-alone-cache leak on
`claude/split-tunnel-direct-cache-destination`; that one is separate,
still unmerged, and untouched by this.

### The mechanism, unchanged from what was measured

A UDP socket closed microseconds after its send is already out of the
Windows UDP endpoint table by the time the redirect loop is handed the
datagram. `image_for_new_connection` rebuilds and finds no row, because
there is no row — the fact is gone, not late. In `OnlySelected` an
unknown owner meant "leave it alone", so a **selected** application's
datagram left in clear text from the customer's own address while the
app reported Custom mode on. 13 of 15 unredirected in one rig run, 14 of
15 in the next.

Nothing above is new. What follows is.

### The B2 filter cannot be built, and the reason is ordering, not attribution

The recorded direction was a user-mode WFP BLOCK at
`FWPM_LAYER_ALE_AUTH_CONNECT_V4` keyed on `FWPM_CONDITION_ALE_APP_ID`,
because the kernel classifies there inside the sending process where the
owner is the caller rather than a lookup. **The attribution argument is
right and the filter is still not buildable.**

`ALE_AUTH_CONNECT_V4` is classified when the flow is established, which
is *before* the packet reaches the network layer where WinDivert's
callout sits and where this loop rewrites it. A BLOCK there does not
hand the loop a datagram to refuse — `sendto` fails and **no packet is
produced at all**. So the filter cannot carry a selected app's traffic
into the relay; it can only stop it.

And it cannot be narrowed to just the leaking sends. At that layer a
selected app's fire-and-forget datagram and its QUIC handshake are the
same app id, the same protocol and the same kind of destination. Every
field ALE can condition on is identical for the two, because the
difference between them is not a property of the send at all — it is
whether a *later* lookup will still find the socket open, which nothing
at connect time knows. The filter would have to block both, turning a
partial leak into a **total outage of the selected application's UDP**,
including the Chrome 219-plaintext-datagrams-to-0 case that already
works today.

The 0928 comment ended "what is missing is the decision about what such
a filter should do with a datagram it cannot hand to the relay". That
was the right question and it has an answer, and the answer kills the
proposal: there is no such thing as "a datagram it cannot hand to the
relay" at that layer, because the filter sees *all* of them and can tell
none of them apart.

So B2 should come off the roadmap in the form it is written in.
`engines/ipv6_block.rs` stays the right shape for what *it* does — a
whole family, for a full tunnel, where there is no redirect downstream
to starve.

### What was built instead

`Selection::verdict_for_unattributed` replaces the
`tunnel_when_owner_unknown()` boolean with three answers — Carry, Leave
alone, **Refuse** — and refuses this one case. WinDivert is the callout
driver this service already loads; it sees the datagram *after* the
send, with the owner lookup's answer in hand, and can drop exactly the
one that has no answer. The teardown guarantee a dynamic WFP session
would have given is already there: the filter lives in the driver only
while the handle is open, and closing the last handle removes it whether
or not any code of ours ran. **No second kill-switch-shaped object was
added to the filtering table**, which was a deliberate call — a leftover
block is the leftover-state failure customers already report as a broken
network needing a reset and an uninstall.

**This inverts the feature's usual trade and that is the point.**
Everywhere else an unanswerable question fails open, because unprotected
traffic beats a stalled application. Here failing open *is* the leak.

Scoped as narrowly as the evidence allows, and each clause is load
bearing:

- `AllExcept` untouched — it carries an unknown owner and has no leak of
  this shape.
- **TCP untouched.** A TCP socket cannot be gone before its SYN is
  classified; it has to stay open to receive the handshake.
- **Only destinations that are the internet.** Loopback, RFC1918,
  link-local, multicast and broadcast are left alone, because refusing
  them closes no leak and would break mDNS, LLMNR, SSDP, WS-Discovery
  and DHCP — one-shot senders every one, which is exactly the shape that
  would be caught.
- **Only an owner that could not be found at all.** A live socket is in
  the table from the moment it is created, so QUIC, games and every
  long-running connection are attributed and decided on their merits and
  never reach this arm.

**The honest cost:** an *unselected* application's one-shot UDP to the
internet is refused while Custom mode is on. That is a real behavioural
change. The alternative is that the identical datagram from a selected
app leaves in the clear, and this loop cannot tell the two apart.

The refusal deliberately runs **after** the DNS branch. A lookup is
carried whoever made it, and carrying an unattributable one is strictly
better than swallowing it — same protection, and the page still loads.

The IPv6 arm got the same answer, and **that half is reasoned, not
measured** — the rig run was IPv4. It is worth doing anyway because a
selected app's IPv6 is already dropped deliberately, so refusing takes
nothing further from it; the only new cost is an unselected app's
one-shot v6 UDP. `ParsedV6` now carries the destination address so the
rule and the kernel filter cannot drift into disagreeing about one
address.

New counter `refused_unattributed` in the loop's summary line, both
families. A v6 refusal is also counted in `blocked_v6` so that number
stays the whole count of v6 packets swallowed. It is deliberately **not**
read by `Stats::complaint`, for the reason `blocked_v6` is not: it
counts a refusal working as designed, and a warning that is always on is
one nobody reads when it matters.

### What is proven: nothing about a machine

`cargo check --workspace --all-targets` clean and `cargo test
--workspace` green — 152 in the service crate, 145 before. Seven new
tests, and **all four guards were checked by mutation rather than
asserted**, which is the only reason to believe any of them:

| mutation | what failed |
|---|---|
| decision reverted to the old fail-open | 4 tests; `left: Direct right: Drop`, and the v6 packet `got None` |
| refusal moved ahead of the DNS branch | the ordering test |
| local-network guard removed | `127.0.0.1 is the local network, not the internet` |
| transport guard removed | both TCP tests, `left: Drop right: Direct` |

That is table logic. It says nothing whatsoever about whether the leak
is gone on a machine.

### The rig procedure that would settle it

Needs a Windows guest with WinDivert loaded, a tunnel up, Custom mode on
in **OnlySelected** with one app selected, and a capture taken **on the
host side of the guest's vNIC** — outside anything the client can
influence. Counters do not count; this file already records that exit
codes and "no error was thrown" have produced false passes here.

1. **Build the sender.** A small program that opens a UDP socket, sends
   one datagram to a public address, and closes the socket immediately —
   15 times, 15 sockets. This is the program that produced 13/15 and
   14/15. Put it at a known path.
2. **Baseline, before.** Select that program. Connect. Run it. In the
   capture, count datagrams to the target address arriving **from the
   guest's own LAN address**. On 0.9.31 this is 13 or 14 of 15. Record
   the number; a run that shows 0 here has not reproduced the bug and
   proves nothing about the fix.
3. **After.** Same guest, same selection, service built from this
   branch. Expect **0** plaintext datagrams at the vNIC, and
   `refused_unattributed` in the custom-mode log to be non-zero. Both,
   not either: a zero count with a zero counter means the sender did not
   run.
4. **The scoping test, which is the one that can go wrong.** This is the
   `curl.exe`-and-a-copy-of-curl experiment from the IPv6 work, in the
   other direction. With the same session live:
   - a **selected** app's ordinary QUIC (a browser, a real page load)
     must still be carried — `matched`/`redirected` climbing, exit IP
     the node's;
   - an **unselected** app's ordinary TCP and its long-lived UDP must be
     untouched — full speed, real IP, nothing in `refused_unattributed`
     attributable to it;
   - the LAN must still work: `ping` the router, browse an SMB share,
     find a network printer, and confirm mDNS/SSDP still resolve. If any
     of this breaks, the destination guard is wrong and the fix is worse
     than the leak.
5. **The second-handle check, which is the only honest one.** Open a
   second WinDivert handle *below* this loop's priority (`prio -1000`),
   as `live_custom_mode_blocks_ipv6_and_keeps_carrying_ipv4` does, and
   confirm it sees **none** of the fire-and-forget datagrams surviving
   the loop. The counter reports intent; this reports what got past.
6. **Teardown.** Disconnect, then confirm the machine's networking is
   whole: `netsh wfp show filters` shows no Neoxify objects, one-shot
   UDP works again, and the sender from step 1 puts all 15 datagrams on
   the wire. Nothing this change adds is supposed to survive the
   session.

The IPv6 half of step 3 needs a dual-stack guest and has the same shape:
run the sender over IPv6 and expect 0 at the vNIC.

### Open, and one of them is the owner's

1. **Nothing has run on a rig.** Everything above is source and unit
   tests.
2. **The customer is not told.** The IPv6 gap is stated in words on the
   dashboard (`dash.customActive`); this gap is not stated anywhere. It
   should probably get the same treatment, but that is an i18n string
   across every language and a UI file another session is holding, so it
   was deliberately not touched here.
3. **B2 needs removing from the roadmap** in the form it is written in,
   with the ordering reason above kept — otherwise somebody spends a
   week rediscovering it.
4. A real kill switch — blocking a selected app's traffic when the
   redirect loop is *not* running while the app claims Custom mode is on
   — is a separate feature and genuinely is WFP-shaped. The watchdog
   currently stops interception and tells the UI, which is honest but is
   not a kill switch. Not built, not in scope, worth its own decision.

## 2026-08-24 — the leave-alone cache never looked at where the packet was going

**Status:** in flight — in source and unit-tested, **never run on a rig**
**Touches:** `apps/desktop-windows/service/src/split_tunnel/flows.rs`,
`.../redirect.rs`, on branch
`claude/split-tunnel-direct-cache-destination` (not merged)

**This is not the leak the 0928 entry wrote down, and that one is still
open.** The fire-and-forget gap recorded at the `None =>` arm in
`redirect.rs` — socket closed microseconds after the send, no row in the
UDP endpoint table, no owner, so `OnlySelected` leaves it alone — is
untouched by this and still needs B2. What follows is a *second*
mechanism in the same decision path, found by reading rather than by
capture, and it does not need the owner lookup to fail at all.

`Tables.direct` was keyed on `(transport, source port)`. `Nat::lookup`
consults it before anything else, so a Direct verdict recorded about one
peer answered for **every destination that port reached** for the next
five seconds. TCP never showed it: a TCP port changes destination by
sending a SYN, a SYN skips this cache on purpose, and `Nat::redirect`
clears the entry. UDP has no SYN and nothing else re-decides.

Two of the three places that record a verdict make that a leak rather
than a curiosity:

- **The `if known_owner` arm.** `decide` carries a DNS query through the
  tunnel whoever makes it, and drops one it cannot carry rather than
  hand it to the resolver the network supplied. None of that ran when
  the cache answered first — and any port left alone in the previous
  five seconds made it answer first. The query left in the clear, past
  a rule written specifically to stop that.
- **The out-of-synthetic-ports fail-open**, which is reached from a
  *selected* app. Failing open on the flow that could not be carried is
  the intended trade; what was recorded was the whole port, so one
  exhausted moment exempted every destination that port used next.
  `expire_idle` frees ports continuously, so the exemption routinely
  outlived the shortage that caused it.

The fix keys the cache on the flow — the same lesson `forward` was built
on and which this field one line down did not get. Hot path unchanged in
shape: one hash lookup per packet, wider key. A miss for a socket that
is still open costs a lookup in the owner snapshot the loop already
holds, not a table walk, because `image_for_new_connection` only forces
a rebuild when the port is *absent* from the snapshot. A flow-keyed
table can outgrow the port space, so it is capped; overflow forgets
verdicts, which costs a re-decision and cannot leak.

**What is proven: nothing about a machine.** Six unit tests, three of
which fail against the old key and pass against the new one, including
one end to end through `decide`. That is table logic. `cargo test
--workspace` is green (151 in the service crate) and `cargo check
--workspace --all-targets`, which is what CI runs, passes.

**What a rig has to do**, and until it does this entry claims nothing
else:

1. Custom mode, one app selected, WinDivert loaded, capture at the vNIC.
2. From the selected app, one UDP socket, datagram to an ordinary
   destination, then a DNS query from the same socket inside five
   seconds. The query must not appear in clear text.
3. The exhaustion path is the harder one to stage — it needs the
   synthetic port range full — and has not been thought through as a
   rig procedure yet.

**Gotcha, and it cost real time:** another session was checking branches
in and out of this same working tree while I worked. A commit I made on
my own branch landed on `claude/gaming-mode`, because HEAD had moved
under me between `checkout -b` and `commit`. Recovered with `branch -f`
(nothing of theirs was lost — that branch had no commits of its own),
but **verify `git branch --show-current` immediately before every commit
in this repo**, or work in a `git worktree`. This is the same class as
the journal-conflict note: two sessions on one machine, not two
machines.

## 2026-08-24 — Four latency defects in the split-tunnel relay, fixed but unproven

**Status:** landed on `claude/split-tunnel-latency`, **nothing verified
on the wire** — the rig VM was being rebuilt
**Touches:** `apps/desktop-windows/service/src/split_tunnel/{proxy.rs,redirect.rs,mod.rs}`

Found by a research pass framed around gamers; all four hit every user.
Each was located in source, none is speculative. One commit per item.

1. **No `TCP_NODELAY` anywhere.** Zero hits for `nodelay` across the
   service, agent and tauri source, so both sockets a relayed connection
   crosses ran Nagled. Two Nagles in series against a peer using delayed
   ACK is up to 200ms on Windows, 40ms on Linux, on exactly the traffic
   made of small writes. Set in `pump`, both halves. The probe socket is
   deliberately left alone — it writes zero bytes, so the option would
   change nothing.
2. **UDP head-of-line blocking.** `serve_udp` called
   `bind_upstream_retrying` inline, so one new flow that could not bind
   froze *every* UDP flow on the machine for up to six seconds — and the
   condition that makes a bind fail is a tentative tunnel address, i.e.
   the seconds after a connect or a failover. The freeze landed exactly
   when the customer was already watching. Measured 5.83s in a test with
   the retry put back on the loop. Now: one inline bind attempt, then a
   per-flow setup thread. 0.9.20 is intact — datagrams are held, not
   dropped, and sent in the order they arrived.
3. **Packet reordering by design.** Both workers received from the
   shared handle with no flow affinity, which the WORKERS comment
   admitted. Now one dispatcher receives, in driver order, and hashes
   the 5-tuple to a worker.
4. **Silent UDP send failures.** `let _ = upstream.send_to(..)`. Now
   three counters — `udp_send_failed`, `udp_reply_failed`,
   `udp_unbound` — in `Stats`, logged and rate limited. Behaviour on
   failure is unchanged; only the silence is.

`Stats` is now created in `mod.rs` and shared by the relay and the
redirect loop, because the relay starts first — the firewall allowance
and the reachability wait sit between the two.

### The rig experiments these need

Nothing below has been run. `cargo test --workspace` passing means the
logic holds against loopback and synthetic packets; none of it says a
packet went anywhere.

- **Nagle.** A selected app talking to a listener on the node that
  echoes small writes. Capture on the node. Compare the inter-arrival
  gaps of a request/response ping-pong at 10/s, before and after. Fixed
  looks like the 40ms/200ms mode disappearing from the histogram, not
  like a lower mean.
- **UDP freeze (the important one).** Hold a UDP flow live — `iperf3 -u`
  at a low rate, or a game sitting in a match — then **force the
  tentative-address window**: connect, or trigger a failover by stopping
  the active engine while Custom mode is on. Both bring up a fresh TUN
  whose address is under duplicate address detection, which is the only
  thing that makes the bind fail. Measure the *established* flow's
  datagram gap across that moment, from a capture at the node rather
  than from the client. Fixed = no gap above ~100ms. Broken = a gap of
  up to 6s. "Nobody complained" is not the measurement.
- **Ordering.** `iperf3 -u` through a selected app and read the
  receiver's out-of-order count at the node. Worth also capturing a real
  game's UDP flow and checking its sequence numbers arrive monotonic.
- **Throughput cost of the dispatcher.** The one thing this change could
  plausibly make *worse*: one thread now receives every packet, and each
  packet gets a copy and a channel hop. Measure with a saturating TCP
  transfer through a selected app, before and after, watching `seen` per
  second. If the dispatcher turns out to be the ceiling, the answer is a
  buffer pool and a deeper queue — not going back to two receivers,
  which is what reordered packets in the first place.
- **The counters.** Read `udp_send_failed` / `udp_reply_failed` /
  `udp_unbound` against a capture before letting `Stats::complaint` ever
  speak on their behalf. They are deliberately not consulted by it yet,
  for the same reason `escaped` is not.

### Gotchas worth keeping

- Two tests binding the same synthetic port collided under the parallel
  test runner, because every `Nat` starts allocating from the same
  number. With `SO_REUSEADDR` both binds succeed and Windows delivers
  replies to whichever socket it likes — a test that passes or fails on
  the scheduler. `udp_flow` now binds exclusively and takes another flow
  if the port is already held.
- `0.0.0.0:9` fails `sendto` with WSAEADDRNOTAVAIL every time, and an
  address in `203.0.113.0/24` fails `bind` the same way. Both are good
  deterministic stand-ins for failures that otherwise need a live
  tunnel — the second reproduces the tentative-address condition without
  a driver, a tunnel or elevation.
- The dispatcher is joined **before** the workers: a worker ends only
  when the dispatcher drops its end of the queue, so the other order
  would hang the teardown.
## 2026-08-23 — "Repair my network", on branch `claude/repair-my-network`

**Status:** built and compiling; the elevated behaviour is UNVERIFIED
**Touches:** `apps/desktop-windows/**` only. Not merged, not pushed.

The in-product escape hatch every mature competitor has and we did not.
Windscribe has `-firewall_off` out of band, Mullvad has
`mullvad-setup.exe reset-firewall`, GearUP has literal "Reset local
network" buttons. Ours is `service/src/engines/repair.rs`, reached two
ways that run the same code:

- **`neoconnect-service.exe repair`** from an elevated prompt. Stops the
  service, does the whole teardown, starts it again, prints per step.
  Exit 0 clean-or-fixed, 1 naming what is not, 2 not elevated.
- **Settings → Repair network**, and a collapsed line in the
  connect-failure message on the dashboard.

Nine steps: tunnel + Custom-mode redirect, orphaned engines, NRPT, our
routes, the split-tunnel firewall rule, WFP filters under our provider,
the WireGuard tunnel service, the RAS entry, DNS cache.

### What is actually proven, and what is not

Proven here: it compiles, `cargo test --workspace` and the desktop
`tsc` / `vite build` / `vitest` are green, and the unelevated run prints
the elevation message and exits 2. **That is all.** Every step's real
behaviour needs elevation, so none of it has been run against a machine
that actually had residue on it. Do not describe this as working.

### The rig test, per step

Take a snapshot first. Then, for each, create the residue and run
`repair`:

- **NRPT** — connect, kill the service with Task Manager (not stop),
  confirm the rule via `Get-DnsClientNrptRule` *and* under
  `HKLM\SYSTEM\...\Dnscache\Parameters\DnsPolicyConfig`. Repair. Both
  must be empty and a name must resolve.
- **Group Policy NRPT** — write a rule of ours by hand under
  `HKLM\SOFTWARE\Policies\Microsoft\Windows NT\DNSClient\DnsPolicyConfig`
  with `Comment = Neoxify tunnel DNS`. `Get-DnsClientNrptRule` will not
  show it; the sweep must still remove it. **Control: put a second key
  there with a different Comment and check it survives.**
- **Orphaned engines** — kill the service while Xray is up, confirm
  `xray.exe` is still running from our resources directory. **Control:
  start a copy of `xray.exe` from somewhere else first and check it
  lives.**
- **Routes** — after the same kill, `Get-NetRoute -InterfaceIndex` on
  `neoconnect0`. Repair, re-check. **Control: the physical adapter's
  default route must still be there** — deleting a destination
  machine-wide is a fault this could cause.
- **WireGuard tunnel service** — `/installtunnelservice`, kill the
  service, confirm `WireGuardTunnel$neoconnect` in `sc query`. Repair.
  Then the harder one: get it into RUNNING-marked-for-delete (install,
  then uninstall immediately) and check `force_remove_tunnel_service`
  reports honestly rather than claiming success.
- **WFP** — this one has never executed. `our_filter_ids` enumerates
  with `providerKey` set, a zeroed `layerKey` and
  `FWP_FILTER_ENUM_FULLY_CONTAINED`; if Windows refuses that
  combination the step reports Unknown, which is honest but useless.
  Check `netsh wfp show filters` for the Neoxify provider before and
  after, and confirm the enumerate call returns 0.
- **RAS entry** — connect over IKEv2, kill the service, confirm
  "Neoxify" is in the Windows VPN list. Repair.
- **Service stop/start** — run `repair` with the service running and
  confirm it comes back (`sc query NeoxifyService`), and again with the
  service already stopped and confirm it is left stopped.

### The one that cannot be tested this way

The split-tunnel redirect loop outliving its tunnel is undone only by
the service process ending or by `disconnect()` running. The
command-line form covers it by stopping the service; the button covers
it because `step_tunnel` calls `disconnect()` first. Neither reaches the
case where the service is wedged *and* refuses to stop — that is still
"restart Windows", and the command says so rather than claiming
otherwise.

### Files another session should know about

`engines/mod.rs` gained exactly one line (`pub(crate) mod repair;`) and
`split_tunnel/firewall.rs` one word (`pub(crate)` on `RULE`). Everything
else is a new module or an additive return value on an existing
teardown. `dns::clear`, `janitor::reconcile` and
`routing::purge_interface` behave exactly as they did.
## 2026-08-23 — B2 is dead; its IPv6 half is not

**Status:** finding recorded + one change landed, unverified on the wire
**Touches:** `apps/desktop-windows/service/src/engines/ipv6_block.rs`,
`split_tunnel/{mod,owner,redirect}.rs`

### B2, as written on the roadmap, cannot work

The proposal was: while Custom mode is on, add user-mode WFP BLOCK
filters keyed on `FWPM_CONDITION_ALE_APP_ID` for each selected app,
refusing their outbound traffic to everything except loopback, LAN and
the relay path — so a flow the WinDivert loop fails to attribute is
**refused instead of leaked**. It would have flipped the failure
direction on the worst outcome this product has.

It is unsound, and structurally rather than fixably so.

`ALE_AUTH_CONNECT_V4` classifies at `connect()` — MS states plainly that
for TCP there is **no packet** at that layer — and for UDP at the first
`sendto` to each new remote tuple. The redirect rewrites the destination
at `FWPM_LAYER_OUTBOUND_IPPACKET_V4`, which is where WinDivert's NETWORK
layer actually registers (there is no `FWPM_LAYER_OUTBOUND_NETWORK_V4`;
that name does not exist in `Fwpmu.h`). MS's documented client-open
order is `ALE_AUTH_CONNECT` → `OUTBOUND_TRANSPORT` → `OUTBOUND_IPPACKET`.
So at ALE, the connection that will be carried and the connection that
will escape are **the same event**: selected app, public destination.

And there is nowhere else to look. `ALE_APP_ID` is a filtering
condition only at the ALE layers; `FWPS_METADATA_FIELD_PROCESS_ID` is
callout metadata, never a `FWPM_CONDITION_*`, so **user mode cannot key
on PID at any layer at all**; `OUTBOUND_TRANSPORT` has neither. Every
layer that knows *who* runs before the rewrite; every layer that sees
the rewrite has forgotten who. `ALE_FLOW_ESTABLISHED` has both
`ALE_APP_ID` and `IP_REMOTE_ADDRESS` and is the tease — MS says a filter
there "should not return Block or Permit".

**Mullvad and Windscribe confirm it from the other side.** Both redirect
at `ALE_BIND_REDIRECT` / `ALE_CONNECT_REDIRECT` with a signed kernel
callout that rewrites the **local** address, which is why their block
filters can key on local address (Mullvad, `IP_LOCAL_ADDRESS == tunnel
IP`) or local interface LUID (Windscribe) and never on the remote one.
Neither ships user-mode-only per-app splitting; both hard-fail the
feature if their driver is not running. Our loop deliberately leaves the
source address alone — the module header says why — so we do not even
have the discriminator they built the design around.

Two variants died with it. **(a) activation-window blocking** is worse
than redundant: 0.9.28's grace drop already covers *mid-connection*
packets only, and new connections in that window are exactly what
`image_for_new_connection` gets right — an ALE block there would refuse
the flows the loop is handling correctly. **(b) fail-closed on detach**
is technically expressible (nothing is being carried at that point, so
nothing is confusable) but it is a reversal of the stated fail-open
policy, not an engineering question. Left for a product decision.

Worth knowing while that decision is open: `detach_tunnel()` is called
only when a *child* engine process exits. The WireGuard arm of
`Engines::status` clears `self.active` without it, so a WireGuard tunnel
that dies leaves Custom mode still pinning to an interface index that no
longer exists. Neither behaviour has been measured; both should be,
together, if (b) is ever picked up.

### The IPv6 half survives, and it is now in

`SelectedAppsIpv6Block` in `engines/ipv6_block.rs`. Sound for exactly
one reason: **no IPv6 is ever redirected**, so a block has nothing to be
confused with.

What it closes is the v6 form of the gap the 0928 entry called *not
fixable by asking harder*: the loop's v6 block still has to attribute a
packet through the endpoint tables, and in `OnlySelected` an unknown
owner means *leave alone*. A socket closed microseconds after its send,
or younger than the 20ms snapshot, therefore leaks v6 in clear text with
every counter reading healthy. ALE has no lookup to lose — the kernel
classifies in the calling thread, inside the sending process.

Shape, and each clause is deliberate:

- `ALE_AUTH_CONNECT_V6` only. Outbound only, because the loop is.
- `OnlySelected` only. In `AllExcept` the loop already answers *block*
  for an unknown owner, so the hole does not exist, and the WFP shape
  there would be machine-wide-with-holes.
- Every filter carries an `ALE_APP_ID` condition, permits included, so
  the sublayer says nothing about any other program.
- **`::/64` is permitted and that is load-bearing.** A dual-stack
  socket's IPv4 classifies at the *V6* layer with an IPv4-mapped address
  (`::ffff:a.b.c.d`). Without that permit this refuses a selected app's
  IPv4 — i.e. breaks Custom mode outright, only on machines that have
  IPv6.
- Rebuilt on `set_selection`, because the list is editable live and the
  loop reads it per packet while filters do not. Deselecting an app must
  give it its IPv6 back without a reconnect.

Reuses 0.9.28's dynamic session, provider and one-transaction install,
so the crash guarantee is the same one already proven by `taskkill /F`.

`blocked_v6` in the redirect log **will read lower** on a session where
these installed. That is the refusal happening a layer up, not a
regression; the counter's doc comment now says so.

### What has NOT been proven

Nothing here has touched a wire. Specifically:

1. The `FwpmFilterAdd0` acceptance test —
   `wfp_accepts_the_per_app_filter_set_then_it_is_aborted` — **skipped**
   on the dev box: `FwpmTransactionBegin0` returns `0x5`, needs admin.
   It has never once run. Run it elevated before believing any of this:
   `cargo test -p neoconnect-service --bin neoconnect-service ipv6_block`
   from an Administrator shell, and check the output does not say
   "skipped".
2. The wire test, on `Neoxify-Test2` from `pre-verify3`, host-side pcap:
   select `curl.exe`, Custom mode on, dual-stack guest. (i) a selected
   app's v6 to a public address produces **zero** clear-text packets and
   `connect()` fails immediately rather than hanging; (ii) a *second,
   unselected* copy of the same binary at another path still reaches the
   same v6 address — the scope control, the same one the 0.9.27 v6 work
   used; (iii) **the IPv4-mapped case**: the selected app's ordinary
   IPv4 still exits at the node. That third one is what catches a
   missing `::/64` and it must not be skipped. (iv) `netsh wfp show
   filters` shows the `Neoxify Custom-mode IPv6 block` sublayer appear
   on activation and go on `taskkill /F`. (v) deselect the app while
   connected and confirm its IPv6 comes back without a reconnect.
3. Whether the fire-and-forget shape leaks over v6 at all was never
   measured — it was measured over v4 (13–14 of 15) and inferred here.
   The fix is right either way, but do not quote a v6 number nobody took.

### What this means for B1

It strengthens the case, and it is now the *only* case for the v4 gap.
That gap has **no user-mode-reachable fix** — established now rather
than suspected — and a kernel callout at `ALE_CONNECT_REDIRECT` is what
buys the two things missing: attribution in the sending process at
connect time, and the local-address rewrite that makes fail-closed
filters expressible at all. EV cert plus Partner Center attestation
signing is the price of the whole category, not of one bug.

**Before paying it, one cheaper thing is worth a spike.** WinDivert's
`WINDIVERT_LAYER_SOCKET` — already in the driver we ship, already in
`windivert-sys` 0.9.3 — delivers `SocketBind` / `SocketConnect` /
`SocketClose` events carrying **`process_id`, local port and protocol**,
and WinDivert implements that layer on `ALE_RESOURCE_ASSIGNMENT` /
`ALE_AUTH_CONNECT`. That is the fact the endpoint-table lookup cannot
get, delivered at socket creation rather than inferred afterwards. A
second handle feeding a port→PID map that `owner.rs` consults ahead of
the tables would sidestep the race with no driver of ours. It does not
give the *rewrite* — only B1 does — but attribution is where every
measured leak in this feature has actually come from. Not started; no
evidence yet beyond the layer table and the struct definition. The
ordering question a spike has to answer first: whether a `SocketBind`
event is reliably queued before the datagram reaches the NETWORK-layer
handle, since the two handles have independent queues.

---

## 2026-08-24 — 0.9.31 integrated; the repair's WFP sweep was broken, and the rig only half-answered

**Status:** **NOT released.** `claude/integration-0931` is built, merged
from all three branches, green by every test this repo runs, and carries
two fixes found by hand and by measurement. Four of the eight rig
experiments came back with an answer; the other four did not run.
**Touches:** `apps/desktop-windows/**`, this file.

### What is in the branch

`claude/integration-0931` off `5c60728`, three `--no-ff` merges in
order: `claude/split-tunnel-latency`, `claude/repair-my-network`,
`claude/selected-apps-ipv6`. Version bumped to 0.9.31 in the four files
that carry it. `cargo check --workspace --all-targets` clean, 212 Rust
tests, `pnpm turbo run lint typecheck build test --force` 16/16 with
0 cached. (`@neoxify/backend#typecheck` fails in a fresh worktree until
`pnpm --filter @neoxify/backend prisma:generate` has been run -- CI does
it as its own step and it is easy to mistake for a real break.)

Git reported conflicts only in this file, plus three in
`split_tunnel/mod.rs` that were additive on both sides (the watchdog
from 0.9.30's orphaned-redirect work alongside `ipv6_apps`, and a
`redirect::start` call whose arity the latency branch had changed).

**The one that merged cleanly and was wrong** is why the audit was done
by hand. `claude/repair-my-network` made
`ipv6_block::{PROVIDER_KEY, SUBLAYER_KEY}` `pub(super)` so the repair
could sweep by them. `claude/selected-apps-ipv6`, on a different branch,
added a **second** sublayer -- `SPLIT_SUBLAYER_KEY`, for the Custom-mode
per-app filters -- under the **same** provider. Neither branch could see
the other. Merged, the repair deleted one sublayer and then tried to
deregister the provider, which refuses while anything still references
it: a stuck Custom-mode sublayer would have pinned the provider on every
future repair and never been removed itself. Fixed by sweeping both.

### The rig, and what it cost

`Neoxify-Test2`, restored from `clean-base`. Three protocols would not
connect on this guest and this is **not** a finding about the product:
OpenVPN failed with "tapctl returned nothing", IKEv2 and Xray/REALITY
both with "powershell did not finish within 15s" -- the service's own
internal timeouts firing on a CPU-starved guest. **WireGuard connected
and its exit IP was the node** (38.60.249.229, DE), so every experiment
below ran over a tunnel proven to carry a selected app's traffic before
anything was measured.

The guest then wedged repeatedly: two heartbeat flatlines, one guest
bugcheck (`0x133`, DPC_WATCHDOG_VIOLATION), and long spells where
`VBoxManage guestcontrol` answered every request with "current status
is: starting" while the desktop painted normally.

Three things learned about the rig, each of which cost an hour:

- **The guest needs 10-15 minutes undisturbed after boot before
  `guestcontrol` works**, and **polling it during that window jams the
  guest-control service for good.** Every readiness loop made it worse.
  Boot, wait, probe once.
- **`VBoxManage startvm` can report success and leave the VM powered
  off.** Killing `VBoxHeadless`, `VirtualBoxVM` and `VBoxSVC` clears it;
  nothing else did.
- **The elevated runner dies on its own**, silently, leaving nothing in
  `runner2-log.txt`. It does not need the Win+R/UAC dance to come back:
  it registers itself as a logon task at RunLevel Highest, and
  *starting* an already-registered task is permitted from the filtered
  token even though *registering* one is not (`Register-ScheduledTask`
  answers "Access is denied"). `kick.py` on the share does exactly that.

**Defender did flag the unsigned installer, once.** Six installs of the
same bytes produced nothing; the seventh logged threat `2147731849`
against `C:\Users\Public\nx31-setup.exe`. The install still finished --
exit 0, the app reports 0.9.31 -- so what it caught was the copy on
disk, after the fact. No exclusion was added. It is an ML detection and
it is not deterministic, which is worth knowing before anyone concludes
from one clean install that customers will not see it.

### What the rig proved

**The UDP failure counters move, and only when a send really fails.**
Zero across every interval of two full Custom-mode sessions. Then the
WireGuard tunnel service was stopped underneath a live 20 Hz flow and
they went to 45 and then 55, with a named line beside them:
`relay could not send a datagram to 1.1.1.1:53: The requested address is
not valid in its context. (os error 10049)`. `udp_reply_failed` and
`udp_unbound` stayed zero, which is the right answer -- nothing
exercised those two. Evidence: `L2-v31-split-final.log`,
`L2-v31b-split-final.log`.

**No head-of-line stall across a reconnect on 0.9.31.** One 20 Hz UDP
flow, tunnel torn down and brought back 15s in, eight fresh flows
started into the tentative-address window. 1198 of 1200 datagrams
answered; largest reply gap 1044 ms, with a 1090 ms gap in the *send*
column at the same sequence number -- this guest descheduling the probe,
not the relay stalling. **The undisturbed baseline run was worse** (981
ms largest reply gap, median RTT 163 ms against 37 ms), which is the
honest reading: on four vCPUs under a busy host the noise floor is about
a second, so this instrument cannot resolve the 100 ms threshold. It can
resolve the 5.83 s the unit test measured, and nothing of that size is
there. Evidence: `L1-v31-steady.txt`, `L1-v31base-steady.txt`,
`L1-v31.pcapng`.

**Small writes leave the relay one segment at a time.** Forty 11-byte
writes, the probe's own Nagle off -- with it on the writes coalesce in
the *probe's* buffer and the relay never makes a small write at all,
which is what the first two attempts measured and why they proved
nothing. On the relay's upstream leg, captured with `pktmon` before
WireGuard encapsulates it: 32 distinct segments each carrying an 11-byte
payload, median 0.3 ms apart, max 34.8 ms -- tracking the writes rather
than the ~180 ms round trip a Nagled socket would impose. Evidence:
`L2-v31c-tcp.txt`, `L2-v31c.pcapng`.

**A selected app's IPv6 does not reach the wire, and its IPv4 still
exits at the node.** Custom mode on, `OnlySelected`, one selected app.
Three readings off one capture, using a different destination address
per phase so they cannot be confused:

| what | destination | packets on the wire |
|---|---|---|
| control -- selected app, Custom mode **off** | `2606:4700:4700::1001` / `2001:4860:4860::8844` | **20 / 4** |
| the claim -- selected app, Custom mode **on** | `2606:4700:4700::1111` / `2001:4860:4860::8888` | **0 / 0** |
| unselected app (second copy, different path) | `2620:fe::fe` / `2620:fe::9` | **25 / 0** |

The control is the half that could have failed and did not: the same
binary, doing the same thing a minute earlier with the block off, put
its IPv6 on the wire and got answers. The service's own log agrees --
`installed: 6 filters for 1 app(s) in a dynamic session, provider
Neoxify, sublayer Neoxify Custom-mode IPv6 block` -- and the redirect
loop's `blocked_v6` moved from 0 to 5, which is the UDP half the ALE
filters do not catch being stopped a layer down.

**And the check that catches a missing `::/64` permit passed**: the
selected app's own IPv4 exit, asked by that executable rather than by
curl, was `{"ip":"38.60.249.229","country":"DE"}` both while the v6 was
being refused and again after it. Evidence: `V1-v31.txt`,
`V1-v31b.pcap`, `V1-v31-ipv6-block-custom.log`,
`V1-v31-split-tunnel.log`.

**One thing in that table is not explained.** The unselected app's TCP
v6 went out untouched, 25 packets, which is the answer that matters --
but its UDP destination shows zero, and the selected app's control UDP
in the same run shows four. Either something stopped an unselected
app's UDP v6, which would be a real bug, or that particular Quad9
address behaved differently on this guest. `blocked_v6` reaching exactly
5 accounts for the *selected* app's five datagrams and leaves none for
the unselected one, which argues for the second reading -- but it is an
argument, not a measurement. One targeted run settles it and it has not
been done.

### What the rig disproved

**The repair's WFP sweep does not work, and never has.** This is the
step the branch's own entry flagged as never having executed once. On a
machine carrying eight of our filters -- `netsh wfp show filters` listed
them in the same breath -- the repair reported

    [????] Windows Filtering Platform filters -- the filtering platform
           would not list filters under our provider

and exited **1**, not 0. Every other step passed against residue built
by connecting and then killing the service: the tunnel torn down, the
NRPT rule removed **from the GPO registry path the cmdlets do not
report**, the firewall rule gone, the stranded WireGuard tunnel service
gone, the DNS cache flushed. The foreign `xray.exe` outside the install
directory **survived** -- and that only became a control on the second
attempt, because the first pointed it at a config that does not exist,
so it exited within seconds and "the repair killed it" and "it was never
going to survive" looked identical.

Three readings of the source found nothing, because the error code was
being thrown away. Adding it to the message answered it in one run:
`FwpmFilterCreateEnumHandle0` returns **`0x80320004`,
FWP_E_LAYER_NOT_FOUND**. The enumeration passed a template carrying our
provider key and a zeroed `layerKey`, on the assumption that a NULL GUID
means "every layer"; `FWP_FILTER_ENUM_FULLY_CONTAINED` needs a real
layer to be contained *in*. Fixed by enumerating every filter and
comparing the provider here, which is also the more honest sweep: the
objects this step exists to find were installed by a *previous* build,
at whatever layers that build used.

**That fix is still not verified.** Two attempts: the first bugchecked
the guest, the second got a tunnel up whose exit IP was the machine's
own address rather than the node, aborted on that assertion as it should
have, and then the guest wedged. The repair itself never ran against the
fixed binary.

**Flow affinity is not demonstrated.** A single 300-datagram UDP flow,
sent under twelve concurrent flows, arrives at the relay's upstream leg
with 11-15 out-of-order steps per run, reproducibly, across three runs.
Every datagram was captured exactly twice and the count is identical
whether ordered by first or last sighting, so it is not a capture
artefact. What it does not establish is the cause: that leg is the
relay's own single-threaded send loop, so either the dispatcher handed
the packets over out of order -- which is what affinity was meant to
stop -- or Windows reordered them below the socket. **The 0.9.30
control, the only thing that separates those two, did not run.**

### What did not run at all

- The **0.9.30 control** for head-of-line, TCP_NODELAY and flow
  affinity. Without it, three of the four latency claims are measured
  but not attributed.
- **Re-verification of the WFP fix**, twice attempted.
- The one unexplained cell in the IPv6 table above.

Everything needed is on the share and scripted: `V1.ps1`, `R1.ps1`
(which copies an instrumented service over the installed one), `L1.ps1`,
`L2.ps1`, the probe `nxlat.cs` with modes `udpsteady udpburst tcpsmall
udporder udpload v6 get4`, `d31.py`/`seq31.py` to drive a phase with a
NIC capture, `kick.py` to bring the runner back, and `latstat.py` /
`pcapng31.py` to read the results. Both installers are staged as
`nx31-setup.exe` and `nx30-setup.exe`.

### Why 0.9.31 was not cut

Two named pass criteria failed on the code as merged -- the repair's
exit code and its WFP sweep -- and the fix for them has not run on
hardware. Three of the four latency claims have no control, and one of
those three (flow affinity) has a measurement pointing the wrong way
that only the control can attribute. A release now would be a release on
reasoning, and this product's whole history is findings that only
appeared under execution.

What is ready to go the moment a rig will stay up: the branch, the
scripts, and one clean pass of `R1` plus `L1`/`L2` against 0.9.30.

---

## 2026-08-24 (later) — the WFP sweep's root cause named; the elevated run still did not happen

**Status:** `claude/repair-wfp-sweep-0931`, off `claude/integration-0931`
at `71c672d`, pushed. **0.9.31 still not cut.** **Touches:**
`apps/desktop-windows/service/src/engines/repair.rs`, this file.

### The zeroed `layerKey`, stated properly

The previous entry recorded *that* a zeroed `layerKey` makes
`FwpmFilterCreateEnumHandle0` answer `FWP_E_LAYER_NOT_FOUND`, and the fix
that followed is right. What it did not record is **why the mistake was
available to make**, which is the part that will otherwise be made again.

It is not that a field was forgotten. In `FWPM_FILTER_ENUM_TEMPLATE0` two
fields sit one line apart, look alike, and are not alike:

    providerKey: *mut GUID   <- a pointer. NULL is "any provider".
    layerKey:    GUID        <- by value. There is no "absent".

A nullable pointer can encode "unspecified"; a by-value GUID cannot. The
all-zero `layerKey` that `mem::zeroed()` leaves is therefore not a
wildcard but a *specific* GUID naming no layer on the machine — hence
LAYER_NOT_FOUND rather than a match-everything. The original code
generalised the pointer field's rule to the value field directly below
it, and nothing about that is visible at the call site.

This is the same shape as the RAS struct traps already in this file: the
type checks, the size is right, the meaning is wrong. **Read the binding,
not the field name.** Checked against `windows-sys` 0.59, which is what
the service builds with.

### What is proven, and what is not

**Proven, off-machine only:** `cargo check --workspace --all-targets`
clean and `cargo test --workspace` at **213 passed / 0 failed** (212
before; the new one is mine). The provider comparison is now a named
`guid_eq` with a test that was **checked by mutation** — dropping `data4`
from `guid_eq` makes it fail. A test that has never been seen to fail is
not yet a test.

**Not proven, and this is the whole point:** *nothing here has run
elevated on Windows.* The sweep has still never been observed to
enumerate a single filter. A green build is not evidence a WFP
enumeration works, and this file already says exit codes and "no error
was thrown" have produced false passes here.

### The rig, again, and what it cost

`Neoxify-Test2` was booted, wedged, power-cycled, and wedged again. It is
now powered off. In order:

- **I polled `guestcontrol` during the boot window and jammed it
  permanently** — the trap the previous entry documents in so many words.
  Every later call answered `Error starting guest session (current status
  is: starting)`. **`kick.py` cannot recover this**, because it *needs*
  guest control to start the task. Only a power-cycle clears it.
- After the power-cycle, **keyboard injection worked** — a Win key press
  opened Start, `launch.py` opened the Run box and typed `boot2.ps1`
  correctly (screenshot `_typed.png`). Then, mid-UAC,
  `keyboardputscancode` began answering **`Failed to send a scancode`**
  and the guest stopped taking input at all.
- **`bringup.py` cannot work on a headless guest.** Its `wait_desktop`
  requires `size == (1920, 955)`, which is what the guest reports only
  when the VM runs with a GUI window; booted `--type headless` it sits at
  1024x768 for ever and the function times out on a desktop that is
  plainly up. `VBoxManage controlvm <vm> setvideomodehint 1920 955 32`
  does eventually fix the size, but not until the Guest Additions
  graphics service is up, so it is not a boot-time fix. Either boot the
  VM `--type gui` or use a readiness test that is not resolution-bound.
- **A visible elevated PowerShell window is not evidence the channel is
  up.** On the first boot the logon task's window appeared and
  `runner2-log.txt` was never rewritten: the task started before the
  `\\VBOXSVR` redirector was usable, and `runner2.ps1` swallows that and
  then heartbeats into nothing. **Only a fresh `heartbeat2.txt` counts.**

### A fresh worktree cannot build the service

Worth its own note, because it looks like a code break and is not.
`src-tauri/resources/` holds gitignored fetched binaries. Without them:

- `cargo build` fails at `LNK1181: cannot open input file 'WinDivert.lib'`
- `cargo check --workspace --all-targets` fails at
  `resource path 'resources\xray.exe' doesn't exist`

Copy the directory from a working checkout or run
`scripts/fetch-binaries.ps1` first. After supplying `WinDivert.lib` you
must also **delete `target/debug/build/windivert-sys-*`**, or the cached
build script keeps its empty `OUT_DIR` and the link fails again with the
same message. Note `cargo check` alone does not link, which is why the
previous entry's "clean" and this failure are both true statements.

### How to finish the verification — everything is staged

On the share, ready to run: **`wfpprobe.exe`** (and `wfpprobe.rs`, its
source — a rig tool, deliberately not committed, because `residue` mode
installs *persistent* IPv6 blocks and that is not a thing to ship in a
public repo), **`W1.ps1`**, and **`nxsvc-wfpfix.exe`**, which is the
service built from this branch.

`W1.ps1` runs seven phases into `W1-<tag>.txt` and needs an elevated
shell and nothing else — **no tunnel, no connection, no node**. That is
the point: the WFP sweep can be tested in isolation.

    0  the three enumeration forms on a clean machine
    1  install PERSISTENT provider/sublayer/filters under our GUIDs
    2  the same three forms, with our objects present
    3  netsh cross-check (independent of our code)
    4  neoconnect-service.exe repair -- stdout and EXIT CODE
    5  the three forms again -- "ours" must be 0
    6  netsh cross-check again

The three forms in phase 0 are the experiment that settles the diagnosis,
and they are built as a **single-variable control**:

    A  providerKey + ZEROED layerKey   <- what shipped. Expect 0x80320004.
    C  providerKey + REAL  layerKey    <- byte-for-byte A, one field changed.
    B  no template at all              <- the fix.

A and C differ **only** in `layerKey`. If A fails and C succeeds, the
zeroed layer key is the cause and nothing else is. If A *succeeds*, the
diagnosis in this file is wrong and the fix needs revisiting.

Pass criteria for phases 4 and 5: exit code **0**, the `wfp` step
reporting `removed N leftover filter(s)` rather than `Unknown`, and phase
5 reporting `ours=0`.

To drive it once a runner is alive: `echo "W1 a" > job2.txt` on the
share, then read `W1-a.txt`. If the guest is fresh, bring the runner up
with the keyboard path (`bringup.start_runner()`), **not** `kick.py`, and
**do not touch `guestcontrol` until the desktop has been up for a while**.
Safety valve if a repair ever fails mid-run: `wfpprobe.exe clean` removes
the residue directly.

### The 0.9.30 latency control: still has not run

Checked rather than assumed. The share has `L1-v30.pcap` at **41 KB** and
`L1-v30.txt` at **162 bytes**, and the whole of the latter is a start
line, `client: 0.9.30`, the route, and `disconnect: {"status":"ok"}`.
There is no `L1-v30-steady.txt` and no v30 pcapng — against 52 MB and
52 KB for the 0.9.31 run. The v30 install and connect happened; **no
measurement did.** So the previous entry's position stands, unchanged:
head-of-line, TCP_NODELAY and flow affinity are measured on 0.9.31 and
**unattributed**, and flow affinity still has a measurement pointing the
wrong way that only the control can explain.

### What still blocks 0.9.31

1. The repair's WFP sweep has **still never enumerated on hardware**.
2. The 0.9.30 latency control.
3. The one unexplained cell in the IPv6 table (the unselected app's UDP
   v6 showing zero).

Item 1 is now a fifteen-minute test that needs no tunnel, provided a rig
will stay up long enough to run it.

---

## 2026-08-24 (later still) — the WFP sweep enumerated, removed, and was cross-checked on real hardware

**Status:** `claude/repair-wfp-sweep-0931` at `8fe55e9`. **Touches:** this
file only. **The sweep is now hardware-verified.** Item 1 of the previous
entry's block list is closed.

### What ran, and where

Two independent runs, both elevated, both against real WFP:

- **Host, read-only.** A purpose-built read-only probe (the `residue`/
  `clean` mutators physically deleted from the binary, verified by
  `grep` of the Fwpm*Add/Delete symbols — none present) run elevated on
  the Windows 11 host. This settled phase 0 only; it never wrote WFP
  state and left nothing behind.
- **Guest, full end-to-end.** `Neoxify-Test2`, restored to `clean-base`,
  ran the whole of `W1b` elevated: the three enumeration forms, install
  persistent residue, enumerate again, `netsh` cross-check, the *actual
  service `repair`*, enumerate again, `netsh` again, and a safety-valve
  clean. Powered off and snapshot-restored afterwards; nothing stranded.

### Phase 0, the single-variable control — verbatim, both machines agree

    A  provider + ZEROED layerKey (the shipped bug): FwpmFilterCreateEnumHandle0 -> 0x80320004  FAILED
    C  provider + REAL layerKey (ALE_AUTH_CONNECT_V6): OK  handle=0  filters_seen=0  ours=0
    B  no template at all (the fix): OK  handle=0  filters_seen=547  ours=0

A fails with `FWP_E_LAYER_NOT_FOUND`; C, byte-identical but with a real
`layerKey`, succeeds. **The diagnosis in this file is confirmed, not
refuted.** The zeroed layer key is the whole cause. On the host the same
three lines held with `filters_seen=262` — the count is machine-specific,
the verdict is not.

### The fix does what the per-layer template cannot

With three persistent filters installed under our provider across two
layers (CONNECT_V6, RECV_ACCEPT_V6):

    C  provider + REAL layerKey (ALE_AUTH_CONNECT_V6): ... filters_seen=2  ours=2
    B  no template at all (the fix): ... filters_seen=550  ours=3

The real-layer template C sees only the **two** filters that live at the
one layer it names and misses the inbound one entirely; the fix's
no-template sweep finds all **three**. This is the reason the sweep is
written to enumerate everything and compare the provider itself, stated
now as a measurement rather than an argument.

### The service's own `repair` — verbatim, the line that matters

    [FIXED] Windows Filtering Platform filters -- removed 3 leftover filter(s)

Post-repair: form B `ours=0`, and the independent `netsh wfp show filters`
count of `Neoxify` went `5 -> 0`. The teardown also removed the sublayers
and provider (the safety-valve clean that followed got
`FWP_E_SUBLAYER_NOT_FOUND`/`FWP_E_PROVIDER_NOT_FOUND` — already gone).

**Honest caveat on the exit code:** the run exited `1`, not `0`. Not the
WFP step — that is `[FIXED]`. The non-zero came from the NRPT tunnel-DNS
item, whose PowerShell removal timed out at 15s in the constrained guest
and fell back to the registry, which held no rules of ours. That is an
unrelated teardown item and a guest-performance artifact, not a WFP
result. The WFP-specific pass criteria (removed N filters; phase 5
`ours=0`; netsh 0) are all met.

### Rig traps paid for this time, for the next session

- **The staged binaries were stale and the built binaries would not
  launch.** `nxsvc-wfpfix.exe`/`wfpprobe.exe` on the share were built
  from `c5213d6`, before `a03b0e3`'s `guid_eq` and zero-page free — the
  strings prove it. Rebuilt both from tip. Then they failed on the clean
  guest with `0xC0000135` (STATUS_DLL_NOT_FOUND): a stock Windows 11 has
  the UCRT but **not** `VCRUNTIME140.dll`, and the service **also**
  imports `WinDivert.dll` at load time even for the WFP-only `repair`
  path. Fix: build the rig binaries with `-C target-feature=+crt-static`,
  and drop `WinDivert.dll` beside the service. Both are now in `W1b.ps1`.
- **The wedged guest from the prior session could not be cleared with
  `taskkill`, even elevated** — the hung `guestcontrol` process sat in a
  kernel wait on the VBox driver. Killing `VBoxHeadless` did not free it
  either; only killing `VBoxSVC.exe` (the COM server, which respawns on
  demand) reaped it. That is the recovery when a guest session jams and
  the machine lock will not release.
- **Guest-control tokens are medium-IL**, so `schtasks /ru SYSTEM /rl
  highest` is `Access denied` from them — the no-UAC scheduled-task idea
  does not work cold. The path that *did* work is the documented one:
  `boot2.ps1` via an interactive Win+R, `Start-Process -Verb RunAs`, and
  the UAC consent accepted by injected keystrokes. **Scancode injection
  does reach the secure desktop on 7.2.10** (Left to move No->Yes, then
  Enter, both confirmed by screenshot) — the previous "Failed to send a
  scancode" was not a hard ceiling. `keyboardputstring`, however, is the
  reliable one for text; a bare Win+R still sometimes lands nowhere, so
  launching `boot2.ps1` straight from `guestcontrol start` and only
  injecting the UAC accept is cleaner than driving Run by keyboard.
- **A screenshot beats `bringup.py`'s readiness test.** Headless, the
  guest reports 1024x768 for ever and `wait_desktop`'s `(1920,955)` gate
  never trips though the desktop is plainly up. Confirm boot with
  `controlvm screenshotpng`, not the resolution.

### What still blocks 0.9.31

1. ~~The repair's WFP sweep has never enumerated on hardware.~~ **Done.**
2. The 0.9.30 latency control still has not run. Not attempted here: it
   needs a real client-to-node connection to measure, and the standing
   rule is not to lean on production nodes for tests. What it needs is a
   node that can be driven without disturbing live users (a throwaway
   exit, or explicit sign-off), then `L1.ps1` against the 0.9.30 client
   exactly as the 0.9.31 run was done. Until then head-of-line,
   TCP_NODELAY and flow affinity stay measured-but-unattributed.
3. The one unexplained cell in the IPv6 table.
4. Unrelated but seen in passing: the `repair` NRPT step's 15s PowerShell
   timeout fires readily on a slow machine and pushes the exit code to 1
   even when nothing of ours was present. Worth a look before release —
   a clean machine should not report a partial repair.

---

## 2026-08-24 (later) — the repair's false failure, and why the exit code was the bug rather than the timeout

**Status:** `claude/repair-nrpt-timeout-indeterminate`, branched from
`claude/repair-wfp-sweep-0931` at `c76c2e9`. **Touches:** `ipc`,
`service/src/{main.rs,engines/{dns,repair}.rs}`, `src-tauri/src/vpn.rs`,
and the repair UI (`lib/repair.ts`, `components/RepairNetwork.tsx`,
`lib/i18n.tsx`). Closes item 4 of the previous entry's block list.

### The bug was one layer up from where it looked

The previous entry recorded the symptom honestly: the WFP step was
`[FIXED]`, `netsh` confirmed 5 -> 0, and the run still exited `1`
because the NRPT step timed out. The obvious reading is "the timeout is
the bug, raise it". That is half of it, and the smaller half.

`RepairOutcome` already had four variants. `Unknown` already existed and
already said the right thing; `step_dns` already produced it; and
`RepairOutcome::is_failure()` already returned false for it. **Every
piece of the distinction was in place and nothing consumed it.** Both
ends derived their verdict from the same "not `AlreadyClean` and not
`Fixed`" filter, so `Unknown` arrived at the exit code and at the
summary banner as a failure:

- `main.rs` exited `1` on `report.unresolved()`, which includes
  `Unknown`.
- `RepairNetwork.tsx` picked `repair.resultProblems` and the destructive
  colour from `unresolvedSteps()` — the same conflation, in the place a
  customer actually reads.

So raising the timeout alone would have made the symptom rarer and left
the false claim in the code, waiting for the next slow machine.

### What "we could not check" is allowed to mean

`RepairReport` now answers three questions instead of one:
`failed()` (a step looked, found ours, could not remove it),
`indeterminate()` (a step could not complete), and `has_failures()` for
the exit status. `unresolved()` is unchanged and still returns both
kinds, because both are worth *naming* to whoever is helping — it is
only the verdict that had to stop treating them alike. The app mirrors
this with `failedSteps()` / `indeterminateSteps()`.

Only `failed()` sets the exit code. An indeterminate step is still
reported — named on the command line under its own heading, and in the
UI as a third summary state (`repair.resultUnverified`, en + fa) in the
same highlight tone the per-step "Couldn't check" already used, so the
banner and the row it refers to finally agree. It is not silently
swallowed and it still does not count as clean; `is_clean()` is
untouched.

This is the product rule applied to the tool that exists to enforce it.
Exiting `1` on a timeout asserts "this did not work", which is the one
thing a timeout does not establish — and the person reading it has
networking that is already broken, on a machine slow enough to have hit
the timeout, being told the last resort before a network reset failed.

### The NRPT query was never the PowerShell problem

Worth recording because the obvious fix here is the wrong one.
`rule_count()` — the census, on both the survey and the verify side —
has always read the registry directly, and deliberately: a rule under
`SOFTWARE\Policies\...\DnsPolicyConfig` is invisible to
`Get-DnsClientNrptRule`, so asking the cmdlet would under-report exactly
the case the sweep exists for. **There is no PowerShell to remove from
the query; it is already gone.**

What timed out is the cmdlet *removal*, which runs alongside the
registry sweep that does the real work across both locations. That belt
stays — dropping it would narrow coverage on an argument, and there is
no rig time tonight to test the narrowing. But 15s is the wrong budget
for it: `Get-DnsClientNrptRule` is CIM-backed, so a cold call pays
PowerShell start-up plus module and CIM-session load, twice in the one
script. `REPAIR_CMDLET_BUDGET` gives it 60s **on the repair path only**.

`clear()` keeps `HELPER_BUDGET`. That number's reasoning is untouched
and still correct where it applies: on connect and disconnect the
`Engines` lock is held, and one wedged child must not make the service
deaf to `status` and `disconnect`. The repair is a one-shot the customer
deliberately started and is waiting on, with no status poll queued
behind it — which is the only reason it can afford four times as long.

`REPAIR_TIMEOUT` moves 150s -> 195s and the app's deadline 160s -> 205s,
by exactly the 45s the NRPT budget gained. The old comment's arithmetic
("each bounded by the fifteen-second helper budget") was load-bearing
and would otherwise have quietly stopped being true; abandoning the pass
early would be the same false failure arriving one layer up.

### What is proven and what is not

Proven: `cargo check --workspace --all-targets` clean, `cargo test
--workspace` 214 passed / 0 failed, `tsc --noEmit` clean, `vitest` 128
passed. The new tests rebuild the rig's own report — clean tunnel,
timed-out dns, fixed wfp — and assert it is not a failure, with the
discriminator beside it: a dns step that *checked* and found residue
still is. Both were confirmed to discriminate by reverting the logic and
watching only those cases fail, on both sides of the wire.

**Not proven: any of this on a slow Windows machine.** A unit test
cannot produce a 15s CIM load; it asserts the classification, not the
conditions that trigger it. The rig was left powered off with its
snapshot restored to `clean-base`, so this was not re-run on hardware.
The end-to-end claim that stays open is narrow but real: that on a guest
slow enough to have timed out at 15s, 60s is now enough — and failing
that, that the run reports indeterminate rather than failed. The second
half is what the tests cover; the first is a guess with a rationale.

### What still blocks 0.9.31

1. ~~The repair's WFP sweep has never enumerated on hardware.~~ **Done.**
2. ~~The `repair` NRPT step's 15s timeout pushes the exit code to 1.~~
   **Fixed here, but see the caveat above: not re-run on the rig.**
3. The 0.9.30 latency control still has not run. Unchanged.
4. The one unexplained cell in the IPv6 table. Still unexplained, but
   there is now a candidate mechanism worth testing rather than
   reasoning about — see below.

### The IPv6 cell: a lead, not an answer

The cell is the unselected app's **UDP** v6 to `2620:fe::9` reading `0`
where the control read `4`. Two mechanisms sit on it, and neither was
checked against the probe's actual parameters:

- `redirect.rs`'s `handle_ipv6` blocks **any** v6 packet to **port 53**
  before it consults the selection list (`carry_dns` is `true` in
  production), by the stated design that while Custom mode is on every
  lookup goes through the tunnel. If the probe's UDP leg was a DNS query
  to `2620:fe::9:53`, a zero for an unselected app is **by design**, and
  its TCP leg to `2620:fe::fe` is untouched because the block is
  destination-port-53 only — which is exactly the shape of the table.
- Against that: this path calls `block(stats)`, which increments
  `blocked_v6`, and the journal's argument for the benign reading rests
  on `blocked_v6` reaching **exactly 5**, all accounted for by the
  selected app. Both cannot be true as stated.

Settling it needs the probe's actual destination port and datagram count
out of `V1-v31.txt` / `V1-v31b.pcap`, which live on the VM share and not
in git. **So: still unexplained.** What changed is that there is now a
specific thing to read rather than a rerun to schedule — and if the
probe did use port 53, the cell is not a bug at all.

Also worth knowing before that rerun: the merge on `claude/integration-all`
reports that the UDP-leak fix's `verdict_for_unattributed` and 0931's
`SelectedAppsIpv6Block` now both act on a selected app's unattributable
IPv6 from opposite ends. `verdict_for_unattributed` did **not** exist in
the binary that produced this table, so it cannot explain this cell —
but it will be present for whatever run settles it.

## 2026-08-24 — The integration branch, and the one semantic conflict in it

**Status:** `claude/integration-all` now carries four of the five queued
branches. Compiles and tests green; **nothing in it has run on a rig.**
**Touches:** `apps/desktop-windows/service/src/split_tunnel/redirect.rs`,
`apps/desktop-windows/service/src/engines/ipv6_block.rs`

Merged in order: `fix-shared-journal-conflict`,
`split-tunnel-direct-cache-destination`, `fix-udp-fire-and-forget-leak`
(all clean), then `repair-wfp-sweep-0931` (five conflicts in
`redirect.rs`, one in this file). `claude/gaming-mode` re-checked clean
against the result and is **not** merged — it is the owner's to take.

### Four of the five conflicts were counters, and that is the trap

The leak fix and 0931 each added their own fields to `Stats`. Both sets
survive — `refused_unattributed` from the leak fix, `udp_send_failed` /
`udp_reply_failed` / `udp_unbound` from 0931 — in the struct, the
`format!` string, the `.load()` list and the test initialiser. The one
that can go wrong silently is `summary()`: git offers two whole
`format!` strings and taking either wins the merge while dropping three
counters or one, and the placeholder count and the argument order have
to be reconciled by hand. Thirteen placeholders, thirteen arguments,
`refused_unattributed` before the three `udp_*`. The 0931 test
`the_relays_own_udp_losses_reach_the_log` only checks its own three, so
it would not have caught the other direction.

### The fifth was a real decision: the leak fix's arm wins

Both branches rewrote the same `None =>` arm of `decide`. 0931 kept
`selection.tunnel_when_owner_unknown()` and hung a long comment on it —
*"# The measured gap this arm cannot close"* — while the leak fix
**replaced** the arm with `matches!(unattributed, Some(Carry))`. Taking
0931's side would have reverted the leak fix's whole point while leaving
its tests, its counter and its module header in place: a merge that
compiles, passes nothing that notices, and puts the measured 13-of-15
leak back. So the leak fix's arm is what is in the tree.

**The 0931 comment was not deleted, because most of it is still true.**
What was stale is only its framing — it described the gap as open and
pointed at a mechanism as unbuilt. What was *not* stale, and what a rig
day paid for, was the structural reasoning about why the B2 filter
cannot be that mechanism, and that has been folded into `redirect.rs`'s
module header beside the section the leak fix already wrote there:

* the documented layer order (`ALE_AUTH_CONNECT` -> `OUTBOUND_TRANSPORT`
  -> `OUTBOUND_IPPACKET`, WinDivert's callout at the last of them);
* that there is no other layer to try — `ALE_APP_ID` is a condition only
  at the ALE layers and process id is not a filtering condition
  anywhere;
* that Mullvad and Windscribe get out of it with a **signed kernel
  callout** at `ALE_BIND_REDIRECT` / `ALE_CONNECT_REDIRECT` rewriting the
  *local* address, which this loop cannot copy because it leaves the
  source address alone by design.

### A stale claim the textual merge would have left standing

`SelectedAppsIpv6Block`'s doc comment (0931) said an unattributable v6
packet is "**left alone**, which for IPv6 means it goes out in clear
text". After the leak fix that is no longer true for the case it cited:
`verdict_for_unattributed` refuses unattributable UDP to public
destinations on both families. Git merged those two files without a
conflict, and the wrong sentence would simply have survived. Rewritten
to say what the type is still for once the loop refuses — TCP (a v6 SYN
that escapes is answered, and the connection establishes in the clear),
and acting at `connect()` before a packet exists at all. The `mod.rs`
note about `AllExcept` was checked and is still correct: that mode still
returns `Carry`, which for v6 still means block.

### What is proven and what is not

`cargo check --workspace --all-targets` clean. `cargo test --workspace`
226 passed, 0 failed, 4 ignored — 184 in the service crate. No test from
either parent branch is missing: the merged tree's test-name set is a
strict superset of the union of both.

**That proves the merge composes, and nothing else.** Neither underlying
fix has run on a machine. The UDP refusal has never been read against a
packet capture, its IPv6 half was reasoned rather than measured on the
branch it came from, and 0931's WFP sweep still has never enumerated on
hardware. The rig procedures for both are already written up above and
are unchanged by this merge.

**Open question for the owner, stated rather than decided:** the leak
fix's refusal and 0931's `SelectedAppsIpv6Block` now both act on a
selected app's unattributable IPv6, from opposite ends. Nothing here
double-counts — the ALE block prevents the packet, so the loop never
sees it — but the interaction has only been reasoned about, and the one
unexplained cell in the 0931 IPv6 table (an unselected app's UDP v6
showing zero) sits exactly where the two overlap. Whichever rig run
settles that table should be read with both in mind.

**Build note for the next worktree:** a fresh worktree cannot link the
service — `src-tauri/resources/` is gitignored and its absence gives
`LNK1181: cannot open input file 'WinDivert.lib'`, and the tauri build
script fails earlier still on `libpkcs11-helper-1.dll`. `cargo check`
does not link, so it passes regardless and proves less than it looks
like. Copy `resources/` in from a tree that has it, then delete
`target/debug/build/windivert-sys-*` so the cached build script re-runs.

## 2026-08-24 — Gaming Mode is built everywhere except the end that makes it work

**Status:** in flight on `claude/gaming-mode`, pushed, **not merged**
**Touches:** `apps/backend/**`, `apps/panel/**`, `apps/desktop-windows/**`
(service and src), `README.md`, `scripts/check-feature-drift.sh`

`docs/design/gaming-mode.md` is now merged onto that branch instead of
sitting alone on `claude/gaming-mode-design`, because every comment in the
implementation points at it. Read it before touching any of this.

### The thing the next session will assume and get wrong

**This is not a lower-ping feature.** Direct from Tehran to Blizzard's EU
game server is **72.0 ms**; the best path through our fleet is **72.8 ms**;
the other four nodes are **28–66 ms worse**. And turkey-1 is the *closest*
node to Tehran while being one of the *worst* paths to Blizzard — node
proximity to the customer is not the metric, total path is. "Pick the
nearest server" is the intuitive design here and it is wrong.

The schema comments, the panel copy and the client strings are all written
to make a ping claim awkward to add by accident. If a future pass finds a
natural-looking place to put "lower ping", that is the guardrail working,
not an omission to fix.

### What exists, and the one thing that does not

Built and green: Prisma models and migration, a Nest module with admin CRUD
and one customer endpoint, the panel page, and the whole Windows client —
mode selector, Settings pane, game picker, plus a service-side loopback DoH
stub and namespace-scoped NRPT rules.

**The node side does not exist.** No resolver process, no SNI proxy, no
agent command, no installer support. Nothing ever sets
`GamingResolver.confirmedAt`, so `/customer/gaming-profile` answers
`unavailableReason: "noResolver"` for every customer and **no client can
arm**. The feature is inert on purpose and says so rather than
half-working: `isEnabled` records what the operator meant, `confirmedAt`
records what a node reported, and only the second connects anybody. Same
decision as `Route.uplinkAssertedAt`, same reason — thirteen relay routes
once reported ONLINE with every one of them dead.

That omission was a choice, not a shortfall of time. The node side cannot
be verified without deploying to a production node, and an installer
function nobody has ever run is fiction; that lesson is already in this
file twice. Building it blind would have produced the most confident-looking
and least trustworthy part of the branch.

### What is blocked, and on a person rather than on code

**Instrument #1 in §14 gates whether this should be sold at all**, and it
needs a beta tester in Iran on TCI / MCI / Irancell running the hostname
sweep and posting raw output. Every Iranian probe used so far is a
**datacenter** network and none of them found anything blocked — so the
"sanctions-blocked vs merely slow" split this feature was conceived around
**did not hold on the evidence available**. A negative result kills the
unblocking premise, and that has to be allowed to happen.

Also unmeasured and cheap to get wrong: whether the Battle.net launcher
resolves in-process (instrument #9). If it does, DNS mode never sees its
lookups and the launcher half of this reaches nothing.

### Ground truth that does exist

The DNS stub was stood up against a real DoH endpoint on a loopback port:
`example.com` → rcode 0 with real A records, three non-matching names →
rcode 5 REFUSED, a dead resolver → rcode 2 SERVFAIL, and counters reading
`forwarded=1 refused=3 failed=0`. The counters are the useful part — they
are positive evidence the refusals produced **no outbound request**, and
that `notexample.com` does not match an `example.com` namespace in the
running stub rather than only in a unit test.

**Never run, and it is the half that matters:** NRPT installation,
verify-present, and the canary. Those need an elevated service and the
shell was not elevated, so the entire `active` path is compile-and-unit-test
only. Binding 127.0.0.53:53 has never been attempted either (instrument
#11) — the tests bind an ephemeral port.

### Gotchas worth the next session's time

- **`docs/journal/shared.md` on `main` carries committed merge-conflict
  markers** — `<<<<<<< HEAD` at 152, `=======` at 201, `>>>>>>> origin/main`
  at 239. Both sides are real 2026-08-23 entries. It is the only channel to
  the Mac session and it currently reads as corrupt. Left alone here rather
  than risk a second conflict in the one file two machines share.

- **Three agents shared this working tree and HEAD belonged to another
  session throughout.** Rather than `git checkout` — which moves HEAD under
  everyone else, and is how a commit landed on the wrong branch earlier
  today — every commit here was built with a private index:
  `GIT_INDEX_FILE=… git read-tree <branch>`, stage paths, `commit-tree`,
  then `update-ref` with the old value passed for compare-and-swap. The
  working tree, the shared index and HEAD are never touched, and a
  concurrent branch move fails loudly instead of silently. Worth reaching
  for again rather than re-deriving.

- **`apps/desktop-windows/src/lib/**` and `src/screens/Settings.tsx` are
  compiled by the mobile app** through the `@shared` alias. The new Settings
  section therefore takes an **optional** `gamingSection` prop and renders
  its rail row only when supplied, so nothing under `apps/mobile/**` needed
  editing. Mobile's `build` is `tsc && vite build`, so its build is the gate
  that catches a mistake here — and `@neoxify/desktop-windows` and
  `@neoxify/mobile` define **no `lint` or `typecheck` script at all**, which
  makes `turbo run lint typecheck --filter=…` report success while executing
  nothing. Run `build`.

- Gaming NRPT rules carry their own comment tag. `dns::clear()` matches on
  the tunnel tag alone and runs unconditionally on every disconnect, so
  without separate tags the two features would delete each other's rules.

## 2026-08-24 (later) — `claude/gaming-mode` no longer merges clean, and the reason is instructive

It merged clean against `main`. It does **not** merge clean against
`main` + `repair-wfp-sweep-0931`, and the interesting failure is not any
of the five conflicts git reported.

Five textual conflicts, all of them additive and all resolved by keeping
both sides: two in `ipc/src/lib.rs` (both branches append variants to
`Request` and to `Response`, and both then define new types after the
enum closes — the naive union welds one side's half-finished struct onto
the other's), one in `src-tauri/src/lib.rs` (both append to the
`invoke_handler` list), one in `src/screens/Settings.tsx` (both add a
`SectionId`, so the union is `"gaming" | "custom" | "general" | "repair"
| "account"`), and this file. The two `vpn.rs` match arms that list
every unexpected `Response` also had to be unioned rather than chosen.

**The one that mattered merged cleanly.** `gaming_reply` in
`src-tauri/src/vpn.rs` is new on `gaming-mode` and matches exhaustively
over `Response`. 0931 added `Repaired` and `Diagnostics` to that enum in
a part of the file gaming-mode never touched, so git had nothing to
report — and the result did not compile: `error[E0004]: non-exhaustive
patterns`. Exactly the shape CLAUDE.md warns about, one branch reshaping
a type the other exhaustively matches, and the only reason it was caught
in seconds instead of at runtime is that Rust makes this class a compile
error. A TypeScript `switch` or a `_ =>` arm would have swallowed it.

Verified after resolution: `cargo check --workspace --all-targets`
clean, `cargo test --workspace` **277 passed, 0 failed, 6 ignored**
(222 service, 38 ipc, 17 tauri lib), `tsc --noEmit` clean for the
desktop frontend and `vitest run` at 124 passed in 12 files. The merged
tree's Rust test-name set is a strict superset of the union of all four
merged branches' — nothing was dropped.

Backend and panel were **not** typechecked here: gaming-mode's
`apps/backend/**` changes came across with no conflict at all, so
nothing in them is integration-created, and installing the whole
monorepo to prove that was not worth the time. CI will say. Nothing in
Gaming Mode has run on a rig either, and the entry above it already says
what is missing at the node end.

## 2026-08-25 — PUA protection on: 0.9.31 is still clean, and the control now covers PUA

**Status:** done (measured on the rig, PUA in block mode)
**Touches:** nothing in the tree — a finding about released artifacts

Yesterday's Defender run named its own hole: `PUAProtection` was `0`, so
nothing it proved said anything about a customer with PUA protection on.
Xray, OpenVPN and WireGuard are exactly the class that lands in
`PUA:Win32/*` rather than the malware bucket. **That hole is now closed.
With PUA protection in block mode, nothing in 0.9.31 is flagged** — not
the installers, not the installed tree, not the engines at runtime.

### The evidence is the absence of events, not the presence of files

This matters, because **remediation is broken on this snapshot**. Both
control files were detected *and blocked* and yet stayed on disk. So
"the binary is still there" proves nothing on this rig, and any future
run that reasons from survival alone will produce a false pass.

What is load-bearing is the detection log. Three detections happened in
the guest, all session, and here they are in full:

| when | threat | path |
|---|---|---|
| 11:28:04 | `PUA:Win32/EICAR_Test_File` (224688) | `C:\nx\PotentiallyUnwanted.exe` |
| 11:30:44 | `PUA:Win32/EICAR_Test_File` (224688) | `Downloads\PotentiallyUnwanted.exe` |
| 12:51:06 | `Virus:DOS/EICAR_Test_File` (2147519003) | `C:\nx\eicar.com` |

Both control detections also produced a **`1117` with `Action: Block`**,
so PUA block mode was genuinely enforcing and not merely set. **No
Neoxify file appears anywhere in that log** — not once, at any step.

### Two controls, because EICAR alone does not cover PUA

A clean PUA scan is worthless unless PUA detection was demonstrably live,
and EICAR only exercises the malware path. So this run added a
PUA-specific control: the AMTSO/EICAR `PotentiallyUnwanted.exe`
(`http://amtso.eicar.org/PotentiallyUnwanted.exe`, sha256 `42d6581d…`).
It fired in the guest on explicit scan (`found 1 threats`) and again on
the mark-of-the-web copy in `Downloads`, and it fired on the host too.

**The PUA event ID depends on the mode, and this is worth not
rediscovering.** In the guest at `PUAProtection=1` (block) it came
through as **`1116`/`1117`** and `1160` was empty. On the host at
`PUAProtection=2` (audit) the same file logged as **`1160`** with
Category *Potentially Unwanted Software*. Query all three or a PUA
detection will be invisible in whichever mode you did not expect.

### What was actually on

| | guest (rig) | host (cross-check) |
|---|---|---|
| `PUAProtection` | **1 = block** | 2 = audit |
| definitions | `1.457.318.0` (23 Aug) | `1.457.335.0` (25 Aug) |
| engine | `1.1.26070.7` | `1.1.26070.7` |
| RTP / MAPS | on / `MAPS=2` | on |
| exclusions | none | none for Neoxify |

`Set-MpPreference -PUAProtection Enabled` stuck first try **even with
Tamper Protection on**, so the policy-key fallback was not needed.

**Guest definitions are two days stale and would not update** —
`Update-MpSignature` hangs at `0/1 completed` (9 minutes before it was
killed), which is worse than the documented `0x80070102` failure because
nothing errors. That is why the host cross-check matters, and it is a
real one: **all twelve vendored binaries are byte-identical between the
guest's fresh 0.9.31 install and the host copies**, which were scanned at
current definitions with PUA audit on and came back clean. Only
`neoconnect-service.exe` and `neoconnect-desktop.exe` differ, because the
host carries an older build.

The host is also independent evidence in its own right: 37 detection
events in its Defender log across its lifetime, including real PUA
verdicts (`PUABundler:Win32/FileZilla_BundleInstaller`), and **not one
of them is a Neoxify binary**.

### Per-file, by name, PUA block on

Both released assets verified against `sha256sums.txt` and re-hashed
inside the guest to the same values (`e8c05dc5…e015cee0`,
`ea29caad…61c4e990`), so what was installed is byte-for-byte the release.

All 15 installed binaries scanned individually: **CLEAN**, plus
`[WHOLE TREE] CLEAN` over `C:\Program Files\Neoxify`. Both installers
clean on explicit scan and clean again as mark-of-the-web copies in
`Downloads` — the shape a real download has, and the shape PUA
protection has historically keyed on.

`xray.exe` is the one to watch, and it is clean: **unsigned**, 34 MB, a
proxy engine — comfortably the strongest PUA candidate in the bundle.
`openvpn.exe` (CN=OpenVPN Inc.), `wireguard.exe` (CN=WireGuard LLC) and
`WinDivert64.sys` carry valid vendor signatures. Both installers and both
Neoxify-built binaries are `NotSigned`, which is the known signing gap
rather than a new finding.

### It runs, too

PUA verdicts often arrive on execution rather than at install.
`NeoxifyService` came up **Running / Automatic** and was still
`Running` at the end; `neoconnect-desktop` and `neoconnect-service`
stayed alive; and every engine was launched directly — `xray.exe` ran
(killed at 12s, it serves rather than printing a version),
`wireguard.exe` and `wg.exe` exited 0, `openvpn.exe` and `tapctl.exe`
exited 1 with no config, as expected. None was blocked, and none
produced a detection event.

No tunnel was established and no production node was touched.

### What this does not prove

One machine, one engine version, one moment. **PUA classification is a
reputation call and it moves** — an unsigned proxy engine that is clean
today can be reclassified tomorrow with nothing in our tree changing.
This is a snapshot, not a settled property of 0.9.31.

- 0.9.31's own `neoconnect-service.exe` and `neoconnect-desktop.exe` were
  only ever scanned at `1.457.318.0`. The current-definitions coverage is
  for the twelve vendored binaries.
- **Neither a full scan nor a quick scan completed.** `MpCmdRun -Scan` is
  pathologically slow on this VM — the full scan ran 50 minutes and the
  quick scan 18, both without finishing, and both were abandoned. The
  scheduled-scan path is therefore *not* covered. Per-file, whole-tree,
  download-path and live-execution scans are.
- Nothing was tested against a managed configuration, where PUA is often
  forced on at a stricter `CloudBlockLevel` than the `0` here.
- The bootstrapper was scanned but **not installed** — its `Install`
  button is still mouse-only on this rig. What it installs is the same
  NSIS package that was installed here, so the gap is its UI path, not
  the payload.

### No exclusion, no repack, no submission

- **An exclusion should not be shipped.** Telling customers to exclude
  `C:\Program Files\Neoxify` trains exactly the habit that gets people in
  Iran compromised, and it would mask a real detection later.
- **A repack fixes nothing** — there is nothing being flagged.
- **Nothing was submitted to Microsoft and nothing should be.** There is
  no false positive to report, and WDSI takes malware/PUA submissions,
  not "please pre-approve my unsigned installer". It would also spend the
  owner's identity, which is his call.

The lever that matters is unchanged and still stalled: **finish the Azure
Trusted Signing enrolment so `AZURE_CLIENT_ID` exists.** Signing grants
no instant reputation, but it is what lets reputation accrue to a
publisher instead of to each new file — and an unsigned `xray.exe` is the
single most likely place a future PUA verdict lands on us.

### Rig traps corrected

- **`guestcontrol` cannot be used on this rig at all.** The account
  auto-logs in with a blank password and Windows blocks the secondary
  logon, so every call returns "user was not able to logon" regardless of
  the password passed. Use `sharedfolder add --transient --automount
  --auto-mount-point Y:` and drive the Run dialog.
- **UAC *does* render into VirtualBox screenshots** — yesterday's entry
  says it does not. `No` has default focus; Left-arrow then Enter works.
  The earlier "Alt+Y did nothing" was timing: the prompt takes ~10s and
  the keystroke was arriving first.
- **The mapped share IS visible to the elevated token here** (`Y:` worked
  from the Administrator shell), which is not the usual Windows
  behaviour.
- **`Update-MpSignature` hangs rather than failing.** `Ctrl+C` does break
  it, but only once the cmdlet yields — send it and wait rather than
  concluding it was ignored.
- Screenshots lag the guest by several seconds. Verify the Run-dialog
  contents after a pause, never immediately — and the `RunMRU` prefill is
  real: the field came up pre-populated with a stale command from a
  previous session every single time.
