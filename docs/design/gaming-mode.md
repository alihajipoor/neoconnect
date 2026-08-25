# Gaming Mode — design

Status: **design only, nothing built.** Written 2026-08-24 on branch
`claude/gaming-mode-design`.

Audience: whoever builds this. It is written to be read cold, and to make
re-deriving the constraints unnecessary. Where a number appears, the
instrument that produced it is named. Where something is unproven, it says
so in those words.

---

## 0. The short version

The measurements do not support the product as it is usually imagined.

1. **Tunnelling a game through our nodes makes it slower.** From Tehran, the
   direct path to Blizzard's EU game server is 72 ms. The best case through
   our fleet — germany-1, from the best-connected Iranian network measured —
   is 72.8 ms, a dead heat *before* encryption and queueing. Every other node
   is 30–90 ms worse. "Lower ping" is not a claim we can make.
2. **Nothing we could measure is blocked.** Sixteen Blizzard hostnames, the
   Battle.net service port, and the WoW game port were probed from four
   Iranian networks with German, Turkish and Finnish controls. Every DNS
   answer was clean, every HTTP status matched the control exactly, and TCP
   to the game port completed from Iran. So the "sanction-blocked vs merely
   slow" split that this design was meant to be built on **did not hold on
   the evidence available**. See §2 for exactly what that does and does not
   cover — the gap is large and it is the first thing to close.
3. Therefore the honest v1 is **not a tunnel and not a ping product**. It is
   **selective DNS redirection of named, non-latency-critical endpoints**
   (launcher, login, web, store) with the game's own connections left on the
   direct path by construction — plus a clearly-separate, off-by-default,
   top-tier option to give the game a stable private exit, which is the only
   benefit with any supporting evidence at all.
4. **Ship nothing until instrument #1 in §14 comes back.** It is a single
   measurement from an Iranian consumer ISP, it can come back negative, and
   if it does it kills the unblocking premise outright.

---

## 1. What this is modelled on, and what those products actually do

| Product | What it actually does | What we can copy |
|---|---|---|
| **EZ Connect** | Their own ToS: *"All EZ Connect servers are located in Iran."* Iranian company, Toman pricing, Arvan Cloud Tehran, Telegram support. Lists Battle.net by name. It **never changes the exit country** — and users still report it fixing their problem. | The mechanism that is left once "foreign exit" is removed: **a stable, low-density, non-shared address**. Also their honesty floor — they disclaim liability for IP-change-sensitive games, in Persian, to our exact customers. |
| **ExitLag** | Route selection across rented PoPs. Redirection method not established. | Nothing verified. |
| **GearUP** | Their own docs describe route **switching**, not packet duplication. Partners with Tarkov / PUBG / ASUS / Discord — evidence that publishers treat route optimisers differently from VPNs. Blizzard is *not* in that list. | The partner-list observation. **Not** their ban-immunity claim, which they place in an influencer testimonial rather than their own voice. We do not copy that laundering pattern. |

RIPEstat ASN searches for exitlag / gearup / ezconnect / wtfast / noping /
mudfish return **no ASN for any of them**. None owns address space. They rent
PoPs exactly as we do. Their advantage is quantity of PoPs, path selection,
and low account density per exit — not anything exotic.

---

## 2. The core question: what is blocked, and what is merely slow

### 2.1 The instrument

Globalping probes, 2026-08-24. Four Iranian networks in Tehran —
AS202468 AbrArvan, AS42043 Parsian High Tech, AS59441 Hostiran,
AS59580 Batterflyai — with control runs from Germany (Hetzner Falkenstein,
Nuremberg; netcup), Turkey (Istanbul) and Finland (Helsinki).

The control is the point. A 403 or a timeout means nothing until you have
seen what the same request does from an unblocked vantage. Every finding
below is a *difference* or an *absence of difference* against the control.

**The instrument's hard limit, stated first: all five Iranian Globalping
probes are tagged `datacenter-network`.** There is no consumer-ISP probe in
Iran. That splits the question cleanly:

- **Does Blizzard refuse Iranian IP space?** These probes answer it. Iranian
  datacenter addresses are Iranian addresses; a geo-block by the destination
  applies to them the same way.
- **Does an Iranian consumer ISP block the path?** These probes **cannot**
  answer it. TCI, MCI, Irancell and Rightel are where national filtering
  lives, and nothing here reaches them.

### 2.2 Result: reachability

DNS, A records, from all four Iranian networks:

| Host | Answer from Iran | Verdict |
|---|---|---|
| `us.actual.battle.net` | `34.118.243.237`, `34.125.219.30`, `34.125.159.31` (GCP US) | clean |
| `eu.actual.battle.net` | `34.34.51.91`, `34.13.208.150`, `35.204.95.176` (GCP europe-west4, NL) | clean |
| `oauth.battle.net` | `63.181.215.22`, `3.78.117.122`, `63.186.190.245` | clean |
| `us.battle.net` / `eu.battle.net` / `shop.battle.net` | `166.117.x` | clean |
| `worldofwarcraft.blizzard.com` | `54.76.247.89`, `54.247.0.181` | clean |
| `blzddist1-a.akamaihd.net` | CNAME chain → Akamai edge, **Iranian-local edge IPs** (`185.200.125.x` on two networks) | clean, and served locally |
| `level3.blizzard.com` | CNAME → Akamai, `2.x` / `23.x` edges | clean |
| `eu.cdn.blizzard.com` | CNAME `cdn.blizzard.com`, `137.221.64.1-8` (Blizzard AS57976) | clean |
| `telemetry-in.battle.net` | `137.221.105.x` | clean |

No poisoning. Nothing resolved to `10.10.34.x` (the Iranian block-page
range). Answers matched the controls. Contrast this with the prior research
finding that `speedtest-ams3.digitalocean.com` failed to resolve from all
five Iranian probes — selective DNS filtering *is* real in Iran and this
instrument does detect it; it simply did not fire on any Blizzard name.

HTTPS `GET /` — Iranian status code vs German control, sixteen hostnames:

| Host | Iran | Germany control | Same? |
|---|---|---|---|
| `oauth.battle.net` | 302 → OIDC discovery | 302 → OIDC discovery | yes |
| `account.battle.net` | 200 | 200 | yes |
| `us.battle.net` / `eu.battle.net` | 301 → shop | 301 → shop | yes |
| `shop.battle.net` | 302 → `eu.shop.battle.net` | 302 → same | yes |
| `worldofwarcraft.blizzard.com` | 307 → `/en-us/` | 307 → `/en-us/` | yes |
| `render.worldofwarcraft.com` | 403 `AmazonS3 AccessDenied` | 403 `AmazonS3 AccessDenied` | yes — **not a geo-block**, it is S3 refusing a bare `/` |
| `us.forums.blizzard.com` | 200 | 200 | yes |
| `us.api.blizzard.com` / `eu.api.blizzard.com` | 404 `server: blizzard` | 404 `server: blizzard` | yes |
| `blzddist1-a.akamaihd.net` | 404 `AkamaiGHost` | 404 `AkamaiGHost` | yes |
| `level3.blizzard.com` | 403 `AmazonS3` (IAM user in body) | 403 `AmazonS3` (same) | yes |
| `us.cdn.blizzard.com` / `eu.cdn.blizzard.com` | 404 | 404 | yes |
| `us.actual.battle.net` / `eu.actual.battle.net` | timeout | **timeout** | yes — port 443 is simply closed on those hosts, everywhere |

