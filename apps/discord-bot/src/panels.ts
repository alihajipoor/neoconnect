import {
  ChannelType,
  EmbedBuilder,
  type Client,
  type Guild,
  type Message,
  type TextChannel,
} from "discord.js";

import type { NeoxifyApi, PlatformRelease, PublicPlan } from "./api.js";
import { BRAND_COLOUR, type BotConfig } from "./config.js";

/**
 * Self-maintaining posts.
 *
 * A panel is one message the bot owns in a read-only channel, rewritten
 * from live data on a timer. That is the whole point: tag a release or edit
 * a plan in the panel, and the Discord post follows on its own. Nobody has
 * to remember to update a pinned message, and it cannot drift from what the
 * product actually sells.
 *
 * Identified by a marker in the embed footer rather than by storing message
 * ids: the bot holds no database, and a restart must find the same message
 * it wrote last time instead of posting a second one.
 */
const MARKER = "neoxify-panel";

const markerFor = (id: string) => `${MARKER}:${id}`;

/** How often panels are rewritten. Releases and plans change on the order
 *  of days, so this is about being eventually correct, not instant. */
export const REFRESH_MS = 10 * 60_000;

export interface PanelDefinition {
  id: string;
  /** Channel name to post in, matched loosely so emoji prefixes do not matter. */
  channel: string;
  build: (ctx: PanelContext) => Promise<EmbedBuilder[]>;
}

export interface PanelContext {
  api: NeoxifyApi;
  config: BotConfig;
}

/** Channel names are compared with emoji, separators and case stripped, so
 *  `⬇️・downloads` matches a config entry of `downloads`. Mirrors
 *  normalise() in scripts/discord/sync.mjs. */
export function normalise(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function findChannel(guild: Guild, name: string): TextChannel | null {
  const target = normalise(name);
  const match = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && normalise(c.name) === target,
  );
  return (match as TextChannel | undefined) ?? null;
}

const PLATFORM_LABELS: Record<string, string> = {
  windows: "🖥️  Windows",
  android: "🤖  Android",
};

function downloadsEmbed(releases: PlatformRelease[], config: BotConfig): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle("Download Neoxify · دانلود نئوکسیفای")
    .setColor(BRAND_COLOUR)
    .setDescription(
      [
        `Always download from **${config.websiteUrl}** — never a build another member sends you.`,
        "همیشه از سایت رسمی دانلود کنید، نه از فایلی که کاربر دیگری فرستاده.",
      ].join("\n"),
    );

  const known = releases.filter((r) => r.url && r.version);
  if (known.length === 0) {
    embed.addFields({
      name: "Downloads",
      value: `The release feed is not answering right now. Get the app from ${config.websiteUrl}`,
    });
  } else {
    for (const release of known) {
      embed.addFields({
        name: PLATFORM_LABELS[release.platform] ?? release.platform,
        value: `**v${release.version}** — [Download](${release.url})`,
        inline: true,
      });
    }
  }

  // Listed even when the feed is healthy: a platform with no release yet is
  // a real answer to "is there an iOS app", and silence is not.
  const missing = releases.filter((r) => !r.url).map((r) => PLATFORM_LABELS[r.platform] ?? r.platform);
  if (missing.length > 0) {
    embed.addFields({ name: "Not released yet", value: missing.join(" · ") });
  }

  return embed;
}

function planLine(plan: PublicPlan): string {
  const bits = [`**$${plan.priceUsd}** / ${plan.durationDays} days`];
  bits.push(plan.dataCapGb === null ? "Unlimited data" : `${plan.dataCapGb} GB`);
  if (plan.maxDownloadMbps || plan.maxUploadMbps) {
    const down = plan.maxDownloadMbps ? `↓${plan.maxDownloadMbps}` : "";
    const up = plan.maxUploadMbps ? `↑${plan.maxUploadMbps}` : "";
    bits.push(`${[down, up].filter(Boolean).join(" ")} Mbps`);
  }
  if (plan.maxConcurrentConnections) bits.push(`${plan.maxConcurrentConnections} devices`);
  return bits.join(" · ");
}

