# Building an IKEv2 node

Status: strongSwan is proven working by hand on sg1 (Singapore). The
installer role that reproduces it is **not written yet**. This is the spec for it, taken from what actually works rather
than from documentation.

## Why IKEv2 is different from every other protocol here

Nothing ships in the client. Windows and Android both dial it with the
operating system's own VPN client, so there is no engine to bundle, no
binary to fetch, and -- importantly after the Android segfault -- no
third native runtime in the app's process.

The cost is that the client is not ours, which fixes two things we would
otherwise choose:

- **UDP 500 and 4500, always.** The protocol fixes them and neither
  built-in client offers a way to say otherwise. IKEv2 cannot join the
  randomised-port work in `port-migration.md`.
- **Clients must connect by hostname, not IP.** The server presents a
  Let's Encrypt certificate for the node's name; Windows refuses a
  server whose certificate does not match what the user typed.

Both are reasons this protocol belongs on its own address, away from the
stealth protocols: it is the easiest thing here to fingerprint, and a
censor blocking the address takes everything sharing it.

## What the installer must do

Proven on sg1 in this order.

1. `apt-get install strongswan strongswan-swanctl libcharon-extra-plugins certbot`
   (`libcharon-extra-plugins` is what provides eap-mschapv2; without it
   the connection loads and every authentication fails.)
2. `certbot certonly --standalone -d <node hostname>`, then copy into
   swanctl's own tree, which is what strongSwan reads:
   - `cert.pem`    -> `/etc/swanctl/x509/<node>.pem`
   - `chain.pem`   -> `/etc/swanctl/x509ca/chain.pem`
   - `privkey.pem` -> `/etc/swanctl/private/<node>.key`, mode 600
3. Write `/etc/swanctl/conf.d/neoxify.conf` -- the `connections` and
   `pools` blocks. Copy the working file from sg1 verbatim.

   **The local `id` must be the hostname clients are given to dial, not
   the node's own name.** These stopped being the same thing when the
   panel began handing out mirror hostnames, and this instruction said
   "the node's hostname" for long enough that every node was configured
   that way. The result: IKE_SA_INIT succeeded, then every IKE_AUTH
   failed, on every client. iOS and Android both pin the remote identity
   to the address they dialled -- Android has no way not to -- so a
   server asserting a different name is rejected however good its
   certificate is. It had never once established an SA. The certificate
   is not the thing to check here; it already carries both names in its
   SAN, which is why this looked fine from the node.

   Verify with `swanctl --list-conns` and compare the `id:` under local
   public key authentication against the `endpointHost` the panel
   publishes for that node. They must match exactly.

   Read the certificate out of whatever file is in `/etc/swanctl/x509`
   rather than assuming `node.pem`. One node names it after the host
   instead, and a check that opens a fixed filename reports "the
   certificate does not cover this name" for a certificate that does --
   which is the wrong diagnosis in the more expensive direction, since
   it sends you to reissue a certificate that is fine.
4. Write `/etc/swanctl/conf.d/neoxify-users.conf` containing an empty
   `secrets { }`, mode 600. The agent owns this file from then on and
   rewrites it wholesale; the installer must not put users in it.
5. Forwarding and NAT, or the tunnel comes up and carries nothing --
   the M14 lesson, applied up front:
   - `net.ipv4.ip_forward=1`, persisted in `/etc/sysctl.d`
   - `MASQUERADE` for `10.68.0.0/24` out of the detected default
     interface (detected, not hardcoded to eth0)
   - `FORWARD` accept both directions for that subnet
   - persisted with `iptables-persistent`
6. `systemctl enable --now strongswan` then `swanctl --load-all`.
7. Register with the panel as protocol `IKEV2`, port 500.
8. The firewall advisory the installer prints at the end currently names
   TCP ports only. IKEv2 needs **UDP 500 and 4500** opening on any cloud
   firewall, and saying "TCP" there would send the operator to the wrong
   setting.

## How to know it worked

`ss -lnup` shows charon on 500 and 4500, and `swanctl --load-all`
reports the connection and pool loaded. That is necessary, not
sufficient: prove it by connecting a real client to the hostname and
confirming traffic egresses, the same standard every other protocol here
was held to.

Two things that look like proof and are not. A reply to a raw
IKE_SA_INIT proves only that UDP reaches charon -- no certificate or
identity is exchanged that early, so a node with the identity bug above
answers it perfectly. And dialling one node from another fails at chain
validation regardless: `/etc/swanctl/x509ca` holds only this node's own
chain, so the initiator has no ISRG root and reports `no trusted RSA
public key found`, which reads exactly like an identity mismatch. Real
clients carry a full trust store and do not hit it. Use a phone.

## Usage and session counts

This section used to say `StatsSince` returns nothing. It did, though
not on purpose: the provisioner had grown a parser for
`swanctl --list-sas --raw`, but the parser looked for a shape strongSwan
never prints, so until the 2026-10-06 review it matched nothing and
IKEv2 traffic counted against no quota and no device limit, silently.

The parser now reads swanctl's real `--raw` output -- one
`list-sa event {...}` line per IKE SA, captured from a live node and
kept as `agent/internal/protocols/ikev2/testdata/swanctl-list-sas-raw.txt`.
Counters are tracked per CHILD_SA, which is the key that stays stable
across an IKE rekey (strongSwan moves the children, counters and all, to
the new IKE SA); `bytes-in` is the customer's upload. When swanctl lists
SAs and none can be read, the poll errors instead of reporting nobody.

**Billing IKEv2 is a product change, and needs the owner's approval
before the agent release that carries it.** This section used to call
leaving IKEv2 uncounted deliberate ("Uncounted is visible and safe"),
for fear of billing someone for traffic they never used. The parser
fix turns counting on. The concern it named -- a per-user key that
survives rekeys and reconnects -- is what the per-CHILD_SA keying and
the first-poll baseline address, but by reasoning, not on a node. The
alternative is an unmetered path around every data cap.

Session counts are not usage. strongSwan keeps an SA until charon
restarts (no DPD, rekey_time = 0s), so a phone that died on IKEv2 stays
listed indefinitely: the captured sample's two SAs had had nothing from
their clients for about 21 hours. The agent counts only ESTABLISHED SAs
with a CHILD_SA that had a packet in from the client in the last three
minutes, and the backend ignores IKEv2 session counts anyway and goes by
bytes, as it does for WireGuard and Xray.

A revoked customer's session is ended with `swanctl --terminate --ike-id
N --force`. If that fails, the DISABLE_USER/DELETE_USER command fails
and is never resent, so the agent itself ends any SA still listed under
that identity on every stats poll until none is. An agent restart in
between forgets it.

**Unverified:** that a usage row appears in the panel after a real
IKEv2 dial on a node running the fixed agent, and the IKE-rekey case
(reasoned from how strongSwan rekeys, not observed on a node); that
`--terminate --ike-id N --force` ends a live session; that `use-in`
moves only with ESP traffic.
