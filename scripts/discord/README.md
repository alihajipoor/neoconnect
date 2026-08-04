# Discord server setup

Builds and maintains the Neoxify community server from a config file instead of
by hand: identity and icon, roles, categories, text/voice/forum/stage channels,
the permission matrix, the **English/Persian language split**, onboarding, the
welcome screen, AutoMod, and the channel header posters.

It is **additive and idempotent**. Roles and channels are matched by name:
missing ones are created, existing ones are updated in place, and anything on
the server the config does not mention is left alone. Nothing is ever deleted,
so it is safe to run against a server that is already set up, and safe to run
twice.

- `config.mjs` — the desired server shape. This is the file you edit.
- `content.mjs` — starter posts and the poster-to-channel mapping.
- `posters.mjs` — renders `posters/*.png` from the brand mark.
- `sync.mjs` — the engine.

## The language split

New members answer one **required** onboarding prompt — English or فارسی —
before anything else. That grants a language role, and the role is what makes
the matching channels visible. An English speaker never sees the Persian
channels; a Persian speaker never sees the English ones. **Staff see both.**

Set it on a channel or category with `lang: "en"` or `lang: "fa"`. The preset
still controls posting rules; the language gate only controls who can see it.

A **shared core** stays visible to everyone whatever they picked:
`welcome`, `announcements`, `releases`, `server-status`, `lounge`, `showcase`,
`suggestions`, `bug-reports`, `off-topic`. That is not a design preference —
Discord refuses to enable onboarding unless enough channels are visible and
postable by `@everyone`, so gating literally everything would break the very
prompt that does the gating. The shared channels are the ones where language
matters least: images, votes, and bug reports.

Members can change their language any time from **Channels & Roles** at the top
of the channel list.

## One-time setup

**1. Create the bot** at <https://discord.com/developers/applications> →
_New Application_ → _Bot_ → _Reset Token_ → copy it. Treat the token like a
password; reset it when you are done.

**2. Invite it**, replacing `YOUR_CLIENT_ID` with the _Application ID_:

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot&permissions=8
```

**3. Drag the bot's role to the top** of _Server Settings → Roles_.

This step is unavoidable and needs a human. Discord will not let a bot move any
role to or above its own, and it cannot promote itself — Administrator makes no
difference. Two traps worth knowing:

- **New roles are all created at `position: 1`**, tied with each other. A tied
  role *looks* correctly ordered in the UI, because Discord displays ties in
  creation order, while having no real rank. Permission checks use `position`
  alone and ignore that display order, so tied staff roles cannot moderate each
  other's members.
- **Discord only writes real position numbers when a role actually moves.**
  Dragging the top role to the top is a no-op. If everything is tied, drag some
  *other* role to a clearly different slot — that forces a renumber of the whole
  list.

`sync.mjs inspect` prints the true positions. Trust it over the UI.

## Running it

```powershell
$env:DISCORD_BOT_TOKEN = 'your-token-here'
```

```bash
node scripts/discord/sync.mjs inspect
```

Dumps the server as it is: roles with real positions, channels by category,
whether Community is on, existing AutoMod rules. Read-only. Start here.

```bash
node scripts/discord/sync.mjs plan
```

Lists what `apply` would create and change. Writes nothing.

```bash
node scripts/discord/sync.mjs apply
```

Makes it so.

```bash
node scripts/discord/sync.mjs seed-content
```

Posts the header posters and starter text into the read-only channels. Skips any
channel that already has a post from this bot. Add `--replace` to delete this
bot's own previous posts first and repost — it never touches a message written
by a person.

If the bot is in more than one server, set `DISCORD_GUILD_ID` to pick one.

## What `apply` does, in order

1. **Renames the server** and sets the icon (only if the server has none, so a
   hand-picked icon is never clobbered).
2. **Roles** — create/update, then order them under the bot's role. Skipped with
   an explanation if the bot's role is not high enough.
3. **Categories, text and voice channels.**
4. **Enables Community** — see the warning below.
5. **Forum, media, stage and announcement channels**, which cannot exist before
   step 4.
6. **Welcome screen, onboarding, AutoMod.** Enhancements: if Discord rejects
   one, it reports itself and the rest of the run stands.

### Enabling Community changes two server-wide settings

Discord requires them, so `apply` sets both and says so:

- **Verification level → Low**
- **Explicit media filter → scan everyone**

It also sets default notifications to **mentions only**. Change any of them back
in Server Settings; the sync will not re-apply them once Community is on.

## What gets built

**Roles**, highest first. Colours are the product palette from
`apps/panel/src/app/globals.css`.

| Role              | Colour    | Hoisted | Purpose                                  |
| ----------------- | --------- | ------- | ---------------------------------------- |
| Founder           | `#5b21b6` | yes     | Administrator                            |
| Neoxify Team      | `#8b5cf6` | yes     | Administrator                            |
| Moderator         | `#22d3ee` | yes     | Kick/ban/timeout, message and voice mod  |
| Support           | `#38bdf8` | yes     | Thread/message management, move in voice |
| Beta Tester       | `#f59e0b` | yes     | Unlocks the private BETA category        |
| Subscriber        | `#34d399` | yes     | Members with an active plan              |
| English           | none      | no      | Language gate — grants the 🇬🇧 channels   |
| فارسی             | none      | no      | Language gate — grants the 🇮🇷 channels   |
| Announcement Ping | none      | no      | Opt-in, product news                     |
| Release Ping      | none      | no      | Opt-in, new app builds                   |
| Status Ping       | none      | no      | Opt-in, outages                          |

