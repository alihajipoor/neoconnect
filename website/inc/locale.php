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
 * Whether this request looks like a search-engine crawler.
 *
 * Crawlers are never redirected by language. Googlebot crawls from the US
 * with `Accept-Language: en`, and bouncing a bot around on the strength of a
 * header it did not really mean is how half a site stops being indexed. The
 * Persian pages are already safe -- the redirect below only ever fires on an
 * English URL -- but this makes the English half safe too, so a bot that
 * happens to send `fa` still indexes `/` as English rather than following a
 * 302 to `/fa/` and indexing that instead.
 *
 * Deliberately a coarse substring match rather than a precise list: the cost
 * of a false positive is one visitor not being auto-redirected (they can
 * still switch, and the switch still sticks), and the cost of a false
 * negative is a page dropping out of the index.
 *
 * @return bool
 */
function nx_is_crawler()
{
    if (empty($_SERVER['HTTP_USER_AGENT'])) {
        // No UA at all is far more likely to be a bot or a probe than a
        // browser, and not redirecting it costs nothing.
        return true;
    }

    $ua = strtolower((string) $_SERVER['HTTP_USER_AGENT']);

    $signatures = array(
        'bot', 'crawl', 'spider', 'slurp', 'archiver',
        'facebookexternalhit', 'embedly', 'quora link preview',
        'telegrambot', 'whatsapp', 'discordbot', 'twitterbot',
        'linkedinbot', 'pinterest', 'redditbot', 'applebot',
        'lighthouse', 'chrome-lighthouse', 'headlesschrome',
    );

    foreach ($signatures as $needle) {
        if (strpos($ua, $needle) !== false) {
            return true;
        }
    }
    return false;
}

/**
 * The query string of the current request, including the leading '?', or ''.
 *
 * The automatic redirect has to carry it. `/pricing?ref=abc` must land on
 * `/fa/pricing?ref=abc` and not on `/fa/pricing`, or every referral and
 * campaign parameter is silently dropped for exactly the visitors the
 * redirect exists to serve.
 *
 * `setlang` is stripped on the way through: it has done its job by the time
 * anything redirects, and letting it ride along would put it back in the
 * address bar and into anything the visitor then shares.
 *
 * @return string
 */
function nx_query_suffix()
{
    if (empty($_GET)) {
        return '';
    }

    $params = $_GET;
    unset($params['setlang']);

    if (!$params) {
        return '';
    }

    return '?' . http_build_query($params);
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
            // Carry any other query parameters across, and drop setlang
            // itself so it never ends up shared or indexed.
            header('Location: ' . nx_url(nx_page(), $wanted) . nx_query_suffix(), true, 302);
            exit;
        }
    }

    // 2. Automatic redirect. Four guards, and every one of them matters:
    //
    //    a. Only from the ENGLISH URLs. A request for /fa/anything is an
    //       explicit request for Persian -- somebody followed a Persian
    //       link -- and is never redirected. This is also what keeps every
    //       Persian page directly reachable by a crawler.
    //    b. Only while the visitor has expressed no preference. Once the
    //       cookie exists, nothing here fires again in either direction:
    //       somebody who chose English can sit on / forever.
    //    c. Never for a crawler. See nx_is_crawler().
    //    d. At most once per request -- guaranteed by (a), since the target
    //       of the redirect is a /fa/ URL, which (a) then refuses to touch.
    if (nx_locale() !== 'en' || nx_stored_locale() !== '' || nx_is_crawler()) {
        return;
    }

    $detected = nx_detect_locale();
    if ($detected !== 'en') {
        // 302, NEVER 301. This response depends on who is asking, so it must
        // not be cached as a permanent property of the URL -- a 301 here
        // would pin a visitor to one language in their own browser cache,
        // including after they switch.
        header('Location: ' . nx_url(nx_page(), $detected) . nx_query_suffix(), true, 302);
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
    /* Points at THE SAME PAGE in the other language, never at the home page.
       Sending someone who is reading /fa/faq to / because they wanted
       English is the single most irritating bug a language switch can have,
       and it is the default one. nx_page() is what prevents it. */
    return nx_url(nx_page(), nx_other_locale()) . '?setlang=' . nx_other_locale();
}
