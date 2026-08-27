# Node enumerability: remediation runbook

**Status: still not executed on production.** No certificate, DNS record,
node configuration or provider setting has been changed. What *has*
changed since this file was first written is that the plan below was
checked against the running fleet, and several of its premises turned out
to be wrong. **Read "Measured state" first — it overrides the sections
below wherever the two disagree.**

The companion documents are `docs/node-address-hygiene.md` (the
repository half, already applied) and
`docs/research/gaming-ip-reputation.md` (the measurement this rests on).

---

## Measured state (2026-08-26)

Everything in this section was observed, not inferred. Method: Cert
Spotter and crt.sh for the CT logs, Google DoH for resolution and PTR,
passive TLS handshakes for what is actually served, and read-only SSH to
the five reachable nodes for what is actually installed. Nothing was
written, restarted or reconfigured.

### 1. The DNS provider is confirmed, and it is not one provider

The runbook guessed "almost certainly Cloudflare". Verified:

| Zone | Authoritative NS | DNS-01 usable? |
|---|---|---|
| `neoxify.site` | `beth`/`dimitris.ns.cloudflare.com` | **Yes** — `certbot-dns-cloudflare` |
| `neoxify.com` | `dns1`/`dns2.registrar-servers.com` (Namecheap) | Awkward; no first-class certbot plugin |
| `neoxify.net` | Namecheap, as above | n/a — no node names |

All node names live under `neoxify.site`, so the Cloudflare path is the
one that matters and DNS-01 is available.

### 2. The exposure spans two domains, not one

CT holds **25 distinct names** across the two domains. The node-shaped
ones:

- `neoxify.site`: `de1`, `fi1`, `fr1`, `ir1`, `sg1`, `tr1` — all six
  resolve to live exits.
- `neoxify.com`: `fi1`, `fr1`, `ir1`, `us1` — all four still resolve. The
  `.com` forms of `fi1` and `fr1` resolve to **the same addresses** as
  their `.site` twins; the `.com` forms of `ir1` and `us1` resolve to
  different addresses again. `us1` has no `.site` counterpart at all, so
  it is a node name the `.site`-only query never showed.

So the true count of CT-logged names that resolve to something is ten,
not six. The `.com` half was invisible to anyone who only queried
`%.neoxify.site`.

Addresses are deliberately absent from this section; node hostnames are
written as bare labels per `docs/node-address-hygiene.md`.

### 3. The `*.neoxify.site` wildcard in CT is **not ours**

This looked alarming — a wildcard logged 2026-08-04 while nodes kept
issuing per-node certificates for weeks afterwards. It is benign:

```
connect.neoxify.site  ->  issuer: Google Trust Services WE1
                          subject: CN=neoxify.site
                          SAN: neoxify.site, *.neoxify.site
```

That is **Cloudflare Universal SSL**, issued automatically by Cloudflare
for the proxied zone and terminated at Cloudflare's edge. Its private key
has never been on a Neoxify machine. Confirmed from the other direction
too: `ls /etc/letsencrypt/live/` on every reachable node returns only
that node's own single-name certificate, and no node holds a certificate
with a wildcard SAN.

**The key-distribution trap this document warns about has not been
sprung.** Compromising `ir1` today still costs you `ir1` and nothing
else.

Note also that `*.neoxify.site` would not help a node even if we held it:
a wildcard matches exactly one label, so it covers `{node}.neoxify.site`
but not `{node}.n.neoxify.site`. A nodes-only wildcard has to be issued
separately regardless.

### 4. Every node runs IKEv2 — which invalidates the cheerful path

The runbook's most load-bearing claim is that a node serving only the
Xray TLS trio needs its A record *solely* for HTTP-01, so DNS-01 would
let the name stop resolving. The code half of that is correct and was
re-proven (see "Do the per-node hostnames need to resolve publicly?").
The practical half is not, because **there is no such node**:

| Node | strongSwan | Certificate key type | Reading |
|---|---|---|---|
| `fi1` | active | RSA | IKEv2 |
| `fr1` | active | RSA | IKEv2 |
| `ir1` | active | RSA (`ir1-ikev2`) + ECDSA | IKEv2, two certificates |
| `sg1` | active | RSA | IKEv2 |
| `tr1` | active | RSA | IKEv2 |
| `de1` | not reachable by SSH | RSA (observed over TLS) | IKEv2 inferred |

The key type is the tell: `issue_tls_certificate` lets certbot default to
ECDSA, and only the IKEv2 path passes `--key-type rsa`. An RSA leaf on
port 2053 means the IKEv2 installer reissued that name. `de1` is
therefore almost certainly an IKEv2 node too, though that is inference
rather than a login.

**Consequence: not one current node can stop resolving.** IKEv2 clients
dial `endpointHost` by name and refuse an address, so every node's A
record is load-bearing on the client path, not just at renewal time.

### 5. Therefore DNS-01 and the wildcard are not alternatives

The choice as usually posed — "DNS-01 *or* a nodes-only wildcard" — is a
false one:

- **DNS-01 with per-node names does nothing for CT.** The name still goes
  into the log at every issuance. DNS-01 only removes the *A record*
  requirement for renewal — and §4 just established that the A record has
  to stay anyway for IKEv2.
- **A wildcard is the only thing that keeps a node name out of CT**, and
  Let's Encrypt issues wildcards **only** via DNS-01 (CA policy, not a
  certbot limitation).

So DNS-01 is a **prerequisite for** the wildcard, not a substitute for
it. Any plan that adopts DNS-01 and keeps per-node names has spent the
effort and bought nothing.

### 6. The `.com` node names are already broken, and that is an opportunity

This is the one item in the whole document that *reduces* live exposure
rather than freezing it, and it is nearly free:

- the `.com` form of `fi1` serves, on its API-mirror port, a certificate
  named after its `.site` form — and so does `fr1`. **Any client that
  validates the name it dialled already fails against these**, which means
  nothing that works today can be relying on them.
- No node has a `.com` renewal configuration left
  (`ls /etc/letsencrypt/renewal/ | grep neoxify.com` → 0 on all five
  reachable nodes), so those certificates are lapsing on their own and
  will not republish.
- `apps/desktop-windows/src/lib/config.ts` deliberately removed the
  `.com` origin; every shipped API URL is `.site`.
- The Tauri HTTP allowlist in
  `apps/desktop-windows/src-tauri/capabilities/default.json` and its
  mobile twin scope to `https://*.neoxify.site` only — a `.com` mirror is
  refused by the capability system before a request leaves the machine.

**Deleting the four `.com` node A records removes four CT-logged names
from the set that resolves to a live exit, and breaks nothing that
currently works.** It needs Namecheap DNS access, which is the owner's.

### 7. Reputation baseline is clean and was captured

`scripts/check-exit-reputation.py` run 2026-08-26, artifact under
`var/exit-reputation/` (gitignored). Every required feed succeeded;
**no exit is labelled `is_vpn` or `is_proxy` on any feed.** Known adverse
flags unchanged: `ipapi.is:is_abuser` on `de1` and `tr1` (both
AS154177 — see §4 of the plan), `proxycheck.io:proxy` on `fi1`, `fr1`,
`sg1`. PTR state is unchanged from the original measurement: `fi1` still
carries the Hetzner default, `fr1` and `sg1` the Linode default, and
`de1`/`ir1`/`tr1` none.

### 8. What republication actually costs, stated honestly

The framing "the fleet republishes itself to CT every ~90 days" is worth
one correction: re-issuing a certificate for a name **already** in the
log adds no name an enumerator did not have. The six `.site` names are
permanently public whatever happens next.