The language and ping roles are colourless and unhoisted so they never override
a member's real role colour. Language roles carry **no permissions of their own**
— they exist only to make channels visible.

**Channels**

- **🏠 START HERE** *(shared)* — `welcome` (bilingual rules), `announcements`,
  `releases`, `server-status`.
- **🌍 SHARED** — `lounge`, `showcase` (gallery forum), `suggestions` (forum),
  `bug-reports` (forum), `off-topic`.
- **🇬🇧 ENGLISH** *(gated)* — `general`, `setup-and-tips`, `speed-and-routing`,
  `split-tunneling`, `get-help` (forum), `faq`, `resources`, `English Voice`.
- **🇮🇷 فارسی** *(gated)* — mirrors the English set: `گفتگو`, `نصب-و-راهنما`,
  `سرعت-و-مسیر`, `تونل-تفکیکی`, `پشتیبانی` (forum), `سوالات-متداول`, `منابع`,
  `گفتگوی-صوتی`.
- **🔊 VOICE** *(shared)* — `Lobby`, `Community 1`, `Community 2`,
  `Support Room` (capped at 4), `Community Stage`, `Beta Room`, `AFK`.
- **🧪 BETA** — private to Beta Tester and staff.
- **🔒 STAFF** — private.

Support runs on **forum channels**, one per language: one post per problem,
tagged, with `Solved` / `Needs Info` reserved for moderators.

**AutoMod** — six rules, staff exempt, alerts to `mod-log`. The first blocks
pasted credentials (`vless://`, `vmess://`, `trojan://`, PEM keys, WireGuard
`[Interface]` blocks). A VPN server attracts people pasting their own
subscription link into a public channel, which hands over their account. The
account-trading rule carries Persian keywords as well as English.

**Posters** — `posters.mjs` renders branded PNG headers from the same logo
geometry the app uses, including RTL Persian. The rendered files are committed
so a sync needs no build step. To change them:

```bash
npm install @resvg/resvg-js && node scripts/discord/posters.mjs
```

## Notes

- **Server-wide `@everyone` permissions are never touched** — only per-channel
  overwrites.
- **Existing role permissions are widened, never narrowed.**
- **An adopted channel keeps its type.** A text channel where the config wants a
  forum is renamed and moved but stays text — converting would discard history.
- **Emoji prefixes are cosmetic.** The matcher strips them, so `💬・general`
  finds an existing `general`. This works for Persian names too.
- Removing an entry from `config.mjs` does not remove it from the server —
  delete it in Discord yourself, deliberately.
