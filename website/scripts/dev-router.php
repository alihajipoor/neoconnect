<?php
/**
 * Router for PHP's built-in server, so the site can be RENDERED locally.
 *
 *     php -S 127.0.0.1:8123 -t website website/scripts/dev-router.php
 *
 * The built-in server serves directory index.php files on its own, which
 * gets you most of the site. It does not do the two things the real server
 * does that this site's SEO depends on, and both of them are defects the
 * live site actually shipped:
 *
 *   1. An unknown path must be a real 404 rendered by 404.php. Without
 *      this, every mistyped URL 200s -- which is exactly the production
 *      bug being fixed, so checking locally without this router reports
 *      the bug as absent.
 *   2. /sitemap.xml must serve the XML from sitemap.php.
 *
 * It also carries the /r/CODE voucher rewrite, for the same reason: it is
 * inert on the live host today and needs somewhere to be exercised.
 *
 * This mirrors nginx-website.conf.example. If you change a rule there,
 * change it here, or local rendering stops describing production.
 *
 * ONE DIFFERENCE FROM PRODUCTION, on purpose: nginx's `try_files $uri $uri/`
 * issues a 301 from /download to /download/, and the built-in server just
 * serves the directory index at both. Emulating that here would mean
 * reimplementing nginx's rule rather than exercising the site, and the
 * trailing-slash redirects were measured working on the live host. Do not
 * conclude from a local 200 on /download that the redirect is missing.
 *
 * Development only. It is excluded from the deploy archive, and the server
 * config denies /scripts/ outright.
 */

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$root = getenv('NX_ROOT_DIR');
if (!$root) {
    $root = dirname(__DIR__);
}

// location = /sitemap.xml { rewrite ^ /sitemap.php last; }
if ($path === '/sitemap.xml') {
    require $root . '/sitemap.php';
    return true;
}

// location ~ "^/r/([A-Za-z0-9-]{1,32})/?$" { rewrite ^ /r/index.php?c=$1 last; }
if (preg_match('#^/r/([A-Za-z0-9-]{1,32})/?$#', $path, $m)) {
    $_GET['c'] = $m[1];
    require $root . '/r/index.php';
    return true;
}

// location ^~ /data/ | /inc/ | /scripts/ { deny all; return 404; }
if (preg_match('#^/(data|inc|scripts)/#', $path) || preg_match('#/\.#', $path)) {
    http_response_code(404);
    require $root . '/404.php';
    return true;
}

$file = $root . $path;

// try_files $uri $uri/ -- let the built-in server handle anything real.
//
// index.html as well as index.php, and for one reason: /account/ is the
// compiled customer portal, an SPA with no index.php under it. Checking
// only for index.php made /account/ 404 here while every file inside it
// served fine, so the portal could not be walked locally at all -- and the
// same gap existed in the real server configs, where it was a live fault
// rather than a testing one. Mirrors `index index.php index.html;` in
// nginx-website.conf.example.
foreach (array('index.php', 'index.html') as $indexFile) {
    if (is_dir($file) && is_file(rtrim($file, '/') . '/' . $indexFile)) {
        return false;
    }
}
if (is_file($file)) {
    return false;
}

// A missing asset is a bare 404, not a marketing page: rendering the
// whole site into a stylesheet request would be its own kind of lie.
if (preg_match('#\.(css|js|woff2|svg|png|jpg|jpeg|webp|avif|ico|txt|xml|map)$#', $path)) {
    http_response_code(404);
    header('Content-Type: text/plain; charset=UTF-8');
    echo "404\n";
    return true;
}

// error_page 404 /404.php;
http_response_code(404);
require $root . '/404.php';
return true;
