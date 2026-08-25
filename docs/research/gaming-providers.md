# How commercial gaming-optimisation services actually work

Status: **research only.** Nothing here is a measurement of Neoxify's own
network except where it quotes `docs/design/gaming-mode.md`, which is.

Written 2026-08-25 on branch `claude/gaming-providers-research`.

Read `docs/design/gaming-mode.md` first. This document does not repeat its
measurements; it tests two hypotheses against them.

**The question, as first asked:**

> *"you kinda need to research about the protols and routes exitlag/ezconnect
> and the rest of gaming providers have it looks like those are not vpn they
> might be dns only on different vps like german/france or other i also might
> be wrong and their structure might be different"*

**The question, re-centred mid-research, and the one this document is
organised around:**

> *"Its not about latency always, its about network restrictions that doesn't
> [let] gamers to connect to game servers"*

The problem is **access**. Latency findings are kept because they constrain
what the product may claim, but they are no longer the question.

---

## Evidence labelling

Every claim below carries one of:

- **Verified** — a vendor document naming a driver, a file format or a node;
  a published node list; a BGP or ASN lookup; a peer-reviewed measurement.
- **Vendor claim** — the company says so about its own product.
  Authoritative about *intent*, not about *effect*.
- **Marketing** — a homepage, an SEO blog post, or a review-site aggregation.
  Not evidence of anything.
- **Not established** — searched for, not found. Listed, because an absence
  is a finding.

Where this document reasons rather than cites, it says **inference** and
names the experiment that would settle it.

---

## The short version

**On the original hypothesis.**

1. **They are not VPNs — correct.** Every one of them installs a *packet
   filter or callout driver* that picks one process's flows out of the stack
   and hands them to a proxy. ExitLag's is an **NDIS lightweight filter**
   (`ndextlag.sys`), which binds to the existing NIC and therefore **creates
   no adapter in Device Manager at all** — very likely the observation behind
   the question. NoPing uses WinpkFilter. WTFast uses a WFP callout driver
   that is **licensed Proxifier**. Mudfish ships both a TAP adapter and a WFP
   callout. On *mobile*, though, all of them are ordinary VPNs, because
   Android offers nothing else.
2. **They are not DNS-only — but that half of the hypothesis found a real
   thing, and it is the Iranian half.** ExitLag, WTFast, GearUP and Outfox
   have no DNS feature whatsoever. Iran, however, has an entire market of
   genuinely DNS-based services — Shecan, 403.online, Begzar, Electro,
   DNSBox — that work exactly as described. What they sell is **تحریم‌شکن:
   sanction-breaking, i.e. access.** None claims a latency benefit. And no
   service moves packets with DNS: DNS selects, a relay carries.
3. **They run on ordinary rented VPS — correct, and verifiably.** Mudfish
   publishes the hosting provider of all ~600 of its nodes (AWS, Google,
   Azure, DigitalOcean, Vultr, Linode, OVH, Hetzner, LeaseWeb…). ExitLag's
   entire registered footprint is four **/30**s inside **Voxility** in
   Bucharest, Miami, Ashburn and Frankfurt. NoPing's is a single **/31** from
   velia.net. **None of these brands owns an ASN or appears in PeeringDB.**
   They rent exactly as Neoxify rents.
4. **The "multipath" that defines this industry has never been demonstrated by
   anyone.** No packet capture, no traceroute, no teardown, no nDPI dissector
   exists in public for any of them. ExitLag's own knowledge base described
   route *switching* in 2024 and packet duplication in 2026, and its shipped
   control is a **"Use dual routes"** checkbox. The only non-marketing
   corroboration of real duplication anywhere is NoPing telling sub-10-Mbps
   customers to cut their route count — because duplication costs bandwidth.

**On the question that actually matters — access.**

5. **Route diversity is structurally unavailable to an Iranian player.**
   TCI, MCI and Irancell each show essentially **one** international upstream:
   the state TIC (AS49666/AS48159). Every packet leaves through the same
   gateway whichever foreign relay it is aimed at. There is no second path to
   put a second copy on, and nothing sold on a multipath premise can be true
   for this customer.
6. **The access premise is now partly measurable, and it splits cleanly.**
   OONI — which, unlike Globalping, *does* have thousands of monthly
   measurements on real Iranian consumer and mobile lines — shows Iran
   blocking gaming's **social layer**, not its platforms:
   Discord 67%, Twitch 59%, **Free Fire 76%**, ModDB 71%, Kotaku 69%; against
   Steam 0.9%, Epic 0.1%, Xbox 0.4%, PSN 0.7% and **`www.blizzard.com` at
   zero confirmed blocks in 681 measurements.** Meanwhile **QUIC has been
   100% blocked since June 2025 and never came back**, DNS-over-UDP drops sit
   at 89%, IPv6 is reported disabled on all ISPs, and the DPI now inspects SNI
   on **all TCP ports** with full TCP reassembly.
7. **So for Blizzard the likely answer is that the blocking is the
   publisher's, not Iran's** — which is the opposite direction and needs an
   exit address the *publisher* accepts, not censorship circumvention. But
   `battle.net`, `riotgames.com`, `valorant.com` and `steamcommunity.com` are
   **not on the Citizen Lab Iran test list at all**, so nobody has ever
   measured them, and **no measurement anywhere has ever looked at real game
   protocol traffic from Iran.** That is a void in the literature, not a
   negative result.
8. **For access, Neoxify is not the challenger in this comparison — it is
   ahead.** Eight transports with an automatic ladder, REALITY and
   TLS-in-WebSocket obfuscation, per-network memory of what worked, Iranian
   relay entry nodes, and `uot: true` so game UDP survives a network that
   degrades UDP. **None of ExitLag, NoPing, WTFast, GearUP or Outfox does any
   censorship circumvention at all** — they are unencrypted relays on fixed
   ports, which is precisely what Iranian DPI handles best. Measured here on
   Neoxify's own wire: a *valid* WireGuard handshake into Iran is dropped
   while a malformed one of identical size passes.
9. **And the access product needs no node software.** Custom mode already
   routes chosen executables by absolute path through an existing protocol to
   an existing exit; relay routes already chain an Iranian entry to a foreign
   exit; the full tunnel's IPv6 leak is measured closed. **The unbuilt
   resolver and SNI proxy add nothing to any of it, and are strictly weaker,
   because DNS cannot reach a game that receives its server as a literal.**
10. **The remaining hard case is address reputation, not routing.** All five
   node addresses are datacenter-labelled ASN-wide, two of the five share one
   ASN, and rotating within those ASNs is already known to buy nothing. If the
   game refuses Neoxify's exit as well as the player's own address, that is a
   procurement problem and a separate programme — and no competitor has solved
   it either.
11. **The whole question turns on one hour of measurement that has never been
    taken**: a real account, on a real Iranian home connection, trying to log
    in and connect — direct, then through germany-1, then direct again. Every
    outcome of that test, including "nothing is blocked", changes the decision.

**One correction to the record, and it is significant.** This repository
records *"All EZ Connect servers are located in Iran"* as fact, and builds the
"stable low-density domestic address" thesis on it. The sentence is real —
it is the opening line of their Persian terms of service — but the same
operator's Telegram channel routinely announces outages and upgrades on
**Bahrain, Russia, Turkey, Germany, Netherlands and UAE** routes. The ToS
sentence reads as compliance boilerplate protecting a state e-commerce seal.
**EZ Connect appears to be ingress in Iran, egress abroad — which is Neoxify's
own relay architecture.** The design doc's standing open question, *"why does
EZ Connect work from an Iranian IP?"*, dissolves: it does not appear to.

---

## The two blocking directions

Everything in this report depends on keeping these apart, because they have
opposite fixes and Neoxify's answer to one is already built while its answer
to the other may not be buildable at all.

| | **Direction 1 — outbound** | **Direction 2 — inbound** |
|---|---|---|
| Who blocks | The Iranian side: ISP, national filter, DPI | The game: sanctions and geo-fencing |
| What the player sees | Timeout, reset, poisoned DNS, dead UDP | 403, "not available in your region", account restriction |
| What fixes it | Censorship circumvention — a transport the filter does not recognise | An exit IP the *game* accepts |
| Does Neoxify have it | **Yes.** Six transports, REALITY/TLS/WS obfuscation, an automatic ladder, and Iran-reachable relay entries | **Partly.** It changes the exit IP; whether the game accepts that IP is a different problem |
| What it costs | Nothing new | Possibly new address space, which is the expensive kind of problem |
| What the evidence says | **Confirmed for Discord (67%), Free Fire (76%), Twitch (59%); QUIC blocked outright since June 2025.** Not confirmed for any game platform | **Structurally likely and the probable dominant cause for Blizzard/Riot/Epic** — but the reports are from 2019 and current status is unverified |

A single product can fail either way, and the failure looks identical to the
customer: the game does not connect. **The two are distinguishable only by
instrumentation**, and the one instrument that would separate them — a real
account logging in from a real Iranian home connection — has never been
pointed at the problem. That is the central gap in this whole programme.

And note the asymmetry the last row exposes: the direction with hard,
repeated, consumer-network measurement behind it is **not** the one the
Gaming Mode design was built around.

---

## The client mechanism nobody advertises

Five distinct client-side redirection mechanisms appear across this market.
Which one a product uses determines what it can and cannot do — and none of
the marketing pages name theirs.

