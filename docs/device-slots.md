# Device slots: the plan's device limit

Status: backend implemented on `claude/per-device-credentials`; the
Windows and mobile clients implement this revision on
`claude/device-slots-mobile`. **Unit tests only**: no client has reached
the real backend, and nothing here has run against a real node, phone or
censored network -- see *What is unverified* at the end.

This document is the contract. The desktop and mobile apps are built
against it, not against the backend code; change the two together.

## The rule

Owner decisions, 2026-10-06:

- A plan's `maxConcurrentConnections` is how many of the customer's
  devices may **use the VPN at the same time**: "if someone uses the VPN
  on their PC, they shouldn't be able to use the VPN on the phone at the
  same time if the plan limit is 1". Production today: Starter 1, Pro 2,
  Trial 2, Ultimate and Ultimate Max unlimited.
- **Option A.** The second device is refused *before it connects*, told
  where Neoxify is in use, and offered **Use on this device instead**,
  which ends the other device's slot. The device taken over is told why
  and does **not** run its failover ladder.
- Signing in is not using: how many devices may be *signed in* is a
  separate, hidden safety cap of 10 (see `docs/per-device-credentials.md`).

## How it works

1. Before dialling, the app **claims** a slot on the subscription it is
   connecting with.
2. Granted: it dials, and **renews** the slot every `renewEverySec` while
   connected.
3. Refused (409 `DEVICE_LIMIT`): it does not dial. It shows where Neoxify
   is in use. If the customer chooses **Use on this device instead**, it
   claims again naming the other device's `handle` in `takeover`, and
   dials.
4. The device taken over learns it on its next renewal (`status:
   "displaced"`), disconnects, and says why.
5. On Disconnect the app **releases** its slot.

A slot whose device has neither renewed nor carried traffic for
`staleAfterSec` (90 s) is free: the next claim gets it without asking.
A phone in the background that cannot renew keeps its slot through its
tunnel's own traffic (WireGuard and OpenVPN keepalives are enough), for
as long as the traffic lasts -- days, if the app is never opened.

**The control plane is never a precondition for connecting.** An app
that cannot reach the API -- in Iran, often -- dials anyway and claims
once it can (through the tunnel). Enforcement then arrives a few seconds
late, by renewal, or not at all if the API stays unreachable; the
node-side backstop (below) covers that gap.

## Base URL, authentication, device identity

- Paths are relative to the same API base URL the apps already use for
  `/customer/protocol-users` and `/customer/subscriptions`.
- Every call is authenticated with the customer access token, exactly
  like the other `/customer/*` calls (`Authorization: Bearer <access>`).
- **The device is the session in the access token** (`sid`, issued at
  sign-in since 2026-10-05). Nothing in the body identifies the device,
  and one device cannot claim, renew or release for another.
- A token from before sessions existed names no device. Such a claim is
  answered `200` with `enforced: false`: go ahead, nothing is recorded.
  (The first refresh moves such a token onto a session.)

### Headers the app sends

Send both on **sign-in** (`POST /customer-auth/login`,
`POST /customer-auth/social`), on **refresh** (`POST
/customer-auth/refresh`) and on **claim** (`POST /customer/vpn/claim`).
They name the device to the customer's *other* devices: "Neoxify is in
use on Windows PC since 14:02".

| Header | Value |
|---|---|
| `X-Neoxify-Device-Platform` | `windows`, `macos`, `linux`, `android` or `ios` (case-insensitive). Anything else is ignored. Always send it. |
| `X-Neoxify-Device-Label` | Only what the platform does not say: a **model** (`Pixel 7`, `Galaxy S24`, `iPad`) or the user's own name for the device. Omit it when there is neither. ASCII, or UTF-8 **percent-encoded** (`encodeURIComponent`) for anything else -- HTTP header values are Latin-1. |

Rules for the label:

