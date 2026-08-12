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
