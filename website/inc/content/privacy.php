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
 * If you change either of those in the product, update this file to match.
 *
 * Sections render in order: title, then each paragraph, then optional bullets.
 */

defined('NX') || exit;

return array(

    'updated' => '2026-08-03',

    'sections' => array(

        array(
            'title' => array(
                'en' => 'Who this covers',
                'fa' => 'این سند شامل چه چیزی می‌شود',
            ),
            'body' => array(
                'en' => array(
                    'This statement covers the Neoxify website and the Neoxify apps and VPN service. It explains what we collect, why, and what you can ask us to do about it.',
                    'If anything here is unclear, write to us and ask. The address is at the bottom.',
                ),
                'fa' => array(
                    'این سند وب‌سایت نئوکسیفای و همچنین برنامه‌ها و سرویس وی‌پی‌ان نئوکسیفای را پوشش می‌دهد. توضیح می‌دهد چه اطلاعاتی جمع‌آوری می‌کنیم، چرا، و شما چه چیزی می‌توانید از ما بخواهید.',
                    'اگر بخشی از این متن برایتان روشن نیست، برای ما بنویسید و بپرسید. آدرس تماس در انتهای صفحه است.',
                ),
            ),
        ),

        array(
            'title' => array(
                'en' => 'What we collect for your account',
                'fa' => 'چه اطلاعاتی برای حساب کاربری شما جمع‌آوری می‌کنیم',
            ),
            'body' => array(
                'en' => array(
                    'To create and run an account we store:',
                ),
                'fa' => array(
                    'برای ساخت و اداره یک حساب کاربری این موارد را ذخیره می‌کنیم:',
                ),
            ),
            'bullets' => array(
                'en' => array(
                    'Your email address. It is how you sign in, how we confirm the account is yours, and how we reach you about it.',
                    'Your password, stored only as a cryptographic hash. We cannot read it and cannot tell you what it is.',
                    'A Telegram username, only if you choose to give one.',
                    'Your subscription: which plan, when it renews, and how much data you have used against it.',
                    'Support messages you send us from inside the app.',
                    'A referral code, and who referred you, if you arrived through someone else\'s invitation.',
                ),
                'fa' => array(
                    'آدرس ایمیل شما. با آن وارد می‌شوید، با آن تأیید می‌کنیم حساب متعلق به شماست، و از همان راه درباره حساب با شما تماس می‌گیریم.',
                    'رمز عبور شما، فقط به‌صورت هش رمزنگاری‌شده. ما نمی‌توانیم آن را بخوانیم و نمی‌توانیم به شما بگوییم چیست.',
                    'نام کاربری تلگرام، فقط اگر خودتان آن را وارد کنید.',
                    'اشتراک شما: اینکه چه پلنی دارید، چه زمانی تمدید می‌شود، و چقدر از حجم آن مصرف کرده‌اید.',
                    'پیام‌های پشتیبانی که از داخل برنامه برای ما می‌فرستید.',
                    'کد معرف، و اینکه چه کسی شما را دعوت کرده، اگر با دعوت شخص دیگری آمده باشید.',
                ),
            ),
        ),

        array(
            'title' => array(
                'en' => 'Payments',
                'fa' => 'پرداخت‌ها',
            ),
            'body' => array(
                'en' => array(
                    'Payments are handled by our payment providers — Stripe for cards, NowPayments for cryptocurrency. Your card number never reaches our servers; it goes directly to the provider.',
                    'What we do store is a record of the transaction: the amount, the currency, the status, a reference number from the provider, and the confirmation the provider sends back. That confirmation can include details such as a name, a country, or the last four digits of a card. We keep invoices for the same reason any business does.',
                ),
                'fa' => array(
                    'پرداخت‌ها از طریق ارائه‌دهندگان پرداخت ما انجام می‌شود — استرایپ برای کارت‌ها و NowPayments برای رمزارز. شماره کارت شما هرگز به سرورهای ما نمی‌رسد و مستقیماً به ارائه‌دهنده می‌رود.',
                    'آنچه ما ذخیره می‌کنیم سابقه تراکنش است: مبلغ، واحد پول، وضعیت، یک شماره پیگیری از ارائه‌دهنده، و تأییدیه‌ای که ارائه‌دهنده برمی‌گرداند. آن تأییدیه ممکن است شامل مواردی مانند نام، کشور یا چهار رقم آخر کارت باشد. فاکتورها را به همان دلیلی نگه می‌داریم که هر کسب‌وکاری نگه می‌دارد.',
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
                    'We want to be straight with you here, because this is the part people care about most and the part most VPN services are vague about.',
                    'Our billing system records how much data you use — a number of bytes, so we can enforce your plan\'s allowance. It does not record what you did with it.',
                    'Separately, the VPN servers themselves keep operational logs, as network software generally does. Those logs can include connection records. They exist so the service can be run and faults diagnosed, they are not used to build a profile of you, and they are not sold or handed to advertisers.',
                    'If you need a guarantee stronger than that, please ask us rather than assuming.',
                ),
                'fa' => array(
                    'اینجا می‌خواهیم صادق باشیم، چون این همان بخشی است که بیشتر از همه برای مردم اهمیت دارد و بیشتر سرویس‌های وی‌پی‌ان درباره‌اش مبهم حرف می‌زنند.',
                    'سیستم صورتحساب ما ثبت می‌کند که چه مقدار داده مصرف کرده‌اید — یک عدد بر حسب بایت، تا بتوانیم سقف پلن شما را اعمال کنیم. اینکه با آن چه کردید ثبت نمی‌شود.',
                    'جدا از آن، خود سرورهای وی‌پی‌ان مانند هر نرم‌افزار شبکه‌ای، گزارش‌های عملیاتی نگه می‌دارند. این گزارش‌ها می‌توانند شامل سوابق اتصال باشند. آن‌ها برای اداره سرویس و رفع اشکال وجود دارند، برای ساختن نمایه‌ای از شما استفاده نمی‌شوند، و به تبلیغ‌کنندگان فروخته یا داده نمی‌شوند.',
                    'اگر به تضمینی قوی‌تر از این نیاز دارید، لطفاً به‌جای فرض کردن، از ما بپرسید.',
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
                    'This website sets no cookies at all. It runs no analytics, loads nothing from any third party, and does not track you between visits. That is also why you were not asked to accept a cookie banner.',
                    'If you send the contact form or apply to be a reseller, we receive what you typed into it — your name, email address, and the message itself, plus the extra fields on the reseller form. Alongside it we store a one-way hash of your IP address, used to stop the form being abused. We do not keep the address itself.',
                ),
                'fa' => array(
                    'این وب‌سایت هیچ کوکی‌ای تنظیم نمی‌کند. هیچ ابزار تحلیلی اجرا نمی‌کند، هیچ چیزی از سرویس‌های شخص ثالث بارگذاری نمی‌کند و شما را بین بازدیدها ردیابی نمی‌کند. به همین دلیل هم از شما خواسته نشد بنر کوکی را بپذیرید.',
                    'اگر فرم تماس را بفرستید یا برای نمایندگی درخواست بدهید، آنچه در فرم نوشته‌اید به ما می‌رسد — نام، آدرس ایمیل و خود پیام، به‌علاوه فیلدهای اضافی فرم نمایندگی. در کنار آن، یک هش یک‌طرفه از نشانی IP شما را ذخیره می‌کنیم تا جلوی سوءاستفاده از فرم گرفته شود. خود نشانی را نگه نمی‌داریم.',
                ),
            ),
        ),

        array(
            'title' => array(
                'en' => 'Who else sees your data',
                'fa' => 'چه کسان دیگری به اطلاعات شما دسترسی دارند',
            ),
            'body' => array(
                'en' => array(
                    'We do not sell your data, and we do not share it for advertising.',
                    'It reaches other companies only where the service cannot work otherwise: our payment providers process your payment, and our mail provider delivers the emails we send you. We may also disclose information where a law that genuinely applies to us requires it.',
                ),
                'fa' => array(
                    'ما اطلاعات شما را نمی‌فروشیم و آن را برای تبلیغات با کسی به اشتراک نمی‌گذاریم.',
                    'اطلاعات فقط در جایی به شرکت‌های دیگر می‌رسد که سرویس بدون آن کار نمی‌کند: ارائه‌دهندگان پرداخت، پرداخت شما را پردازش می‌کنند و ارائه‌دهنده ایمیل ما، ایمیل‌هایی را که برایتان می‌فرستیم تحویل می‌دهد. همچنین ممکن است در مواردی که قانونی که واقعاً بر ما اعمال می‌شود ایجاب کند، اطلاعاتی را افشا کنیم.',
                ),
            ),
        ),

        array(
            'title' => array(
                'en' => 'How long we keep it, and how to get rid of it',
                'fa' => 'چه مدت نگه می‌داریم و چطور حذفش کنید',
            ),
            'body' => array(
                'en' => array(
                    'Account data is kept while your account exists. Invoices and payment records are kept longer, because accounting rules generally require it.',
                    'You can ask us for a copy of what we hold about you, ask us to correct it, or ask us to delete your account. Write to us from the email address on the account and we will deal with it.',
                ),
                'fa' => array(
                    'اطلاعات حساب تا زمانی که حساب شما وجود دارد نگهداری می‌شود. فاکتورها و سوابق پرداخت مدت بیشتری نگه داشته می‌شوند، چون قواعد حسابداری معمولاً چنین ایجاب می‌کند.',
                    'می‌توانید نسخه‌ای از اطلاعاتی که درباره شما داریم بخواهید، اصلاح آن را بخواهید، یا درخواست حذف حسابتان را بدهید. از همان ایمیلی که روی حساب ثبت شده برای ما بنویسید تا رسیدگی کنیم.',
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
                    'Passwords are stored only as hashes. Connection credentials are encrypted where we store them. Traffic between your device and our servers is encrypted, and the website is served over HTTPS.',
                    'No service can promise it will never be breached. If something happens that affects you, we will tell you rather than hope you do not notice.',
                ),
                'fa' => array(
                    'رمزهای عبور فقط به‌صورت هش ذخیره می‌شوند. اطلاعات اتصال در محل ذخیره‌سازی رمزنگاری می‌شوند. ترافیک میان دستگاه شما و سرورهای ما رمزنگاری شده است و وب‌سایت روی HTTPS ارائه می‌شود.',
                    'هیچ سرویسی نمی‌تواند قول بدهد هرگز دچار نفوذ نمی‌شود. اگر اتفاقی بیفتد که بر شما اثر بگذارد، به شما اطلاع می‌دهیم، نه اینکه امیدوار باشیم متوجه نشوید.',
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
                    'Neoxify is not intended for children, and we do not knowingly create accounts for them.',
                ),
                'fa' => array(
                    'نئوکسیفای برای کودکان در نظر گرفته نشده و ما آگاهانه برای آن‌ها حساب کاربری نمی‌سازیم.',
                ),
            ),
        ),

        array(
            'title' => array(
                'en' => 'Changes to this statement',
                'fa' => 'تغییرات این سند',
            ),
            'body' => array(
                'en' => array(
                    'If this changes in a way that matters, we will update the date at the top of the page, and tell account holders by email when the change is significant.',
                ),
                'fa' => array(
                    'اگر این سند به شکلی تغییر کند که اهمیت داشته باشد، تاریخ بالای صفحه را به‌روز می‌کنیم و در صورت مهم بودن تغییر، به دارندگان حساب از طریق ایمیل اطلاع می‌دهیم.',
                ),
            ),
        ),
    ),
);
