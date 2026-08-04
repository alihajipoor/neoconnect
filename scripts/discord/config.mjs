/**
 * The desired shape of the Neoxify Discord server: identity, roles, categories,
 * channels, onboarding, welcome screen, and AutoMod.
 *
 * This file is the thing you edit. `sync.mjs` reads it and makes the live
 * server match -- additively. Nothing here ever deletes: a channel or role you
 * remove from this file is left alone on the server, so hand-made additions
 * survive a sync.
 *
 * ## The language split
 *
 * Members pick English or Persian in a required onboarding prompt before they
 * see anything else, and that choice grants a role. Channels carrying
 * `lang: "en"` or `lang: "fa"` are hidden from @everyone and revealed only to
 * that role -- so an English speaker never sees the Persian channels and vice
 * versa. Staff always see both.
 *
 * A shared core stays visible to everyone regardless of language. That is not
 * decoration: Discord refuses to enable onboarding at all unless enough
 * channels are visible and postable by @everyone, so gating literally every
 * channel would break the very prompt that does the gating. The shared channels
 * are the ones where language matters least -- announcements, screenshots,
 * feature votes, bug reports.
 *
 * Channel names carry an emoji and a `・` separator. That is cosmetic, and the
 * matcher strips it, so `💬・general` still matches a channel already named
 * `general` -- an existing channel is renamed in place, never duplicated.
 *
 * Role colours are the product's own palette (see apps/panel/src/app/globals.css):
 * violet #8b5cf6 is the primary accent, cyan #22d3ee the secondary highlight.
 */

/**
 * Server-level identity. `description` and `icon` only take effect once
 * Community is enabled, which the sync does for you. `icon` is a path relative
 * to the repo root.
 */
export const guild = {
  name: "Neoxify",
  description: "Fast, private connections that stay up. Support, releases, and beta testing for Neoxify.",
  icon: "apps/desktop-windows/src-tauri/icons/icon.png",
};

/** Discord channel type ids. The last four require Community to be enabled. */
export const TEXT = 0;
export const VOICE = 2;
export const CATEGORY = 4;
export const ANNOUNCEMENT = 5;
export const STAGE = 13;
export const FORUM = 15;
export const MEDIA = 16;

/**
 * Roles, listed top of the hierarchy first. `key` is how channel presets and
 * onboarding refer to a role; `name` is what members see, and is also the match
 * key against roles that already exist on the server.
 *
 * Colour note: Discord shows a member in the colour of their highest *coloured*
 * role. The language and ping roles at the bottom are deliberately colourless
 * so they never override somebody's real role colour in the sidebar.
 */
export const roles = [
  {
    key: "founder",
    name: "Founder",
    color: 0x5b21b6,
    hoist: true,
    mentionable: false,
    permissions: ["ADMINISTRATOR"],
  },
  {
    key: "team",
    name: "Neoxify Team",
    color: 0x8b5cf6,
    hoist: true,
    mentionable: true,
    permissions: ["ADMINISTRATOR"],
  },
  {
    key: "moderator",
    name: "Moderator",
    color: 0x22d3ee,
    hoist: true,
    mentionable: true,
    permissions: [
      "VIEW_CHANNEL",
      "SEND_MESSAGES",
      "READ_MESSAGE_HISTORY",
      "MANAGE_MESSAGES",
      "MANAGE_THREADS",
      "KICK_MEMBERS",
      "BAN_MEMBERS",
      "MODERATE_MEMBERS",
      "MANAGE_NICKNAMES",
      "VIEW_AUDIT_LOG",
      "MUTE_MEMBERS",
      "DEAFEN_MEMBERS",
      "MOVE_MEMBERS",
      "CONNECT",
      "SPEAK",
      "ATTACH_FILES",
      "EMBED_LINKS",
      "ADD_REACTIONS",
    ],
  },
  {
    key: "support",
    name: "Support",
    color: 0x38bdf8,
    hoist: true,
    mentionable: true,
    permissions: [
      "VIEW_CHANNEL",
      "SEND_MESSAGES",
      "READ_MESSAGE_HISTORY",
      "MANAGE_MESSAGES",
      "CREATE_PUBLIC_THREADS",
      "SEND_MESSAGES_IN_THREADS",
      "MANAGE_THREADS",
      "CONNECT",
      "SPEAK",
      "MOVE_MEMBERS",
      "MUTE_MEMBERS",
      "ATTACH_FILES",
      "EMBED_LINKS",
      "ADD_REACTIONS",
    ],
  },
  {
    key: "beta",
    name: "Beta Tester",
    color: 0xf59e0b,
    hoist: true,
    mentionable: true,
    permissions: [],
  },
  {
    key: "subscriber",
    name: "Subscriber",
    color: 0x34d399,
    hoist: true,
    mentionable: false,
    permissions: [],
  },

  // Language roles. Granted by the required onboarding prompt; they are what
  // makes a channel visible at all, so nothing else may depend on them.
  { key: "en", name: "English", color: 0, hoist: false, mentionable: false, permissions: [] },
  { key: "fa", name: "فارسی", color: 0, hoist: false, mentionable: false, permissions: [] },

  // Opt-in notification roles.
  { key: "pingAnnounce", name: "Announcement Ping", color: 0, hoist: false, mentionable: true, permissions: [] },
  { key: "pingRelease", name: "Release Ping", color: 0, hoist: false, mentionable: true, permissions: [] },
  { key: "pingStatus", name: "Status Ping", color: 0, hoist: false, mentionable: true, permissions: [] },
];

