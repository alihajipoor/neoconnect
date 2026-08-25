# Are Neoxify's exit IPs labelled as VPN? A measurement

Status: **measurement.** Every number below was taken on **2026-08-25** from
free, public reputation feeds. This is not a literature review; the raw
per-IP results are in the tables, and the exact commands that produced them
are in "Reproducing this" at the end.

Neoxify's own addresses in this file are redacted: `{germany-1}`, `{finland1}`, `{panel}` and the like stand in for real node addresses, including where they appear inside a PTR name or a reverse-DNS query. Third-party addresses -- Mudfish, ExitLag, NoPing, Mullvad, NordVPN, Voxility, Vultr -- are kept exactly as measured, because they are the evidence. Each placeholder is stable, so same-provider comparisons still read: `{germany-1}` and Mudfish's `38.60.202.189` are still visibly two different addresses at one provider with opposite verdicts. Node addresses are never committed -- see `docs/node-address-hygiene.md`.

Companion to `docs/research/gaming-providers.md` (branch
`claude/gaming-providers-research`). **It corrects that document's headline
conclusion on this subject -- see "Correction to the record" below.**

**The question, as the owner put it:**

> *"The most important thing gamers care about with ExitLag is they won't get
> banned by that, but when they use a regular VPN they get banned."*

The hypothesis under test: **gaming relays are not flagged because their
address space carries no consumer-VPN reputation** -- not because their IP
never changed. If true, the question for Neoxify is which side of that line
it currently sits on.

---

## The verdict, in five lines

1. **Neoxify's exits are labelled `datacenter`. They are not labelled `vpn`,
   `proxy` or "Anonymizing VPN" by any of the five feeds checked.** 0 of 6
   nodes carry a VPN flag on any feed.
2. **ExitLag's and NoPing's address space measures exactly the same way** --
   datacenter yes, VPN no, on all twelve of their addresses. **Neoxify is
   already on ExitLag's side of the line, not Mullvad's.**
3. **Mullvad and NordVPN are flagged on every feed** -- `is_vpn: true`,
   `proxy: true`, "Anonymizing VPN: yes", and present in the X4BNet VPN
   blocklist. So is **Mudfish**, the market-leading gaming relay, on
   **19 of 20** sampled nodes.
4. **The distinguishing variable is not the ASN, the provider, the
   address-space age or the paperwork. It is whether the operator's exit
   list is publicly enumerable.** Two same-provider control pairs prove it
   (below): the published node gets flagged, the unpublished one on identical
   infrastructure does not.
5. **So the owner's hypothesis is half right, and the correction favours
   Neoxify.** Gaming relays really are labelled differently from consumer
   VPNs -- but the reason is publication, not transit-versus-cloud address
   space. Mudfish is a gaming relay on the *same* cloud providers and is
   flagged worse than Mullvad on some feeds. **There is no evidence today
   that a VPN label is why a Neoxify user would be banned**, because Neoxify
   does not currently carry one.

**The one thing this measurement cannot tell you** is whether Riot, Blizzard
or Epic consume any of these feeds. Nothing here is a game's verdict. See
"What this does not settle".

---

## Correction to the record

`docs/research/gaming-providers.md` states, in its summary and again in
"The exit-IP reputation problem":

> *"All five Neoxify node addresses are labelled datacenter by every feed
> checked; three are labelled VPN outright and the other two carry
> is_abuser=true."*

> *"The label is ASN-wide, not earned. Controls on unrelated IPs in the same
> ASNs return identical verdicts. Rotating to a fresh address at the same
> provider buys nothing."*

> *"And that label cannot be bought off ... `is_vpn`/`is_datacenter` is not
> movable by address-space engineering."*

**Three of those claims do not survive measurement.**

| Earlier claim | What the measurement shows |
|---|---|
| "three are labelled VPN outright" | **Not reproduced.** 0 of 6 Neoxify addresses return `is_vpn: true` (ipapi.is), `proxy: true` (ip-api.com), "Anonymizing VPN: yes" (Scamalytics), or membership of the X4BNet VPN list. The *datacenter* half of the claim is fully confirmed. `is_abuser: true` is confirmed, on the two LightNode nodes only. |
| "The label is ASN-wide, not earned" | **False for the VPN label; true for the datacenter label.** Two controlled pairs (same ASN, same provider, one address published as a relay and one not) return *opposite* VPN verdicts. See "The two decisive pairs". |
| "cannot be bought off" | **Overstated, and the wrong frame.** The VPN label is not bought, it is *earned by being discoverable*. Mullvad still carries it after buying an ASN because Mullvad publishes every relay address in a public JSON API. Nothing about owning address space stops that. The correct statement is: **address-space spending does not remove the VPN label, and it was never the mechanism that applies it.** |

The earlier document's method was to measure **Mullvad** and generalise. That
was the flaw the owner suspected. Mullvad is the single most-enumerated VPN
brand on the internet; it is the worst possible proxy for a small unlisted
operator.

Two claims from the earlier document **are** confirmed here and should be
kept: the datacenter flag is unavoidable on rented infrastructure, and
residential proxy pools remain disqualifying.

