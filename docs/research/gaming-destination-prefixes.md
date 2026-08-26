# Can a destination prefix list ever be *complete*? — measurement, 2026-08-25

**Verdict: no, for every publisher measured — Blizzard, Riot and Valve.
`prefixComplete` stays `false` on all three seeded profiles, and
`SplitTunnelConfig.scopes` stays inert.**

This document exists so nobody repeats the work. The question was not
"can we fetch a publisher's announced prefixes" — that is trivial and
took ten minutes. The question was whether such a list is *complete with
respect to the set of connections that must share one source IP*, and
the answer is no for a structural reason that applies to modern titles
generally, not to these three by accident.

**The counterexample was found on the first game, and it is the single
most important host in the profile. Then three more were found.**

---

## 0. The finding in one paragraph

Modern publishers keep their **game servers** on their own ASN and put
their **control plane** — login, entitlements, client config,
patch/version negotiation, session brokering — plus **voice** on
third-party infrastructure (Google Cloud, AWS, Cloudflare, Akamai,
Unity/Vivox). A prefix list
scoped to the publisher's ASN therefore captures precisely the half that
does *not* need tunnelling to work from Iran, and misses precisely the
half that does. Worse for the safety claim: the control plane is where
the **account** lives, so the publisher-ASN boundary is the *maximally
wrong* place to split. It puts the account session and the game session
on different source addresses **by construction** — which is the exact
account-sharing signature the `prefixComplete` rule exists to prevent.

---

## 1. Where these lookups were made from, and what that limits

All DNS resolution and TCP probing in this document was done **from the
Windows development machine in Germany**, using three independent
resolvers: Cloudflare DoH (`cloudflare-dns.com`), Google DoH
(`dns.google`), and the local ISP resolver via `nslookup`. BGP data is
from **RIPEstat's Data API**, `announced-prefixes` and
`prefix-overview`, observation window `2026-08-11T16:00Z` →
`2026-08-25T16:00Z`.

DNS answers are geo-dependent, so a German vantage point does not by
itself establish what an Iranian client resolves. **For the decisive
finding it does not have to**, because `docs/design/gaming-mode.md` §2.2
already recorded the same hostnames resolved *from four Iranian
networks*, and those answers are in the same third-party address space —
see §2.3 below, where the Iranian-observed addresses are mapped to their
origin ASNs. That cross-check is what turns this from "true where I am"
into "true from Iran too".

What is **not** established from outside Iran, and is marked as such
throughout: whether any of these third-party edges *refuses* an Iranian
or a datacenter source address. That is a reputation question, not a
routing question, and it is `docs/research/gaming-ip-reputation.md`'s
subject rather than this one's.

---

## 2. Blizzard — AS57976

### 2.1 The prefix list itself is easy and was fetched

RIPEstat `announced-prefixes` for AS57976, window ending
2026-08-25T16:00Z: **182 prefixes — 151 IPv4 and 31 IPv6.** The 151
figure matches the number quoted in `docs/design/gaming-mode.md` §5.4
independently, which is a useful corroboration that both counts are
reading the same reality.

Getting the list was never the problem. What the list *contains* is.

### 2.2 What the game's own endpoints actually resolve to

Every hostname in the seeded `wow` profile, resolved from Germany across
three resolvers, each answer address mapped to its origin AS via
RIPEstat `prefix-overview`:

| Hostname | Origin AS of every answer | In AS57976? |
|---|---|---|
| `us.actual.battle.net` | **AS396982 Google Cloud** | **no** |
| `eu.actual.battle.net` | **AS396982 Google Cloud** | **no** |
| `kr.actual.battle.net` | **AS396982 Google Cloud** | **no** |
| `us.version.battle.net` / `eu.version.battle.net` | **AS396982 Google Cloud** | **no** |
| `us.patch.battle.net` / `eu.patch.battle.net` | **AS396982 Google Cloud** | **no** |
| `oauth.battle.net` | AS16509 Amazon | no |
| `account.battle.net` | AS16509 Amazon | no |
| `battle.net`, `www.battle.net`, `us.battle.net`, `eu.battle.net`, `kr.battle.net` | AS16509 Amazon | no |
| `shop.battle.net`, `eu.shop.battle.net` | AS16509 Amazon | no |
| `blizzard.com` | AS16509 Amazon | no |
| `www.blizzard.com`, `worldofwarcraft.blizzard.com` | AS14618 Amazon (AES) | no |
| `render.worldofwarcraft.com` | AS16509 Amazon (S3) | no |
| `us.api.blizzard.com`, `eu.api.blizzard.com` | AS16509 Amazon | no |
| `us.forums.blizzard.com` | AS16509 Amazon (Discourse-hosted) | no |
| `level3.blizzard.com` | AS20940 Akamai | no |
| `blzddist1-a`/`blzddist2-a`/`bnetcmsus-a`/`bnetproduct-a`/`blzmedia-a`.akamaihd.net | AS20940 Akamai | no |
| `cdn.blizzard.com`, `us.cdn.blizzard.com`, `eu.cdn.blizzard.com` | AS57976 Blizzard | **yes** |
| `telemetry-in.battle.net` | AS57976 Blizzard | **yes** |

| `us.launcher.battle.net` | AS57976 Blizzard | **yes** |

`tw.actual.battle.net`, `us.logon.battle.net`, `eu.logon.battle.net`,
`client-api.battle.net` and the bare `launcher.battle.net` are NXDOMAIN
from all three resolvers — they do not exist, and any list built from a
blog post that names them is already wrong. (The regional
`us.launcher.battle.net` does exist and is in AS57976.)

**Three of twenty resolvable hostnames are inside Blizzard's own ASN,
and two of the three are things you would deliberately leave direct** —
a CDN and a telemetry sink.

### 2.2a Blizzard publishes the CDN list itself, and it is not Blizzard's

Worth recording because it is a genuinely authoritative, machine-readable
first-party source that costs one HTTP request. The patch service serves
each product's CDN configuration over the same port-1119 endpoint the
client uses:

```
$ curl http://us.patch.battle.net:1119/wow/cdns
Name!STRING:0|Path!STRING:0|Hosts!STRING:0|Servers!STRING:0|ConfigPath!STRING:0
## seqn = 3518786
us|tpr/wow|level3.blizzard.com us.cdn.blizzard.com|http://level3.blizzard.com/?maxhosts=8 ...
eu|tpr/wow|level3.blizzard.com|http://level3.blizzard.com/?maxhosts=8 ...
kr|tpr/wow|level3.blizzard.com kr.cdn.blizzard.com blizzard.gcdn.cloudn.co.kr|...
cn|tpr/wow|blzdist-wow.necdn.leihuo.netease.com|...
```

The same shape works for `bna` (the Battle.net app), `agent` (the
downloader), `pro`, `d3`, `hsb`. Note that the **EU row lists only
`level3.blizzard.com`** — which despite the name is **Akamai AS20940**,
not Lumen — and that `us.cdn.blizzard.com` (the one host actually in
AS57976) appears with `fallback=1`. So for a European WoW install the
primary content path is entirely Akamai, and the Blizzard-ASN CDN is the
backup. The name is historical and is a trap: *names are not evidence,
resolve them.*

### 2.3 The counterexample, stated precisely

`docs/design/gaming-mode.md` §3 records, as a carried-forward fact:

> Realm addresses arrive inside the Battle.net session as literals, not
> from a resolver.

That Battle.net session is the port-1119 connection to
`*.actual.battle.net`. The seeded profile's own comment already
identifies those two hosts as the correctness-critical ones — it puts
them in `excludeHostnames` and explains at length that redirecting them
would break the launcher.

**They are on Google Cloud.**

So: the connection that *tells World of Warcraft which address its realm
is on* is itself outside Blizzard's ASN. An AS57976 prefix list would
carry the realm connection and not the connection that brokered it. That
is not a marginal gap at the edge of the list; it is the middle of it.

This is corroborated from Iran, not only from Germany. The addresses
`docs/design/gaming-mode.md` §2.2 recorded from four Iranian networks,
mapped to origin AS:

```
34.118.243.237   34.118.240.0/22   AS396982 GOOGLE-CLOUD-PLATFORM     (us.actual)
34.125.219.30    34.125.208.0/20   AS396982 GOOGLE-CLOUD-PLATFORM     (us.actual)
34.125.159.31    34.125.144.0/20   AS396982 GOOGLE-CLOUD-PLATFORM     (us.actual)
34.34.51.91      34.34.0.0/17      AS396982 GOOGLE-CLOUD-PLATFORM     (eu.actual)
34.13.208.150    34.13.128.0/17    AS396982 GOOGLE-CLOUD-PLATFORM     (eu.actual)
35.204.95.176    35.204.80.0/20    AS396982 GOOGLE-CLOUD-PLATFORM     (eu.actual)
63.181.215.22    63.180.0.0/14     AS16509  AMAZON-02                 (oauth)
3.78.117.122     3.64.0.0/12       AS16509  AMAZON-02                 (oauth)
63.186.190.245   63.184.0.0/14     AS16509  AMAZON-02                 (oauth)
166.117.1.1      166.117.0.0/20    AS16509  AMAZON-02                 (us/eu/shop.battle.net)
54.76.247.89     54.76.0.0/15      AS16509  AMAZON-02                 (worldofwarcraft.blizzard.com)
137.221.105.1    137.221.104.0/22  AS57976  BLIZZARD                  (telemetry-in)
37.244.62.99     37.244.60.0/22    AS57976  BLIZZARD                  (WoW EU realm/world, port 3724)
```

The Iranian probes and the German ones disagree about *which* address
they got — they were answered by different regional load balancers — and
agree completely about **whose network it is**. `eu.actual.battle.net`
even returned the identical address (`34.13.208.150`) to an Iranian
probe and to this machine's ISP resolver.

Note the last line: the **WoW game server itself is in AS57976**
(`37.244.60.0/22`). The game servers were never the problem. Everything
around them is.

### 2.4 Proved by connecting, not only by resolving

DNS alone would be weak evidence — an answer is not a service. TCP
connect from Germany, 2026-08-25:

```
us.actual.battle.net:1119 via 34.16.211.209  connect  33ms  b'HTTP/1.1 403\r\nContent-Length: 9\r\n...Forbidden'
eu.actual.battle.net:1119 via 34.32.129.55   connect 160ms  b'HTTP/1.1 403\r\nContent-Length: 9\r\n...Forbidden'
us.actual.battle.net:443  via 34.16.211.209  TimeoutError
eu.actual.battle.net:443  via 34.32.129.55   TimeoutError
us.patch.battle.net:1119  via 8.228.22.130   connect  33ms  b'HTTP/1.1 404 Not Found...'
eu.patch.battle.net:1119  via 34.141.190.240 connect 143ms  b'HTTP/1.1 404 Not Found...'
```

That is byte-for-byte the signature `docs/design/gaming-mode.md` §2.2
recorded from Iran and from three control countries — 403 on 1119, hard
timeout on 443. **The service really is served from Google Cloud
address space**, on the port the Battle.net client actually uses. The
403 is a protocol mismatch (an HTTP request to a host that speaks
Battle.net), which is what confirms something is listening rather than a
load balancer answering for nothing.

### 2.5 The second, independent disqualifier: the addresses do not hold still

Even a reader willing to accept "then put Google Cloud in the list too"
runs into this. Distinct A records observed for the two hosts, over ~20
DoH queries from Germany in a few minutes, unioned with the six the
Iranian probes recorded:

| Host | distinct addresses | spanning |
|---|---|---|
| `us.actual.battle.net` | 18 | 3 different Google /16s (`34.16`, `34.118`, `34.125`) |
| `eu.actual.battle.net` | 15 | **8** different Google /16s (`34.13`, `34.32`, `34.34`, `34.91`, `34.141`, `34.147`, `35.204`, `35.234`) |