The two `*.actual.battle.net` timeouts looked at first like the smoking gun.
The control killed it: they time out from Germany too. Those hosts do not
serve HTTPS on 443 at all.

Authentication surface, three consecutive rounds, real path:

```
GET https://oauth.battle.net/.well-known/openid-configuration
  AS202468  200  1048 bytes    (x3)
  AS42043   200  1048 bytes    (x3)
  AS59441   200  1048 bytes    (x3)
  AS59580   200  1048 bytes    (x3)
```

Identical byte counts, all four networks, every round. (One 403 appeared in
the first sweep, from Hostiran against the bare `/` path — an `awselb/2.0`
403, and it did not reproduce at the real path.)

Transport-level, the ports that matter:

| Target | Iran | DE | TR | FI |
|---|---|---|---|---|
| `37.244.62.99:3724` (WoW EU realm/world) | TCP completes, server sends non-HTTP bytes | same | same | same |
| `eu.actual.battle.net:1119` (Battle.net service) | TCP completes, 89–92 ms, HTTP 403 | TCP completes, 15–19 ms, HTTP 403 | 43–46 ms, 403 | 32–34 ms, 403 |
| `us.actual.battle.net:1119` | TCP completes, 226–238 ms, 403 | 150–156 ms, 403 | 182 ms, 403 | 165–169 ms, 403 |
| `eu.actual.battle.net:443` | timeout | timeout | — | — |

The 403 on 1119 is a protocol mismatch — an HTTP request to a host that
speaks Battle.net — and it is byte-identical from every country. The
**TCP handshake to the WoW game port completes from Iranian address space
and the server answers.**

### 2.3 Result: latency

ICMP, 8 packets, from the same four Iranian networks, to our actual
production node addresses (this is the first time these have been measured
directly rather than by proxy through same-city rentals):

| Target | AS59441 Hostiran | AS202468 Arvan | AS42043 Parsian | AS59580 Batterflyai |
|---|---|---|---|---|
| **turkey-1** `130.94.0.27` | **51.6** | 53.2 | 53.8 | 232.5 |
| **germany-1** `38.60.249.229` | **66.1** | 75.9 | 87.0 | 199.5 |
| **france-1** `104.105.205.233` | 88.0 | 88.4 | 88.3 | 211.3 |
| **finland1** `204.168.161.100` | 109.0 | 119.9 | 115.5 (12.5% loss) | 225.5 |
| **singapore-1** `172.236.143.200` | 225.8 | 228.8 | 248.3 (12.5% loss) | 512.3 |
| **Blizzard EU game** `37.244.62.99` | **72.0** | 72.4 | 78.5 | 218.5 |
| `eu.actual.battle.net` | 93.2 | 91.0 | 98.5 | 212.7 |

Second leg — node city to the same Blizzard game server, min RTT, three
probes per city:

| From | to `37.244.62.99` |
|---|---|
| Frankfurt | 6.7 / 6.9 / 8.2 |
| Amsterdam | 0.9 / 6.5 / 12.7 |
| Paris | 12.2 / 15.5 / 26.5 |
| Helsinki | 29.0 / 31.5 / 39.3 |
| Istanbul | 54.8 / 55.7 / 57.9 |

The arithmetic, using the best-connected Iranian network (Hostiran) and the
best second-leg figure per city:

| Path | Leg 1 | Leg 2 | Total | vs 72 ms direct |
|---|---|---|---|---|
| Direct | — | — | **72.0** | — |
| via germany-1 | 66.1 | ~6.7 | **72.8** | **+0.8 — a wash** |
| via france-1 | 88.0 | ~12.2 | 100.2 | +28 |
| via turkey-1 | 51.6 | ~54.8 | 106.4 | +34 |
| via finland1 | 109.0 | ~29.0 | 138.0 | +66 |
| via singapore-1 | 225.8 | — | ≫200 | unusable |

Three things follow, and they are the load-bearing conclusions of this
section:

- **turkey-1 is the closest node to Tehran (51.6 ms) and one of the worst
  paths to Blizzard.** Node proximity to the customer is not the metric;
  total path is. This is a trap worth naming, because "pick the nearest
  server" is the intuitive design and it is wrong here.
- **The absolute best case in the fleet is break-even**, and that is before
  encryption, the userspace relay hop, and queueing. There is no headroom.
- The second-leg figures are from *other machines in those cities*, not from
  our nodes. germany-1 is LightNode, not Hetzner or Oracle. Treat +0.8 ms as
  an estimate with an unmeasured term — instrument #3 in §14 closes it.

Prior research (2026-08-23) put the direct figure at 73.7 ms by a different
route and a different probe set. Two independent instruments landing on
72–74 ms is the strongest number in this document.

### 2.4 What this evidence does *not* establish

Written out plainly, because the design below is shaped by these gaps as
much as by the findings.

1. **Consumer ISPs are unmeasured.** Every Iranian probe is a datacenter.
   Iranian hosting networks frequently have different filtering from
   consumer broadband and mobile. If Blizzard is blocked for a real player,
   it is most likely here, and nothing above sees it.
2. **Authenticated behaviour is unmeasured.** A sanctions block can sit
   *behind* login: the TLS handshake completes, the API answers, and the
   account is refused. No unauthenticated probe can see that. This is the
   single most likely place for a real block to live, and it is invisible to
   everything in §2.2.
3. **Purchases are unmeasured**, and separately, international cards do not
   work from inside Iran regardless of routing. Store reachability is not
   store usability.
4. **One day, one time of day.** Iranian filtering is not static.
5. **Game-server behaviour after the handshake is unmeasured.** TCP opening
   on 3724 is not the same as a realm accepting a login.
6. **Why EZ Connect works from an Iranian IP is still unexplained.** It was
   unexplained in the prior research and nothing here explains it. Any
   design that assumes we understand the mechanism is assuming something
   nobody has established.

**If the split does not hold, say so rather than designing around it.** On
the evidence available today, the sanction-blocked set is *empty*, and the
latency-sensitive set is *already on the shortest available path*. That is
not a product. What is left, and what §7 recommends, is the narrower and
better-evidenced claim: a stable, low-density, non-shared address for the
account, and reachability insurance for the endpoints we cannot yet see.

---

## 3. What WoW actually needs (carried forward, do not re-derive)

- **Two connections, one account.** WoW holds a "Home" connection (realm,
  chat, auction house) and a "World" connection (combat, NPCs). Splitting
  them across different paths gives one account two source IPs
  simultaneously — the exact signature that produces "Account Sharing" and
  "Unauthorised Account Access" penalties. **Any mechanism that can put Home
  and World on different sides of a decision is disqualified unless it can
  prove it never does.**
