#!/usr/bin/env node
/**
 * Makes a Discord server match scripts/discord/config.mjs.
 *
 * Additive and idempotent by design. Roles and channels are matched by name;
 * missing ones are created, existing ones are updated in place, and anything
 * on the server that this config does not mention is left untouched. Running
 * it twice is a no-op. Nothing is ever deleted.
 *
 * Usage:
 *   DISCORD_BOT_TOKEN=... node scripts/discord/sync.mjs inspect
 *   DISCORD_BOT_TOKEN=... node scripts/discord/sync.mjs plan
 *   DISCORD_BOT_TOKEN=... node scripts/discord/sync.mjs apply
 *   DISCORD_BOT_TOKEN=... node scripts/discord/sync.mjs seed-content
 *
 * DISCORD_GUILD_ID is optional when the bot is in exactly one server.
 */

import { pathToFileURL } from "node:url";

import { readFile } from "node:fs/promises";

import {
  guild as guildConfig,
  roles as roleConfig,
  staffKeys,
  structure,
  specialChannels,
  welcomeScreen,
  onboarding,
  autoMod,
  TEXT,
  VOICE,
  CATEGORY,
  ANNOUNCEMENT,
  STAGE,
  FORUM,
  MEDIA,
} from "./config.mjs";
import { channelContent, channelPosters } from "./content.mjs";

const API = "https://discord.com/api/v10";
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const REASON = "Neoxify server sync";

/** Channel types Discord only allows once the server is a Community. */
const COMMUNITY_TYPES = new Set([ANNOUNCEMENT, STAGE, FORUM, MEDIA]);

/** Types that hold messages, for name matching and content seeding. */
const MESSAGE_TYPES = new Set([TEXT, ANNOUNCEMENT]);

/** Where to land when a server rejects a channel type outright (error 50024). */
const FALLBACK_TYPE = {
  [MEDIA]: TEXT,
  [FORUM]: TEXT,
  [ANNOUNCEMENT]: TEXT,
  [STAGE]: VOICE,
};

/** Discord permission flags, as bit positions. */
const PERMISSION_BITS = {
  CREATE_INSTANT_INVITE: 0n,
  KICK_MEMBERS: 1n,
  BAN_MEMBERS: 2n,
  ADMINISTRATOR: 3n,
  MANAGE_CHANNELS: 4n,
  MANAGE_GUILD: 5n,
  ADD_REACTIONS: 6n,
  VIEW_AUDIT_LOG: 7n,
  PRIORITY_SPEAKER: 8n,
  STREAM: 9n,
  VIEW_CHANNEL: 10n,
  SEND_MESSAGES: 11n,
  MANAGE_MESSAGES: 13n,
  EMBED_LINKS: 14n,
  ATTACH_FILES: 15n,
  READ_MESSAGE_HISTORY: 16n,
  MENTION_EVERYONE: 17n,
  USE_EXTERNAL_EMOJIS: 18n,
  CONNECT: 20n,
  SPEAK: 21n,
  MUTE_MEMBERS: 22n,
  DEAFEN_MEMBERS: 23n,
  MOVE_MEMBERS: 24n,
  USE_VAD: 25n,
  MANAGE_NICKNAMES: 27n,
  MANAGE_ROLES: 28n,
  USE_APPLICATION_COMMANDS: 31n,
  REQUEST_TO_SPEAK: 32n,
  MANAGE_THREADS: 34n,
  CREATE_PUBLIC_THREADS: 35n,
  CREATE_PRIVATE_THREADS: 36n,
  SEND_MESSAGES_IN_THREADS: 38n,
  MODERATE_MEMBERS: 40n,
};

