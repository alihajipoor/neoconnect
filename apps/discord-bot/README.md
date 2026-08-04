# @neoxify/discord-bot

Slash commands for the Neoxify Discord server, answering in the member's own
language.

The server's structure — channels, roles, the English/Persian split — is built
by `scripts/discord/`, which is a one-shot sync tool. This is the opposite: a
long-running process that answers questions. The two are independent; you can
run either without the other.

## Commands

| Command     | Answers                                                      |
| ----------- | ------------------------------------------------------------ |
| `/status`   | Node and route health, grouped by region                     |
| `/plans`    | What is on sale: price, duration, data, speed caps, devices   |
| `/download` | The current Windows installer URL                             |
| `/help`     | What to include in a support post, and what never to post     |

Replies are **ephemeral** — only the person who ran the command sees them.
These are lookups, and a channel filling with bot output nobody asked for is
its own kind of noise.

### Language

The bot answers in Persian to anyone holding the `فارسی` role and English to
everyone else, matching the channel split. It reads the member's **role**, not
Discord's client locale: the locale is whatever language their app happens to
be set to, while the role is what they deliberately chose during onboarding.

Role names are matched as strings, so the sync script recreating the roles does
not break the bot. They are defined in `src/i18n.ts` and must stay in step with
`roles` in `scripts/discord/config.mjs`.

## How it talks to the panel

Through `GET /integrations/*` on the backend, authenticated with a shared
secret in `X-Service-Token` (see `apps/backend/src/modules/integrations/`).

Those endpoints are **read-only by construction** — there is no write route in
that controller — and return only counts, regions, and public plan pricing. A
node's address, credentials, and any customer data are never selected, so a
leaked service token discloses facts that are already public in the Discord
channel rather than granting control of anything.

The bot deliberately does **not** hold an admin login. An admin JWT would carry
the whole panel's authority into a process whose hardest question is "how many
nodes are up".

## Configuration

| Variable                     | Required | Purpose                                        |
| ---------------------------- | -------- | ---------------------------------------------- |
| `DISCORD_BOT_TOKEN`          | yes      | Bot token from the Developer Portal            |
| `DISCORD_APPLICATION_ID`     | yes      | Application ID, same page                      |
| `DISCORD_GUILD_ID`           | yes      | The server to register commands to             |
| `NEOXIFY_API_URL`            | yes      | Backend base URL, e.g. `http://backend:4000`   |
| `INTEGRATIONS_SERVICE_TOKEN` | yes      | Must match the backend's value                 |
| `NEOXIFY_WEBSITE_URL`        | no       | Defaults to `https://neoxify.net`              |

Every required variable is checked at boot and the process exits if one is
missing. A bot that starts without an API URL looks healthy in `docker ps` and
answers every command with an error — a worse failure than not starting.

Generate the shared secret with:

```bash
openssl rand -hex 32
```

Set the same value as `INTEGRATIONS_SERVICE_TOKEN` on both the backend and the
bot. Until it is set on the backend, `/integrations/*` rejects everything —
it fails closed rather than falling open.

## Running it

Locally:

```bash
pnpm --filter @neoxify/discord-bot build
```

```bash
node apps/discord-bot/dist/index.js
```

In production, it is an optional compose service behind a profile, so a
deployment with no Discord server is unaffected:

```bash
docker compose -f infra/docker-compose.prod.yml --profile discord up -d --build
```

## Tests

```bash
pnpm --filter @neoxify/discord-bot test
```

Compiles to `dist-test/` first and runs `node --test` against the emitted JS.
That is not incidental: the source uses NodeNext, whose `.js` import
specifiers only resolve once emitted, and testing the compiled output means
the tests exercise exactly what ships.

Covered: language detection from roles, that every string has non-empty copy in
both languages and the Persian actually contains Persian script, embed
formatting (unlimited plans, half-capped speeds, Discord's 25-field limit), the
status colour thresholds, and that a status embed can never contain an IP
address.

## Intents

`Guilds` only. Every interaction arrives through the slash-command gateway,
which needs no privileged intent. Requesting `MessageContent` would mean a
Discord review and access to every message in the server, to gain nothing.

## What it does not do

No account linking. `/me`-style commands — your plan, your expiry, your devices
— need a Discord-to-customer mapping that does not exist in the schema yet, and
adding one means a migration against the production database plus a panel UI to
drive it. That is a deliberate decision to make on purpose, not to slip in.
