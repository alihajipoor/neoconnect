# NeoConnect

Multi-protocol VPN platform, sold as **Neoxify**: a control-plane backend,
an admin panel, a Go node agent, and native Windows and Android clients.
See
[docs/architecture.md](docs/architecture.md) for the system design and
build order.

The repository, its module names and its `neoconnect://` URL scheme keep
the original name deliberately -- renaming identifiers that are baked into
installed clients and enrolled nodes would break both.

## What it does today

**Protocols.** VLESS+REALITY, VLESS+TLS (over TCP *or* inside a
WebSocket), Trojan, Shadowsocks 2022, WireGuard and OpenVPN -- all
provisioned per customer without restarting the engine or disturbing
anyone else on the node. Relayed routes chain an Iran-reachable entry node
to an exit node abroad.

The WebSocket variant shares the VLESS+TLS port and certificate rather
than taking one of its own, routed by a path-keyed Xray fallback: a second
public port is a second thing for a censor to fingerprint, while an HTTP
upgrade on a normal HTTPS port is what ordinary web applications do.
Shadowsocks 2022 is the opposite trade -- no handshake to fingerprint at
all, but nothing to hide behind either once the port is found, so it sits
late in the failover ladder rather than early.

Deliberately absent: PPTP, L2TP, SSTP, IKEv2 and ShadowsocksR. PPTP's
MS-CHAPv2 is broken well enough to be cracked in hours, so offering it
would sell the appearance of protection; SSR is abandoned upstream and
already fingerprinted; the rest use fixed ports that are among the first
blocked, which is the opposite of the point.

**Clients.** A Windows client (`apps/desktop-windows`, Tauri) that signs
in, buys a plan, picks a location, connects, and updates itself. It walks
the protocol ladder automatically when one is blocked, and says which one
it landed on rather than claiming success silently.

An Android client (`apps/mobile`, Tauri) sharing the Windows client's
screens by direct import rather than by copy -- everything but the
dashboard, which drives a `VpnService` instead of a privileged Windows
service. Four of the five protocols: WireGuard via the maintainers'
own embeddable tunnel library, and Stealth, Stealth HTTPS and Stealth
Lite via xray-core compiled into the app with gomobile. OpenVPN is
absent for a licensing reason, not an unfinished one -- the usable
Android implementation is GPLv2.

**Custom mode.** Per-application split tunnel -- route one game or one
browser and leave everything else alone. On Windows it follows whichever
protocol is active and fails open while reconnecting (the UI says so); on
Android the platform's own allow-list does the same job, so there is no
reconnect window to leak through.

**Billing.** Stripe and NowPayments, invoices with a printable branded
document, and vouchers that grant a plan without payment (one-time,
expiring, or unlimited).

**Plans.** Duration, data cap (or unlimited), concurrent-connection limit
and per-user speed caps. Speed caps are enforced on WireGuard and OpenVPN
only -- see the open item in the plan file.

**Customer-facing.** Self-signup with email verification, an optional free
trial, referrals, and in-app support conversations answered from the
panel.

## Deploying to a real Linux server

`installer/install.sh` is the single entrypoint for both server roles:

```bash
git clone https://github.com/alihajipoor/neoconnect.git
cd neoconnect/installer
sudo ./install.sh
```

On a fresh box it asks which role this server plays:

- **Main Panel Server** — installs Docker, builds and starts the backend +
  panel + Postgres + Redis stack (`infra/docker-compose.prod.yml`), then
  installs nginx + Let's Encrypt for HTTPS on a domain you provide, and
  seeds the first admin account. Must be run from inside a checked-out
  copy of the repo (as above) since it builds the Docker images from
  source.
- **VPN Agent Node** — downloads the compiled `agentd` binary (no source
  checkout needed) and walks through enrollment with the panel.

Re-running `sudo ./install.sh` on an already-installed box shows that
role's management menu (status/logs, rebuild, uninstall, etc.) instead of
asking again — the chosen role is recorded in `/etc/neoxify/role`.