- **TCP *and* UDP** on 3724 / 1119 / 6012. "WoW is TCP so UDP doesn't
  matter" is false.
- **Voice chat is UDP 12000–64000.** Per-port rules break voice.
  **Per-process selection is the right mechanism**, which is what we already
  have.
- **Realm addresses arrive inside the Battle.net session as literals**, not
  from a resolver. This matters enormously for mechanism (a) — see §4.
- **Bandwidth is tiny**: 5 Kbps solo, ~80 Kbps in a crowd. It is TCP, so one
  lost segment head-of-line-blocks everything behind it. That is the
  "Home 30 ms / World 1500 ms" signature all over the forums. **Optimise
  loss and jitter. Never throughput.**
- **What 30 ms is worth**: Claypool & Claypool put the RPG threshold at
  500 ms; `SpellQueueWindow` defaults to 400 ms and absorbs RTT for
  rotational throughput. Below ~400 ms, shaving 30 ms buys nearly nothing
  for PvE. Reactive play (interrupt, dispel, arena) is a hard deadline and
  there it is real. **110 ms with 5 ms jitter and 0% loss plays better than
  80 ms with 40 ms jitter and 1% loss.**
- **EU players sometimes get instance layers hosted in Los Angeles.** ~140 ms
  floor from Europe, documented on Blizzard's own forums with players'
  Resource Monitor traces. No product fixes that, and a "Connected — 45 ms"
  indicator that implies otherwise is a lie.
- **Warden does not look at the network.** TrinityCore's Warden protocol enum
  has no network check type; the EULA "Consent to Monitor" clause is scoped
  to memory and never says network, proxy, VPN, adapter or IP; 2026 dynamic
  analysis under Proton shows Warden operating entirely in userspace with no
  syscalls, and enumerating adapters or sockets requires syscalls. The one
  real adjacency is `DRIVER_CHECK`, which hashes loaded **driver names**
  against a blacklist — and we ship kernel drivers (Wintun, WireGuardNT, the
  WFP callout). Nothing suggests Blizzard has listed one. That is the thing
  to watch, not "Warden can't see VPNs".

---

## 4. Mechanism (a) — Gaming DNS mode

A resolver we run answers a curated list of gaming hostnames with the
address of our proxy, and answers everything else truthfully. No tunnel, no
adapter, no split-tunnel driver.

### 4.1 What it can do

- Near-zero overhead. The customer's own traffic path is untouched except
  for the named hosts.
- Works on a console, a smart TV, or a router with nothing but a DNS setting.
- **Structurally cannot degrade game latency**, because it structurally
  cannot touch the game path — see the next point. Given §2.3 that is not a
  limitation, it is the single best property this mechanism has.

### 4.2 What it cannot do — and the first one is decisive

1. **It cannot touch WoW's realm/world connections at all.** Those addresses
   are handed to the client inside the Battle.net session as literals. No
   resolver ever sees them. So DNS mode's reach is exactly: launcher, login,
   patching, web, store, telemetry. It delivers **zero** exit-IP change for
   the game itself, which means it delivers zero of the account-safety
   benefit that §1 identified as the only evidenced one.
2. **It cannot help where the block is by IP.** A truthful name resolved to
   a null-routed prefix is still null-routed.
3. **It is defeated by any client that resolves in-process.** Chrome and
   Edge do DoH by default; Windows has its own DoH auto-upgrade; a launcher
   that ever pins a resolver bypasses us silently. NRPT rules and adapter
   DNS settings are both ignored by an application that does its own
   lookups. **Whether the Battle.net launcher does this is unmeasured** —
   instrument #9.
4. **DoH/DoT interference.** Plain 53 to a foreign IP in Iran is the most
   tampered-with path there is, so the client must speak DoH to us. If the
   ISP blocks 443 to the resolver host, the client must **fail visibly**,
   never fall back to the ISP resolver. A silent fallback is precisely the
   class of bug this project keeps finding.
5. **The proxy needs SNI handling.** The hijacked hostnames are TLS. We
   forward without decrypting (see below), so we depend on the ClientHello
   carrying a readable SNI. **Encrypted ClientHello would blind this
   entirely** — not deployed at Blizzard today; a watch item, not a risk
   today.
6. **A plain-53 listener is an open resolver.** Unless it refuses everything
   outside the gaming allowlist and rate-limits hard, it is a DDoS
   amplifier and a fast route to getting the node's address blocklisted —
   which costs us the node, and the node's address reputation is the
   product.
7. **Name-asserted routing.** An SNI proxy forwards to whatever host the
   client names. Strict allowlist or it becomes an open proxy.

### 4.3 Backend

- **`GameProfile` table** (new): `id, slug, displayName, iconKey, hostnames
  String[], processNames String[], destinationCidrs String[], excludeHostnames
  String[], isActive, updatedAt`. Curated in the panel. `excludeHostnames`
  exists for one reason: **patch CDN hosts must be excluded by default** or
  multi-GB downloads run through the node and eat a metered plan's cap.
- **`GET /api/customer/gaming-profile`** — new endpoint, deliberately *not*
  an extension of `/customer/protocol-users`. Returns
  `{ version, resolverDoh, resolverPlain, games: [...] }`. Two reasons for a
  separate endpoint: `protocol-users.service.ts` filters everything through
  the `CLIENT_VISIBLE_PUBLIC_PARAMS` whitelist at `:472-522` (a new field
  added anywhere else silently never reaches the client), and the desktop
  client caches that payload in `credential-cache.ts` behind a `version`
  shape discriminator that would have to be bumped.
- **Plan gating.** There is no entitlement mechanism in this codebase — the
  only gate is `SubscriptionPlan.allowedRoutes`, and empty means "serves
  nothing". `relayOnly` is a **dead column**: the enforcement was removed
  (`protocol-users.service.ts:97-108`, `:191-214` both say so explicitly)
  and nothing reads it. Do not copy it. Add a **`PlanFeature` join table**
  rather than another boolean on `SubscriptionPlan` — the schema's own
  comment about `isActive` / `isPurchasable` (schema:334-348) is this repo's
  cautionary tale about one boolean doing two jobs.
- **Per-customer resolver token** so the DoH endpoint can authenticate:
  `https://<node-fallback-host>/dns-query/<token>`. Path-token auth is the
  standard trick and it works. A source-IP allowlist does not — Iranian
  consumer networks are behind CGNAT.

### 4.4 Node / agent

- **Resolver: CoreDNS.** Single static Go binary, matches the agent's
  language, and the plugins needed all exist: `forward`, `template`,
  `hosts`, `cache`, `acl`, plus `tls`/`https` server blocks for DoT/DoH.
  There is currently **no DNS software anywhere in this repo** — no dnsmasq,
  CoreDNS, unbound, knot, sing-box; no `dns` block in any Xray config,
  server or client. This is genuinely new surface.
