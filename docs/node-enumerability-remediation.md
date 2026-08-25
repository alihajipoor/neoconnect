# Node enumerability: remediation runbook

**Status: a plan, not a change.** Nothing in this file has been executed.
No certificate, DNS record, node configuration or provider setting was
touched in writing it. Every command below is for the owner to run, in
the order he chooses, after reading the risk notes.

The companion documents are `docs/node-address-hygiene.md` (the
repository half, already applied) and
`docs/research/gaming-ip-reputation.md` (the measurement this rests on).

---

## The problem in one paragraph

Certificate transparency is an append-only public log of every TLS
certificate ever issued. This project issues one Let's Encrypt
certificate per node, named after that node. So a query for
`%.neoxify.site` on `crt.sh` returns the fleet's hostnames, each resolves
to an address in DNS, and the whole exit list falls out in seconds, for
free, with no account and no probing. That is precisely the technique the
research document used to enumerate Mudfish's 635 nodes — and
enumerability is the variable that the measurement identified as
*causing* the `is_vpn` reputation label. The mechanism that flags an
operator is fully in place here. The fleet has simply not been scraped
yet.

**This was already known.** `docs/detection-resistance.md` §"Open, and
needing a live test or an owner decision" item 1, and the matching entry
in `docs/journal/windows.md`, both record CT exposure as an open owner
decision, with "unrelated domains per node, or a wildcard issued by
DNS-01" as the candidate fixes. What is new is the second consequence:
it is not only about someone blocking the addresses in bulk, it is about
earning a reputation label that no amount of address-space spending
removes.

## What is irreversible, stated plainly

**Certificates already logged cannot be withdrawn.** CT logs are
append-only by design; that is the entire point of them. `de1`, `fr1`,
`fi1`, `tr1`, `sg1`, `ir1` and `connect` under `neoxify.site` are in
public logs permanently. Revoking the certificates does not remove the
log entries. Deleting the DNS records does not remove the log entries.

Therefore:

- A wildcard certificate stops **new** node names from entering CT. It
  does nothing about the six already there.
- The only thing that helps the six is making those names stop being
  *useful* — i.e. renaming the nodes, or renumbering them, so that the
  logged names no longer resolve to a live exit.
- Everything below should be read with that split in mind: **cheap work
  protects future nodes; protecting today's fleet costs a migration.**

---

## How certificates are issued today

Grounded in the installer source, not assumed.

| Where | Command | Challenge |
|---|---|---|
| `installer/lib/panel.sh:129` | `certbot --nginx -d "$domain" …` | HTTP-01 via the nginx plugin |
| `installer/lib/agent.sh:846` | `certbot certonly --standalone` or `--webroot -w /var/www/html -d "$domain"` | HTTP-01 |
| `installer/lib/agent.sh:2739,2746` | same, plus `--cert-name` and `--key-type rsa` for IKEv2 | HTTP-01 |

Facts that constrain every option below:

1. **Every invocation passes exactly one `-d`.** There is no SAN list, no
   `--domains`, no wildcard anywhere in the tree.
