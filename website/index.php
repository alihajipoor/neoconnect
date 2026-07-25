<?php
/**
 * English home page.
 *
 * Page files are deliberately this thin: declare which page and locale this
 * is, then hand off to the shared template. Real directories with an
 * index.php give clean URLs (/download/, /fa/contact/) without depending on
 * mod_rewrite, so the site works the moment it is unzipped -- on Apache,
 * LiteSpeed or nginx alike.
 */

$NX_LOCALE = 'en';
$NX_PAGE = 'home';

require __DIR__ . '/inc/bootstrap.php';
require NX_INC . '/pages/home.php';