- **Proxy: no new binary.** Use an Xray `dokodemo-door` inbound with
  `sniffing: { enabled: true, destOverride: ["tls","http"] }` and routing
  rules matching on `domain:`. This matters more than it looks:
  - The existing templates already ship `RoutingService` in the API services
    list on **both** `xray-config.json.template` and
    `xray-relay-config.json.template`, and the relay provisioner already
    injects rules live via `RoutingService.AddRule`
    (`agent/internal/relay/provisioner.go:203`, rule built at `:364` as a
    free-form `map[string]any` fed through xray-core's own
    `conf.RouterConfig.Build()`). **`domain`, `port`, `network` keys parse
    today without touching the builder.** Only the map literal at `:365-375`
    needs extra keys.
  - No TLS termination means no certificate, no pinning problem, and **no
    ability to see credentials** — which is the right posture for a product
    whose customers' accounts are the asset.
  - `geosite:` matchers would need `geosite.dat` shipped to nodes (nothing
    in the installer downloads it, and the iOS build deliberately strips
    it). Use explicit `domain:` / `keyword:` lists instead.
- **The re-assert sweep is mandatory, not optional.** Rules added through
  the Xray API live only in the running process — that is exactly why
  `install_verified_xray_restart` exists (`installer/lib/agent.sh:618`,
  diffing inbounds before and after a restart). Relay uplinks are already
  re-asserted every ~60 s by `apps/backend/src/modules/jobs/sweeps.processor.ts`
  after thirteen dead relay routes all reported ONLINE. Gaming rules need
  the same treatment or an Xray restart silently turns the feature off while
  the client still says it is on.
- **Agent extension is small and additive.** Add a `CommandType`
  (`CONFIGURE_GAMEDNS` / `REMOVE_GAMEDNS`) to `packages/proto/agent.proto`
  and a branch in `dispatch.Execute` (`agent/internal/dispatch/dispatch.go:230`),
  following the `relay.Provisioner` precedent — a non-`common.Provisioner`
  component registered separately and dispatched through its own branch. The
  proto is shared with enrolled nodes, so the change must be additive.
- **Installer**: an `install_gamedns` function shaped like `install_wireguard`
  (`installer/lib/agent.sh:1553`) — systemd unit in `installer/assets/`
  (precedents: `neoxify-phantun@.service`, `neoxify-wstunnel.service`), port
  selection via `suggest_free_port`, firewall and NAT, a menu entry in
  `action_engines_agent` (`:2423`), a call site in `action_install_agent`,
  and teardown in `action_uninstall_agent`. **All five of those, or a fresh
  install is wrong** — this project's rule is that a hotfix on a live server
  is not done until the installer makes a clean install correct.
- **Where the DoH endpoint lives matters.** OONI shows roughly 94% of VPN
  vendor sites blocked in Iran. A resolver on a name that looks like ours is
  a name that gets blocked. Serve DoH behind the node's existing Xray TLS
  fallback path — the same machinery already used so the node does not look
  like a VPN (`installer/lib/agent.sh:440-487` already routes loopback
  8080/8081 behind it). Related: open item 5 in the handover, "Welcome to
  nginx!" on port 80 across three nodes, is a fleet-wide fingerprint that
  would sit directly beside a public resolver.

### 4.5 Windows client

- Gaming DNS mode brings up **no adapter and no tunnel**.
- Use **namespace-scoped NRPT rules** — one per game domain suffix. The
  machinery exists: `apps/desktop-windows/service/src/engines/dns.rs`
  already installs `Add-DnsClientNrptRule -Namespace '.' -NameServers ...`
  and, more importantly, already knows how to **verify removal**, sweeping
  both the local and Group Policy `DnsPolicyConfig` registry keys
  unconditionally at every disconnect and at service start. The change is
  `apply(resolver)` → `apply_namespaces(&[(suffix, resolver)])`, keeping the
  single-`.` behaviour for full tunnel.
  - The module's existing reasoning is why NRPT and not adapter DNS:
    Windows smart multi-homed name resolution races every interface, so an
    adapter-level preference loses to the ISP resolver — and in Iran that
    resolver poisons answers.
  - **A stranded NRPT rule takes the whole machine's DNS down**, not just
    the game's. That is the network-corruption complaint class already on
    record. The existing start-up sweep is the defence; §14 instrument #7
    proves it covers namespace-scoped rules too.
- The rules point at a **loopback DoH stub inside the service**, not at the
  node directly. Three reasons: it can carry the per-customer token; it is
  encrypted so the ISP can neither read nor forge the answers; and it avoids
  sending plain 53 to a foreign address from Iran. Binding it on a loopback
  alias (e.g. `127.0.0.53:53`) needs verifying on a real machine — named as
  an instrument, not assumed.

---

## 5. Mechanism (b) — Gaming route mode

Per-game selective routing on the existing Custom mode (WinDivert split
tunnel), sending chosen processes' traffic to a chosen exit.

### 5.1 The latency cost, and how you would avoid it

Per §2.3: +0.8 ms best case (germany-1, best Iranian network, estimated
second leg), +28 to +66 ms on the other usable nodes, and that is before the
tunnel's own cost. The mitigation in the brief — *route only blocked
destinations, not the whole process* — is correct in principle and
**currently has an empty target set**, because §2.2 found nothing blocked.
So route mode's latency cost today buys exactly one thing: the exit-IP
change. That is a real thing (§1, EZ Connect) but it is not speed, and it
must never be sold as speed.

### 5.2 The surgery

Redirection today is **purely per-process**. Destination IP is used only as
part of the NAT flow key. The single exception is `is_dns()`
(`redirect.rs:570`), which matches `destination_port == 53` and rewrites to
`dns_resolver` — that is the one existing per-destination rule in the whole
product, and it is the shape this needs.

Minimum change, in `apps/desktop-windows/service/src/split_tunnel/`:

- Add `destinations: Option<DestinationFilter>` to `SplitTunnelConfig`
  (`apps/desktop-windows/ipc/src/lib.rs:127-151`), `#[serde(default)]` so
  older services and clients still parse it. **Do not add a third
  `SplitTunnelMode` variant** — the enum's own doc calls the two modes "two
  genuinely different tunnels, not a filter applied twice", and CLAUDE.md
  requires the shared interface stay additive.
- One clause on the `selected` computation at `redirect.rs:1449-1494`:
  `... && destination_matches(parsed.destination)`.
- `FlowKey` (`flows.rs:94`) is already `{transport, client_port,
  destination, destination_port}`, so per-destination decisions cache
  correctly with no change.

### 5.3 Three traps, each of which produces a silent leak

1. **`nat.record_direct` is not destination-aware.** It pins a verdict per
   `(transport, source_port)` for `DIRECT_VERDICT_TTL = 5s`
   (`redirect.rs:1559`, `flows.rs:90`). Under a per-destination policy, one
   non-matching destination pins the whole socket to Direct, and a matching
   destination on that same socket goes out **in clear for up to five
   seconds**. `nat.lookup` / `lookup_flow` are destination-aware; `direct`
   is not. A per-destination policy must not call it.
