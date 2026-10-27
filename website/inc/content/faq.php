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
            'fa' => 'روی چه دستگاه‌هایی کار می‌کند؟',
        ),
        'a' => array(
            'en' => 'Windows and Android. There\'s no macOS or iOS app yet, and we haven\'t set a date for either. Your plan sets how many devices can be connected at once.',
            'fa' => 'ویندوز و اندروید. هنوز نسخه مک و iOS نداریم و تاریخی هم برایشان اعلام نکرده‌ایم. تعداد دستگاه‌هایی که هم‌زمان وصل می‌شوند به پلنتان بستگی دارد.',
        ),
    ),

    array(
        'q' => array(
            'en' => 'How do I pay?',
            'fa' => 'چطور پرداخت کنم؟',
        ),
        'a' => array(
            'en' => 'By international card or crypto, in the app. Local bank cards aren\'t accepted, so if your card doesn\'t work abroad, pay with crypto.',
            'fa' => 'با کارت بین‌المللی یا رمزارز، داخل برنامه. کارت بانکی داخلی پذیرفته نمی‌شود؛ اگر کارتتان در خارج کار نمی‌کند، با رمزارز پرداخت کنید.',
        ),
    ),

    array(
        'q' => array(
            'en' => 'Will it work on a network that blocks VPNs?',
            'fa' => 'روی شبکه‌ای که وی‌پی‌ان را می‌بندد کار می‌کند؟',
        ),
        'a' => array(
            'en' => 'That\'s what it\'s built for. Some of its ways to connect look like ordinary web traffic, and the app looks for one your network still lets through. No VPN can promise that any one way will stay open, which is why you get several ways to connect and several countries to choose from.',
            'fa' => 'برای همین ساخته شده است. بعضی از روش‌های اتصالش شبیه ترافیک معمولی وب هستند و برنامه دنبال روشی می‌گردد که شبکه شما هنوز اجازه عبورش را می‌دهد. هیچ وی‌پی‌انی نمی‌تواند قول بدهد یک روش همیشه باز بماند؛ برای همین چند روش اتصال و چند کشور در اختیار دارید.',
        ),
    ),

    array(
        'q' => array(
            'en' => 'Can I change the server country later?',
            'fa' => 'بعداً می‌توانم کشور سرور را عوض کنم؟',
        ),
        'a' => array(
            'en' => 'Yes, in the app, as often as you like. Server addresses aren\'t built into the app, so we can change them without you reinstalling or importing anything.',
            'fa' => 'بله، از داخل برنامه و هر چند بار که بخواهید. آدرس سرورها داخل برنامه ثابت نیست، پس می‌توانیم عوضشان کنیم بی‌آنکه لازم باشد چیزی را دوباره نصب یا وارد کنید.',
        ),
    ),

    array(
        'q' => array(
            'en' => 'What happens when I use up my data?',
            'fa' => 'اگر حجمم تمام شود چه می‌شود؟',
        ),
        'a' => array(
            'en' => 'Your connection pauses until you renew or move to a bigger plan. The app shows your usage, and we warn you before you reach the limit.',
            'fa' => 'اتصالتان تا وقتی تمدید کنید یا پلن بزرگ‌تری بخرید متوقف می‌شود. برنامه مصرفتان را نشان می‌دهد و قبل از رسیدن به سقف هم خبرتان می‌کنیم.',
        ),
    ),

    array(
        'q' => array(
            'en' => 'Do I have to import config files or subscription links?',
            'fa' => 'باید کانفیگ یا لینک اشتراک وارد کنم؟',
        ),
        'a' => array(
            'en' => 'No. You sign in and the app gets everything it needs. There\'s nothing to copy, scan or update by hand.',
            'fa' => 'نه. وارد حساب می‌شوید و برنامه هر چه لازم دارد را خودش می‌گیرد. چیزی برای کپی، اسکن یا به‌روزرسانی دستی نیست.',
        ),
    ),

    array(
        'q' => array(
            'en' => 'Do I get an invoice?',
            'fa' => 'فاکتور می‌گیرم؟',
        ),
        'a' => array(
            'en' => 'Yes. For every payment, by card or crypto, you get an invoice you can open and print in the app.',
            'fa' => 'بله. برای هر پرداخت، با کارت یا رمزارز، فاکتوری می‌گیرید که می‌توانید داخل برنامه باز و چاپ کنید.',
        ),
    ),

    array(
        'q' => array(
            'en' => 'Where do I enter a voucher code?',
            'fa' => 'کد هدیه را کجا وارد کنم؟',
        ),
        'a' => array(
            'en' => 'In the app. Sign in and enter the code. A valid code activates your plan right away, with no payment step.',
            'fa' => 'داخل برنامه. وارد حسابتان شوید و کد را وارد کنید. کد معتبر بدون مرحله پرداخت، همان لحظه پلنتان را فعال می‌کند.',
        ),
    ),

    array(
        'requires' => 'referrals',
        'q' => array(
            'en' => 'Is there a referral programme?',
            'fa' => 'برنامه دعوت از دوستان دارید؟',
        ),
        'a' => array(
            'en' => 'Yes. Invite friends from the app, and you get free time when they subscribe. The app shows who joined with your link and how close you are to the next reward.',
            'fa' => 'بله. از داخل برنامه دوستانتان را دعوت کنید؛ وقتی پلن بخرند، زمان رایگان می‌گیرید. برنامه نشان می‌دهد چه کسانی با لینک شما عضو شده‌اند و تا جایزه بعدی چقدر مانده است.',
        ),
    ),

    array(
        'requires' => 'free_trial',
        'q' => array(
            'en' => 'Is there a free trial?',
            'fa' => 'دوره رایگان دارید؟',
        ),
        'a' => array(
            'en' => 'Yes. New accounts start with a free trial, and you don\'t need a payment method. Create an account in the app, confirm your email and connect.',
            'fa' => 'بله. حساب‌های جدید با دوره رایگان شروع می‌شوند و روش پرداخت لازم نیست. در برنامه حساب بسازید، ایمیلتان را تأیید کنید و وصل شوید.',
        ),
    ),
);
