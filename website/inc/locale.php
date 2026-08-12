<?php
/**
 * Automatic language selection.
 *
 * Goal: someone in Iran lands on Persian without doing anything, everyone
 * else lands on English, and either can switch and have that stick.
 *
 * The order of evidence, best first:
 *
 *   1. An explicit choice. If the visitor has used the language switch, that
 *      wins over everything. Guessing over someone's stated preference is the
 *      one unforgivable behaviour here.
 *   2. A country header, if the host or a CDN in front of it provides one.
 *      Shared hosting often does not, which is why it is not the only signal.
 *   3. Accept-Language. Every browser sends it and it needs no lookup.
 *
 * Deliberately NOT used: a third-party geolocation API. The whole site makes
 * no external requests, and putting a blocking call to someone else's server
 * in front of every page render -- for an audience whose networks are the
 * reason this product exists -- would be a bad trade.
 *
 * Two rules keep the redirect from being annoying:
 *
 *   - It only ever redirects AWAY from the English URLs, never away from
 *     /fa/. A Persian link someone shared is an explicit request for Persian
 *     and is left alone.
 *   - It stops entirely once a preference cookie exists.
 */

defined('NX') || exit;

/** Name of the preference cookie. One cookie, one purpose. */
define('NX_LANG_COOKIE', 'nx_lang');

/** How long a stated language preference is remembered. */
define('NX_LANG_COOKIE_TTL', 31536000); // one year

/**
 * The visitor's explicitly chosen locale, or '' if they have not chosen.
 *
 * @return string
 */
function nx_stored_locale()
{
    global $NX_LOCALES;

    if (!isset($_COOKIE[NX_LANG_COOKIE])) {
        return '';
    }

    $value = (string) $_COOKIE[NX_LANG_COOKIE];
    return in_array($value, $NX_LOCALES, true) ? $value : '';
}

/**
 * Two-letter country code from whatever header the host provides, or ''.
 *
 * Cloudflare sets CF-IPCountry; other proxies and panels use their own names.
 * Checking several costs nothing and means this starts working by itself if
 * the site is ever put behind a CDN.
 *
 * @return string uppercase code, or ''
 */
function nx_client_country()
{
    $headers = array(
        'HTTP_CF_IPCOUNTRY',        // Cloudflare
        'HTTP_X_COUNTRY_CODE',      // several shared hosts
        'HTTP_X_GEOIP_COUNTRY',
        'HTTP_X_APPENGINE_COUNTRY', // Google
        'GEOIP_COUNTRY_CODE',       // Apache mod_geoip
    );

    foreach ($headers as $key) {
        if (empty($_SERVER[$key])) {
            continue;
        }
        $code = strtoupper(substr((string) $_SERVER[$key], 0, 2));
        // Cloudflare sends XX for anonymised or unknown clients.
        if (preg_match('/^[A-Z]{2}$/', $code) && $code !== 'XX') {
            return $code;
        }
    }
    return '';
}

/**
 * Whether the browser asks for Persian.
 *
 * Matches the language subtag only, so fa, fa-IR and fa_IR all count, while
 * something like "farsi-fan.example" in a header cannot produce a false
 * positive.
 *
 * @return bool
 */
function nx_accepts_persian()
{
    if (empty($_SERVER['HTTP_ACCEPT_LANGUAGE'])) {
        return false;
    }

    foreach (explode(',', (string) $_SERVER['HTTP_ACCEPT_LANGUAGE']) as $part) {
        // Strip any ;q=0.8 weighting, then take the primary subtag.
        $tag = trim(strtok($part, ';'));
        $primary = strtolower(strtok($tag, '-_'));
        if ($primary === 'fa') {
            return true;
        }
    }
    return false;
}

/**
 * The locale this visitor should see if they have expressed no preference.
 *
 * @return string
 */
function nx_detect_locale()
{
    $chosen = nx_stored_locale();
    if ($chosen !== '') {
        return $chosen;
    }

    if (nx_client_country() === 'IR') {
        return 'fa';
    }

    return nx_accepts_persian() ? 'fa' : 'en';
}

/**
 * Remember a locale choice.
 *
 * @param string $locale
 */
function nx_remember_locale($locale)
{
    global $NX_LOCALES;

    if (!in_array($locale, $NX_LOCALES, true)) {
        return;
    }

    $secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (isset($_SERVER['SERVER_PORT']) && (int) $_SERVER['SERVER_PORT'] === 443);

    // Lax, not None: this cookie has no business travelling with cross-site
    // requests. HttpOnly because nothing in the page needs to read it.
    //
    // The 7.3+ options-array form of setcookie() is the only one that accepts
    // SameSite, so older PHP gets the documented path-suffix workaround
    // rather than silently losing the attribute.
    if (PHP_VERSION_ID >= 70300) {
        setcookie(NX_LANG_COOKIE, $locale, array(
            'expires'  => time() + NX_LANG_COOKIE_TTL,
            'path'     => '/',
            'secure'   => $secure,
            'httponly' => true,
            'samesite' => 'Lax',
        ));
    } else {
        setcookie(
            NX_LANG_COOKIE,
            $locale,
            time() + NX_LANG_COOKIE_TTL,
            '/; SameSite=Lax',
            '',
            $secure,
            true
        );
    }

    $_COOKIE[NX_LANG_COOKIE] = $locale;
}

/**
 * Handle ?setlang= and the automatic first-visit redirect.
 *
 * Must run before any output. Never returns if it redirects.
 */
function nx_apply_locale_preference()
{
    global $NX_LOCALES;

    // Caches must not serve one visitor's language to another. This is the
    // difference between a nice feature and a confusing one behind any proxy.
    header('Vary: Accept-Language, Cookie');

    // 1. An explicit switch. Record it, then send the visitor to the clean
    //    URL so ?setlang never ends up shared or indexed.
    if (isset($_GET['setlang'])) {
        $wanted = (string) $_GET['setlang'];
        if (in_array($wanted, $NX_LOCALES, true)) {
            nx_remember_locale($wanted);
            header('Location: ' . nx_url(nx_page(), $wanted), true, 302);
            exit;
        }
    }

    // 2. Automatic redirect, only from the English URLs and only while the
    //    visitor has expressed no preference.
    if (nx_locale() !== 'en' || nx_stored_locale() !== '') {
        return;
    }

    $detected = nx_detect_locale();
    if ($detected !== 'en') {
        // 302, not 301: this depends on who is asking, so it must never be
        // cached as a permanent property of the URL.
        header('Location: ' . nx_url(nx_page(), $detected), true, 302);
        exit;
    }
}

/**
 * URL for switching to the other language.
 *
 * Carries ?setlang so the choice is recorded, which is also what stops the
 * automatic redirect from overriding it on the next page.
 *
 * @return string
 */
function nx_switch_url()
{
    return nx_url(nx_page(), nx_other_locale()) . '?setlang=' . nx_other_locale();
}