2. **The name is typed by the operator at install time**
   (`agent.sh:1749` "Domain for the certificate", `agent.sh:2666` "DNS
   name clients will connect to (must resolve to this node)"). It is not
   derived from the panel database — `model Node` in
   `apps/backend/prisma/schema.prisma` has `publicIp` and **no hostname
   column at all**. The hostname reaches the database afterwards, as a
   `ProtocolConfig` param (`serverName` / `endpointHost`).
3. **There is no DNS-provider integration of any kind in this
   repository.** No `certbot-dns-*` plugin, no API token handling, no
   credentials file. A grep for `dns-cloudflare|credentials.ini|--dns-`
   returns nothing.
4. **Port 80 is deliberately open on every node and stays open**, because
   HTTP-01 needs it at every renewal, not just at issuance
   (`agent.sh:513-525`, `541-614`: *"This location is the reason port 80
   stays open at all."*). The stated consequence of losing it is that
   Xray fails its whole configuration on an unreadable certificate and
   the node drops every TLS inbound at once, about ninety days later.
5. **Renewal relies on the distro's `certbot.timer`**; this repository
   installs deploy hooks, not timers. Xray is deliberately *not*
   restarted on renewal (a restart strips every hot-added inbound, user
   and relay route); it re-reads the certificate files itself.
6. **The DNS zone is almost certainly on Cloudflare** — inferred, not
   stated in the repo: `connect.neoxify.site` is described as
   Cloudflare-proxied in several places, and orange-cloud proxying
   requires Cloudflare-hosted DNS. **Verify this before planning any
   DNS-01 work**; the whole of step 3 below depends on it.

## Which protocols actually need a certificate

This is what decides how much of the problem is even reachable.

| Protocol | Needs our certificate? | Needs a public A record? |
|---|---|---|
| VLESS + REALITY | **No** — borrows the decoy site's certificate | No |
| Shadowsocks 2022 | No | No |
| WireGuard | No | Only if the endpoint is written as a hostname |
| OpenVPN | No | Only if the endpoint is written as a hostname |
| VLESS + TLS, VLESS + TLS over WS, Trojan + TLS | **Yes** | See below |
| IKEv2 (strongSwan) | **Yes**, and RSA specifically | **Yes, unavoidably** |

**A node running only REALITY, Shadowsocks, WireGuard and OpenVPN needs
no certificate and therefore never appears in CT.** That is a real lever
and it costs nothing to use on the next node built.

## Do the per-node hostnames need to resolve publicly?

Answered from the code, per consumer.

- **Xray TLS trio — no, the client never resolves them.** The
  customer-facing payload sets `connection.host` to `node.publicIp`
  (`apps/backend/src/modules/protocol-users/protocol-users.service.ts`,
  `connectionInfo`). The hostname travels separately as
  `publicParams.serverName` and is used only as the SNI string and the
  certificate name to verify. A name that stops resolving is still a
  perfectly good SNI. **The only thing that needs the A record is
  certbot's HTTP-01 challenge at every renewal** — which DNS-01 removes.
- **IKEv2 — yes, hard requirement.** The Windows and Android clients
  dial `publicParams.endpointHost` by name and *refuse* to substitute the
  IP, because the OS validates the server certificate against the name it
  dialled. Removing the A record breaks IKEv2 on that node and no
  server-side change fixes it.
- **The node API mirrors — yes.** `apps/desktop-windows/src/lib/config.ts`
  hardcodes `https://fi1.neoxify.site:2053/api` and the `fr1` equivalent
  as the censorship fallbacks used when `connect.neoxify.site` is
  blocked, and they are compiled into every shipped build. Additional
  mirrors are derived at runtime from any TLS `serverName` in the cached
  credential snapshot, so the mirror *set* is updatable server-side —
  but those two names are permanent in every already-installed client.
  The bare IP cannot be substituted: it would fail the certificate name
  check before reaching nginx.
- **Gaming-mode DoH — yes if used.** `GamingResolver.dohHost` is a
  database column rendered into the DoH URL. No node has one provisioned
  today, so this is a future constraint, not a current one.
- **WireGuard / OpenVPN — only where the endpoint was written as a
  hostname.** At least one was (the Android main-thread DNS failure was
  a hostname-form France endpoint). These are rewritable server-side
  into already-issued credentials.
- **The Go agent — no.** It dials *outbound* to the panel; the panel
  never resolves a node hostname.
- **The panel — no.** It stores and displays `publicIp`; it edits
  `serverName` as text.

**Conclusion:** hostnames must keep resolving for any node that serves
IKEv2 or acts as an API mirror. For a node serving only the Xray TLS
trio, the public A record exists *solely* to satisfy HTTP-01, and moving
that node to DNS-01 would let its name stop resolving entirely — which
is strictly better than a wildcard, because an unresolvable name is not
an exit even to someone reading the CT log.

---

## The plan, ordered by value per unit of risk

> **Risk key.**
> 🟢 cannot disconnect a live user.
> 🟡 can disconnect users if done carelessly; sequencing matters.
> 🔴 will disconnect users, or break already-installed clients, unless
> carefully staged.

### 1. 🟢 rDNS hygiene — free, immediate, no user impact

PTR records are not in any packet path; changing one cannot drop a
connection.

Current state, from the measurement:

| Node | PTR today |
|---|---|
| finland1 (Hetzner) | `static.<addr>.clients.your-server.de` |
| france-1, singapore-1 (Linode) | `<addr>.ip.linodeusercontent.com` |
| germany-1, turkey-1 (LightNode) | none |
| ir1 (Vunify) | none |

The report's recommendation is **empty, not branded, and not a generic
provider default** — `clients.your-server.de` is a legible
advertisement for a cheap VPS, and the addresses with no PTR at all were
among the lowest-scoring in the whole 53-address set. Set the reverse
record to empty:

- **Hetzner**: Cloud Console → Server → Networking → Reverse DNS → clear
  the value. (Hetzner may refuse a fully empty PTR; if so, leave it
  rather than inventing a name — an invented name is worse than a
  generic one if it hints at the product.)
- **Linode/Akamai**: Cloud Manager → Linode → Network → Reverse DNS →
  remove. Linode requires a matching forward record to *set* a PTR, so
  clearing is the only option that does not create a new public name.

**Never** let a PTR contain `neoxify`, `vpn`, `node`, `exit`, `relay` or
a region code. `mudsyd.mudfish.net` is the anti-pattern and it sits on
one of the most heavily flagged addresses in the sample.

### 2. 🟢 Stop the bleeding in the repository — already done

`docs/node-address-hygiene.md`. Applied in the working tree. Note its own
honesty section: git history still contains the old values and the
repository is public, so this reduces future scraping surface and
un-publishes nothing.

### 3. 🟢 Build the next node with no certificate at all

Before any migration work, change the default for *new* nodes: install
with REALITY + Shadowsocks + WireGuard + OpenVPN, decline the "Domain
for the certificate" prompt (`agent.sh:1749` — an empty answer skips
VLESS+TLS, VLESS-over-WS and Trojan by design), and skip IKEv2. That node
never enters CT, never needs an A record, and never needs port 80.

The cost is stated plainly rather than hidden: **that node loses four
transports, including the two that survive the most aggressive DPI.**
Per the project's own rule, a protocol gap is a gap to state, not a
decision to make quietly. This is a reasonable default for an *additional*
exit in a permissive region; it is not acceptable for a node that Iranian
users depend on.

### 4. 🟢 Investigate the two `is_abuser` flags

germany-1 and turkey-1, both LightNode (AS154177), both flagged
`is_abuser: true` by ipapi.is. In the full 53-address sample only two
other addresses carry it. It is the one adverse signal Neoxify carries
that its competitors' equivalents do not, and — unlike `is_datacenter` —
it is behaviour-driven, so it responds to being fixed.

What to do, in order:

1. Confirm the flag is still live and check whether it is address-wide or
   range-wide. The control `38.60.249.1` — a different address in
   germany-1's `/24` — also returned `is_abuser: true`, which points at
   the *range*, not at Neoxify's traffic. Re-check that control first;
   if the whole `/24` is flagged, this is LightNode's problem and
   chasing our own traffic is wasted effort.
2. Check the free abuse feeds for the two addresses (AbuseIPDB's public
   page needs no key to read; Spamhaus and Barracuda have public lookup
   forms).
3. Only then contact LightNode support. The question to ask is narrow:
   *"Is there an open abuse complaint against this address or its range,
   and if so what was reported and when?"* Do not volunteer that the host
   runs a VPN.
4. If reports exist and originate from our customers' traffic, the
   answer is egress rate-limiting or outbound port policy on the node,
   which is 🟡 work and needs its own plan.

**Do not** rotate the addresses to escape the flag. The measurement is
explicit that rotation discards low-abuse history, which is the actual
asset, and buys nothing on a range-wide flag.

### 5. 🟡 Wildcard certificate for `*.neoxify.site`

This is the main mitigation for *future* exposure, and it is the step
with the most hidden complexity.

**Let's Encrypt issues wildcards only via DNS-01.** There is no HTTP-01
path to a wildcard; this is a CA policy, not a certbot limitation. So
this step is not "add a flag", it is "introduce a DNS-01 capability this
project does not currently have anywhere."

**Three ways to do it, and the choice matters more than the commands:**

**(a) Issue centrally, distribute the key.** One host — most naturally
the panel — holds the Cloudflare token, issues `*.neoxify.site`, and the
private key is copied to each node.

```bash
# on the issuing host only
apt-get install -y certbot python3-certbot-dns-cloudflare
install -m 0600 /dev/null /root/.secrets/cloudflare.ini   # token goes here, never in git
certbot certonly \
  --dns-cloudflare --dns-cloudflare-credentials /root/.secrets/cloudflare.ini \
  --dns-cloudflare-propagation-seconds 60 \
  -d 'neoxify.site' -d '*.neoxify.site' \
  --cert-name neoxify-wildcard -m "$LE_EMAIL" --agree-tos --non-interactive
```

> **Risk, and it is the real one:** this puts *the same private key for
> every name under the domain* on six machines, one of which is a relay
> physically located in Iran. Compromise of any single node compromises
> the certificate for `connect.neoxify.site` — the panel, the API,
> billing, the updater. Today, compromising `ir1` costs you `ir1`'s name
> and nothing else. **This is a genuine security downgrade traded for a
> privacy gain, and it should not be waved through.** If this route is
> taken, the panel must keep its own separate single-name certificate and
> the wildcard must be nodes-only — which means the wildcard has to be
> issued for a subdomain, e.g. `*.n.neoxify.site`, not the apex.

**(b) Each node issues its own wildcard.** Requires a zone-scoped
Cloudflare API token on every node. Cloudflare tokens scope to a zone,
not to a record, so every node would hold a token that can rewrite
`connect.neoxify.site`. **Worse than (a). Do not.**

**(c) `_acme-challenge` CNAME delegation (acme-dns).** Each node keeps
its own key and its own certificate, and the zone holds a one-time static
`CNAME _acme-challenge.<name>.neoxify.site → <uuid>.auth.acme-dns.io`.
The node's credential can only write that one challenge record; it cannot
touch the rest of the zone. This is the standard answer to (b)'s problem
and it composes with per-node certificates — but note it does **not**
give you a wildcard, so it solves the "token is too powerful" problem
without solving the CT problem. Useful in combination with §6, not
instead of §5.

**Sequencing so nobody drops.** Whichever route: issue the new
certificate alongside the existing one, verify it on disk, then switch
the paths and let Xray pick them up. Do **not** restart Xray to make it
notice — a restart strips every hot-added inbound, user and relay route,
which is a documented outage mechanism in this project. Xray re-reads
`certificateFile`/`keyFile` from disk on roughly an hourly cycle; the
deploy hook `neoxify-sync-certs` already exists to copy files into
`/usr/local/etc/xray/certs/` with the ownership Xray needs.

**Also fix while you are in there:** `origin.neoxify.site` is an existing
open item — the panel's certificate carries `DNS:connect.neoxify.site`
and no SAN for it, which is why the API-mirror `X-Forwarded-For` fix
stalled. A wildcard covering the panel names would close that. Weigh it
against the key-distribution risk above; it is a nice-to-have, not a
reason.

**What this step buys, precisely:** node number seven onwards never
appears in CT. Nodes one to six are unaffected — their names are logged
forever. If that is all you do, the exposure is frozen, not reduced.

### 6. 🔴 Unguessable names, and/or a domain not linked to the brand

`de1/fr1/fi1/tr1/sg1/ir1` is a convention a person guesses in one
attempt. So even behind a wildcard, if the names still resolve, a
dictionary of two-letter country codes plus a digit enumerates the fleet
without CT at all. Mudfish's `node-{cc}-{NNNNN}` convention is the same
mistake at larger scale, and it is how the research document obtained
635 addresses.

**Unguessable labels under the same domain** — e.g.
`k7f2qm9x.n.neoxify.site` — defeat both CT (behind the wildcard) and
brute force. Migration cost, honestly:

- New certificate for the new name must exist *before* anything points at
  it. Under a wildcard this is free.
- `serverName` and `endpointHost` are `ProtocolConfig` params in the
  database, so changing them is a panel edit, not a client release.
  Clients pick up the new snapshot within the credential cache TTL
  (10 minutes).
- **IKEv2 clients hold an OS-level VPN profile naming the old host.**
  Changing `endpointHost` does not rewrite a profile Windows or Android
  already saved. Expect IKEv2 users to need to reconnect, and verify what
  the client does with a changed host before touching a live node.
- **The two hardcoded API mirrors cannot be renamed.**
  `fi1.neoxify.site` and `fr1.neoxify.site` are compiled into every
  shipped client. If those names stop resolving, the first-install-in-Iran
  fallback is gone for every existing installation, permanently, because
  those users are precisely the ones who cannot reach the panel to
  update. **Keep the old names resolving and serving alongside the new
  ones.** They are already burned in CT, so keeping them costs nothing
  extra — but it also means those two exits stay enumerable forever.
- Old A records should be *removed* once nothing uses them, otherwise the
  CT entries stay live and the whole exercise is decorative.

**A separate, unbranded domain** (GearUP's approach — six unbranded
infrastructure domains whose only tie to the brand is a shared
certificate) is strictly stronger: it breaks the link from the brand to
the fleet, so an analyst who knows about Neoxify cannot pivot to the
nodes at all. Additional cost on top of the above, and this one is the
expensive part:

- **`apps/desktop-windows/src-tauri/capabilities/default.json` allows
  HTTP only to `https://*.neoxify.site`.** A mirror on a different domain
  is blocked by the Tauri capability system in every already-installed
  client. Same file exists for mobile. **This requires a client release,
  and already-installed clients that cannot reach the panel to update are
  exactly the users the mirrors exist for.** There is no server-side fix.
- A second domain must not be registered with the same registrant
  details, same registrar account, same nameservers or same
  registration date as `neoxify.site`, or the link is trivially
  recovered from WHOIS and passive DNS and the money is wasted.

**Recommendation:** unguessable labels under `*.n.neoxify.site` for new
nodes, immediately after §5. Treat the separate domain as a decision to
revisit if a node is ever actually blocked in bulk — the client-release
requirement makes it a poor emergency response, which is an argument for
doing it early, but the measurement gives no evidence that it is needed
today.

### 7. 🟢 Quarterly re-measurement

The measurement has a shelf life. The flags that matter are
behaviour-driven, the fleet is young and small, and the report cites a
provider whose non-anonymous tunnels were proxy-flagged within a month.
A quarterly run shows a label appearing before a customer discovers it.

Take the addresses from the panel database, named columns only:

```sql
SELECT name, role, region, "publicIp", status FROM nodes;
```

Then, per address:

```bash
IP=<node address>          # never paste a real one into this repository
curl -s "https://api.ipapi.is/?q=$IP"                     # is_vpn, is_proxy, is_abuser
curl -s "http://ip-api.com/json/$IP?fields=proxy,hosting,as,asname"
curl -s "https://proxycheck.io/v2/$IP?vpn=1&asn=1&risk=1"
curl -s -A Mozilla/5.0 "https://scamalytics.com/ip/$IP" | grep -o 'Fraud Score: [0-9]*'
curl -s "https://dns.google/resolve?name=$(echo $IP | awk -F. '{print $4"."$3"."$2"."$1}').in-addr.arpa&type=PTR"
```

And the blocklist membership check, which is free and local:

```bash
curl -sO https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/vpn/ipv4.txt
curl -sO https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/datacenter/ipv4.txt
```

Rate limits: ip-api.com 45/min, proxycheck.io 100/day unkeyed.

**The two numbers to watch**, because they are the ones that can change:
`is_vpn` / `proxy` moving to true on any node, and `is_abuser` appearing
on a node that did not have it. `is_datacenter` is permanent and not
worth tracking.

**And the one-line check nobody has run yet.** The report flags
getipintel.net as the highest-value single measurement left — it is the
only vendor with a *proven* production game integration, and its API is
free, but it requires an email address as a query parameter:

```bash
curl "https://check.getipintel.net/check.php?ip=<node address>&contact=<your email>"
```

A result above 0.95 is the threshold Space Station 14 rejects on. This is
the owner's to run, because it means handing his address to a third
party.

**Also re-run the enumerability check itself**, which is the thing this
document exists about:

```bash
curl -s 'https://crt.sh/?q=%25.neoxify.site&output=json' | \
  python -c "import json,sys; print(sorted({e['common_name'] for e in json.load(sys.stdin)}))"
```

If that list grows, a certificate was issued outside the wildcard and the
policy has leaked.

---

## Headline recommendation

**Do §1, §2 and §4 now — they are free, they cannot disconnect anyone,
and §1 is the only item in the whole document with a measured
correlation behind it that costs nothing.**

**Then §5 (wildcard) with route (a) restricted to a `*.n.neoxify.site`
subdomain, keeping the panel's certificate separate**, followed
immediately by §6's unguessable labels for new nodes.

The single most important sentence: **a wildcard freezes the exposure, it
does not reduce it.** The six names already in CT are permanent, and the
two that are compiled into every shipped client can never be retired
without abandoning the censorship fallback for the users who most need
it. Anyone who reads "we moved to a wildcard" as "the fleet is no longer
enumerable" has been misled.

The risk that most deserves the owner's attention is not any of the
enumeration ones — it is that the obvious implementation of the wildcard
puts the panel's private key on a box in Iran.
