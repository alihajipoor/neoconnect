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

**Protocols.** VLESS+REALITY, VLESS+TLS, Trojan, WireGuard and OpenVPN,
all provisioned per customer without restarting the engine or disturbing
anyone else on the node. Relayed routes chain an Iran-reachable entry node
to an exit node abroad.

**Clients.** A Windows client (`apps/desktop-windows`, Tauri) that signs
in, buys a plan, picks a location, connects, and updates itself. It walks
the protocol ladder automatically when one is blocked, and says which one
it landed on rather than claiming success silently.

An Android client (`apps/mobile`, Tauri) sharing the Windows client's
screens by direct import rather than by copy -- everything but the
dashboard, which drives a `VpnService` instead of a privileged Windows
service. WireGuard only so far, via WireGuard's own embeddable tunnel
library.

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

## Releasing the Android client

Same shape, own tag prefix. Bump the version in
`apps/mobile/package.json`, `src-tauri/Cargo.toml` and
`src-tauri/tauri.conf.json`, commit, then:

```bash
git tag android-v0.1.0 && git push origin android-v0.1.0
```

GitHub Actions builds and signs `Neoxify-<version>.apk`. The download
link is `https://connect.neoxify.com/api/updates/installer/android`, which
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
