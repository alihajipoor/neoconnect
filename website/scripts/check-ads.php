<?php
/**
 * Check that the Google tag reaches only visitors from our Google ads.
 *
 *     php scripts/check-ads.php
 *
 * Starts PHP's built-in server on the site (scripts/dev-router.php, as the
 * live host routes), fetches real responses and asserts:
 *
 *   1. A plain visit -- no click id, no nx_ad cookie -- has no Google
 *      source in its policy header and no trace of the tag in its HTML, on
 *      every page in both languages. So do near misses: an empty or
 *      malformed click id, a marker cookie with the wrong value.
 *   2. An ad visit (gclid, gbraid or wbraid) and a later page of one (the
 *      nx_ad=1 cookie) get the header opened to EXACTLY the sources listed
 *      below, still with no 'unsafe-inline', and the loader adds ads.js
 *      with the tag id -- still one inline script, allowed by its hash.
 *   3. The privacy page's "turn it off" request runs ads.js with the header
 *      still strict, and expires the marker cookie.
 *
 * What runs in the browser (the time zone, the question, the consent
 * defaults, the download event) is not provable from here; see the README.
 *
 * The expected sources are written out literally, not read from
 * inc/ads.php: a check that asks the code under test for the answer cannot
 * catch the code being wrong. Source: Google's CSP guide, "Google Ads
 * conversions", developers.google.com/tag-platform/security/guides/csp.
 *
 * Exit code 0 if clean, 1 if anything failed.
 */

$root = dirname(__DIR__);
$port = 18000 + mt_rand(0, 999);
$base = 'http://127.0.0.1:' . $port;

$google = array();
foreach (array('com', 'co.uk', 'de', 'fr', 'it', 'es', 'nl', 'be', 'at', 'ch', 'ie', 'pt',
    'pl', 'se', 'dk', 'fi', 'no', 'is', 'lu', 'li', 'cz', 'sk', 'hu', 'ro', 'bg',
    'gr', 'hr', 'si', 'lt', 'lv', 'ee', 'com.cy', 'com.mt') as $t) {
    $google[] = 'https://www.google.' . $t;
}
$ads = array('https://www.googletagmanager.com', 'https://www.googleadservices.com',
    'https://googleads.g.doubleclick.net', 'https://pagead2.googlesyndication.com');
$expect = array(
    'script-src' => array('https://www.googletagmanager.com', 'https://www.googleadservices.com', 'https://www.google.com'),
    'img-src' => array_merge($ads, $google),
    'connect-src' => array_merge($ads, $google, array('https://ad.doubleclick.net')),
    'frame-src' => array('https://www.googletagmanager.com'),
);

$cmd = escapeshellarg(PHP_BINARY) . ' -S 127.0.0.1:' . $port . ' -t ' . escapeshellarg($root)
    . ' ' . escapeshellarg($root . '/scripts/dev-router.php');
$null = stripos(PHP_OS, 'WIN') === 0 ? 'NUL' : '/dev/null';
$server = proc_open($cmd, array(array("pipe", "r"), array("file", $null, "w"), array("file", $null, "w")), $pipes, null, null, array("bypass_shell" => true));
if (!is_resource($server)) {
    fwrite(STDERR, "could not start the built-in server\n");
    exit(1);
}
for ($i = 0; $i < 50 && !@fsockopen('127.0.0.1', $port); $i++) {
    usleep(100000);
}

/** @return array [status line, headers by lower-case name (list), body] */
function nxa_get($url, $cookie = '', $extra = '')
{
    $ctx = stream_context_create(array('http' => array(
        'method' => 'GET',
        'header' => ($cookie !== '' ? 'Cookie: ' . $cookie . "\r\n" : '') . "Accept-Language: en\r\n" . $extra,
        'ignore_errors' => true,
        'follow_location' => 0,
        'timeout' => 20,
    )));
    $body = @file_get_contents($url, false, $ctx);
    $headers = array();
    $status = '';
    foreach (isset($http_response_header) ? $http_response_header : array() as $h) {
        if (strpos($h, 'HTTP/') === 0) {
            $status = $h;
            continue;
        }
        $p = strpos($h, ':');
        if ($p !== false) {
            $headers[strtolower(trim(substr($h, 0, $p)))][] = trim(substr($h, $p + 1));
        }
    }
    return array($status, $headers, $body === false ? '' : $body);
}

