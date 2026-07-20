# NeoConnect

Multi-protocol VPN reseller platform (control-plane backend + admin panel +
node agent + installer). See [docs/architecture.md](docs/architecture.md)
for the system design and build order.

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
- `agent/` — Go node agent daemon (`agentd`)
- `packages/proto` — agent<->backend wire contract (protobuf)
- `installer/` — bash installer + management menu for VPS nodes
- `infra/docker-compose.yml` — local Postgres + Redis for development

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

## Common commands

```bash
pnpm turbo run lint typecheck build test   # everything, TS side
cd agent && go vet ./... && go test ./...  # agent
```