/** Role keys that see every channel regardless of language. */
export const staffKeys = ["founder", "team", "moderator", "support"];

/**
 * Channel presets, expanded by sync.mjs into Discord permission overwrites.
 * Any entry may additionally carry `lang: "en" | "fa"`, which hides it from
 * @everyone and reveals it to that language role plus staff.
 *
 *   public       - everyone reads and posts
 *   readonly     - everyone reads, only staff post
 *   staffOnly    - invisible to everyone but staff
 *   betaOnly     - invisible to everyone but beta testers and staff
 *   betaReadonly - visible to beta testers, but only staff post
 *   voicePublic  - everyone may connect and speak
 *   voiceStaff   - invisible to everyone but staff
 *   voiceBeta    - invisible to everyone but beta testers and staff
 *   stagePublic  - everyone may listen; staff may speak
 */
export const structure = [
  {
    category: "🏠 ┃ START HERE",
    preset: "readonly",
    channels: [
      {
        name: "👋・welcome",
        type: TEXT,
        preset: "readonly",
        topic: "Start here · از اینجا شروع کنید — what Neoxify is, and the ground rules.",
      },
      {
        name: "📢・announcements",
        type: ANNOUNCEMENT,
        preset: "readonly",
        topic: "Product news and maintenance · اطلاعیه‌ها و اخبار محصول",
      },
      {
        name: "🚀・releases",
        type: ANNOUNCEMENT,
        preset: "readonly",
        topic: "New app builds and changelogs · نسخه‌های جدید برنامه",
      },
      {
        name: "🟢・server-status",
        type: TEXT,
        preset: "readonly",
        topic: "Node and route status · وضعیت سرورها و مسیرها",
      },
      // The next three hold self-updating panels written by the bot
      // (apps/discord-bot/src/panels.ts). Read-only because their content is
      // rewritten from live data every few minutes -- anything a person
      // posted here would be noise next to a message that edits itself.
      {
        name: "⬇️・downloads",
        type: TEXT,
        preset: "readonly",
        topic: "Every platform's newest build, updated automatically · دانلود آخرین نسخه",
      },
      {
        name: "💳・plans",
        type: TEXT,
        preset: "readonly",
        topic: "What is on sale right now, straight from the panel · پلن‌های فعلی",
      },
      {
        name: "🔗・links",
        type: TEXT,
        preset: "readonly",
        topic: "Official links, and what we will never ask you for · لینک‌های رسمی",
      },
    ],
  },
  {
    // Language-neutral by design: images, votes, and reports read the same in
    // any language, and Discord needs these visible to @everyone for onboarding.
    category: "🌍 ┃ SHARED",
    preset: "public",
    channels: [
      {
        name: "💬・lounge",
        type: TEXT,
        preset: "public",
        topic: "Any language welcome · به هر زبانی خوش آمدید",
        slowmode: 3,
      },
      // Read-only on purpose: the only thing to do here is press the button,
      // which opens a private thread. A channel people could type in would
      // fill with "hello?" messages nobody is watching.
      {
        name: "🎟️・open-a-ticket",
        type: TEXT,
        preset: "threadOnly",
        topic: "Account, payment or log problems — opens a private thread · تیکت خصوصی پشتیبانی",
      },
      {
        name: "🖼️・showcase",
        type: FORUM,
        layout: "gallery",
        preset: "public",
        topic: "Speed tests, dashboards, and setups. Redact anything identifying before you post.",
        defaultReaction: "🔥",
        tags: [
          { name: "Speed Test", emoji: "⚡" },
          { name: "Setup", emoji: "🛠" },
          { name: "Dashboard", emoji: "📊" },
        ],
      },
      {
        name: "💡・suggestions",
        type: FORUM,
        preset: "public",
        topic: "Feature requests, one post per idea · پیشنهادها، هر ایده یک پست",
        defaultReaction: "👍",
        tags: [
          { name: "Under Review", emoji: "👀", moderated: true },
          { name: "Planned", emoji: "📌", moderated: true },
          { name: "Shipped", emoji: "✅", moderated: true },
          { name: "Declined", emoji: "🚫", moderated: true },
          { name: "App", emoji: "💻" },
          { name: "Routing", emoji: "🌐" },
          { name: "Billing", emoji: "💳" },
        ],
      },
      {
        name: "🐛・bug-reports",
        type: FORUM,
        preset: "public",
        topic: "Reproducible bugs only. Steps, expected, actual, app version.",
        defaultReaction: "🐛",
        tags: [
          { name: "Confirmed", emoji: "✅", moderated: true },
          { name: "Fixed", emoji: "🎉", moderated: true },
          { name: "Cannot Reproduce", emoji: "🤔", moderated: true },
          { name: "App", emoji: "💻" },
          { name: "Installer", emoji: "📦" },
          { name: "Panel", emoji: "🌐" },
        ],
      },
      { name: "🎲・off-topic", type: TEXT, preset: "public", topic: "Everything that is not Neoxify." },
    ],
  },
  {
    category: "🇬🇧 ┃ ENGLISH",
    preset: "public",
    lang: "en",
    channels: [
      { name: "💬・general", type: TEXT, preset: "public", lang: "en", topic: "General chat, in English." },
      {
        name: "🛠️・setup-and-tips",
        type: TEXT,
        preset: "public",
        lang: "en",
        topic: "Install walkthroughs, configuration tips, and things that worked for you.",
      },
      {
        name: "⚡・speed-and-routing",
        type: TEXT,
        preset: "public",
        lang: "en",
        topic: "Throughput, latency, and which routes work best from where you are.",
      },
      {
        name: "🧩・split-tunneling",
        type: TEXT,
        preset: "public",
        lang: "en",
        topic: "Per-app routing: what you send through the tunnel and what you leave alone.",
      },
      {
        name: "🎫・get-help",
        type: FORUM,
        preset: "public",
        lang: "en",
        topic: "One post per problem. Tag it, and include your OS, app version, route, and protocol.",
        defaultReaction: "👀",
        tags: [
          { name: "Solved", emoji: "✅", moderated: true },
          { name: "Needs Info", emoji: "❔", moderated: true },
          { name: "Connection", emoji: "🔌" },
          { name: "Speed", emoji: "⚡" },
          { name: "App / Installer", emoji: "💻" },
          { name: "Billing", emoji: "💳" },
          { name: "Split Tunneling", emoji: "🧩" },
        ],
      },
      {
        name: "❓・faq",
        type: TEXT,
        preset: "readonly",
        lang: "en",
        topic: "The questions that come up most: setup, billing, speed, split tunneling.",
      },
      {
        name: "📚・resources",
        type: TEXT,
        preset: "readonly",
        lang: "en",
        topic: "Guides, links, and reference material worth keeping around.",
      },
      { name: "🎧・English Voice", type: VOICE, preset: "voicePublic", lang: "en" },
    ],
  },
  {
    category: "🇮🇷 ┃ فارسی",
    preset: "public",
    lang: "fa",
    channels: [
      { name: "💬・گفتگو", type: TEXT, preset: "public", lang: "fa", topic: "گفتگوی عمومی، به فارسی." },
      {
        name: "🛠️・نصب-و-راهنما",
        type: TEXT,
        preset: "public",
        lang: "fa",
        topic: "راهنمای نصب، تنظیمات، و تجربه‌هایی که برایتان جواب داده.",
      },
      {
        name: "⚡・سرعت-و-مسیر",
        type: TEXT,
        preset: "public",
        lang: "fa",
        topic: "سرعت، پینگ، و اینکه کدام مسیر از منطقهٔ شما بهتر کار می‌کند.",
      },
      {
        name: "🧩・تونل-تفکیکی",
        type: TEXT,
        preset: "public",
        lang: "fa",
        topic: "انتخاب اینکه ترافیک کدام برنامه از تونل عبور کند و کدام نکند.",
      },
      {
        name: "🎫・پشتیبانی",
        type: FORUM,
        preset: "public",
        lang: "fa",
        topic: "برای هر مشکل یک پست جدا بسازید و برچسب بزنید. سیستم‌عامل، نسخهٔ برنامه، مسیر و پروتکل را بنویسید.",
        defaultReaction: "👀",
        tags: [
          { name: "حل شد", emoji: "✅", moderated: true },
          { name: "اطلاعات ناقص", emoji: "❔", moderated: true },
          { name: "اتصال", emoji: "🔌" },
          { name: "سرعت", emoji: "⚡" },
          { name: "برنامه و نصب", emoji: "💻" },
          { name: "پرداخت", emoji: "💳" },
          { name: "تونل تفکیکی", emoji: "🧩" },
        ],
      },
      {
        name: "❓・سوالات-متداول",
        type: TEXT,
        preset: "readonly",
        lang: "fa",
        topic: "پرسش‌هایی که بیشترین تکرار را دارند: نصب، پرداخت، سرعت، تونل تفکیکی.",
      },
      {
        name: "📚・منابع",
        type: TEXT,
        preset: "readonly",
        lang: "fa",
        topic: "راهنماها، لینک‌ها، و منابعی که به کارتان می‌آید.",
      },
      { name: "🎧・گفتگوی-صوتی", type: VOICE, preset: "voicePublic", lang: "fa" },
    ],
  },
  {
    category: "🔊 ┃ VOICE",
    preset: "public",
    channels: [
      { name: "🎧・Lobby", type: VOICE, preset: "voicePublic" },
      { name: "🎮・Community 1", type: VOICE, preset: "voicePublic" },
      { name: "🎮・Community 2", type: VOICE, preset: "voicePublic" },
      { name: "🛟・Support Room", type: VOICE, preset: "voicePublic", userLimit: 4 },
      { name: "🎤・Community Stage", type: STAGE, preset: "stagePublic" },
      { name: "🔬・Beta Room", type: VOICE, preset: "voiceBeta" },
      { name: "😴・AFK", type: VOICE, preset: "voicePublic" },
    ],
  },
  {
    category: "🧪 ┃ BETA",
    preset: "betaOnly",
    channels: [
      {
        name: "📣・beta-announcements",
        type: TEXT,
        preset: "betaReadonly",
        topic: "What is in the current beta build and what needs testing.",
      },
      {
        name: "📦・beta-builds",
        type: TEXT,
        preset: "betaReadonly",
        topic: "Pre-release builds. Test builds -- do not redistribute.",
      },
      {
        name: "🔬・beta-feedback",
        type: FORUM,
        preset: "betaOnly",
        topic: "Findings from the current beta. Rough notes welcome.",
        tags: [
          { name: "Bug", emoji: "🐛" },
          { name: "Feedback", emoji: "💭" },
          { name: "Crash", emoji: "💥" },
          { name: "Triaged", emoji: "✅", moderated: true },
        ],
      },
    ],
  },
  {
    category: "🔒 ┃ STAFF",
    preset: "staffOnly",
    channels: [
      { name: "🧑‍💻・staff-chat", type: TEXT, preset: "staffOnly", topic: "Team coordination." },
      {
        name: "🚨・infra-alerts",
        type: TEXT,
        preset: "staffOnly",
        topic: "Node health, agent errors, and panel alerts.",
      },
      {
        name: "📋・mod-log",
        type: TEXT,
        preset: "staffOnly",
        topic: "Moderation actions and AutoMod hits.",
      },
      {
        name: "📡・community-updates",
        type: TEXT,
        preset: "staffOnly",
        topic: "Where Discord posts community and safety updates for this server.",
      },
      { name: "🔐・Staff Voice", type: VOICE, preset: "voiceStaff" },
    ],
  },
];

