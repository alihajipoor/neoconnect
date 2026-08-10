import { Client, Events, GatewayIntentBits, REST, Routes, type Interaction } from "discord.js";

import { NeoxifyApi } from "./api.js";
import { definitions, handle } from "./commands.js";
import { loadConfig } from "./config.js";
import { REFRESH_MS, refreshPanels } from "./panels.js";
import { ensureTicketPanel, handleTicketButton, handleTicketModal, isTicketInteraction } from "./tickets.js";

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

  // Panels are rewritten on boot and then on a timer, so a deploy is enough
  // to correct one that drifted and nobody has to touch a Discord message
  // by hand. Failures inside are logged per panel, never thrown.
  const ctx = { api, config };

  // The boot attempt races the backend: on a deploy both containers restart
  // together and the bot is ready long before the backend finishes its
  // migrations, so the first fetch fails. Retry quickly a few times rather
  // than leaving the channels empty until the ten-minute tick.
  const settle = async (attempt = 1): Promise<void> => {
    const failures = await refreshPanels(client, ctx, config.guildId).catch(() => 1);
    await ensureTicketPanel(client, config, config.guildId).catch((err) =>
      console.error("ticket panel failed:", err instanceof Error ? err.message : err),
    );
    if (failures > 0 && attempt < 6) {
      console.warn(`${failures} panel(s) failed on attempt ${attempt}; retrying in 15s`);
      setTimeout(() => void settle(attempt + 1), 15_000).unref?.();
    }
  };

  void settle();
  const timer = setInterval(() => void settle(), REFRESH_MS);
  timer.unref?.();
});

// Gateway lifecycle. Without these a dropped shard is completely silent:
// the process stays up, the last line in the log is still "Logged in", and
// every slash command hangs on "Sending command..." with nothing anywhere
// saying why. That is exactly how the first deployment failed.
client.on(Events.Error, (err) => console.error("client error:", err));
client.on(Events.ShardError, (err, id) => console.error(`shard ${id} error:`, err));
client.on(Events.ShardDisconnect, (event, id) =>
  console.warn(`shard ${id} disconnected: ${event.code} ${event.reason || ""}`),
);
client.on(Events.ShardReconnecting, (id) => console.warn(`shard ${id} reconnecting`));
client.on(Events.ShardResume, (id, replayed) => console.log(`shard ${id} resumed, replayed ${replayed} events`));
client.on(Events.Invalidated, () => {
  console.error("session invalidated by Discord; exiting so the restart policy reconnects");
  process.exit(1);
});

async function onInteraction(interaction: Interaction): Promise<void> {
  // Logged before anything can throw, so "did the event even arrive?" is
  // answerable from the log rather than by inference.
  console.log(
    `interaction ${interaction.type} ` +
      (interaction.isChatInputCommand() ? `/${interaction.commandName} ` : "") +
      `from ${interaction.user?.tag ?? "?"}`,
  );

  if (interaction.isButton() && isTicketInteraction(interaction.customId)) {
    await handleTicketButton(interaction);
    return;
  }
  if (interaction.isModalSubmit() && isTicketInteraction(interaction.customId)) {
    await handleTicketModal(interaction);
    return;
  }

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