2. **The DNS branch runs before the selection test and is unconditional**
   (`redirect.rs:1498`). A destination filter that excludes port 53 breaks
   the DNS carry.
3. **The kernel filter string is fixed at `WinDivertOpen`.** Narrowing the
   set in-kernel would cut per-packet cost dramatically but cannot be edited
   live; changing the set means stopping and restarting the loop. The module
   doc at `redirect.rs:25-43` says so.

### 5.4 The two-connection hazard, and the rule that contains it

A destination filter can put WoW's Home and World legs on opposite sides if
their addresses differ — two source IPs, one account, at the same instant.
That is the disqualifying case from §3.

**Rule: a gaming destination filter must be expressed as whole announced
prefixes at ASN granularity** (Blizzard is AS57976, 151 prefixes), never as
individual host addresses, and the client must **refuse to activate a game
profile whose CIDR list is not prefix-complete** rather than activate a
partial one. The filter must not change mid-session.

### 5.5 Fail-open must be inverted for gaming profiles

Custom mode fails open by design, and the comment that says so cites games
as the justification (`proxy.rs:20-23`): *"a game must not stall for the
seconds a protocol switch takes"*. There are four consistent places
(`bind_upstream:376`, `connect_upstream:274-299`, the watchdog at
`mod.rs:341-401`, and `engines/mod.rs:820-830`).

**For a Blizzard account that is the worst possible behaviour.** An
unredirected game connection during a failover is simultaneously the
sanctions signal and the impossible-travel signal — the two things this
product exists to avoid. Add a **per-profile `failClosed: bool`, default
true for gaming profiles and false everywhere else.** This inverts a
documented decision, so it must be a profile property and never a global
change, and the UI must say which behaviour is in force.

### 5.6 Dependency on `claude/split-tunnel-latency`

That branch is **local only, never pushed, five commits ahead of main and
three behind**, and every commit message ends "Not verified against real
traffic; the rig is being rebuilt." It carries exactly the four fixes route
mode depends on:

| commit | fix |
|---|---|
| `7ca86af` | `TCP_NODELAY` on both halves of every relayed TCP connection — the only `nodelay` in the repo. WoW is small frequent packets on TCP: classic Nagle + delayed-ACK penalty. |
| `ed9cd58` | UDP bind retry off the receive loop. On main, `bind_upstream_retrying` runs **inline** for up to 6 s, so one unbindable flow freezes *all* UDP — and it fails exactly when a tunnel address is tentative, i.e. right after connect or failover. Measured 5.83 s freeze of an unrelated flow. |
| `112d35e` | Counters for UDP datagrams the relay fails to hand on (they were silently discarded by `let _ =`). |
| `a67c7ef` | Flow affinity for the divert workers — on main two workers share the handle with no affinity, so a flow's packets can be reordered by design. |

**Route mode must not ship before those are merged and verified on the rig.**
Not "merged" — verified. A green build means it compiles.

---

## 6. Mechanism (c) — the hybrid

DNS-driven destination selection feeding the per-app redirect: the loopback
stub sees every answer it forwards, so it can feed the observed A/AAAA
records for gaming hostnames into the redirect's destination set. Only
sanction-blocked endpoints get carried; game traffic goes direct.

Buildable, and it is how several commercial smart-DNS-plus-route products
work. Two caveats that must be designed for:

- It only learns names the application resolves **through the stub**. Realm
  literals never appear, DoH-pinning apps never appear.
- TTL churn: the set must be additive with an expiry comfortably longer than
  the record TTL, or a live connection outlives its own entry and the
  §5.3 leak fires.

---

## 7. Recommendation

**Ship (c), staged: (a) alone in v1, (b) added in v2 as an explicit,
off-by-default, top-tier option.**

**Why (a) wins v1.** It cannot make ping worse, because it cannot reach the
game path. It works on Android, iOS and consoles. It needs no driver work
and does not depend on the unverified latency branch. Its cost is bounded.
And given §2.2, the thing it would unblock may not exist — so the cheapest
mechanism is the right one to find that out with.

**Why (b) alone loses.** It degrades the one number gamers actually measure,
by +28 to +66 ms on four of five nodes, in exchange for unblocking that our
measurement says is not needed. It carries three silent-leak traps
(§5.3) and the two-connection hazard (§5.4). It depends on four unverified
fixes. And its one real benefit — a stable low-density exit — is supported
only by an analogy to EZ Connect whose mechanism nobody has explained.

**Why (a) alone is not enough either.** It delivers zero exit-IP change for
the game, and the exit-IP change is the only benefit with any supporting
evidence. Selling (a) as an account-safety product would be a lie. Sell (a)
as reachability insurance for launcher, login, patching and store — and only
if instrument #1 says those need it.

**The honest framing of the whole product**: Gaming Mode is *narrower*
routing, not *better* routing. Its value is that it stops carrying the
things that should not be carried.

---

## 8. Client UX — Windows

Design language, taken from the existing code and to be matched exactly:
violet `--primary: #8b5cf6` → cyan `--highlight: #22d3ee`, gradients always
`120deg` (top-left to bottom-right), Vazirmatn bundled variable font,
dark-only (`:root` and `.dark` are defined identically in `theme.css`; there
is no light theme and nobody should promise one), CSS logical properties
throughout.

### 8.1 Where the switch lives

**Both places, with a clear division of labour.**

**Dashboard — a two-segment mode selector directly below the header and
above the identity strip.** Full width. This is the owner's ask and it is
also right: the mode changes what every element below it *means*, so it must
be readable before the orb is.

Reuse the segmented control already in `CustomModeCard.tsx:154-180`
verbatim:

```
groove:    "flex gap-1 rounded-lg border border-white/8 bg-white/[0.025] p-1"
segment:   "press flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors"
selected:  "bg-[linear-gradient(120deg,var(--primary),var(--highlight))] text-white shadow-[0_2px_10px_-4px_var(--primary)]"
idle:      "text-muted-foreground hover:bg-white/8 hover:text-foreground"
```

with a one-sentence hint below in `"text-[11px] text-muted-foreground"`,
exactly as that card does. **Do not add an animated sliding indicator.** The
selected state must be carried by the segment's own background. If anyone
later adds a marker it must animate `inset-inline-start`, the way the Custom
toggle knob already does — see §10.

Switching mode while connected is refused, the same way the location picker
already is (`disabledReason={connectionState === "disconnected" ? undefined
: t("dash.disconnectToChange")}`). The Dashboard's existing rule applies:
turning a mode on mid-session cannot retrofit onto a live tunnel
(`Dashboard.tsx:536`).

**Settings — a fourth rail section, `"gaming"`, above `"custom"`.** For
choosing games, per-game options, and the advanced private-exit toggle.
`SectionId` is a three-value union today and `Settings.tsx` already takes
`customSection: ReactNode` as a prop from `App.tsx` — a fourth section is a
one-line union change plus a pane, injected the same way. Icon: `Gamepad2`
in a `"flex size-8 shrink-0 items-center justify-center rounded-lg
bg-highlight/15 text-highlight"` chip, matching the Custom card's header.