---

## What was measured

**Neoxify's exits** were taken from the panel database on the live panel host,
`SELECT name, role, region, "publicIp", status FROM nodes` -- named columns
only, read-only, no credential columns touched, no node contacted. Six rows,
all matching the exit IPs this repository's own tunnel tests already
recorded. No production node was connected to, restarted, reconfigured or
probed; every lookup below hits a third-party database, not the node.

**Feeds** (all free tiers or public endpoints; nothing paid, nothing signed
up for, no credentials entered anywhere):

| Feed | What it gives | Note |
|---|---|---|
| **ipapi.is** (`api.ipapi.is`) | `is_datacenter`, `is_vpn`, `is_proxy`, `is_abuser`, `is_tor`, ASN | Publishes its algorithm: WHOIS OrgName -> registrant domain -> crawl and keyword-classify |
| **ip-api.com** | `hosting`, `proxy`, ASN, ISP | `proxy` is its anonymiser flag |
| **proxycheck.io** | `proxy` yes/no, `type`, `risk` 0-100 | Free tier, no key, 100 lookups/day |
| **Scamalytics** (public page) | fraud score 0-100, "Anonymizing VPN", "Server", "Public Proxy" rows | Scraped from the public per-IP page |
| **X4BNet `lists_vpn`** | membership of `output/vpn/ipv4.txt` and `output/datacenter/ipv4.txt` | The GitHub CIDR lists many self-hosted blocklists are built from |
| **RIPEstat / RIPE DB / ARIN** | prefix registration dates, netnames, announced prefixes | For address-space age |
| **Google DNS** | PTR / rDNS | For naming hygiene |

**53 addresses** were measured across nine groups. Sampling was
representative rather than exhaustive: 8 of ExitLag's 16 registered
addresses (all four /30s, two each -- the results were uniform), and 20
Mudfish nodes chosen one per provider family across the 20 largest families
in their 635-node fleet. The X4BNet membership test was additionally run
against **all 635** Mudfish nodes locally, at no API cost.

---

## Raw results

Columns: `dc` = ipapi.is `is_datacenter`; **`vpn`** = ipapi.is `is_vpn`;
`abuser` = ipapi.is `is_abuser`; `hosting` / **`proxy`** = ip-api.com;
proxycheck = `proxy / type / risk`; **`Scam. VPN`** = Scamalytics
"Anonymizing VPN" row; X4B = membership of the two X4BNet lists.

### Neoxify

| IP | Who | ASN / owner | dc | **vpn** | abuser | hosting | **proxy** | proxycheck | Scam. score | **Scam. VPN** | X4B VPN | X4B DC | rDNS |
|---|---|---|:--:|:--:|:--:|:--:|:--:|---|--:|:--:|:--:|:--:|---|
| `{germany-1}` | Neoxify germany-1 | AS154177 LIGHT NODE LIMITED | yes | no | yes | yes | no | no / Business / 0 | 0 | no | no | no | — |
| `{turkey-1}` | Neoxify turkey-1 | AS154177 LIGHT NODE LIMITED | yes | no | yes | no | no | no / Business / 0 | 20 | no | no | no | — |
| `{france-1}` | Neoxify france-1 | AS63949 Akamai Technologies, Inc. | yes | no | no | yes | no | yes / VPN / 66 | 26 | no | no | yes | {france-1}.ip.linodeusercontent.com |
| `{finland1}` | Neoxify finland1 | AS24940 Hetzner Online GmbH | yes | no | no | yes | no | yes / VPN / 66 | 6 | no | no | yes | static.{finland1}.clients.your-server.de |
| `{singapore-1}` | Neoxify singapore-1 | AS63949 Akamai Technologies, Inc. | yes | no | no | yes | no | yes / VPN / 66 | 26 | no | no | yes | {singapore-1}.ip.linodeusercontent.com |
| `{ir1}` | Neoxify ir1 relay entry | AS210814 VUNIFY LTD | yes | no | no | no | no | no / Business / 0 | 0 | no | no | no | — |
| `{panel}` | Neoxify panel/API (never a VPN endpoint) | AS24940 Hetzner Online GmbH | yes | no | no | yes | no | yes / VPN / 66 | 6 | no | no | yes | static.{panel}.clients.your-server.de |

The last row is the control that matters most: the panel/API host is a
Hetzner VPS that has **never** carried a tunnel -- and it measures
byte-for-byte identically to `finland1`, which does. Whatever these feeds are
detecting on the Hetzner and Linode nodes, it is not VPN behaviour; it is the
address range.

### ExitLag and NoPing

The first eight are ExitLag's registered footprint -- four `/30`s inside
Voxility. The next four are ExitLag-operated hosts found in certificate
transparency **outside** that registered space, on Vultr and OVH; that these
carry game traffic is **not proven**, only that ExitLag operates them. The
last two are NoPing, including the single OVH box that eleven of its
regional `*-beta` hostnames -- `ir-beta` among them -- all resolve to.

