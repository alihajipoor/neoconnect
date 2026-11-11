# The installer: operating systems and provider images

What `installer/install.sh` accepts, what each newer release changed
under it, and what a provider's image can bring along that a node must
not keep.

**Status of everything below that is marked "automatic": written and
tested without a server (stand-ins for `iptables` and `ufw`, a TLS
server on loopback), never yet run on a real box.** The two Ubuntu
26.10 nodes this page was written from were built by hand; the first
build that goes through the installer and `scripts/fleet` as they are
now is the proof, and until then each item is unverified on a server.

Two things have run on one of those nodes since, both read-only
(2026-11-11): the image report (`maintenance/provider-image.sh` with no
flag) found all six items in order, on an interface that is not `eth0`
and with no global IPv6; and the dest audit's control case passed on
that node's OpenSSL 4.0, so the "Negotiated TLS1.3 group" line is now
read from a real handshake there and not from a report of one. No
repair has run on a real box.

## Supported releases

`installer/lib/os-detect.sh` refuses anything outside this list. It is a
list of releases a node has actually been built on, not a range: what a
release changed is not known until somebody has installed on it.

| Release | Notes |
|---|---|
| Ubuntu 20.04, 22.04 | The original matrix. |
| Ubuntu 24.04 | strongSwan runs as `strongswan-starter`. OpenSSL 3.0. |
| Ubuntu 26.04 | strongSwan runs as `strongswan.service` (charon-systemd); there is no `strongswan-starter`. The IKEv2 loader is bound to whichever unit exists. |
| Ubuntu 26.10 | Added 2026-11. See below. |
| Debian 11, 12 | |

`OS_VERSION` is read nowhere else in the installer, so adding a release
is one line in that file plus a row here.

## What Ubuntu 26.10 changed

Found on two nodes built on it in November 2026.

| What | Effect | Handled |
|---|---|---|
| Not in the installer's matrix | The installer refused to start. Both builds patched the check on the box. | Automatic: 26.10 is in the matrix. |
| OpenSSL 4.0 | `openssl s_client` no longer prints `Server Temp Key`; the negotiated group is on a `Negotiated TLS1.3 group` line. The REALITY dest audit read only the old line, so on 26.10 it could not see which key exchange a site used, and it treated the question as advisory anyway. It passed a site that refuses X25519; REALITY on that node carried nothing ("received real certificate") until the site was changed by hand, on a node that was already built. | Automatic: see *The REALITY dest audit* below. |
| OpenSSL 4.0, cosmetic | `openssl dhparam` announces "Generating DSA parameters" for the same DH file. The legacy provider still supplies what MSCHAPv2 needs; strongSwan's loaded plugins and algorithms were identical to a 26.04 node's. | Nothing to do. |
| strongSwan 6.0.7 | Still charon-systemd, as on 26.04. The `swanctl` command prints "plugin failed to load" lines; they are the client's own and charon is unaffected. | Nothing to do. |
| nginx 1.30, certbot 5.5, OpenVPN 2.7 | No change needed. nginx wants `http2 on;` (the fleet tool already writes that from 1.25.1 on). | Nothing to do. |
| OpenSSH 10.5 | Failed logins are logged by a second process, `sshd-session`. | The fleet tool's fail2ban jail matches both; one failed login was counted on each box. |
| `wg-quick@wg0` | Also linked into `wg-quick.target.wants`. | Nothing to do. |
| `/tmp` | A tmpfs. | Nothing to do: nothing the installer leaves there has to outlive a boot. |
| Time | `systemd-timesyncd`, no chrony. | The fleet tool's verify accepts either. |
| `ssh.service` | Enabled as a service rather than socket-activated. | Left as it is: sshd is never changed. |
| `upki-fetch.timer` | A new timer that fetches PKI data. | Left as it is. |

Xray is not on this list: the release it runs is pinned by the installer
(`XRAY_PINNED_VERSION` in `installer/lib/agent.sh`) and runs as `nobody`
under the installer's own unit, whatever the distribution. Upstream's
install script had started installing a newer Xray under a new `xray`
user that cannot read the certificate key, which stopped every protocol
(exit 23) on both builds; they were built with an installer from before
that fix.

## What a provider's image can bring along

The same two nodes were built on a provider image that was not bare.
`installer/lib/image.sh` looks for each of these and repairs only what
it finds. A fresh install runs it before any package is installed;
`scripts/fleet` runs it as the `add.image` step and lists what it found
in `add.inventory`; and it can be run by hand:

```bash
bash installer/maintenance/provider-image.sh            # look, change nothing
bash installer/maintenance/provider-image.sh --apply    # repair what is found
```

One line per item: `ok`, `REPAIR` (found; `--apply` changes it) or
`LOOK` (found; a person decides). On a box that is already a node,
`--apply` changes nothing without `--live`.