### 8.2 What each mode says it does

Two sentences, no marketing, both languages, in `i18n.tsx` (`en` and `fa`
are both required or the build fails — that guard is a feature).

| key | en | fa |
|---|---|---|
| `dash.modeVpn` | VPN | وی‌پی‌ان |
| `dash.modeGaming` | Gaming | بازی |
| `dash.modeVpnHint` | Everything on this computer goes through Neoxify. | همه‌ی ترافیک این رایانه از نئوکسیفای عبور می‌کند. |
| `dash.modeGamingHint` | Only the game services you choose go through Neoxify. The game itself connects directly, on the shortest path. | فقط سرویس‌های بازی‌ای که انتخاب می‌کنید از نئوکسیفای عبور می‌کنند. خود بازی مستقیم و از کوتاه‌ترین مسیر وصل می‌شود. |

### 8.3 The status surface in gaming mode

This is where the honest-state rule bites hardest, because **there is no
tunnel**, so there is nothing that "Connected" could truthfully mean.

Gaming mode gets its own state set, distinct from `ConnectionState`:

| state | claimable only when | orb | headline |
|---|---|---|---|
| `off` | — | idle violet face | Gaming mode is off |
| `arming` | rules being installed | busy | Setting up… |
| `active` | **all three checks below pass** | success | Gaming mode is on |
| `partial` | rules present, canary failed | warning | Gaming mode is on, but not confirmed |
| `unknown` | the service did not answer | pulsing grey | Can't tell right now |

The three checks for `active`, all of which can fail:

1. Every NRPT rule the service installed is **present** in the registry
   (`engines/dns.rs` already verifies *removal*; add verify-present).
2. A canary hostname resolved through the stub returns the node's proxy
   address, not the real one.
3. A TCP connect to that proxy address succeeds.

Anything less is `partial`, whose string is: *"Gaming mode is on but
Neoxify could not confirm your game traffic is reaching it."* Never
"Connected". `unknown` is its own state and is never folded into `off` —
the Dashboard already works this way (`STATUS_MISSES_BEFORE_UNKNOWN = 4`).

**The exit-IP pill must not appear in gaming mode.** In DNS-only mode the
machine's exit IP is unchanged by design, and showing one would be a
straightforward lie about what the product did. Replace it, in the same
chrome, with a path chip:

```
"mt-2 inline-flex items-center gap-1.5 rounded-full border border-white/12
 bg-white/[0.04] px-2.5 py-1 text-[11px] text-muted-foreground"
```

reading **"Game path: direct"** (fa: «مسیر بازی: مستقیم»). If, and only if,
the v2 private exit is enabled for a game, a second chip names the exit node
in the existing success chrome.

And one line that must be present, in `"mt-1 text-xs text-highlight"` beside
the existing `dash.customActive` slot:

> **Your computer's IP address does not change in this mode.**
> «در این حالت نشانی آی‌پی رایانه‌ی شما تغییر نمی‌کند.»

That sentence is the whole anti-lie. It goes in before anything ships.

### 8.4 How a user picks games

Reuse the `RunningAppPicker.tsx` shape — `createPortal` to `document.body`
(required: the parent `Card` has `backdrop-blur` and would clip a fixed
child), search input with the glyph at logical `start-2.5`, icons with a
lettered fallback tile, already-chosen rows **disabled and still visible**
rather than removed — but backed by the server-curated `GameProfile` list
instead of running processes.

Each row states exactly what will be redirected, because that is the only
way the customer can tell what they bought:

- **"Launcher, login and updates"** — DNS mode, the v1 default.
- **"Launcher, login, updates and the game connection"** — only when the v2
  private exit is on for that game.

A per-row chevron (`ChevronRight className="size-3.5 rtl:rotate-180"`, the
existing convention) opens the per-game options.

Empty state must warn, in the warning chrome the Custom card already uses
(`"rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs
text-warning"`): gaming mode with no games chosen does nothing, and it has
to say so rather than sit there looking enabled. That is the same class of
defect as the Custom-mode empty state, which is already handled this way.

**Do not require the customer to find the launcher and the game separately.**
The handover records that as a real usability failure in Custom mode
(launcher and game are separate products in the picker and nothing says you
need both). A `GameProfile` carries `processNames[]` covering both, so one
row is one game.

---

## 9. Client — Android and iOS

### 9.1 Android

Per-app routing exists two ways already:
`VpnService.Builder.addAllowedApplication` for the Xray/TUN path
(`NeoxifyTunService.kt:346-375`) and `IncludedApplications =` in the
wg-quick text for WireGuard (`NeoxifyVpnPlugin.kt:586-596`). DNS is settable
via `addDnsServer` (`:361`, default `1.1.1.1`).

But **Android has no NRPT equivalent, and setting a DNS server requires a
`VpnService` — an adapter must exist.** So "DNS-only, no tunnel" is not
achievable on Android. Two options:

1. **A narrow-route `VpnService`**: `addDnsServer(stub)` plus `addRoute`
   covering only the gaming destination CIDRs. A real tunnel, but a narrow
   one, and it reuses `NeoxifyTunService` wholesale. **Recommended.**
2. Android 9+ Private DNS (DoT) — a system setting the user types in by
   hand, system-wide, not per-app, and not something the app can set. Not a
   product.

Two things to carry into the UI, not paper over:

- **Android's allow-list is a property of the TUN device, so there is no
  fail-open** (`per-app.ts:14-19`). Selected apps simply have no network
  while reconnecting. Windows fails open; Android does not. For a game that
  asymmetry is a disconnect, and the Android copy must say so.
- The realistic Android audience is Hearthstone and Diablo Immortal. **WoW
  is not on Android**, so §3's two-connection hazard does not apply there —
  but nothing about that generalises to other titles.

Android UI: mirror the desktop mode selector, but in `apps/mobile`'s own
`Dashboard.tsx` and `PerAppCard.tsx`. **These are not shared components.**
The handover is explicit: Android carries a verbatim copy of the desktop
`PerAppCard`, and all four RTL bugs had to be fixed twice. Budget for two
implementations of every string and every control.

### 9.2 iOS

**iOS cannot do per-app routing at all.** It is MDM-only, and that is
recorded in `docs/ios-client.md:69`. There is no per-app split tunnel, no
process selection, and no equivalent of NRPT.

Gaming mode on iOS would therefore be **DNS-only, system-wide**, via a
`NEDNSSettingsManager` DNS-settings provider — the whole device's resolver,
not the game's. There is no way to scope it to a title, and no way to offer
the v2 private exit.

That is a **gap, stated plainly, not a decision made quietly**. If gaming
mode ships on Windows and Android, the iOS product page must say what iOS
cannot do rather than leaving the customer to discover it. Also, per
CLAUDE.md, `apps/mobile/plugins/vpn/ios/**` and `docs/ios-client.md` belong
to the Mac session — any iOS work here is a coordination item, and the
shared plugin interface must stay additive.

