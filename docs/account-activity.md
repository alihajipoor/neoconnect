# Account activity and the Android update check: the API contract

Status: backend on `claude/ui-features`, **unit-tested only**. The daily
usage SQL also runs against a migrated, empty Postgres in CI
(`daily-usage.db.spec.ts`). No client calls any of this yet, and nothing
here has met production data. It has to be **deployed before** a client
that uses it is released (the clients must also cope with a 404 from a
backend that does not have it yet).

This is what the Activity screen (Devices on your plan, Daily usage) and
the Android update notice are built against. Change the two together.

All routes are relative to the API base the app already uses. The
`/customer/*` routes take the customer access token
(`Authorization: Bearer <access>`), like every other `/customer/*` call.
They are **not** open to an account the relay let in unverified (403
`VERIFY_EMAIL`) and are **not** on the relay allowlist: neither is needed
to connect, so over the backup route they are a 404. The client shows the
card's offline/unavailable state for those, never an empty list or a
zero.

## `GET /customer/devices`

The devices signed in to this account.

```json
{
  "inUseKnown": true,
  "devices": [
    {
      "id": "Jx8m1Q2sV0d9kLr3TqYw5a",
      "thisDevice": true,
      "label": null,
      "platform": "windows",
      "signedInAt": "2026-10-02T09:14:07.000Z",
      "lastSeenAt": "2026-10-19T11:58:30.000Z",
      "inUse": { "since": "2026-10-19T10:02:11.000Z", "lastSeen": "2026-10-19T11:58:30.000Z" }
    },
    {
      "id": "b7Kq0zP4c2Ww9eRt1yUi8o",
      "thisDevice": false,
      "label": "Pixel 7",
      "platform": "android",
      "signedInAt": "2026-09-28T17:40:00.000Z",
      "lastSeenAt": "2026-10-19T07:21:44.000Z",
      "inUse": null
    }
  ]
}
```

- **Signed in** means not signed out, and refreshed within the refresh
  token's lifetime (`CUSTOMER_JWT_REFRESH_TTL`, 7 days by default): a
  device idle longer has to sign in again, so it is not listed -- unless
  it still holds a device slot (a phone's always-on tunnel nobody opens
  the app on). The calling device is always listed.
- `id` is opaque and stable; it is **not** the session id (a session id
  is never handed to another device, docs/device-slots.md). Use it only
  for `DELETE` below.
- `label` and `platform` follow docs/device-slots.md, *Naming a device on
  screen*: `label` when not `null`, otherwise the platform's name in the
  app's language, otherwise "another device".
- `lastSeenAt`: the last time the server heard from the device -- a token
  refresh, or while it holds a slot, a renewal or its tunnel's traffic.
- `inUse`: the device holds a device slot it is using now (renewed or
  carried traffic in the last 90 s). **Only a non-null `inUse` says
  anything.** Show "In use now" for it; say nothing about the others.
  `null` is not "not in use": an app from before slots, or one that
  dialled while the API was unreachable, connects without one.
- `inUseKnown: false` -- an unlimited plan, no active plan, or slots
  switched off -- means no slot is kept that could say; every `inUse` is
  then `null`. Word the card so it does not imply nothing is in use.
- Order: this device, then the ones in use, then the most recently seen.
- Never in the response: an address, a node, a location, a session id,
  or how the device signed in.
- 30 requests a minute per signed-in device.

## `DELETE /customer/devices/:id`

Signs another of this account's devices out, exactly as it signing
itself out would: its session is revoked, its own VPN credentials are
taken off the nodes, its slot is freed. Its next refresh is refused and
its app signs out. A tunnel on the subscription's *shared* credentials
(an app from before per-device credentials) is not ended by this.

- **204** done.
- **400** `{"code": "THIS_DEVICE"}` -- the caller's own device. Use
  `POST /customer-auth/logout`, with the app's own teardown.
- **404** -- not one of this account's signed-in devices (already signed
  out, another account's, or not an id).
- 10 requests a minute per signed-in device.

**Owner decision pending** on whether the apps offer this ("Sign out of
this device" on a row). The endpoint exists so that decision needs no
backend release; no client may expose it until it is made.

## `GET /customer/subscriptions/:id/usage?days=30&tz=Asia/Tehran`

Data used per day on one of the customer's subscriptions, every device
together.

| Query | |
|---|---|
| `days` | 1 to 31, default 30. Today and the `days - 1` before it. |
| `tz` | An IANA zone name, default `UTC`. Send the device's own (`Intl.DateTimeFormat().resolvedOptions().timeZone`). |

```json
{
  "subscriptionId": "6f1c...",
  "timeZone": "Asia/Tehran",
  "from": "2026-10-14",
  "to": "2026-10-20",
  "asOf": "2026-10-19T21:00:00.000Z",
  "days": [
    { "date": "2026-10-14", "bytesUp": "0", "bytesDown": "0" },
    { "date": "2026-10-19", "bytesUp": "18341120", "bytesDown": "734003200" },
    { "date": "2026-10-20", "bytesUp": "5120", "bytesDown": "51200" }
  ]
}
```

(`days` shortened above; it holds every date from `from` to `to`.)

- Days are calendar days **in `tz`**, split at that zone's real midnight
  (20:30 UTC for Tehran), Gregorian `YYYY-MM-DD`. Render them in the
  reader's calendar (Solar Hijri in Persian). The last day is today so
  far.
- `from` is never before the day the subscription was created.
- Byte counts are **decimal strings** (a day can pass 2^53). `0` means
  nothing was recorded that day.
- Read from what the nodes reported against this subscription's
  credentials, every ~30 s while traffic flows -- the same records that
  count against the cap. Nothing is estimated, so the card must say
  **as recorded**, and must not present the sum of the days as the plan's
  used total (that is the subscription's `dataUsedBytes`). Two things are
  not in the days: traffic a node could not tie to a credential (a
  relay's shared uplink), and the records of a node an admin deleted
  (`NodesService.remove` deletes them; the subscription's total keeps
  them).
- **400** for `days` outside 1-31 or not a number, or a query field not
  listed here; **400** `{"code": "UNKNOWN_TIME_ZONE"}` for a zone the
  server does not know. **404** for a subscription that is not the
  caller's.
- 30 requests a minute per signed-in device.

## `GET /updates/android/:arch/:currentVersion`

The Android app's update check -- **direct-download (APK) builds only**.
A Play or App Store build must never call it: the store updates those,
and this cannot tell them apart. Unauthenticated, like the Windows check.
`:arch` is not used (the APK is universal).

- **200** `{"version": "0.2.29", "downloadPath": "/updates/installer/android"}`
  -- a newer APK is published. The notice's Download opens `downloadPath`
  against the API base the app used (often a node mirror in Iran) in the
  browser, which redirects to the newest APK; Android then asks to
  install it. Nothing is installed silently.
- **204** -- the app is on the newest APK.
- **503** -- the release feed could not be read. Not "up to date": show
  nothing and ask again later.
- **400** -- `currentVersion` is not `x.y.z`.

Until this existed the Android check answered 204 for every version,
which nothing had compared. Other non-Windows targets (the macOS
updater's `darwin`) still answer 204: nothing is published for them.

## What is unverified

- No client has called any of it; nothing has run against production
  data or a real device.
- Whether the device list matches `customer_sessions` and the slots for a
  real account: after deploying, list a test account's devices from two
  devices and compare with its `customer_sessions` rows (named columns
  only).
- Whether a day's total matches a known download over the tunnel: after
  deploying, download a known size and compare that day's total with the
  sum of its `usage_records` rows.