| Item | What was found | The repair | Copies kept |
|---|---|---|---|
| **ufw** | Active, INPUT and FORWARD on DROP, a few ports open. Every engine port would have been closed and nothing forwarded. `iptables-persistent`, which the installer needs, removes the package and leaves its DROP policies and chains loaded, so the certificate challenge on port 80 fails next, and the first `netfilter-persistent save` writes the chains into the rules the node boots with. | Disabled through ufw itself, removed, then its chains taken out of the running tables: policies to ACCEPT first, then the jumps, then the chains. Before every save of the firewall rules the installer takes out leftover ufw chains again. | `/root/ufw-status-before-neoxify-*.txt`, `/root/ufw-config-before-neoxify-*.tgz` |
| **Hostname** | The label typed into the provider's dashboard, carrying the brand. Renaming the box held until the next boot: cloud-init set `/etc/hosts` back from the provider's metadata, because the provider's vendor data forces `manage_etc_hosts` on. | `/etc/cloud/cloud.cfg.d/99-neoxify-hostname.cfg` with `preserve_hostname`, `manage_etc_hosts: false` **and** the name itself (`hostname`, `fqdn`), written before the box is renamed; `/etc/hosts` rewritten. A box whose name carries the brand is renamed to the distribution's id. | `/root/hostname.before-neoxify-*`, `/root/hosts.before-neoxify-*` |
| **Swap** | A swap file of the provider's own size, with its own line in `/etc/fstab`. | On a box with up to 1100 MB of memory: a 2 GB `/swapfile` and the line `/swapfile none swap sw 0 0`. A swap file of another size is replaced; swap on a partition or another file is left. A small box with no swap gets one. | `/root/fstab.before-neoxify-*` |
| **fwupd** | `fwupd-refresh.timer`, which fails on a virtual machine and leaves a failed unit. | Masked, on a virtual machine only. | none |
| **Interface name** | `enp1s0`, not `eth0`. | Nothing to repair. Every rule names the interface the routing table gives (`detect_default_iface`). `scripts/fleet/test/image.test.mjs` fails if an interface name is written into the installer, the fleet tool or the agent, and the fleet tool's verify checks on the built server that every NAT rule leaves by the default route's interface. | |
| **IPv6** | No global address, with IPv6 resolvers still listed in `resolv.conf`. | The API mirror's nginx resolver is the first IPv4 nameserver (a bare IPv6 address there is an nginx syntax error). The fleet tool closes IPv6 for Xray's user whether or not the box has an address, on the interface IPv4 leaves by: the provider can turn IPv6 on later. | `/root/rules.v6.bak-pre-ipv6-nobody` |

Not repaired, on purpose: a DROP policy that is not ufw's. That is
somebody's own firewall; it is reported as `LOOK` and left alone.

Not checked at all: the provider's own sysctl file (congestion control
and buffer sizes differed from the other nodes and were left), and a
firewall in front of the box at the provider, which only the owner can
see.

**Only a reboot shows whether the hostname holds.** The fleet tool's
`add.reboot` runs the image check again afterwards; a build done with
the installer alone should be rebooted once, before any customer is on
it, and `provider-image.sh` run again.

## The REALITY dest audit

`probe_reality_dest` in `installer/lib/agent.sh`, also reachable as
`installer/maintenance/reality-dest-audit.sh <name>`.

REALITY's server answers a customer only after reading the disguise
site's own answer and finding an X25519 key share in it (or the
X25519+ML-KEM hybrid). On anything else it stops and passes the
connection through to the real site, whose certificate the client then
refuses. Nothing on the node logs it.

So X25519 is now proven and fatal:

- A second handshake offers X25519 **alone** (`-groups X25519`). If it
  does not complete, the site is `BAD`. The answer is whether the
  handshake completed, which every OpenSSL reports the same way, and not
  a line one release prints.
- If the ordinary handshake settled on another group although X25519
  was offered first, the site is `BAD` as well. That reads the group
  from whichever line this OpenSSL prints (`Server Temp Key`,
  `Peer Temp Key` or `Negotiated TLS1.3 group`), and is skipped when it
  prints none.

The installer asks about a site it cannot use in different words than
about a weak disguise ("Build on it although REALITY will not work?"),
so an answer prepared for the second never lands on the first.

```bash
bash installer/maintenance/reality-dest-audit.sh --self-test-local   # no network
bash installer/maintenance/reality-dest-audit.sh --self-test         # that, and two live sites
```

The local part starts two TLS servers on loopback, one that offers only
P-256 and one that offers X25519, and requires the check to refuse the
first and pass the second with whatever OpenSSL the box has. It runs in
CI on every push (the step prints which OpenSSL the runner had) and was
run on OpenSSL 3.5.8. **It has not been run on OpenSSL 4**: the line
OpenSSL 4 prints is covered as text, taken from the 26.10 build notes.

`scripts/fleet` does not rely on the audit alone. Its `add.dest` step
runs the audit on the box and then dials a real REALITY handshake from
outside through a throwaway inbound on the box, before the installer
runs: see `docs/runbooks/fleet.md`.