export function permissions(...names) {
  let mask = 0n;
  for (const name of names) {
    const bit = PERMISSION_BITS[name];
    if (bit === undefined) throw new Error(`Unknown permission: ${name}`);
    mask |= 1n << bit;
  }
  return mask;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One REST call, with the failure modes that actually happen: 429 rate limits
 * (Discord tells us exactly how long to wait) and transient 5xx.
 */
async function api(method, path, body) {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bot ${TOKEN}`,
        "Content-Type": "application/json",
        "X-Audit-Log-Reason": REASON,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (res.status === 429) {
      const info = await res.json().catch(() => ({}));
      await sleep(Math.ceil((info.retry_after ?? 1) * 1000) + 250);
      continue;
    }
    if (res.status >= 500 && attempt < 3) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (res.status === 401) {
      throw new Error(
        "Discord rejected the bot token (401).\n" +
          "Check DISCORD_BOT_TOKEN is the *bot* token from the Bot tab -- not the client secret,\n" +
          "and not the application id. Reset it there if you are unsure.",
      );
    }
    if (res.status === 403) {
      throw new Error(
        `Discord refused ${method} ${path} (403 Forbidden).\n` +
          "Usually this means the bot was invited without Administrator, or its own role sits\n" +
          "below the role it is trying to change. See steps 2 and 3 in README.md.",
      );
    }
    if (!res.ok) {
      throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
    }
    return res.status === 204 ? null : res.json();
  }
}

/**
 * Uploads a message with a file attached. Discord takes attachments as
 * multipart/form-data, which is why this cannot go through `api()`.
 */
async function apiUpload(path, { content, filename, bytes }) {
  const form = new FormData();
  form.append(
    "payload_json",
    JSON.stringify({
      ...(content ? { content } : {}),
      attachments: [{ id: 0, filename }],
      allowed_mentions: { parse: [] },
    }),
  );
  form.append("files[0]", new Blob([bytes]), filename);

  const res = await fetch(API + path, {
    method: "POST",
    headers: { Authorization: `Bot ${TOKEN}` },
    body: form,
  });
  if (!res.ok) throw new Error(`POST ${path} (upload) -> ${res.status} ${await res.text()}`);
  return res.json();
}

/** Reads a file from the repo, resolved relative to the repo root. */
function repoFile(relativePath) {
  return readFile(new URL(`../../${relativePath}`, import.meta.url));
}

/**
 * Names are compared with emoji, separators, and case stripped, so the config's
 * `💬・general` matches a channel already called `general` and renames it in
 * place instead of creating a second one.
 */
export function normalise(name) {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function findByName(items, name, predicate = () => true) {
  const target = normalise(name);
  return items.find((item) => predicate(item) && normalise(item.name) === target);
}

/** A configured channel matches a live one of the same broad kind. A text
 *  channel may be adopted by an announcement/forum entry and vice versa, since
 *  Discord can convert between them and we would rather rename than duplicate. */
function channelMatcher(configured) {
  if (configured.type === VOICE || configured.type === STAGE) {
    return (c) => c.type === VOICE || c.type === STAGE;
  }
  if (configured.type === CATEGORY) return (c) => c.type === CATEGORY;
  return (c) => c.type === TEXT || c.type === ANNOUNCEMENT || c.type === FORUM || c.type === MEDIA;
}

// ---------------------------------------------------------------------------
// Permission presets
// ---------------------------------------------------------------------------

const TALK = [
  "SEND_MESSAGES",
  "READ_MESSAGE_HISTORY",
  "ADD_REACTIONS",
  "ATTACH_FILES",
  "EMBED_LINKS",
  "CREATE_PUBLIC_THREADS",
  "SEND_MESSAGES_IN_THREADS",
  "USE_EXTERNAL_EMOJIS",
];
const VOICE_USE = ["CONNECT", "SPEAK", "USE_VAD", "STREAM"];
const STAFF_KEYS = staffKeys;
const VIEW_CHANNEL = permissions("VIEW_CHANNEL");

/**
 * Expands a preset name into Discord permission overwrites.
 * `roleId` resolves a config role key to its live snowflake; `everyoneId` is
 * the @everyone role, whose id is always the guild id.
 */
export function overwritesFor(preset, roleId, everyoneId, lang) {
  const base = basePreset(preset, roleId, everyoneId);
  return lang ? gateToLanguage(base, roleId, everyoneId, lang) : base;
}

/**
 * Hides a channel from @everyone and hands its permissions to one language
 * role instead. Whatever @everyone was going to get becomes what speakers of
 * that language get, plus VIEW_CHANNEL; staff keep full sight of both halves
 * of the server so they can moderate a language they may not read.
 */
function gateToLanguage(base, roleId, everyoneId, lang) {
  const langRoleId = roleId(lang);
  if (!langRoleId) throw new Error(`No role configured for language "${lang}"`);

  const everyone = base.find((o) => o.id === everyoneId);
  const others = base.filter((o) => o.id !== everyoneId && o.id !== langRoleId);

  const allow = (BigInt(everyone?.allow ?? 0n) | VIEW_CHANNEL).toString();
  const deny = (BigInt(everyone?.deny ?? 0n) & ~VIEW_CHANNEL).toString();

  const staffSight = STAFF_KEYS.map((key) => roleId(key))
    .filter((id) => id && !others.some((o) => o.id === id))
    .map((id) => ({ id, type: 0, allow: permissions("VIEW_CHANNEL", ...TALK, ...VOICE_USE).toString(), deny: "0" }));

  return [
    { id: everyoneId, type: 0, allow: "0", deny: VIEW_CHANNEL.toString() },
    { id: langRoleId, type: 0, allow, deny },
    ...others,
    ...staffSight,
  ];
}

function basePreset(preset, roleId, everyoneId) {
  const entry = (id, allow, deny) => ({
    id,
    type: 0,
    allow: allow.toString(),
    deny: deny.toString(),
  });
  const staff = (allow) =>
    STAFF_KEYS.map((key) => roleId(key)).filter(Boolean).map((id) => entry(id, allow, 0n));

  switch (preset) {
    case "public":
      return [entry(everyoneId, permissions("VIEW_CHANNEL", ...TALK), 0n)];

    case "readonly":
      return [
        entry(
          everyoneId,
          permissions("VIEW_CHANNEL", "READ_MESSAGE_HISTORY", "ADD_REACTIONS"),
          permissions("SEND_MESSAGES", "CREATE_PUBLIC_THREADS", "CREATE_PRIVATE_THREADS", "SEND_MESSAGES_IN_THREADS"),
        ),
        ...staff(permissions("VIEW_CHANNEL", ...TALK, "MANAGE_MESSAGES", "MENTION_EVERYONE")),
      ];

    case "staffOnly":
      return [
        entry(everyoneId, 0n, permissions("VIEW_CHANNEL")),
        ...staff(permissions("VIEW_CHANNEL", ...TALK)),
      ];

    case "betaOnly":
      return [
        entry(everyoneId, 0n, permissions("VIEW_CHANNEL")),
        entry(roleId("beta"), permissions("VIEW_CHANNEL", ...TALK), 0n),
        ...staff(permissions("VIEW_CHANNEL", ...TALK, "MANAGE_MESSAGES")),
      ];

    case "betaReadonly":
      return [
        entry(everyoneId, 0n, permissions("VIEW_CHANNEL")),
        entry(
          roleId("beta"),
          permissions("VIEW_CHANNEL", "READ_MESSAGE_HISTORY", "ADD_REACTIONS"),
          permissions("SEND_MESSAGES", "CREATE_PUBLIC_THREADS", "SEND_MESSAGES_IN_THREADS"),
        ),
        ...staff(permissions("VIEW_CHANNEL", ...TALK, "MANAGE_MESSAGES")),
      ];

    case "voicePublic":
      return [entry(everyoneId, permissions("VIEW_CHANNEL", "READ_MESSAGE_HISTORY", ...VOICE_USE), 0n)];

    case "voiceStaff":
      return [
        entry(everyoneId, 0n, permissions("VIEW_CHANNEL", "CONNECT")),
        ...staff(permissions("VIEW_CHANNEL", "READ_MESSAGE_HISTORY", ...VOICE_USE)),
      ];

    case "voiceBeta":
      return [
        entry(everyoneId, 0n, permissions("VIEW_CHANNEL", "CONNECT")),
        entry(roleId("beta"), permissions("VIEW_CHANNEL", "READ_MESSAGE_HISTORY", ...VOICE_USE), 0n),
        ...staff(permissions("VIEW_CHANNEL", "READ_MESSAGE_HISTORY", ...VOICE_USE)),
      ];

    // A stage is listen-by-default: everyone can hear and ask to speak, only
    // staff take the stage without being invited up.
    case "stagePublic":
      return [
        entry(
          everyoneId,
          permissions("VIEW_CHANNEL", "CONNECT", "REQUEST_TO_SPEAK", "USE_VAD"),
          permissions("SPEAK"),
        ),
        ...staff(permissions("VIEW_CHANNEL", "CONNECT", "SPEAK", "MUTE_MEMBERS", "MOVE_MEMBERS", "STREAM")),
      ];

    default:
      throw new Error(`Unknown preset: ${preset}`);
  }
}

// ---------------------------------------------------------------------------
// Guild state
// ---------------------------------------------------------------------------

let cachedBotUserId = null;

/** The bot's own user id, fetched once per run. */
async function botUserId() {
  cachedBotUserId ??= (await api("GET", "/users/@me")).id;
  return cachedBotUserId;
}

/**
 * The position of the bot's own highest role. Must be read fresh: creating a
 * role pushes every existing role up one, so a value captured before the role
 * pass is stale by exactly the number of roles created.
 */
async function botTopPosition(guildId) {
  // `@me` is only a valid stand-in on /users/@me -- the members endpoint wants
  // a real snowflake, so resolve the bot's own id first.
  const userId = await botUserId();
  const [liveRoles, member] = await Promise.all([
    api("GET", `/guilds/${guildId}/roles`),
    api("GET", `/guilds/${guildId}/members/${userId}`),
  ]);
  return liveRoles
    .filter((role) => member.roles.includes(role.id))
    .reduce((highest, role) => Math.max(highest, role.position), 0);
}

async function resolveGuild() {
  const guilds = await api("GET", "/users/@me/guilds");
  const wanted = process.env.DISCORD_GUILD_ID;

  if (wanted) {
    const match = guilds.find((g) => g.id === wanted);
    if (!match) {
      throw new Error(
        `The bot is not a member of guild ${wanted}. It is in: ` +
          (guilds.map((g) => `${g.name} (${g.id})`).join(", ") || "no servers at all"),
      );
    }
    return match;
  }
  if (guilds.length === 0) {
    throw new Error("The bot is not in any server yet. Invite it first (see README.md).");
  }
  if (guilds.length > 1) {
    throw new Error(
      "The bot is in more than one server, so set DISCORD_GUILD_ID to pick one:\n" +
        guilds.map((g) => `  ${g.id}  ${g.name}`).join("\n"),
    );
  }
  return guilds[0];
}

async function loadState(guildId) {
  const [liveRoles, liveChannels, botTop, full] = await Promise.all([
    api("GET", `/guilds/${guildId}/roles`),
    api("GET", `/guilds/${guildId}/channels`),
    botTopPosition(guildId),
    api("GET", `/guilds/${guildId}`),
  ]);

  return { liveRoles, liveChannels, botTop, full };
}

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

const TYPE_LABELS = {
  [TEXT]: "text",
  [VOICE]: "voice",
  [CATEGORY]: "category",
  [ANNOUNCEMENT]: "announce",
  [STAGE]: "stage",
  [FORUM]: "forum",
  [MEDIA]: "media",
};

async function inspect(guild) {
  const { liveRoles, liveChannels, botTop, full } = await loadState(guild.id);

  console.log(`\nServer: ${full.name}  (${guild.id})`);
  console.log(`Community enabled: ${full.features.includes("COMMUNITY") ? "yes" : "no"}`);
  console.log(`Bot's highest role position: ${botTop}\n`);

  console.log("Roles, highest first:");
  for (const role of [...liveRoles].sort((a, b) => b.position - a.position)) {
    const colour = role.color ? `#${role.color.toString(16).padStart(6, "0")}` : "no colour";
    const managed = role.managed ? "  [bot/integration]" : "";
    console.log(`  ${String(role.position).padStart(3)}  ${role.name.padEnd(24)} ${colour}${managed}`);
  }

  const categories = liveChannels.filter((c) => c.type === CATEGORY).sort((a, b) => a.position - b.position);
  const orphans = liveChannels.filter((c) => c.type !== CATEGORY && !c.parent_id);

  console.log("\nChannels:");
  const printChannel = (c) => console.log(`    ${(TYPE_LABELS[c.type] ?? c.type).padEnd(9)} ${c.name}`);
  for (const c of orphans.sort((a, b) => a.position - b.position)) printChannel(c);
  for (const category of categories) {
    console.log(`  ${category.name}`);
    liveChannels
      .filter((c) => c.parent_id === category.id)
      .sort((a, b) => a.position - b.position)
      .forEach(printChannel);
  }

  const rules = await api("GET", `/guilds/${guild.id}/auto-moderation/rules`).catch(() => []);
  console.log(`\nAutoMod rules: ${rules.length === 0 ? "none" : ""}`);
  rules.forEach((r) => console.log(`  ${r.enabled ? "on " : "off"} ${r.name}`));
  console.log();
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

/** Works out what apply() would do, without writing anything. */
export function buildPlan({ liveRoles, liveChannels, full }) {
  const actions = [];

  if (full && full.name !== guildConfig.name) {
    actions.push({ kind: "rename-guild", label: `server    ${full.name} -> ${guildConfig.name}` });
  }
  if (full && !full.features.includes("COMMUNITY")) {
    actions.push({ kind: "enable-community", label: "server    enable Community" });
  }

  for (const role of roleConfig) {
    const existing = findByName(liveRoles, role.name);
    if (!existing) {
      actions.push({ kind: "create-role", label: `role      ${role.name}` });
    } else if (existing.color !== role.color || existing.hoist !== role.hoist) {
      actions.push({ kind: "update-role", label: `role      ${role.name} (colour/hoist)` });
    }
  }

  for (const group of structure) {
    const category = findByName(liveChannels, group.category, (c) => c.type === CATEGORY);
    if (!category) actions.push({ kind: "create-category", label: `category  ${group.category}` });

    for (const channel of group.channels) {
      const existing = findByName(liveChannels, channel.name, channelMatcher(channel));
      if (!existing) {
        actions.push({ kind: "create-channel", label: `channel   ${group.category} / ${channel.name}` });
      } else if (existing.name !== channel.name) {
        actions.push({ kind: "rename-channel", label: `channel   ${existing.name} -> ${channel.name}` });
      } else if (existing.parent_id !== category?.id) {
        actions.push({ kind: "move-channel", label: `channel   ${channel.name} -> ${group.category}` });
      } else {
        actions.push({ kind: "update-channel", label: `channel   ${channel.name} (topic/permissions)` });
      }
    }
  }

  actions.push({ kind: "welcome-screen", label: "server    welcome screen" });
  actions.push({ kind: "onboarding", label: `server    onboarding (${onboarding.prompts.length} prompts)` });
  for (const rule of autoMod) {
    actions.push({ kind: "automod", label: `automod   ${rule.name}` });
  }

  return actions;
}

async function plan(guild) {
  const state = await loadState(guild.id);
  const actions = buildPlan(state);

  console.log(`\nPlan for ${state.full.name}. Nothing has been changed.\n`);
  const creates = actions.filter((a) => a.kind.startsWith("create"));
  const updates = actions.filter((a) => !a.kind.startsWith("create"));

  console.log(`Will create (${creates.length}):`);
  creates.forEach((a) => console.log(`  + ${a.label}`));
  console.log(`\nWill update or configure (${updates.length}):`);
  updates.forEach((a) => console.log(`  ~ ${a.label}`));
  console.log("\nNothing is deleted. Run `apply` to make these changes.\n");
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

async function syncRoles(guild, liveRoles) {
  const byKey = new Map();

  for (const role of roleConfig) {
    const existing = findByName(liveRoles, role.name);
    const payload = {
      name: role.name,
      color: role.color,
      hoist: role.hoist,
      mentionable: role.mentionable,
      permissions: permissions(...role.permissions).toString(),
    };

    if (existing) {
      // Keep whatever permissions the role already has if a human widened them;
      // only reconcile the cosmetic fields plus our baseline grant.
      const merged = {
        ...payload,
        permissions: (BigInt(existing.permissions) | permissions(...role.permissions)).toString(),
      };
      const updated = await api("PATCH", `/guilds/${guild.id}/roles/${existing.id}`, merged);
      byKey.set(role.key, updated.id);
      console.log(`  ~ role      ${role.name}`);
    } else {
      const created = await api("POST", `/guilds/${guild.id}/roles`, payload);
      byKey.set(role.key, created.id);
      console.log(`  + role      ${role.name}`);
    }
  }

  // Discord refuses to place a role at or above the bot's own highest role, and
  // a bot cannot promote itself -- that check has no override, Administrator or
  // not. Newly created roles all land at position 1, tied with a bot whose role
  // is also near the bottom, which leaves no room to order anything.
  const botTop = await botTopPosition(guild.id);
  const top = botTop - 1;

  if (top < roleConfig.length) {
    console.log(
      `\n  ! Skipped role ordering. The bot's role sits at position ${botTop}, leaving ` +
        `${Math.max(top, 0)} slots for ${roleConfig.length} roles.\n` +
        "    Discord does not let a bot move any role to or above its own, and it cannot\n" +
        "    promote itself, so this one step needs a human:\n\n" +
        "      Server Settings > Roles > drag \"Neoxify Setup\" to the top of the list,\n" +
        "      above every role it just created. Then re-run `apply`.\n\n" +
        "    Everything else on this run still applied. The roles exist and are correct;\n" +
        "    they are just not stacked in the intended order yet.\n",
    );
  } else {
    const positions = roleConfig.map((role, index) => ({ id: byKey.get(role.key), position: top - index }));
    await api("PATCH", `/guilds/${guild.id}/roles`, positions);
    console.log(`  ~ role order  (${roleConfig.length} roles placed under the bot)`);
  }

  return byKey;
}

/** Forum and media tags carry ids once they exist; re-sending them without the
 *  id creates duplicates. Keep every live tag, add only the genuinely new. */
function mergeTags(existingTags = [], desiredTags = []) {
  const merged = existingTags.map((tag) => ({
    id: tag.id,
    name: tag.name,
    moderated: tag.moderated,
    emoji_id: tag.emoji_id ?? null,
    emoji_name: tag.emoji_name ?? null,
  }));
  const seen = new Set(merged.map((tag) => normalise(tag.name)));

  for (const tag of desiredTags) {
    if (seen.has(normalise(tag.name))) continue;
    merged.push({
      name: tag.name,
      moderated: Boolean(tag.moderated),
      emoji_id: null,
      emoji_name: tag.emoji ?? null,
    });
  }
  return merged;
}

function channelPayload(channel, categoryId, index, overwrites, existing) {
  const payload = {
    name: channel.name,
    parent_id: categoryId,
    position: index,
    permission_overwrites: overwrites,
  };

  if (channel.topic) payload.topic = channel.topic;
  if (channel.userLimit) payload.user_limit = channel.userLimit;
  if (channel.slowmode) payload.rate_limit_per_user = channel.slowmode;

  if (channel.type === FORUM || channel.type === MEDIA) {
    payload.available_tags = mergeTags(existing?.available_tags, channel.tags);
    payload.default_sort_order = 0; // latest activity
    if (channel.defaultReaction) {
      payload.default_reaction_emoji = { emoji_id: null, emoji_name: channel.defaultReaction };
    }
    if (channel.type === FORUM) {
      payload.default_forum_layout = channel.layout === "gallery" ? 2 : 1;
    }
  }

  return payload;
}

/**
 * Creates or updates the channels whose type passes `wanted`. Split into two
 * passes by the caller because forum, media, stage, and announcement channels
 * cannot exist until Community is switched on, and Community cannot be switched
 * on until the rules and updates channels exist.
 */
async function syncChannels(guild, roleId, everyoneId, wanted, channels) {
  for (const [groupIndex, group] of structure.entries()) {
    const wantedHere = group.channels.filter((c) => wanted(c.type));
    if (wantedHere.length === 0 && !wanted(CATEGORY)) continue;

    let category = findByName(channels, group.category, (c) => c.type === CATEGORY);
    const categoryOverwrites = overwritesFor(group.preset, roleId, everyoneId, group.lang);

    if (!category) {
      category = await api("POST", `/guilds/${guild.id}/channels`, {
        name: group.category,
        type: CATEGORY,
        position: groupIndex,
        permission_overwrites: categoryOverwrites,
      });
      channels.push(category);
      console.log(`  + category  ${group.category}`);
    } else if (wanted(CATEGORY)) {
      await api("PATCH", `/channels/${category.id}`, {
        name: group.category,
        permission_overwrites: categoryOverwrites,
        position: groupIndex,
      });
      console.log(`  ~ category  ${group.category}`);
    }

    for (const channel of wantedHere) {
      const index = group.channels.indexOf(channel);
      const overwrites = overwritesFor(channel.preset, roleId, everyoneId, channel.lang);
      const existing = findByName(channels, channel.name, channelMatcher(channel));
      const payload = channelPayload(channel, category.id, index, overwrites, existing);

      if (existing) {
        // An adopted text channel keeps its type; converting text <-> forum
        // would discard its history, which is never what you want.
        const updated = await api("PATCH", `/channels/${existing.id}`, payload);
        Object.assign(existing, updated);
        const renamed = existing.name !== channel.name ? `  (was ${existing.name})` : "";
        console.log(`  ~ ${(TYPE_LABELS[existing.type] ?? "channel").padEnd(9)} ${channel.name}${renamed}`);
        continue;
      }

      try {
        const created = await api("POST", `/guilds/${guild.id}/channels`, { ...payload, type: channel.type });
        channels.push(created);
        console.log(`  + ${(TYPE_LABELS[channel.type] ?? "channel").padEnd(9)} ${channel.name}`);
      } catch (err) {
        // 50024 means this server cannot host that channel type at all -- media
        // channels in particular are unavailable on many guilds. Fall back to
        // the nearest type that works and say so, rather than losing the channel.
        const fallback = FALLBACK_TYPE[channel.type];
        if (!err.message.includes("50024") || fallback === undefined) throw err;

        const { available_tags, default_reaction_emoji, default_sort_order, default_forum_layout, ...plain } = payload;
        const created = await api("POST", `/guilds/${guild.id}/channels`, { ...plain, type: fallback });
        channels.push(created);
        console.log(
          `  + ${(TYPE_LABELS[fallback] ?? "channel").padEnd(9)} ${channel.name}` +
            `  (as ${TYPE_LABELS[fallback]}: this server does not support ${TYPE_LABELS[channel.type]} channels)`,
        );
      }
    }
  }
}

/**
 * Turns the server into a Community, which is what unlocks forums, media and
 * stage channels, the welcome screen, onboarding, and AutoMod alerts.
 *
 * This changes two server-wide settings Discord requires for Community:
 * verification level goes to Low, and the explicit media filter to scan
 * everyone. Both are announced in the output rather than done quietly.
 */
async function enableCommunity(guild, channels) {
  const full = await api("GET", `/guilds/${guild.id}`);
  if (full.features.includes("COMMUNITY")) {
    console.log("  = community  already enabled");
    return;
  }

  const rules = findByName(channels, specialChannels.rules, (c) => MESSAGE_TYPES.has(c.type));
  const updates = findByName(channels, specialChannels.communityUpdates, (c) => MESSAGE_TYPES.has(c.type));

  if (!rules || !updates) {
    throw new Error(
      "Cannot enable Community: the rules and community-updates channels must exist first.\n" +
        `Looked for "${specialChannels.rules}" and "${specialChannels.communityUpdates}".`,
    );
  }

  await api("PATCH", `/guilds/${guild.id}`, {
    features: [...full.features, "COMMUNITY"],
    rules_channel_id: rules.id,
    public_updates_channel_id: updates.id,
    verification_level: 1,
    explicit_content_filter: 2,
    default_message_notifications: 1,
    description: guildConfig.description,
  });

  console.log("  + community  enabled");
  console.log("    verification level -> Low, explicit media filter -> everyone (both required by Discord)");
  console.log("    default notifications -> mentions only");
}

async function syncWelcomeScreen(guild, channels) {
  const welcome = welcomeScreen.channels
    .map((entry) => {
      const channel = findByName(channels, entry.channel);
      return channel
        ? { channel_id: channel.id, description: entry.description, emoji_id: null, emoji_name: entry.emoji }
        : null;
    })
    .filter(Boolean);

  await api("PATCH", `/guilds/${guild.id}/welcome-screen`, {
    enabled: true,
    description: welcomeScreen.description,
    welcome_channels: welcome,
  });
  console.log(`  ~ welcome screen  (${welcome.length} channels)`);
}

/**
 * Builds the onboarding payload. Every prompt and option needs an `id` that
 * Discord can parse as a snowflake -- it rejects anything non-numeric, so these
 * are a plain counter rather than something readable like "prompt-0-option-1".
 * Discord reassigns real snowflakes on save; these only have to be distinct.
 */
export function onboardingPayload(roleId, channelId) {
  let next = 0;
  const nextId = () => String(next++);

  const prompts = onboarding.prompts.map((prompt) => ({
    id: nextId(),
    type: 0, // multiple choice
    title: prompt.title,
    single_select: prompt.singleSelect,
    required: prompt.required,
    in_onboarding: true,
    options: prompt.options.map((option) => ({
      id: nextId(),
      title: option.title,
      description: option.description ?? null,
      emoji: { id: null, name: option.emoji, animated: false },
      role_ids: (option.roles ?? []).map(roleId).filter(Boolean),
      channel_ids: (option.channels ?? []).map(channelId).filter(Boolean),
    })),
  }));

  return {
    prompts,
    default_channel_ids: onboarding.defaultChannels.map(channelId).filter(Boolean),
    enabled: true,
    mode: 1, // count default channels and prompts toward the requirements
  };
}

async function syncOnboarding(guild, roleId, channels) {
  const channelId = (name) => findByName(channels, name)?.id;
  const payload = onboardingPayload(roleId, channelId);

  await api("PUT", `/guilds/${guild.id}/onboarding`, payload);
  console.log(
    `  ~ onboarding  (${payload.prompts.length} prompts, ${payload.default_channel_ids.length} default channels)`,
  );
}

function autoModPayload(rule, staffRoleIds, alertChannelId) {
  const actions = [];

  if (rule.trigger !== "spam" && rule.message) {
    actions.push({ type: 1, metadata: { custom_message: rule.message.slice(0, 150) } });
  } else {
    actions.push({ type: 1, metadata: {} });
  }
  if (rule.alert && alertChannelId) {
    actions.push({ type: 2, metadata: { channel_id: alertChannelId } });
  }

  const base = { name: rule.name, event_type: 1, actions, enabled: true, exempt_roles: staffRoleIds };

  switch (rule.trigger) {
    case "regex":
      return { ...base, trigger_type: 1, trigger_metadata: { keyword_filter: [], regex_patterns: rule.patterns } };
    case "keyword":
      return { ...base, trigger_type: 1, trigger_metadata: { keyword_filter: rule.keywords, regex_patterns: [] } };
    case "spam":
      return { ...base, trigger_type: 3, trigger_metadata: {} };
    case "preset":
      return { ...base, trigger_type: 4, trigger_metadata: { presets: rule.presets, allow_list: [] } };
    case "mentionSpam":
      return { ...base, trigger_type: 5, trigger_metadata: { mention_total_limit: rule.mentionLimit } };
    default:
      throw new Error(`Unknown AutoMod trigger: ${rule.trigger}`);
  }
}

async function syncAutoMod(guild, roleId, channels) {
  const staffRoleIds = STAFF_KEYS.map(roleId).filter(Boolean);
  const alertChannelId = findByName(channels, specialChannels.modLog, (c) => MESSAGE_TYPES.has(c.type))?.id;
  const existing = await api("GET", `/guilds/${guild.id}/auto-moderation/rules`);

  for (const rule of autoMod) {
    const payload = autoModPayload(rule, staffRoleIds, alertChannelId);
    const match = existing.find((r) => r.name === rule.name);

    try {
      if (match) {
        await api("PATCH", `/guilds/${guild.id}/auto-moderation/rules/${match.id}`, payload);
        console.log(`  ~ automod   ${rule.name}`);
      } else {
        await api("POST", `/guilds/${guild.id}/auto-moderation/rules`, payload);
        console.log(`  + automod   ${rule.name}`);
      }
    } catch (err) {
      // One rejected rule should not cost you the other four.
      console.log(`  ! automod   ${rule.name} -- ${err.message.split("\n")[0]}`);
    }
  }
}

async function apply(guild) {
  const { liveRoles, full } = await loadState(guild.id);
  const everyoneId = guild.id;

  if (full.name !== guildConfig.name) {
    await api("PATCH", `/guilds/${guild.id}`, { name: guildConfig.name });
    console.log(`  ~ server    renamed ${full.name} -> ${guildConfig.name}`);
  }

  // Only set the icon when there is none, so a icon chosen by hand in the
  // Discord UI is never silently overwritten by a re-run.
  if (guildConfig.icon && !full.icon) {
    const bytes = await repoFile(guildConfig.icon);
    await api("PATCH", `/guilds/${guild.id}`, { icon: `data:image/png;base64,${bytes.toString("base64")}` });
    console.log(`  ~ server    icon set from ${guildConfig.icon}`);
  }

  const byKey = await syncRoles(guild, liveRoles);
  const roleId = (key) => byKey.get(key);

  let channels = await api("GET", `/guilds/${guild.id}/channels`);

  // Pass one: categories and the plain text/voice channels, which Discord
  // allows on any server. This also creates the two channels Community needs.
  await syncChannels(guild, roleId, everyoneId, (t) => !COMMUNITY_TYPES.has(t), channels);

  await enableCommunity(guild, channels);

  // Pass two: the channel types that only exist on a Community server.
  channels = await api("GET", `/guilds/${guild.id}/channels`);
  await syncChannels(guild, roleId, everyoneId, (t) => COMMUNITY_TYPES.has(t), channels);

  channels = await api("GET", `/guilds/${guild.id}/channels`);

  // These four are enhancements: a rejection here should report itself and let
  // the rest of the run stand, rather than unwinding a server that is already
  // correctly built.
  for (const [label, step] of [
    ["welcome screen", () => syncWelcomeScreen(guild, channels)],
    ["onboarding", () => syncOnboarding(guild, roleId, channels)],
    ["automod", () => syncAutoMod(guild, roleId, channels)],
  ]) {
    try {
      await step();
    } catch (err) {
      console.log(`  ! ${label} failed -- ${err.message.split("\n")[0]}`);
    }
  }

  console.log("\nDone. Re-run `plan` to confirm the server now matches the config.\n");
}

// ---------------------------------------------------------------------------
// seed-content
// ---------------------------------------------------------------------------

/** Posts the starter messages into the read-only channels. Separate from
 *  `apply` because it writes visible content, not structure. */
async function seedContent(guild, { replace = false } = {}) {
  const channels = await api("GET", `/guilds/${guild.id}/channels`);
  const botId = await botUserId();

  for (const [name, messages] of Object.entries(channelContent)) {
    const channel = findByName(channels, name, (c) => MESSAGE_TYPES.has(c.type));
    if (!channel) {
      console.log(`  ! ${name} does not exist yet -- run \`apply\` first`);
      continue;
    }

    const existing = await api("GET", `/channels/${channel.id}/messages?limit=50`);
    const mine = existing.filter((m) => m.author?.id === botId);

    if (mine.length > 0 && !replace) {
      console.log(`  = ${channel.name} already has ${mine.length} post(s) from this bot, leaving it alone`);
      continue;
    }

    if (mine.length > 0) {
      // Only ever this bot's own posts -- a member's message is never touched.
      if (mine.length > 1) {
        await api("POST", `/channels/${channel.id}/messages/bulk-delete`, { messages: mine.map((m) => m.id) });
      } else {
        await api("DELETE", `/channels/${channel.id}/messages/${mine[0].id}`);
      }
      console.log(`  - ${channel.name}  removed ${mine.length} old post(s)`);
    }

    // The poster goes first so it reads as the channel's header.
    const poster = channelPosters[name];
    if (poster) {
      await apiUpload(`/channels/${channel.id}/messages`, {
        filename: poster,
        bytes: await repoFile(`scripts/discord/posters/${poster}`),
      });
    }

    for (const content of messages) {
      await api("POST", `/channels/${channel.id}/messages`, { content, allowed_mentions: { parse: [] } });
    }
    console.log(
      `  + ${channel.name}  (${poster ? "poster + " : ""}${messages.length} message${messages.length === 1 ? "" : "s"})`,
    );
  }
  console.log();
}

// ---------------------------------------------------------------------------

async function main() {
  const command = process.argv[2] ?? "inspect";

  if (!TOKEN) {
    console.error("DISCORD_BOT_TOKEN is not set. See scripts/discord/README.md.");
    process.exit(1);
  }

  // Validate the command before spending a round trip on authentication.
  if (!["inspect", "plan", "apply", "seed-content"].includes(command)) {
    console.error(`Unknown command: ${command}. Use inspect | plan | apply | seed-content.`);
    process.exit(1);
  }

  const guild = await resolveGuild();

  switch (command) {
    case "inspect":
      return inspect(guild);
    case "plan":
      return plan(guild);
    case "apply":
      console.log(`\nApplying config to ${guild.name}...\n`);
      return apply(guild);
    case "seed-content": {
      const replace = process.argv.includes("--replace");
      console.log(`\nPosting starter content to ${guild.name}${replace ? " (replacing this bot's old posts)" : ""}...\n`);
      return seedContent(guild, { replace });
    }
  }
}

// Only run when invoked as a script, so the pure helpers above can be imported
// and tested without firing a single API call.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  });
}