A node enrolled before that marker existed has no such file. It is still
not asked: an agent is recognised by the `/etc/neoxify/agent.json` it
wrote at enrollment, and the marker is filled in. This matters because
the only sensible answer to the role question re-runs the full install,
which would re-enroll a node that is already serving customers.

### Deploying an update to a running panel server

```bash
cd /root/neoconnect          # wherever the repo was checked out
git pull --ff-only origin main
docker compose -f infra/docker-compose.prod.yml up -d --build backend
```

`infra/docker-compose.prod.yml`, **not** `infra/docker-compose.yml` — the
latter is the local-development stack further down this file and contains
only Postgres, Redis and MailHog, so `up --build backend` against it fails
with `no such service: backend`. That mistake is easy to make from a
grep, which is why it is written down here.

Name the service you actually changed (`backend`, `panel`,
`discord-bot`); rebuilding all of them takes far longer for no benefit.
The project name is pinned as `name: neoxify` at the top of the prod
compose file, so this targets the running containers whatever the
checkout directory is called — without that, compose would derive the
project from the directory and start a *second* stack alongside the live
one.

**Check for schema changes first.** `git diff <deployed>..origin/main --
apps/backend/prisma/` — if it is non-empty the migration has to be run
against production before the new image starts, or the container comes up
against a schema it does not expect.

The API is not in the VPN data path: customer tunnels stay up across a
backend restart, and only the panel and API blink for a few seconds.

### Inbound ports your provider must allow

Most cloud providers attach a firewall that permits only 22/80/443 and
silently drops everything else. The installer cannot see or change it, and
the symptom is specific and confusing: the panel works perfectly in a
browser while every node sits `PENDING` forever, because the one port the
agents need is the one being dropped. Check this before debugging
anything else.

**Panel server**

| Port | Proto | Why |
|---|---|---|
| 22 | TCP | SSH |
| 80 | TCP | Let's Encrypt HTTP-01, and the redirect to HTTPS |
| 443 | TCP | Panel and API |
| **50051** | **TCP** | **Agent gRPC. Nothing works without it and nothing else uses it.** |

Ports 3000 and 4000 are the panel and backend containers. They bind to
`127.0.0.1` deliberately — nginx proxies them, and they must *not* be
reachable from outside.

**Agent node** — whatever the installer was told to listen on, which is
443 for REALITY plus any of: 2053 (VLESS+TLS, and the WebSocket path that
shares it), 8443 (Trojan), the Shadowsocks port you chose, 51820/udp
(WireGuard) and 1194/udp (OpenVPN).

## Repo layout

- `apps/backend` — NestJS control-plane API
- `apps/panel` — Next.js admin dashboard
- `apps/desktop-windows` — Tauri Windows client, its LocalSystem helper
  service, and the branded installer bootstrapper
- `apps/mobile` — Tauri Android client; `plugins/vpn` inside it is the
  Kotlin VpnService bridge
- `agent/` — Go node agent daemon (`agentd`)
- `packages/proto` — agent<->backend wire contract (protobuf)
- `installer/` — bash installer + management menu for VPS nodes
- `infra/docker-compose.yml` — local Postgres + Redis for development
- `scripts/` — repo-wide checks run by CI
- `brand/` — store-listing art, and the script that renders it from the
  mark's own geometry (see `brand/README.md`)

## Prerequisites

