# Reaching Neoxify from a filtered network

How the apps find the control plane when addresses get blocked, what
changed on 2026-10-18, the rules for running it, and what is still to
build. Real domains and addresses never appear here
(docs/node-address-hygiene.md); `{curly}` names are stand-ins.

## What happened on 2026-10-17

- `{mirror-domain}` -- the domain every node mirror and most node TLS
  names were on -- was DNS-poisoned (the 10.10.34.x block page, even
  through public resolvers) and SNI-reset in Iran. All five mirrors in
  the signed list died there at once. `{old-domain}` already was.
- Each older node's certificate listed its `{old-domain}` name beside its
  `{mirror-domain}` name. Certificates are published in CT logs with all
  their names, so the first block led straight to the second.
- On home and mobile networks (TCI, MCI, RighTel, Irancell, ParsOnline)
  all four panel addresses timed out: two go straight to the panel host's
  IP, two through Cloudflare, and those networks filtered both. A node's
  IP reached with no name of ours worked from inside Iran.
- The relay of last resort worked end to end, yet a customer on such a
  network stayed on "Could not reach Neoxify". The app sent nothing to
  the relay without consent, background requests never asked for it, and
  the server list is a background request. The app also kept the relay
  shut when the last country it had stamped was not Iran -- and a stamp
  taken while another VPN was on names that VPN's country.
- Installed apps can reach only the hosts their build-time HTTP scope
  names (a wildcard where the seed had two hosts on one domain). No
  signed list could move them to a new domain or a bare IP.

## The layers, as of this change

1. **The signed list** (endpoint-bundle.ts). Addresses as data, signed
   offline by a compiled-in key (`primary`, `backup`). Any copy is good
   wherever it came from; a client takes only a higher version.
2. **The server-signed list** (`/endpoints/bundle2`). A compiled-in key
   signs a statement that a server key may sign lists until a date; the
   server signs lists under it. Clients from this release check the
   statement, ask for bundle2 first, and fall back to the offline list.
   Older clients never see bundle2 and keep reading `/endpoints/bundle`.
   Versions: offline lists stay below 100, server lists are 100 and up.
3. **The HTTP scope follows the list** (src-tauri/src/bundle_scope.rs).
   The app hands each list it holds or adopts to `grant_bundle_scope`,
   which verifies it in Rust and adds a runtime capability for its panel
   and mirror hosts. From this release on, a new domain or a bare IPv4
   address reaches every client that can fetch the list -- no release.
   A bare address needs a certificate valid for that address.
4. **Direct mirrors**: each node answers `/api` on a dedicated port with
   a certificate of its own for a name on a domain the shipped builds
   already scope (`{direct-mirror-domain}`), behind a DNS-only record.
   Added 2026-10-17 as bundle v7; nginx terminates TLS and Xray is not
   touched (`neoxify-mirror-direct` on each node).
5. **The relay of last resort** (last-resort.ts). Now on until the
   customer turns it off in Settings, for background requests too, with
   no device-side guess at the country: the backend's region gate
   decides, and a refusal switches it off on that network for a day.

## Rules for running it

- **One of our domains per certificate.** Never issue a certificate that
  names two of our domains: CT logs make the pair public, and blocking
  one hands over the other. A new name gets its own certbot lineage.
- **Keep reserve domains dormant**: no DNS records pointing at us and no
  certificates until the day they are needed. Activating one is a DNS
  record, a certificate and a signed list -- minutes, no release.
- **Do not pile names onto one IP.** A domain resolving to an address
  already known as ours is the next thing to be blocked with it.
