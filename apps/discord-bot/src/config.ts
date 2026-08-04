/** Environment the bot needs, validated once at boot.
 *
 * Deliberately fails loudly and immediately on a missing value rather than
 * defaulting: a bot that starts with no API URL looks healthy in `docker ps`
 * and answers every command with an error, which is a far worse failure than
 * not starting at all.
 */
export interface BotConfig {
  discordToken: string;
  applicationId: string;
  guildId: string;
  apiBaseUrl: string;
  serviceToken: string;
  websiteUrl: string;
  panelUrl: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required. See apps/discord-bot/README.md.`);
  }
  return value;
}

export function loadConfig(): BotConfig {
  return {
    discordToken: required("DISCORD_BOT_TOKEN"),
    applicationId: required("DISCORD_APPLICATION_ID"),
    // Guild-scoped rather than global: guild commands appear the instant they
    // are registered, where global ones can take an hour to propagate. This
    // is a single-server bot, so there is nothing to gain from global.
    guildId: required("DISCORD_GUILD_ID"),
    apiBaseUrl: required("NEOXIFY_API_URL").replace(/\/+$/, ""),
    serviceToken: required("INTEGRATIONS_SERVICE_TOKEN"),
    websiteUrl: process.env.NEOXIFY_WEBSITE_URL?.trim() || "https://neoxify.net",
    panelUrl: process.env.NEOXIFY_PANEL_URL?.trim() || "https://connect.neoxify.com",
  };
}

/** The product palette's primary violet, as Discord wants it: a plain int. */
export const BRAND_COLOUR = 0x8b5cf6;
export const BRAND_COLOUR_WARN = 0xf59e0b;
export const BRAND_COLOUR_BAD = 0xef4444;
