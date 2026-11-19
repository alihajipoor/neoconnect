# Client diagnostics: fuller reports, the service check, diagnostics bundles

Status: on `claude/client-diagnostics`, unreleased. The server can
receive, store and show everything below (stage A); the native commands
and the apps' shared TypeScript that sends it are written (stage B, see
*Per platform*). Unit tests only: the migration has not yet run against
Postgres (CI is its first run), and nothing here has met a real
backend, phone or censored network -- see *What is not proven* at the end.

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
is answered on the device, so `connectMs` means little there. The Linux
app compiles the same file by path.

**`device_facts`** (no arguments), every key left out when the platform
cannot tell. One shape for every platform (`device_facts.rs`, compiled
into the mobile VPN plugin by path, which reads the platform answer field
by field and holds it to the bounds above).

| Field | Windows | Android | iOS | Linux |
|---|---|---|---|---|
| `model` | BIOS `SystemManufacturer` + `SystemProductName`, OEM placeholders dropped | `Build.MANUFACTURER` + `Build.MODEL` (the maker once, when the model already starts with it) | `utsname.machine`, e.g. "iPhone16,2" -- never the device's name | DMI `sys_vendor` + `product_name` from `/sys/class/dmi/id`, the same placeholders dropped -- never the host name |
| `os`, `osVersion` | "Windows", "11 26100.2314" from the registry build and UBR | "Android", `Build.VERSION.RELEASE` | "iOS", `ProcessInfo.operatingSystemVersion` ("18.1", "18.1.1") | "Linux", os-release `NAME` (else `ID`) + `VERSION_ID`, e.g. "Ubuntu 24.04"; `NAME` alone on a rolling release |
| `lowPower` | battery saver (`GetSystemPowerStatus`) | `PowerManager.isPowerSaveMode` | `ProcessInfo.isLowPowerModeEnabled` | **never**: no setting every distribution shares |
| `dataSaver` | **never** (no such setting) | `ConnectivityManager.restrictBackgroundStatus`: true when Data Saver is on, whether or not this app is on its allow list | Low Data Mode: `isConstrained` of the pinned path below; left out when that path is not read | **never** (no such setting) |
| `memFreeMb` | `GlobalMemoryStatusEx` | `ActivityManager.MemoryInfo.availMem` | **never**: iOS tells an app its own budget, not the device's free memory | `MemAvailable` in `/proc/meminfo` |
| `net.type` | the uplink's ifType: 71 wifi, 6 ethernet, 243/244 cellular, else other; "none" when nothing is up with a gateway, "unknown" when only tunnels are | the chosen non-VPN network's transport (Wi-Fi, cellular, Ethernet, else other); "none" when the networks were read and none without a VPN transport has INTERNET | the first Wi-Fi, cellular or wired interface in a path monitor's `availableInterfaces`; "none" when there is none and the path is down, "other" when only other interfaces are there | the uplink (below): wifi when sysfs has `wireless`/`phy80211` for it, cellular for `wwan*`, ethernet when its `type` is 1, else other; "none" when there is no default route at all, "unknown" when only tunnels hold one |
| `net.metered` | **never**: WinRT's cost describes whichever network Windows calls the internet one, which is our tunnel while it is up | not `NET_CAPABILITY_NOT_METERED` | `isExpensive` of a path monitor pinned to that interface type | **never**: only NetworkManager knows, over D-Bus |
| `net.ipv4`, `net.ipv6` | the uplink has a gateway of that family and a usable address (not APIPA; IPv6 global 2000::/3) | the network's `LinkProperties.linkAddresses` hold an IPv4 / a non-link-local IPv6 address | `supportsIPv4` / `supportsIPv6` of the pinned path | ipv4: an IPv4 default route on the uplink; ipv6: an IPv6 default route on it and a usable global (2000::/3, not tentative) address in `/proc/net/if_inet6` |
| `net.otherVpn` | **never** yet: the service's diagnostics know it, behind a round trip this does not wait for | false when no network has a VPN transport; true when one has and none of our own tunnels shows any sign of life (Android 10+: no VPN network owned by this app; no WireGuard, no recorded protocol, no Xray state "up", no platform IKEv2 of ours); left out otherwise | **never**: a tunnel interface does not say whose it is | **never** yet: the helper's diagnostics know it, behind a round trip this does not wait for |
| `net.dns` | the uplink adapter's resolvers, without loopback and the fec0 defaults, at most 4 | `LinkProperties.dnsServers` of the non-VPN network, at most 4 | **never**: no public API | behind the systemd-resolved stub (127.0.0.53/54) the upstreams in `/run/systemd/resolve/resolv.conf`, else `/etc/resolv.conf`; loopback dropped, at most 4. **Left out while a tunnel of ours is up** (below) |