- **Publishing.** Offline lists (v < 100) for every client:

      node scripts/endpoints/bundle.mjs sign --in list.json \
        --key {offline-key-path} --key-id primary \
        --previous last.signed.json --out list.signed.json
      # PUT /admin/endpoints/bundle {signed}

  Server lists (v >= 100) for clients from this release:

      node scripts/endpoints/bundle.mjs sign --in list.json \
        --key {server-key-path} --key-id {server-key-id} \
        --cert {statement.json} --out bundle2.signed.json
      # PUT /admin/endpoints/bundle2 {signed}

  To move a client that holds a server list back to an offline one,
  publish the offline list with a version above the server list's. The
  next server list must then be numbered above that offline list: clients
  keep one version number for both, and the panel refuses one beneath it.
- **Copies on GitHub**, mirrored by jsDelivr. After publishing either
  list, copy both into a checkout of the copies repository
  (`{copies-repo}`; its name stays out of this repository):

      node scripts/endpoints/publish-copies.mjs --repo {copies-checkout} --push

  It fetches the two lists from the panel, verifies them against the
  apps' compiled-in keys with `bundle.mjs verify`, writes them unchanged
  as `bundle.json` and `bundle2.json`, commits only a higher version,
  pushes, and asks jsDelivr to refetch. `--dry-run` writes nothing. The
  repository holds those two files and nothing else, and the script
  refuses a checkout that holds more.
- **The statement expires** (at most two years). Vouch again with the
  offline key before it does, or server lists stop being accepted and
  clients fall back to the newest offline list they have fetched (kept
  apart for this), or their build's seed if that is newer:

      node scripts/endpoints/bundle.mjs vouch --key {offline-key-path} \
        --key-id primary --id {server-key-id} --server-pub {base64} --days 365 \
        --out {statement.json}

## Release checks (desktop 0.9.51 / mobile 0.2.29 or whatever ships this)

On the VM and a phone, with the release build:

1. **The scope grant.** Publish a server list naming a mirror host that is
   *not* in the build's seed (a fresh name on a domain the seed does not
   have). Start the app, let it fetch bundle2, confirm a request to that
   host succeeds -- before this change it failed locally with `scope`.
   The mock-runtime test (`bundle_scope_runtime` in the mobile crate)
   proves the mechanism against the real generated ACL; this proves the
   release.
2. **No crash at start** with an old stored list, a seed-only install,
   and a stored server list -- `grant_bundle_scope` runs as the list is
   first read.
3. **The relay with no prompt.** On a network where the ordinary routes
   are blocked (the VM's filter profile), signed in, open the app: the
   server list should arrive through the relay with the "App data:
   backup route" chip, and no question asked. Turn the backup route off
   in Settings: nothing goes to the relay.
4. **A previous "No"** to the old prompt (`neoxify.relay.consent =
   declined` in storage) does not keep the relay off.

## Not built yet

- **The panel signs and publishes server lists by itself**, rebuilding
  bundle2 as nodes change. Needs the server key on the panel host --
  only after the panel is hardened (below). Until then lists are signed
  with the server key on the owner's Mac and published by hand.
- **Panel hardening** (owner's condition for the server key). Live:
  admin sign-in alerts and an admin audit log; fail2ban on sshd on the
  panel host and every node. Owner decisions (2026-10-18): SSH password
  login stays, no identity-aware proxy in front of the panel, MFA turned
  on by the owner later. Still to do: short sessions, and the signing key
  in a separate process the panel can ask but not read.
- **The control plane through the tunnels** (Psiphon's model): the app
  reaches the API through whatever VPN connection works -- the
  customer's own credentials, or for sign-in and sign-up a built-in
  guest connection that can reach only the API, with a traffic cap and a
  per-device limit. The node routes the guest's traffic to the API and
  nowhere else.
- **Social sign-in during an intranet** cannot work (it needs Google's
  and Apple's servers). Sessions renew without them; social-only
  accounts should be nudged once to set a password.
- **The apps reading the GitHub copies.** No build fetches them yet:
  the copies' hosts are outside every shipped HTTP scope, and their URLs
  need to reach the build the way the seed does, not through this
  repository.
- **Bare-address mirrors** need certificates valid for an IP address
  (Let's Encrypt issues short-lived ones), renewed every few days.
