# Ban safety: every way a player using Neoxify could lose an account

**Why this document is a product requirement and not a note.** The owner,
on why Gaming Mode is being built at all:

> *"the only reason im bringing this game mode to app is to have the same
> thing that exitlag has that wont cause players get banned otherwise this
> tool will be useless and they wont use it anymore."*

So ban-safety **is** the feature. A Gaming Mode that gets accounts banned is
worse than no Gaming Mode, because a player who loses a decade-old account
does not come back and does not stop telling people.

This file is the model: every mechanism that could end with a banned or
blocked player, what evidence stands behind each one, which ones Neoxify
could *create* rather than merely fail to prevent, and the operating rules
that keep the position. It is a design document, not a measurement — the
measurements are `docs/research/gaming-ip-reputation.md` (Neoxify's own
exits, taken 2026-08-25) and `docs/research/gaming-providers.md`.

Companion runbooks: `docs/node-enumerability-remediation.md` (the fix for
the biggest live threat, **unexecuted**) and `docs/node-address-hygiene.md`.

**Evidence levels** are used throughout and mean exactly this:

| | |
|---|---|
| **Verified** | The publisher's own statement, a provider confirming, or reproducible technical evidence in the source. |
| **Corroborated** | Several independent reports of the same symptom. |
| **Single report** | One person, unconfirmed. |
| **Measured** | We measured it ourselves; the numbers are in the research file. |
| **Vendor claim** | A VPN or proxy seller asserting it. Recorded, never counted. |
| **Speculation** | Community guessing with nothing behind it. |

---

## The verdict in six lines

1. **Neoxify can currently promise what ExitLag promises**, and the promise
   is honest today: on five independent reputation feeds, Neoxify's exits
   measure identically to ExitLag's and NoPing's — datacenter yes, VPN no.
2. **The property is not owned, it is held.** It rests on the fleet not
   being enumerable, and the fleet *is* enumerable right now through
   certificate transparency. Nothing about that is fixed.
3. **The largest risk Neoxify controls is one it could create itself**: a
   partial destination-prefix list splitting a game's simultaneous
   connections across two source addresses. That is now a build failure.
4. **The datacenter-range risk is real, shared with every competitor
   including ExitLag, and not fixable by anything anyone in this market has
   bought.** It is also much smaller than folklore says — see mechanism 2.
5. **Most real-world "the VPN got me blocked" reports are the auth tier,
   not the game.** Login and patch endpoints sit behind Cloudflare and
   Akamai; the gameplay path frequently keeps working. A model that treats
   "datacenter IP" as one binary will mispredict.
6. **The single highest-severity mechanism in this whole document requires
   no detection at all**: a player telling support where he really is.

---

## The mechanisms

Ordered by how much control Neoxify has over them, not by likelihood.

### 1. IP reputation — the VPN / proxy label

**What it is.** Anti-fraud vendors publish per-address booleans —
`is_vpn`, `is_proxy`, "Anonymizing VPN" — and some services consume them.

**Where Neoxify stands: measured, clean.** Zero of six exits carry a VPN,
proxy or anonymiser flag on ipapi.is, ip-api.com, proxycheck.io,
Scamalytics or the X4BNet VPN blocklist. ExitLag (twelve addresses) and
NoPing measure identically. Mullvad, NordVPN and — importantly — **Mudfish,
a gaming relay, on 19 of 20 sampled nodes** are flagged on every feed.

**What actually causes the label: enumerability. Measured, with controls.**
Two same-provider pairs settle it: on LightNode/Kaopu, Mudfish's node is
flagged and Neoxify's is not; on Vultr, Mudfish's is flagged and ExitLag's
is not. Same ASN, same hosting company, opposite verdicts. Every operator
in the flagged group publishes a machine-readable exit list. Every operator
in the clean group hands addresses to the client after authentication.

**What does not cause it, so nobody wastes money on it** — all measured:
transit space versus cloud VPS; address-space age; being called a "gaming
relay" instead of a VPN; and owning an ASN (Mullvad's own AS216025 and own
/24 still return `is_vpn: true`).