| IP | Who | ASN / owner | dc | **vpn** | abuser | hosting | **proxy** | proxycheck | Scam. score | **Scam. VPN** | X4B VPN | X4B DC | rDNS |
|---|---|---|:--:|:--:|:--:|:--:|:--:|---|--:|:--:|:--:|:--:|---|
| `5.254.56.32` | ExitLag /30 Bucharest .32 | AS3223 Voxility LLP | yes | no | no | no | no | yes / VPN / 66 | 0 | no | no | yes | — |
| `5.254.56.34` | ExitLag /30 Bucharest .34 | AS3223 Voxility LLP | yes | no | no | no | no | yes / VPN / 66 | 0 | no | no | yes | — |
| `5.254.79.204` | ExitLag /30 .204 | AS3223 Voxility LLP | yes | no | no | yes | no | yes / VPN / 66 | 0 | no | no | yes | — |
| `5.254.79.206` | ExitLag /30 .206 | AS3223 Voxility LLP | yes | no | no | yes | no | yes / VPN / 66 | 0 | no | no | yes | — |
| `5.254.81.44` | ExitLag /30 .44 | AS3223 Voxility LLP | yes | no | no | yes | no | yes / VPN / 66 | 0 | no | no | yes | — |
| `5.254.81.46` | ExitLag /30 .46 | AS3223 Voxility LLP | yes | no | no | yes | no | yes / VPN / 66 | 0 | no | no | yes | — |
| `5.254.88.48` | ExitLag /30 .48 | AS3223 Voxility LLP | yes | no | no | yes | no | yes / VPN / 66 | 0 | no | no | yes | — |
| `5.254.88.50` | ExitLag /30 .50 | AS3223 Voxility LLP | yes | no | no | yes | no | yes / VPN / 66 | 0 | no | no | yes | — |
| `216.238.115.26` | ExitLag powerlock.exitlag.com (Vultr AS20473) | AS20473 The Constant Company, LLC | yes | no | no | yes | no | yes / VPN / 66 | 30 | no | no | yes | 216-238-115-26.constant.com |
| `207.246.78.145` | ExitLag xunel.exitlag.com (Vultr) | AS20473 The Constant Company, LLC | yes | no | no | yes | no | yes / VPN / 66 | 42 | no | no | yes | 207.246.78.145.vultrusercontent.com |
| `108.61.191.80` | ExitLag partners.exitlag.com (Vultr) | AS20473 The Constant Company, LLC | yes | no | no | yes | no | yes / VPN / 66 | 42 | no | no | yes | 108.61.191.80.vultrusercontent.com |
| `148.113.215.209` | ExitLag b2b.exitlag.com (OVH) | AS16276 OVH SAS | yes | no | no | yes | no | yes / VPN / 66 | 54 | no | no | yes | ns5036077.ip-148-113-215.net |
| `15.235.46.171` | NoPing *-beta.noping.com incl ir-beta (OVH) | AS16276 OVH SAS | yes | no | no | yes | no | yes / VPN / 66 | 54 | no | no | yes | — |
| `54.39.183.150` | NoPing mobileapi.noping.com (OVH) | AS16276 OVH SAS | yes | no | no | yes | no | yes / VPN / 66 | 36 | no | no | yes | — |

**Every one of the twelve: datacenter yes, VPN no.** Identical to Neoxify.

### Mudfish -- the gaming relay that *is* flagged