- Node.js 20+, [pnpm](https://pnpm.io) 9+ (`npm install -g pnpm`)
- Go 1.23+
- Docker (for local Postgres/Redis) — or point `DATABASE_URL`/`REDIS_URL`
  at instances you already have running

## Getting started

```bash
pnpm install

# local Postgres + Redis
docker compose -f infra/docker-compose.yml up -d

# backend
cp apps/backend/.env.example apps/backend/.env   # edit DATABASE_URL etc.
pnpm --filter @neoxify/backend prisma:migrate
pnpm --filter @neoxify/backend dev               # http://localhost:4000, docs at /docs

# panel
pnpm --filter @neoxify/panel dev                 # http://localhost:3000

# agent (Go)
cd agent && go build ./...
```

## Releasing the Windows client

One command. Bump the version in **all three** of
`apps/desktop-windows/package.json`, `src-tauri/Cargo.toml` and
`src-tauri/tauri.conf.json`, commit, then:

```bash
git tag desktop-v0.8.2 && git push origin desktop-v0.8.2
```

GitHub Actions builds and publishes the branded installer, the raw NSIS
installer, its updater signature and checksums. The API reads the newest
`desktop-v*` release and offers it to running clients, which download in
the background and install on request.

The workflow **refuses a tag whose version disagrees with the app's**,
because a mismatch makes the updater offer the same build forever. The
website should link to
`https://github.com/alihajipoor/neoconnect/releases/latest/download/Neoxify-Setup.exe`,
which never needs changing.

The updater's signing key is separate from any Authenticode certificate
and is **not recoverable**: losing it means already-installed clients can
never be updated again.

### Repairing a customer's networking

Some faults outlive the app. A leftover NRPT DNS rule points the whole
machine's lookups at a resolver it can no longer reach and survives both
a reboot and Windows' own network reset; a stranded
`WireGuardTunnel$neoconnect` service takes the default route on every
boot; routes stay on an adapter whose engine is gone. Every one of those
is torn down on the normal paths -- but a service that will not start
never runs its start-up reconcile, and a wedged one never answers a
disconnect. That gap is what "I had to reset my network settings and
uninstall it" in a customer report means.

Two ways out, and they run the same code
(`service/src/engines/repair.rs`):

- **In the app** -- Settings -> Repair network, and offered directly in
  the connect-failure message so somebody who cannot connect does not
  have to go looking. Goes through the running service.
- **From an administrator command prompt**, when the service is itself
  the broken thing:

  ```
  "C:\Program Files\Neoxify\resources\neoconnect-service.exe" repair
  ```

  Stops the service, performs the whole teardown, starts it again, and
  prints what it found step by step. Exit code 0 when everything was
  either already clean or repaired, 1 when something could not be, 2
  when it was not run elevated. A full record is appended to
  `C:\ProgramData\Neoxify\cleanup.log`.

Every step is independent and non-fatal, and nothing it does can leave a
machine more restricted than it found it -- it only ever removes. A step
that could not be checked reports "couldn't check" rather than borrowing
a tick from the ones that could.

Support can also ask a customer for the snapshot behind **Support ->
Send us your details**: adapters present, our routes, NRPT rules,
firewall rule, orphaned engines, and the tail of `cleanup.log`. It is
built from named fields only and carries no credentials, keys or
protocol config, and the customer reads the whole thing before copying
it.

## Releasing the Android client

Same shape, own tag prefix. Bump the version in
`apps/mobile/package.json`, `src-tauri/Cargo.toml` and
`src-tauri/tauri.conf.json`, commit, then:

```bash
git tag android-v0.1.0 && git push origin android-v0.1.0
```

GitHub Actions compiles xray-core with gomobile, builds and signs
`Neoxify-<version>.apk`. The download
link is `https://connect.neoxify.site/api/updates/installer/android`, which
resolves to the newest `android-v*` release.

There is no silent in-app update, and that is a platform limit rather than
something left undone: Android will not let an app replace its own APK
without the system installer's confirmation.

Two secrets are required, and the workflow refuses to publish without
them: `ANDROID_KEYSTORE_BASE64` and `ANDROID_KEYSTORE_PASSWORD`. **The
keystore is not recoverable.** Android identifies an app by its signing
key, so losing it means every installed copy is stranded -- a rebuild
signed with a new key is a different package with no upgrade path.

## Keeping the installer honest

`installer/install.sh` must be able to build a working server from
nothing, which is easy to break because nobody installs from scratch --
production is upgraded in place. `scripts/check-installer-drift.sh` runs
in CI and fails when the backend reads an environment variable the
installer never creates. Adding a new secret means adding an
`ensure_env_key` line to `generate_panel_secrets()` in
`installer/lib/panel.sh`; it appends only what is missing, so existing
servers pick it up on the next run.

Database migrations need no installer change: the backend applies them on
startup.

## Common commands

```bash
pnpm turbo run lint typecheck build test   # everything, TS side
cd agent && go vet ./... && go test ./...  # agent
bash scripts/check-installer-drift.sh      # installer covers every env var
```