/**
 * Channels referenced by name elsewhere in the sync. Kept here so renaming a
 * channel above only needs one matching edit rather than a hunt through sync.mjs.
 */
export const specialChannels = {
  rules: "👋・welcome",
  communityUpdates: "📡・community-updates",
  modLog: "📋・mod-log",
};

/**
 * The Server Guide / welcome screen shown to people who have not joined yet.
 * Discord allows at most five channels, and they must be ones @everyone can
 * see -- so every entry here is from the shared core, never a gated channel.
 */
export const welcomeScreen = {
  description: "Fast, private connections that stay up · اتصالی سریع و پایدار",
  channels: [
    { channel: "👋・welcome", description: "Start here · از اینجا شروع کنید", emoji: "👋" },
    { channel: "💬・lounge", description: "Say hello · سلام کنید", emoji: "💬" },
    { channel: "🚀・releases", description: "New app builds", emoji: "🚀" },
    { channel: "💡・suggestions", description: "Ask for a feature", emoji: "💡" },
    { channel: "🐛・bug-reports", description: "Report a bug", emoji: "🐛" },
  ],
};

/**
 * Onboarding. The language prompt is `required`, so it is the first thing a new
 * member answers and nothing else is reachable until they do -- that is what
 * makes the split work.
 *
 * `defaultChannels` may only contain shared channels. A gated channel here
 * would be invisible to a member who has not chosen a language yet, which is
 * everybody at the moment the list is evaluated.
 */