/** @return array directive => list of sources */
function nxa_csp($headers)
{
    $out = array();
    $csp = isset($headers['content-security-policy'][0]) ? $headers['content-security-policy'][0] : '';
    foreach (explode(';', $csp) as $d) {
        $parts = preg_split('/\s+/', trim($d));
        if ($parts && $parts[0] !== '') {
            $out[array_shift($parts)] = $parts;
        }
    }
    return $out;
}

$failures = array();
$checked = 0;
$pages = array('', 'features/', 'pricing/', 'faq/', 'download/', 'contact/', 'reseller/', 'privacy/', 'delete-account/');

// 1. Plain visits and near misses.
$plain = array(
    array('', ''),
    array('?gclid=', ''),
    array('?gclid=%20', ''),
    array('?utm_source=google', ''),
    array('', 'nx_ad=0'),
    array('', 'nx_ad=yes'),
);
foreach (array('', 'fa/') as $loc) {
    foreach ($pages as $pg) {
        foreach ($plain as $case) {
            list($q, $cookie) = $case;
            if (($q !== '' || $cookie !== '') && $pg !== 'download/' && $pg !== '') {
                continue; // near misses on two pages per locale is enough
            }
            $label = '[plain /' . $loc . $pg . $q . ($cookie !== '' ? ' cookie ' . $cookie : '') . ']';
            list($st, $h, $body) = nxa_get($base . '/' . $loc . $pg . $q, $cookie);
            $checked++;
            if (strpos($st, ' 200') === false) {
                $failures[] = $label . ' status ' . $st;
                continue;
            }
            $csp = isset($h['content-security-policy'][0]) ? $h['content-security-policy'][0] : '';
            if ($csp === '' || preg_match('/google|doubleclick|frame-src/i', $csp)) {
                $failures[] = $label . ' policy header names Google or a frame source: ' . substr($csp, 0, 120);
            }
            if (preg_match('/ads\.js|data-nx-ads|googletagmanager|gtag|dataLayer|adsbar/i', $body)) {
                $failures[] = $label . ' HTML carries the Google tag or its loader';
            }
            if (isset($h['set-cookie'])) {
                $failures[] = $label . ' sets a cookie: ' . implode(' | ', $h['set-cookie']);
            }
        }
    }
}

// 1b. A restricted country never gets the tag, even with a click id or the
//     marker cookie: a ?gclid= link can be posted anywhere.
foreach (array(array('download/?gclid=test', ''), array('fa/download/?gclid=test', ''),
    array('pricing/', 'nx_ad=1')) as $case) {
    list($q, $cookie) = $case;
    $label = '[restricted /' . $q . ($cookie !== '' ? ' cookie ' . $cookie : '') . ']';
    list($st, $h, $body) = nxa_get($base . '/' . $q, $cookie, "CF-IPCountry: IR\r\n");
    $checked++;
    if (strpos($st, ' 200') === false) {
        $failures[] = $label . ' status ' . $st;
        continue;
    }
    $csp = isset($h['content-security-policy'][0]) ? $h['content-security-policy'][0] : '';
    if ($csp === '' || preg_match('/google|doubleclick|frame-src/i', $csp)) {
        $failures[] = $label . ' policy header names Google';
    }
    if (preg_match('/ads\.js|data-nx-ads|googletagmanager|gtag|dataLayer|adsbar/i', $body)) {
        $failures[] = $label . ' HTML carries the Google tag or its loader';
    }
}