On every platform `net.dns` leaves out any IPv6 resolver that is
link-local (fe80::/10) or whose interface ID is EUI-64 (ff:fe in its
middle): home routers commonly advertise their own link-local address as
the resolver, and on many it is built from the router's MAC -- the
gateway fingerprint this feature never sends. Dropped in the Kotlin read,
again in `dns_list` (`device_facts.rs`, which Windows and both phones go
through), and once more in the shared TypeScript. A router's global IPv6
resolver that is not EUI-64 is kept: it carries the household's prefix,
which the server already sees as the report's source address.
| `net.privateDns`, `privateDnsHost` | **never** (Android only) | Android 9+: the setting, `Settings.Global` `private_dns_mode` -- "off", "opportunistic" as "auto", "hostname" as "host" with the host from `privateDnsServerName` when active, else from `private_dns_specifier` when readable. A phone whose owner never opened the setting has no value stored; Android then uses its default, read from `private_dns_default_mode` and "opportunistic" when that is empty too, so such a phone reports "auto" (the emulator, unset, first reported "unknown"). When the setting cannot be read at all: "host" (with the host) or "auto" only when `isPrivateDnsActive` says so, otherwise "unknown" -- never "off" on a guess, since "Automatic" (the default) is not active on a network that offers no DNS-over-TLS; left out before Android 9 | **never**: iOS has no such setting | **never** (Android only) |

The Windows uplink is chosen among adapters that are up, can be physical
(Wi-Fi, Ethernet, mobile broadband, PPP) and have a default gateway,
leaving out every tunnel -- Wintun and WireGuard by ifType, TAP and other
VPN drivers by the service's list of driver names, our IKEv2 connection
by its name -- with the lowest interface metric winning, IPv4 first. Not
Windows' best route, which while our tunnel is up is the tunnel. Adapter
names, Wi-Fi names, the computer name and the gateway's hardware address
are never read into the answer.

On Linux (`linux_facts.rs`: files only, no program run and no round trip
to the helper, the whole read held to 900 ms on a blocking thread) the
uplink is the interface holding the IPv4 default route in
`/proc/net/route` with the lowest metric, failing that the IPv6 one in
`/proc/net/ipv6_route`, leaving out every tunnel by name: ours
(`neoconnect0`, `neoxify-wg`, `neoxify-ovpn`, strongSwan's `ipsec*` for
IKEv2) and `tun*`, `tap*`, `wg*`, `ppp*`, `vti*`, `tailscale*`,
`nordlynx*`, `zt*`. Our tunnels route through routes and a table of
their own, so the machine's own default stays visible beneath them.
`net.dns` is left out whenever one of our interfaces (`neoconnect*`,
`neoxify*`, `ipsec*`) exists, and whenever `/etc/resolv.conf` is the file
the helper writes while connected: the helper then points the machine's
DNS at the tunnel -- through systemd-resolved, whose upstream list then
holds the tunnel's resolver beside the network's, or by rewriting
`/etc/resolv.conf` -- and the device's own resolvers cannot be told
apart from the tunnel's. Interface names are read only to make that
choice; the host name, Wi-Fi names and hardware addresses are never read.

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

### What the apps send (the shared TypeScript)

One implementation, `apps/desktop-windows/src/lib`, which the phone app
imports: `report-details.ts` (the `details` object), `attempts.ts` (the
report queue), `service-check.ts`, `diagnostics-bundle.ts`,
`diagnostics-consent.ts`, and the Support screen (`screens/Support.tsx`).