---

## 10. Persian and RTL

Persian is first-class here, not a translation pass.

The codebase is already uniformly logical: a grep across
`apps/desktop-windows/src` for `left-`, `right-`, `pl-`, `pr-`, `ml-`,
`mr-`, `border-l-`, `border-r-`, `text-left`, `text-right` returns **zero
matches**. Direction is set on the document (`document.documentElement.dir`)
so portals inherit it, and `theme.css` forces `.tabular-nums` and
`[data-ltr]` to `direction: ltr` under `html[dir="rtl"]`.

Rules for this feature:

1. **Never position a control's state indicator physically.** The specific
   failure this product has already shipped: the Custom-mode toggle knob
   used physical `left-*`, so in Persian the card mirrored and the knob did
   not — **"on" sat exactly where an RTL reader reads "off"**. A control
   lying about whether traffic is tunnelled, to this product's core
   audience, invisible in English, live for months. It is fixed now
   (`start-[1.375rem]` / `start-0.5`, animating `inset-inline-start`), and
   the fix is the template.
2. Hostnames, file paths, IP addresses and ms figures are Latin. Wrap them
   in `dir="ltr"` or `.tabular-nums`, which is the existing convention.
3. Every new key needs both `en` and `fa` in `i18n.tsx`. `TranslationKey =
   keyof typeof en` makes a missing Persian string a **build error** — use
   that, do not work around it.
4. Persian strings need the honest wording too, not a softened translation.
   «شما محافظت می‌شوید» must never appear on a screen where nothing is
   tunnelled.
5. **A Persian screenshot review of the mode selector and the gaming status
   surface is a release gate**, not a nice-to-have. The toggle bug was
   invisible in English review and shipped for months. Both the desktop and
   the Android card need it, separately, because they are separate code.

---

## 11. What we say, and what we never say

**Never:**

- "Ban-safe", "ban immunity", "protects your account from bans". GearUP
  claims this; we do not. And never let a testimonial or an affiliate say
  what we will not say in our own voice.
- "Blizzard allows VPNs."
- "Play from Iran safely."
- "Lower ping", or any millisecond figure we have not measured on that
  customer's own path. Our own data (§2.3) contradicts a ping claim on four
  of five nodes.
- Anything implying the sanctions position changes. The EULA clause is about
  **residence**, not IP address. No product changes where someone lives; it
  only makes it harder to observe. If an account is closed on those grounds,
  neither we nor Blizzard support can help, and we say that before the sale,
  not after.

**Do say, and it is quotable:**

- Blizzard's own support staff have said VPN use is unsupported but not
  against policy — Orlyia (Blizzard CS, 2019): *"We cannot support VPNs, but
  they aren't forbidden for WoW, either."*
  (`us.forums.blizzard.com/en/wow/t/89360`); Vrakthris (2020): *"using a VPN
  is not against policy, it is just unsupported"*
  (`us.forums.blizzard.com/en/wow/t/776135`). Blizzard support staff
  actively recommend a VPN as a connection diagnostic.
