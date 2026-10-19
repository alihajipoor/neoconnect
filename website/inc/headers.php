<?php
/**
 * Security headers, sent by PHP on every response it makes.
 *
 * WHY PHP. The live host is a shared box (owner, 2026-10-19): its nginx is
 * not ours to configure, so nothing in nginx-website.conf.example will ever
 * be installed there. What the site needs beyond the host's defaults has to
 * come from PHP.
 *
 * NEVER TWICE. That shared nginx already adds four of these to every
 * response, PHP's included: HSTS (one year, includeSubDomains),
 * X-Frame-Options SAMEORIGIN, nosniff and Referrer-Policy (measured
 * 2026-10-19). PHP sending its own copies would put two HSTS headers on
 * every page -- hstspreload.org rejects that -- and two X-Frame-Options
 * that disagree. So config.php lists what the server already sends
 * ('headers_sent_by_server') and this file skips exactly those. On a host
 * that sends none of them, empty the list and PHP sends the full set.
 * Check a real response after every deploy: the list describes a server
 * we do not control, and it can change under us.
 *
 * THE CSP IS PHP'S ALONE, because it is per page: the page's stylesheet is
 * inlined (no render-blocking request) and allowed by its SHA-256, and the
 * one inline script -- the loader in head.php -- by its SHA-256 too. There
 * is no 'unsafe-inline' and no 'unsafe-eval' anywhere. 'strict-dynamic'
 * lets the loader add site.js; 'self' is only the fallback for browsers
 * that predate 'strict-dynamic' (newer ones ignore it when it is present).
 *
 * Standalone on purpose: r/index.php sends these without loading the rest
 * of the site.
 */

defined('NX') || exit;

/**
 * Features the site never uses, switched off for this origin and any frame.
 * Only names current browsers recognise: an unknown one (the old
 * interest-cohort, say) is logged as a console error on every page.
 */
define('NX_PERMISSIONS_POLICY',
    'accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), '
    . 'geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), '
    . 'publickey-credentials-get=(), screen-wake-lock=(), serial=(), usb=(), '
    . 'xr-spatial-tracking=(), browsing-topics=()');

/**
 * The CSP for anything that is not a rendered page (the sitemap, redirects,
 * errors before the head is built): nothing may load at all.
 */
define('NX_CSP_NONE', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");

/**
 * Build a page's Content-Security-Policy.
 *
 * @param array $scriptHashes base64 SHA-256 values of inline scripts
 * @param array $styleHashes  base64 SHA-256 values of inline <style> blocks
 * @return string
 */
function nx_csp_for_page($scriptHashes, $styleHashes)
{
    $script = array();
    foreach ($scriptHashes as $h) {
        $script[] = "'sha256-" . $h . "'";
    }
    $style = array("'self'");
    foreach ($styleHashes as $h) {
        $style[] = "'sha256-" . $h . "'";
    }

    return implode('; ', array(
        "default-src 'self'",
        'script-src ' . implode(' ', $script) . " 'strict-dynamic' 'self'",
        'style-src ' . implode(' ', $style),
        "img-src 'self'",
        "font-src 'self'",
        "connect-src 'self'",
        "manifest-src 'self'",
        "media-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ));
}

/**
 * The fixed headers the web server already adds itself, lower-cased, from
 * 'headers_sent_by_server' in config.php. Reads the config on its own when
 * the bootstrap has not (r/index.php).
 *
 * @return array
 */
function nx_server_header_names()
{
    static $names = null;
    if ($names === null) {
        $cfg = (isset($GLOBALS['NX_CFG']) && is_array($GLOBALS['NX_CFG']))
            ? $GLOBALS['NX_CFG']
            : (require __DIR__ . '/config.php');
        $list = (isset($cfg['headers_sent_by_server']) && is_array($cfg['headers_sent_by_server']))
            ? $cfg['headers_sent_by_server']
            : array();
        $names = array_map('strtolower', $list);
    }
    return $names;
}

/**
 * Send the set, minus what the server already sends. Safe to call more
 * than once: header() replaces.
 *
 * @param string|null $csp a page policy, or null for NX_CSP_NONE
 */
function nx_security_headers($csp = null)
{
    if (headers_sent()) {
        return;
    }

    // No version leakage. expose_php=Off in php.ini is the real fix; this
    // covers a host where nobody has set it.
    if (function_exists('header_remove')) {
        header_remove('X-Powered-By');
    }

    $fixed = array(
        // Two years and every subdomain. NOT 'preload': that token is the
        // signal hstspreload.org acts on, its form does not check who owns
        // the domain, and inclusion is close to irreversible for
        // neoxify.net and every name under it. Add the word only when the
        // owner decides to submit, after confirming every neoxify.net name
        // serves HTTPS. Browsers ignore the header over plain http.
        'Strict-Transport-Security' => 'max-age=63072000; includeSubDomains',
        'X-Content-Type-Options' => 'nosniff',
        'Referrer-Policy' => 'strict-origin-when-cross-origin',
        // frame-ancestors 'none' in the CSP says the same to every current
        // browser and wins over this; this is for the ones that predate it.
        'X-Frame-Options' => 'DENY',
        'Cross-Origin-Opener-Policy' => 'same-origin',
        'Cross-Origin-Resource-Policy' => 'same-origin',
        'Permissions-Policy' => NX_PERMISSIONS_POLICY,
    );
    $skip = nx_server_header_names();
    foreach ($fixed as $name => $value) {
        if (in_array(strtolower($name), $skip, true)) {
            continue;
        }
        header($name . ': ' . $value);
    }

    // Never skipped, whatever the config says: it is per page and no
    // server can write it.
    header('Content-Security-Policy: ' . ($csp !== null ? $csp : NX_CSP_NONE));
}