export const onboarding = {
  defaultChannels: [
    "👋・welcome",
    "📢・announcements",
    "🚀・releases",
    "🟢・server-status",
    "💬・lounge",
    "🖼️・showcase",
    "💡・suggestions",
    "🐛・bug-reports",
    "🎲・off-topic",
  ],
  prompts: [
    {
      title: "Choose your language · زبان خود را انتخاب کنید",
      singleSelect: true,
      required: true,
      options: [
        {
          title: "English",
          description: "Show me the English channels",
          emoji: "🇬🇧",
          roles: ["en"],
        },
        {
          title: "فارسی",
          description: "کانال‌های فارسی را به من نشان بده",
          emoji: "🇮🇷",
          roles: ["fa"],
        },
      ],
    },
    {
      title: "What do you want to be notified about?",
      singleSelect: false,
      required: false,
      options: [
        {
          title: "Product news · اخبار محصول",
          description: "Maintenance, outages, anything affecting your connection",
          emoji: "📢",
          roles: ["pingAnnounce"],
        },
        {
          title: "New releases · نسخه‌های جدید",
          description: "Pinged only when a new desktop build ships",
          emoji: "🚀",
          roles: ["pingRelease"],
        },
        {
          title: "Node status · وضعیت سرورها",
          description: "Outages and recoveries only",
          emoji: "🟢",
          roles: ["pingStatus"],
        },
      ],
    },
    {
      title: "What brings you here?",
      singleSelect: true,
      required: false,
      options: [
        {
          title: "I need help · کمک می‌خواهم",
          description: "Points you at the help forums",
          emoji: "🛟",
          channels: ["🐛・bug-reports"],
        },
        {
          title: "Making it faster · سرعت بیشتر",
          description: "Routing, throughput, and split tunneling",
          emoji: "⚡",
          channels: ["🖼️・showcase"],
        },
        {
          title: "Just hanging out · فقط گپ",
          description: "General chat and off-topic",
          emoji: "💬",
          channels: ["💬・lounge", "🎲・off-topic"],
        },
        {
          title: "Shaping the product · بهبود محصول",
          description: "Feature requests and beta testing",
          emoji: "💡",
          channels: ["💡・suggestions"],
        },
      ],
    },
  ],
};

