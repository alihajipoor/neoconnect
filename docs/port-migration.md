# Moving WireGuard, OpenVPN and Shadowsocks off their default ports

Decided 2026-08-10. **Done 2026-08-11.**

## Outcome

| Protocol | fi1 | fr1 | sg1 |
|---|---|---|---|
| WireGuard | 51820 -> **45312** | 51820 -> **38471** | not offered |
| OpenVPN | 1194 -> **49266** | 1194 -> **52903** | 26471 (already custom) |
| Shadowsocks | 41820 | 37651 | not offered |
| REALITY / VLESS+TLS / Trojan | 443 / 2053 / 8443, unchanged by design | | |
| IKEv2 | | | 500, fixed by the protocol |

No default port is in use anywhere. Shadowsocks needed nothing -- both
nodes were already on high ports, since its installer step has always
refused 8388.

**Add-then-retire turned out to be unnecessary, and the runbook below
overstates what was required.** It assumed a second listener had to run
alongside the first while clients moved across. In practice both nodes
had zero live WireGuard and OpenVPN sessions at the time, and the
clients re-fetch credentials on every launch, so a direct switch cost
nothing and avoided running duplicate listeners. WireGuard's port even
changes hot, via `wg set wg0 listen-port`, with peers retained -- 14 on
each node, confirmed after the change.

**The real blocker was elsewhere, and it was a bug.** Changing a
config's port updated the row and did nothing else. WireGuard and
OpenVPN bake `endpoint` into each customer's credentials at generation,
so every provisioned customer would have gone on dialling the old port
while the panel showed success. Fixed first, in
`ProtocolConfigsService.update()`, which now rewrites the endpoint in
every issued credential for the config. That is the thing to remember
if a port ever moves again.

Verified by connecting from the Android client on the new WireGuard
port and reading fi1's own counters: handshake 23 seconds old, 11.77
KiB received and 26.79 KiB sent.

## Why

`51820` and `1194` announce what they are. A scanner or an ISP looking
for VPN traffic finds them by port alone, before inspecting anything, and
some networks block them outright on that basis. Shadowsocks' `8388` is
the same. Randomising per node per protocol removes the free signal and
means one blocked port costs one protocol on one node, not everywhere.

## What is deliberately NOT changing

**REALITY, VLESS+TLS and Trojan stay on 443 / 2053 / 8443.** Their
disguise *is* the port: TLS on 443 is indistinguishable from browsing,
while a TLS handshake on a random high port is itself the anomaly. Iran
cannot block 443 wholesale. Moving them would trade an unblockable port
for a conspicuous one.

**IKEv2 stays on UDP 500/4500.** Not a choice: the protocol fixes them,
and neither Windows' nor Android's built-in client offers a way to
specify anything else. That is the cost of not shipping an engine, and
another reason IKEv2 belongs on its own address.

## Port range

20000–59999, drawn per node per protocol, skipping anything already
listening.

## Order of work

The migration is add-then-retire, confirmed with the operator. A port
change on a live node disconnects every customer on it until they hold
new credentials, and the people this matters most to are the ones least
able to recover.

1. **Installer** — replace the fixed defaults with a randomly suggested
   free port, so new nodes never land on a well-known one.
   - `installer/lib/agent.sh:900` WireGuard, default `51820`
   - `installer/lib/agent.sh:1187` OpenVPN, default `1194`
   - Shadowsocks (~line 681) already refuses a default and warns about
     8388; give it a suggested random port rather than a blank prompt
   - `:863` firewall advisory lists the ports to open — must follow
   - `:1305` OpenVPN management-port text
2. **Windows client** — `src-tauri/src/vpn.rs:670` hardcodes
   `443/51820/1194` in a diagnostic. The connect path is already
   port-agnostic (it uses `connection.endpoint.port`), so this is
   reporting only, but it would print nonsense after the change.
   `vpn.rs:376` is a comment; `api-endpoints.test.ts:44` is a fixture.
3. **Android** — nothing to do. Already takes the port from the API.
4. **Panel** — nothing to do. `listenPort` is already free-form per
   protocol config.
5. **Live nodes (fi1, fr1)** — the careful part:
   a. Add a second listener on the new port, leaving the old one up.
   b. Register it as a new ProtocolConfig + Route, so clients receive
      credentials pointing at the new port.
   c. Ship clients; watch `/client-attempts` for traffic moving over.
   d. Only then remove the old listener and its Route.
   Existing `ProtocolUser` rows carry the endpoint, so they are
   re-issued by the backfill rather than edited.
6. **sg1** — OpenVPN on a random port from the start; IKEv2 on 500/4500.

## How to know it worked

Not "the config has the new port". Connect a real client over each
changed protocol and confirm from the node's own logs that the session
arrives on the new port, then confirm the old listener is idle before
removing it.
