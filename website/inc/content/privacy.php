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

    'updated' => '2026-11-15',

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
                    'Support messages you send us from the app.',
                    'A referral code, and who invited you, if you joined through someone else\'s invitation.',
                ),
                'fa' => array(
                    'ایمیل شما. با آن وارد می‌شوید، با آن تأیید می‌کنیم حساب مال شماست و از همین راه با شما در تماس هستیم.',
                    'رمز عبور شما، فقط به شکل هش رمزنگاری‌شده. ما نمی‌توانیم آن را بخوانیم و نمی‌توانیم به شما بگوییم چیست.',
                    'نام کاربری تلگرام، فقط اگر خودتان وارد کنید.',
                    'پلن شما: کدام پلن، کی تمدید می‌شود و چقدر از حجمش را مصرف کرده‌اید.',
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
                    'Our billing system records how much data you use, as a number of bytes, to apply your plan\'s limit. It doesn\'t record what you used it for.',
                    'The app also sends us a short report when you sign up, sign in or connect, whether it works or not. It says which servers and connection types the app tried and what happened. It also includes the app version, the kind of device, your internet provider and your IP address. If you\'re signed in, the report is linked to your account. We delete the IP address after 14 days and the rest of the report after 60 days.',
                    'The VPN servers also keep operational logs, as most network software does, and these can include connection records. We use them to run the service and find faults. We don\'t use them to build a profile of you, and we don\'t sell them or give them to advertisers.',
                    'If you need a stronger guarantee than this, ask us before you assume one.',
                ),
                'fa' => array(
                    'این بخشی است که بیشتر از همه درباره‌اش سؤال می‌شود.',
                    'سیستم صورتحساب ما حجم مصرفی شما را به بایت ثبت می‌کند تا سقف پلنتان را اعمال کند. ثبت نمی‌کند آن حجم را صرف چه کاری کرده‌اید.',
                    'برنامه هم وقتی ثبت‌نام می‌کنید، وارد حسابتان می‌شوید یا وصل می‌شوید، چه موفق شود چه نه، یک گزارش کوتاه برایمان می‌فرستد. در این گزارش آمده که برنامه کدام سرورها و روش‌های اتصال را امتحان کرده و نتیجه چه شده است. نسخه برنامه، نوع دستگاه، اپراتور اینترنتتان و آدرس IP شما هم در آن هست. اگر وارد حسابتان شده باشید، گزارش با حساب کاربری شما ثبت می‌شود. آدرس IP را بعد از ۱۴ روز پاک می‌کنیم و بقیه گزارش را بعد از ۶۰ روز.',
                    'خود سرورهای وی‌پی‌ان هم مثل بیشتر نرم‌افزارهای شبکه لاگ‌های عملیاتی نگه می‌دارند که ممکن است سوابق اتصال را هم شامل شود. از این لاگ‌ها برای اداره سرویس و پیدا کردن خطاها استفاده می‌کنیم. با آن‌ها درباره شما پرونده نمی‌سازیم و آن‌ها را به تبلیغ‌کننده‌ها نمی‌فروشیم یا نمی‌دهیم.',
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
                    'This website sets at most two cookies, and only when you use the switch each one belongs to. One remembers whether you chose English or Persian, the other whether you chose the light or dark theme. Each holds that one word and nothing else, and neither identifies anyone. That\'s why there\'s no cookie banner: remembering a choice you made yourself doesn\'t need consent. There\'s no analytics, nothing loads from any other company, and nothing tracks you between visits. The one exception is a visit that starts from one of our Google ads, described in the next section.',
                    'Before you choose a language, we pick one from the language your browser asks for, and from a country code if the network in front of our server adds one to the request. Neither is stored, and you can always switch.',
                    'If you send the contact form or apply to be a reseller, we receive what you typed: your name, email address and message, plus the extra fields on the reseller form. We also store a one-way hash of your IP address to stop the form being abused. We don\'t keep the address itself.',
                ),
                'fa' => array(
                    'این سایت حداکثر دو کوکی می‌گذارد، آن هم فقط وقتی از کلید مربوط به هرکدام استفاده کنید. یکی به خاطر می‌سپارد انگلیسی را انتخاب کرده‌اید یا فارسی، و دیگری حالت روشن یا تیره را. در هرکدام فقط همان یک کلمه هست و هیچ‌کدام کسی را شناسایی نمی‌کند. برای همین بنر کوکی نداریم؛ به خاطر سپردن انتخابی که خودتان کرده‌اید رضایت جداگانه لازم ندارد. ابزار آمار و تحلیل نداریم، چیزی از سرور شرکت‌های دیگر بارگذاری نمی‌شود و بین بازدیدها ردیابی‌تان نمی‌کنیم. تنها استثنا بازدیدی است که از یکی از تبلیغ‌های ما در گوگل شروع شود و در بخش بعد توضیحش آمده است.',
                    'تا وقتی زبان را انتخاب نکرده‌اید، زبان صفحه را از روی زبانی که مرورگرتان درخواست می‌کند تعیین می‌کنیم، و از روی کد کشور اگر شبکه‌ای که جلوی سرور ماست آن را به درخواست اضافه کند. هیچ‌کدام ذخیره نمی‌شود و همیشه می‌توانید زبان را عوض کنید.',
                    'اگر فرم تماس یا درخواست نمایندگی را بفرستید، آنچه نوشته‌اید به دست ما می‌رسد: نام، ایمیل و پیامتان، به‌علاوه فیلدهای اضافه فرم نمایندگی. یک هش یک‌طرفه از آدرس IP شما را هم نگه می‌داریم تا جلوی سوءاستفاده از فرم گرفته شود. خود آدرس IP را نگه نمی‌داریم.',
                ),
            ),
        ),

        // Must match what inc/ads.php and assets/js/ads.js actually do.
        // Change either and this section changes with it.
        array(
            'id' => 'ads',
            'title' => array(
                'en' => 'Visits from our Google ads',
                'fa' => 'بازدید از راه تبلیغ‌های ما در گوگل',
            ),
            'body' => array(
                'en' => array(
                    'If you come to this website by tapping one of our ads on Google, and only then, the page loads Google\'s tag. It shows us which ads lead to a download, so we spend on the ones that work.',
                    'Google\'s tag stores up to three cookies on this site, each kept for 90 days: _gcl_au, and _gcl_aw or _gcl_gb, which hold the reference of the ad you tapped. We add one of our own, nx_ad. It holds the number 1, is deleted when you close the browser, and keeps the measurement on for the rest of that visit. When you tap a download button, Google is told which one. As on any site that uses its tag, Google also gets your IP address and browser details. We tell Google not to use any of this to personalise ads.',
                    'None of this involves the VPN. This website can\'t see what you do through Neoxify, and it tells Google nothing about it.',
                    'If your device\'s time zone is in Europe, or we can\'t tell, we ask first, and nothing from Google loads unless you choose Allow. If you choose No thanks, we remember it until you close the tab, without a cookie. Everywhere else the tag loads without asking. You can say no at any time with the link below. It turns the measurement off in this browser, deletes those cookies, and leaves a note in your browser\'s own storage so it stays off.',
                    'Everyone else, including anyone who comes here any other way, gets the same two cookies as above and nothing from Google.',
                ),
                'fa' => array(
                    'اگر با زدن یکی از تبلیغ‌های ما در گوگل به این سایت بیایید، و فقط در همین حالت، صفحه تگ گوگل را بارگذاری می‌کند. این تگ به ما نشان می‌دهد کدام تبلیغ‌ها به دانلود می‌رسند تا هزینه تبلیغ را صرف همان‌هایی کنیم که جواب می‌دهند.',
                    'تگ گوگل حداکثر سه کوکی در این سایت می‌گذارد و هرکدام ۹۰ روز می‌ماند: _gcl_au، و _gcl_aw یا _gcl_gb که شناسه تبلیغی را که زده‌اید نگه می‌دارد. ما هم یک کوکی خودمان می‌گذاریم به اسم nx_ad. فقط عدد ۱ در آن است، با بستن مرورگر پاک می‌شود و باعث می‌شود سنجش تا آخر همان بازدید ادامه داشته باشد. وقتی دکمه دانلودی را می‌زنید، به گوگل گفته می‌شود کدام دکمه بوده. مثل هر سایت دیگری که تگ گوگل دارد، آدرس IP و مشخصات مرورگرتان هم به گوگل می‌رسد. از گوگل خواسته‌ایم از هیچ‌کدام از این‌ها برای شخصی‌سازی تبلیغ استفاده نکند.',
                    'هیچ‌کدام از این‌ها به وی‌پی‌ان ربطی ندارد. این سایت نمی‌بیند با نئوکسیفای چه کار می‌کنید و چیزی هم درباره‌اش به گوگل نمی‌گوید.',
                    'اگر منطقه زمانی دستگاهتان در اروپا باشد، یا نتوانیم تشخیصش بدهیم، اول از شما می‌پرسیم و تا «اجازه می‌دهم» را نزنید هیچ چیزی از گوگل بارگذاری نمی‌شود. اگر «نه، ممنون» را بزنید، تا وقتی همین زبانه باز است یادمان می‌ماند، بدون کوکی. جاهای دیگر تگ بدون پرسیدن بارگذاری می‌شود. هر وقت خواستید می‌توانید با لینک زیر آن را رد کنید. این لینک سنجش را در همین مرورگر خاموش می‌کند، آن کوکی‌ها را پاک می‌کند و یادداشتی در حافظه خود مرورگر می‌گذارد تا خاموش بماند.',
                    'بقیه بازدیدکننده‌ها، یعنی هر کسی که از راه دیگری به این سایت می‌آید، همان دو کوکی بالا را دارند و هیچ چیزی از گوگل برایشان بارگذاری نمی‌شود.',
                ),
            ),
            // Rendered by inc/pages/privacy.php as the "turn it off" link.
            'ads_off_link' => true,
        ),

        array(
            'title' => array(
                'en' => 'Who else sees your data',
                'fa' => 'چه کسان دیگری اطلاعات شما را می‌بینند',
            ),
            'body' => array(
                'en' => array(
                    'We don\'t sell your data, and we don\'t share your account data for advertising.',
                    'It goes to other companies only where the service can\'t work without it: our payment providers process your payments, and our email provider delivers the emails we send you. The one other case is Google, for a visit that starts from one of our Google ads, as described above; your account data is never part of that. We may also disclose information when a law that actually applies to us requires it.',
                ),
                'fa' => array(
                    'اطلاعات شما را نمی‌فروشیم و اطلاعات حسابتان را برای تبلیغات در اختیار کسی نمی‌گذاریم.',
                    'اطلاعات فقط وقتی به شرکت‌های دیگر می‌رسد که سرویس بدون آن کار نکند: شرکت‌های پرداخت، پرداخت شما را انجام می‌دهند و سرویس ایمیل ما، ایمیل‌هایمان را به دستتان می‌رساند. تنها مورد دیگر گوگل است، برای بازدیدی که از یکی از تبلیغ‌های ما در گوگل شروع شود، همان‌طور که بالاتر گفتیم؛ اطلاعات حساب شما هیچ‌وقت جزو آن نیست. اگر قانونی که واقعاً شامل حال ما می‌شود لازم بداند، ممکن است اطلاعاتی را در اختیار بگذاریم.',
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
                    'We delete the IP address in the app\'s reports after 14 days, and the reports themselves after 60.',
                    'You can ask us for a copy of what we hold about you, ask us to correct it, or ask us to delete your account. Write to us from your account\'s email address and we\'ll take care of it.',
                ),
                'fa' => array(
                    'اطلاعات حساب را تا وقتی حسابتان وجود دارد نگه می‌داریم. فاکتورها و سوابق پرداخت را بیشتر نگه می‌داریم، چون قوانین حسابداری معمولاً این را لازم می‌دانند.',
                    'آدرس IP را در گزارش‌های برنامه بعد از ۱۴ روز پاک می‌کنیم و خود گزارش‌ها را بعد از ۶۰ روز.',
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
