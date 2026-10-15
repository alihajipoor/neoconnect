# Relay of last resort: sign-up, sign-in and payment

When Iran's national intranet cuts the international routes, a customer in
Iran can reach only domestic addresses. The app's last resort is a pinned
relay box inside Iran that carries its own small API calls to the panel host
abroad. This document is the approved design for signing up, signing in and
paying through it, and records what the backend does today.

Below: the owner's decisions, the backend as built, then the reviewed spec
(findings F1-F17, rules R1-R10, invariants I1-I5) that the code comments
cite.

## Owner decisions (2026-10-15)

Binding where they differ from the spec below.

- The relay path is a last resort only: every normal route failed (net,
  timeout or block page), Iran evidence on the client and region IR on the
  server. Normal sign-up and sign-in are unchanged.
- The server proves relay origin by **arrival port** -- the relay listener
  proxies to a dedicated backend listener -- never by a client header.
- Relay sign-up skips email verification: no trial, no referral credit, at
  most 3 sessions; caps 200/day normal, 3,000/day declared intranet, 30/day
  per real IP, proof of work 18 bits; throwaway addresses refused. No
  verification deadline: unverified relay accounts stay limited (Ultimate
  vouchers only) until they verify; unpaid ones are deleted after 30 days
  idle, paused during an intranet. Paying users are never locked out.
- Recovery codes: one for every relay account, optional for everyone in
  Settings. "Set a password" for social-only accounts before any shutdown.
- Payment: both card/crypto checkout (the checkout page reached through
  the Iranian relay as a payment-only path, not free VPN) and vouchers.
  iOS during an intranet: vouchers on another device.
- Pro/Starter users must buy Ultimate for shutdown access. Ultimate's
  device limit is unchanged.

## Backend as built (branch claude/relay-auth)

