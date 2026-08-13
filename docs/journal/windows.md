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