- Most penalties blamed on VPNs carry **account-security** labels ("Account
  Sharing", "Unauthorised Account Access"), never cheating labels. That is
  what a shared exit address manufactures: many accounts from one address
  reads as sharing; a sudden new country reads as compromise.
- **Warden inspects memory, not network state** (§3). "The VPN triggered
  anti-cheat" is folklore.
- What gaming mode actually does: it stops carrying the things that should
  not be carried, and leaves the game on the shortest path.

---

## 12. Plan and pricing fit

The real ladder is Starter $3.99 / Pro $6.99 / Ultimate $9.99 (metered),
plus a granted Trial. Crypto is the only payment path for this audience —
international cards do not work from inside Iran, which is why Plisio
replaced NowPayments (its minimum blocked the $3.99 plan).

**Recommendation: a feature of existing tiers. Not a new plan, not an
add-on.**

- **Trial and above: gaming DNS mode.** People must be able to test it
  before paying in crypto. Crypto checkout is high-friction; a feature
  nobody could try before paying will not sell.
- **Ultimate only: the v2 per-game private exit.** The scarce resource is
  not bandwidth, it is **accounts per exit IP** — a low-density address with
  a hard cap is the actual cost, and it is the thing worth reserving for the
  top tier.
- **Not a fourth plan.** Every plan multiplies the route-set matrix, and
  `allowedRoutes` empty means "serves nothing" — a new plan is a
  provisioning liability, and the handover already records thirteen dead
  relay routes reporting ONLINE.
- **Not an add-on SKU.** A second crypto checkout for a small delta is a
  worse trade than folding it into a tier.
- **Do not market a "Gaming plan" at all** until §14's instruments come
  back. Selling the tier before the measurement is exactly the failure mode
  this project's rules exist to prevent.

One hard design rule with a billing consequence: **patch CDN hostnames are
excluded from the proxy list by default.** Multi-GB launcher downloads
through the node eat a metered cap, and the resulting bill is our fault.

---

## 13. Risks

- **The domain-blocking ceiling.** OONI shows roughly 94% of VPN vendor
  sites blocked in Iran. A resolver hostname that looks like ours is a
  hostname that gets blocked. Hence §4.4: DoH behind the node's existing
  Xray TLS fallback, on the decoy name, not on a Neoxify-branded host. And
  the port-80 "Welcome to nginx!" fingerprint (handover open item 5) should
  be gone before anything public is added beside it.
- **Publishers may treat a proxy differently from a VPN.** GearUP partners
  with Tarkov, PUBG, ASUS and Discord — evidence that route optimisers get
  tolerance VPNs do not. Blizzard is not in that list, and we have no
  evidence Blizzard distinguishes them. The EULA's "Unauthorized
  Connections" and "Matchmaking" clauses arguably cover a packet-redirecting
  split tunnel; there is no evidence either has ever been enforced against a
  VPN. Do not claim approval we do not have.
- **Open-resolver abuse.** A plain-53 listener that recurses for strangers
  is a DDoS amplifier and a fast route to a blocklisted node address —
  losing us the node and the address reputation that is the product.
- **Name-asserted proxying.** SNI routing forwards to whatever the client
  names. Without a strict allowlist it is an open proxy, and an open proxy's
  address reputation degrades — again destroying the one thing being sold.
- **NRPT is machine-wide.** A stranded rule breaks DNS for the whole
  computer. Users already report needing a network reset and an uninstall to
  recover from teardown bugs; this is that class.
- **The claim risk.** The moment a page says "lower ping", our own
  measurement contradicts it, and a customer with a stopwatch can prove it.
- **Our five node IPs are datacenter-labelled ASN-wide.** Three of five are
  labelled VPN outright; the other two carry `is_abuser=true`. The control
  result is the important one: **unrelated IPs in the same ASNs return
  identical verdicts, so the label is ASN-wide, not earned.** Rotating to a
  fresh IP at the same provider buys nothing. Anyone costing the v2 private
  exit must price *new providers*, vetted against the feeds **before**
  purchase.

---

## 14. What must be measured before any of this is sold

Every instrument below can come back negative. That is the point. This
project's whole history is tests that could not fail producing false passes:
a 40-byte JSON fetch that passed on every route while browsers were
unusable; `chrome -> proxy: 0, direct: 60` reported as proof of a bug by a
metric that can never show a redirected connection; an MTU experiment that
produced a complete set of plausible numbers describing the wrong link; a
download hashed for days, proving the right bytes arrived and never that
they ran.

Ordered. **#1 and #2 gate the whole product.**

1. **Consumer-ISP reachability from Iran.** *The decisive one.* A signed-in
   beta tester in Iran on TCI / MCI / Irancell runs a scripted sweep — the
   same sixteen hostnames, plus TCP to `37.244.62.99:3724` and
   `eu.actual.battle.net:1119` — and posts raw output. Globalping cannot do
   this: all five Iranian probes are datacenter.
   **Negative result: nothing is blocked, and the unblocking premise is
   dead.** That is a legitimate outcome and it must be allowed to happen.
2. **Authenticated behaviour.** A real Battle.net account logging in from an
   Iranian consumer IP, recording the exact failure and response body if
   any. No unauthenticated probe can see a block that sits behind login, and
   that is the most likely place for one to live.
3. **Node → Blizzard second leg, per node.** `ping -c 100` and
   `mtr --report-cycles 100` from each of the five nodes to `37.244.62.99`
   and `eu.actual.battle.net`. Read-only, non-disruptive. §2.3's +0.8 ms
   best case is an estimate from *other machines* in Frankfurt; germany-1 is
   LightNode and its transit is unmeasured.
4. **End-to-end A/B on the real game.** WoW's own
   `/dump GetNetStats()` — world latency, home latency, in/out bandwidth —
   recorded for 30 minutes direct and 30 minutes on each candidate path,
   same character, same zone, same time of day, **A/B/A**. "It felt
   smoother" and packet counters do not count. Our latency data predicts
   this comes back negative for four of five nodes; if it comes back
   positive for all five, suspect the harness, not the finding.
5. **Loss and jitter, not mean.** `irtt` or a UDP echo against 3724 from the
   tester, ten-minute runs, reporting p50 / p95 / p99 and loss. §3: below
   the 400 ms `SpellQueueWindow`, mean barely matters and loss does.
6. **The DNS stub's failure mode.** Block 443 to the resolver host at the
   tester's end and confirm the client **says so** rather than silently
   falling back to the ISP resolver. This test exists solely to catch a lie,
   which is the bug class this project keeps finding.
7. **NRPT cleanup after a hard kill.** `taskkill /f` the service with
   namespace-scoped rules installed, reboot, then read both the local and
   Group Policy `DnsPolicyConfig` keys. `engines/dns.rs` sweeps at start;
   prove the sweep covers namespaced rules, not just the `.` rule.
8. **Exit-IP density.** Count distinct customer accounts egressing per exit
   IP per hour, from the node's own connection log. The EZ Connect thesis is
   that density is the mechanism; if we cannot measure ours we cannot claim
   to have improved it.
9. **DoH-pinning applications.** Install the rules, then take a packet
   capture and confirm whether the Battle.net launcher's lookups actually
   traverse the stub. If it resolves in-process, DNS mode never sees it and
   §4.2.3 becomes fatal rather than theoretical.
10. **Amplification safety.** From outside, `dig ANY isc.org @<node>` must
    return REFUSED. Non-negotiable before any plain-53 listener is public.
11. **Loopback stub binding.** Confirm on a real machine that the stub can
    hold its loopback address and port across sleep, fast-user-switching and
    a network change, and that NRPT actually routes to it.

Two standing traps when writing any of these: **force IPv4 on every exit-IP
assertion** (the nodes have v6 and a v6 answer fakes a total failure), and
**`urllib` cannot speak SOCKS** — both have previously produced convincing
false negatives.

---

## 15. Effort and sequencing

| Window | Work | Depends on |
|---|---|---|
| **Week 1** | Merge `claude/split-tunnel-latency` **and verify it on the rig** — all four fixes are explicitly unproven. In parallel, run instruments **#1, #2, #3, #9**. | rig rebuilt |
| **Weeks 2–3** | Backend: `GameProfile` table, panel CRUD, `PlanFeature` gating, `GET /customer/gaming-profile`, per-customer resolver token. No node changes, no client changes. | #1 came back positive |
| **Weeks 3–5** | Node: CoreDNS unit + `install_gamedns` in `installer/lib/agent.sh` (+ engines menu, install call site, uninstall teardown), agent `CommandType` + `dispatch.Execute` branch, Xray `dokodemo-door` inbound + `domain:` rules via `RoutingService.AddRule`, **and the re-assert sweep**. | backend |
| **Weeks 5–7** | Windows client: `dns.rs` namespace rules + verify-present, loopback DoH stub, Dashboard mode selector, Settings gaming pane, game picker, `en` + `fa` strings, Persian screenshot pass. | node |
| **Week 8** | Beta with the Iranian testers. Instruments **#4–#8, #10, #11**. Nothing is sold before this closes. | all |
| **+2 weeks** | Android: narrow-route `VpnService`, its own Dashboard and card (not shared), its own RTL pass. | Windows |
| **A quarter** | v2 per-game private exit: destination filter in `decide()`, the `record_direct` fix, per-profile `failClosed`, sticky exit per customer, low-density exit IP procurement from **new** providers vetted before purchase. | `claude/split-tunnel-latency` **verified**, plus #4 and #8 |
| **Unscheduled** | iOS: DNS-only, system-wide, no per-app anything. Mac session; coordinate per CLAUDE.md; `docs/ios-client.md` is theirs. | — |

Week 1 is genuinely a week. The quarter item is genuinely a quarter — the
split tunnel took four designs against real packet captures before one
worked, and the destination filter reopens the same decision path.

---

## 16. Open questions

Things this document could not settle, listed so nobody assumes they were
settled:

- **Is anything actually blocked for a real Iranian player?** Unmeasured
  from consumer networks (§2.4.1). Instrument #1.
- **Does a block sit behind login?** Unmeasured (§2.4.2). Instrument #2.
- **Why does EZ Connect work from an Iranian IP?** Still unexplained.
  Everything downstream of "a stable low-density address is what helps" is
  inference from their ToS and user reports, not a mechanism anyone has
  demonstrated.
- **Does the Battle.net launcher resolve in-process?** Unmeasured.
  Instrument #9. If it does, DNS mode cannot reach it.
- **What does a low-density exit at a non-datacenter provider cost?**
  Residential/ISP space is what would change the classification; pricing was
  never obtained.
- **Does Blizzard use any IP-reputation feed at all?** Not established, in
  this document or the prior research.
- **Whether modern Warden checks network state.** The evidence against is
  strong (§3) but it is absence of evidence plus one affirmative
  counter-observation, not proof.
