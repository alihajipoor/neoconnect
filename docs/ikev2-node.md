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

## What is deliberately missing

`StatsSince` in the agent provisioner returns nothing, so IKEv2 traffic
is not counted against a customer's quota. strongSwan exposes per-SA
byte counts, but a delta needs a per-user key stable across rekeys and
reconnects; getting it wrong bills somebody for traffic they never used.
Uncounted is visible and safe. Worth closing if IKEv2 becomes popular.