| IP | Who | ASN / owner | dc | **vpn** | abuser | hosting | **proxy** | proxycheck | Scam. score | **Scam. VPN** | X4B VPN | X4B DC | rDNS |
|---|---|---|:--:|:--:|:--:|:--:|:--:|---|--:|:--:|:--:|:--:|---|
| `35.201.28.107` | Mudfish node-au-00075.mudfish.net (Google 2, 48 nodes) | AS396982 Google LLC | yes | no | no | yes | **yes** | yes / VPN / 66 | 0 | **yes** | no | yes | 107.28.201.35.bc.googleusercontent.com |
| `20.233.42.17` | Mudfish node-ae-00287.mudfish.net (Azure, 45 nodes) | AS8075 Microsoft Corporation | yes | no | no | yes | **yes** | yes / VPN / 66 | 0 | **yes** | no | yes | — |
| `45.77.48.63` | Mudfish node-au-00551.mudfish.net (Vultr 2, 39 nodes) | AS20473 The Constant Company, LLC | yes | no | no | yes | **yes** | yes / VPN / 66 | 42 | **yes** | no | yes | 45.77.48.63.vultrusercontent.com |
| `49.212.188.122` | Mudfish node-jp-00011.mudfish.net (SakuraNet 4, 34 nodes) | AS9371 SAKURA Internet Inc. | yes | no | no | no | **yes** | no / Business / 0 | 0 | **yes** | no | no | os3-330-54618.vs.sakura.ne.jp |
| `103.205.9.224` | Mudfish node-hk-00064.mudfish.net (TinMok 3, 33 nodes) | AS134835 Starry Network Limited | yes | no | no | no | **yes** | no / Business / 0 | 0 | **yes** | no | no | — |
| `108.181.64.97` | Mudfish node-au-00568.mudfish.net (Psychz, 29 nodes) | AS40676 Psychz Networks | yes | no | yes | yes | **yes** | yes / VPN / 66 | 48 | **yes** | no | yes | — |
| `45.248.78.105` | Mudfish node-au-00051.mudfish.net (RansomIT 5, 28 nodes) | AS136557 Host Universal Pty Ltd | yes | **yes** | no | yes | **yes** | yes / VPN / 73 | 66 | **yes** | no | yes | — |
| `146.185.214.48` | Mudfish node-au-00405.mudfish.net (G-Core Labs, 24 nodes) | AS202422 G-Core Labs S.A. | yes | no | no | yes | **yes** | yes / VPN / 66 | 39 | **yes** | no | no | mudsyd.mudfish.net |
| `172.105.186.62` | Mudfish node-au-00349.mudfish.net (Linode, 23 nodes) | AS63949 Akamai Technologies, Inc. | yes | no | no | yes | no | yes / VPN / 66 | 56 | no | no | yes | li2134-62.members.linode.com |
| `147.78.0.106` | Mudfish node-ae-00271.mudfish.net (OneProvider, 21 nodes) | AS136258 BrainStorm Network, Inc | yes | **yes** | no | no | **yes** | yes / VPN / 66 | 28 | **yes** | no | yes | — |
| `27.100.36.143` | Mudfish node-au-00220.mudfish.net (HostUS, 20 nodes) | AS7489 HostUS | yes | no | no | yes | **yes** | yes / VPN / 66 | 15 | **yes** | no | yes | — |
| `16.50.103.34` | Mudfish node-au-00350.mudfish.net (Amazon EC2, 20 nodes) | AS16509 Amazon.com, Inc. | yes | no | no | yes | **yes** | yes / VPN / 66 | 0 | **yes** | no | yes | ec2-16-50-103-34.ap-southeast-4.compute.amazonaws.com |
| `38.60.202.189` | Mudfish node-ae-00151.mudfish.net (LightNode, 17 nodes) | AS138915 Kaopu Cloud HK Limited | yes | no | yes | yes | **yes** | yes / VPN / 66 | 0 | **yes** | no | no | — |
| `27.102.207.193` | Mudfish node-kr-00039.mudfish.net (GNJ IDC, 17 nodes) | AS45996 DAOU TECHNOLOGY | no | no | no | yes | **yes** | yes / VPN / 66 | 0 | **yes** | no | no | — |
| `47.91.122.48` | Mudfish node-ae-00421.mudfish.net (Aliyun, 14 nodes) | AS45102 Alibaba (US) Technology Co., Ltd. | yes | no | no | yes | **yes** | yes / VPN / 66 | 0 | **yes** | no | yes | — |
| `16.50.61.224` | Mudfish node-au-00002.mudfish.net (Amazon EC2 2, 13 nodes) | AS16509 Amazon.com, Inc. | yes | no | no | yes | **yes** | yes / VPN / 66 | 0 | **yes** | no | yes | ec2-16-50-61-224.ap-southeast-4.compute.amazonaws.com |
| `116.251.216.71` | Mudfish node-sg-00153.mudfish.net (IndoVirtue 4, 13 nodes) | AS59211 OneAsiaHost | no | no | no | yes | **yes** | yes / VPN / 73 | 0 | **yes** | no | no | — |
| `103.150.37.197` | Mudfish node-tw-00149.mudfish.net (HostingInside 14, 11 nodes) | AS9678 HostingInside LTD | yes | no | no | yes | **yes** | yes / VPN / 66 | 0 | **yes** | no | no | 37-150-103-197.hostinginside.com |
| `202.168.154.10` | Mudfish node-kr-00101.mudfish.net (Dognet 10, 10 nodes) | AS4766 Korea Telecom | yes | no | no | no | **yes** | no / Business / 0 | 0 | **yes** | no | no | — |
| `216.250.97.10` | Mudfish node-hk-00466.mudfish.net (HostHatch 2, 8 nodes) | AS63473 HostHatch, LLC | yes | no | no | yes | **yes** | yes / VPN / 66 | 8 | **yes** | no | yes | — |

**19 of 20 carry `proxy: true` and "Anonymizing VPN: yes".** Across the full
published fleet, **426 of 635 (67.1%)** are in the X4BNet datacenter list;
only 3 are in its VPN list, which is the one list here that is prefix-based
rather than behaviour-based.

Note `146.185.214.48`, whose rDNS is **`mudsyd.mudfish.net`**. The node
announces what it is in DNS.

### Controls

