# Moving WireGuard, OpenVPN and Shadowsocks off their default ports

Decided 2026-08-10. Not started.

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
