# Detection resistance: how each transport is meant to look on the wire

Written 2026-08-14, from a read of the installer, the templates, the
agent and both clients. **Everything here that is not marked "measured"
is analysis of code and protocol behaviour, not a measurement against a
live filter.** Nothing in this document was tested against an Iranian
network. The items that need a real test are collected at the end.

The audience is whoever next changes a transport's defaults. The point
of writing it down is that most of these choices look arbitrary in the
code and are not.

## What an automated filter can actually do cheaply

Ordered by cost to the censor, because that is the order in which our
mistakes get found:

1. **Port lookup.** Free, no inspection. 51820 is WireGuard, 1194 is
   OpenVPN, 8388 is Shadowsocks. This is why `suggest_free_port` exists
   and why the well-known ports are gone from every node
   (`docs/port-migration.md`).
2. **SNI against the address it was sent to.** Nearly free. The big
   properties publish their address ranges -- Cloudflare, Google,
   Fastly, Apple, Akamai -- so "this ClientHello says `cloudflare.com`
   and it is going to a Hetzner box in Iran" is one table lookup and no
   packet inspection at all. **This is the strongest argument against
   the stock REALITY `dest` values**, and it is why the installer now
   steers towards long-tail sites hosted near the node.
3. **Response fingerprinting by active probe.** Cheap, and it does not
   need to break anything: open the port, speak ordinary HTTPS, hash
   what comes back. If every node in a fleet returns byte-identical
   bytes, the fleet is enumerable. Fixed for the fallback site (below);
   still open for the certificate names (below).
4. **TLS fingerprint (JA3/JA4) of the ClientHello.** Cheap. Countered by
   xray's uTLS `fingerprint: "chrome"`, set identically in all three
   places that build an outbound.
5. **Timing, volume and flow shape.** Expensive, needs state per flow.
   Nothing here defends against it; a long-lived high-volume flow looks
   like a tunnel whatever it is wrapped in.

## REALITY

`installer/lib/agent.sh`, `install_xray` -> `probe_reality_dest`.

REALITY borrows a real site's TLS identity, and hands any connection
that fails authentication to that site for real. So the `dest` is not
cosmetic: it is dialled from the node on every failed probe.

Four criteria, in the order a bad answer gets caught:

1. **Plausible for this node's address.** See point 2 above. A site
   hosted on ordinary infrastructure in the same country as the node is
   a much harder claim to falsify than a household name whose netblocks
   are published. For an Iran-hosted relay this means an Iranian site.
2. **Reachable from the node.** The handshake is forwarded there. A
   `dest` that refuses the node's address -- sanctions geo-blocking is
   the common case for an Iranian VPS dialling a US property -- turns
   probes into failures instead of into a convincing web page, which is
   *louder* than having no disguise.
3. **Not blocked where customers are, and not intercepted.**
   **`www.microsoft.com` is the known-bad one on this project.**
   Endpoint security software on a real customer's Windows machine
   intercepts it, so the interceptor's certificate arrives instead of
   the one REALITY expects and every connection fails with "received
   real certificate". Measured, on a live customer machine (M9). It is
   also a bad *local* testing choice on this project's dev machine for
   exactly the same reason -- the failure looks like a broken node.
4. **TLS 1.3, HTTP/2, X25519.** The installer no longer assumes this:
   `probe_reality_dest` opens a real TLS 1.3 connection with `-alpn h2`,
   checks the negotiated ALPN, checks the certificate verifies, and
   reports X25519 as advisory. Candidates are probed *from the node*
   before any of them is offered, so the list can never promise
   something that box cannot reach.

The old default was `cloudflare.com:443` for every node, which loses on
criterion 1 and additionally makes all our nodes match each other.
There is now a candidate list per node location and the operator picks;
the default is whichever candidate passed the probe first.

**Diversity matters as much as the individual choice.** One `dest`
across the fleet is one signature across the fleet.

## VLESS+TLS, Trojan, and the fallback site

These present a real Let's Encrypt certificate rather than borrowing
one, so the disguise is "an ordinary HTTPS site" and it has to survive
someone opening it in a browser.

- **Port is part of the disguise here**, unlike Shadowsocks and the UDP
  engines. TLS on 2087 is unremarkable (Cloudflare publishes
  2053/2083/2087/2096 as alternative HTTPS ports); the same handshake on
  46731 is an anomaly before inspection. `suggest_plausible_tls_port`
  draws from that set at random -- at random because every node
  answering on 2053 is one scan away from being a list of our nodes.
- **The fallback site is now different on every node.** It used to be
  the same 118 bytes everywhere, which is a fleet-wide fingerprint
  obtainable by an active probe that never touches a tunnel. It stays
  dull and impersonal on purpose: a page claiming to be a real
  organisation would be a lie told to whoever looks, and a page
  mentioning VPN would undo the point.
- **ALPN is `["h2", "http/1.1"]` on both ends, including for the
  WebSocket transport, and that is deliberate.** The ClientHello's ALPN
  list is plaintext, so it must match what a Chrome-fingerprinted hello
  would carry; dropping `h2` to match the WebSocket's actual HTTP/1.1
  framing would make the hello inconsistent with the fingerprint it is
  imitating, and the framing itself is inside TLS where no passive
  filter can see it.