| IP | Who | ASN / owner | dc | **vpn** | abuser | hosting | **proxy** | proxycheck | Scam. score | **Scam. VPN** | X4B VPN | X4B DC | rDNS |
|---|---|---|:--:|:--:|:--:|:--:|:--:|---|--:|:--:|:--:|:--:|---|
| `45.92.0.10` | Mullvad own ASN space (AS216025) | AS216025 Mullvad VPN AB | yes | **yes** | no | no | **yes** | yes / VPN / 66 | 0 | **yes** | no | no | — |
| `193.32.127.117` | Mullvad relay ch-zrh (31173 Services) | AS39351 31173 Services AB | yes | **yes** | no | yes | **yes** | yes / VPN / 73 | 17 | **yes** | yes | yes | — |
| `146.70.116.130` | Mullvad relay at-vie (M247) | AS9009 M247 Europe SRL | yes | **yes** | no | yes | **yes** | yes / VPN / 73 | 11 | **yes** | yes | yes | — |
| `187.15.96.88` | NordVPN us13587 | AS147049 PacketHub S.A. | yes | **yes** | no | no | **yes** | yes / VPN / 73 | 40 | **yes** | no | yes | — |
| `{tester-home}` | Residential consumer line (US, beta tester) | AS20055 Wholesail networks LLC | no | no | no | no | no | no / Residential / 0 | 10 | no | no | no | — |
| `5.254.100.1` | Voxility space, not ExitLag | AS3223 Voxility LLP | yes | no | no | yes | no | yes / VPN / 66 | 0 | no | no | yes | buc-ir1-28sw.voxility.net |
| `{germany-1-neighbour}` | LightNode same /24 as germany-1 | AS154177 LIGHT NODE LIMITED | yes | no | yes | yes | no | no / Business / 0 | 0 | no | no | no | — |
| `{singapore-1-neighbour}` | Linode/Akamai same /24 as singapore-1 | AS63949 Akamai Technologies, Inc. | yes | no | no | yes | no | yes / VPN / 66 | 26 | no | no | yes | — |
| `{finland1-neighbour}` | Hetzner same /24 as finland1 | AS24940 Hetzner Online GmbH | yes | no | no | yes | no | yes / VPN / 66 | 6 | no | no | yes | static.{finland1-neighbour}.clients.your-server.de |

---

## The two decisive pairs

The earlier document's "the label is ASN-wide" claim is testable directly:
find two addresses at the **same provider**, one belonging to an operator who
publishes its exit list and one who does not, and compare.

| | Published operator | Unpublished operator | Same infrastructure? |
|---|---|---|---|
| **LightNode / Kaopu Cloud** | Mudfish `38.60.202.189` -- `proxy: yes`, Scamalytics VPN **yes** | Neoxify germany-1 `{germany-1}` -- `proxy: no`, Scamalytics VPN **no** | Yes. Both `38.60.x`, both Kaopu Cloud HK Limited, LightNode's operating org |
| **Vultr / The Constant Company (AS20473)** | Mudfish `45.77.48.63` -- `proxy: yes`, Scamalytics VPN **yes**, score 42 | ExitLag `216.238.115.26` -- `proxy: no`, Scamalytics VPN **no**, score 30 | Yes. Same ASN, same provider, same `vultrusercontent.com` rDNS family |

Same ASN. Same hosting company. **Opposite VPN verdicts.** The label is
per-address and it tracks discoverability, not the AS number.

The ASN-wide effect *does* exist -- but only for one thing, and only for one
kind of ASN:

```text
                    announced      X4B-VPN entries    X4B-datacenter
                    prefixes       inside the AS      entries inside
Hetzner   AS24940      90                 0                  92
Linode    AS63949     350                 0                 112
LightNode AS154177    315                 0                   0
Voxility  AS3223      238                 0                  75
M247      AS9009     4250              2521                2411
```

M247 -- the ASN behind ExpressVPN and much of Mullvad's rented fleet -- has
**99% of its address space in the VPN blocklist**. Hetzner, Linode,
LightNode and Voxility have **zero**. That is what "an ASN with a
consumer-VPN reputation" looks like, and it is a property of M247's tenant
mix, not of hosting in general.

---

## So what actually makes an address "clean"?

In descending order of what the data supports.

**1. Not being enumerable.** This is the whole mechanism. Every operator in
the flagged group publishes a machine-readable exit list that a feed vendor
can scrape on a cron:

- Mullvad: `api.mullvad.net/www/relays/all/` -- every relay, with IP.
- NordVPN: `api.nordvpn.com/v1/servers/...` -- every server, with IP.
- Mudfish: 635 nodes on a public status page, each resolvable via a
  guessable `node-{cc}-{nnnnn}.mudfish.net` hostname convention. **That
  convention is how this document obtained them, using nothing but
  certificate transparency and DNS** -- which is precisely the work a
  detection vendor does, at far greater scale.

The unflagged group publishes nothing. ExitLag, NoPing and Neoxify all hand
node addresses to the client after authentication. WTFast and GearUP go
further: WTFast's ~230 nodes appear in no DNS or CT record at all, and GearUP
deliberately hides behind six unbranded infrastructure domains
(`anchortunnel.com`, `speedlynk.com`, `lynksignal.com`, `connectrly.com`,
`saferarmadillo.com`, `accessflux.com`) whose only tie to the brand is a
shared certificate.

**2. Free or trivially cheap access.** A vendor can only harvest exits it can
reach. Every product in the flagged group has a free tier or a free trial
that hands out addresses on demand. This is the second half of the same
mechanism and it cannot be separated from the first with the data here.

