<?php
/**
 * Connection methods, as a customer sees them.
 *
 * ============================================================================
 *  A DELIBERATE REVERSAL, WORTH READING BEFORE EDITING.
 *
 *  This site used to name no protocol at all. inc/lang/en.php still carries
 *  the note explaining why the pricing key was renamed from `all_protocols`
 *  to `all_modes`: "the site deliberately does not name the protocols it
 *  runs on."
 *
 *  That is now reversed, on purpose, for two reasons:
 *
 *  1. It was costing the buyer. "Every connection option included" tells
 *     someone comparing VPNs nothing. Protocol names are the single most
 *     common thing a technical buyer filters on, and the audience here is
 *     unusually technical -- people who have already tried three other
 *     tools and know exactly what WireGuard and Shadowsocks are.
 *
 *  2. It was costing every protocol-name search query, which are the
 *     highest-intent terms this site could rank for and are far less
 *     contested than "vpn".
 *
 *  What has NOT changed: the site still does not publish server addresses,
 *  ports, REALITY destinations, key material, or anything else that is
 *  operationally sensitive. Naming a protocol is not disclosing a route.
 *  A censor already knows what WireGuard looks like on the wire -- that is
 *  the entire reason REALITY exists.
 *
 *  IF THE OWNER DISAGREES with naming protocols publicly, this is the one
 *  file to empty: every surface reads from it, and the pages degrade to the
 *  old generic wording rather than breaking.
 * ============================================================================
 *
 * The names and one-line hints below are lifted verbatim from
 * apps/desktop-windows/src/lib/protocol-labels.ts (CUSTOMER_PROTOCOL_LABELS
 * and CUSTOMER_PROTOCOL_HINTS). That is deliberate and worth keeping: a
 * visitor who reads "Stealth -- hardest to block" here and then installs the
 * app sees the same words in the protocol picker. If the app's labels ever
 * change, change them here in the same sitting.
 *
 * XRAY_VMESS is intentionally ABSENT. It exists in the backend enum and the
 * app labels it "Stealth (legacy)", but the installer does not build it and
 * no node runs it, so advertising it would be advertising something nobody
 * can connect to.
 *
 * Fields:
 *   id        internal key, used as a CSS hook and for the JSON-LD id
 *   label     the customer-facing name, per locale
 *   tech      the underlying technology, shown as a smaller subtitle.
 *             Named plainly because that is the SEO- and buyer-relevant
 *             half. Not translated -- these are proper nouns.
 *   hint      one line of "when would I pick this", per locale
 *   windows   supported by the Windows client
 *   android   supported by the Android client
 */

defined('NX') || exit;

return array(

    array(
        'id' => 'stealth',
        'label' => array('en' => 'Stealth', 'fa' => 'مخفی'),
        'tech' => 'VLESS + REALITY',
        'hint' => array(
            'en' => 'Hardest to block. Best on restricted networks.',
            'fa' => 'سخت‌ترین گزینه برای مسدود کردن. بهترین انتخاب روی شبکه‌های محدودشده.',
        ),
        'windows' => true,
        'android' => true,
    ),

    array(
        'id' => 'stealth-https',
        'label' => array('en' => 'Stealth HTTPS', 'fa' => 'مخفی HTTPS'),
        'tech' => 'VLESS + TLS',
        'hint' => array(
            'en' => 'Looks exactly like a normal HTTPS website.',
            'fa' => 'دقیقاً شبیه یک وب‌سایت معمولی HTTPS به نظر می‌رسد.',
        ),
        'windows' => true,
        'android' => true,
    ),

    array(
        'id' => 'stealth-web',
        'label' => array('en' => 'Stealth Web', 'fa' => 'مخفی وب'),
        'tech' => 'VLESS + TLS over WebSocket',
        'hint' => array(
            'en' => 'Looks like ordinary web traffic. Best when everything else is blocked.',
            'fa' => 'شبیه ترافیک عادی وب است. بهترین گزینه وقتی بقیه راه‌ها بسته شده‌اند.',
        ),
        'windows' => true,
        'android' => true,
    ),

    array(
        'id' => 'stealth-lite',
        'label' => array('en' => 'Stealth Lite', 'fa' => 'مخفی سبک'),
        'tech' => 'Trojan + TLS',
        'hint' => array(
            'en' => 'Also looks like a website. An older method than Stealth HTTPS.',
            'fa' => 'این هم شبیه یک وب‌سایت است. روشی قدیمی‌تر از مخفی HTTPS.',
        ),
        'windows' => true,
        'android' => true,
    ),

    array(
        'id' => 'shadowsocks',
        'label' => array('en' => 'Shadowsocks', 'fa' => 'شدوساکس'),
        'tech' => 'Shadowsocks 2022',
        'hint' => array(
            'en' => 'No handshake to detect. Good when stealth ports are blocked.',
            'fa' => 'دست‌دادن اولیه‌ای ندارد که قابل شناسایی باشد. وقتی پورت‌های مخفی بسته‌اند خوب کار می‌کند.',
        ),
        'windows' => true,
        'android' => true,
    ),

    array(
        'id' => 'fast',
        'label' => array('en' => 'Fast', 'fa' => 'سریع'),
        'tech' => 'WireGuard',
        'hint' => array(
            'en' => 'Fastest. Best when nothing is blocking you.',
            'fa' => 'سریع‌ترین گزینه. وقتی چیزی جلوی شما را نگرفته بهترین انتخاب است.',
        ),
        'windows' => true,
        'android' => true,
    ),

    array(
        'id' => 'compatible',
        'label' => array('en' => 'Compatible', 'fa' => 'سازگار'),
        'tech' => 'OpenVPN',
        'hint' => array(
            'en' => 'Slower, but works almost everywhere.',
            'fa' => 'کندتر است، اما تقریباً همه‌جا کار می‌کند.',
        ),
        'windows' => true,
        /* Not in the Android client's SUPPORTED set. Stating that plainly
           is the whole point of having a per-platform column: a customer on
           a phone should not read this row and expect it to be there. */
        'android' => false,
    ),

    array(
        'id' => 'built-in',
        'label' => array('en' => 'Built-in', 'fa' => 'داخلی'),
        'tech' => 'IKEv2 / IPsec',
        'hint' => array(
            'en' => "Uses your device's own VPN. Fast, but easy to block.",
            'fa' => 'از وی‌پی‌ان خود دستگاه شما استفاده می‌کند. سریع است، اما به‌راحتی مسدود می‌شود.',
        ),
        'windows' => true,
        'android' => true,
    ),
);