/**
 * AutoMod rules. The first one is the reason this section exists: a VPN server
 * attracts people pasting their own subscription links and config files into
 * public channels, which hands their account to whoever reads it. Blocking that
 * automatically is worth more than any amount of asking politely.
 *
 * Staff are exempt from all of them.
 */
export const autoMod = [
  {
    name: "Block leaked credentials and configs",
    trigger: "regex",
    patterns: [
      "(?i)\\b(vless|vmess|trojan|ss|ssr)://\\S+",
      "-----BEGIN [A-Z ]*PRIVATE KEY-----",
      "(?i)privatekey\\s*=\\s*\\S{20,}",
      "(?i)\\[interface\\]\\s*\\n",
      "(?i)\\bpsk\\s*=\\s*\\S{16,}",
    ],
    message:
      "That looks like a VPN config or key. Posting it publicly hands your account to anyone reading. Send it to staff privately instead.",
    alert: true,
  },
  {
    name: "Block server invites",
    trigger: "keyword",
    keywords: ["discord.gg/*", "discord.com/invite/*", "discordapp.com/invite/*", "dsc.gg/*"],
    message: "Invite links are not allowed here. Ask a moderator if you think this one belongs.",
    alert: true,
  },
  {
    name: "Block account trading and resale",
    trigger: "keyword",
    keywords: [
      "*selling account*",
      "*account for sale*",
      "*cheap panel*",
      "*فروش اکانت*",
      "*اکانت ارزان*",
      "*پنل ارزان*",
    ],
    message: "Reselling or trading accounts is not allowed. · خرید و فروش اکانت در این سرور مجاز نیست.",
    alert: true,
  },
  {
    name: "Block mention spam",
    trigger: "mentionSpam",
    mentionLimit: 6,
    alert: true,
  },
  {
    name: "Block spam and scam patterns",
    trigger: "spam",
    alert: true,
  },
  {
    name: "Block slurs and explicit content",
    trigger: "preset",
    presets: [2, 3], // 2 = SEXUAL_CONTENT, 3 = SLURS
    alert: true,
  },
];