**Standing exceptions, and why they are accepted.** Two exits carry
`is_abuser: true` on ipapi.is, and three carry `proxy: yes` on
proxycheck.io. Both are believed to be range properties rather than
verdicts on our traffic — a neighbour address in the same /24 carries the
same abuser flag, and the panel host, which has never carried a tunnel,
scores identically to the Hetzner exit. They are recorded with their
reasoning in `scripts/exit-reputation-baseline.json`. Accepted is not the
same as harmless: chasing the abuser flags is
`docs/node-enumerability-remediation.md` §4 and it is still open.

**Decay.** These flags are behaviour-driven and the fleet is young. The
research cites an operator whose non-anonymous tunnels were proxy-flagged
within a month. This is the mechanism the monitor exists for.

**Not established:** that any of Riot, Blizzard or Epic licenses any of
these feeds. No primary evidence exists either way. The one game anywhere
with a named vendor in its source is Space Station 14, which is open
source and calls `check.getipintel.net`.

### 2. Datacenter-range blocks at the publisher's edge

**What it is.** A publisher drops a hosting provider's address range at its
own network edge. Independent of any VPN label — the address is refused for
being a server, not for being an anonymiser. No amount of reputation
hygiene touches it.

**The one ASN-attributable case: verified, and much weaker than it is
usually quoted.** In September 2019 a self-hosted WireGuard VPN on a Linode
New Jersey host could not reach Battle.net; the traceroute died on a
Blizzard-side router and the reporter says Linode support confirmed
Blizzard was blocking the range. **It cleared within hours once Linode
escalated.** That is a reactive, revocable abuse response, not a standing
policy against Linode's address space. Two of Neoxify's exits sit on
Akamai Connected Cloud (Linode, AS63949), which is why this case matters —
but "Blizzard blocks Linode" overstates the source by a wide margin. The
honest form is "Blizzard once blocked a Linode range and then stopped."

**The strongest published evidence of the category is Blizzard's own
support article — verified — and it is narrower than it looks.** Legacy
Diablo II (2000) Battle.net lists *connecting via a business network, cloud
hosting service, VPN or proxy* among the triggers for an automatic
temporary play restriction: IP-keyed, realm-specific, up to two weeks, and
support cannot lift it. Modern Battle.net has no documented equivalent, and
a Blizzard forum agent in 2023 described VPNs as unsupported but permitted.

**What is genuinely unknown, and this is the important part:** not one
primary source found anywhere says any publisher maintains a *standing*
blocklist keyed to hosting-provider ASNs. It is universally assumed and
nowhere documented. Searches for Hetzner, OVH, Vultr, DigitalOcean, AWS,
Azure, Google Cloud, Oracle and Contabo against Blizzard, Riot, Valve and
Epic produced no non-vendor evidence at all.

**Recorded evidence lives in `scripts/publisher-blocks.json`**, with per-
entry evidence levels and sources, and the reputation monitor annotates
each exit with whatever is on record for its range.

### 3. CDN and WAF blocks on the auth and patch tier

**Corroborated, and it is the correction that matters most.**

Login, account and patch endpoints sit behind Cloudflare and Akamai. Their
bot-management scoring refuses some datacenter exits — and the pattern is
*per datacenter*, not per operator and not per ASN. In the clearest
reported case, one VPN operator's Prague, Frankfurt, Vienna and Brussels
exits could not reach Riot's auth endpoint while its Netherlands and US
exits could, and **the game servers themselves stayed reachable
throughout**: the reporter authenticated through one exit and played
through another.

**Consequences for Neoxify's design, and they are concrete:**

- **The auth path and the gameplay path need separate risk terms.** A
  single "is this exit safe for gaming" boolean will mispredict, because
  the failure mode is "logs in fine, plays fine, cannot patch" or "cannot
  log in, but would play fine if it could".
- **This mechanism is a *blocked connection*, not a ban.** Do not describe
  it to a customer as a ban risk. It is an availability problem.
- **It interacts with mechanism 4 in the wrong direction.** Routing only
  the game's traffic and leaving the launcher direct avoids the auth-tier
  block — and creates the two-source-IP split. Routing everything avoids
  the split and exposes the auth tier. There is no configuration that
  dodges both, which is why the rule is all-or-nothing per game rather
  than clever.