// 2. Ad visits and later pages of one.
$adCases = array(
    array('download/?gclid=test', ''),
    array('download/?gbraid=test', ''),
    array('download/?wbraid=test', ''),
    array('fa/download/?gclid=test', ''),
    array('?gclid=Cj0KCQiA-test_123', ''),
    array('pricing/', 'nx_ad=1'),
    array('privacy/', 'nx_ad=1'),
);
foreach ($adCases as $case) {
    list($path, $cookie) = $case;
    $label = '[ad /' . $path . ($cookie !== '' ? ' cookie ' . $cookie : '') . ']';
    list($st, $h, $body) = nxa_get($base . '/' . $path, $cookie);
    $checked++;
    if (strpos($st, ' 200') === false) {
        $failures[] = $label . ' status ' . $st;
        continue;
    }
    $csp = nxa_csp($h);
    $raw = $h['content-security-policy'][0];
    if (preg_match("/'unsafe-(inline|eval)'/", $raw)) {
        $failures[] = $label . ' policy has unsafe-inline or unsafe-eval';
    }
    foreach ($expect as $dir => $want) {
        $have = isset($csp[$dir]) ? $csp[$dir] : array();
        $extra = array_values(array_filter($have, function ($s) {
            return strpos($s, 'https://') === 0;
        }));
        sort($extra);
        $w = $want;
        sort($w);
        if ($extra !== $w) {
            $failures[] = $label . ' ' . $dir . ' outside sources differ: got ' . implode(' ', array_diff($extra, $w))
                . ' / missing ' . implode(' ', array_diff($w, $extra));
        }
    }
    foreach ($csp as $dir => $list) {
        if (!isset($expect[$dir]) && preg_grep('#^https?://#', $list)) {
            $failures[] = $label . ' ' . $dir . ' names an outside source';
        }
    }
    // Still exactly one inline script, and it is the hashed one.
    if (!preg_match_all('/<script>(.*?)<\/script>/s', $body, $m) || count($m[1]) !== 1) {
        $failures[] = $label . ' expected exactly one inline script';
    } else {
        $hash = "'sha256-" . base64_encode(hash('sha256', $m[1][0], true)) . "'";
        if (!in_array($hash, $csp['script-src'], true)) {
            $failures[] = $label . ' inline script is not allowed by its hash';
        }
        if (strpos($m[1][0], 'js/ads.js') === false || strpos($m[1][0], 'GTM-P95CLDXK') === false) {
            $failures[] = $label . ' loader does not add ads.js with the tag id';
        }
    }
    if (strpos($body, 'googletagmanager') !== false && strpos($body, 'gtm.js') !== false) {
        $failures[] = $label . ' the Google script is in the HTML itself (it must come from ads.js)';
    }
    if (strpos($body, '.adsbar{') === false) {
        $failures[] = $label . ' the question\'s styles are not inlined';
    }
}

// 3. The "turn it off" link.
list($st, $h, $body) = nxa_get($base . '/privacy/?ads=off', 'nx_ad=1');
$checked++;
$raw = isset($h['content-security-policy'][0]) ? $h['content-security-policy'][0] : '';
if (preg_match('/google|doubleclick/i', $raw)) {
    $failures[] = '[off] policy header opened on the turn-it-off request';
}
if (strpos($body, 'js/ads.js') === false || strpos($body, 'data-ads-off-done') === false) {
    $failures[] = '[off] ads.js or the confirmation line is missing';
}
$sc = isset($h['set-cookie']) ? implode(' | ', $h['set-cookie']) : '';
if (!preg_match('/nx_ad=(deleted)?;.*expires=/i', $sc)) {
    $failures[] = '[off] marker cookie not expired: ' . $sc;
}
// And every privacy page offers the link.
list($st, $h, $body) = nxa_get($base . '/privacy/');
if (strpos($body, 'href="/privacy/?ads=off#ads"') === false || strpos($body, 'id="ads"') === false) {
    $failures[] = '[privacy] the turn-it-off link or the #ads heading is missing';
}

// 4. The ad loader must PARSE: string checks above once passed a loader
//    that every browser rejected with a syntax error (a missing semicolon).
//    Needs Node; skipped, and said so, without it.
list($st, $h, $body) = nxa_get($base . '/download/?gclid=test');
if (preg_match('/<script>(.*?)<\/script>/s', $body, $m)) {
    $tmp = tempnam(sys_get_temp_dir(), 'nxl') . '.js';
    file_put_contents($tmp, $m[1]);
    exec('node --check ' . escapeshellarg($tmp) . ' 2>&1', $o, $rc);
    if ($rc === 0) {
        $checked++;
    } elseif (preg_match('/not (found|recognized)/i', implode(' ', $o))) {
        echo "(node not found: the loader's syntax was not checked)\n";
    } else {
        $failures[] = '[ad loader] does not parse: ' . implode(' ', $o);
    }
    @unlink($tmp);
}

proc_terminate($server);
proc_close($server);

echo 'Checked ' . $checked . " responses.\n";
if ($failures) {
    echo "\nFAILED (" . count($failures) . "):\n";
    foreach ($failures as $f) {
        echo '  - ' . $f . "\n";
    }
    exit(1);
}
echo "All clean.\n";
exit(0);