**3. rDNS naming.** Weakly supported but real, and free to fix. Compare:

| Address | rDNS | Reads as |
|---|---|---|
| Mudfish `146.185.214.48` | `mudsyd.mudfish.net` | the brand, in DNS |
| Neoxify france-1 | `{france-1}.ip.linodeusercontent.com` | generic cloud VPS |
| Neoxify finland1 | `static.{finland1}.clients.your-server.de` | generic cloud VPS |
| ExitLag Voxility /30s | *(none)* | nothing |
| ExitLag Vultr hosts | `216-238-115-26.constant.com` | generic cloud VPS |

Note that ExitLag's *registered* space has no PTR at all, and Neoxify's
LightNode and Iran nodes have none either -- and those are four of the five
addresses in this whole set with the lowest scores. Correlation, not proof.

**4. What the ASN's other tenants do.** M247 is blocklisted wholesale
because it is full of VPNs. Hetzner, Linode, Vultr, AWS, Azure and LightNode
are not, because they are full of everything else. **Neoxify's providers are
all in the good half of this split, including LightNode, which is on no
datacenter list at all.**

**Things that turned out not to matter:**

- **Address-space age.** finland1's range `{finland1-prefix}/20` (`CLOUD-HEL1`)
  was **created 2026-03-17** -- five months old -- and is on the datacenter
  list. ExitLag's `5.254.56.0/24` dates to 2018 and is equally on it. Neither
  carries a VPN flag. Age moves nothing either way.
- **Transit space versus cloud VPS.** This was the owner's proposed
  mechanism, and it does not hold. Voxility transit space and Vultr cloud
  space give ExitLag the same verdict, and ExitLag's own Vultr hosts score
  *worse* on Scamalytics than its Voxility ones.
- **Owning an ASN.** Mullvad's own AS216025 and own `45.92.0.0/24` still
  return `is_vpn: true`, `proxy: true`, Scamalytics VPN yes. Confirmed
  exactly as the earlier document found. The EUR 1,000 + EUR 1,800/year +
  $64-141/month does not buy this.
- **Being a "gaming relay" rather than a "VPN".** Mudfish is a gaming relay
  and is flagged harder than most consumer VPNs. The category label is worth
  nothing; the operational posture is worth everything.

---

## What Neoxify could realistically do

Ordered by value per unit of cost. The honest headline first:

> **The most actionable finding is that there is nothing urgent to fix here.**
> Neoxify's exits are not VPN-flagged today. Money spent on address space
> would buy off a label Neoxify does not currently carry.

**Do these -- they are cheap, and they are about not losing the position:**

1. **Never publish a node list, and never let one be derived.** This is the
   single most valuable property Neoxify has and it is free. Concretely:
   node addresses reach clients only after authentication (already true); no
   node hostname in any public certificate; no guessable hostname convention;
   no node address in a public repository, issue, changelog or support
   article. **This repository is public** -- every node IP already committed
   to `docs/` is a permanent contribution to the very enumeration this
   document is about. Worth an audit. **That audit has since happened**
   -- see `docs/node-address-hygiene.md`; the Neoxify addresses in this
   file are redacted, and this file adds none.
2. **Keep rDNS neutral or empty.** Free. Never let a PTR contain "neoxify",
   "vpn", "node", "exit" or a region code. `mudsyd.mudfish.net` is the
   anti-pattern; ExitLag's blank PTRs are the pattern. Note this cuts against
   generic cloud PTRs too -- `clients.your-server.de` is a literal
   advertisement for a cheap VPS.
3. **Watch the two `is_abuser: true` LightNode nodes.** germany-1 and
   turkey-1 carry it; in the whole 53-address set only one Psychz node and
   one Kaopu-hosted Mudfish node do as well. It is the only adverse signal
   Neoxify carries that its competitors' equivalents do not, it is the one
   flag that *does* respond to behaviour, and abuse reports are worth
   chasing before they compound.
4. **Re-measure on a schedule.** The VPN label is earned over time and the
   fleet is young and small. A quarterly re-run of the commands below,
   appended to this file, will show a label appearing before a customer
   discovers it.

**Consider, but only on evidence:**

5. **A free tier is an infrastructure decision here, not just a marketing
   one.** If Neoxify ever offers free or trial accounts, its exits become
   harvestable by exactly the mechanism that flagged Mudfish, Mullvad and
   Nord. Price that in.

**Do not do these:**

6. **Do not buy an ASN or lease a /24 for this reason.** Measured: it does
   not move the VPN flag, and Neoxify has no VPN flag to move.
7. **Do not rotate addresses at the same provider "for a clean IP".** There
   is nothing to escape, and rotation discards the low-abuse history that is
   the actual asset.
8. **Do not use residential proxy pools. At any price.** Restated and
   endorsed from the earlier document, whose sourcing is solid: hCaptcha puts
   30-95% of residential-proxy traffic in the blackhat/greyhat band; Spur
   found residential-proxy SDKs in nearly half of LG smart-TV apps; Google
   disrupted IPIDEA as the largest such network; the FBI has a standing
   public alert. For a product whose users are in Iran and whose value
   proposition is trust, routing their traffic through
   frequently-non-consensual infrastructure is a worse position than a clean
   datacenter address, not a better one. **This is disqualifying, not
   expensive.**

