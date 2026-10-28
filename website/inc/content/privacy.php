<?php
/**
 * Privacy statement content, per locale, in one file.
 *
 * ---------------------------------------------------------------------------
 * THIS IS A DRAFT, NOT LEGAL ADVICE. It was written by reading what the system
 * actually stores -- the Prisma schema, the payment modules, this website's own
 * form handler -- rather than from a template. That makes it accurate about
 * the product, which is the part most published policies get wrong. It does
 * not make it a lawyer's work, and it has not been checked against the GDPR or
 * any other regime you may fall under. Have it reviewed before you rely on it.
 * ---------------------------------------------------------------------------
 *
 * Two claims here were deliberately NOT made, because the code does not
 * support them:
 *
 *   - "We keep no logs." The Xray config the installer ships sets
 *     "access": "/var/log/xray/access.log", and an access log records
 *     connection destinations. Saying otherwise would be false.
 *   - "We never see your payment details." Card data genuinely never reaches
 *     us, but PaymentTransaction.rawWebhookPayload stores the provider's
 *     confirmation, which can contain a name, country or card last four.
 *
 * Two more were taken out on 2026-10-28, the day they stopped being true:
 * "It doesn't record what you used it for" and "We don't use them to build
 * a profile of you". By the owner's decision of that day, the node agents
 * report which destinations each account's connections opened
 * (DestinationBatch in packages/proto/agent.proto), the backend keeps them
 * for 7 days in site_visits (the SiteVisit model), and staff read them on
 * the customer's page in the panel. A list of sites tied to an account is a
 * profile by any reader's meaning of the word, so the page now says what is
 * kept, for how long, and who can see it.
 *
 * "Most connection types" is deliberate. Only some of the engines feed that
 * record (the SiteVisit model says which), but public pages never name
 * protocols, ports, server hosts or the relay, so the page cannot say which
 * ones are left out. Do not let it drift into "every connection" either. If
 * all of them start reporting, change it then.
 *
 * "Only a few of us can open the list of sites, and each time someone does,
 * it's logged" holds because GET /customers/:id/sites is SUPERADMIN only
 * and writes an admin audit entry on every call. Widen that endpoint and
 * this sentence has to change with it.
 *
 * The numbers are the code's and must move with it: 7 days is the
 * site-visits sweep, 14 and 60 days are RETENTION_DAYS and
 * KEEP_WITHOUT_ADDRESS_DAYS in the backend's client-attempts module. Those
 * app reports (ClientAttempt) are older than the site record, but this page
 * never mentioned them until the same day.
 *
 * If you change any of this in the product, update this file to match. The
 * home page's "No logs" answer (home.answers.1.say in inc/lang) repeats the
 * short version and has to agree with it.
 *
 * Sections render in order: title, then each paragraph, then optional bullets.
 */

defined('NX') || exit;

