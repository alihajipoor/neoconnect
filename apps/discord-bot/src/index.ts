import { Client, Events, GatewayIntentBits, REST, Routes, type Interaction } from "discord.js";

import { NeoxifyApi } from "./api.js";
import { definitions, handle } from "./commands.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const api = new NeoxifyApi(config);

/**
 * Guilds is the only intent needed. The bot reads nothing anybody types --
 * every interaction arrives through the slash-command gateway, which needs no
 * privileged intent at all. Asking for MessageContent would mean a Discord
 * review and access to every message in the server, to gain nothing.
 */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

/** Guild-scoped registration, done on every boot. `PUT` replaces the whole
 * set, so it is idempotent and a removed command actually disappears rather
 * than lingering until someone remembers to clean it up. */
async function registerCommands(): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(config.discordToken);
  await rest.put(Routes.applicationGuildCommands(config.applicationId, config.guildId), {
    body: definitions,
  });
  console.log(`Registered ${definitions.length} commands to guild ${config.guildId}`);
}

client.once(Events.ClientReady, (ready) => {
  console.log(`Logged in as ${ready.user.tag}`);
});

async function onInteraction(interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand()) return;

  try {
    await handle(interaction, api, config);
  } catch (err) {
    // handle() answers its own errors; reaching here means replying itself
    // failed (an expired interaction, usually). Nothing left to say to the
    // user, so just make sure it is visible in the logs.
    console.error("Unhandled interaction failure:", err);
  }
}

// Not an async listener: discord.js ignores the returned promise, so a
// rejection would surface as an unhandled rejection instead of the log line
// above. `void` on a function that cannot reject makes that explicit.
client.on(Events.InteractionCreate, (interaction) => void onInteraction(interaction));

async function main(): Promise<void> {
  await registerCommands();
  await client.login(config.discordToken);
}

/** A bot that cannot register its commands or log in is useless; exiting
 * non-zero lets the container restart policy retry rather than sitting there
 * pretending to be healthy. */
main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    void client.destroy().finally(() => process.exit(0));
  });
}