The residual harm from renewal is second-order but real: a fresh CT entry
is evidence the name is still *live*. A node last certified in June and
never renewed looks decommissioned; one certified last week is obviously
in service. That is a recency signal, not a discovery signal — worth
removing, never worth an outage to remove.

The first-order value is entirely in **node seven onwards**, plus the
`.com` deletion in §6.

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
6. ~~**The DNS zone is almost certainly on Cloudflare** — inferred.~~
   **Verified 2026-08-26: `neoxify.site` is on Cloudflare**
   (`beth`/`dimitris.ns.cloudflare.com`), so `certbot-dns-cloudflare` is
   available. `neoxify.com` and `neoxify.net` are on Namecheap and would
   need a different mechanism — but no node certificate is issued for
   either, so that does not block anything. See "Measured state" §1.

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

> **Correction (2026-08-26).** The paragraph above is correct about the
> code and vacuous about the fleet: **every node currently serves IKEv2**,
> so there is no "node serving only the Xray TLS trio" to apply it to, and
> no current node's A record can be withdrawn. Measured state §4.
>
> The practical reading is the opposite of the one this section invites:
> because the A record must stay anyway, DNS-01 buys nothing *by itself*.
> Its only value here is that it is the required means of obtaining a
> wildcard. Measured state §5.
>
> The clause survives as a design rule for **future** nodes: a node built
> without IKEv2 and without an API-mirror role genuinely can have an
> unresolvable name, and that is the strongest configuration available.

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
   range-wide. The control `{germany-1-neighbour}` — a different address in
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

### 5. 🟡 Wildcard certificate — nodes-only, `*.n.neoxify.site`

> The heading used to read `*.neoxify.site`. That form is **forbidden**:
> issuing the apex wildcard and distributing it is exactly the trap
> described in route (a) below, because it puts the private key for
> `connect.neoxify.site` — panel, API, billing, updater — on every node
> including the relay in Iran. The nodes-only subdomain is the only
> acceptable shape, and the panel keeps its own separate certificate.

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

## The unproven step, which must be tested before the fleet

**Nobody has demonstrated that IKEv2 works with a wildcard certificate,
on either client.** This is the single largest hole in the plan and it
sits directly on the critical path, because §4 of the measured state
established that every node runs IKEv2.

The doubt is specific:

- **Windows** builds its RAS entry with `Add-VpnConnection
  -ServerAddress '<name>'` and the OS validates the server certificate
  against that name. Whether Windows' IKEv2 implementation accepts a
  wildcard SAN — as opposed to TLS, where it plainly does — is not
  something to assume.
- **Android** uses `Ikev2VpnProfile.Builder(server, server)`, where the
  same string is both the server address *and* the remote identity. A
  wildcard leaf whose SAN is `*.n.neoxify.site` has to satisfy an
  identity check for `{node}.n.neoxify.site`. strongSwan's own ID matching
  and Android's platform client do not necessarily agree about that.
- **The key type is a second trap.** Today the IKEv2 installer reissues
  the node's certificate as RSA because Android's IKE library rejects an
  ECDSA-signed AUTH payload. A shared wildcard therefore has to be RSA
  from the start, or IKEv2 breaks fleet-wide the moment it is adopted —
  and it must not be left where the Xray path and the IKEv2 path can
  fight over `--key-type` on the same `--cert-name`.

**Test it on a node with no live IKEv2 users, with a real dial from both
a Windows client and an Android handset, before it goes anywhere near
`ir1`.** A successful `swanctl --load-creds` proves nothing: the failure
mode on record here is Windows silently discarding the IKE_AUTH response
and retransmitting until the SA times out, which surfaces as "terminated
by the remote computer" and points at the wrong thing.

If wildcard IKEv2 turns out not to work, the fallback is a **split**: the
Xray TLS trio moves to the wildcard name and IKEv2 keeps its own
single-name certificate. That leaves IKEv2 nodes in CT — a gap to state
plainly, not to paper over.

