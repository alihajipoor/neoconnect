<?php
/**
 * Google ads measurement: who gets it, and what the page header allows.
 *
 * ONLY FOR PEOPLE WHO CLICKED ONE OF OUR GOOGLE ADS. Most of this site's
 * visitors are on networks where a request to Google is slow, blocked or
 * worse, and the privacy page promises at most two cookies. So the Google
 * tag is not on the site. It exists on exactly two kinds of request:
 *
 *   'click'   the address carries a Google click id (gclid, gbraid or
 *             wbraid) -- the landing page of an ad click;
 *   'marker'  the request carries the nx_ad session cookie, which
 *             assets/js/ads.js sets once measurement is allowed for this
 *             visit, so the next pages of the same visit keep it.
 *
 * A cookie and not sessionStorage because the policy header is built HERE,
 * on the server, and only a cookie reaches the server. It holds "1", has no
 * expiry (gone when the browser closes) and is described on the privacy page.
 *
 * Everything else gets '' and the page is byte-for-byte what it was before
 * this file existed: same HTML, same strict header. scripts/check-ads.php
 * proves that.
 *
 * Whether the tag actually loads is decided in the browser (ads.js), because
 * only the browser knows its time zone: in Europe the visitor is asked first
 * and nothing from Google loads before "Allow". The header being opened on a
 * click request is what makes "Allow" able to work without a reload; it lets
 * nothing load by itself.
 */

defined('NX') || exit;

/**
 * Hosts the Google tag needs for Google Ads conversion measurement, by
 * directive. From Google's own list, "Google Ads conversions" plus the tag
 * itself (developers.google.com/tag-platform/security/guides/csp, read
 * 2026-11-15). Nothing for remarketing beyond what that list shares with
 * conversions: this site does none.
 *
 * www.google.<TLD>: the policy cannot wildcard a top-level domain, so each
 * one Google may use for the countries the ads run in (United States and
 * Europe) is listed. A missing one costs a lost beacon, never a broken page.
 */
function nx_ads_csp_sources()
{
    $tlds = array(
        'com', 'co.uk', 'de', 'fr', 'it', 'es', 'nl', 'be', 'at', 'ch', 'ie', 'pt',
        'pl', 'se', 'dk', 'fi', 'no', 'is', 'lu', 'li', 'cz', 'sk', 'hu', 'ro', 'bg',
        'gr', 'hr', 'si', 'lt', 'lv', 'ee', 'com.cy', 'com.mt',
    );
    $google = array();
    foreach ($tlds as $t) {
        $google[] = 'https://www.google.' . $t;
    }
    $google = array_unique($google);

    $base = array('https://www.googletagmanager.com', 'https://www.googleadservices.com',
        'https://googleads.g.doubleclick.net', 'https://pagead2.googlesyndication.com');

    return array(
        // Ignored by every browser that understands 'strict-dynamic' (the
        // tag is trusted because a hashed script inserted it); here for the
        // older ones that fall back to host lists.
        'script-src' => array('https://www.googletagmanager.com', 'https://www.googleadservices.com',
            'https://www.google.com'),
        'img-src' => array_merge($base, $google),
        'connect-src' => array_merge($base, $google, array('https://ad.doubleclick.net')),
        'frame-src' => array('https://www.googletagmanager.com'),
    );
}

/** @return string the configured tag id, or '' when unset or malformed */
function nx_ads_tag_id()
{
    $id = trim((string) nx_cfg('google_tag_id', ''));
    return preg_match('/^GTM-[A-Z0-9]{4,12}$/', $id) ? $id : '';
}

/** @return string the Ads conversion target, or '' when unset or malformed */
function nx_ads_send_to()
{
    $t = trim((string) nx_cfg('google_ads_send_to', ''));
    return preg_match('#^AW-\d{5,15}/[A-Za-z0-9_-]{4,64}$#', $t) ? $t : '';
}

/**
 * Whether this request's address carries a Google click id. A real one is a
 * short run of printable characters; anything else is not an ad click.
 *
 * @return bool
 */
function nx_ads_has_click_id()
{
    foreach (array('gclid', 'gbraid', 'wbraid') as $k) {
        if (isset($_GET[$k]) && is_string($_GET[$k]) && preg_match('/^[\x21-\x7e]{1,512}$/', $_GET[$k])) {
            return true;
        }
    }
    return false;
}

/**
 * What this request is, for the Google tag. Once per request.
 *
 *   'click'  an ad click's landing page      -> header opened, ads.js runs
 *   'marker' a later page of an allowed visit -> header opened, ads.js runs
 *   'off'    the privacy page's "turn it off" link -> ads.js runs to forget
 *            everything, header stays strict
 *   ''       everyone else                   -> nothing at all changes
 *
 * @return string
 */
function nx_ads_mode()
{
    static $mode = null;
    if ($mode !== null) {
        return $mode;
    }
    $mode = '';
    if (nx_ads_tag_id() === '') {
        return $mode;
    }
    if (isset($_GET['ads']) && $_GET['ads'] === 'off') {
        $mode = 'off';
    } elseif (nx_ads_has_click_id()) {
        $mode = 'click';
    } elseif (isset($_COOKIE['nx_ad']) && $_COOKIE['nx_ad'] === '1') {
        $mode = 'marker';
    }
    return $mode;
}

/** @return bool whether the page header must allow the Google sources */
function nx_ads_open_csp()
{
    $m = nx_ads_mode();
    return $m === 'click' || $m === 'marker';
}

/**
 * The extra statement the loader adds on an ads request: load ads.js, with
 * its settings in a data attribute. '' for everyone else, so their loader
 * (and its hash) is unchanged.
 *
 * @return string JavaScript, appended inside the loader's function right
 *                after its last statement (hence the leading semicolon)
 */
function nx_ads_loader_js()
{
    $mode = nx_ads_mode();
    if ($mode === '') {
        return '';
    }
    $links = array();
    foreach (array('windows' => nx_installer_button_url('windows'),
        'android' => nx_installer_button_url('android'),
        'play' => nx_android_play_url(),
        'ios' => nx_ios_store_url()) as $k => $u) {
        if ($u !== '') {
            $links[$k] = $u;
        }
    }
    $cfg = array(
        'mode' => $mode,
        'tag' => nx_ads_tag_id(),
        'sendTo' => nx_ads_send_to(),
        'path' => nx_cfg('base_path', '/'),
        'links' => $links,
        'text' => nx_t('ads.bar.text'),
        'allow' => nx_t('ads.bar.allow'),
        'deny' => nx_t('ads.bar.deny'),
        'more' => nx_t('ads.bar.more'),
        'label' => nx_t('ads.bar.label'),
        'privacy' => nx_url('privacy') . '#ads',
    );
    $flags = JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT;
    return ';var a=d.createElement("script");a.src=' . json_encode(nx_asset('js/ads.js'), $flags)
        . ';a.async=true;a.setAttribute("data-nx-ads",' . json_encode(json_encode($cfg, $flags), $flags)
        . ');d.head.appendChild(a);';
}

/**
 * The "turn it off" request also clears the marker on the server side, so
 * the very next page is strict again even before ads.js has run.
 */
function nx_ads_send_cookies()
{
    if (nx_ads_mode() === 'off' && isset($_COOKIE['nx_ad']) && !headers_sent()) {
        setcookie('nx_ad', '', time() - 3600, nx_cfg('base_path', '/'));
    }
}