return array(

    'updated' => '2026-10-28',

    'sections' => array(

        array(
            'title' => array(
                'en' => 'What this page covers',
                'fa' => 'این صفحه درباره چیست',
            ),
            'body' => array(
                'en' => array(
                    'This page covers the Neoxify website, the Neoxify apps and the VPN service. It explains what we collect, why, and what you can ask us to do with it.',
                    'If anything here is unclear, write to us and ask. The address is at the bottom of the page.',
                ),
                'fa' => array(
                    'این صفحه درباره وب‌سایت نئوکسیفای، برنامه‌های نئوکسیفای و سرویس وی‌پی‌ان است. توضیح می‌دهد چه اطلاعاتی جمع می‌کنیم، برای چه، و چه درخواستی می‌توانید درباره آن داشته باشید.',
                    'اگر جایی از این متن روشن نیست، از ما بپرسید. آدرس ایمیل پایین صفحه است.',
                ),
            ),
        ),

        array(
            'title' => array(
                'en' => 'What we store for your account',
                'fa' => 'اطلاعاتی که برای حسابتان نگه می‌داریم',
            ),
            'body' => array(
                'en' => array(
                    'To create and run your account, we store:',
                ),
                'fa' => array(
                    'برای ساختن و اداره حسابتان این‌ها را نگه می‌داریم:',
                ),
            ),
            'bullets' => array(
                'en' => array(
                    'Your email address. You sign in with it, we use it to confirm the account is yours, and we contact you through it.',
                    'Your password, stored only as a cryptographic hash. We can\'t read it and can\'t tell you what it is.',
                    'A Telegram username, only if you choose to give one.',
                    'Your plan: which one, when it renews and how much data you\'ve used.',
                    'The devices you sign in on: what kind each one is, the name the app shows for it, and when it was last used.',
                    'Support messages you send us from the app.',
                    'A referral code, and who invited you, if you joined through someone else\'s invitation.',
                ),
                'fa' => array(
                    'ایمیل شما. با آن وارد می‌شوید، با آن تأیید می‌کنیم حساب مال شماست و از همین راه با شما در تماس هستیم.',
                    'رمز عبور شما، فقط به شکل هش رمزنگاری‌شده. ما نمی‌توانیم آن را بخوانیم و نمی‌توانیم به شما بگوییم چیست.',
                    'نام کاربری تلگرام، فقط اگر خودتان وارد کنید.',
                    'پلن شما: کدام پلن، کی تمدید می‌شود و چقدر از حجمش را مصرف کرده‌اید.',
                    'دستگاه‌هایی که با آن‌ها وارد حسابتان می‌شوید: نوع هر دستگاه، اسمی که برنامه برایش نشان می‌دهد و آخرین باری که از آن استفاده شده.',
                    'پیام‌هایی که از داخل برنامه برای پشتیبانی می‌فرستید.',
                    'کد دعوت، و اینکه چه کسی شما را دعوت کرده، اگر با دعوت کس دیگری عضو شده باشید.',
                ),
            ),
        ),

        array(
            'title' => array(
                'en' => 'Payments',
                'fa' => 'پرداخت',
            ),
            'body' => array(
                'en' => array(
                    'Payments are handled by our payment providers: Stripe for cards and NowPayments for crypto. Your card number goes straight to the provider and never reaches our servers.',
                    'We store a record of each transaction: the amount, the currency, the status, the provider\'s reference number and the confirmation the provider sends back. That confirmation can include a name, a country or the last four digits of a card. Like any business, we keep invoices.',
                ),
                'fa' => array(
                    'پرداخت‌ها را شرکت‌های پرداخت انجام می‌دهند: Stripe برای کارت و NowPayments برای رمزارز. شماره کارت شما مستقیم به همین شرکت‌ها می‌رود و هیچ‌وقت به سرورهای ما نمی‌رسد.',
                    'از هر تراکنش یک سابقه نگه می‌داریم: مبلغ، واحد پول، وضعیت، شماره پیگیری شرکت پرداخت و تأییدیه‌ای که آن شرکت برمی‌گرداند. این تأییدیه ممکن است نام، کشور یا چهار رقم آخر کارت را داشته باشد. فاکتورها را هم مثل هر کسب‌وکار دیگری نگه می‌داریم.',
                ),
            ),
        ),

        array(
            'title' => array(
                'en' => 'What our servers record',
                'fa' => 'سرورهای ما چه چیزی ثبت می‌کنند',
            ),
            'body' => array(
                'en' => array(
                    'This is the part people ask about most.',
                    'Our billing system records how much data you use, in bytes, and on which server. That\'s how it applies your plan\'s limit.',
                    'For most connection types, our servers also record which sites and addresses you connected to through the VPN. Each record is linked to your account. It shows the site or address, the server you used, how many times and when. Often it\'s only an IP address, with no site name. It doesn\'t show which pages you read on a site, or what you sent and received. We keep these records for 7 days, then delete them.',
                    'The app also sends us a short report when you sign up, sign in or connect, whether it works or not. It says which servers and connection types the app tried and what happened. It also includes the app version, the kind of device, your internet provider and your IP address. If you\'re signed in, the report is linked to your account. We delete the IP address after 14 days and the rest of the report after 60 days.',
                    'Like most network software, the servers also keep operational logs, and these can include connection records.',
                    'We use all of this to fix connection problems and to keep an eye on how the service is running. Our support team sees it when they open your account. Only a few of us can open the list of sites, and each time someone does, it\'s logged. We don\'t sell any of it, and we don\'t give it to advertisers.',
                    'If you need a stronger guarantee than this, ask us before you assume one.',
                ),
                'fa' => array(
                    'این بخشی است که بیشتر از همه درباره‌اش سؤال می‌شود.',
                    'سیستم صورتحساب ما حجم مصرفی شما را به بایت ثبت می‌کند و اینکه روی کدام سرور مصرف شده است. سقف پلنتان از روی همین حساب می‌شود.',
                    'در بیشتر روش‌های اتصال، سرورهای ما ثبت می‌کنند که از طریق وی‌پی‌ان به کدام سایت‌ها و آدرس‌ها وصل شده‌اید. هر مورد با حساب کاربری شما ثبت می‌شود و نشان می‌دهد چه سایت یا آدرسی بوده، از کدام سرور، چند بار و کی. خیلی وقت‌ها فقط آدرس IP است و اسم سایت را ندارد. اینکه چه صفحه‌هایی از یک سایت را دیده‌اید، یا چه چیزی فرستاده‌اید و گرفته‌اید، در آن نیست. این سوابق را ۷ روز نگه می‌داریم و بعد پاک می‌کنیم.',
                    'برنامه هم وقتی ثبت‌نام می‌کنید، وارد حسابتان می‌شوید یا وصل می‌شوید، چه موفق شود چه نه، یک گزارش کوتاه برایمان می‌فرستد. در این گزارش آمده که برنامه کدام سرورها و روش‌های اتصال را امتحان کرده و نتیجه چه شده است. نسخه برنامه، نوع دستگاه، اپراتور اینترنتتان و آدرس IP شما هم در آن هست. اگر وارد حسابتان شده باشید، گزارش با حساب کاربری شما ثبت می‌شود. آدرس IP را بعد از ۱۴ روز پاک می‌کنیم و بقیه گزارش را بعد از ۶۰ روز.',
                    'خود سرورها هم مثل بیشتر نرم‌افزارهای شبکه لاگ‌های عملیاتی نگه می‌دارند که ممکن است سوابق اتصال را هم شامل شود.',
                    'از همه این‌ها برای رفع مشکلات اتصال و بررسی وضعیت سرویس استفاده می‌کنیم. تیم پشتیبانی ما وقتی حساب شما را باز می‌کند، این‌ها را می‌بیند. فهرست سایت‌ها را فقط چند نفر از ما می‌توانند باز کنند و هر بار که کسی این کار را بکند، ثبت می‌شود. هیچ‌کدام از این‌ها را نمی‌فروشیم و به تبلیغ‌کننده‌ها نمی‌دهیم.',
                    'اگر به تضمینی بیشتر از این نیاز دارید، قبل از هر فرضی از ما بپرسید.',
                ),
            ),
        ),

        array(
            'title' => array(
                'en' => 'This website',
                'fa' => 'همین وب‌سایت',
            ),
            'body' => array(
                'en' => array(
                    'This website sets at most two cookies, and only when you use the switch each one belongs to. One remembers whether you chose English or Persian, the other whether you chose the light or dark theme. Each holds that one word and nothing else, and neither identifies anyone. That\'s why there\'s no cookie banner: remembering a choice you made yourself doesn\'t need consent. There\'s no analytics, nothing loads from any other company, and nothing tracks you between visits.',
                    'Before you choose a language, we pick one from the language your browser asks for, and from a country code if the network in front of our server adds one to the request. Neither is stored, and you can always switch.',
                    'If you send the contact form or apply to be a reseller, we receive what you typed: your name, email address and message, plus the extra fields on the reseller form. We also store a one-way hash of your IP address to stop the form being abused. We don\'t keep the address itself.',
                ),
                'fa' => array(
                    'این سایت حداکثر دو کوکی می‌گذارد، آن هم فقط وقتی از کلید مربوط به هرکدام استفاده کنید. یکی به خاطر می‌سپارد انگلیسی را انتخاب کرده‌اید یا فارسی، و دیگری حالت روشن یا تیره را. در هرکدام فقط همان یک کلمه هست و هیچ‌کدام کسی را شناسایی نمی‌کند. برای همین بنر کوکی نداریم؛ به خاطر سپردن انتخابی که خودتان کرده‌اید رضایت جداگانه لازم ندارد. ابزار آمار و تحلیل نداریم، چیزی از سرور شرکت‌های دیگر بارگذاری نمی‌شود و بین بازدیدها ردیابی‌تان نمی‌کنیم.',
                    'تا وقتی زبان را انتخاب نکرده‌اید، زبان صفحه را از روی زبانی که مرورگرتان درخواست می‌کند تعیین می‌کنیم، و از روی کد کشور اگر شبکه‌ای که جلوی سرور ماست آن را به درخواست اضافه کند. هیچ‌کدام ذخیره نمی‌شود و همیشه می‌توانید زبان را عوض کنید.',
                    'اگر فرم تماس یا درخواست نمایندگی را بفرستید، آنچه نوشته‌اید به دست ما می‌رسد: نام، ایمیل و پیامتان، به‌علاوه فیلدهای اضافه فرم نمایندگی. یک هش یک‌طرفه از آدرس IP شما را هم نگه می‌داریم تا جلوی سوءاستفاده از فرم گرفته شود. خود آدرس IP را نگه نمی‌داریم.',
                ),
            ),
        ),

        array(
            'title' => array(
                'en' => 'Who else sees your data',
                'fa' => 'چه کسان دیگری اطلاعات شما را می‌بینند',
            ),
            'body' => array(
                'en' => array(
                    'We don\'t sell your data, and we don\'t share it for advertising.',
                    'It goes to other companies only where the service can\'t work without it: our payment providers process your payments, and our email provider delivers the emails we send you. We may also disclose information when a law that actually applies to us requires it.',
                ),
                'fa' => array(
                    'اطلاعات شما را نمی‌فروشیم و برای تبلیغات در اختیار کسی نمی‌گذاریم.',
                    'اطلاعات فقط وقتی به شرکت‌های دیگر می‌رسد که سرویس بدون آن کار نکند: شرکت‌های پرداخت، پرداخت شما را انجام می‌دهند و سرویس ایمیل ما، ایمیل‌هایمان را به دستتان می‌رساند. اگر قانونی که واقعاً شامل حال ما می‌شود لازم بداند، ممکن است اطلاعاتی را در اختیار بگذاریم.',
                ),
            ),
        ),

        array(
            'title' => array(
                'en' => 'How long we keep it, and how to delete it',
                'fa' => 'تا کی نگه می‌داریم و چطور حذفش کنید',
            ),
            'body' => array(
                'en' => array(
                    'We keep account data while your account exists. We keep invoices and payment records longer, because accounting rules usually require it.',
                    'We delete the record of sites and addresses you connected to after 7 days. We delete the IP address in the app\'s reports after 14 days, and the reports themselves after 60.',
                    'You can ask us for a copy of what we hold about you, ask us to correct it, or ask us to delete your account. Write to us from your account\'s email address and we\'ll take care of it.',
                ),
                'fa' => array(
                    'اطلاعات حساب را تا وقتی حسابتان وجود دارد نگه می‌داریم. فاکتورها و سوابق پرداخت را بیشتر نگه می‌داریم، چون قوانین حسابداری معمولاً این را لازم می‌دانند.',
                    'سوابق سایت‌ها و آدرس‌هایی را که به آن‌ها وصل شده‌اید بعد از ۷ روز پاک می‌کنیم. آدرس IP را در گزارش‌های برنامه بعد از ۱۴ روز پاک می‌کنیم و خود گزارش‌ها را بعد از ۶۰ روز.',
                    'می‌توانید یک نسخه از اطلاعاتی که درباره‌تان داریم بخواهید، اصلاحش را بخواهید یا درخواست حذف حسابتان را بدهید. از ایمیل حسابتان برایمان بنویسید تا انجامش دهیم.',
                ),
            ),
        ),

        array(
            'title' => array(
                'en' => 'Security',
                'fa' => 'امنیت',
            ),
            'body' => array(
                'en' => array(
                    'Passwords are stored only as hashes. Connection credentials are encrypted where we store them. Traffic between your device and our servers is encrypted, and this website uses HTTPS.',
                    'No service can promise it will never be breached. If something happens that affects you, we\'ll tell you.',
                ),
                'fa' => array(
                    'رمزهای عبور فقط به شکل هش ذخیره می‌شوند. اطلاعات اتصال را رمزنگاری‌شده نگه می‌داریم. ترافیک بین دستگاه شما و سرورهای ما رمزنگاری می‌شود و این سایت از HTTPS استفاده می‌کند.',
                    'هیچ سرویسی نمی‌تواند قول بدهد هیچ‌وقت هک نشود. اگر اتفاقی بیفتد که روی شما اثر بگذارد، به شما خبر می‌دهیم.',
                ),
            ),
        ),

        array(
            'title' => array(
                'en' => 'Children',
                'fa' => 'کودکان',
            ),
            'body' => array(
                'en' => array(
                    'Neoxify isn\'t meant for children, and we don\'t knowingly create accounts for them.',
                ),
                'fa' => array(
                    'نئوکسیفای برای کودکان نیست و ما آگاهانه برای آن‌ها حساب نمی‌سازیم.',
                ),
            ),
        ),

        array(
            'title' => array(
                'en' => 'Changes to this page',
                'fa' => 'تغییرات این صفحه',
            ),
            'body' => array(
                'en' => array(
                    'If this page changes in a way that matters, we\'ll update the date at the top. If the change is significant, we\'ll also email account holders.',
                ),
                'fa' => array(
                    'اگر این صفحه تغییر مهمی کند، تاریخ بالای صفحه را به‌روز می‌کنیم. اگر تغییر جدی باشد، به صاحبان حساب هم ایمیل می‌زنیم.',
                ),
            ),
        ),
    ),
);