**Arrival proof (R2).** `RELAY_LISTEN` (compose default `0.0.0.0:4001`,
published on the host's `127.0.0.1:4001` only) starts a second HTTP
listener on the same application. A request is a relay request if and only
if its socket was accepted there (`common/relay/relay-arrival.ts`). That
listener accepts connections only from loopback and the container's default
gateway -- where Docker's port publishing connects from -- so the panel and
the bot, which share the compose network, are closed unread (F3);
`RELAY_TRUSTED_PEERS` replaces the detected gateway. `X-Neoxify-Via` and
`X-Neoxify-Relay-Box` are stripped from every request on both listeners; the
box name is read only on a relay socket. Relay requests pass
`relayGate`: the allowlist (`common/relay/relay-allowlist.ts`, pinned and
checked against the router by its spec) or a bare 404, then the region gate.
The listener is inert until the origin's relay block proxies to it
(`infra/nginx/relay-origin.conf.example`).

**Region (R2.4).** The ASN table keeps iptoasn's country column;
`AsnLookupService.regionOf(ip)`. Relay sign-up needs IR; every other relay
call needs IR or unknown; otherwise 403 `RELAY_REGION`. Registered country,
not location (F5).

**Mode (R2.5).** `relay_auth_settings.mode`: `OFF`, `AUTO` (default),
`INTRANET`; Panel -> Settings -> Relay sign-up. The auto detector counts
normal-route requests per 10 minutes by registered country (our own node
addresses excluded), compares the last half hour with the same half hour on
the previous 7 days, alerts the owner (webhook and SUPERADMIN mail) after 30
minutes of Iran < 15% of its median while the rest is >= 70%, and raises the
caps to the intranet tier after 60. It changes nothing a customer reads.
`GET /relay/status` tells the apps `{signup, intranet}`; only a declared
intranet sets `intranet` (I4).

**Endpoints.**

| Endpoint | What |
|---|---|
| `POST /customer-auth/relay-register` | Relay only (404 elsewhere). Address twice, PoW required (>= 18 bits), caps, no throwaway domains. Tokens at once, plus a recovery code shown once. No mail, no trial, referral ignored. |
| `POST /customer-auth/login` (changed) | Over the relay from IR, an unverified account becomes relay-unverified on a relay sign-up's terms, once: switch, region, a proof of work of at least the sign-up's bits (else 400 `CHALLENGE_REQUIRED`, `scope: "relay-signup"`), and a place under the caps (R4.2). Refusals say why (`RELAY_SIGNUP_OFF`, `RELAY_REGION`, `RELAY_SIGNUP_LIMIT`), never `requiresVerification`, and are not counted as failed guesses. An account already relay-unverified, or holding an active or relay-only subscription, is let in without a place whatever the switch says. Normal routes unchanged. |
| `POST /customer-auth/reset-password-recovery` | Reset by recovery code; shares the emailed code's guess budget; returns a new code. |
| `POST /customer-auth/recovery-code` | Create or rotate (current password, or a sign-in in the last 15 min for social-only accounts). |
| `POST /customer-auth/set-password` | Social-only accounts, sign-in in the last 15 min. |
| `POST /customer-auth/unverified-email` | Change an unconfirmed address: password, address twice, 3/day. |
| `POST /customer-auth/reset-password-code` (changed) | Now also verifies an unverified account (R3.8). |
| `POST /login-challenge` (changed) | Scope `relay-signup` mints at the caller's relay difficulty. |
| `POST /customer/vouchers/preview`, `/redeem` (changed) | Over the relay, or for an unconfirmed account: single-use relay-only (Ultimate) codes only, else 403 `VOUCHER_NOT_ALLOWED`, code untouched (F1). |
| `GET /customer/me` (changed) | Adds `signupChannel`, `relayUnverifiedSince`, `recoveryCodeSetAt`, `hasPassword`, `hasRecoveryCode`. |
| `GET /relay/status` | Public; on the allowlist. |
| `GET`/`PATCH /relay-auth` | SUPERADMIN: mode, hosting ASNs, today's counts, detector state. |
| `POST /relay-auth/customers/:id/move-address` | SUPERADMIN: move an account to a new address on its recovery code (R3.9); returns a new code. The account is relay-unverified until the new address is confirmed. |

**Default deny (R3.3, F2).** `CustomerJwtAuthGuard` refuses a
relay-unverified account (address unconfirmed, `relayUnverifiedSince` set:
a relay sign-up, a relay conversion, or a support move) on every route not
marked `@AllowUnverified`, with 403 `VERIFY_EMAIL`. Marked: logout,
change-password, unverified-email, recovery-code, `GET`/`DELETE
/customer/me`, subscriptions, protocol-users, a subscription's routes and
route switch, voucher preview and redeem, and the device-slot calls. Its
spec enumerates every guarded route. An unverified account that never came
in by the relay is not limited: one older than verification (2026-07-24,
no backfill) may hold a session that has refreshed ever since, and keeps
what it had; normal sign-in still makes no new one.

**Records (R2.6, I5).** `customers.signupChannel`, `relayUnverifiedSince`,
`recoveryCodeHash` (SHA-256), `recoveryCodeSetAt`, `relayMailAt`;
`customer_sessions.channel`; `client_attempts.via`; `relay_daily_stats`
(day, box, ASN: sign-ups, sign-ins, refusals); `relay_traffic_buckets`.
Migration `20261015_relay_auth`, additive. No relay caller's address is
stored or logged: callers are counted by a keyed hash whose key dies with
the process, and relay `client_attempts` rows keep the ASN with `ip` null.

**Sweeps.** Daily `relay-unverified`: deletes unverified relay accounts with
no subscription, voucher, payment or invoice and no session used for 30
days; paused during a declared intranet and the 30 days after. During that
same hold, idle sessions and device credentials of customers with an active
relay-only subscription are kept (R4.5).

**Mail (R3.7).** Relay-unverified accounts: one verification or reset mail
per address per day, and a daily total equal to the day's sign-up cap.

### Where the backend differs from the spec, and why

- **Arrival port, not a secret header** (R2.1, F3): the owner's decision.
  F3's sibling-container hole is closed by the peer check instead.
- **Region gate on every relay call**, not only sign-in and refresh: the
  relay is for Iran, and one rule is simpler to hold.
- **Device slots and account deletion are open to unverified accounts**:
  the apps claim a slot before every connect, so refusing it would lock a
  paid Ultimate account out (owner: never lock paying users out); in-app
  deletion is a store requirement. Recovery-code rotation is open too
  ("every account can create or rotate", R4.3).
- **Payment allowlist adds `GET /customer/plans` and
  `/customer/billing/providers`**: checkout cannot be started without them.
  Unverified accounts are refused all four by the guard.
- **Install id is a PoW step, not a counter alone**: past 3 sign-ups a day
  it adds 2 bits, never refuses.
- **An unverified account's first sign-in over the relay takes a sign-up
  place, and pays the sign-up's proof of work**: otherwise accounts
  registered on the normal routes would bypass the caps, or drain them for
  the login guard's cheaper work (F4). Only that first one: later sign-ins
  of a relay-unverified account, and any of an account holding paid access,
  are never capped -- paying users are never locked out.
- **The cleanup also waits 30 days after an intranet**, like the session
  hold, rather than resuming the day it is lifted.

### Not done here

- **Client (P2).** `relay_http.rs` must add: `relay-register`, `logout`,
  `reset-password-recovery`, `recovery-code`, `unverified-email`,
  `change-password`, voucher preview/redeem, `GET /relay/status`, the four
  checkout calls and `POST /client-attempts`, and forward
  `X-Neoxify-Install-Id`. `GET /endpoints/bundle2` is on the client's list
  but is not a backend route yet.
- **Origin nginx.** The live relay block must proxy to `127.0.0.1:4001`,
  set `X-Forwarded-For` from the PROXY header, clear `CF-Connecting-IP`,
  `X-Real-IP` and `X-Neoxify-Via`, and send the box name -- see the
  template. Until then relay requests reach port 4000 and are ordinary
  requests (relay sign-up answers 404).
- **Payment-only path for checkout pages.** Server side, when built: a
  short-lived credential on the relay box's VPN inbound, minted by an
  authenticated `POST /customer/billing/checkout-path` for a PENDING
  subscription only, whose node routing allows only the provider's checkout
  hosts (Stripe, NOWPayments, Plisio) and expires with the checkout. Needs
  agent routing work and is not built.
- **Unverified.** Nothing here has been shown on a real Iranian network, on
  the VM through the relay, or through Docker's port publishing on the panel
  host (the gateway-peer check is reasoned, not observed). The proof gate
  in P1 below still applies.

---

## Reviewed spec (2026-10-15)

SKEPTIC REVIEW of the relay sign-up/login spec (2026-10-15). Read-only: nothing was changed. [A] = owner must confirm. [U] = unverified until shown on a real network.

FINDINGS (attack -> fix; code refs checked)
F1 Voucher farming. Admin vouchers may be unlimited (maxRedemptions null, vouchers.service.ts:222). One leaked Ultimate code plus farmed unverified accounts = unlimited free Ultimate. Fix: unverified accounts redeem only single-use relayOnly codes. Reseller codes already are single-use (resellers.service.ts:151).
F2 Blacklist rot. "MAY NOT pay / ticket / ..." lists endpoints one by one, so any future /customer/* route is silently open to unverified accounts on normal routes. Fix: a default-deny guard. This also removes the 14-day deadline and its lock-out matrix: there is nothing to lock, and verifying unlocks the rest.
F3 Marker spoofing. A ":4001 published on loopback" port is still reachable from the panel and discord-bot containers, which share the backend's default compose network (docker-compose.prod.yml). Fix: one listener, plus a secret header injected only by the 8444 server block.
F4 The caps are a DoS lever. A few Iranian VPSes can exhaust 200/day and lock out real users. A hard per-IP 10/h hits mobile CGNAT IPs during a surge. Fix: a per-ASN share, a small bucket for hosting ASNs, and PoW step-up before any hard refusal.
F5 Region is not location. iptoasn's country is where the AS is registered, and any Iranian VPS passes the check. It is a cost gate, not security. An unknown ASN cannot sign up.
F6 False "intranet". Our IR traffic also drops when only our domains are blocked. Fix: the user-facing intranet wording appears only when the owner declares it. Auto mode only raises caps and alerts.
F7 Lock-out. A password lost during the intranet is unrecoverable: mail is unreachable and the address is unverified anyway. Fix: a recovery code. The old R3.4 also forbade reset mail while R3.8 relied on it; reset mail is now allowed.
F8 "Sessions last seen from IR" needs a per-session region we do not store. Fix: key the sweep pause on an active relayOnly subscription.
F9 Typos and squatting. A payer's Ultimate goes to whoever controls the typed address. Fix: the address is typed twice, and the recovery code can change it. Squatting during the intranet remains (bounded by caps and the cleanup of unpaid accounts). This is stated, not solved.
F10 Box enumeration. Every box returns the same self-signed origin cert to a no-SNI probe, and /api/health returns Neoxify JSON. One scan of Iranian IDC space finds them all. Fix: a keypair per box, plus a generic 404 for requests without the relay key.
F11 Mail cannon. Farmed accounts can use "send code" and change-address to mail strangers. Fix: per-address and global mail caps.
F12 Missed requirement. New users cannot download the app during the intranet (GitHub, Play, App Store and our site are all unreachable), and pre-relay releases have no relay.
F13 Gate trap. A user who stays "connected" or degraded on Pro can never reach the relay to buy Ultimate. Fix: tell them to disconnect.
F14 A seized box can forge PROXY IPs, which voids the per-IP limits and the region check. Only the per-ASN and global caps and PoW still hold. Fix: a sign-up rate alert per box.
F15 There is one box on one ASN today. Fix: at least 3 boxes on at least 2 providers.
F16 Consolidating the VPN relay inbounds is unrelated to sign-up and carries the wrong-country risk. Split it out.
F17 A cap of 3 sessions with no way to sign out over the relay is a lock-out. Fix: the oldest session is evicted, and logout goes on the allowlist.

FINAL SPEC

BASELINE (from the code)
- register mails a code and returns requiresVerification (customer-auth.service.ts:108-138).
- login refuses unverified accounts (:454).
- The trial and the referrer mail come only at first verification (:325).
- A password reset does not set emailVerifiedAt (:746).
- Redeeming a voucher creates no invoice and checks no verification.
- The ASN table drops the country column (asn-table.ts:91).
- ClientAttempt stores the client IP.
- Sessions idle for more than 30 d are reclaimed.
- The allowlist on the relay-client branch includes social sign-in and reset, but not vouchers.

0 INVARIANTS
I1 Normal sign-up and login are unchanged. Verification is required on every normal route, from Iran too.
I2 Skipping verification is possible only on a request the relay delivered (proven by the server) from an IR network, made by a client whose normal routes failed (enforced by the client, which the server cannot prove; hence I3).
I3 An unverified account holds nothing free and can use only the capability set in R3.3, on any route. This is the real abuse control.
I4 "National intranet" is shown only when the owner has declared it.
I5 No relay caller's IP is ever stored.

1 CLIENT
R1.1 Order: the normal race/walk, then foreign pinned IP-literal entries, then the Iranian relay. The relay is never raced, and never appears in apiEndpoints(), the http scope, lastGood, updater targets or probe targets.
R1.2 Trigger: every normal attempt ended in net or timeout, or hit the 10.10.34.x block page. Never on an HTTP status, a scope refusal or a local error.
R1.3 Iran evidence (a cost and honesty gate): the last server-stamped country for this network key is IR. On a fresh install, timezone Asia/Tehran or region IR is enough.
R1.4 Consent once per install, before any byte is sent. A decline is remembered. Background flows never prompt.
R1.5 The service must report `disconnected` at send time. Otherwise the app shows "Disconnect to use the backup route".
R1.6 Budgets:
- 40 requests/h and 200/day per device, counting only TCP-completed attempts
- one relay decision in flight at a time
- at most 2 boxes, 4 s to connect and 12 s in total; the sign-in deadline grows by this budget
- pool idle time under 25 s
R1.7 Relay mode starts on backend JSON from the relay, with a 15-min sliding TTL per network key. It ends on any of:
- a normal-route success (probed at most every 3 min)
- a tunnel connect
- a network change
- 2 relay failures in a row
- a RELAY_REGION refusal, which also turns the relay off for that network for 24 h
R1.8 Every relay request carries the relay key from the signed bundle (see R7.1).

2 BACKEND PROOF
R2.1 The relay marker is a header, X-Neoxify-Relay-Auth, injected only by the 8444 server block from a root-only secret file. It is compared in constant time, stripped by every other server block, never logged, and rotatable. A client-sent Via header is ignored.
R2.2 A relay-marked request passes allowlist middleware that mirrors nginx and relay_http.rs. Anything else gets 404.
R2.3 The 8444 block sets XFF from the PROXY header and clears CF-Connecting-IP and X-Real-IP. The IP stays in memory only. Relay ClientAttempt rows keep the ASN with ip null.
R2.4 Keep the country column and add regionOf(ip). Relay sign-up needs IR. Relay login and refresh need IR or unknown. Anything else gets 403 RELAY_REGION.
R2.5 relayAuth.mode is stored in the DB: off, auto (the default) or intranet (declared by the owner).
- Auto alerts the owner after 30 min when both hold [A]: IR-ASN normal traffic is below 15% of the 7-day same-hour median, and non-IR traffic is at or above 70% of its median.
- After 60 min sustained, auto raises the caps to the intranet tier.
- Only a declared intranet changes user wording or pauses sweeps.
R2.6 Record:
- Customer.signupChannel (NORMAL, RELAY or SOCIAL)
- CustomerSession.channel
- the box id and the ASN
- daily counters by ASN

3 RELAY SIGN-UP (NO VERIFICATION)
R3.1 Allowed only when all hold: the request is relay-marked, the region is IR, mode is not off, caps remain, and the address is not disposable.
R3.2 Account state:
- emailVerifiedAt stays null and relayUnverifiedSince is set.
- Tokens are issued at once.
- The address is typed twice.
- The referral code is ignored, and no mail is sent.
- A recovery code is issued: 16 base32 characters, shown once, stored hashed.
R3.3 The capability set, enforced by a default-deny guard on every route. Everything else gets 403 VERIFY_EMAIL.
- sign-in, refresh and logout
- read me, subscriptions, routes and protocol-users
- voucher preview and redeem, for single-use relayOnly codes only
- request and enter a verification code
- change the unverified address (password required, 3/day)
- change the password
- reset by recovery code
R3.4 What follows from that:
- no trial and no plan that is not relayOnly
- no card, crypto or IAP, and no tickets
- at most 3 sessions [A]; a 4th sign-in evicts the least recently used one
- the only mail is verification and reset
R3.5 Limits:
- PoW floor of 18 bits over the relay, +2 bits per pressure step (per IP above 3/h, global above 50/h)
- per IP: 30/day hard [A]
- per ASN: at most 25% of the global cap; listed hosting ASNs share 5% [A]
- global: 200/day in auto, 3,000/day in the intranet tier [A]
- install-id header: 3/day, advisory only
- duplicate address: 409 as today
R3.6 Verifying, by any route at any time, makes it a normal account. The guard lifts, and the trial follows today's rule: granted only if the account has no subscription. There is no deadline.
R3.7 Mail: at most one verification or reset mail per address per 24 h, plus a global daily cap on mail to unverified relay accounts.
R3.8 Proving the mailbox wins. A reset by emailed code sets emailVerifiedAt and revokes all sessions (as today). Unpaid unverified relay accounts idle for 30 d are deleted, which frees the address; this is paused during a declared intranet.
R3.9 Support may move an account to a new address on the recovery code alone.

4 RELAY LOGIN AND RECOVERY
R4.1 Verified accounts: today's PoW and LoginGuard, counted per account and per real IP.
R4.2 An unverified account that was registered normally and signs in over the relay from IR becomes relayUnverified. Over normal routes it still gets requiresVerification.
R4.3 Recovery-code reset is a new endpoint, POST /customer-auth/reset-password-recovery. It uses the same GuessBudget as reset by code and goes on the relay allowlist. Every account can create or rotate a recovery code in Settings (re-authentication required), and the app suggests it to users in Iran.
R4.4 What will not work during the intranet, said in the UI:
- email reset, unless the mailbox opens domestically
- Google, Apple and Facebook sign-in
Outside the intranet, social sign-in over the relay counts as verified by the provider and follows normal rules.
R4.5 During a declared intranet and for 30 d after it, there is no idle-session pruning and no device-credential reclaim for customers with an active relayOnly subscription.
R4.6 Device-slot calls never go over the relay. The control plane never gates a connect.

5 PAYMENT
R5.1 Add voucher preview and redeem to all three allowlists. Over the relay, or from an unverified account, only single-use relayOnly codes are accepted; anything else is refused and not spent.
R5.2 [A] During the intranet, Ultimate is sold by voucher only. Resellers pre-mint stock, because the reseller panel is abroad.
R5.3 Subscribers to other plans are told plainly that their servers are outside Iran. No automatic relay grant [A].
R5.4 iOS: the store build cannot redeem (guideline 3.1.1), and the App Store is unreachable during the intranet. iPhone users must redeem on another device. This is a stated gap.

6 RELAYS AND SERVER LIST
R6.1 Ultimate gets relay routes only: IPv4 literals, no CDN variants, no names under blocked domains.
R6.2 Control-plane boxes:
- at least 3, on at least 2 providers/ASNs
- seeded in every release, with a standby pin
- refreshed through signed bundle2 (chain at v100 or higher) and never accepted unsigned
- rotated through the signed-in response [A]
R6.3 VPN relay credentials come per account through protocol-users and are cached. If every control-plane box is dead, new users cannot join, while existing Ultimate users keep connecting.
R6.4 A signed app build must be downloadable domestically before any shutdown. Where is the owner's call.

7 DETECTION AND THROTTLING
R7.1 Control plane:
- 443 only, TLS 1.3 with h2.
- ssl_preread routes no-SNI to the passthrough, any SNI to a plausible decoy, and closes non-TLS.
- Each box has its own origin keypair with a generic subject.
- A request without the relay key gets the generic nginx 404. This deters scans, not someone who reverse-engineers the app.
- Box-to-origin moves to 443 on a second origin IP, or to REALITY via a node that serves no customers.
- The handshake shows international RTT [U, accepted].
R7.2 VPN relay:
- REALITY first, with a domestic dest.
- Port profile: 443 plus SSH.
- Shadowsocks last, with a per-box toggle, off by default [A].
- Relay-to-exit: REALITY with the chrome fingerprint, no mux, load spread across exits.
- Consolidating the inbounds onto one is a separate design [U].
R7.3 Budgets and alerts:
- Ultimate dataCapBytes is set.
- Each box has a daily quota, with panel-host alerts at 50% and 80%.
- Each box has a sign-up rate alert.

8 UI (calm, en/fa)
Calm-UI rules:
- The backup-route chip is neutral and steady for the whole relay mode, and never changes the orb or the headline.
- The verification reminder is neutral, not a warning colour.
- "...including the backup server" appears only if the relay was actually dialled.
- "Reset code" (emailed, کد بازنشانی) and "recovery code" (کد بازیابی) are never conflated.
- Use the app's existing Persian term for voucher.
Strings:
- Consent: "Neoxify can't be reached the usual way on this network. Use our backup server inside Iran? Your data stays encrypted; the server's host can see that this device connected, not what it sent." / «در این شبکه دسترسی به نئوکسیفای از راه معمول ممکن نیست. از سرور پشتیبان ما در داخل ایران استفاده شود؟ اطلاعات شما رمزگذاری‌شده می‌ماند؛ میزبان این سرور فقط می‌بیند که این دستگاه وصل شده، نه آنچه فرستاده شده.»
- Sign-up: "You're signing up through the backup route, so email confirmation is skipped for now. Use an address you can open later — you'll need it to confirm and recover your account." / «ثبت‌نام از مسیر پشتیبان انجام می‌شود، پس فعلاً تأیید ایمیل لازم نیست. نشانی‌ای وارد کنید که بعداً بتوانید باز کنید؛ برای تأیید و بازیابی حساب به آن نیاز دارید.»
- After sign-up: "Account created. Until you confirm your email, this account can use only the Ultimate plan. Enter an Ultimate voucher code." / «حساب ساخته شد. تا وقتی ایمیل خود را تأیید نکنید، این حساب فقط می‌تواند از طرح Ultimate استفاده کند. کد کوپن Ultimate را وارد کنید.»
- Recovery code: "Save this recovery code somewhere safe. If you can't open your email, it is the only way to reset your password. It is shown only once." / «این کد بازیابی را جای امنی نگه دارید. اگر به ایمیل خود دسترسی ندارید، تنها راه بازنشانی رمز عبور همین کد است. این کد فقط یک بار نمایش داده می‌شود.»
- Reminder: "Confirm your email to unlock all plans and payments. Your current plan is not affected." / «برای دسترسی به همهٔ طرح‌ها و روش‌های پرداخت، ایمیل خود را تأیید کنید. طرح فعلی شما تغییری نمی‌کند.»
- Reset: "The reset code is sent by email. If you can't open your email, use your recovery code." / «کد بازنشانی با ایمیل فرستاده می‌شود. اگر به ایمیل خود دسترسی ندارید، از کد بازیابی خود استفاده کنید.»
- Region: "The backup route is only for connections from inside Iran." / «مسیر پشتیبان فقط برای اتصال از داخل ایران است.»
- Disconnect: "Disconnect to use the backup route." / «برای استفاده از مسیر پشتیبان، اتصال را قطع کنید.»
- Blocked (shown whenever the intranet is not declared): "Neoxify's usual routes are blocked on this network." / «راه‌های معمول نئوکسیفای در این شبکه مسدود است.»
- Chip: "App data: backup route" / «داده‌های برنامه: مسیر پشتیبان»

9 PRIVACY AND SECURITY
R9.1 The box sees which IPs connected and when, and nothing else. TLS runs end to end with SPKI pins, and the box keeps no logs.
R9.2 If a box is seized, an attacker can log connecting IPs from then on, deny service, and forge PROXY IPs (bounded by the per-ASN and global caps and PoW). They cannot read or MITM traffic. Response: firewall the box out at the origin and rotate through the signed bundle.
R9.3 The VPN relay boxes hold the agent key and the REALITY keys. Their 1-day access log should go off [A].
R9.4 Commit sanitized nginx templates, with no IPs.

10 PHASES
P0: owner decisions, and testers measuring relay reachability on MCI, Irancell and TCI.
P1 backend, deployed first:
- the marker, the allowlist middleware and the region lookup
- the schema and the default-deny guard
- the recovery code, the caps, the voucher rule and the sweep pause
- nginx
Tests:
- the policy matrix
- a request from another container, with the marker missing or forged, is refused
- a non-IR caller is refused
- a multi-use voucher is refused for an unverified account and not spent
- the guard denies every /customer route that is not allowlisted, with the list enumerated from the router so a new endpoint fails the test
- no relay IP is persisted
P2 client: merge claude/relay-client and claude/relay-bundle-backend, add last-resort.ts, the screens and the strings. Tests:
- zero relay calls while a normal base is healthy
- the gate holds in every tunnel state
- no relay use before consent
- a RELAY_REGION refusal turns the relay off for that network
P3 (separate): VPN relay consolidation.
Proof gate on the VM: block every normal base, then do relay sign-up, voucher and connect.
- pktmon must show only the relay before connect.
- The exit IP must match the exit node.
- The backend must log via=relay with the real ASN and store no IP.
Stays [U] until shown on it: real Iranian ISPs, the intranet itself, Android devices, iOS.
