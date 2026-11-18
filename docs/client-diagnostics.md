# Client diagnostics: fuller reports, the service check, diagnostics bundles

Status: **stage A, backend only**, on `claude/client-diagnostics`. The
server can receive, store and show everything below. **No app sends any
of it yet**; the apps are a later stage, built against this document.
Unit tests only: the migration has not yet run against Postgres (CI is
its first run), and nothing here has met a real client, phone or
censored network -- see *What is not proven* at the end.

This document is the contract. The apps are built against it, not
against the backend code; change the two together.

## Why

The connect report (`POST /client-attempts`) says what happened: which
server and protocol, which rung failed and in what words. It does not say
what the device was standing on -- which network type, whether another
VPN held it, which DNS it was using, whether the data check moved bytes
up or only down, how long each server try took -- and support has had to
ask for screenshots to learn it. Nor could anyone see whether, through a
given server, the services customers actually open (Instagram, WhatsApp,
Telegram, Google) loaded at all. Two additions answer that:

- **Details** on the reports the apps already send: device, network and
  tunnel settings, the data check, the egress check, the reconnect state,
  why a session ended, and how long each rung took.
- **The service check**: a short, fixed list of well-known targets the
  app tries, through the tunnel or directly, with how far each got (DNS,
  connect, TLS, HTTP) and how long each stage took.

And one thing the customer does on purpose: **Send diagnostics**, a
bundle with an optional note and (on Windows and Linux) the text the
"Copy diagnostics" button already shows them, answered with a short
reference to quote to support.

## THE BOUNDARY

Owner decision, and what the privacy page promises:

> Nothing may store or show which sites, domains or addresses a customer
> visits or looks up.

The only names and addresses this feature may hold are:

1. **Settings of the device**: its DNS server addresses, and Android's
   Private DNS hostname. These are configuration, not browsing.
2. **Neoxify's own servers and API**: which route a report was about,
   as before.
3. **Results for a fixed list of test targets that the server chooses**
   (`apps/backend/src/modules/client-attempts/service-check-targets.ts`).

How the server holds the line, rather than trusting the app to:

- Every field of `details` is declared and bounded. The global
  ValidationPipe rejects any key that is not, at any depth, so there is
  no free-form slot to put a visited address in. The address fields
  (`net.dns`, `services[].address`) accept IP literals only; `tunnel.dns`
  accepts an IP literal or a resolver URL (the app's own DoH/DoT setting),
  nothing else.
- A service result is kept only when its `key` and `host` together
  name one entry of the server's list (the current one or the previous
  one); anything else is **dropped at intake** (`keepServiceResults` in
  `report-details.ts`), and the drop is logged as a count, never with
  the host. The host is stored in the list's own spelling. A modified
  client can send anything the validator accepts; it cannot make the
  server keep a result for a site the server did not choose, nor file an
  allowed host's result under a name of its own (the key is what the
  panel groups by and shows). The readers also skip any key on neither
  list.
- A result's `address` (where the target resolved to) is **stored**,
  when it is an IP literal, with its kind beside it (`addressKind`:
  `public`, `private` (RFC 1918, CGNAT, ULA), `loopback`, `link-local`
  or `reserved` (unspecified, documentation, benchmarking, multicast and
  the rest of 224/3)). It is the answer the customer's line or tunnel
  gave for a name on our list, and it is what tells a poisoned answer
  (which block-page address), a wrong region's edge or an IPv6-only
  answer apart. It is not a visited site: the app reports it only for the
  fixed targets, and the key and host beside it are held to the list.
  Nothing ties the address itself to the target, so a modified client
  can put another address in its own report; that is a customer
  misreporting themselves and is accepted. A first review round removed
  the address for that reason and kept only the kind; it was put back
  because the owner asked for the addresses and the kind alone cannot
  say which block page or which edge answered.
- The free-text fields that remain are the app's own words about its own
  failures (`errorKind`, `services[].error`, the `reason` that already
  existed) and the customer's own note and diagnostics text in a bundle
  they chose to send. The apps must not put a visited address in any of
  them; that is a client rule the server cannot check, and the client
  stage must keep it.

## The wire contract

Old apps keep working unchanged: every addition is optional.