## What the owner has to do himself, exactly

Every remaining production step is gated on a credential or a provider
console that an agent session does not have and must not guess at. They
are listed here in the order they should happen, with what each one is
worth.

**A. Delete four DNS records (Namecheap, zone `neoxify.com`).** Remove
the A records for the `.com` forms of `fi1`, `fr1`, `ir1` and `us1`.
Evidence that nothing depends on them is in Measured state §6: they serve
a certificate for a different name, no node renews a `.com` certificate
any more, the shipped clients removed the `.com` origin, and the Tauri
capability allowlist blocks `.com` outright. *Worth: the only available
reduction in the live enumerable set — ten resolving names down to six.*

**B. Clear two-and-a-bit reverse DNS records.** Hetzner Cloud Console →
Server → Networking → Reverse DNS for `fi1`; Linode Cloud Manager →
Network → Reverse DNS for `fr1` and `sg1`. Set empty, do not invent a
name. *Worth: removes the only provider-default PTRs in the fleet; §1 of
the plan, the one item with a measured correlation behind it.*

**C. Create a Cloudflare API token** scoped to `Zone:DNS:Edit` on
`neoxify.site` only, and put it on the node in
`/root/.secrets/cloudflare.ini` at mode 0600. **Never commit it, never
paste it into a chat or an issue.** *This is the credential that blocks
everything below it.*

**D. Create the `n.neoxify.site` delegation and one node's A record.**
Pick an unguessable label — not a country code and a digit. *Worth:
nothing on its own; it is the prerequisite for E.*

**E. Configure and test the wildcard on ONE node, and pick the right
node.** `tr1` is the correct pilot: it is not one of the two hardcoded
API mirrors, so a mistake cannot take out the censorship fallback. Write
`/etc/neoxify/acme.conf` on it (see `installer/lib/agent.sh`), re-run the
certificate menu entry, and then **dial it from a real Windows client and
a real Android handset over IKEv2** before touching anything else. The
IKEv2-with-a-wildcard question above is genuinely open and a `swanctl
--load-creds` that returns 0 does not answer it.

**F. Only then, the rest of the fleet** — and `ir1` last.

Three things to hold on to while doing this:

- **Do not restart Xray to make it notice a new certificate.** It
  re-reads the files from disk; a restart strips every hot-added inbound,
  user and relay route. The `neoxify-sync-certs` deploy hook already
  exists to put the files where Xray can read them.
- **Changing a node's name does not rewrite an IKEv2 profile a client has
  already saved.** Expect existing IKEv2 users to have to reconnect, and
  keep the old name resolving and serving until they have.
- **The old A records have to be deleted at the end**, once nothing uses
  them. Leaving them up means the CT entries still point at live exits
  and the whole migration was decorative.

## Headline recommendation

**Do §1, §2 and §4 now — they are free, they cannot disconnect anyone,
and §1 is the only item in the whole document with a measured
correlation behind it that costs nothing.**

**Add to that: delete the four `.com` node A records** (Measured state
§6). It is the only step available that *reduces* the live enumerable set
instead of freezing it, and the evidence says nothing working depends on
them.

**Then §5 (wildcard) with route (a) restricted to a `*.n.neoxify.site`
subdomain, keeping the panel's certificate separate**, followed
immediately by §6's unguessable labels for new nodes — but not before
the IKEv2 wildcard question above has an answer from a real dial.

The single most important sentence: **a wildcard freezes the exposure, it
does not reduce it.** The six names already in CT are permanent, and the
two that are compiled into every shipped client can never be retired
without abandoning the censorship fallback for the users who most need
it. Anyone who reads "we moved to a wildcard" as "the fleet is no longer
enumerable" has been misled.

The risk that most deserves the owner's attention is not any of the
enumeration ones — it is that the obvious implementation of the wildcard
puts the panel's private key on a box in Iran.
