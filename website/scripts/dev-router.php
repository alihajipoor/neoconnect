<?php
/**
 * Router for PHP's built-in server, so the site can be RENDERED locally.
 *
 *     php -S 127.0.0.1:8123 -t website website/scripts/dev-router.php
 *
 * It behaves like the live host, which is a shared nginx box whose config
 * is not ours to change: a real file (or a directory with an index file) is
 * served as itself, and EVERYTHING ELSE goes to /index.php. The site's own
 * routing -- real 404s, /sitemap.xml, /r/CODE -- lives at the top of
 * index.php, so this file must not do any of it. If it did, a local check
 * would pass on rules production does not have, which is exactly how the
 * soft-404s on the live site went unnoticed (2026-10-19).
 *
 * ONE DIFFERENCE FROM PRODUCTION, on purpose: nginx issues a 301 from
 * /download to /download/, and the built-in server just serves the
 * directory index at both. The redirects were measured working on the
 * live host. Do not conclude from a local 200 on /download that the
 * redirect is missing.
 *
 * Development only. It is excluded from the deploy archive.
 */

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$root = getenv('NX_ROOT_DIR');
if (!$root) {
    $root = dirname(__DIR__);
}
$file = $root . $path;

// gzip, as the live host does (it sends gzip and nothing better). Without
// it a local Lighthouse run measures transfers production never makes.
// PHP output: zlib.output_compression, set before anything is printed; it
// holds for a script the built-in server runs after "return false" too.
// Static text: served here, compressed, with the ETag and Last-Modified the
// host sends and no Cache-Control, which the host does not send either.
$gzip = isset($_SERVER['HTTP_ACCEPT_ENCODING']) && stripos($_SERVER['HTTP_ACCEPT_ENCODING'], 'gzip') !== false;
if ($gzip && function_exists('gzencode')) {
    ini_set('zlib.output_compression', '1');
    $types = array('css' => 'text/css', 'js' => 'application/javascript', 'svg' => 'image/svg+xml',
        'txt' => 'text/plain', 'xml' => 'application/xml', 'json' => 'application/json');
    $ext = strtolower(pathinfo($file, PATHINFO_EXTENSION));
    if (isset($types[$ext]) && is_file($file)) {
        ini_set('zlib.output_compression', '0');
        $mtime = filemtime($file);
        $etag = '"' . dechex($mtime) . '-' . dechex(filesize($file)) . '"';
        header('Content-Type: ' . $types[$ext] . ($ext === 'svg' ? '' : '; charset=utf-8'));
        header('ETag: ' . $etag);
        header('Last-Modified: ' . gmdate('D, d M Y H:i:s', $mtime) . ' GMT');
        header('Vary: Accept-Encoding');
        if (isset($_SERVER['HTTP_IF_NONE_MATCH']) && trim($_SERVER['HTTP_IF_NONE_MATCH']) === $etag) {
            http_response_code(304);
            return true;
        }
        $body = gzencode(file_get_contents($file), 6);
        header('Content-Encoding: gzip');
        header('Content-Length: ' . strlen($body));
        echo $body;
        return true;
    }
}

// try_files $uri $uri/ -- let the built-in server handle anything real.
// index.html as well as index.php for /account/, the compiled customer
// portal, which has no index.php.
foreach (array('index.php', 'index.html') as $indexFile) {
    if (is_dir($file) && is_file(rtrim($file, '/') . '/' . $indexFile)) {
        return false;
    }
}
if (is_file($file)) {
    return false;
}

// ... /index.php -- the host's fallback for everything else.
$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = $root . '/index.php';
require $root . '/index.php';
return true;
