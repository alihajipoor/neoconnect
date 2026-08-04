import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ThreadAutoArchiveDuration,
  type ButtonInteraction,
  type Client,
  type Guild,
  type GuildMember,
  type ModalSubmitInteraction,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";

import { BRAND_COLOUR, BRAND_COLOUR_BAD, type BotConfig } from "./config.js";
import { detectLang, type Lang } from "./i18n.js";
import { normalise } from "./panels.js";

/**
 * Support tickets as private threads.
 *
 * A thread rather than a new channel per ticket: channels are capped at 500
 * per guild and each one leaves a corpse to clean up, while a thread
 * archives itself and costs nothing. Private, so a member's logs and route
 * names are visible to them and staff only -- the same reason the help
 * forums exist but with a wall around each conversation.
 *
 * The button's custom id is static, so it keeps working across restarts.
 * There is no state to lose: everything a ticket needs is on the thread.
 */
const OPEN_BUTTON = "ticket:open";
const CLOSE_BUTTON = "ticket:close";
const MODAL = "ticket:modal";

/** Channel the ticket panel lives in, matched loosely. */
export const TICKET_CHANNEL = "open-a-ticket";

/** Roles that can see every ticket and close them. Matched by name, so the
 *  sync script recreating them does not break this. */
const STAFF_ROLE_NAMES = ["Founder", "Neoxify Team", "Moderator", "Support"];

const PANEL_MARKER = "neoxify-ticket-panel";

const copy = {
  panelTitle: "Open a support ticket · ثبت تیکت پشتیبانی",
  panelBody: [
    "Press the button below and describe the problem. A private thread opens that only you and the support team can see.",
    "",
    "Use this when your issue involves your **account, payment, or logs** — anything you should not post in a public channel.",
    "For general questions the help forum is faster, because other members can answer too.",
    "",
    "دکمهٔ زیر را بزنید و مشکل را توضیح دهید. یک گفتگوی خصوصی باز می‌شود که فقط شما و تیم پشتیبانی آن را می‌بینید.",
    "برای مسائل مربوط به **حساب کاربری، پرداخت یا لاگ‌ها** از این استفاده کنید — چیزهایی که نباید در کانال عمومی بفرستید.",
  ].join("\n"),
  opened: (lang: Lang) =>
    lang === "fa"
      ? "تیکت شما ساخته شد. لطفاً همان‌جا ادامه دهید."
      : "Your ticket is open. Carry on in the thread.",
  closed: (lang: Lang) =>
    lang === "fa" ? "این تیکت بسته شد." : "This ticket is closed.",
  notAllowed: (lang: Lang) =>
    lang === "fa"
      ? "فقط صاحب تیکت یا تیم پشتیبانی می‌تواند آن را ببندد."
      : "Only the person who opened this ticket, or staff, can close it.",
};

export function ticketPanelComponents() {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(OPEN_BUTTON)
        .setLabel("Open a ticket")
        .setEmoji("🎟️")
        .setStyle(ButtonStyle.Primary),
    ),
  ];
}

export function ticketPanelEmbed(config: BotConfig): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(copy.panelTitle)
    .setColor(BRAND_COLOUR)
    .setDescription(copy.panelBody)
    .addFields({
      name: "Never post these",
      value:
        "Config files, keys, subscription links, or invoices — not even in a ticket screenshot. " +
        "Staff will ask for your **email or order time**, never your password.",
    })
    .setFooter({ text: `${PANEL_MARKER} · ${config.panelUrl}` });
}

function staffRoleIds(guild: Guild): string[] {
  const wanted = new Set(STAFF_ROLE_NAMES.map(normalise));
  return guild.roles.cache.filter((r) => wanted.has(normalise(r.name))).map((r) => r.id);
}

function isStaff(member: GuildMember | null): boolean {
  if (!member) return false;
  const wanted = new Set(STAFF_ROLE_NAMES.map(normalise));
  return member.roles.cache.some((r) => wanted.has(normalise(r.name)));
}

function langOf(member: GuildMember | null): Lang {
  return detectLang(member ? [...member.roles.cache.values()].map((r) => r.name) : []);
}