function plansEmbed(plans: PublicPlan[], config: BotConfig): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle("Plans · پلن‌ها")
    .setColor(BRAND_COLOUR)
    .setDescription(
      plans.length === 0
        ? "No plans are on sale right now."
        : `Buy and manage your subscription **in the app** — download it from ${config.websiteUrl}\n` +
          "خرید و مدیریت اشتراک از داخل خود برنامه انجام می‌شود.",
    );

  for (const plan of plans.slice(0, 25)) {
    embed.addFields({ name: plan.name, value: planLine(plan) });
  }
  return embed;
}

function linksEmbed(config: BotConfig): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("Neoxify · links")
    .setColor(BRAND_COLOUR)
    .setDescription("Everything official, in one place. هر چیزی که رسمی است، یکجا.")
    .addFields(
      { name: "🌐  Website", value: config.websiteUrl, inline: true },
      {
        name: "👤  Your subscription",
        value: "In the app — Settings → Account",
        inline: true,
      },
      {
        name: "⚠️  Only these",
        value:
          "We will never DM you first, and we never ask for your password, config file, or subscription link. " +
          "هرگز اول ما به شما پیام خصوصی نمی‌دهیم و هرگز رمز یا فایل کانفیگ نمی‌خواهیم.",
      },
    );
}

export const PANELS: PanelDefinition[] = [
  {
    id: "downloads",
    channel: "downloads",
    build: async ({ api, config }) => [downloadsEmbed(await api.releases(), config)],
  },
  {
    id: "plans",
    channel: "plans",
    build: async ({ api, config }) => [plansEmbed(await api.plans(), config)],
  },
  {
    id: "links",
    channel: "links",
    build: ({ config }) => Promise.resolve([linksEmbed(config)]),
  },
];

export const __testing = { downloadsEmbed, plansEmbed, linksEmbed, planLine, markerFor };

/** The bot's own previous panel message in this channel, if there is one. */
async function findExisting(channel: TextChannel, panelId: string, botId: string): Promise<Message | null> {
  const recent = await channel.messages.fetch({ limit: 50 });
  return (
    recent.find(
      (m) =>
        m.author.id === botId &&
        m.embeds.some((e) => e.footer?.text?.includes(markerFor(panelId))),
    ) ?? null
  );
}

/** Rewrites every panel once and reports how many failed.
 *
 * Never throws: a panel that cannot be built is logged and skipped, because
 * one bad channel must not stop the others. The count is what lets the
 * caller retry sooner than the normal interval -- on a deploy the bot
 * reaches ClientReady while the backend is still running migrations, so the
 * first attempt legitimately fails and waiting ten minutes to correct it
 * would leave the channels visibly empty.
 */
export async function refreshPanels(client: Client, ctx: PanelContext, guildId: string): Promise<number> {
  const guild = await client.guilds.fetch(guildId);
  const botId = client.user?.id;
  if (!botId) return 0;

  let failures = 0;

  for (const panel of PANELS) {
    try {
      const channel = findChannel(guild, panel.channel);
      if (!channel) {
        console.warn(`panel "${panel.id}": no channel named ${panel.channel}, skipping`);
        continue;
      }

      const embeds = await panel.build(ctx);
      const stamped = embeds.map((e, i) =>
        i === embeds.length - 1
          ? e.setFooter({ text: `${markerFor(panel.id)} · updated` }).setTimestamp(new Date())
          : e,
      );

      const existing = await findExisting(channel, panel.id, botId);
      if (existing) {
        await existing.edit({ embeds: stamped });
      } else {
        await channel.send({ embeds: stamped });
      }
    } catch (err) {
      failures += 1;
      console.error(`panel "${panel.id}" failed:`, err instanceof Error ? err.message : err);
    }
  }

  return failures;
}