- **On phones, nothing new until the disclosure is accepted; on desktop,
  from the first run** (Rollout 2, `diagnostics-consent.ts`). On a phone,
  until then every report goes exactly as it did before this change -- no
  `details`, no rung `ms` -- and no SERVICE_CHECK is run by itself or
  sent. On a phone the notice is the
  prominent disclosure, now **version 2** (`DISCLOSURE_VERSION`), whose
  "connection diagnostics" item names the new data; everyone who accepted
  version 1 is shown it again before anything new is sent, and a wiring
  test fails whenever the disclosure's words change without a decision
  about the version. The desktop apps (Windows, Linux, the macOS shell) have no in-app
  notice and no gate: the published privacy page describes all of it, no
  store rule asks a desktop app for an acceptance, and the desktop's
  reports have always gone without one. A one-time Dashboard notice with
  an OK gate was built first as a reviewer's precaution; the owner chose
  on 2026-11-19 to have no card at all, since anyone who ignored it sent
  none of the details support needs.
  A diagnostics bundle is not held by any of this: the customer sees exactly what
  it carries before pressing Send.

- **Details on every CONNECT, SIGN_IN, REGISTER and SESSION report**:
  `device` (from `device_facts`, with the app's interface language:
  `model`, `os` and `osVersion` kept from the first good read of the run;
  `memFreeMb`, `lowPower` and `dataSaver` read again with the network) and
  `net` (the same command, at most every 30 s; a failed read sends neither
  an old network nor old free-memory and saver readings).
  On a successful CONNECT, on SESSION and on SERVICE_CHECK also `tunnel`:
  the mode (`full`, `custom`, `gaming`) and the resolvers the app sets
  inside the tunnel, set afresh when a rung lands (proven or not), and on
  Windows `splitTunnel`, `ipv6Blocked` and `dnsUnprotected` from the
  service's status, merged into that landing's. Put away on a disconnect,
  a drop, a teardown (a stopped pass, the device limit) and when a connect
  pass begins, so nothing of an older session is reported as a later
  one's; a failed CONNECT landed nothing and carries none. Read when the
  report is made, before anything is awaited. On CONNECT also the last
  data check's two legs and the last exit check's state and time, each
  within two minutes, each sent once and put away when a pass begins --
  the exit check only the connect's own (a health poll's never counts);
  `errorKind` on a failed connect;
  `reconnect` on an automatic reconnect's report. Every field is copied by
  name and held to the validators above; the whole is capped at 6,000
  bytes, giving up parts in the order reconnect, egress, dataCheck,
  tunnel, device, net (service error words first, service results last)
  rather than all at once. A native command that is missing or fails
  leaves its part out; with `device_facts` missing there is no `device`
  or `net` at all, the language included.
- **`attempts[].ms`** on both ladders: the time from a rung's start to its
  line (`timedRungs`), the landed rung's taken as it lands.
- **The one resend.** A 400 to a report carrying `details` or a rung's
  `ms` is answered by sending it once more without both, so a validator
  mismatch never loses the basic report.
