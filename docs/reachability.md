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

      node scripts/endpoints/publish-copies.mjs --repo {copies-checkout} \
        --names {offline-file},{server-file} --push

  It fetches the two lists from the panel, verifies them against the
  apps' compiled-in keys with `bundle.mjs verify`, writes them unchanged
  under the two file names given (kept with the repository's name, out
  of this repository), commits only a higher version, pushes, and asks
  jsDelivr to refetch. A copy already there is checked the same way
  before its version counts; one that fails is replaced. `--dry-run`
  writes nothing. The repository holds those two files and nothing else,
  and the script refuses a checkout that holds more. It commits only
  under the checkout's own identity (`git config --local user.name` and
  `user.email`, ideally a GitHub noreply address), in UTC, and refuses a
  checkout without one.
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

## Servers that connect and carry nothing (2026-10-27)

Found by the investigation of 27 October: Iran blocks per operator and
per server address, and the commonest block lets a connection open and
then holds the upload of that address to about 0.1 Mbps after the first
63-95 KB. A tunnel to such a server passes the address check, so the app
said "Connected" over a tunnel that loaded nothing. What changed:

- **"Connected" proves data moves** (`src/lib/data-check.ts`, shared by
  both apps; `data_check_v4` in `health_ip.rs`; `/health/bulk` in the
  API). After the address check passes, 128 KB down and 256 KB up through
  the endpoint that answered it, 8 s per direction. A rung that does not
  finish is moved on from, its route's other protocols are passed over
  (the hold is on the address), and the best slow rung is dialled again
  and kept only if nothing faster lands, with a line saying it is slow.
  A check that cannot run -- old backend, 503 from the in-flight limit,
  an error page -- changes nothing.
- **Ordering** (`failover.ts`). The tie-break was the route id,
  alphabetically, which put the UK first for everybody on a new network.
  Now: a server that answered the probe much later than the quickest goes
  after the rest, then a per-install seed spreads customers. A pin brings
  the same country's other routes next. A remembered server that refuses
  every probe no longer leads, nor does one another working server has
  been measured at twice the speed of (`speedFor`).
