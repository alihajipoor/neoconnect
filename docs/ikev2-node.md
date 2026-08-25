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
   `pools` blocks. Copy the working file from sg1 verbatim; the local
   `id` must be the node's hostname, matching the certificate.
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

## What is deliberately missing

`StatsSince` in the agent provisioner returns nothing, so IKEv2 traffic
is not counted against a customer's quota. strongSwan exposes per-SA
byte counts, but a delta needs a per-user key stable across rekeys and
reconnects; getting it wrong bills somebody for traffic they never used.
Uncounted is visible and safe. Worth closing if IKEv2 becomes popular.