- **The end of a session**: a second SESSION report, `outcome: OTHER` and
  no `sessionSeconds` (so it is never read as ten minutes of health), with
  `details.sessionEnd` -- `disconnected` (the customer's press), `lost`
  (a drop, or the health checks giving up), `replaced` (another route took
  over), `unknown` (the plan's device limit took it down) -- with the
  `routeId` and `protocol` (the label the connect's own report used) of
  the session, and `seconds` counted from the moment the app's own
  connected-for timer starts for that tunnel (its first passing check when
  that time is not known; the ten-minute report still counts from the
  first passing check), for a session of at least 60 s by that count,
  once. On the phones that timer starts when the tunnel comes up, a few
  seconds before the word "Connected" appears, because the checks run
  first: the emulator showed 187 s for 181 s on screen and 92 s for 83 s.
  This report goes even when the network could not be attested (every
  other SESSION report is held back then: it is per-network evidence,
  and this one is about one customer's session); on a phone, before the disclosure
  is accepted it is not sent at all, since its reason line alone says how
  long the session ran. A stopped pass ends
  it as `disconnected`. From the live tracker (`session-report.ts`), never
  from the local session log, which stays on the device. `app_closed` is
  never sent: a killed app sends nothing.
- **The service check**, after a proven connect's success report (and
  its speed sample): only when the list says `enabled`, the app is in
  front, the tunnel is still the one landed on, the route's last run is
  older than `everyHours`, and the app's own traffic goes through the
  tunnel -- on Windows and Linux not in Custom or gaming mode; on a phone
  always (Android puts this app in the tunnel when apps are chosen; iOS
  has no per-app routing). Three at a time, 8 s each, 25 s in all; a
  target not answered by then is left out and the run is `OTHER`. Any
  teardown or landing during the run -- even a drop and a reconnect to the
  same route -- stops it and nothing is reported (a landing counter taken
  when it starts). The list is kept 24 h and the last run per route in
  the app's store (`service-checks.json`), so a customer who uses several
  servers in a day gets one run for each; the disclosure says "at most
  once a day for each server". A SERVICE_CHECK that cannot be delivered is
  never queued: the queue's 25 places are for connect failures.
- **Support screen, every platform**: "Connection test" runs the check
  now and shows each service by its label as reachable or not, and the
  way it went (through the VPN, without it, or -- for a tunnel this run of
  the app did not bring up -- neither). The way is that of the last
  landing, unverified ones included, and is left out when a tunnel came or
  went during the run. It does not start while the automatic run is going.
  It is reported as a SERVICE_CHECK with that `via` (left out when
  unknown), at most once in 5 minutes however often it is pressed (shown
  every time), and only once the customer has been told; the card then
  says the result is sent. "Send diagnostics to support"
  (signed-in only) shows exactly the body it sends -- the facts, the
  test's results if one was run, and on Windows and Linux the Copy text --
  and answers with the reference. In the bundle's Copy text the other VPNs
  that are up are a count ("2 (names not sent)"), not the adapters' or
  links' own names, which a customer or an employer may have named after
  a person; the Copy button's own text, which the customer pastes
  themselves, keeps the names.

**Windows** sends all of the above. Its `device_facts` gives no
`dataSaver`, `metered` or `otherVpn` (table above); `tunnel.dns` is
`1.1.1.1` for the Xray family and IKEv2 (the service's `TUN_DNS` and
`IKEV2_DNS`), a WireGuard credential's own `dns`, and left out for
OpenVPN, whose resolvers the server pushes.

**Linux** (`apps/desktop-linux`) runs the same TypeScript and registers
both native commands: `probe_service` is the shared `service_probe.rs`,
compiled by path, and `device_facts` is `linux_facts.rs` over the shared
`device_facts.rs` shape and filters. So it sends `device` and `net` as
in the table above (no `lowPower`, `dataSaver`, `metered`, `otherVpn`
or `privateDns`; no `net.dns` while a tunnel of ours is up), the service
results of an automatic run and of the Support screen's test, and
`tunnel.mode` and `splitTunnel`, `ipv6Blocked`, `dnsUnprotected` where
its helper's status gives them; `errorKind`, `dataCheck`, `egress`,
`reconnect`, `sessionEnd`, and rung `ms`. It sends no `tunnel.dns` (its
engines' resolvers are not known to this layer). Its bundle carries the
Copy text. None of the Linux side has run on a Linux machine: CI only
type-checks the app crate (`cargo check --all-targets`), and the unit
tests in `linux_facts.rs` have run against sample texts, off Linux.

**Android and iOS** send what their `device_facts` gives (table above);
`tunnel.dns` is `1.1.1.1` for Xray (`TUN_DNS`) and a WireGuard
credential's `dns`, and left out for IKEv2; their bundles carry no Copy
text, since neither phone has one.

## What is not proven

- The migration has not run against Postgres. CI's migration step
  (`migrate deploy` on an empty database, `migrate diff --exit-code`,
  `test/sql/rollback-check.sql`) and the database spec
  (`customer-activity.db.spec.ts`, under `NEOXIFY_DB_SPECS=1`) are its
  first runs.
- No app has sent any of this to a real backend. Every shape is checked
  by unit tests on both sides, against mocks; that the apps' validators
  match the server's is held by reading the DTOs, not by a round trip.
- None of the app side has run on a real network: not the facts with a
  tunnel up, not a probe through a tunnel, not a 400 resend, not the
  Support screen against the live API.
- Whether a fixed list of nine targets, tried once a day, says anything
  useful about a server under real filtering is unknown until real runs
  arrive. The views count what arrives; they do not interpret it.
- The boundary is enforced for service results only. A modified client
  could still write a visited address into one of the bounded free-text
  fields; the server cannot tell such text from an error message.