- **Never the device's kind.** `Windows PC` or `Android phone` is English,
  and the device that shows it may be in Persian: the kind is named by
  the reader, from `platform`, in its own language. The backend drops a
  generic kind (`Windows PC`, `Mac`, `Linux PC`, `Android phone`,
  `iPhone`, ...) to `null`, and keeps only the model out of `Android
  phone (Pixel 7)` -- the form the apps were first built to send.
- **Never a hostname, computer name or account name.** It is shown on
  other devices and a machine name is personal -- often the owner's own
  name. The backend also drops anything that looks like one
  (`ali-laptop.local`, `DESKTOP-7H3K2L9`), but that is a backstop, not
  permission.
- Control characters are stripped, whitespace collapsed, and the label is
  cut to 48 characters.
- Sending neither header leaves the name as it was.

**Naming a device on screen** (`holders[]`, `by`): in the app's own
language, `label` when it is not `null` -- a model or the user's words,
shown as sent -- and otherwise the platform's name (`windows` → "Windows
PC" in English, `android` → "Android phone", `ios` → "iPhone", `macos`
→ "Mac", `linux` → "Linux PC", each in the app's language); with
neither, "another device".

The browser sign-in flow (Google/Facebook through the system browser)
cannot send headers when the session is created; the device is named by
its first refresh or claim.

## Endpoints

All bodies are JSON. Unknown fields are rejected with 400 (the API's
validation forbids them), so do not send extras.

### `POST /customer/vpn/claim`

Before dialling.

Request:

```json
{
  "subscriptionId": "6f1c...-uuid",
  "protocolUserId": "a2b4...-uuid",
  "takeover": ["Qm9yZWQ0aGFu"]
}
```

| Field | Required | Meaning |
|---|---|---|
| `subscriptionId` | yes | UUID of the subscription being connected with (`GET /customer/subscriptions`). |
| `protocolUserId` | no | The `id` of the credential about to be dialled (`GET /customer/protocol-users`). Send it. When it is one of the subscription's shared credentials (the device's own one is not confirmed on that node yet), traffic on it then counts as this device's. |
| `takeover` | no | Handles from a 409's `holders`, after the customer chose **Use on this device instead**. At most 16, each at most 64 characters. Only holders named here can be displaced, and only as many as it takes to make room -- the least recently seen first. Send every handle shown to let the server pick (on a plan of two, one device goes, not both), or one handle if the customer picked a device. If there is room by the time it arrives, nobody is displaced. |

**200 -- granted.**

```json
{
  "granted": true,
  "enforced": true,
  "subscriptionId": "6f1c...",
  "limit": 1,
  "handle": "Zm9vYmFyYmF6",
  "renewEverySec": 60,
  "staleAfterSec": 90
}
```

- `enforced: false` (with `handle: null`) means nothing was recorded:
  the plan is unlimited (`limit: null`), the token names no device, or
  slots are switched off (`DEVICE_SLOTS=off`). Dial; renewing is
  harmless but pointless.
- Claiming again while holding the slot keeps the slot and answers
  `200` with a **new** `handle`. Keep the handle of the latest grant
  (claim, or a `renew` that re-granted): `release` names it. Another
  device's takeover may still name the previous one.

**409 -- `DEVICE_LIMIT`.** The plan's devices are all in use. Do not dial.

```json
{
  "statusCode": 409,
  "code": "DEVICE_LIMIT",
  "message": "Your plan allows 1 device at a time.",
  "limit": 1,
  "holders": [
    {
      "handle": "Zm9vYmFyYmF6",
      "label": null,
      "platform": "windows",
      "since": "2026-10-06T10:32:04.120Z",
      "lastSeen": "2026-10-06T10:55:41.004Z"
    }
  ]
}
```

- `holders` are the devices using the slots: `since` is when each got its
  slot, `lastSeen` when it last renewed or carried traffic. Format times
  in the device's locale and time zone. `label` is often `null`: name
  the device from `platform` (see *Naming a device on screen*).