| Mechanism | How it works | Who uses it | Per-process? | Per-destination? |
|---|---|---|---|---|
| **Routing table + virtual adapter** | Install a TUN/TAP adapter, insert routes for the game's address ranges | Mudfish (default path), most "gaming VPNs" | No | Yes |
| **WFP callout / filter driver** | Kernel driver classifies at the socket layer and redirects matched flows to a local proxy | Mudfish (`mudwfp.sys`), **WTFast (`WtfEngineDrv.sys`, licensed Proxifier)**, GearUP (`gunetfilter.sys`), Netch (`netfilter2.sys`) | **Yes** | Yes |
| **NDIS lightweight filter** | A filter binds to the *existing* physical adapter and diverts matched flows — so **no virtual adapter appears in Device Manager** | **ExitLag (`ndextlag.sys`)**, **NoPing (WinpkFilter)** | Yes | Yes |
| **Winsock LSP** | A layered service provider hooks the socket API in-process | GearUP (`lspinst_x64.exe`), alongside its WFP driver | Yes | Yes |
| **Packet redirector (WinDivert class)** | User-mode process diverts and rewrites packets through a kernel shim | **Neoxify Custom mode** | Yes | Yes |
| **Local SOCKS / HTTP proxy** | No driver; the app, or a helper such as Proxifier, points at `127.0.0.1` | Mudfish (TCP 18080/18081) | Only with a helper | Yes |
| **DNS + SNI proxy ("Smart DNS")** | A resolver answers selected hostnames with a proxy address; the proxy relays on SNI | Iranian gaming-DNS market, streaming unblockers, **Neoxify's unbuilt Gaming Mode node side** | No | **Only for names the app resolves** |

Two observations worth more than the table.

**Every one of these products calls itself something it is not.** Outfox is
marketed as a VPN and is described by the only technical account of it as an
unencrypted UDP proxy with port-based game detection. Mudfish is sold as
"Cloud VPN" and its most capable mode is a per-process WFP redirector that is
not a VPN by any definition. This is exactly why the original question is a
good one and why no marketing page can answer it.

**Neoxify already owns the hard part.** The Custom-mode WinDivert split
tunnel sits in the same architectural class as `mudwfp.sys` and
`netfilter2.sys` — the open-source reference implementation of this whole
product category, Netch, uses a commercial WFP filter driver (`netfilter2.sys`
from NetFilter SDK) plus a native `Redirector` DLL to do precisely what
Neoxify's redirector does. What Neoxify does not have is the fleet, the
per-game data, and — for the latency story — any reason for the relay to be
faster.

---

## Smart DNS, stated precisely, because the hypothesis rests on it