- Whether these blocks are publisher-configured or Cloudflare's default
  scoring is **unresolved**.

### 4. The two-source-IP split — the one Neoxify could create

**This is the only mechanism in this document that Neoxify manufactures
rather than fails to prevent, and it is therefore the one that must never
ship.**

**The mechanism.** Route a game by destination prefix with a *partial*
prefix list and a game that holds two connections open simultaneously gets
one routed and the other not. World of Warcraft keeps its Home and its
World connection open together. The account then presents from two source
addresses at the same instant, in two different countries — which is the
account-sharing signature publishers look for. A partial list does not
degrade gracefully into a smaller benefit. It is **worse than not routing
at all**, because not routing carries no ban risk whatsoever.

**The gate.** `GameProfile.prefixComplete` is the operator's explicit
statement that the recorded prefix set covers the whole publisher ASN. It
defaults to `false`; the API coerces an absent value to `false`; the
desktop client's `canRouteByDestination` refuses to activate a per-game
private exit unless it is `true` **and** the CIDR list is non-empty.

**It is now enforced as a build failure.** `scripts/check-prefix-completeness.sh`
runs in CI and fails when any of the four invariants breaks: the schema
default, the API coercion, a seeded profile claiming completeness with an
empty list or no auditable ASN, or the client gate being relaxed. Before
that script, the rule existed as prose in four files and nothing would have
gone red if one of them changed. Every seeded profile today declares
`prefixComplete: false` and an empty `destinationCidrs` — deliberately.
Blizzard announces roughly 151 prefixes and this codebase does not have
them; writing a plausible subset is precisely the failure.

**The rule, stated once:** the whole prefix set or none of it.

**The same mechanism has a second route, and it is now closed too.**
Per-game exit selection lets a customer name an exit per game, and
preferences are keyed on the *executable*. A game is routinely several of
them — `Rust.exe` is the EAC wrapper Steam launches and `RustClient.exe`
is the game; `SeaOfThieves.exe` is a shim and `SoTGame.exe` is the
binary; VALORANT is the Riot client, the game and two Vanguard binaries —
so nothing guaranteed a game's binaries named one exit. Worse, the
binaries are resolved against *running* processes, so a game is routinely
only part-selected, and the part that is not selected is not carried at
all: it reaches the game's servers from the customer's own address while
its siblings reach them from the node. That is this mechanism exactly,
with no second exit required.

The gate is that **a catalogue row is the group**, and a group goes to
one exit or to none. Enforced at four layers — the client cannot express
a per-application exit, `exitsForGames` emits a group whole or not at
all, `SplitTunnelConfig::validate` refuses a config that splits one, and
`Selection::with_exits` drops a group it cannot see whole — with
`scripts/check-exit-groups.sh` failing the build if any of them is
relaxed. Full design in `docs/design/per-game-exits.md` §5.1.

### 5. Shared-exit collateral — the second one Neoxify could create

**Verified for one publisher, and under-appreciated.**

Blizzard's Diablo II article states that where an address is shared, a
restriction *"will affect all users of the IP address."* Every Neoxify
customer on a given exit shares one source address. So one customer's
behaviour — botting, chargebacks, whatever earns a restriction — lands on
every other customer routed through that exit, and support cannot lift it.

This is the same collateral property that makes the two `is_abuser` flags
worth chasing rather than shrugging at, and it is an argument against
concentrating gaming traffic onto a single exit "because that one is
clean". Blast radius is a design input.

**Not established** for any publisher other than legacy Diablo II, but the
mechanism is generic to NAT and there is no reason to expect it to be
unique.

### 6. Self-disclosure — highest severity, zero detection required

**Corroborated, and it is the mechanism with the worst outcome.**

The research found a player who lost **seven years** of Riot progress after
mentioning his real location in a support ticket. No detection was involved.
No IP reputation, no prefix list, no anti-cheat. He told them.

Nothing in the product can prevent this and nothing in the product should
pretend to. It is already in the client copy; it belongs in the model
because it is the mechanism most likely to actually cost a customer an
account, and because engineering effort spent on reputation while the
support-ticket path stays unaddressed is misallocated.

