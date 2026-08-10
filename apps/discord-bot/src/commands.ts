import {
  EmbedBuilder,
  GuildMember,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";

import { ApiError, type NeoxifyApi, type PublicPlan, type StatusSummary } from "./api.js";
import { BRAND_COLOUR, BRAND_COLOUR_BAD, BRAND_COLOUR_WARN, type BotConfig } from "./config.js";
import { detectLang, say, type Lang } from "./i18n.js";

export const definitions: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Node and route health · وضعیت سرورها و مسیرها")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("plans")
    .setDescription("What you can buy, and what you get · پلن‌ها و امکانات")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("download")
    .setDescription("Get the Neoxify app · دریافت برنامه")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("How to ask so you get answered · چطور سوال بپرسید")
    .toJSON(),
];

/** Colour carries the headline: green-ish brand violet when healthy, amber
 *  when something is quiet, red when nothing is up. */
function statusColour(status: StatusSummary): number {
  if (status.nodes.total === 0) return BRAND_COLOUR_WARN;
  if (status.nodes.online === 0) return BRAND_COLOUR_BAD;
  if (status.nodes.stale > 0 || status.nodes.online < status.nodes.total) return BRAND_COLOUR_WARN;
  return BRAND_COLOUR;
}

function statusEmbed(status: StatusSummary, lang: Lang): EmbedBuilder {
  const { nodes, routes, regions } = status;

  const headline =
    nodes.total === 0
      ? say("statusNoNodes", lang)
      : nodes.online === nodes.total
        ? say("statusAllUp", lang)
        : say("statusDegraded", lang);

  const embed = new EmbedBuilder()
    .setTitle(say("statusTitle", lang))
    .setDescription(headline)
    .setColor(statusColour(status))
    .setTimestamp(new Date(status.checkedAt));

  if (nodes.total > 0) {
    const parts = [`**${nodes.online}**/${nodes.total} ${say("online", lang)}`];
    if (nodes.stale > 0) parts.push(`${nodes.stale} ${say("stale", lang)}`);
    if (nodes.offline > 0) parts.push(`${nodes.offline} ${say("offline", lang)}`);
    embed.addFields({ name: say("fieldNodes", lang), value: parts.join(" · "), inline: true });
  }

  if (routes.total > 0) {
    embed.addFields({
      name: say("fieldRoutes", lang),
      value: `**${routes.enabled}**/${routes.total} ${say("enabled", lang)}`,
      inline: true,
    });
  }

  if (regions.length > 0) {
    embed.addFields({
      name: say("fieldRegions", lang),
      value: regions
        .map((r) => `${r.online === r.total ? "🟢" : r.online === 0 ? "🔴" : "🟡"} ${r.region} — ${r.online}/${r.total}`)
        .join("\n"),
    });
  }

  return embed;
}

function planLine(plan: PublicPlan, lang: Lang): string {
  const bits: string[] = [`$${plan.priceUsd} / ${plan.durationDays} ${say("perDays", lang)}`];

  bits.push(plan.dataCapGb === null ? say("unlimited", lang) : `${plan.dataCapGb} GB ${say("dataCap", lang)}`);

  if (plan.maxDownloadMbps || plan.maxUploadMbps) {
    const down = plan.maxDownloadMbps ? `↓${plan.maxDownloadMbps}` : "";
    const up = plan.maxUploadMbps ? `↑${plan.maxUploadMbps}` : "";
    bits.push(`${[down, up].filter(Boolean).join(" ")} Mbps ${say("speed", lang)}`);
  }
  if (plan.maxConcurrentConnections) {
    bits.push(`${plan.maxConcurrentConnections} ${say("devices", lang)}`);
  }

  return bits.join(" · ");
}

function plansEmbed(plans: PublicPlan[], lang: Lang, config: BotConfig): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle(say("plansTitle", lang)).setColor(BRAND_COLOUR);

  if (plans.length === 0) {
    return embed.setDescription(say("plansEmpty", lang));
  }

  for (const plan of plans.slice(0, 25)) {
    embed.addFields({ name: plan.name, value: planLine(plan, lang) });
  }
  return embed.setDescription(`${say("buyAt", lang)} ${config.websiteUrl}`);
}

/**
 * The member's role names.
 *
 * `interaction.member` is a GuildMember when the member is cached and a raw
 * API object when it is not -- and the raw form carries role *ids*, not
 * objects. Resolving the ids through the guild's own role cache covers both,
 * and needs no privileged intent: roles arrive with GUILD_CREATE.
 */
function roleNamesOf(interaction: ChatInputCommandInteraction): string[] {
  const member = interaction.member;
  if (!member) return [];

  if (member instanceof GuildMember) {
    return [...member.roles.cache.values()].map((role) => role.name);
  }

  const ids: string[] = Array.isArray(member.roles) ? member.roles : [];
  const guildRoles = interaction.guild?.roles.cache;
  return ids
    .map((id) => guildRoles?.get(id)?.name)
    .filter((name): name is string => typeof name === "string");
}

/** Every handler answers with an ephemeral embed: these are lookups, and a
 *  channel filling with bot output nobody else asked for is its own problem. */
export async function handle(
  interaction: ChatInputCommandInteraction,
  api: NeoxifyApi,
  config: BotConfig,
): Promise<void> {
  const lang = detectLang(roleNamesOf(interaction));

  // Deferred first: the panel round trip can outlast Discord's three-second
  // interaction deadline, after which any reply is rejected outright.
  await interaction.deferReply({ ephemeral: true });

  try {
    switch (interaction.commandName) {
      case "status": {
        const status = await api.status();
        await interaction.editReply({ embeds: [statusEmbed(status, lang)] });
        return;
      }
      case "plans": {
        const plans = await api.plans();
        await interaction.editReply({ embeds: [plansEmbed(plans, lang, config)] });
        return;
      }
      case "download": {
        const { installerUrl } = await api.download();
        const embed = new EmbedBuilder()
          .setTitle(say("downloadTitle", lang))
          .setColor(BRAND_COLOUR)
          .setDescription(
            installerUrl
              ? `${say("downloadBody", lang)}\n\n${installerUrl}`
              : `${say("downloadFallback", lang)}\n\n${config.websiteUrl}`,
          );
        await interaction.editReply({ embeds: [embed] });
        return;
      }
      case "help": {
        const embed = new EmbedBuilder()
          .setTitle(say("helpTitle", lang))
          .setColor(BRAND_COLOUR)
          .setDescription(say("helpBody", lang));
        await interaction.editReply({ embeds: [embed] });
        return;
      }
      default:
        await interaction.editReply(`Unknown command: ${interaction.commandName}`);
    }
  } catch (err) {
    // An ApiError is expected operationally -- say so plainly. Anything else
    // is a bug, and still must not surface a stack trace to a member.
    const message = err instanceof ApiError ? say("apiDown", lang) : say("apiDown", lang);
    if (!(err instanceof ApiError)) {
      console.error(`/${interaction.commandName} failed:`, err);
    }
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(BRAND_COLOUR_BAD).setDescription(message)],
    });
  }
}

export const __testing = { statusEmbed, plansEmbed, planLine, statusColour };
