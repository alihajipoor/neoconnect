<?php
/**
 * /fa/vpn-app/ -- there is no Persian version of the ads landing page.
 *
 * The page exists for an English-only campaign, so it is written in English
 * alone. Anyone who reaches this address -- by the language switch on the
 * English page, or by typing it -- is sent to the Persian home page instead
 * of a 404. A language choice made with the switch (?setlang=fa) is still
 * recorded, and any other query parameters ride along.
 *
 * 302, not 301: if a Persian version is ever written, nothing is cached.
 */

$NX_LOCALE = 'fa';
$NX_PAGE = 'home';
$NX_SKIP_LOCALE_REDIRECT = true;

require dirname(__DIR__, 2) . '/inc/bootstrap.php';

if (isset($_GET['setlang']) && $_GET['setlang'] === 'fa') {
    nx_remember_locale('fa');
}

nx_security_headers();
header('Vary: Accept-Language, Cookie');
header('Cache-Control: no-cache, must-revalidate');
header('Location: ' . nx_url('home', 'fa') . nx_query_suffix(), true, 302);
exit;