**The rule:** never advise a customer to explain a connection problem to a
publisher by describing their real location or their use of a VPN. The
in-app guidance says so; keep it there.

### 7. Region and entitlement mismatch

**Verified, publisher-documented, and account-side.**

The Steam Subscriber Agreement §3.A prohibits using IP proxying or other
methods to disguise the place of residence and states Valve may terminate
the account for it. Valve's region-restrictions FAQ repeats it in plainer
words. Riot's November 2020 announcement cut cross-region VPN access for
*"a few of the highest volume VPN services"* — named brands, by volume, with
no account penalty stated.

This mechanism is triggered by **apparent-region mismatch against the
account's region and entitlements**, not by the address being a datacenter
address. A player on a European account connecting through Singapore is
exposed; the same player connecting through Frankfurt is not, on this
mechanism, regardless of what the range is.

**Design consequence:** exit region should default to the region nearest
the player's real one, and any UI that invites a customer to pick a distant
exit for a *game* should say why that is different from picking one for
browsing.

### 8. Client-environment detection — not an IP mechanism, constantly blamed

**Verified, and included only so it stops being attributed to us.**

Riot's Vanguard blocks virtual machines; a cloud-PC vendor's own support
page lists League and Valorant as incompatible from update 14.9. This is
hypervisor detection on the customer's machine. It has nothing to do with
addresses, ranges or VPNs, and it will be reported to support as "your VPN
got me blocked". Recognise it and route it away from the reputation model.

---

## What is *not* a mechanism

Effort spent here is wasted. All of these are measured or primary-sourced.

- **Rotating to a fresh address at the same provider.** Measured: the
  datacenter label is a property of the range, the VPN label is per-address
  and tracks discoverability, and neither responds to rotation. Rotation
  also discards the low-abuse history, which is the actual asset.
- **Buying an ASN or leasing address space.** Measured on Mullvad, which
  owns AS216025 and its own /24 and is still flagged on every feed. It buys
  the label that does not govern.
- **Being categorised as a "gaming relay" rather than a "VPN".** Mudfish is
  a gaming relay and is flagged harder than most consumer VPNs. The category
  is worth nothing; the operational posture is worth everything.
- **"It is against their terms of service."** Riot's terms of service and
  Epic's terms of service and community rules contain **zero** occurrences
  of "VPN" or "proxy". The widely repeated claim that Epic's terms
  explicitly prohibit VPNs is contradicted by the document those articles
  cite. Steam's §3.A is real; do not generalise it to publishers who have
  not written it down.
- **Residential proxy pools.** Disqualifying, not expensive. Restated from
  the research: a large share of that traffic is non-consensual, and for a
  product whose users are in Iran and whose value proposition is trust, it
  is a worse position than a clean datacenter address, not a better one.
- **Blizzard's cloud-gaming EULA clause.** It prohibits running the *game*
  on rented hardware, and was enforced against cloud-PC users. It does not
  apply to routing traffic through a VPN exit. It is the usual source of the
  folklore that Blizzard bans datacenter addresses, and the folklore is a
  misreading.

---

## Per-exit gaming-safety verdict

Providers were **resolved, not assumed**: the hostnames were taken from
certificate transparency, resolved through public DNS, and the addresses
looked up on ipapi.is and ip-api.com on 2026-08-25. Node addresses are not
recorded here — `docs/node-address-hygiene.md`.