- `message` is an English fallback. Word the card from `limit` and
  `holders` in the app's language.
- **Never a 401.** The apps end the session on 401; a refusal is not a
  sign-out.

**409 -- `SUBSCRIPTION_INACTIVE`.** `{"statusCode": 409, "code":
"SUBSCRIPTION_INACTIVE", "message": "...", "subscriptionStatus":
"EXPIRED"}` -- the subscription is `SUSPENDED`, `EXPIRED`, `CANCELLED` or
`PENDING`. Show the plan-ended state the app already has.

**429 -- `TAKEOVER_LIMIT`.** `{"statusCode": 429, "code":
"TAKEOVER_LIMIT", "message": "...", "retryAfterSec": 1260}` -- more than
30 takeovers on this subscription in the last hour. Only a claim *with*
`takeover` can get this code. Say so; do not retry automatically.

**429 without a `code`** -- the request limit (see *Request limit*), not
a refusal. Before dialling it means dial anyway, like a timeout.

**401** -- this device has been signed out (its session is revoked or
gone). Handle like any other 401: the session has ended.

**404** -- not one of this customer's subscriptions. **400** -- the body
is malformed.

### `POST /customer/vpn/renew`

Every `renewEverySec` while connected.

Request: `{"subscriptionId": "6f1c..."}`

**200** with a `status` (below). Never 409 for the limit. A renewal
answered with anything else -- no answer, a 5xx, a 429, a 404 -- changes
nothing: keep the tunnel and try again at the next interval. (A 401
still means the device was signed out, as everywhere.)

```json
{ "status": "held", "enforced": true, "subscriptionId": "6f1c...", "limit": 1,
  "handle": "Zm9vYmFyYmF6", "renewEverySec": 60, "staleAfterSec": 90 }
```

```json
{ "status": "displaced", "subscriptionId": "6f1c...", "limit": 1,
  "by": { "handle": "YmF6cXV4", "label": "Pixel 7", "platform": "android" },
  "at": "2026-10-06T11:02:13.551Z" }
```

```json
{ "status": "inactive", "subscriptionId": "6f1c...", "subscriptionStatus": "SUSPENDED" }
```

- `held`: carry on. A slot that had lapsed while the device was quiet is
  given back here if there is room, with a new `handle` -- and so is one
  taken over by a device that has since left (disconnected, signed out,
  or neither renewed nor carried traffic for `staleAfterSec`).
- `displaced`: another device has the slot -- it took it over at `at`,
  or got it after this device went quiet. `by` names it. Answered only
  while it is true: a takeover is reported while the device that took
  the slot still holds it and there is no room for this one, naming
  that device; once it has left, `displaced` names whichever device
  holds the slot now (`at` is when that one got it), and if none does
  and there is room, the answer is `held` instead.
- `inactive`: the subscription is no longer active.

### `POST /customer/vpn/release`

When the customer presses Disconnect. Fire and forget.

Request: `{"subscriptionId": "6f1c...", "handle": "Zm9vYmFyYmF6"}`, or
`{"handle": "..."}` / `{}` for this device's slot on every subscription.

`handle` is the one from the grant being given back -- the latest claim,
or the `renew` that re-granted. Send it. A release is fire and forget,
and the request can still arrive seconds after the customer pressed
Connect again; that new claim gave the slot a new handle, so the late
release, naming the old one, frees nothing. Without `handle` the slot is
freed whatever grant it is under (older behaviour, kept for apps that do
not send it).