### A. `POST /client-attempts`, new optional fields

Unauthenticated as before (a bearer token, if present, attributes the
report). Validated by `ReportAttemptDto`; an undeclared field anywhere is
a 400, and **the apps count a 400 as delivered and drop the report** --
which is why the backend ships first (see *Rollout*).

- `attempts[].ms`: integer 0..600000. How long that server try took.
- `kind: "SERVICE_CHECK"`: one run of the service check. `outcome` is
  `SUCCESS` when every target was reachable, `OTHER` otherwise. Its
  results are in `details.services`; `routeId`/`protocol` name the
  server it ran through when `details.via` is `"tunnel"`.
- `details` (object, every key optional):

| Key | Shape |
|---|---|
| `device` | `{ model?: string<=64, os?: string<=32, osVersion?: string<=48, language?: string<=16, lowPower?: boolean, dataSaver?: boolean, memFreeMb?: int 0..1048576 }` |
| `net` | `{ type?: "wifi"\|"cellular"\|"ethernet"\|"other"\|"none"\|"unknown", metered?: boolean, ipv4?: boolean, ipv6?: boolean, otherVpn?: boolean, dns?: IP[] (<=4), privateDns?: "off"\|"auto"\|"host"\|"unknown", privateDnsHost?: string<=128 }` |
| `tunnel` | `{ mode?: "full"\|"custom"\|"gaming", dns?: string[] (<=4, each <=80, an IP literal or a resolver URL with scheme https, tls, quic, h3, tcp or udp), splitTunnel?: boolean, ipv6Blocked?: boolean, dnsUnprotected?: boolean }` |
| `errorKind` | string<=40 |
| `dataCheck` | `{ down?: { status: string<=24, bytes: int>=0, ms: int>=0 }, up?: same }` |
| `egress` | `{ state: string<=32, ms?: int>=0 }` |
| `reconnect` | `{ attempt?, quickDeaths?, spentMs?, droppedSecondsAgo? }`, each int >=0 |
| `sessionEnd` | `{ cause: "disconnected"\|"lost"\|"replaced"\|"app_closed"\|"unknown", seconds: int 0..604800 }` |
| `via` | `"tunnel"\|"direct"` |
| `targetsVersion` | int >=0: the list version the app ran |
| `services` | <=16 of `{ key: string<=32, host: string<=128 (key and host must match one list entry), ok: boolean, stage: "dns"\|"connect"\|"tls"\|"http"\|"ok", dnsMs?, connectMs?, tlsMs?, firstByteMs? (each int 0..120000), status?: int 0..999, address?: IP, error?: string<=120 }` |

What is stored:

- `client_attempts.detailsJson`: the validated object, undefined and
  null keys removed (a null is "not reported", the same as leaving the
  key out), services off the list removed (and the `services` key with
  them when none is left), each service's `address` kept only as an IP literal, with
  `addressKind` added. Over **8 KB** serialized (`DETAILS_MAX_BYTES`)
  the whole object is dropped and the report kept, with a warning that
  gives the size and never the content. An object left empty is stored
  as NULL.
- `client_attempts.sessionId`: the `sid` of the bearer token, only when
  that session belongs to the token's customer. Never from the body. No
  foreign key: sessions are pruned when signed out or idle, and the
  report outlives them as a plain id.
- `attempts[].ms` is stored with the rung, as the other rung fields.

### B. `GET /customer/service-checks/targets`

Signed-in customer (`CustomerJwtAuthGuard`). Not on the unverified
capability list, so a relay-unverified account gets 403 `VERIFY_EMAIL`,
as for every route not on that list (docs/relay-last-resort.md, I3).

```json
{ "enabled": true, "version": 1, "everyHours": 24,
  "targets": [{ "key": "google", "label": "Google", "host": "www.google.com", "path": "/generate_204" }, ...] }
```

Version 1: `instagram` www.instagram.com `/`, `instagram_app`
i.instagram.com `/`, `whatsapp` web.whatsapp.com `/`, `whatsapp_media`
mmg.whatsapp.net `/`, `telegram` web.telegram.org `/`, `google`
www.google.com `/generate_204`, `youtube` www.youtube.com
`/generate_204`, `x` x.com `/`, `control` www.cloudflare.com
`/cdn-cgi/trace`.