- **The consequence of that, verified against xray-core's source**
  (`proxy/vless/inbound/inbound.go`, v1.260327.0): these connections
  really do negotiate h2, so the fallback comment claiming the path
  entry is matched "before" the ALPN entry was wrong about the
  mechanism. Fallbacks are a `[name][alpn][path]` map, not an ordered
  list. It works because path entries registered under the empty ALPN
  are copied into every named-ALPN bucket at startup, and because the
  path is sniffed from the request line regardless of ALPN. Do not
  "simplify" either entry away.

## WebSocket path

Was `/ws` by default. That is the default in every v2ray/xray tutorial
ever written, so it is the first string an active prober sends -- and a
node that upgrades `/ws` while answering every other path with a static
page has answered the question about what it is.

Now generated per node (`suggest_ws_path`). Both clients read the path
from the server's `publicParams` and neither has ever hardcoded it
(`apps/desktop-windows/src-tauri/src/vpn.rs`,
`apps/mobile/src/lib/xray-config.ts`), so this costs nothing.

## Shadowsocks 2022

No TLS, no handshake, indistinguishable from random bytes -- and
therefore nothing to hide behind once the port is known. The reasoning
about ports inverts here: there is no "normal service" story to tell on
any port, so a random high port is right and a Cloudflare-adjacent port
would be *worse* (a port that normally carries TLS, carrying something
that never sends a ClientHello, is its own anomaly under active
probing).

`uot: true` on both clients, so DNS and game traffic are not silently
dropped.

## WireGuard, OpenVPN, IKEv2

- WireGuard's handshake is a fixed, trivially recognisable shape. On the
  cross-border path it was **measured** dropped into Iran (2026-08-14),
  which is why phantun and then wstunnel exist. On the domestic path --
  a customer in Iran to an Iran-hosted relay -- it has not been tested;
  see the open items.
- OpenVPN uses `tls-crypt`, which encrypts and authenticates the whole
  control channel, so the handshake is not the giveaway it is on a
  plain OpenVPN server. The port is random per node.
- IKEv2 is fixed at UDP 500/4500 by the protocol and neither platform
  client can be told otherwise. **This is a gap, stated rather than
  hidden**: it cannot be moved off the ports a filter watches. It is
  last in the client's failover order for that reason.
- **wstunnel must be `wss://` before any customer sees it.** The proving
  run on ir1 used `ws://0.0.0.0:8447`; a plain WebSocket on an odd port
  is a fingerprint in its own right and gives up the property the
  transport exists for.

## Client side

Checked, and correct as of this writing:

- Every outbound is built from the server's `publicParams`. Nothing that
  varies per node is hardcoded in either client.
- `fingerprint: "chrome"` in all three builders --
  `apps/desktop-windows/service/src/engines/xray.rs`,
  `apps/mobile/src/lib/xray-config.ts`, and the relay's own outbound to
  the exit in `agent/internal/relay/provisioner.go`. A relay's uplink
  crosses the same filter a customer's does, so it needs the same
  treatment, and it has it.
- `allowInsecure` appears nowhere, and there is a test asserting its
  absence.
- Neither client will send an empty REALITY `shortId` any more. That bug
  produced a tunnel that came up and quietly browsed the camouflage
  site, which is the worst possible failure mode for a censorship tool.
- Trojan no longer falls back to the node's IP as SNI when a node
  records no `serverName`. uTLS drops an IP literal from the SNI
  extension entirely (`hostnameInSNI`, utls v1.8.3), so that fallback
  produced a Chrome-shaped ClientHello with *no* server name -- the
  loudest thing it could have sent -- and the certificate check failed
  anyway. It is now a refusal naming the missing field.

## Open, and needing a live test or an owner decision

1. **Certificate transparency exposes every node.** The TLS transports
   need real certificates, and every `*.neoxify.site` node name is
   published in CT logs the moment it is issued. Anyone can enumerate
   the fleet from a public log, with no probing at all, and block the
   addresses in bulk. Mitigations all cost something: unrelated domains
   per node, or a wildcard issued by DNS-01 (which hides the specific
   subdomain but not the apex). **Owner decision.**
2. **Aggregate port profile of the Iran relay.** ir1 answers on 443,
   2053, 2054, 8443, 8444, 8445, 46731, 46732. Individually defensible;
   together they say "this host runs eight services, four of them on
   ports nothing normally uses". The `+1` pairs (2053/2054, 8444/8445,
   46731/46732) come from adding a second inbound per relayed exit by
   hand, and 2054 and 8445 are not ports anything else uses. Nothing was
   changed on the live node -- **needs the owner**.
3. **Which `dest` is actually right for ir1.** The probe answers
   "reachable and TLS 1.3 from this box"; it cannot answer "not
   suspicious from inside Iran". A domestic Iranian site is the
   reasoned choice for an Iran-hosted relay. **Needs a live test from an
   Iranian network before changing a serving node.**
4. **Failed attempts are training data.** The client's failover order
   starts with WireGuard for speed. On a filtered network that means
   every first connection emits a recognisable WireGuard handshake to
   the node before anything else is tried, and the per-network memory
   only remembers what *worked*, not what failed. Remembering failures
   per network would cut it to once. **Product decision** -- the current
   order is a recorded one (speed first, evasion last).
5. **Whether domestic WireGuard works at all** (journal item 0). If it
   does, item 4 matters less; if it does not, the first attempt on every
   Iranian connection is a wasted, conspicuous one.