- **Checks from inside the country** (`scripts/inside-probe`,
  `modules/inside-probe`). Every half hour the panel host asks each
  Iranian box, over SSH with a key whose only command is the check, to
  move 256 KB each way through every node's address (a TLS port whose
  fallback reaches the API mirror), and posts the result. The boxes hold
  nothing. Results go to the block watch's daily digest. It cannot see
  protocol-handshake blocks (WireGuard's) or blocks on our names.
- **Block alarm**: blank settings no longer become 0 (port 0, 0 days of
  history, alert after one failure), and most vantages failing is
  UNREACHABLE (finland1's 5-of-6 block read as DEGRADED).

Unverified: where the "slow" line should sit for home and mobile
networks (the hold was measured from data centres), and the whole data
check against a real held server -- nothing outside Iran is held.

Not built: a scan of several tunnels at once on a new network, to pick
the fastest before connecting. It needs new work in the Windows service
(a test path per concurrent exit) and in the phone engines.

## Server doors (2026-11-10)

The owner's decision: every VPN server is also a door to the panel API,
by address, and nothing about it is set by hand, because servers are
replaced often. The mirrors above are reached by name, and names are
what gets poisoned; the servers' addresses mostly stay reachable.

- **A door** is a server's address, a port where it already serves the
  API mirror, the SPKI pin of the key its certificate carries there (and
  the one before it, for a week after a change), and the server name to
  send in the hello, or none. No shared certificate and no new port: a
  key common to the fleet would let a scanner list it.
- **The backend learns it by asking the node** (`modules/node-doors`),
  every 15 minutes and about 45 seconds after a node comes online. It
  connects to the node's address under a neutral server name, on the
  port the door was last seen on, then the node's own TLS inbounds, then
  `NODE_DOOR_PORTS`. A port is a door only if its certificate chains to
  a public CA, is within its dates and names a host of ours -- a name the
  database records for that node (its mirror host, its TLS inbounds'
  server names, its IKEv2 name) or any host under `NODE_DOOR_DOMAINS` --
  and the API's health check answers through it. No agent, installer or
  node change. A check that fails writes nothing.
- **The apps get it with the server list they already keep**:
  `GET /customer/protocol-users`, as `connection.door =
  { host, port, pins, sni }` on each credential. Left out for a server
  whose door has not passed a check in the last hour, so an old app, and
  a new app against an old backend, see what they always saw.
- **Switches** (`infra/.env`, all optional): `NODE_DOORS=off` stops the
  checks and takes doors out of every answer; `NODE_DOOR_PORTS`,
  `NODE_DOOR_SNI`, `NODE_DOOR_DOMAINS`.
- **A renewal changes the pin.** certbot makes a new key each time, so a
  server's pin changes every couple of months. The backend sees it at
  the next check; an app holding the older list cannot open that
  server's door until it has fetched the list again, through another
  door, a name or the relay.

The apps' half (desktop and mobile, one shared library and one Rust
file compiled by both):

- **Order.** Names first, for everyone. Doors only when a request has
  failed at every name in the way only blocking explains
  (`everyRouteFailed` in `api.ts`) -- the moment that used to go straight
  to the relay of last resort. The relay stays last, and only for the
  calls it has always carried. A door carries every call, signed in or
  not: it is the same mirror, reached by pin instead of by name.
- **Which door** (`server-doors.ts`): the server this device last
  connected through on this network, then the door that last answered
  there, then the rest; one that has just failed goes to the back. Three
  doors and twelve seconds at most for one request. Where they all fail,
  they are left alone on that network for two minutes, doubling up to
  sixteen, so a network that drops everything still reaches the relay
  without paying for the doors each time.
- **Doors work here.** A door that answers is remembered per network for
  fifteen minutes: requests go to the doors first, and the names are
  asked again in the background every three minutes. A name answering
  ends it at once, and so does a tunnel.
- **Never with a tunnel up**, or one being brought up. With a tunnel
  nothing changes.
- **Writes are never sent twice.** A door that could not be connected
  to, or whose key was not the pinned one, was sent nothing, and the next
  is asked. Once a write has gone out and no answer came back, it goes to
  no other door, no name and not to the relay.
- **By pin alone** (`door_http.rs`, a command of its own beside the
  relay's): the server's address, the door's server name in the hello or
  none, TLS accepted only for a pinned key that also signs the
  handshake, HTTP/1.1, a connection per call, nothing outside `/api`, no
  redirects, no proxy, no lookup of the name. The pins come only from
  the API's own answers to a signed-in customer and the cache of them
  (`credential-cache.ts`); a sign-out forgets them.
- **A door's word on a session.** The pin says the answer came from our
  server, not that the server's mirror still points at the API, and a
  cached list can be older than whatever broke it. So, as for an address
  by name: a 401, 403 or 404 through a door starts nothing, and a refused
  token refresh ends the session only through a door the backend has
  otherwise answered through in this run, or once that same door has
  answered the public health check as the backend does. A customer is
  not signed out, on the one network where they could not sign in again,
  by a door that answers 401 to everything.
- **Reports.** A request's trace lists each door that was asked and how
  it ended (`door: address:port=pin@310 ...`), and none that was not.

Not built: sign-in and sign-up through a door (a signed-out device holds
no server list, so no door); the gaming profile's conditional read; a
second door per server.

Checked for real, read-only, from an unfiltered network: the backend's
check passes against live servers by address on both kinds of port (the
TLS inbound's fallback and nginx's own listener), with a neutral server
name and with none, and the two ports of one server present different
keys. Unverified: anything from inside a filtered network; the apps'
half against a real server (its pin check and server name are tested
over real TLS on loopback only, the rest against fakes); and whether a
door on a TLS inbound's port takes an HTTP/1.1 hello from the apps' TLS
library as it takes the backend's.