Response: **204**, no body. (404 for a subscription that is not the
customer's.)

### `GET /customer/subscriptions` -- `deviceLimit`

Each subscription now carries `deviceLimit`: the plan's limit, or `null`
for unlimited. Use it to word "Your plan allows 1 device at a time"
before any refusal, and to skip claiming entirely when it is `null` if
the app wants to save a round trip (claiming is still correct).

```json
[{ "id": "6f1c...", "status": "ACTIVE", "planId": "...", "expireAt": "...", "deviceLimit": 1 }]
```

### Request limit

The three endpoints allow 60 requests a minute **per device** (per
access token), not per address: customers reaching the API through a
node's mirror or through the tunnel share that node's address, and so
do customers behind one carrier-grade NAT. Past it the answer is a 429
with no `code` (`ThrottlerException: Too Many Requests`). It is never a
refusal of the device -- see obligation 2.

## Timings

| What | Value | Where it comes from |
|---|---|---|
| Renew interval | 60 s | `renewEverySec` in every grant -- use the value sent |
| A holder is stale (its slot is free without asking) | 90 s with no renewal **and** no traffic | `staleAfterSec` |
| Claim budget before dialling anyway | 3 s | client side |
| Release budget | 1.5 s or less, never delaying teardown; once more, 1.5 s, after the teardown if unanswered | client side |
| Status check when the tunnel degrades (below) | 4 s | client side |
| Takeovers logged for the admin | more than 10 per subscription per hour | server |
| Takeovers refused (429) | more than 30 per subscription per hour | server |
| Backstop grace for a device just taken over | 90 s (none if it had itself taken over in the last 5 min) | server |

## Client obligations

1. **Claim before dialling**, after refreshing the connection config and
   before tearing down anything. Send the device headers and the
   `protocolUserId` of the credential about to be dialled.
2. **Never let the claim block a connect.** Exactly three answers stop
   the dial: **409 with `code` `DEVICE_LIMIT`**, **409 with `code`
   `SUBSCRIPTION_INACTIVE`**, and **429 with `code` `TAKEOVER_LIMIT`**
   (only after a takeover). A 401 ends the session, as everywhere.
   Anything else -- no answer within 3 s, a network error, a 5xx, a 429
   or 409 without one of those codes, a 404 -- means dial anyway, and
   claim again once the tunnel is up (through it). That later claim can
   be refused too, over a working tunnel: see item 11.
3. **On 409 `DEVICE_LIMIT`**, do not dial. Show, in the app's language:
   "Your plan allows *{limit}* device(s) at a time. Neoxify is in use on
   *{device}* since *{since}*." with **Use on this device instead** and
   **Cancel**. *Use here* claims again with `takeover` = the handles shown
   (the server frees one slot, from the device least recently seen), then
   dials. On a plan of more than one the app may let the customer pick
   which device instead, and send only that handle. Model it on the
   plan-ended card.
4. **Keep the status and the `code`.** A 409 is not a sign-out and not a
   network failure. (The desktop's `apiRequest` currently reduces every
   failure to a message; it has to keep both.)
5. **Classify a refusal as a concurrency limit, not a failed dial**: it
   must not be recorded as a failure in the per-ISP evidence or the
   attempt history, must not move "best route", and must not start the
   failover ladder.
6. **Renew every `renewEverySec` while connected**, in the foreground.
   Mobile apps need not renew in the background; traffic keeps the slot.
   A renewal that is not answered 200 -- unreachable, 5xx, 429, anything
   but a 401 -- changes nothing: keep the tunnel.
7. **On `displaced`**: disconnect, show "Disconnected: Neoxify is now in
   use on *{device}*." with **Use on this device instead**, and **do
   not run the failover ladder** (it would only take the slot back or
   fail). On `inactive`: disconnect and show the plan-ended state.
8. **On Disconnect, release** -- fire and forget, at most 1.5 s, never
   delaying teardown -- naming the `handle` of the latest grant, so a
   release that lands after the next Connect's claim frees nothing.
   Sign-out releases the slot on the server by itself; no separate call
   is needed.
   Sent before the teardown, so it goes through the tunnel while the
   tunnel is up -- on a filtered network the likeliest way to reach the
   API. The teardown does not wait for it, and so usually takes it down
   before it is answered: on the Windows test VM (2026-10-10) none of four
   was answered, and the panel host's access log shows two of the four
   arriving, none from the run where only the tunnel reached Neoxify. A
   release that got no answer is therefore sent once more when the
   teardown is over, on the bare line, with its own 1.5 s -- the same
   handle, so it frees nothing if the first arrived or a Connect has been
   granted since, and not sent at all once a Connect or a sign-out has
   started. Where the bare line cannot reach the API either, the slot
   goes stale after 90 s, as before.
9. **When the tunnel degrades and this device was unclaimed or
   displaced**, do not run the ladder blindly: tear down, call `renew`
   with a 4 s budget, and if it answers `displaced`, show that. If it
   cannot be reached, say so honestly ("We couldn't reach Neoxify to
   check. If Neoxify is in use on another of your devices, your plan's
   limit of *{limit}* may be the reason.") and then run the ladder as
   usual. Never claim a server "couldn't be reached" if it was never
   dialled -- nor if it answered: a 5xx, a 404, a 429 or a 200 with a
   status the app does not know is an answer without a verdict, and
   the honest note then is that Neoxify could not confirm this device's
   place right now, not that it could not be reached.
10. **The label is a model or the user's own words** -- never the device's kind and never a hostname; *{device}* is named as *Naming a device on screen* says (see *Headers*).
11. **A claim refused after connecting.** When the claim before dialling
    went unanswered (item 2), the device is already connected when its
    claim through the tunnel is answered -- and in Iran that will be the
    common path. The answer is final, as it would have been before
    dialling:
    - **409 `DEVICE_LIMIT`**: handled like `displaced` (item 7). Tear
      the tunnel down, **do not run the failover ladder**, record **no
      attempt and no best route** (item 5 -- the dial worked; the plan
      refused the device), and show the refusal card of item 3 with
      **Use on this device instead** and **Cancel**. *Use here* claims
      with `takeover`, then dials again. Never leave the tunnel up over
      a refusal, and never show the card over a tunnel still carrying
      traffic.
    - **409 `SUBSCRIPTION_INACTIVE`**: tear down the same way, no ladder,
      and show the plan-ended state.
    - Anything else (no answer, 5xx, a codeless 429): keep the tunnel
      and renew at the next interval. A `renew` from a device holding no
      slot grants one if there is room, and answers `displaced` (item 7)
      if there is not.

Where this lands in the apps (from the design review; line numbers drift):
desktop `runLadder` in `apps/desktop-windows/src/screens/Dashboard.tsx`
(claim after the config refresh, before teardown; renew on every 4th
health poll; release on the Disconnect press; suppress the automatic
ladder on `displaced`), `src/lib/api.ts` (keep status and code),
`src/lib/attempts.ts` / `src/lib/connection-errors.ts` (a
`concurrentLimit` class that records no dial); mobile
`apps/mobile/src/screens/Dashboard.tsx` (`runLadder`, the toggle, the
poll).

## Server behaviour, for reference

- Changes to one subscription's slots happen one at a time (two devices
  pressing Connect at once: exactly one is let in). State is in Redis,
  with a fallback to the backend's memory if Redis cannot answer -- one
  backend instance, as elsewhere.
- A slot is freed by: release; sign-out of that device; a password
  change or reset (every other device); an admin setting the password
  (every device); the device cap evicting that device; the hourly sweep
  of signed-out and long-idle sessions; suspension or expiry of the
  subscription; deleting the account; or 90 s of silence. Whatever path
  signed a device out, a holder whose session is revoked or gone is
  never counted -- a refusal never names a device that cannot connect.
- `DEVICE_SLOTS=enforce` (default) or `off` (every claim granted,
  nothing recorded). Empty means the default. Only apps that claim are
  affected, so the switch is safe to leave on before any app ships it.

## The backstop (node side)

Slots only bind apps that claim. The backstop is for the rest -- an old
release, credentials copied into a third-party client -- and runs on
what nodes already report every ~30 s: usage bytes per credential, and
session counts from OpenVPN only. Xray's and WireGuard's session counts
are ignored: both carry a tail (60 s after the last accepted
connection, three minutes after the last handshake) that made a clean
switch from the PC to the phone look like two devices for long enough
to hold the phone. IKEv2's is ignored too: strongSwan lists an SA until
charon restarts (no DPD, rekey_time = 0s), so a phone that died on
IKEv2 would count as a device in use indefinitely -- the sample captured
from a node had two such SAs, 21 hours old. For those engines a device
is active while its usage shows bytes.

- **Per device.** Every credential of one signed-in device is that
  device, on any route or node. All shared credentials of a subscription
  together are one pseudo-device (attributed to a device that would have
  been handed them, during the transition). A device counts as active
  while it has carried traffic in the last 45 s.
- **When it acts.** More devices active than the plan allows, for three
  readings at least 20 s apart. It picks the excess: a device whose slot
  was taken over (after its 90 s grace, or at once if it had itself
  just taken over), then the shared pseudo-device, then the newest
  device. **Never a device holding a slot**, and never all of them.
  It also acts on a device whose slot was taken over and that is still
  going after its grace while the holders who took its place renew,
  even with no traffic of theirs showing (still dialling, idle) -- and
  then only on that device. A quiet holder counts against nothing else.
- **A grant lifts a hold.** A device let in -- by a claim, a takeover, or
  a renewal that gives a lapsed slot back -- has any hold on its
  credentials, and on the shared credential it named, lifted before its
  grant is answered, and those credentials are put back on their nodes
  at once (the app dials straight after). A hold found on a slot
  holder at any later reading is lifted the same way.
- **`CONCURRENCY_CUT=shadow` (default):** it logs `[shadow] Subscription
  ...: N devices active against a limit of L; would hold device <session>`
  -- at most once per ten minutes per subscription -- and sends nothing.
- **`CONCURRENCY_CUT=enforce`:** it holds the device -- a `DISABLE_USER`
  on each of its credentials, on that credential's own inbound, and a
  90 s lease (`protocol_users.heldUntil`) that the 60 s re-assert skips.
  The lease is renewed while the devices not held fill the limit
  (counting, for a device taken over, the holders that renew), and
  lapses on its own once they do not; the next re-assert then puts the
  credentials back, as they are at that moment. A held device on a
  censored network is back within about two and a half minutes of the
  other device going quiet, with no control plane on its side.

Switch to `enforce` only after a week of shadow logs shows no "would
hold" against a device that holds a slot, and after the rig tests below.

## What is unverified

Everything that is not a unit test. Proven: backend unit tests of the
slot logic over an in-memory store; an HTTP-level test of this contract
on a real Nest server with the production validation pipe; the built
backend boots and maps the three routes. **Unverified:**

- The apps claim, renew and release in unit tests only. Nothing on this
  page has been seen from a client against the real backend.
- No Redis has held a slot. The migrations have been applied only to
  CI's empty Postgres (they apply, and match the schema), never to a
  database with real data.
- The backstop has never seen a real node's report. Whether presence
  from usage deltas is as clean as reasoned (keepalives every 25 s,
  pings every 10 s) is inferred from the agent and client code, not
  measured. IKEv2 usage was always empty before the 2026-10-06 parser
  fix (it matched nothing swanctl prints); the fixed parser reads output
  captured from a node, but usage reaching the backend from a real dial
  has not been seen.
- Xray connections already open when a hold starts may keep working
  (Xray cannot close a user's connections). Unmeasured.
- An iPhone, an Android phone with the screen off, and an Iranian
  network: none tested.

The design's test plan (false-positive soak per protocol, the PC-then-phone
scenario, takeover with captures, switching, a censored path, clients that
do not claim, long Xray downloads, IKEv2, a backend restart during a hold,
Android in the background) is in the design review and needs the rig and
a test account on Starter.