`SERVICE_CHECKS=off` in `infra/.env` answers `enabled: false` (blank or
anything else: on). The list is a constant, so changing it is a backend
deploy and never an app release. On a change: bump the version and move
the outgoing list to `PREVIOUS_SERVICE_CHECK_TARGETS`, so results from
apps still holding it are not dropped.

The app requests `https://<host><path>` and reports per target. It runs
the check at most every `everyHours`, and never when `enabled` is false.

### C. `POST /customer/diagnostics`

Signed-in customer, same guard as B. Throttled to **6 an hour per signed-in
session** (`@Throttle` + `@ThrottleVolumePerSession`).

```json
{ "platform": "windows", "appVersion": "0.9.58", "note": "optional, <=500",
  "details": { "...": "as in A" }, "platformDiagnostics": "optional, <=16000" }
```

`platform` and `appVersion` (each <=32) are required. Answer **201**:
`{ "id": "<uuid>", "reference": "<first 8 characters of id>" }`. The app
shows the reference for the customer to quote.

Stored in `customer_diagnostics` (id, customerId with ON DELETE CASCADE,
sessionId as in A, platform, appVersion, note, `bundleJson` =
`{ details?, platformDiagnostics? }`, createdAt). `details` passes the
same intake as A: off-list services dropped, over 8 KB dropped.

### E. Staff views (read-only, same guards as `GET /customers/:id/activity`)

- `GET /customers/:id/attempts`: each item gains `details` (the stored
  object or null) and `sessionId`; each rung gains `ms` (or null). A
  `SERVICE_CHECK` report has category `check`: never counted as a
  connection attempt, never given a failure code.
- `GET /customers/:id/insight` gains:
  - `deviceFacts[]`: `{ sessionId|null, platform, label|null, lastSeenAt,
    device|null, net|null, tunnel|null }`, grouped by the session a report
    named, else by platform; each part is the newest one seen in the
    window. A device whose reports in the window carried no details is
    not listed.
  - `serviceChecks`: `{ lastRunAt|null, runs, latest[], byServer[] }`.
    `latest` is the newest result per target key (`key, label, host, ok,
    stage, dnsMs, connectMs, tlsMs, firstByteMs, status, address, addressKind,
    error, at, server, protocol, via`). `byServer` counts runs per
    route (`server, protocol, via, runs, perService`). Only a run with
    `via: "tunnel"` is counted under a server, as in the fleet summary;
    direct runs (`via: "direct"`) and runs that did not say (`via:
    null`) each form a group of their own with server and protocol null.
- `GET /customers/:id/diagnostics?take&skip`: `[{ id, reference,
  createdAt, platform, appVersion, sessionId, note, bundle }]`, newest
  first, X-Total-Count. `?ref=<8 hex>` instead returns only that
  customer's bundle with that reference (400 for anything else), so the
  viewer opens a bundle from History whatever page of the list it is on.
- `GET /customers/:id/history` gains `DIAGNOSTICS_SENT`: title with the
  reference, detail "platform, version", link
  `/customers/:id?view=diagnostics&ref=<reference>`.
- `GET /client-attempts` (the existing admin page): `summary` never
  counts a `SERVICE_CHECK` row, and the failures-only list leaves them
  out unless the kind filter asks for them. One unreachable target makes
  a run `OTHER`; it is not a failed connect.
- `GET /service-checks/summary?hours=24` (1..336): `{ hours, runs,
  customers, targets, byServer[], byNetwork[] }`. `byServer` counts
  **only runs made through the tunnel** (`details.via = "tunnel"`), with
  per target ok/failed, median TLS and first-byte times over the results
  that carried them, and the commonest failing stage. `byNetwork` is the
  15 networks with the most runs, tunnel or direct. At most 20,000 runs
  are read, newest first.

Every view states counts of what the apps reported; none names a cause.

## Retention

- `detailsJson` and `sessionId` live and die with their report: 60 days
  (`KEEP_WITHOUT_ADDRESS_DAYS`).
- `customer_diagnostics` rows are deleted at 60 days by the same daily
  sweep (`client-attempt-retention`, `ClientAttemptsService.prune`), and
  with the customer when the account is deleted.