This is a Google Cloud load-balancer pool, not a service on a pinned
address. There is no stable prefix set to enumerate even in principle —
the set is Google's to change without notice and without announcement,
and it is not the sort of thing a `destinationCidrs` array can track.

### 2.5a Voice is a second, independent counterexample — and it fails silently

The brief asked specifically which endpoints must share a source IP, and
named voice as a candidate. It is one, and it is worse than the others
because scoping to AS57976 **breaks voice while the game still
connects** — the "Connected, but something doesn't work" class this
product already knows it must avoid.

**Blizzard's in-game voice chat is Vivox, now owned by Unity.** This is
first-party confirmed: a verified Blizzard Technical Forum Agent wrote in
2019 that Overwatch uses a service called Vivox, and the shipped binaries
agree — WoW installs `utils\vivoxsdk_x64.dll` (company "Mercer Road
Corp") next to Blizzard's own `wowvoiceproxy.exe`, and the Battle.net app,
HotS and Diablo IV ship `vivoxsdk*.dll` too.

Vivox's own current documentation (updated 2026-08-06) gives the address
space: control on TCP 443 to `*.vivox.com`, media on **UDP 12000–54000**
to **85.236.96.0/21 and 85.236.104.0/23**. Verified here:

```
85.236.99.65   85.236.99.0/24    AS35028 MULTIPLAY Unity Technologies ApS
85.236.98.31   85.236.98.0/24    AS35028 MULTIPLAY Unity Technologies ApS
85.236.104.1   85.236.104.0/23   AS35028 MULTIPLAY Unity Technologies ApS
```

Not Blizzard, not AWS, not Google — a fourth party again. Two further
points matter:

- Vivox states it does **not** publish a per-tenant FQDN allowlist and
  that its UDP media does not route through named hosts. So even the
  DNS-observation mechanism (§7) could not learn these addresses; there
  is no lookup to observe.
- `docs/design/gaming-mode.md` §3 already carries "voice chat is UDP
  12000–64000, per-port rules break voice, per-process selection is the
  right mechanism". That conclusion is now reinforced by a second route:
  per-*destination* rules break voice too, and a publisher-ASN filter
  breaks it by definition.

Caveat, stated plainly: that Blizzard's specific Vivox tenant lands in
those two prefixes is inferred from Vivox's published allowlist, not
proven by a capture of a live WoW voice session. It does not need to be
proven to settle this question — the vendor is confirmed first-party and
the vendor is not Blizzard — but anyone building on it should capture it.

### 2.5b There is no second Blizzard ASN hiding the missing half

The obvious rescue is "perhaps the rest is on another Blizzard ASN".
Checked, and it is not. Blizzard holds two further ASNs and **both
announce zero prefixes** as of the same RIPEstat window:

```
AS32163  BLIZZARD ENTERTAINMENT INC   prefixes announced: 0
AS55497  BLIZZARD-AP                  prefixes announced: 0
```

AS57976 is the entire in-house footprint. What is missing from it is
missing from Blizzard's network altogether.

### 2.5c The pattern is not new — Blizzard's own retired docs show it

Blizzard published per-region game-server addresses exactly once, in a
"Performing a Trace Route" support article that has since been retired
(archived captures from 2013-12 and 2015-08). Those pages listed 22
individual addresses — **never CIDR ranges**; no Blizzard article, past
or present, has published prefixes for network administrators.

Mapping those 22 published addresses to their origin AS today: only
three (185.60.114.159, 103.4.115.248, 202.9.67.254) are in AS57976. The
rest were in AT&T (AS7018), Telia (AS1299), LG DACOM (AS3786) and HiNet
(AS3462). The same article told readers to recognise Blizzard's servers
in a traceroute by looking for `att.net`, `alter.net` and `telia.net`
suffixes — Blizzard documenting, in its own words, that its game servers
lived in other people's address space.

Much of that has since moved in-house. The point is that "the
publisher's ASN contains the publisher's game" has never been reliably
true for this publisher, and the current situation is a continuation
rather than a recent regression.

### 2.6 Why "just add the CDN prefixes" is not a fix

It fails on two counts, either of which is fatal:

1. **It is not scoping any more.** AS16509 (Amazon) alone announces a
   substantial fraction of the routed internet; AS13335 and AS20940 are
   comparable. A "Blizzard" list that contains Amazon, Google and Akamai
   is a full tunnel with extra steps. It would also drag the
   multi-gigabyte Akamai patch downloads into the tunnel — which the
   seeded profile deliberately leaves direct, because carrying them eats
   a metered plan's cap and the bill is the customer's.
2. **It still would not be complete**, per §2.5 and §2.5a. Shared edge
   addresses rotate, and Vivox's media range is not discoverable by
   name at all. A list that is wrong tomorrow was never a safety claim,
   it was a snapshot.

### 2.7 Could scoping just `Wow.exe` work, ignoring the launcher?

No, and it is worth writing down because it is the obvious next idea.
`Wow.exe` holds its own port-1119 Battle.net service connection for the
in-game friends list and cross-realm chat — the same
`*.actual.battle.net` hosts, the same Google Cloud — and it carries
Vivox voice to AS35028 as well. The seeded profile is also deliberately
one row covering launcher and game together, because the handover
records customers selecting one, getting half a product, and nothing
telling them they needed both.

### 2.8 Summary: four independent disqualifiers

Any one of these settles it. All four hold.

| # | Endpoint | Where it actually is | Consequence of an AS57976-only filter |
|---|---|---|---|
| 1 | `*.actual.battle.net:1119` — Battle.net session, source of WoW's realm list | Google Cloud AS396982 | Account session and game session on two source IPs at once — the banning signature |
| 2 | `oauth.battle.net`, `account.battle.net` | AWS AS16509 | Login is not carried; the thing most likely to need tunnelling from Iran goes direct |
| 3 | In-game voice (Vivox) UDP 12000–54000 | Unity/Multiplay AS35028 | Voice breaks silently while the game connects |
| 4 | Address instability of #1 | 8 Google /16s in minutes | Nothing stable to enumerate even if you accepted #1–#3 |

**Blizzard verdict: `prefixComplete: false`. Not "not yet" — not
achievable by this mechanism.**

### 2.9 The one thing this did not establish

**Whether WoW's realm and world sockets (TCP 3724) are wholly inside
AS57976 is not proven here**, and cannot be from outside a live client
session: realm addresses arrive as literals inside the Battle.net
session, so no resolver ever sees them and no documentation lists them.
The single data point available is from
`docs/design/gaming-mode.md` §2.2, where `37.244.62.99:3724` was probed
as a WoW EU realm/world endpoint and is in `37.244.60.0/22` (AS57976).
That is one address, chosen by a previous sweep, not an enumeration.

This gap does **not** weaken the verdict — four disqualifiers already
stand, and confirming the game servers are in-house would not rescue a
list that misses login, session brokering and voice. It is recorded
because it is the measurement anyone reviving this idea would have to
take, and it needs a packet capture from a real WoW login, not more
lookups.

---

## 3. Riot — AS6507

The claim in `apps/backend/prisma/game-profiles.ts` and in the
2026-08-25 journal entry was *inferred*. It is now **measured, and it
holds — more strongly than it was stated.**

AS6507 announces **37 prefixes — 36 IPv4 and `2a04:82c0::/29`**
(RIPEstat, same window). Of 22 Riot hostnames resolved:

| Hostname | Origin AS | In AS6507? |
|---|---|---|
| `auth.riotgames.com` | **AS13335 Cloudflare** (CNAME `…cdn.cloudflare.net`) | no |
| `authenticate.riotgames.com` | AS13335 Cloudflare | no |
| `entitlements.auth.riotgames.com` | AS13335 Cloudflare | no |
| `clientconfig.rpg.riotgames.com` | AS13335 Cloudflare | no |
| `playerpreferences.riotgames.com` | Cloudflare (CNAME; no A) | no |
| `pd.eu.a.pvp.net`, `pd.na.a.pvp.net` | AS13335 Cloudflare | no |
| `glz-eu-1.eu.a.pvp.net`, `glz-na-1.na.a.pvp.net` | AS13335 Cloudflare | no |
| `shared.eu.a.pvp.net` | AS13335 Cloudflare | no |
| `euw1.api.riotgames.com`, `esports.api.riotgames.com` | AS13335 Cloudflare | no |
| `telemetry.sgp.pvp.net` | AS13335 Cloudflare | no |
| `valorant.secure.dyn.riotcdn.net` | AS13335 Cloudflare + AS16509 CloudFront | no |
| `ddragon.leagueoflegends.com` | AS16509 Amazon CloudFront | no |
| `riotgames.com`, `www.riotgames.com`, `lolstatic-a.akamaihd.net` | AS20940 / AS16625 Akamai | no |
| `prod.euw1.lol.riotgames.com` | AS6507 Riot | **yes** |

**One hostname out of twenty-two is in Riot's own ASN**, and it is a
League game server. The entire VALORANT control plane —
`pd.*`/`glz-*.a.pvp.net`, the player-data and game-lobby-zone services —
is behind Cloudflare with explicit `.cdn.cloudflare.net` CNAMEs, which
is proof of Cloudflare *proxying* rather than merely Cloudflare-hosted
address space.

An AS6507 destination filter would route the League game session and
nothing else — not login, not entitlements, not client config, not
matchmaking. **`prefixComplete: false` for both Riot rows, confirmed by
measurement.**

The downstream consequence for the product is the one the journal
already flagged: a Riot profile's missing half is **exit-IP reputation**
at Cloudflare, not routing. Nothing in `destinationCidrs` can address
that.

---

## 4. Valve / Steam — AS32590, as a control

Run deliberately as the best possible case: Valve owns AS32590, runs its
own content network, and announces **78 prefixes — 45 IPv4 and 33
IPv6.** If the "publisher ASN is enough" premise were ever going to hold
anywhere, it would hold here.

| Hostname | Origin AS |
|---|---|
| `steamcommunity.com`, `store.steampowered.com`, `help.steampowered.com` | AS16625 Akamai |
| `api.steampowered.com`, **`login.steampowered.com`** | AS20940 Akamai |
| `steamcdn-a.akamaihd.net`, `cdn.akamai.steamstatic.com`, `cdn.cloudflare.steamstatic.com`, `media.steampowered.com` | AS20940 Akamai |
| `avatars.steamstatic.com` | AS54113 Fastly |

**Zero of twelve** Steam hostnames resolved into AS32590 from this
vantage point — including `login.steampowered.com`, the auth surface.
(Note the trap in `cdn.cloudflare.steamstatic.com`: the *name* says
Cloudflare and the answer is Akamai. Names are not evidence.)

Three publishers, three own-ASNs, three times the account surface lives
somewhere else. This is an industry pattern, not three coincidences.

---

## 5. What this means for `SplitTunnelConfig.scopes`

The mechanism is sound and the gate is correct. What is missing is data
that does not exist to be collected, for the games in the catalogue.

- **Do not weaken `canRouteByDestination`.** It is doing exactly its
  job: refusing to act on a list nobody can honestly complete.
- **Destination scoping is not dead in general** — it is dead *as
  "route the publisher's ASN"*. §7 lists the shapes that could still
  work.
- The realistic near-term path for gaming remains **per-process
  routing**, which is what ships today, plus the exit-IP reputation work.
  Per-process routing has the property publisher-ASN scoping does not:
  it cannot split one application's connections across two source
  addresses, because the decision is made per process and not per
  destination.

---

## 6. Procedure for evaluating the next game

Roughly an hour per title. Do it in this order; **stop at the first
"no"**, because one endpoint outside the list settles it.

0. **Check for sibling ASNs before trusting a single one.** A publisher
   may hold several. Blizzard holds three; two announce nothing, which is
   what makes "AS57976 is the whole footprint" a checked statement rather
   than an assumption. RIPEstat `as-overview` per candidate ASN, or a
   search by holder name.

1. **Get the publisher's announced prefixes.** Free, no key, authoritative:
   ```
   curl -s "https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS<n>"
   curl -s "https://stat.ripe.net/data/as-overview/data.json?resource=AS<n>"   # confirms the holder
   ```
   Record `query_starttime`/`query_endtime` from the response — that is
   the observation window, and it is what makes the claim datable.
   Corroborate with bgp.he.net or PeeringDB. Capture IPv4 **and** IPv6;
   a v4-only list leaks on a dual-stacked machine.

2. **Enumerate what the game actually dials.** Not a blog post. In
   order of preference: the client's own config or CDN-manifest
   endpoints (Blizzard's `http://us.patch.battle.net:1119/<product>/cdns`
   is the model — machine-readable and first-party); the publisher's
   firewall/ports documentation; a packet capture from a real session.
   Include, explicitly, all six of: **login/OAuth, entitlements, client
   config, patch/version negotiation, matchmaking or session brokering,
   and voice.** These six are where the counterexample lives every
   single time — Blizzard failed on four of them.

   Be aware that publishers increasingly do *not* document this. Blizzard's
   current firewall article contains zero hostnames, IPs or ports; the
   only current first-party port list is a 2020 forum post by a verified
   CS agent, who says outright the information was removed from the
   article. Absence of documentation is not absence of endpoints.

   **Voice deserves its own check.** It is routinely a fourth party
   (Vivox/Unity for Blizzard), it is UDP on a wide ephemeral range, and
   it breaks *silently* — the game connects and players cannot hear each
   other, which is the worst failure to debug from a support ticket.

3. **Resolve each endpoint and map every answer to its origin AS.**
   Use at least two independent resolvers plus a local one; DNS answers
   are geo-dependent.
   ```
   curl -s -H 'accept: application/dns-json' "https://cloudflare-dns.com/dns-query?name=<h>&type=A"
   curl -s "https://dns.google/resolve?name=<h>&type=A"
   curl -s "https://stat.ripe.net/data/prefix-overview/data.json?resource=<ip>"
   ```
   `scripts` for this are not committed; the twenty lines in
   `resolve.py` used for this document are trivial to rewrite.

4. **Apply the three tests, in this order:**
   - **Counterexample test.** Is there *one* endpoint outside the
     publisher's prefixes? If yes → `prefixComplete: false`, stop. Do
     not weigh it against how many were inside.
   - **Shared-source-IP test.** List the connections that must present
     one source address. For an MMO that is at minimum the account
     session and the game session; check also voice, party and
     launcher-to-game handoff. Would the filter ever put two of them on
     opposite sides? If it could → `false`.
   - **Stability test.** Resolve the critical endpoints ~20 times over
     several minutes. If the answers wander across prefixes, there is
     nothing stable to enumerate → `false`, regardless of ASN.

5. **Look for the counterexample on purpose, and write down what you
   tried.** A completeness claim means nothing unless the search that
   failed to break it is recorded. If you conclude `true`, the profile
   comment must say what was searched and what would invalidate it.

6. **Say where you looked from.** If a claim needs an Iranian resolver,
   mark it and write the one-line check a beta tester can run.

### A shortcut that saves most of the hour

Resolve **the login hostname first**. It has been on third-party edge
infrastructure for every publisher measured. If it is not in the
publisher's ASN, the list is incomplete by construction and steps 1–5
are unnecessary.

### What would make a game a genuine candidate

All of these, together — and no title in the catalogue has them:

- Auth, entitlements and session brokering all inside the publisher's
  own ASN, on stable addresses;
- No Cloudflare/Akamai/CloudFront/GCLB front on anything except
  patch/CDN content;
- A published, versioned address list from the publisher (some
  enterprise-facing services publish these; game publishers generally do
  not);
- A single session, or several sessions that provably share an
  endpoint set.

Older or self-hosted titles are the plausible place to look — private
or community-run servers, or publishers that never moved their control
plane to a CDN. That is a different research question and it has not
been done.

---

## 7. Shapes that could still work, if destination scoping is wanted

None of these are built, and none are recommended without their own
measurement.

- **DNS-observed destination sets** (`docs/design/gaming-mode.md` §6,
  mechanism (c)): the resolver stub sees the answers it hands out and
  feeds *those* addresses into the redirect. This tracks GCLB rotation
  automatically because it never enumerates a prefix — it observes the
  address the client is about to use. The caveat is the one in §6 there:
  literal addresses that never pass a resolver (WoW's realm list) are
  invisible to it, which is the mirror image of this document's problem.
- **Scope by exclusion, not inclusion**: tunnel everything the process
  emits *except* known CDN prefixes. That keeps the account and game
  sessions together by default — the safety property is preserved
  because the default is "same side" — and it only needs the patch-CDN
  ranges to be right, which is a much weaker claim than completeness.
  This inverts the current design and would need its own review.

---

## 8. Staleness — when this must be re-checked

BGP is not static; publishers announce and withdraw prefixes, and
services migrate between clouds in both directions.

- **The prefix counts** (151/31 Blizzard, 36/1 Riot, 45/33 Valve) are a
  snapshot of the RIPEstat window ending **2026-08-25T16:00Z**. Treat
  any figure older than ~3 months as unverified.
- **The verdict is far more durable than the counts.** It does not rest
  on how many prefixes anyone announces; it rests on *where the login
  and session-brokering endpoints live*. Re-checking it is step 3 of §6
  applied to about six hostnames — perhaps fifteen minutes.
- **Re-check when any of these happens**, not on a calendar:
  - a publisher announces moving auth back onto its own infrastructure;
  - someone proposes flipping `prefixComplete` to `true`;
  - a new game profile is added to the catalogue;
  - `SplitTunnelConfig.scopes` gets a second consumer.
- The regression guard is
  `apps/backend/src/modules/gaming/game-catalogue.spec.ts`. It asserts
  the seed's invariants — that a profile claiming completeness has a
  non-empty, parseable list, and that today's three profiles do not
  claim it. It cannot detect that a list has gone stale; only step 3
  can.

---

## 9. Sources

- RIPE NCC RIPEstat Data API — `announced-prefixes`, `as-overview`,
  `prefix-overview`. <https://stat.ripe.net/docs/data_api>
- Cloudflare DNS-over-HTTPS JSON API, `cloudflare-dns.com/dns-query`.
- Google Public DNS resolve API, `dns.google/resolve`.
- Blizzard's own patch service CDN manifest,
  `http://us.patch.battle.net:1119/<product>/cdns` — first-party,
  machine-readable, queried 2026-08-25.
- Blizzard Support, "Troubleshooting Firewall Configuration Issues"
  (article 7842, updated 2026-02-05) — cited for what it does *not*
  contain: no hostnames, addresses or ports.
- Blizzard CS forum post, verified staff, 2020-01-19 — the only current
  first-party port list, including WoW on TCP/UDP 3724/1119/6012 and
  the voice ranges.
  <https://us.forums.blizzard.com/en/sc2/t/how-to-put-in-ports-number-for-blizzard-games/7533>
- Blizzard Technical Forum Agent, 2019-12-19, confirming Vivox as the
  voice provider.
  <https://us.forums.blizzard.com/en/overwatch/t/cant-unmute-pc/438910/4>
- Unity/Vivox, "IPs and ports required", updated 2026-08-06 — the
  85.236.96.0/21 + 85.236.104.0/23 media ranges.
  <https://support.unity.com/hc/en-us/articles/4407491745940>
- Blizzard Support, "Performing a Trace Route" (article 496, retired) —
  archived captures 2013-12-02 and 2015-08-23, the only time Blizzard
  published game-server addresses.
- `docs/design/gaming-mode.md` §2.2 (Iranian reachability sweep, four
  networks, three controls), §3 (WoW's two connections), §5.4 (the
  prefix-completeness rule).
- `docs/research/gaming-ip-reputation.md` (why the exit address, not the
  route, is the Cloudflare-refusal question).
- `docs/journal/windows.md`, 2026-08-25 (the Riot/Cloudflare lead this
  document was written to confirm).