The academic description ([Zhang et al., *Holes in the Geofence: Privacy
Vulnerabilities in "Smart" DNS Services*, arXiv:2012.07944](https://arxiv.org/abs/2012.07944))
is exact and worth stating in the vendors' place:

> the resolver *"smartly identifies geofenced domains and, in lieu of their
> proper DNS resolutions, returns IP addresses of proxy servers located
> within the geofence"*, and those proxies *"transparently proxy traffic
> between the users and their intended destinations."*

Three consequences that decide the hypothesis:

1. **DNS is the selector. The proxy is the transport.** There is no such
   thing as a service that moves packets with DNS. A "DNS-only" product is a
   DNS *plus a relay*, and the relay is where the money and the addresses go.
2. **It reaches only what the application resolves.** WoW receives its realm
   and world addresses as literals inside the Battle.net session — no
   resolver ever sees them. For that game, a DNS mechanism reaches the
   launcher, login, web and store, and reaches the game itself **not at all**.
   That is fatal for an access product whose failure is at the game
   connection.
3. **The classic implementation leaks its own customer list.** The paper's
   headline finding is that these services allowlist by source IP, so anyone
   can enumerate their users by address. Neoxify's design already avoids this
   — it authenticates the resolver with a per-customer path token over DoH,
   and the schema comment gives CGNAT as the reason. The paper supplies a
   second, better reason. That decision should not be revisited.

---

## Latency: kept, demoted, and still binding on what may be claimed

Latency is no longer the question, but the numbers still forbid certain
sentences, so they are recorded here rather than deleted.

Blizzard's EU game servers are in **Amsterdam** — established by RTT
triangulation and Blizzard's own rDNS (`eqam3`), not by IP geolocation, which
returned "Seoul, KR" for one of these addresses.

Great-circle distance and the RTT floor at 200,000 km/s (light in
single-mode fiber, ~2/3 c), against the design doc's measured figures:

| Tehran → | km | RTT floor | measured | stretch |
|---|---|---|---|---|
| **Amsterdam** (Blizzard EU, direct) | 4,063 | **40.6 ms** | **72.0 ms** | **1.77×** |
| Frankfurt (germany-1) | 3,766 | 37.7 ms | 66.1 ms | 1.75× |
| Istanbul (turkey-1) | 2,035 | 20.4 ms | 51.6 ms | 2.53× |
| Paris (france-1) | 4,209 | 42.1 ms | 88.0 ms | 2.09× |
| Helsinki (finland1) | 3,313 | 33.1 ms | 109.0 ms | 3.29× |
| Frankfurt → Amsterdam | 364 | 3.6 ms | 6.7 ms | 1.86× |
| Istanbul → Amsterdam | 2,212 | 22.1 ms | 54.8 ms | 2.48× |

Three conclusions.

**(a) The direct Tehran→Blizzard path is already better than the internet
average.** Measured path inflation over the speed of light in fiber has a
**median of 2.1×** ([Bozkurt et al., *Dissecting Latency in the Internet's
Fiber Infrastructure*, arXiv:1811.10737](https://arxiv.org/pdf/1811.10737)).
This path runs at 1.77×. There is no congested-transit story to tell about it.

**(b) The entire theoretical headroom is about 18 ms and it is not
purchasable.** The same study puts the median *physical* fiber stretch —
cable length over line-of-sight — at 1.32×. A path following the best
existing fiber with zero queueing would be 40.6 × 1.32 ≈ **53.6 ms**. Against
72.0 ms measured, the ceiling on any routing improvement at all is ~18 ms,
and reaching it means owning the path, not renting a VPS on it.

**(c) turkey-1's problem is transit, not geometry.** Istanbul sits almost on
the Tehran–Amsterdam great circle: 20.4 + 22.1 = 42.5 ms of floor against
40.6 ms direct, so relaying through it *should* cost about 2 ms. It measures
106.4 ms, because both legs run at ~2.5× stretch while the direct path runs
at 1.77×. **A relay wins only if each of its legs is better engineered than
the path it replaces.** That is bought with transit contracts, not software.

### Does overlay routing ever help? Yes — at the tail, not the mean

**RON** (MIT, SOSP 2001) built exactly what ExitLag and NoPing describe: a
mesh that probes the paths between its own nodes and forwards indirectly when
the direct path is worse. Its published results
([paper](https://www.sosp.org/2001/papers/andersen.pdf),
[project](http://nms.csail.mit.edu/ron/)):

- Across 12 nodes and 132 paths over 64 hours, **32 outages of over thirty
  minutes** were detected and routed around, in **under 20 seconds** on
  average — against BGP's minutes.
- **About 5% of transfers doubled TCP throughput**; about **5%** saw loss
  probability fall by 0.05.
- **One intermediate hop suffices** in nearly all cases.

The headline results are about **outages, loss and throughput** — the tail.
The share of paths where the overlay improved anything was single-digit
percent. Twenty-four years of follow-up has not changed that shape.

| Condition | Can a relay help? | Why |
|---|---|---|
| Direct path congested or badly routed | **Yes** | Two good legs can beat one bad one |
| Direct path has loss or route flapping | **Yes** | This is RON's actual result |
| **Direct path is blocked or the destination refuses you** | **Yes** | Access, not speed — and this is the case that matters here |
| Bottleneck is shared by both paths | No | The relay is on the far side of it |
| Direct path already near the fiber floor | No | Nothing left to win |

Tehran→Blizzard EU as measured is simultaneously the last row (no latency to
win) and, possibly, the third row (access). That is the whole product
question in one sentence.

### Packet duplication — real technique, wrong customer

Duplicating packets across disjoint paths and de-duplicating at the far end
is standardised in 3GPP for URLLC. The literature is consistent: it trades
**bandwidth for tail latency** — it removes retransmission stalls, it does
not lower the mean. For WoW the trade looks attractive (5–80 Kbps of TCP, and
the reported pathology — "Home 30 ms, World 1500 ms" — is exactly a
head-of-line stall). It requires **two paths that fail independently**. The
next section shows an Iranian consumer does not have two.

---

## The structural finding: Iran has one international path

This changes more than anything learned about any provider.

Observed IPv4 BGP peers, bgp.he.net, 2026-08-25 — **verified**:

| Network | AS | Observed IPv4 peers |
|---|---|---|
| **TCI** — largest consumer ISP | AS58224 | AS48159 TIC, AS49666 TIC, AS12880 IITC, AS60148 IITC, AS216067 BHS |
| **MCI / Hamrah-e Aval** — mobile | AS197207 | AS49666 TIC, AS43754 Asiatech |
| **Irancell** — mobile | AS44244 | AS49666 TIC |
| Respina — business ISP | AS42337 | AS12880 IITC, AS49666 TIC |
| **ArvanCloud** — datacenter | AS202468 | Respina, Fanava, Mobin Net, MCI — 10 peers total |
| **Hostiran** — datacenter | AS59441 | Respina, IITC, **AS48011 Turunc (TR)**, MCI — 6 peers |

Censys states it without hedging: *"AS49666, the Telecommunication
Infrastructure Company (TIC.IR), provides transit (internet connectivity) for
every ISP in Iran."*
([Censys](https://www.censys.com/blog/irans-internet-a-censys-perspective))

**(a) Multipath is structurally unavailable to an Iranian player.** Route
diversity means divergent paths. Every packet leaving an Iranian consumer ISP
crosses the same state gateway whichever foreign relay it is aimed at. Even
ExitLag's "Multi-Internet" bonding converges at TIC if all the links are
Iranian. Anything sold to an Iranian customer on a route-diversity premise
sells a property their network does not have.

**(b) Every latency number in the design doc came from a datacenter, and
Iranian datacenters are connected differently from Iranian homes.** Arvan has
ten observed peers; Irancell has one. Hostiran has a Turkish peer — a
non-TIC border. All five Iranian Globalping probes are tagged
`datacenter-network`; the design doc names this as the instrument's hard
limit and it is the reason the access premise is **untested rather than
disproved**.

**(c) It is the most plausible explanation for EZ Connect, which the design
doc records as unexplained.** An EZ Connect server sits in an Iranian
datacenter. A consumer-ISP customer hopping through it trades their own
single congested path for the datacenter's better-provisioned one, without
ever leaving the country — which is exactly the combination their ToS
describes and their users report. **Inference from BGP topology, not a
measurement.** The experiment that settles it costs one ping.

---

## Per-provider findings

### The table

| Provider | Transport | Client mechanism | Route mechanism | DNS role | Infrastructure | Per-game config | Platforms |
|---|---|---|---|---|---|---|---|
| **Mudfish** | Unencrypted relay; also plain SOCKS/HTTP proxy on TCP 18080/18081 | **Both**: TAP-Win32 `tap0901` (+ Wintun fallback) with route injection, *or* a WFP callout driver **`mudwfp.sys`** + `mudwfp_proxy.exe`, service `MUDWFP`, Win8+ | **Real chaining**: "Advanced" = 2 nodes, "Multi-Path" = up to 4, selected automatically by measured RTT | Separate optional **Mudfish DNS Client** to defeat DNS poisoning. **Not** the steering mechanism | **~500–650 rented nodes**, provider named per node: AWS, Google, Azure, DigitalOcean, Vultr, Linode, OVH, Hetzner, LeaseWeb, SK Broadband… No own ASN | "Items": CIDR, hostname (widened to a **/24**), or `P:proc.exe;E80;X1.1.1.1/32`. Curated by staff from user packet captures | Windows, Linux |
| **WTFast** | Relay, explicitly **unencrypted** — "we relay traffic as is" | **WFP callout driver `WtfEngineDrv.sys`**, signed by **Initex** — i.e. licensed **Proxifier** engine. No virtual adapter | Entry node + exit node, exit chosen "~1 ms from the game server"; two servers chainable | **None** | ~230+ rented nodes, Asia-weighted. **No ASN, no PeeringDB record found** | ~1,500 vendor profiles keyed on **process** — and on the process running *during* play, not the launcher | Windows; **Android/iOS use `VpnService`**, i.e. a real VPN on mobile |
| **GearUP Booster** | Relay | **Both, shipped side by side**: `tap0901` TAP adapter (Routing Mode) *and* `gunetfilter.sys` WFP filter + Winsock **LSP** (`lspinst_x64.exe`) for Process Mode | "Adaptive Intelligent Routing": *"connect to multiple servers at once, allowing for dynamic switching between them"* — **switching, not duplication** | **None** | "7,500+ nodes, 180+ countries" with **zero cities, zero IPs, zero list published**. Unverifiable | Per-game profiles; mode is a **property of the node**, and the standard support answer to "it doesn't work" is *switch to a node using the other mode* | Windows, Android (`VpnService`), iOS, ASUS router firmware |
| **Outfox** (Golden Frog) | **Unencrypted UDP proxy**, single hop | **Not established.** Only `OutfoxUI.exe` confirmed. No driver, adapter or service name found | Probes direct vs via-Outfox and picks the single fastest. **No multipath claim** | **None** | Colocation (Data Foundry, Austin), 40+ locations. No node list | Detection by **known ports**, not process — weaker than the others | Windows only |
| **ExitLag** | Proxy to a rented relay | **NDIS 6 Lightweight Filter `ndextlag.sys`** — "NDIS 6 LWF packet redirector driver", signed Mainline Net Holdings. Binds to the existing NIC, so **there is no ExitLag adapter in Device Manager**. Now labelled **"NDIS (legacy)"** in the UI; the current default method is unnamed and appears to be a connect-redirect to a **loopback proxy** | "MultiPath®" — but the shipped control is a **"Use dual routes"** toggle, and their own 2024 KB describes *migrating* to a better route, not duplicating onto several | **None found** | **No ASN, no PeeringDB record.** RIPE holds four `Exitlag` **/30s** as customer assignments inside **Voxility** (Bucharest, Miami NAP, Equinix Ashburn, Frankfurt DR) plus a velia.net /31. 16 registered IPs against a claimed 1,500 servers | **Process executable name, unauthenticated** — renaming any binary to `LOSTARK.exe` gets it proxied, and a third-party dev ships that as a feature | Windows; **Android uses `VpnService`** |
| **NoPing** | Proxy tunnel; "process routing **and** raw routing" | **WinpkFilter** (NT Kernel Resources' NDIS filter, the `ndisapi` behind WireSock) — named in their own support article telling users to uninstall it. Two "routing modes", mode 2 being the standard fix when mode 1 breaks connectivity | Claims patented "Multi Connection" with simultaneous dispatch; **user-selectable intermediate nodes** = real multi-hop chaining | **A real feature, not the mechanism**: a "DNS Optimizer" that benchmarks public resolvers and rewrites the system resolver | **No ASN, no PeeringDB record.** One RIPE org created 2026-08-21 holding a **/31** from velia.net. Regional beta hostnames include **`ir-beta.noping.com`** | Game executable must appear in the client panel, and NoPing must be running before the game starts | Windows, iOS, Android |
| **EZ Connect** (ایزی کانکت) | Tunnel over **UDP**, protocol never named publicly; ships auto-MTU detection (an encapsulation tell) | Per-application selection on Windows; console support via Windows Mobile Hotspot, so the redirect is **in the network stack, not a socket hook** | Named routes per region | **None** — and the operator says why (below) | Web/download tier on **ArvanCloud, Tehran** (`185.143.234.238`, AS205585). Telegram names **foreign** routes | "Games and Windows applications" chosen by the customer; 120+ games claimed, no catalogue published | **Windows only.** No Android, no iOS |
| **Iranian gaming-DNS** (Shecan, 403.online, Begzar, Electro, DNSBox) | DNS + **reverse proxy** | OS resolver setting only. No client, no driver | None | **DNS is the whole product**: resolve a sanctioned domain to an Iran-hosted IP and reverse-proxy the TLS | Iranian hosting | Hostname lists | Anything with a DNS setting, including consoles |
| **LagoFast** | Relay | Not established | "AI Matrix Route" — selection language only | None | "12,000+ nodes" claimed, unverifiable | 8,355+ games claimed | Windows, macOS, Android, iOS, consoles |
| **Kill Ping / Battleping / PingBooster** | — | — | — | — | — | — | **Kill Ping and Battleping are dead** (origin unreachable / connection refused). **PingBooster redirects to persec.co.th**, a plain Thai VPN business |

### What the table shows once the marketing is stripped out

**Every one of these products is the same architecture**: intercept a chosen
subset of traffic on the client, relay it through one or two rented boxes,
exit near the game. The only real differences are *where* the interception
happens and *how many* relay hops there are.

**None of them duplicates packets.** Across every technical page reachable
for GearUP, the words *duplicate, redundant, copy, FEC* and *dual channel*
never appear; their own wording is *"connect to multiple servers at once,
allowing for dynamic switching between them."* Mudfish's Multi-Path is
node **selection** by measured RTT. WTFast chains an entry to an exit.
**"Multipath" in this industry means probe several nodes and switch, not
send twice.** The frequently repeated claim that GearUP duplicates critical
packets is not in GearUP's documentation and could not be traced to any
source — treat it as fabricated.

**The one place duplication might be real is NoPing, and the evidence is
their own troubleshooting rather than their marketing.** Support article 15
tells customers on **under 10 Mbps** to *"reduce the number of simultaneous
connections"* and *"try using only 2"*; article 16 says to *"decrease the
number of routes to 2"* and then to one. **Bandwidth cost scaling with route
count is what duplication produces and what load-balancing does not.** It is
still vendor prose, not a capture — but it is prose written against the
vendor's own interest, which is the useful kind.

**None of them owns network.** No ASN or prefix under any of these brands was
found in Hurricane Electric's BGP toolkit or RIPEstat, and RIPEstat's search
for `exitlag` returns no resources at all. Mudfish settles it positively
rather than by absence: it **publishes the hosting provider of every node**,
and a spot check of `node-kr-00615` (`58.228.131.31`) returns AS9318 SK
Broadband, matching its own published vendor field.

**The per-process redirector is buyable, not invented.** WTFast's is
Proxifier's engine under licence — `WtfEngineDrv.sys` carries the file
description "WTFastEngine WFP Driver x64" and is signed by **Initex**, who
list WTFast among their own products beside Proxifier. GearUP's
`gunetfilter.sys` sitting in a `wfp/` directory is the shape NetFilter SDK
licensees produce (they are instructed to rename `netfilter2.sys`) —
**inference, not a confirmed licence**.

**Nobody has ever published a capture of any of them.** No packet capture, no
posted traceroute, no independent teardown, and **no protocol dissector for
ExitLag or NoPing in nDPI** — which means their on-wire encapsulation has not
been reverse-engineered publicly, or at least not published. Every "review"
in this space is affiliate ping-before/ping-after with no methodology and no
route inspection. **The single load-bearing technical claim of this entire
industry — simultaneous multipath — has no independent verification
anywhere.** That is worth stating plainly before copying any of it.

### Three findings that bear directly on Neoxify's own code

**1. Process-name matching is unauthenticated, and it is exploited today.**
ExitLag matches on the executable's *image name* with no path or signature
check. `snoww/loa-logs` ships a compatibility mode that copies its own binary
to `LOSTARK.exe` *specifically so ExitLag will proxy it*, and says so in a
source comment. Neoxify's `SplitTunnelConfig` already selects by **absolute
path** rather than by name, and the field carries a comment explaining why —
that decision is better than the market leader's and should not be softened.

**2. Both vendors ship a "reset network settings" button.** ExitLag's is in
Settings → Advanced. That is the same leftover-state failure class already on
record here as customers needing a network reset and an uninstall to recover.
It is not evidence that Neoxify's teardown is unusually bad; it is evidence
that **everyone who filters packets at this level ends up shipping a repair
button**, which is what `RepairNetwork.tsx` already is.

**3. A competitor is already probing Iran.** NoPing's certificate transparency
records include regional beta hostnames `ir-beta`, `ru`, `eg-beta`, `in-beta`,
`th-beta`, `tw-beta`, `vn-beta`, `sa-beta`, `ph-beta`, `id-beta`, `ae-beta`.
An `ir-beta` is not proof of an Iranian product, but it is the clearest signal
available that the market is considered worth entering.

### The finding most relevant to Neoxify's own problem

**GearUP ships both interception mechanisms simultaneously and exposes the
choice as a per-node property** — and its standard support answer to "boost
isn't working" is *switch to a node that uses the other mode*. A player
reported a game failing to load under Process Mode and working under Routing
Mode.

That is a company with far more revenue than Neoxify admitting, in its
support documentation, that **it never got per-process interception reliable
enough to be the only path.** It is the same wall the Custom-mode work has
hit: five confirmed leak mechanisms, all with the same symptom.

### Corrections to what this repository currently believes

**1. EZ Connect's exits are not all in Iran, and the ToS sentence is
compliance boilerplate.** `docs/design/gaming-mode.md` §1 and the project
memory both record *"All EZ Connect servers are located in Iran"* as a
technical fact and build the "stable low-density domestic address" thesis on
it. The ToS sentence is **verified** and reads exactly as quoted:

> «تمامی سرورهای ایزی کانکت واقع در ایران بوده و کلیه فعالیت‌های این وب‌سایت
> مطابق با قوانین جمهوری اسلامی ایران می‌باشد.»

But the same operator's Telegram channel routinely names **foreign** routes —
«مسیرهای بحرین و روسیه … در دسترس نیستند» ("the Bahrain and Russia routes are
unavailable"), and an upgrade notice covering «ترکیه المان هلند و امارات»
(Turkey, Germany, Netherlands, UAE). Locations named over time include
Turkey, Germany, Netherlands, UAE, Bahrain, Russia, Armenia, Singapore,
Poland and Finland.

The reading that fits both: **ingress in Iran, egress abroad** — which is
exactly Neoxify's relay-route architecture — with the ToS sentence protecting
their Enamad state e-commerce seal. The design doc's open question *"why does
EZ Connect work from an Iranian IP?"* dissolves: **it does not appear to
work from an Iranian IP.** That thesis should be retired, and with it the
inference that a low-density *domestic* address is the mechanism.

**2. The name is «ایزی کانکت» (Easy Connect), not «ای زد کانکت».** The
latter returns nothing. It is a one-person business — registered to
**فرزین شجاعی**, Semirom, Isfahan, under a network-design licence — selling a
single 360,000-toman/month plan with a mandatory free trial.

**3. Its own operator states the DNS question better than any vendor doc:**

> «دی ان اس فقط میگه مقصد کجاست. سرویس کاهش پینگ بین مسیر رسیدن به اون مقصد
> رو انتخاب می‌کنه.»
> *"DNS only says where the destination is. A ping-reduction service chooses
> the route to reach that destination."*

### Two industry data points worth carrying

**Riot Games solved this by building a backbone, not an overlay.** Their
engineering blog is the best-documented version of the insight these products
sell: *"BGP is really built for commodity routing by default."* Riot's answer
was real peering and real transit, and it moved players under 80 ms from 31%
to 80%. That is the honest benchmark for what routing work is worth — and the
honest statement of what it costs.

**The market is harder than it looks.** Cox Communications white-labelled
WTFast as "Elite Gamer" (same `gpnc.exe` and `DriverTool.exe` binaries),
launched it across roughly 6 million homes in 2020, and **killed it at the
end of 2023 for lack of demand.**

And hands-on testing of WTFast across six games found **improvement in four
and regression in two** — Apex Legends 57→70 ms with added packet loss, CS2
39→41 ms. The extra hop loses whenever the default path was already good,
which is precisely the Tehran→Blizzard case.

---

## Direction 1 — what the Iranian side actually does

This is the direction where Neoxify has **its own measured evidence**, taken
on its own wire, which is a stronger evidence class than anything available
about any competitor.

### Measured, on Neoxify's traffic

**Iran's filter is protocol-aware and validates cryptography.** On
2026-08-14 the same WireGuard handshake was captured at both ends of the
cross-border path: four packets left the client, **zero arrived at ir1**,
zero returned. The control in the same capture, same host, same `ip:port`,
is what makes it conclusive:

| sent | arrived |
|---|---|
| TCP SYN to 443 | yes |
| UDP, 13 bytes | yes |
| UDP, 148 bytes, `0x01` + random body | **yes** |
| a real WireGuard handshake, 148 bytes | **no** |

Size, port and protocol all pass. **A *valid* handshake is what dies.** A
real initiation carries a `mac1` computed over the responder's public key, so
the DPI box validates it, drops the genuine article, and ignores malformed
lookalikes. That is not a keyword filter or a port block; it is a filter that
implements part of the protocol.

**Selective DNS filtering is real and this project's instruments detect it.**
`speedtest-ams3.digitalocean.com` failed to resolve from all five Iranian
probes. The same instrument found every one of sixteen Blizzard hostnames
clean.

**Sanctions geo-blocking of Iranian addresses is routine enough to be a
design constraint here already.** `docs/detection-resistance.md:54-58` rules
out camouflage destinations that refuse the node's address, noting that
*"sanctions geo-blocking is the common case for an Iranian VPS dialling a US
property."* That is direction 2, observed from inside this project's own
infrastructure.

**Roughly 94% of VPN vendor websites are blocked in Iran** (OONI, cited in
`docs/design/gaming-mode.md:409`). Relevant because it decides where any new
public endpoint may live, and it is why the Gaming Mode design put DoH behind
the node's existing TLS fallback rather than on a Neoxify-branded name.

### Measured, and negative

From four Iranian networks with German, Turkish and Finnish controls
(`docs/design/gaming-mode.md` §2.2): every Blizzard DNS answer clean, every
HTTPS status identical to the control across sixteen hostnames, and **TCP to
the WoW game port `37.244.62.99:3724` completed from Iranian address space
with the server answering.**

### Measured independently, on real Iranian consumer and mobile lines

**This corrects an assumption that has been carried through the whole
programme.** The design doc's caveat — every Iranian probe is a datacenter —
is true of **Globalping**. It is **not** true of **OONI**, which has thousands
of measurements per month on MCI (AS197207), Irancell (AS44244), Rightel
(AS57218), TCI (AS58224), Shatel (AS31549) and Asiatech (AS43754) from real
handsets and home lines.

OONI aggregation, Iran, all ASNs, 2025-08-01 → 2026-08-25. "Confirmed" means
OONI verified a block page or poisoning, not merely an anomaly:

| Domain | measurements | confirmed blocked | % |
|---|---|---|---|
| `discord.com` | 12,571 | 8,419 | **67%** |
| `ff.garena.com` (Free Fire) | 482 | 365 | **76%** |
| `www.moddb.com` | 694 | 490 | **71%** |
| `kotaku.com` | 695 | 479 | **69%** |
| `www.twitch.tv` | 1,407 | 836 | **59%** |
| `www.gog.com` | 510 | 42 | 8% |
| `www.pubg.com` | 673 | 13 | 2% |
| `store.steampowered.com` | 691 | 6 | 0.9% |
| `www.ea.com` / `www.roblox.com` | ~665 each | 6 | 0.9% |
| `store.playstation.com` / `www.ubisoft.com` | ~690 each | 5 | 0.7% |
| `www.xbox.com` | 687 | 3 | 0.4% |
| `store.epicgames.com` | 748 | 1 | 0.1% |
| **`www.blizzard.com`** | **681** | **0** | **0%** |

**The pattern is sharp and it holds across every ISP: Iran blocks gaming's
social layer and gaming journalism, not the game platforms.** Poisoning is to
`10.10.34.35` / `.36` — and there is an IPv6 block-page address too,
`2001:4188:2:600:10:10:34:35`. Blizzard sits at literally zero confirmed
blocks across 681 measurements from consumer networks.

One counter-intuitive detail worth carrying: on Discord, **MCI (81.9%) and
Irancell (86.2%) block *more* than TCI (50.8%)**. The USENIX Security 2025
IRBlock paper reports the opposite — MCI at 0.86%, Irancell at 0.69% — and
that is a measurement artifact of probing Iranian address space from
*outside*: mobile CGNAT pools never answer unsolicited inbound packets, so
the injector never fires. **Do not use IRBlock's per-AS table to conclude
Iranian mobile networks filter less.**

### The one thing that has changed regime, and it matters more than any of the above

**QUIC is blocked outright, and it has been since June 2025.** Niere, Lange &
Somorovsky, *Insights into an Iranian Internet Shutdown* (FOCI 2026), scanned
9,000 Tranco domains from inside Iran before, during and after the June 2025
shutdown:

| Protocol | before (Jun 1–12 2025) | during (Jun 17–18) | after (Jun 25–Jul 7) |
|---|---|---|---|
| DNS over UDP | 15.12% | 16.77% | **89.18%** |
| DNS over TCP | 15.12% | 96.68% | 15.38% |
| TLS | 15.01% | 19.22% | 15.69% |
| HTTP | 15.28% | 17.28% | 15.21% |
| **QUIC** | **0.01%** | **100%** | **100%** |

**QUIC was essentially untouched under normal filtering; it was switched off
as a shutdown measure and never switched back on.** DNS-over-UDP drops went
to 89% and stayed there. Corroborated in-country: *"QUIC: disabled on all
ISPs"*, *"IPv6: disabled on all ISPs"*, and unidentified UDP blocked on most
ISPs depending on destination IP (net4people #489). Nym's independent June
2025 analysis found essentially all UDP protocols blocked — WireGuard,
AmneziaWG, QUIC, WebRTC, OpenVPN — with **UDP/53 deliberately spared**.

Caveat, stated because it is the same trap this document warns about
elsewhere: the FOCI scan is a **single vantage in AS57497, a hosting AS**, not
a consumer line. The in-country anecdote is consumer; the measurement is not.

Two further mechanisms that change what a transport can assume:

- **The HTTP and HTTPS DPI now runs on all TCP ports**, not just 80/443
  (IRBlock). Moving TLS to an unusual port no longer avoids SNI inspection —
  which is a direct hit on one of this project's standing assumptions.
- **The DPI performs full TCP reassembly to extract SNI**, defeating
  client-side ClientHello fragmentation (net4people #628, June 2026), and
  fragmentation was reported dead outright by July 2026 (#640). REALITY has
  been reported hit with RST floods after the handshake.
- **MCI applies upload throttling to under 1 Mbps**, keyed on non-whitelisted
  SNI or IP, while download stays fine. For a game that is the worst possible
  shape of degradation: the connection still looks up while client→server
  updates collapse.

### The correction that has to be made explicitly

The journal reads that the *"sanctions-blocked vs merely slow" split did not
hold on the evidence available*. With OONI's consumer data in hand that
sentence can now be sharpened rather than merely hedged:

**For Blizzard specifically, direction 1 is looking genuinely negative** —
zero confirmed blocks across 681 consumer measurements, on top of the
datacenter sweep. **But the measurement covers `www.blizzard.com`, not
`battle.net` and not the game path.** `battle.net`, `riotgames.com`,
`leagueoflegends.com`, `steamcommunity.com`, `minecraft.net`, `valorant.com`
and `dota2.com` **are not on the Citizen Lab Iran test list at all**, so OONI
has zero measurements for any of them. That is a void in the public record,
not a negative result.

**And there is a void underneath all of it: no measurement anywhere, by
anyone, has ever looked at actual game protocol traffic from Iran.** No
captures of game sessions, no game-server reachability studies, no evidence
on ports 3724, 1119, 27015 or the high UDP ranges. This is a gap in the
literature, not a gap in the searching.

### What is not established about direction 1

- **Whether any game's own connection is filtered** on a consumer Iranian
  ISP. Nothing published touches it.
- **Whether QUIC is still 100% blocked today.** Hard evidence runs to
  mid-2025 plus anecdote; one consumer reporter called things "mostly normal"
  by June 2026.
- **Whether Iran's UDP blocklist contains game-server IPs.** The mechanism is
  destination-IP-keyed, so it is answerable in principle — but only from
  inside Iran.
- **Whether domestic WireGuard** (Iranian customer → Iranian relay) survives
  the filter. Already open in `docs/detection-resistance.md`.

---

## Direction 2 — the game refusing the player

### This now looks like the dominant direction, and the OONI data is why

Roughly half of the "games do not work in Iran" corpus is **the publisher's
own US-sanctions geo-block, not Iranian filtering**: Blizzard blocking
Battle.net, Riot blocking League of Legends with *"Due to US laws and
regulations, players in your country cannot access League of Legends"*, Epic
blocking its store. The OONI numbers are consistent with exactly this —
`www.blizzard.com` shows **zero** confirmed Iranian blocks because **Iran is
not the one blocking it.**

Those specific reports date to 2019 and current status is **not established**,
which is precisely what the experiment below has to settle. But the mechanism
is structural rather than incidental, and it points the whole product a
different way: **a player whose problem is publisher geo-blocking needs an
exit address the *publisher* accepts, and is entirely unaffected by anything
Iran does or by any amount of censorship circumvention.**

That is the case in which Neoxify's existing transports — its strongest asset
— are irrelevant, and its exit IP reputation is the entire product.

### What is established

- The Blizzard EULA's sanctions clause is about **residence**, not IP
  address. No product changes where someone lives; it only makes it harder to
  observe. If an account is closed on those grounds, neither Neoxify nor
  Blizzard support can help. This must be said before a sale, not after.
- Penalties players blame on VPNs carry **account-security** labels —
  "Account Sharing", "Unauthorised Account Access" — not cheating labels.
  A shared exit address manufactures the first; a sudden new country
  manufactures the second.
- **Warden inspects memory, not network state.** TrinityCore's protocol
  reimplementation has no network check type; the EULA's monitoring clause is
  scoped to memory; a 2026 Proton analysis found Warden operating entirely in
  userspace, and enumerating adapters or sockets requires syscalls. The one
  adjacency is `DRIVER_CHECK`, which hashes loaded **driver names** against a
  blacklist — and Neoxify ships Wintun, WireGuardNT and a WFP callout. Nothing
  suggests Blizzard has listed one. **That is the thing to watch**, not
  "anti-cheat sees VPNs".
- Blizzard support staff are on record that VPN use is unsupported but not
  forbidden — Orlyia (2019): *"We cannot support VPNs, but they aren't
  forbidden for WoW, either."*; Vrakthris (2020): *"using a VPN is not against
  policy, it is just unsupported."*
- **Region-blocking via a relay demonstrably works and demonstrably has
  consequences.** WTFast markets itself as not changing your IP — *"we relay
  traffic to the target server 'as is'"* — while simultaneously publishing a
  support article conceding it "can be used sometimes for region blocked
  games", which is only possible if the game sees the exit node's address.
  Gameforge banned SoulWorker accounts for exactly that. Both halves matter:
  the mechanism works, and publishers do act on it.

### The one measurement that would decide it, and has never been taken

**A real account logging in from a real Iranian consumer address.** Every
probe so far is unauthenticated, and a sanctions block can sit *behind*
login: the TLS handshake completes, the API answers, and the account is
refused. No unauthenticated probe can see that, and it is the single most
likely place for a real block to live.

---

## The exit-IP reputation problem — the expensive case

If direction 2 is the real problem, routing is the easy half and **address
space is the hard half.**

What is already known, and it is bad:

- All five Neoxify node addresses are labelled **datacenter** by every feed
  checked; three are labelled **VPN** outright and the other two carry
  `is_abuser=true`.
- **The label is ASN-wide, not earned.** Controls on unrelated IPs in the
  same ASNs return identical verdicts. **Rotating to a fresh address at the
  same provider buys nothing** — which kills the cheapest-looking remedy.
- The ASNs, verified by lookup: germany-1 `38.60.249.229` and turkey-1
  `130.94.0.27` are both **AS154177 LIGHT NODE LIMITED**; france-1
  `104.105.205.233` is **AS63949 Akamai Connected Cloud** (Linode); finland1
  `204.168.161.100` is **AS24940 Hetzner**. Hetzner and Linode are among the
  most heavily VPN-flagged hosting ASNs in existence. And two of the five
  nodes share one ASN, so they share one reputation.
- **The competitors have exactly the same problem and have not solved it.**
  No ASN or prefix under any of these brands exists; Mudfish publishes its
  fleet and it is AWS, Google, Azure, DigitalOcean, Vultr, Linode, OVH,
  Hetzner and LeaseWeb — the same feeds, the same labels. Nobody in this
  market has bought their way out of it.

The practical consequence for the recommendation: **if the beta test shows
that Neoxify's exit is refused where the Iranian address was also refused,
that is not a Gaming Mode problem and no amount of node software fixes it.**
It is an address-space procurement problem, it must be priced against new
providers **vetted against the feeds before purchase**, and it should be
scoped as its own piece of work rather than smuggled into a feature.

---

## What Neoxify can already do today, with no node-side work at all

This section is deliberately placed before the recommendation, because if it
is right it outranks building anything.

**Verified from the repository, not inferred:**

- **Six transports** — VLESS+REALITY, VLESS+TLS over TCP, VLESS+TLS inside a
  WebSocket sharing the TLS port behind a path-keyed Xray fallback, Trojan,
  Shadowsocks 2022, WireGuard, OpenVPN — with an automatic ladder in the
  Windows client that walks to the next one when a transport is blocked and
  reports which one it landed on rather than claiming success silently
  (`README.md:14-38`).
- **Relay routes are first class.** `Route` carries `entryProtocolConfigId`
  and `exitProtocolConfigId`, and the fleet has run thirteen of them; an
  Iran-reachable entry chained to a foreign exit is a shipped, provisioned
  capability, not a design (`apps/backend/prisma/schema.prisma:548-569`).
  An Iranian entry node has existed — `185.222.28.186`, Tehran,
  **AS210814 VUNIFY LTD** (verified by lookup). *Whether it is live today is
  not established here and must be checked before anything is planned on it.*
- **Per-application split tunnel exists and is shipping.** `SplitTunnelConfig`
  selects up to 64 executables **by absolute path** and routes them through
  whichever protocol is active (`apps/desktop-windows/ipc/src/lib.rs:522-539`).
  Point it at a launcher and a game and everything else stays on the direct
  path.
- **The full tunnel no longer leaks IPv6.** Measured and fixed on the rig:
  OpenVPN, IKEv2 and REALITY all went from 13/16/13 clear-text public v6
  packets to **0** with the client's own dynamic-session WFP block filters,
  client 0.9.27. WireGuard was already contained by its own kill-switch.
- **The Gaming Mode data model already covers the route product, not just the
  DNS one.** `GameProfile` carries `processNames[]`, `destinationCidrs[]`,
  `publisherAsn` and `prefixComplete`, with the prefix-completeness rule
  written into the schema comment
  (`apps/backend/prisma/schema.prisma:1355-1381`).

**What follows from that.** For an access problem — in either direction — the
capability is already in customers' hands:

| Need | Existing answer | New node software required |
|---|---|---|
| Outbound censorship of the game's path | Any of six transports; REALITY or TLS-in-WS for DPI resistance; the ladder for automatic recovery | **None** |
| The game refuses an Iranian source address | Full tunnel, or Custom mode with the game's executables selected — either changes the game's source address to the node's | **None** |
| Keep banking, domestic sites and multi-GB patch downloads off the tunnel | Custom mode, per-executable | **None** |
| Domestic hop for a consumer ISP with a poor international leg | Relay route, Iran entry → foreign exit | **None** — the machinery exists |

**The unbuilt node side — CoreDNS plus an Xray `dokodemo-door` SNI proxy —
adds nothing to any row of that table.** Worse, for access it is strictly
weaker than what already ships: a DNS mechanism reaches only the hostnames an
application resolves through the stub, and it reaches WoW's realm and world
connections **never**, because those addresses arrive as literals inside the
Battle.net session. The design doc says so itself (§4.2.1) and calls it
decisive. It was decisive for a latency product. For an access product it is
disqualifying.

### The honest caveat, and it is a real one

Custom mode is the right mechanism and **it is not currently reliable enough
to carry a product whose entire value is that the game must be seen coming
from the foreign exit.** Five mechanisms were confirmed by diagnosis on
2026-08-22: a SYN_SENT survivor, a UDP twin of the 0.9.25 attribution race,
pre-existing QUIC redirected mid-flow, a 180-second NAT expiry that strands a
quiet connection and then **leaks its next packet direct**, and a
first-gateway-wins uplink pick that loses on multi-NIC machines. Every one of
those produces the same customer-visible symptom — *the selected app was
sometimes not tunnelled* — and for this product that symptom is the game
briefly appearing at the player's real Iranian address.

**So the work that would make an access-shaped Gaming Mode real is split-tunnel
reliability work that is already planned, on the client, not a resolver on the
node.**

---

## The cheapest experiment that settles all of it

One beta tester, one real Iranian home connection (TCI, MCI, Irancell or
Shatel — **not** a datacenter, not a VPS, not a colleague's server), under an
hour, producing a single text file. Nothing is installed and nothing is
changed on the machine.

The design is **A/B/A on the same connection in the same session**, because
Iranian filtering is not static and a single-arm result proves nothing.

**Arm A — direct, tunnel off.** Record, forcing IPv4 on every check
(the nodes have v6 and a v6 answer has previously faked a total failure):

1. `curl -4 https://ipinfo.io/json` — the tester's own exit IP and ASN. This
   is what identifies the vantage point and it must be in the output.
2. For each game hostname in the profile list: the A record from the **ISP
   resolver**, and the A record from a **known-good DoH resolver**, side by
   side. A difference is DNS manipulation. An answer in `10.10.34.0/24` is the
   Iranian block page.
3. TCP connect, with timing, to each game's real service and game ports —
   for Blizzard, `37.244.62.99:3724` and `eu.actual.battle.net:1119`.
   Record connect / refused / timeout, not just success.
4. **UDP reachability**, separately from TCP — and **QUIC separately again.**
   This is now the highest-value step in the whole run, not a footnote: QUIC
   measured **100% blocked** from inside Iran after June 2025 and never
   recovered, DNS-over-UDP drops sit at 89%, and Iran's UDP filter is keyed on
   destination IP rather than port. Every probe this programme has run so far
   is TCP-shaped, and games are largely UDP. If anything is broken for a real
   player, the prior probability says it is here.
5. `ping -4 -n 100` to `37.244.62.99` — **and report loss and the min/max
   spread, not the mean.** Below WoW's 400 ms `SpellQueueWindow` the mean
   barely matters and loss does.
6. **The thing no synthetic probe can do: launch the launcher and log in.**
   Record the exact error text and screenshot it. A sanctions block that sits
   *behind* authentication is invisible to every check above and is the single
   most likely place for a real block to live.

**Arm B — Neoxify on.** Repeat 1–6 identically, with the client connected to
**germany-1** (the only node that is a wash on latency), first in full-tunnel
mode and then in Custom mode with the launcher and game executables selected.
Step 1 must now report the node's address; if it reports the tester's own
address, the tunnel is not carrying the traffic and every later step in that
arm is void.

**Arm A again.** Same as A. If A and A' disagree, the network changed under
the test and the run is inconclusive — which is a result, not a failure.

### What each outcome means, decided before the data arrives

| Result | Meaning | Consequence |
|---|---|---|
| A fails at step 3/4, B succeeds | **Outbound blocking is real** | Neoxify already fixes it. Ship guidance, not software. |
| A succeeds at 3/4 but fails at step 6 with a region/sanctions error; B succeeds | **Inbound geo-block, and our exit is accepted** | Ship a game profile for Custom mode. Still no node work. |
| A *and* B both fail at step 6 | **Inbound block, and our exit IP is refused** | This is the expensive case: an address-space problem, not a routing one. See the exit-reputation section. |
| A and B both succeed everywhere | **Nothing is blocked for this player** | The access premise dies for that ISP. Say so and do not build. |
| A's ping is ≈72 ms | The datacenter baseline was representative | No latency headroom; the EZ Connect domestic-hop inference is dead |
| A's ping is ≫72 ms with loss | The datacenter baseline was **not** the customer's baseline | The domestic-hop inference is live, and the relay machinery to test it already exists |

The last two rows are why this experiment is worth running even if the access
question resolves immediately: **the same ping settles the EZ Connect
mechanism that the design doc records as unexplained.**

**One tester on one ISP is one data point.** Iran's consumer networks filter
differently — on Discord, Irancell blocks at 86% while TCI blocks at 51% —
and filtering changes by day and by hour. Three testers on three ISPs, twice,
is the smallest run that should be allowed to justify building anything.

### A second experiment that costs a pull request

**Add the game domains to the Citizen Lab Iran test list.** `battle.net`,
`riotgames.com`, `leagueoflegends.com`, `valorant.com`, `steamcommunity.com`,
`minecraft.net` and `dota2.com` are **not on it**, which is why OONI has
thousands of measurements of `www.blizzard.com` and zero of `battle.net`.
Adding them means every OONI probe in Iran — real consumer handsets and home
lines, continuously, for free, forever — starts answering the question this
programme has been trying to answer with one-off sweeps.

It is one pull request against
[`citizenlab/test-lists`](https://github.com/citizenlab/test-lists/blob/master/lists/ir.csv),
it costs nothing, it benefits the whole censorship-measurement community, and
it produces a continuous longitudinal dataset that no amount of internal
probing can match. **This is the highest value-per-effort item in this entire
document** and it does not depend on any decision about the product.

---

## Verdict on the original hypothesis

> *"it looks like those are not vpn they might be dns only on different vps
> like german/france or other"*

**Three clauses, three different answers.**

### "They are not VPNs" — **right, and for the right reason**

Not one of ExitLag, NoPing, WTFast, GearUP's Process Mode, Mudfish's WFP mode
or Outfox brings up a tunnel that carries the machine's traffic. They install
a **packet filter or callout driver** that picks out one process's flows and
hands them to a proxy. ExitLag's driver is an NDIS lightweight filter, which
means it does not even create an adapter — anyone looking in Device Manager
for an "ExitLag adapter" finds nothing, which is very likely what produced
the impression that no tunnel exists.

Two qualifications. **On mobile they *are* VPNs**: ExitLag, WTFast and GearUP
all use Android's `VpnService`, because Android offers nothing else.
And **GearUP ships a TAP adapter too** (`tap0901`, OpenVPN's own component
ID) for its Routing Mode, chosen per node.

### "DNS only" — **wrong for these products, right about a different set**

**Wrong for the gaming optimisers.** ExitLag has no DNS feature at all.
WTFast, GearUP and Outfox have none. NoPing has a "DNS Optimizer" that
benchmarks public resolvers and rewrites the system resolver — a
resolution-speed feature, not a traffic-steering one. Mudfish ships a DNS
Client whose stated purpose is *defeating DNS poisoning*, and its own docs
are explicit that steering is done by the routing table or the WFP driver.

**Right about a set the question probably ran into.** Iran has a whole market
of genuinely DNS-based services — Shecan, 403.online, Begzar, Electro,
DNSBox — and they work exactly as the hypothesis describes: answer a
sanctioned hostname with an Iran-hosted address and reverse-proxy the TLS.
But note what they sell: **تحریم‌شکن, sanction-breaking. Access.** None of
them claims a latency benefit.

And the sharpest statement of the distinction comes from an Iranian operator
in this exact market rather than from any Western vendor:

> «دی ان اس فقط میگه مقصد کجاست. سرویس کاهش پینگ بین مسیر رسیدن به اون مقصد
> رو انتخاب می‌کنه.»
> *"DNS only says where the destination is. A ping-reduction service chooses
> the route to reach that destination."*

**There is no such thing as a service that moves packets with DNS.** A DNS
product is a DNS *plus a relay*; DNS chooses what gets relayed, and the relay
does the work. That is why Neoxify's own Gaming Mode design pairs a resolver
with an SNI proxy — the design is right about the shape and the shape is not
"DNS only".

### "On ordinary VPS in Germany, France or elsewhere" — **right, and verifiably so**

This is the best-evidenced part of the hypothesis.

- **Mudfish publishes the hosting provider of every one of its ~500–650
  nodes**: AWS, Google, Azure, DigitalOcean, Vultr, Linode, OVH, Hetzner,
  G-Core, LeaseWeb, SK Broadband and a long tail of small regional hosts. A
  spot check of `node-kr-00615` (`58.228.131.31`) returns AS9318 SK Broadband,
  matching its own published field.
- **ExitLag's registered address space is four `/30`s inside Voxility** — a
  DDoS-scrubbing and transit reseller — in Bucharest, Miami (NAP of the
  Americas), Equinix Ashburn and Digital Realty Frankfurt, plus a velia.net
  `/31`. Sixteen registered addresses against a claimed 1,500 servers.
- **NoPing's entire registered footprint is one `/31` from velia.net**,
  in an org record created four days before this research.
- **No ASN, no prefix and no PeeringDB record exists for any of these
  brands** — ExitLag, NoPing, WTFast, GearUP, Mudfish or EZ Connect.

**They rent exactly as Neoxify rents.** Their advantage is quantity of PoPs,
colo adjacency to internet exchanges, and per-game data — not network
ownership, not peering, and not anything exotic. The one company in the
adjacent space that solved routing properly, Riot, did it by building a
backbone with real peering, and says so publicly.

### And the clause the question did not contain, which matters more

**The premise that these are latency products is itself the thing to
question.** Their own artifacts undercut it: WTFast's commissioned IEEE study
admits that when its own paths spike, total latency runs 61–164 ms against
19–61 ms off-network; hands-on testing found WTFast improved four of six
games and made two worse; Cox shipped WTFast to six million homes as "Elite
Gamer" and killed it for lack of demand.

---

## What is actually transferable to Neoxify

Honestly, and in order of value.

### Transferable, and already half-built

1. **Per-process selection by absolute path.** Neoxify's is **better than the
   market leader's.** ExitLag matches the executable's *image name*, so a
   third-party developer ships a mode that copies its own binary to
   `LOSTARK.exe` to get proxied. `SplitTunnelConfig` selecting by absolute
   path is the correct choice and the comment explaining it should stay.
2. **One row per game, covering launcher and game together.** WTFast's own
   failure mode is instructive: it keys on "the process running while the
   game is active, which is not necessarily the process you run to start the
   game", and reviewers found that selecting the launcher optimises patch
   downloads rather than gameplay. `GameProfile.processNames[]` already
   models this correctly.
3. **A repair button.** ExitLag ships "Reset network settings" in its own
   Advanced settings. Everyone filtering at this level ends up needing one.
   `RepairNetwork.tsx` is not a symptom of a uniquely bad teardown; it is
   table stakes.
4. **Relay chaining, entry to exit.** WTFast picks an entry node and an exit
   node; NoPing lets the user choose intermediate hops; Mudfish chains two to
   four. Neoxify's `Route` already has `entryProtocolConfigId` and
   `exitProtocolConfigId` and has run thirteen relay routes.

### Transferable in principle, but not affordable

5. **Multipath / route diversity.** Two separate reasons to leave it.
   - **The evidence is absent.** No capture, no traceroute, no nDPI
     dissector, no independent teardown exists for any product's multipath
     claim. ExitLag's own KB described route *migration* in 2024 and
     duplication in 2026, and its shipped control is a **two**-route toggle.
   - **It cannot work for the customer Neoxify has.** Route diversity needs
     divergent paths, and TCI, MCI and Irancell each have essentially one
     international upstream — the state TIC. There is no second path to put
     the second copy on.

6. **Premium transit and colo adjacency.** ExitLag sits in Equinix Ashburn
   and Digital Realty Frankfurt; that is real and it is why their second legs
   are short. It is also a different cost base, and per §2 the second leg from
   Frankfurt to Amsterdam is already only 6.7 ms — there is nothing there to
   win for this route.

### Not transferable, and it is the honest headline

7. **The dominant mechanism of this industry is "a shorter, better-provisioned
   path to the game", and on the one path Neoxify has measured that path
   already exists and the customer is already on it.** 72.0 ms direct at a
   stretch of 1.77× against an internet median of 2.1×. Nothing in this
   research suggests any of these companies could beat it either.

### The cheap subset that *is* genuinely useful for Iranian players

Not latency. Three things, in descending confidence:

8. **Access — and Neoxify already has the strongest tooling in this
   comparison for it.** Eight transports with an automatic ladder, REALITY and
   TLS-in-WebSocket obfuscation, per-network memory of what worked, Iranian
   relay entries, and `uot: true` so game UDP survives a network that degrades
   UDP. **Not one of ExitLag, NoPing, WTFast, GearUP or Outfox does any
   censorship circumvention at all.** They are unencrypted relays; an
   unencrypted relay on a fixed port is what Iranian DPI is best at. This is
   the one axis on which Neoxify is not the challenger.

   **And there is already a measured, un-hypothetical market here.** Iran
   confirmably blocks **Discord at 67%** across 12,571 consumer measurements
   and **Free Fire's `ff.garena.com` at 76%** — Free Fire being a mass-market
   mobile title, and Discord being where gaming's social life happens. Those
   are DNS-poisoned to `10.10.34.35`, which Neoxify's tunnel already defeats
   today, on Android, with per-app routing. **The gaming feature with the best
   evidence behind it is not a WoW feature at all**; it is "Discord and your
   mobile game work again", for an audience far larger than the WoW one, and
   against a block that has been measured thousands of times rather than
   hypothesised once.
9. **Keeping the tunnel narrow.** Per-app routing keeps banking and domestic
   Iranian services — which commonly refuse foreign addresses — off the
   tunnel, keeps multi-GB patch downloads off a metered plan, and avoids
   paying tunnel cost for everything. That is a real benefit of Custom mode
   and it is independent of any latency claim.
10. **Loss and jitter, if measured.** RON's actual result is that overlays win
    at the tail. Nobody has measured loss or jitter on an Iranian consumer
    connection to a game server, and mean RTT — the only thing measured so
    far — is the wrong statistic below WoW's 400 ms `SpellQueueWindow`.

---

## Recommendation

### 1. Should the Gaming Mode node side be built?

**No — not in the shape it is designed in.** Do not build the CoreDNS
resolver, the `dokodemo-door` SNI proxy, the `CONFIGURE_GAMEDNS` agent
command or the `install_gamedns` installer function.

Three reasons, in order of weight.

**It cannot reach the thing that is broken.** The DNS mechanism reaches only
hostnames the application resolves through the stub. WoW's realm and world
addresses arrive as literals inside the Battle.net session; a modern
matchmade game gets a raw `IP:port` back from an HTTPS matchmaking call. If
the player cannot *connect to the game server*, DNS is structurally unable to
help, and the design doc says so itself (§4.2.1) — it simply weighed that
against a latency product, where being unable to touch the game path was a
*feature*. Under the access framing the same property is disqualifying.

**Everything it would deliver is already deployed.** §"What Neoxify can
already do today" walks the four access needs and finds an existing answer
for each with **no node software at all**. Building a resolver adds a new
public listener, an open-resolver amplification risk, an SNI proxy that is an
open proxy without a strict allowlist, and a new fingerprint beside a fleet
that already has a port-profile problem on ir1 — in exchange for a capability
that is weaker than the one already shipping.

**The client copy already written commits to the wrong claim.** The shipped
strings say *"The game itself connects directly, on the shortest path"* and
put **"Your computer's IP address does not change in this mode"** on screen
for the entire session. Those sentences were written honestly and correctly
for a latency product. For an access product they are exactly backwards —
the IP change **is** the mechanism. Shipping the node side would make the
client's most prominent guarantee false.

**Keep the parts that are right.** `GameProfile` already models the access
product: `processNames[]`, `destinationCidrs[]`, `publisherAsn`,
`prefixComplete`, `excludeHostnames[]` and the prefix-completeness rule.
`GamingResolver.confirmedAt` and its refusal to claim availability on intent
alone are the right pattern. Nothing in the backend or panel needs deleting;
what changes is which client mechanism the profile drives.

### 2. What to build instead

**Gaming Mode becomes a curated front end on Custom mode.** One row is one
game; choosing it selects the launcher and game executables and routes them
through an existing protocol to an existing exit. No new node software, no
new listener, no new driver.

Ordered, and each step gated on the one before:

**Step 0 — run the experiment in §"The cheapest experiment".** One tester,
one real Iranian home ISP, under an hour. It can come back "nothing is
blocked", and that outcome must be allowed to end the programme. Nothing
below is justified until it returns.

**Step 1 — split-tunnel reliability, which is already planned work.** The
five confirmed mechanisms (SYN_SENT survivor, the UDP attribution race,
mid-flow QUIC, the 180-second NAT expiry that leaks the next packet, and
first-gateway-wins) each produce *the selected app was sometimes not
tunnelled*. For this product that symptom **is** the failure: the game
briefly appears at the player's real Iranian address, which is
simultaneously the sanctions signal and the impossible-travel signal.
Merge and **verify on the rig** `claude/split-tunnel-latency` — four fixes
whose own commit messages say they are unproven.

**Step 2 — invert fail-open for gaming profiles.** Custom mode fails open by
design and the comment justifying it cites games. For a game whose value is
the exit address, an unredirected connection during failover is the worst
possible behaviour. Add a per-profile `failClosed`, default true for gaming
profiles, false everywhere else, with the UI saying which is in force.

**Step 3 — the game catalogue.** Populate `GameProfile` from the panel, one
row per game covering launcher *and* game — and heed WTFast's documented
mistake: the process running during play is often not the one you launch.

**Step 4 — rewrite the client copy for access.** Every string listed above
must change. And the honesty bar does not move: the client must not say
"Connected" or "protected" for a game until it has verified the game's
traffic is actually leaving through the node.

**Step 5 — Android, which is probably the larger market and has the better
evidence.** Per-app routing already works there for both the Xray/TUN and
WireGuard paths. The Iranian mobile audience — Clash of Clans, PUBG Mobile,
Free Fire — is far larger than the WoW audience; **Free Fire is measured
DNS-blocked in Iran at 76% and Discord at 67%**, which is a real, repeatedly
measured block rather than a hypothesised one; and EZ Connect, the closest
local competitor, **has no Android app at all.** Those three facts together
are the most concrete opportunity this research found, and they do not
depend on the Blizzard question resolving either way.

Worth considering seriously: **this step could reasonably come first.** It
is the only part of the programme whose premise is already measured.

**A note on iOS, which the access framing improves.** Under the DNS design
iOS was the worst platform: no per-app anything, DNS-only and system-wide.
Under the access framing iOS is *fine* — a full tunnel changes the exit
address, which is the entire mechanism. The remaining gap is only that iOS
cannot keep domestic traffic off the tunnel. State it; do not hide it.

### 3. What is missing, and whether it is cheap or expensive

| If the experiment shows | The missing piece is | Cost |
|---|---|---|
| Outbound blocking of the game path | Nothing. Ship the catalogue and guidance | **Cheap** |
| Inbound geo-block, Neoxify's exit accepted | The catalogue plus split-tunnel reliability | **Cheap — already planned work** |
| Inbound geo-block, Neoxify's exit **refused** | **Address space**, not routing | **Expensive, and a separate programme** |
| Nothing blocked on that ISP | Nothing — do not build | **Zero** |

The third row is the one to be honest about in advance. All five node
addresses are datacenter-labelled ASN-wide; two of the five share one ASN;
Hetzner and Linode are among the most heavily VPN-flagged hosting networks
there are; and **rotating addresses within those ASNs has been shown to buy
nothing.** No competitor has solved this either — Mudfish's published fleet is
the same hyperscalers and the same labels. If the exit is refused, that is an
IP-reputation procurement problem, it must be priced against **new** providers
vetted against the feeds **before** purchase, and it should be scoped
separately rather than smuggled into a feature.

### 4. What must never be claimed

Unchanged from the design doc, and reinforced by this research:

- **No millisecond figure** that was not measured on that customer's own
  path. Our own data contradicts a ping claim on four of five nodes and calls
  it a wash on the fifth.
- **No ban-safety claim.** GearUP makes one; NoPing asserts compliance with
  the terms of Epic, Blizzard, Riot, Valve, Microsoft and others **with no
  citation for any of them**. Neither we nor a testimonial nor an affiliate
  says that in our voice. Gameforge has banned accounts for region-hopping
  through a relay.
- **Nothing implying the sanctions position changes.** The EULA clause is
  about residence.
- **"Multipath", "route optimisation" or "AI routing"** — three claims this
  industry makes and none has ever demonstrated.

### 5. The one-line answer

**Gaming Mode as designed solves a latency problem the measurements say does
not exist, with a mechanism that cannot reach an access problem that has
never been measured. The access problem, if it is real, is already solved by
what Neoxify ships — so the work is one hour of measurement from an Iranian
living room, then reliability work on a split tunnel that already exists,
and no node software at all.**

---

## What this research could not establish

Listed because an absence is a finding, and because the next session should
not re-derive the same dead ends.

**About the providers**

- **No packet capture of any product in this market exists in public.** Not
  for ExitLag, NoPing, WTFast, GearUP, Mudfish or Outfox. `nDPI` carries no
  dissector for any of them. Every claim about what actually goes over the
  wire — encapsulation, encryption, whether "multi-server" means concurrent —
  is vendor-asserted for all of them. The obvious next step is one `tcpdump`
  on the physical NIC of the **Neoxify-Test rig** while a UDP flow runs under
  ExitLag. That single capture would settle the multipath question for the
  whole industry.
- **ExitLag's current (non-legacy) redirection method has no name.** A WFP
  connect-redirect to a loopback proxy is inferred from three converging
  artifacts — a socket hook logging `127.0.0.1 -> <real server>`, third-party
  tools describing "ExitLag's proxy", and packets vanishing from the physical
  adapter — but no driver filename or vendor document was found.
- **The actual relay fleets are not enumerable.** 16 registered IPs against
  ExitLag's claimed 1,500 servers; 2 against NoPing's claimed 2,000. The rest
  carry no attributable registration.
- **Neither ExitLag's nor NoPing's claimed patents could be located.** Both
  say "patented". Searches returned nothing before rate-limiting, and
  Brazilian INPI filings were not searched. Unresolved, not disproved.
- **Outfox appears to be dead** — `getoutfox.com` 307-redirects to
  `vyprvpn.com/gaming-vpn`, which does not mention Outfox — but no sunset
  announcement was found, and its adapter, driver and service names were never
  documented anywhere.
- **EZ Connect's tunnel protocol, exit geolocation and Windows driver model
  are unknown.** Settling them means instrumenting their 55 MB Windows client
  in a VM. Given the rig exists, that is arguably the highest-value single
  follow-up in this document: it is the closest competitor, in the same
  market, selling to the same customer.
- **Haste's duplication claim** is the only genuinely novel mechanism claimed
  in this market and it is unverified. Battleping and Kill Ping appear dead.

**About Iran and the games**

- **Which specific games and platforms refuse Iranian addresses *today*, and
  by what mechanism** — IP-level, account-level or payment-level. The
  publisher geo-blocking reports for Blizzard, Riot and Epic date to **2019**
  and current status is unverified. Two research threads — one on the
  per-publisher blocking picture, one on obtaining address space that is not
  labelled datacenter — were still running when this document was assembled
  and their results are **not** included. Treat both as **open**.
- **Whether UDP specifically is degraded for a game's own traffic** on
  Iranian consumer ISPs. The evidence that Iran's UDP filter is keyed on
  destination IP means a game server has no obvious reason to be on the
  blocklist while a VPN's VPS does — **but that asymmetry is an inference, and
  it cuts against the product**: it would mean Neoxify's own transport is more
  exposed to the UDP filter than the game it is carrying.
- **Whether a block sits behind authentication.** No unauthenticated probe can
  see it, and it is the most likely place for a real sanctions block to live.
- **Whether announcing your own leased address space escapes the
  datacenter/VPN label**, and what an ASN plus a /24 plus transit actually
  costs. Unpriced. This decides whether the expensive branch of the
  recommendation is affordable at all.
- **Whether domestic WireGuard works** — an Iranian customer to the Iranian
  relay — already recorded as open in `docs/detection-resistance.md`.

**A standing trap, repeated because it has produced convincing false
negatives here before:** force IPv4 on every exit-IP assertion (the nodes have
v6 and a v6 answer fakes a total failure), and remember that `urllib` cannot
speak SOCKS.

---

## Sources

Grouped by what they are worth. Vendor pages are listed because they are
quoted, not because they are evidence.

**Peer-reviewed and measurement**

- Andersen et al., *Resilient Overlay Networks*, SOSP 2001 — <https://www.sosp.org/2001/papers/andersen.pdf>, <http://nms.csail.mit.edu/ron/>
- Bozkurt et al., *Dissecting Latency in the Internet's Fiber Infrastructure*, arXiv:1811.10737 — <https://arxiv.org/pdf/1811.10737>
- *Holes in the Geofence: Privacy Vulnerabilities in "Smart" DNS Services*, arXiv:2012.07944 — <https://arxiv.org/abs/2012.07944>
- Tai et al., *IRBlock: A Large-Scale Measurement Study of the Great Firewall of Iran*, USENIX Security 2025 — <https://www.usenix.org/system/files/usenixsecurity25-tai.pdf>
- Niere, Lange & Somorovsky, *Insights into an Iranian Internet Shutdown*, FOCI 2026 — <https://www.petsymposium.org/foci/2026/foci-2026-0016.php>
- Elmenhorst et al., *Web Censorship Measurements of HTTP/3 over QUIC*, IMC 2021 — <https://dl.acm.org/doi/10.1145/3487552.3487836>
- UCSC RandLab, *A Swift Look into the Internet Allowlist in Iran*, June 2026 — <https://randlab.engineering.ucsc.edu/blogs/iran-allowlist/>

**Measurement platforms and network data**

- OONI aggregation API — <https://api.ooni.io/api/v1/aggregation>; Explorer — <https://explorer.ooni.org/country/IR>
- Citizen Lab Iran test list — <https://github.com/citizenlab/test-lists/blob/master/lists/ir.csv>
- bgp.he.net (Iranian ISP peer sets, 2026-08-25); ipinfo.io (node ASN lookups); RIPE database (ExitLag and NoPing inetnums); PeeringDB (absence of records)
- Censys, *Iran's Internet: A Censys Perspective* — <https://www.censys.com/blog/irans-internet-a-censys-perspective>
- net4people/bbs issues [#181](https://github.com/net4people/bbs/issues/181), [#253](https://github.com/net4people/bbs/issues/253), [#489](https://github.com/net4people/bbs/issues/489), [#612](https://github.com/net4people/bbs/issues/612), [#626](https://github.com/net4people/bbs/issues/626), [#628](https://github.com/net4people/bbs/issues/628), [#640](https://github.com/net4people/bbs/issues/640) — in-country anecdote, labelled as such throughout
- IODA, *The Normalization of Tiered Internet in Iran* — <https://ioda.inetintel.cc.gatech.edu/reports/from-war-to-sovereignty-the-normalization-of-tiered-internet-in-iran/>
- Freedom House, *Freedom on the Net 2024: Iran* — <https://freedomhouse.org/country/iran/freedom-net/2024>

**Artifacts that establish a mechanism**

- `ndextlag.sys` version block, "NDIS 6 LWF packet redirector driver" — <https://www.pconlife.com/viewfileinfo/ndextlag-sys/>
- `wtfenginedrv.sys`, "WTFastEngine WFP Driver x64", signer Initex — <https://www.freefixer.com/library/file/wtfenginedrv.sys-203952/>; Initex product list — <https://initex.com/>; Proxifier v4 WFP architecture — <https://www.proxifier.com/docs/win-v4/install.html>
- NoPing support naming **WinpkFilter** and its route-count/bandwidth advice — <https://noping.com/support>
- Mudfish WFP Item mode — <https://docs.mudfish.net/en/docs/mudfish-features/wfp-item-mode/>; Item syntax — <https://docs.mudfish.net/en/docs/mudfish-launcher/item/>; Multi-Path — <https://docs.mudfish.net/en/docs/mudfish-features/multipath-node-mode/>; per-node fleet with provider names — <http://mudfish.net/server/status>
- GearUP driver inventory (`tap0901`, `gunetfilter.sys`, `lspinst_x64.exe`) — <https://www.advanceduninstaller.com/GearUP-2e0305367e05976edb2b1de2a2f9776f-application.htm>; "Adaptive Intelligent Routing" in their own words — <https://www.gearupbooster.com/support/what-is-adaptive-intelligent-routing-technology.html>
- ExitLag process-name matching, exploited in the open — `snoww/loa-logs`, `src-tauri/src/constants.rs` (`NINEVEH_COMPAT_EXE_NAME = "LOSTARK.exe"`)
- Netch process mode on `netfilter2.sys` — <https://github.com/NetchX/Netch/blob/main/Netch/Controllers/NFController.cs>; NetFilter SDK — <https://www.netfiltersdk.com/help/nfsdk2/nfapi_index.html>
- EZ Connect terms of service — <https://ezconnect.ir/policies/terms-of-service>; usage flow — <https://ezconnect.ir/how-to-use>; Telegram channel naming foreign routes — <https://t.me/ezconnect_ir>

**Industry context**

- Riot Games, *Fixing the Internet for Real-Time Applications* — <https://www.riotgames.com/en/news/fixing-internet-real-time-applications-part-ii>
- WTFast GPN performance evaluation, IEEE SysCon 2020 — co-authored by WTFast's COO; read the spike-magnitude figures, not the headline — <https://www.okanagancollege.ca/sites/default/files/2025-01/2020sysconwtfastgpnperfevresults.pdf>
- Cox discontinuing "Elite Gamer" (white-labelled WTFast) — <https://www.lightreading.com/customer-experience/cox-killed-its-elite-gamer-service-here-s-why-that-s-important>
- Publisher sanctions geo-blocking, **dated 2019 and unverified for today** — <https://www.pcgamer.com/blizzard-battle-net-being-blocked-in-iran-is-due-to-us-sanctions-not-government-censorship/>, <https://www.aljazeera.com/economy/2019/12/23/locked-out-us-sanctions-are-ruining-online-gaming-in-iran/>

**Marketing, quoted but not relied on**

- ExitLag technology page and "how it works" blog; NoPing technology page;
  GearUP node/mode pages; LagoFast claims; Outfox via Golden Frog's blog and
  Windows Central's reporting.