/** Ensures the ticket panel exists in its channel, exactly once. */
export async function ensureTicketPanel(client: Client, config: BotConfig, guildId: string): Promise<void> {
  const guild = await client.guilds.fetch(guildId);
  const botId = client.user?.id;
  if (!botId) return;

  const target = normalise(TICKET_CHANNEL);
  const channel = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && normalise(c.name) === target,
  ) as TextChannel | undefined;

  if (!channel) {
    console.warn(`ticket panel: no channel named ${TICKET_CHANNEL}, skipping`);
    return;
  }

  const recent = await channel.messages.fetch({ limit: 50 });
  const existing = recent.find(
    (m) => m.author.id === botId && m.embeds.some((e) => e.footer?.text?.includes(PANEL_MARKER)),
  );

  const payload = { embeds: [ticketPanelEmbed(config)], components: ticketPanelComponents() };
  if (existing) {
    await existing.edit(payload);
  } else {
    await channel.send(payload);
  }
}

export function isTicketInteraction(customId: string): boolean {
  return customId === OPEN_BUTTON || customId === CLOSE_BUTTON || customId === MODAL;
}

/** Button press on the panel: ask what is wrong before making a thread, so
 *  the first message is the problem rather than "hello". */
export async function handleTicketButton(interaction: ButtonInteraction): Promise<void> {
  if (interaction.customId === OPEN_BUTTON) {
    const modal = new ModalBuilder().setCustomId(MODAL).setTitle("Open a ticket");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("subject")
          .setLabel("Subject")
          .setPlaceholder("Payment did not activate my plan")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(80)
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("detail")
          .setLabel("What happened? OS, app version, route")
          .setPlaceholder("No config files, keys or subscription links, please.")
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(1000)
          .setRequired(true),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (interaction.customId === CLOSE_BUTTON) {
    await closeTicket(interaction);
  }
}

export async function handleTicketModal(interaction: ModalSubmitInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guild = interaction.guild;
  const channel = interaction.channel;
  if (!guild || !channel || channel.type !== ChannelType.GuildText) {
    await interaction.editReply("Tickets can only be opened from the ticket channel.");
    return;
  }

  const member = interaction.member as GuildMember | null;
  const lang = langOf(member);
  const subject = interaction.fields.getTextInputValue("subject");
  const detail = interaction.fields.getTextInputValue("detail");

  // Private where the guild allows it. Private threads stopped needing a
  // boost level years ago, but a guild that still refuses must get a
  // working ticket rather than an error, so fall back to a public thread.
  let thread: ThreadChannel;
  try {
    thread = await channel.threads.create({
      name: `🎟 ${interaction.user.username} — ${subject}`.slice(0, 90),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      type: ChannelType.PrivateThread,
      invitable: false,
    });
  } catch {
    thread = await channel.threads.create({
      name: `🎟 ${interaction.user.username} — ${subject}`.slice(0, 90),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    });
  }

  await thread.members.add(interaction.user.id);

  const opened = new EmbedBuilder()
    .setTitle(subject)
    .setColor(BRAND_COLOUR)
    .setDescription(detail)
    .addFields({ name: "Opened by", value: `<@${interaction.user.id}>`, inline: true })
    .setTimestamp(new Date());

  const close = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(CLOSE_BUTTON).setLabel("Close ticket").setStyle(ButtonStyle.Secondary),
  );

  // Staff are pinged once, here, rather than added silently: a ticket
  // nobody is told about is a ticket nobody answers.
  const mentions = staffRoleIds(guild).map((id) => `<@&${id}>`).join(" ");
  await thread.send({
    content: mentions || undefined,
    embeds: [opened],
    components: [close],
    allowedMentions: { roles: staffRoleIds(guild) },
  });

  await interaction.editReply(`${copy.opened(lang)} <#${thread.id}>`);
}

async function closeTicket(interaction: ButtonInteraction): Promise<void> {
  const channel = interaction.channel;
  if (!channel?.isThread()) {
    await interaction.reply({ content: "That button only works inside a ticket.", flags: MessageFlags.Ephemeral });
    return;
  }

  const member = interaction.member as GuildMember | null;
  const lang = langOf(member);
  const starter = await channel.fetchStarterMessage().catch(() => null);
  const opener = starter?.embeds[0]?.fields?.find((f) => f.name === "Opened by")?.value ?? "";
  const isOpener = opener.includes(interaction.user.id);

  if (!isStaff(member) && !isOpener) {
    await interaction.reply({
      embeds: [new EmbedBuilder().setColor(BRAND_COLOUR_BAD).setDescription(copy.notAllowed(lang))],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(BRAND_COLOUR)
        .setDescription(`${copy.closed(lang)} — <@${interaction.user.id}>`),
    ],
  });

  // Archived and locked, not deleted: the history is the record of what was
  // promised to a customer, and staff can still read it.
  await channel.setLocked(true).catch(() => undefined);
  await channel.setArchived(true).catch(() => undefined);
}
