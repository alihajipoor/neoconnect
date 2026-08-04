/**
 * Starter posts for the read-only channels, so they are not empty on day one.
 *
 * Keyed by channel name; the key is matched the same loose way as everywhere
 * else, so `welcome` finds `👋・welcome` and `سوالات-متداول` finds
 * `❓・سوالات-متداول`. Each value is a list of messages posted in order.
 * Discord caps a message at 2000 characters, which is why the longer channels
 * are split rather than written as one block.
 *
 * `sync.mjs seed-content` skips any channel that already has a post from the
 * bot, so editing these and re-running will not duplicate them -- delete the
 * old posts first if you want them replaced.
 */

/**
 * Header images posted above the text, one per channel. Rendered by
 * `posters.mjs` into `posters/`; the PNGs are committed so a sync needs no
 * build step.
 */
export const channelPosters = {
  welcome: "welcome.png",
  announcements: "announcements.png",
  releases: "releases.png",
  "server-status": "server-status.png",
  faq: "faq.png",
  resources: "resources.png",
  "سوالات-متداول": "faq-fa.png",
  منابع: "resources-fa.png",
};

export const channelContent = {
  // Bilingual on purpose: this is the one channel every member sees before
  // they have chosen a language.
  welcome: [
    [
      "# Welcome to Neoxify · به نئوکسیفای خوش آمدید",
      "",
      "Neoxify is a VPN built for connections that are fast **and** stay up: three protocols, routes you pick per region, and per-app split tunneling.",
      "",
      "**First step — pick your language.** Open **Channels & Roles** at the top of the channel list and choose English or فارسی. The channels for your language appear once you do.",
      "",
      "نئوکسیفای یک VPN است برای اتصالی که هم **سریع** باشد و هم **پایدار**: سه پروتکل، انتخاب مسیر بر اساس منطقه، و تونل تفکیکی برای هر برنامه.",
      "",
      "**قدم اول — زبانتان را انتخاب کنید.** از بالای فهرست کانال‌ها گزینهٔ **Channels & Roles** را باز کنید و English یا فارسی را بزنید. کانال‌های زبان شما بعد از آن نمایان می‌شوند.",
      "",
      "**Links · لینک‌ها**",
      "- <https://neoxify.net> — download · دانلود",
      "- <https://connect.neoxify.com> — account, plans, invoices · حساب کاربری، پلن‌ها، فاکتورها",
    ].join("\n"),

    [
      "## Ground rules",
      "",
      "**1. Never post credentials.** No subscription links, config files, WireGuard or OpenVPN keys, VLESS URIs, or invoice links — not in a channel, not in a screenshot. AutoMod blocks the obvious cases, but it cannot read a screenshot.",
      "**2. Staff will never DM you first.** Anyone claiming to be staff who opens a DM asking for payment or account access is a scammer.",
      "**3. One problem, one post.** Use the help forum for your language and tag it.",
      "**4. No account trading or reselling.** Accounts doing this get terminated.",
      "**5. Keep it civil.** No harassment, hate speech, or NSFW content.",
      "",
      "Breaking rule 1 or 2 in a way that puts other members at risk is an immediate ban, not a warning.",
    ].join("\n"),

    [
      "## قوانین",
      "",
      "**۱. هرگز اطلاعات اتصال خود را عمومی نکنید.** لینک اشتراک، فایل کانفیگ، کلید WireGuard یا OpenVPN، آدرس VLESS و لینک فاکتور را نه در کانال بفرستید و نه در اسکرین‌شات. سیستم خودکار موارد آشکار را مسدود می‌کند، اما متن داخل عکس را نمی‌خواند.",
      "**۲. تیم پشتیبانی هرگز اول به شما پیام خصوصی نمی‌دهد.** هر کسی که خود را پشتیبان معرفی کند و در پیام خصوصی درخواست پرداخت یا دسترسی به حساب کند، کلاهبردار است.",
      "**۳. برای هر مشکل یک پست جدا.** در انجمن پشتیبانی فارسی پست بسازید و برچسب مناسب بزنید.",
      "**۴. خرید و فروش اکانت ممنوع است.** حساب‌هایی که این کار را بکنند مسدود می‌شوند.",
      "**۵. محترمانه بنویسید.** توهین، نفرت‌پراکنی و محتوای نامناسب جایی اینجا ندارد.",
      "",
      "نقض قانون ۱ یا ۲ به شکلی که دیگران را در خطر بگذارد، مستقیم به مسدودی دائم منجر می‌شود.",
    ].join("\n"),
  ],

  announcements: [],
  releases: [],
  "server-status": [],

  faq: [
    [
      "**Which protocol should I use?**",
      "Start on WireGuard — fastest and lightest. Switch to VLESS where a network actively blocks VPN traffic, since it is hardest to spot. OpenVPN is the compatibility fallback.",
      "",
      "**My speed is lower than my plan says.**",
      "Try a route physically closer to you first, then a different protocol. Post the numbers in `speed-and-routing` with your route name — throughput problems are usually route-specific, not account-specific.",
      "",
      "**Can I route only some apps through the VPN?**",
      "Yes. Split tunneling lets you choose per application. Ask in `split-tunneling` for help setting it up.",
      "",
      "**How many devices can I use?**",
      "Depends on your plan. Your limit and active devices are at <https://connect.neoxify.com>.",
    ].join("\n"),

    [
      "**I paid and nothing happened.**",
      "Card payments usually settle in under a minute; crypto waits for network confirmations. If it has been over an hour, open a post in `get-help` with the `Billing` tag — time and payment method only, **no transaction hashes or receipts in public**.",
      "",
      "**Where do I download the app?**",
      "Only from <https://neoxify.net>. Never install a build shared by another member — a VPN client is exactly the thing you do not want a stranger's copy of.",
      "",
      "**How do I join the beta?**",
      "Ask in `suggestions`. Beta testers get the `Beta Tester` role and the private beta category.",
      "",
      "**How do I change my language or my pings?**",
      "**Channels & Roles**, at the top of the channel list. You can switch whenever you like.",
    ].join("\n"),
  ],

  resources: [
    [
      "**Official**",
      "- Website and downloads — <https://neoxify.net>",
      "- Account, plans, invoices, devices — <https://connect.neoxify.com>",
      "",
      "**In this server**",
      "- `faq` — the short answers",
      "- `get-help` — open a post when you are stuck",
      "- `setup-and-tips` — walkthroughs from other users",
      "- `speed-and-routing` — which routes work well from where",
      "- `split-tunneling` — per-app routing",
      "",
      "**A note on links**",
      "Only download the client from neoxify.net. Anything posted here by another member is a link someone typed, not something we vouch for — and a tampered VPN client sees everything you do.",
    ].join("\n"),
  ],

  "سوالات-متداول": [
    [
      "**کدام پروتکل را انتخاب کنم؟**",
      "با WireGuard شروع کنید؛ سریع‌ترین و سبک‌ترین گزینه است. اگر شبکه‌ای فعالانه ترافیک VPN را مسدود می‌کند، به VLESS سوئیچ کنید چون تشخیصش سخت‌ترین است. OpenVPN گزینهٔ سازگاری است.",
      "",
      "**سرعتم از چیزی که در پلن نوشته کمتر است.**",
      "اول مسیری را امتحان کنید که از نظر جغرافیایی به شما نزدیک‌تر است، بعد پروتکل دیگری را. نتیجه را با نام مسیر در کانال `سرعت-و-مسیر` بفرستید؛ افت سرعت معمولاً به مسیر مربوط است نه به حساب شما.",
      "",
      "**می‌توانم فقط ترافیک بعضی برنامه‌ها را از تونل رد کنم؟**",
      "بله. تونل تفکیکی این امکان را برای هر برنامه جداگانه می‌دهد. برای راهنمایی در `تونل-تفکیکی` بپرسید.",
      "",
      "**روی چند دستگاه می‌توانم استفاده کنم؟**",
      "بستگی به پلن شما دارد. سقف و دستگاه‌های فعالتان در <https://connect.neoxify.com> آمده است.",
    ].join("\n"),

    [
      "**پرداخت کردم ولی چیزی فعال نشد.**",
      "پرداخت کارتی معمولاً زیر یک دقیقه تسویه می‌شود؛ رمزارز منتظر تأیید شبکه می‌ماند و ممکن است طول بکشد. اگر بیش از یک ساعت گذشته، در `پشتیبانی` پستی با برچسب `پرداخت` بسازید و فقط زمان و روش پرداخت را بنویسید — **هش تراکنش یا رسید را عمومی نفرستید**.",
      "",
      "**برنامه را از کجا دانلود کنم؟**",
      "فقط از <https://neoxify.net>. هرگز نسخه‌ای را که یک کاربر دیگر فرستاده نصب نکنید؛ کلاینت VPN دقیقاً همان چیزی است که نباید نسخهٔ دستکاری‌شده‌اش را اجرا کنید.",
      "",
      "**چطور در نسخهٔ آزمایشی شرکت کنم؟**",
      "در `suggestions` بپرسید. تسترها نقش `Beta Tester` و دسترسی به بخش خصوصی بتا را می‌گیرند.",
      "",
      "**چطور زبان یا اعلان‌هایم را عوض کنم؟**",
      "از بالای فهرست کانال‌ها **Channels & Roles** را باز کنید. هر وقت خواستید می‌توانید تغییرش دهید.",
    ].join("\n"),
  ],

  منابع: [
    [
      "**رسمی**",
      "- وب‌سایت و دانلود — <https://neoxify.net>",
      "- حساب کاربری، پلن‌ها، فاکتورها، دستگاه‌ها — <https://connect.neoxify.com>",
      "",
      "**در همین سرور**",
      "- `سوالات-متداول` — پاسخ‌های کوتاه",
      "- `پشتیبانی` — وقتی گیر کردید پست بسازید",
      "- `نصب-و-راهنما` — راهنماهای کاربران دیگر",
      "- `سرعت-و-مسیر` — اینکه کدام مسیر از کجا بهتر جواب می‌دهد",
      "- `تونل-تفکیکی` — عبور دادن ترافیک بعضی برنامه‌ها",
      "",
      "**دربارهٔ لینک‌ها**",
      "کلاینت را فقط از neoxify.net بگیرید. هر لینکی که کاربر دیگری اینجا می‌گذارد صرفاً چیزی است که او تایپ کرده و مورد تأیید ما نیست — و یک کلاینت VPN دستکاری‌شده همهٔ کارهای شما را می‌بیند.",
    ].join("\n"),
  ],
};