| Exit | ASN / provider | ASN type | VPN label | Adverse | Publisher blocks on record | Gaming verdict |
|---|---|---|---|---|---|---|
| **de1** | AS154177 LIGHT NODE LIMITED (Kaopu Cloud, DE) | hosting | none | `is_abuser` (range-wide) | none | **Lower risk.** No publisher evidence against LightNode anywhere. The abuser flag is the open item. |
| **tr1** | AS2914 NTT America, org Light Node Limited (TR) | **isp** | none | `is_abuser` (range-wide) | none | **Lowest risk in the fleet.** The only exit ip-api.com does not call hosting; sub-allocated space inside a transit ASN. |
| **fi1** | AS24940 Hetzner Online (FI) | hosting | none | proxycheck `proxy: yes` (range) | none | **Lower risk.** No publisher evidence against Hetzner. |
| **fr1** | AS63949 Akamai Connected Cloud / Linode (FR) | hosting | none | proxycheck `proxy: yes` (range) | **Blizzard 2019, edge-block, resolved** | **Slightly elevated for Battle.net titles only**, on one revocable historical incident. Not a known standing block. |
| **sg1** | AS63949 Akamai Connected Cloud / Linode (SG) | hosting | none | proxycheck `proxy: yes` (range) | **Blizzard 2019, edge-block, resolved** | Same as fr1, **plus** the largest region-mismatch exposure in the fleet for European and North American accounts (mechanism 7). |
| **ir1** | AS210814 VUNIFY (IR) | isp | none | none | none | Relay entry, not an exit. A game never sees this address. Iranian address space carries its own sanctions exposure — see mechanism 2's Blizzard-Iran precedent — which is a reason it must stay an entry. |

**The clear statement asked for:**

- **No Neoxify exit currently sits in a range any publisher is known to be
  blocking.** The one ASN with any recorded incident is AS63949, the
  incident is from 2019, and it was resolved.
- **`tr1`, `de1` and `fi1` are the lower-risk choices for gaming**, with
  `tr1` marginally best on ASN type.
- **`fr1` and `sg1` carry the only recorded publisher incident**, at
  evidence level "verified" but status "resolved". That is a reason to
  prefer another exit when one is equally good, not a reason to withhold
  them.
- **`sg1` is the wrong default for a European or North American gaming
  account** for region-mismatch reasons that have nothing to do with its
  range.

### Should route selection avoid fr1 and sg1?

**Not on this evidence, and building a blocker now would be building on a
single revocable incident from 2019.** The task of preventing a gaming
customer from being routed through a publisher-blocked range is real, but
the precondition — a range a publisher is *known* to block — is not
currently met by any exit.

What exists instead, and it is the honest minimum:

1. **`scripts/publisher-blocks.json`** — the evidence table, keyed by ASN
   and CIDR, with an evidence level and a status on every entry.
2. **The monitor reports it per exit on every run**, so the operator sees
   the annotation without anyone having to remember.
3. **If evidence ever hardens** — a second independent report against the
   same provider, or a block that does not clear — the table is already the
   right shape to lift into the backend.

**The design for that, when it is needed** (not implemented, deliberately):

- Evaluate the risk on the route's **exit** node, never its entry. For a
  relayed route the address a publisher sees is the exit's, and
  `listAvailableForPlan` in `apps/backend/src/modules/routes/routes.service.ts`
  currently exposes only the entry node's `publicIp` and region. A flag
  keyed on the entry node would be silently wrong for exactly the relayed
  routes it most needs to be right about.
- Prefer, do not remove. Order the route list so an annotated exit sorts
  below an equivalent unannotated one, and surface the annotation as an
  advisory in the client. Removing an exit is dropping capability for
  censored users to solve a gaming problem, and this project does not make
  that trade quietly.
- Do **not** put the CIDR table in the schema. It is evidence, it changes
  when someone reads a forum thread, and it belongs in source review.
- There is no node-update endpoint at all today (`nodes.controller.ts` has
  no `PATCH`), so a per-node admin-set flag is a larger change than it
  sounds and would need a DTO, an endpoint and a panel form.

---

## Certificate transparency is the live threat

**Say this plainly: the property this whole document is about is protected
by one thing — the fleet not being enumerable — and the fleet is
enumerable right now.**

Every Let's Encrypt certificate this project issues per node puts that
node's hostname into a public, permanent, append-only log. Querying it and
resolving the results recovers the entire exit list in about ninety
seconds, with no account, no probing and no contact with any node. That was
re-confirmed while writing this document, using two public APIs. It is
**precisely** the technique this project's own research used to enumerate
Mudfish's 635 nodes — and enumerability is the variable measured to *cause*
the `is_vpn` label. The mechanism that flags an operator is fully in place
here. The fleet has simply not been scraped yet.

Two things the re-check found that the existing runbook does not record:

- **The exposure spans two domains, not one.** Historical node names exist
  under the second domain as well as the primary one, and the monitor now
  checks both.
- **A wildcard certificate exists, and it is not being used by the nodes.**
  Per-node single-name certificates were still being issued weeks after the
  wildcard was, so every ~90-day renewal re-publishes the fleet's names.
  `docs/node-enumerability-remediation.md` §5 is genuinely unexecuted at the
  node level, and this is the concrete evidence that it is.

**`docs/node-enumerability-remediation.md` is unexecuted and needs an owner
decision.** Nothing in it has been run. It is not a task that can be picked
up unilaterally, because its central option puts the same private key on
six machines including a relay physically in Iran, and its stronger option
requires a client release that the users who most need the censorship
fallback are the least able to install. Those are the owner's calls.

The one sentence from that runbook that must not be lost: **a wildcard
freezes the exposure, it does not reduce it.** The names already logged are
permanent, and two of them are compiled into every shipped client as
censorship fallbacks and can never be retired.

---

## Operating rules

These are what keep the property. None of them is expensive and all of them
are lost the same way — quietly.

1. **Never publish a node list, and never let one be derived.** Addresses
   reach clients only after authentication. No node hostname in any public
   certificate. No guessable hostname convention. No node address in this
   repository, its history, an issue, a changelog or a support article —
   and remember that reverse-DNS forms hide an address from a plain grep.
   See `docs/node-address-hygiene.md`.
2. **Keep rDNS empty rather than a provider default.** Free, and the only
   recommendation in the whole measurement with a correlation behind it that
   costs nothing. Three exits still carry provider defaults. Never let a PTR
   contain the brand, "vpn", "node", "exit", "relay" or a region code.
3. **Never ship an incomplete prefix list.** Enforced by
   `scripts/check-prefix-completeness.sh` in CI. Do not weaken that check to
   make a game work; the whole prefix set or none of it.
4. **Re-measure on a schedule.** `scripts/check-exit-reputation.py`. See
   below for cadence.
5. **Price a free tier as an infrastructure decision.** Free or trial
   accounts make exits harvestable by exactly the mechanism that flagged
   Mudfish, Mullvad and NordVPN. It is the second half of enumerability.
6. **Never claim a connection state the app has not verified**, including
   in this domain: do not tell a customer an exit is "safe for" a game. Say
   what is measured and what is not.
7. **Treat a newly flagged exit as an incident.** Defined below.

### Cadence: monthly, not quarterly

The research recommends quarterly. **Monthly is better supported by the
same evidence**, and the argument is short:

- The research itself cites an operator whose non-anonymous tunnels were
  proxy-flagged **within a month**. A quarterly cadence can therefore miss
  a flag by up to eleven weeks, and the customer finds it first.
- Certificates renew on roughly a 90-day cycle, so a certificate issued
  outside policy can sit unnoticed for an entire quarterly interval — and
  a CT entry is **irreversible**. Every day of delay is permanent.
- The run costs about forty free API calls and two minutes. There is no
  budget argument for waiting.

**Run it monthly, and additionally:**

- **After every node install or decommission** — that is the only moment
  the CT name set changes, and it is the change that cannot be undone.
- **Before making any public gaming claim**, so the claim is backed by a
  measurement taken this month rather than by this document.
- **On any customer report of a game refusing a connection**, before
  theorising. Instrument, do not guess.

### Running the monitor

```bash
# On the panel host, where the node list is:
python3 scripts/check-exit-reputation.py --nodes-from compose \
  --compose-file infra/docker-compose.prod.yml --env-file infra/.env

# Or anywhere DATABASE_URL reaches the panel database:
python3 scripts/check-exit-reputation.py --database-url "$DATABASE_URL"
```

Python 3 standard library only; no `pip install`, no `jq`. It contacts no
node — every lookup hits a third-party database *about* an address. Free
tiers and public endpoints only; nothing paid, no account, no credential
sent anywhere. `getipintel.net` is deliberately not queried even though it
is the one vendor with a proven production game integration, because its
API requires an email address as a query parameter and that is the owner's
to hand over.

