<?php
/**
 * Frequently asked questions, inline per locale so a question can be added,
 * reworded or removed in one place.
 *
 * Answers describe what the service actually does today. Where something is
 * genuinely uncertain -- whether a given network will stay reachable, for
 * instance -- the answer says so rather than promising an outcome nobody can
 * guarantee. Please keep it that way.
 *
 * Optional key:
 *   requires  Hides the entry unless the matching switch is on in config.php.
 *             'free_trial' and 'referrals' are both admin-gated features
 *             whose panel settings default to OFF, so the site stays quiet
 *             about them until you have actually turned them on. Advertising
 *             a reward scheme that isn't running is a support ticket, not a
 *             feature.
 */

defined('NX') || exit;

return array(

    array(
        'q' => array(
            'en' => 'Which devices can I use it on?',
            'fa' => 'روی چه دستگاه‌هایی می‌توانم از آن استفاده کنم؟',
        ),
        'a' => array(
            'en' => 'Windows and Android today. macOS and iOS are in development. Your plan decides how many devices can be connected at the same time.',
            'fa' => 'در حال حاضر ویندوز و اندروید. نسخه‌های مک و iOS در حال توسعه هستند. تعداد دستگاه‌هایی که می‌توانند هم‌زمان متصل باشند به پلن شما بستگی دارد.',
        ),
    ),

    array(
        'q' => array(
            'en' => 'How do I pay?',
            'fa' => 'چطور پرداخت کنم؟',
        ),
        'a' => array(
            'en' => 'By international card or with cryptocurrency, both from inside the app. There is no Iranian payment gateway — if you are in Iran, crypto is the route that works.',
            'fa' => 'با کارت بین‌المللی یا رمزارز، هر دو از داخل خود برنامه. درگاه پرداخت ایرانی نداریم — اگر در ایران هستید، پرداخت با رمزارز راه کارآمد است.',
        ),
    ),

    array(
        'q' => array(
            'en' => 'Will it work on a network that blocks VPNs?',
            'fa' => 'روی شبکه‌ای که وی‌پی‌ان را مسدود می‌کند کار می‌کند؟',
        ),
        'a' => array(
            'en' => 'That is precisely what this is built for. Your connection is designed to blend in with ordinary web traffic instead of advertising itself, and you can come in through a server your network can still reach. We will be straight with you though — no VPN can promise that any single route stays open forever. That is exactly why you get several ways to connect and multiple locations to switch between.',
            'fa' => 'دقیقاً برای همین ساخته شده است. اتصال شما طوری طراحی شده که به‌جای معرفی کردن خودش، میان ترافیک معمولی وب گم شود، و می‌توانید از سروری وارد شوید که شبکه‌تان هنوز به آن دسترسی دارد. اما صادق باشیم — هیچ وی‌پی‌انی نمی‌تواند قول بدهد که یک مسیر مشخص برای همیشه باز می‌ماند. دقیقاً به همین دلیل چند راه اتصال و چند موقعیت مختلف در اختیار شماست تا بینشان جابه‌جا شوید.',
        ),
    ),

    array(
        'q' => array(
            'en' => 'Can I change server location later?',
            'fa' => 'می‌توانم بعداً موقعیت سرور را عوض کنم؟',
        ),
        'a' => array(
            'en' => 'Yes, from inside the app, as often as you like. Server addresses come from our backend rather than being baked into the app, so we can rotate them without you having to reinstall or import anything new.',
            'fa' => 'بله، از داخل برنامه و هر چند بار که بخواهید. آدرس سرورها به‌جای آنکه داخل برنامه ثابت باشد از بک‌اند ما می‌آید، پس می‌توانیم آن‌ها را تغییر دهیم بدون اینکه شما نیاز به نصب دوباره یا وارد کردن چیزی داشته باشید.',
        ),
    ),

    array(
        'q' => array(
            'en' => 'What happens when I use up my data?',
            'fa' => 'وقتی حجم پلنم تمام شود چه می‌شود؟',
        ),
        'a' => array(
            'en' => 'Your connection is paused until you renew or move to a larger plan. Usage is shown in the app as you go, so it should never be a surprise, and we warn you before you get there.',
            'fa' => 'اتصال شما تا زمان تمدید یا ارتقا به پلن بزرگ‌تر متوقف می‌شود. میزان مصرف در برنامه نمایش داده می‌شود تا هیچ‌وقت غافلگیر نشوید، و پیش از رسیدن به سقف هم به شما هشدار می‌دهیم.',
        ),
    ),

    array(
        'q' => array(
            'en' => 'Do I have to import config files or subscription links?',
            'fa' => 'باید فایل کانفیگ یا لینک اشتراک وارد کنم؟',
        ),
        'a' => array(
            'en' => 'No. You sign in and the app fetches everything it needs. There is nothing to copy, paste, scan or keep up to date by hand.',
            'fa' => 'نه. وارد حساب می‌شوید و برنامه هر چیزی را که لازم دارد خودش دریافت می‌کند. چیزی برای کپی، جای‌گذاری، اسکن یا به‌روز نگه داشتن دستی وجود ندارد.',
        ),
    ),

    array(
        'q' => array(
            'en' => 'Do I get an invoice?',
            'fa' => 'فاکتور دریافت می‌کنم؟',
        ),
        'a' => array(
            'en' => 'Yes. Every payment produces an invoice you can open and print from inside the app, whether you paid by card or with crypto.',
            'fa' => 'بله. برای هر پرداخت یک فاکتور صادر می‌شود که می‌توانید از داخل برنامه باز و چاپ کنید، چه با کارت پرداخت کرده باشید چه با رمزارز.',
        ),
    ),

    array(
        'q' => array(
            'en' => 'I have a voucher code — where do I use it?',
            'fa' => 'کد ووچر دارم — کجا واردش کنم؟',
        ),
        'a' => array(
            'en' => 'Inside the app. Sign in, redeem the code, and a valid one activates your plan straight away — there is no payment step to go through.',
            'fa' => 'داخل خود برنامه. وارد حساب شوید و کد را وارد کنید؛ کد معتبر بلافاصله پلن شما را فعال می‌کند و نیازی به مرحله پرداخت نیست.',
        ),
    ),

    array(
        'requires' => 'referrals',
        'q' => array(
            'en' => 'Is there a referral programme?',
            'fa' => 'برنامه دعوت از دوستان دارید؟',
        ),
        'a' => array(
            'en' => 'Yes. Invite friends from inside the app and you earn free time once they subscribe. The app shows who has joined through your link and how close you are to the next reward.',
            'fa' => 'بله. از داخل برنامه دوستانتان را دعوت کنید و وقتی مشترک شوند زمان رایگان دریافت می‌کنید. برنامه نشان می‌دهد چه کسانی با لینک شما عضو شده‌اند و تا پاداش بعدی چقدر مانده است.',
        ),
    ),

    array(
        'requires' => 'free_trial',
        'q' => array(
            'en' => 'Is there a free trial?',
            'fa' => 'دوره استفاده رایگان دارید؟',
        ),
        'a' => array(
            'en' => 'Yes. New accounts start with a free trial and no payment method is needed to begin — create an account in the app, verify your email, and you are connected.',
            'fa' => 'بله. حساب‌های جدید با یک دوره رایگان شروع می‌شوند و برای شروع نیازی به روش پرداخت نیست — در برنامه حساب بسازید، ایمیلتان را تأیید کنید و متصل شوید.',
        ),
    ),
);