## Rollout order

1. **Backend first.** A server from before this change rejects every
   unknown field with a 400, and the apps count a 400 as delivered: a
   new app talking to an old server would lose every report it sent,
   silently. Deploy the backend before any app sends a new field. The
   migration is additive and safe to apply while the API serves.
   **Rollback** to the previous backend is safe only while no
   `SERVICE_CHECK` row exists: the previous Prisma client throws on an
   enum value it does not know, so its attempt lists, `/customers/:id/activity`
   and `/insight` would fail. Once checks have arrived, run
   `DELETE FROM "client_attempts" WHERE "kind" = 'SERVICE_CHECK';`
   first (only the checks are lost), then start the previous image.
2. **The privacy page and the in-app notice**, saying in plain words
   what is collected and the boundary above, before any app collects it.
3. **The apps**, each reading `GET /customer/service-checks/targets`
   rather than carrying its own list.

## Per platform

Two native commands feed the app layer. Both are best effort, never
touch connecting, and are swallowed on error.

**`probe_service { host, path, timeoutMs }`**, one implementation
(`apps/desktop-windows/src-tauri/src/service_probe.rs`, compiled into the
mobile app by path) registered in the Windows and mobile apps. One HTTPS
request on port 443: the system resolver (inside the tunnel when it is
up), an IPv4 answer first, TCP, TLS verified against the webpki roots the
app's own requests trust, `GET <path>` with a Host header, the status line
read and nothing more, then closed. Answers `{ ok, stage, dnsMs?,
connectMs?, tlsMs?, firstByteMs?, status?, address?, error? }`, `ok` when
any status line came back. The whole probe is held to `timeoutMs`
(clamped to 1-30 s). It rejects (an error, no request made) anything but a
plain host name -- no scheme, port, user info, IP literal or trailing dot
-- and any path not starting with one "/" or carrying a space, CR/LF,
fragment, backslash or dot segment. `error` is one of fixed words that
name no host or address. Proxies are not consulted: it measures the path
itself. Under the phones' engine and under Xray on Windows the TCP connect
is answered on the device, so `connectMs` means little there. Linux has
no such command yet.

**`device_facts`** (no arguments), every key left out when the platform
cannot tell. One shape for every platform (`device_facts.rs`, compiled
into the mobile VPN plugin by path, which reads the platform answer field
by field and holds it to the bounds above).

| Field | Windows | Android | iOS | Linux |
|---|---|---|---|---|
| `model` | BIOS `SystemManufacturer` + `SystemProductName`, OEM placeholders dropped | `Build.MANUFACTURER` + `Build.MODEL` (the maker once, when the model already starts with it) | `utsname.machine`, e.g. "iPhone16,2" -- never the device's name | no command |
| `os`, `osVersion` | "Windows", "11 26100.2314" from the registry build and UBR | "Android", `Build.VERSION.RELEASE` | "iOS", `ProcessInfo.operatingSystemVersion` ("18.1", "18.1.1") | no command |
| `lowPower` | battery saver (`GetSystemPowerStatus`) | `PowerManager.isPowerSaveMode` | `ProcessInfo.isLowPowerModeEnabled` | no command |
| `dataSaver` | **never** (no such setting) | `ConnectivityManager.restrictBackgroundStatus`: true when Data Saver is on, whether or not this app is on its allow list | Low Data Mode: `isConstrained` of the pinned path below; left out when that path is not read | no command |
| `memFreeMb` | `GlobalMemoryStatusEx` | `ActivityManager.MemoryInfo.availMem` | **never**: iOS tells an app its own budget, not the device's free memory | no command |
| `net.type` | the uplink's ifType: 71 wifi, 6 ethernet, 243/244 cellular, else other; "none" when nothing is up with a gateway, "unknown" when only tunnels are | the chosen non-VPN network's transport (Wi-Fi, cellular, Ethernet, else other); "none" when the networks were read and none without a VPN transport has INTERNET | the first Wi-Fi, cellular or wired interface in a path monitor's `availableInterfaces`; "none" when there is none and the path is down, "other" when only other interfaces are there | no command |
| `net.metered` | **never**: WinRT's cost describes whichever network Windows calls the internet one, which is our tunnel while it is up | not `NET_CAPABILITY_NOT_METERED` | `isExpensive` of a path monitor pinned to that interface type | no command |
| `net.ipv4`, `net.ipv6` | the uplink has a gateway of that family and a usable address (not APIPA; IPv6 global 2000::/3) | the network's `LinkProperties.linkAddresses` hold an IPv4 / a non-link-local IPv6 address | `supportsIPv4` / `supportsIPv6` of the pinned path | no command |
| `net.otherVpn` | **never** yet: the service's diagnostics know it, behind a round trip this does not wait for | false when no network has a VPN transport; true when one has and none of our own tunnels shows any sign of life (Android 10+: no VPN network owned by this app; no WireGuard, no recorded protocol, no Xray state "up", no platform IKEv2 of ours); left out otherwise | **never**: a tunnel interface does not say whose it is | no command |
| `net.dns` | the uplink adapter's resolvers, without loopback and the fec0 defaults, at most 4 | `LinkProperties.dnsServers` of the non-VPN network, at most 4 | **never**: no public API | no command |
| `net.privateDns`, `privateDnsHost` | **never** (Android only) | Android 9+: `isPrivateDnsActive` / `privateDnsServerName` -- "host" with the host when a name is set, "auto" when active without one, "off" when not active (so automatic mode that found no DNS-over-TLS server reads "off"); left out before Android 9 | **never**: iOS has no such setting | no command |