Output is **redacted by default** — addresses are replaced with
`{node-name}` in all four textual forms, including the reversed and dashed
reverse-DNS spellings — so a run can be pasted into an issue safely. Use
`--show-addresses` for a terminal. The full artifact is written to
`var/exit-reputation/`, which is gitignored, and each run diffs itself
against the previous one.

**Exit codes, and the distinction is the point:**

| | |
|---|---|
| `0` | Every required lookup succeeded and nothing adverse is unacknowledged. |
| `1` | **Regression** — a new adverse flag or blocklist membership. |
| `2` | **Incomplete** — a required lookup failed. "Clean" is not claimable. |
| `3` | Setup error: no node source, no `psql`, an empty node list. |

Exit 2 exists because this project has been burned repeatedly by checks
that pass by not running. A silent run is only worth trusting if a failed
lookup cannot produce silence. Optional feeds — proxycheck.io, which caps
at 100 lookups a day unkeyed, and Scamalytics, which is an HTML page behind
bot protection — are reported as `DEGRADED` and do not fail the run, but a
feed that did not answer never diffs as a flag being cleared.

The detector was verified against a positive control: a Mullvad relay
address, which the research measured as flagged on every feed, and which
fires all five detection paths and exits 1.

### Newly flagged exit

When the monitor exits 1:

1. **Do not rotate the address.** Measured: rotation buys nothing on a
   range-wide flag and discards the low-abuse history that is the actual
   asset. This is the reflex to suppress.
2. **Determine whether it is the range or us.** Look up a neighbour address
   in the same /24 that is not ours. If the neighbour carries the same flag,
   it is the provider's tenant mix and chasing our own traffic is wasted
   effort. This is the step that resolved both existing `is_abuser` flags
   into accepted baseline entries.
3. **If it is us, ask what changed.** A new flag on a previously clean
   address means either the fleet became enumerable — check the CT section
   of the same run for a new name — or a customer's traffic earned it.
4. **For an enumerability cause**, the response is
   `docs/node-enumerability-remediation.md`, and it needs the owner.
5. **For a traffic cause**, the response is egress rate-limiting or outbound
   port policy on the node, which needs its own plan and touches production.
6. **Only record it in `scripts/exit-reputation-baseline.json` once steps
   2-5 have an answer.** Accepting a flag to make the check green, without
   understanding it, converts this monitor into the thing it was built to
   replace.
7. **If a gaming customer is affected**, tell them what is known and what is
   not. Do not tell them a server "couldn't be reached" if it was never
   dialled, and do not tell them an exit is safe on the strength of a
   measurement nobody has re-run.

---

## Can Neoxify promise what ExitLag promises?

**Yes today. Fragile for four specific reasons.**

The promise ExitLag makes is that using it will not get you banned, and the
measurable part of that promise — that its exits do not carry an anonymiser
label — is one Neoxify meets exactly as well, on five independent feeds,
today. Neoxify is on ExitLag's side of the line and not Mullvad's, and
Mudfish, the market leader in this category, is on the wrong side of it.

What makes it fragile:

1. **The fleet is enumerable through certificate transparency, and the
   remediation is unexecuted and needs the owner.** This is not a
   theoretical exposure; it is the exact mechanism measured to cause the
   label, and it re-publishes itself at every certificate renewal.
2. **The clean result is partly a consequence of being small and young.**
   These flags are behaviour-driven. Nothing has scraped this fleet yet.
3. **A free tier would end it.** Harvestability is the second half of
   enumerability, and it is a pricing decision that looks like a marketing
   one.
4. **Nobody has tested a game.** Not one. Everything in this document is
   reputation data and publisher documentation. The measurement that would
   actually settle the promise remains the one both research files name: a
   real account, on a real Iranian home connection, logging in and playing —
   direct, then through a node, then direct again. Until that exists, the
   honest form of the claim is *"our exits do not carry the label that gets
   VPN users blocked, measured on this date against these five feeds"* —
   never *"you will not be banned"*.

And one thing that is **not** on the fragile list, because it is now
engineered: the two-source-IP split. That was the ban risk Neoxify could
have created for itself, and it is a build failure.
