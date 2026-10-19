<?php
/**
 * English home page -- and the site's router.
 *
 * Page files are deliberately thin: declare which page and locale this is,
 * then hand off to the shared template. Real directories with an index.php
 * give clean URLs (/download/, /fa/contact/) without depending on
 * mod_rewrite, so the site works the moment it is unzipped -- on Apache,
 * LiteSpeed or nginx alike.
 *
 * WHY THIS FILE ALSO ROUTES. The live host is a shared box whose nginx
 * config is not ours to change, and it sends every request it cannot match
 * to a file to /index.php -- this file. Measured 2026-10-19: an unknown URL,
 * /sitemap.xml and /r/CODE all came back as the home page with a 200. So
 * before anything else, look at the path that was actually asked for:
 *
 *   /  and  /index.php      the home page, below
 *   /sitemap.xml            the generated sitemap
 *   /r/CODE                 a voucher short link
 *   anything else           a real 404, rendered by 404.php
 *
 * Nothing here depends on server configuration, so the same rules hold on
 * nginx with that fallback, on Apache (where .htaccess does the same and
 * this is a second layer), and under PHP's built-in server.
 */

$nx_uri = isset($_SERVER['REQUEST_URI']) ? (string) $_SERVER['REQUEST_URI'] : '/';
$nx_cut = strcspn($nx_uri, '?#');
$nx_path = substr($nx_uri, 0, $nx_cut);
// Absolute-form request targets (http://host/path) are legal, if rare.
if (preg_match('#^[a-z][a-z0-9+.-]*://[^/]*#i', $nx_path, $nx_m)) {
    $nx_path = (string) substr($nx_path, strlen($nx_m[0]));
}
// The site may live in a subfolder (base_path in inc/config.php); whatever
// folder holds this file is the site's root.
$nx_root = rtrim(str_replace('\\', '/', dirname(isset($_SERVER['SCRIPT_NAME']) ? (string) $_SERVER['SCRIPT_NAME'] : '/index.php')), '/') . '/';
$nx_rel = strpos($nx_path, $nx_root) === 0 ? (string) substr($nx_path, strlen($nx_root)) : $nx_path;

if ($nx_rel === 'sitemap.xml') {
    require __DIR__ . '/sitemap.php';
    exit;
}
if (preg_match('#^r/([A-Za-z0-9-]{1,32})/?$#', $nx_rel, $nx_m)) {
    $_GET['c'] = $nx_m[1];
    require __DIR__ . '/r/index.php';
    exit;
}
if ($nx_rel !== '' && $nx_rel !== 'index.php') {
    // 404.php sends the 404 status itself and picks the locale from the
    // path, so /fa/anything-missing gets a Persian page.
    require __DIR__ . '/404.php';
    exit;
}
unset($nx_uri, $nx_cut, $nx_path, $nx_m, $nx_root, $nx_rel);

$NX_LOCALE = 'en';
$NX_PAGE = 'home';

require __DIR__ . '/inc/bootstrap.php';
require NX_INC . '/pages/home.php';