The Windows uplink is chosen among adapters that are up, can be physical
(Wi-Fi, Ethernet, mobile broadband, PPP) and have a default gateway,
leaving out every tunnel -- Wintun and WireGuard by ifType, TAP and other
VPN drivers by the service's list of driver names, our IKEv2 connection
by its name -- with the lowest interface metric winning, IPv4 first. Not
Windows' best route, which while our tunnel is up is the tunnel. Adapter
names, Wi-Fi names, the computer name and the gateway's hardware address
are never read into the answer.

On Android (`deviceFacts` in `NeoxifyVpnPlugin.kt`, on a thread of its
own so a running connect cannot hold it up) the network under the tunnel
is chosen by walking `ConnectivityManager.allNetworks`: anything with a
VPN transport is skipped, and of the networks with INTERNET one that is
VALIDATED wins, Wi-Fi or Ethernet before cellular -- the active network,
while our tunnel is up, is the tunnel. No permission was added
(ACCESS_NETWORK_STATE was already declared); each fact is read in its own
try, so a missing service or a SecurityException costs that fact only.

On iOS (`DeviceFacts.swift`, called by `deviceFacts`) a path monitor
names the physical interface under the tunnel, and a second monitor
pinned to that interface type reads its cost, Low Data Mode and address
families -- the plain path, while a tunnel is up, describes the tunnel.
Each reading waits at most 0.35 s and its monitor is cancelled either way.
No entitlement, no Info.plist key, and nothing in the tunnel extension.
iOS gives an app no public way to read the system's resolvers, whose VPN
is up, or the device's free memory, so those are always left out.

Neither phone has been run with this code: Android is compiled by CI's
debug build and is to be run on an emulator, and iOS is compiled only by
CI and has not run on an iPhone. Which network is picked as the one under
the tunnel, on either phone, is unproven until it runs with our tunnel
up. The pinned-path reading on iOS rests on a monitor pinned to an
interface type describing that interface even while a tunnel is up; that
too is unproven.

## What is not proven

- The migration has not run against Postgres. CI's migration step
  (`migrate deploy` on an empty database, `migrate diff --exit-code`,
  `test/sql/rollback-check.sql`) and the database spec
  (`customer-activity.db.spec.ts`, under `NEOXIFY_DB_SPECS=1`) are its
  first runs.
- No app sends any of this. Every shape here is checked only by unit
  tests with a mocked database.
- Whether a fixed list of nine targets, tried once a day, says anything
  useful about a server under real filtering is unknown until real runs
  arrive. The views count what arrives; they do not interpret it.
- The boundary is enforced for service results only. A modified client
  could still write a visited address into one of the bounded free-text
  fields; the server cannot tell such text from an error message.
