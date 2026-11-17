<?php
/** English landing page for the Google ads campaign. English only; see inc/pages/vpn-app.php. */

$NX_LOCALE = 'en';
$NX_PAGE = 'vpn-app';

// The ad is in English and so is this page: someone who clicked it stays on
// it, whatever their browser's language. (There is no Persian version to
// redirect to; /fa/vpn-app/ goes to the Persian home page.)
$NX_SKIP_LOCALE_REDIRECT = true;

require dirname(__DIR__) . '/inc/bootstrap.php';
require NX_INC . '/pages/vpn-app.php';