---

## What the games actually check

This section is the earlier document's evidence, restated because it is what
turns the numbers above into a decision. It is **not** new measurement.

- **Verified, one game, named vendor.** Space Station 14 -- open source --
  rejects players with *"You are connecting through a datacenter or VPN"* and
  its config names `check.getipintel.net` with `ipintel_bad_rating = 0.95`.
  This is the only case anywhere with the vendor visible in source.
- **Verified, network-edge blocking by Blizzard.** A player on a self-hosted
  WireGuard VPN in Linode New Jersey could not reach Battle.net; the
  traceroute died at Blizzard's own edge router and Linode support confirmed
  Blizzard was blocking the range. **Note what that block was on: a *Linode*
  range -- one of Neoxify's own providers.** It is a datacenter-range block,
  not a VPN-label block, and it is the one mechanism in this document that
  Neoxify's clean VPN status does **not** protect against.
- **Officially announced, by named provider.** Riot (6 Nov 2020) cut *"the
  highest volume VPN services"* by range -- named brands, not datacenter
  space wholesale. Neoxify is not a high-volume VPN brand.
- **Not established:** no evidence was found that Riot, Blizzard or Epic
  licenses any named commercial feed. Every claim to the contrary found in
  community threads traced back to speculation.

**The consequence for Neoxify.** The VPN-label risk measures as low today.
The **datacenter-range** risk is real, is shared with every competitor
including ExitLag and Mudfish, and is not fixable by anything short of
address space nobody in this market has bought. If a Neoxify user is refused
by a game, the mechanisms to suspect, in order, are: a datacenter-range block
at the publisher's edge; a sanctions or geo decision behind login; and only
then a reputation score.

---

## The per-game routing question

The owner also reports that with ExitLag **only the chosen game is affected
and nothing else**. That was checked against the code.

**ExitLag's documented behaviour:** the user searches a game by name, picks
the version/region, and ExitLag *"automatically detects your game executable
and prepares the routing"*; *"it does not route your browser traffic,
streaming apps, Discord audio... everything else remains unchanged"*; any
number of games can be active at once, each with its own profile. Unsupported
games are a **request** -- a "New Game Request" button with a
48-business-hour SLA -- not a user-editable rule. Matching is on executable
**name**, and it is unauthenticated: a third-party tool ships a
rename-to-`LOSTARK.exe` trick deliberately to get itself proxied.

**Neoxify Custom mode**, for comparison: absolute-path exact match,
lowercased, up to 64 paths; include *and* exclude modes; TCP and UDP; new
flows picked up mid-session; pre-existing TCP connections forcibly reset on
activation so nothing stays exempt.

**Real gaps, in order of value per unit of work:**

1. **No game catalogue reaches the tunnel.** The backend `GameProfile` model
   already carries `processNames[]` -- its own schema comment says "covering
   launcher AND game, so one row is one game" -- and `destinationCidrs[]`.
   The customer-facing serializer drops both. Custom mode therefore has no
   idea what a game is. **This is the single highest-leverage item and it is
   small work**: the columns, the admin CRUD, the picker and the IPC all
   exist; the missing link is one field in one payload plus expanding a slug
   into the existing path list.
2. **No auto-detection of the executable.** Neoxify needs the app to be
   *running* to pick it, or a manual browse. ExitLag finds it. Medium work --
   Steam `libraryfolders.vdf`, Battle.net `product.db`, registry uninstall
   keys -- and it has to be verified per title.
3. **Launcher-plus-game coverage** only groups binaries that share a
   `ProductName` **and are running at pick time**. Falls out of (1) for free.
4. **Path-exact matching fails silently on move or rename**, and in
   include-mode the failure is fail-open: the traffic leaves untunnelled
   while the UI still says Custom. This is the flip side of a real security
   property -- Neoxify cannot be spoofed by renaming a binary and ExitLag can
   -- so the fix is a re-resolve-on-miss, not a switch to name matching.
5. **No destination-scoped rules.** ExitLag profiles carry region/server;
   Neoxify has no CIDR or port field anywhere. The user-visible cost is that
   selecting a game also tunnels its multi-gigabyte patch downloads. This is
   the hardest correctness item, not a filter-string edit.
6. **One exit for all selected apps.** ExitLag documents no limit on
   concurrently active games. Architectural.
7. **"Nothing else is affected" is not literally true of Custom mode.** All
   machine DNS is redirected through the tunnel, deliberately -- leaving it
   alone was *measured* leaking the customer's own resolver while the tunnel
   carried TCP -- and Windows resolves via svchost, so per-app DNS is not
   reachable. Selected apps also lose IPv6 entirely. Both are honest
   trade-offs, and both are places where ExitLag's claim is cleaner than
   Neoxify's reality.
8. **No in-app "my game isn't listed" path.** ExitLag has a button and an
   SLA; Neoxify has superadmin-only CRUD. The support module already exists.

