<?php
/**
 * Security headers, sent by PHP on every response it makes.
 *
 * WHY PHP AND NOT ONLY THE SERVER. The server config that carries these
 * (nginx-website.conf.example) has to be installed by hand, and on the live
 * host it sat uninstalled for months -- measured 2026-08-14 and again on
 * 2026-08-24: no CSP, no HSTS, nothing. A header PHP sends cannot be left
 * behind by a missed deploy step. nginx then adds the same set to static
 * files, and hides PHP's copies of everything EXCEPT the CSP, so no header
 * is ever sent twice (see the conf).
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
 * Send the full set. Safe to call more than once: header() replaces.
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

    // Two years, every subdomain, and preload-ready. Adding the domain to
    // the browsers' preload list is a separate, deliberate submission at
    // hstspreload.org and is close to irreversible -- the owner's call,
    // not this file's. Browsers ignore the header over plain http.
    header('Strict-Transport-Security: max-age=63072000; includeSubDomains; preload');
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: strict-origin-when-cross-origin');
    // frame-ancestors 'none' says the same to every current browser; this
    // is for the ones that predate it.
    header('X-Frame-Options: DENY');
    header('Cross-Origin-Opener-Policy: same-origin');
    header('Cross-Origin-Resource-Policy: same-origin');
    header('Permissions-Policy: ' . NX_PERMISSIONS_POLICY);
    header('Content-Security-Policy: ' . ($csp !== null ? $csp : NX_CSP_NONE));
}