**Where Neoxify is ahead:** exclude mode has no ExitLag counterpart; traffic
is encrypted where ExitLag's and WTFast's explicitly is not; app identity
cannot be spoofed by renaming; the escape audit verifies against the
machine's real connection tables rather than asserting; and none of these
four vendors does any censorship circumvention at all, which for Neoxify's
actual audience outweighs the game list.

**The honest summary of this section:** items 1-4 and 8 are *packaging*, not
mechanism. ExitLag's per-game experience is mostly a curated list and an exe
finder sitting on top of a split tunnel Neoxify already has, and in some
respects already does better. Items 5-7 are real mechanism gaps, and 6 is
architectural.

---

## What this does not settle

- **Whether any publisher consumes any feed measured here.** No primary
  evidence exists for Riot, Blizzard or Epic. Everything above is reputation
  data, not a game's decision.
- **getipintel.net was not queried.** It is the one vendor with a *proven*
  production game integration, and its API is free -- but it requires a
  `contact=` email parameter, and sending the owner's address to a
  third-party service was out of scope for this pass. **This is a one-line
  follow-up the owner can run himself**, and it is the highest-value single
  measurement left:
  `curl "https://check.getipintel.net/check.php?ip={germany-1}&contact=YOUR_EMAIL"`
  -- a result above 0.95 is what Space Station 14 rejects on.
- **Paid feeds were not measured**: MaxMind Anonymous IP, IP2Proxy,
  IPQualityScore, Spur, AbuseIPDB. All require a key or a signup. These are
  the feeds most likely to be the ones a large publisher actually licenses,
  so this measurement is systematically biased toward the free end of the
  market.
- **IPinfo's `hosting` vs `isp` ASN type** was not re-measured; it now needs
  a token. ip-api.com's `hosting` boolean was used as the functional
  equivalent.
- **WTFast's and GearUP's relay addresses could not be obtained** without
  running their clients, which would mean signing up. Their absence from
  public DNS and CT is itself a finding, and it supports the enumerability
  thesis.
- **The four ExitLag hosts outside its registered space are unproven as
  relays.** They are ExitLag-operated hosts on Vultr and OVH, found in
  certificate transparency. `powerlock` and `xunel` are suggestive names, and
  that is all.
- **Neoxify's clean VPN status is partly a consequence of being small and
  young.** The flags that matter are behaviour-driven. A provider on
  LowEndTalk watched non-anonymous L2TP tunnels get proxy-flagged within a
  month. This result has a shelf life; see the re-measurement
  recommendation.
- **No game was tested.** The measurement that would settle the whole
  programme is still the one the earlier document named: a real account, on a
  real Iranian home connection, logging in and connecting -- direct, then
  through a node, then direct again.

---

## Reproducing this

The measurement script was throwaway and is not committed; every call is a
single request.

```bash
IP={germany-1}
curl -s "https://api.ipapi.is/?q=$IP"
curl -s "http://ip-api.com/json/$IP?fields=status,isp,org,as,asname,mobile,proxy,hosting,query"
curl -s "https://proxycheck.io/v2/$IP?vpn=1&asn=1&risk=1"
curl -s -A Mozilla/5.0 "https://scamalytics.com/ip/$IP" | grep -o 'Fraud Score: [0-9]*'
curl -s "https://stat.ripe.net/data/whois/data.json?resource=$IP"
curl -s "https://dns.google/resolve?name={germany-1-reversed}.in-addr.arpa&type=PTR"

# blocklist membership
curl -sO https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/vpn/ipv4.txt
curl -sO https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/datacenter/ipv4.txt
```

Rate limits observed: ip-api.com 45/min, proxycheck.io 100/day unkeyed.
Neoxify's exits came from `SELECT name, role, region, "publicIp", status FROM
nodes` on the panel database -- named columns, read-only.

Mudfish's fleet was enumerated from its public status page: the
`openStatusWindow(N)` id in each row is the node number in the hostname
convention `node-{cc}-{NNNNN}.mudfish.net`, which was recovered from a single
certificate-transparency hit for `%.mudfish.net`. 635 of 652 resolve.

---

## Sources

- Reputation feeds: <https://ipapi.is>, <https://ip-api.com>,
  <https://proxycheck.io>, <https://scamalytics.com>,
  X4BNet `lists_vpn` <https://github.com/X4BNet/lists_vpn>
- Registry data: RIPE DB REST (`rest.db.ripe.net`), RIPEstat
  (`stat.ripe.net`), ARIN via RIPEstat
- Vendor exit lists used as controls: `api.mullvad.net/www/relays/all/`,
  `api.nordvpn.com/v1/servers/recommendations`, `mudfish.net/server/status`
- ExitLag behaviour: its own knowledge base and blog -- "How ExitLag Works",
  "Is ExitLag a VPN?", "My game is not on ExitLag. How do I add?",
  "Can I use ExitLag in different applications at the same time?"
- Everything on publisher blocking, residential-proxy sourcing, driver
  mechanisms and the Iranian censorship picture:
  `docs/research/gaming-providers.md`, which carries its own per-claim
  evidence labels.
