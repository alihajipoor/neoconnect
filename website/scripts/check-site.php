<?php
/**
 * Pre-deploy check for the Neoxify website.
 *
 * WHY THIS EXISTS. On 2026-08-24 the live site was serving
 *
 *     <title>⟪meta.delete-account.title⟫</title>
 *
 * on two pages, in both languages, and had been for months: nothing ever
 * looked at a rendered <title>. And until it was caught by reading the
 * markup, the account-deletion form -- the page Google Play's data safety
 * form points at -- POSTed to the home page and every request was lost.
 * This renders every page in every locale and fails on anything that should
 * never reach a visitor.
 *
 *     php scripts/check-site.php                 render each page in a child PHP
 *     php scripts/check-site.php --html <dir>    check pages already rendered
 *                                                 into <dir>/<locale>-<page>.html
 *
 * The second form exists for a machine with no native PHP: render the pages
 * from any running preview (e.g. PHP compiled to WebAssembly) into a folder,
 * then run this file in the same runtime against it.
 *
 * Exit code 0 if clean, 1 if anything failed -- so it can gate a deploy.
 */

$root = dirname(__DIR__);

/**
 * UTF-8 character count, without mbstring: the check must not need a
 * heavier runtime than the site it checks.
 */
function nxc_len($s)
{
    return preg_match_all('/./us', $s);
}

function nxc_cut($s, $n)
{
    return preg_match('/^.{0,' . (int) $n . '}/us', $s, $m) ? $m[0] : $s;
}

$locales = array('en', 'fa');
$pages = array(
    'home' => '',
    'features' => 'features/',
    'pricing' => 'pricing/',
    'faq' => 'faq/',
    'download' => 'download/',
    'contact' => 'contact/',
    'reseller' => 'reseller/',
    'privacy' => 'privacy/',
    'delete-account' => 'delete-account/',
    'vpn-app' => 'vpn-app/',
);

/* Pages that exist in one language only, and pages that must not be
 * indexed. vpn-app is the Google ads landing page: English, noindex, kept
 * out of the navigation and the sitemap (its /fa/ address redirects to the
 * Persian home page; check-ads.php checks that over HTTP). */
$oneLocale = array('vpn-app' => 'en');
$noindexPages = array('vpn-app');

/* What the ads landing page must never say, anywhere in its HTML: text,
 * meta, alt text, labels, comments. The campaign's ad was disapproved for
 * "enabling dishonest behavior"; Google judges the landing page too. */
$adsPages = array('vpn-app');
$adsForbidden = array(
    '/\b(un)?block(s|ed|ing|er)?\b/i', '/restrict/i', '/censor/i', '/\bfilter/i',
    '/bypass|circumvent|get(ting|s)? (around|past|through)|work ?around/i',
    '/hard to (block|detect|spot)|\b(un)?detect/i', '/stealth|disguis|camoufl|obfusc/i',
    '/looks? like|ordinary (web|traffic|browsing)|like any other traffic|stand out/i',
    '/\bhid(e|es|den|ing)\b|appear (to be|in|from)|where you (appear|are)|your location/i',
    '/(pick|choose|change|select) (a |the |your )?(country|location)/i',
    '/anonym|untraceable|no[- ]logs?\b|fastest|\bping\b|latency|lag\b|stream/i',
    '/unrestricted|uncensored|without limits|freedom|abroad|foreign|geo[- ]?/i',
    '/\bIran|\bIR\b|fa_IR|turkey|t(ü|u)rkiye.*restrict/i',
    '/protocol|\bports?\b|\brelay|backup route|\btunnel/i',
    '/wireguard|vless|vmess|\breality\b|shadowsocks|trojan|xray|ikev2|openvpn|hysteria|tuic|\btcp\b|\budp\b/i',
    '/neoxify\.site|\bnode\b/i',
);

/** The words a reader (or a reviewer) can see in a page: text, the
 *  attributes that carry words, and HTML comments. */
function nxc_words($html)
{
    $comments = preg_match_all('/<!--(.*?)-->/s', $html, $cm) ? implode(' ', $cm[1]) : '';
    $attrs = preg_match_all('/\b(?:content|alt|aria-label|title|placeholder)="([^"]*)"/i', $html, $am) ? implode(' ', $am[1]) : '';
    $body = preg_replace('#<(style|script)\b[^>]*>.*?</\1>#is', ' ', $html);
    $text = html_entity_decode(strip_tags($body), ENT_QUOTES, 'UTF-8');
    return preg_replace('/\s+/', ' ', $text . ' ' . html_entity_decode($attrs, ENT_QUOTES, 'UTF-8') . ' ' . $comments);
}

/* Where each form must post. Written out literally rather than derived from
 * the site's own nx_form_url(), because a check that asks the code under
 * test what the right answer is cannot catch the code being wrong. */
$forms = array(
    'contact' => array('en' => '/contact/', 'fa' => '/fa/contact/'),
    'reseller' => array('en' => '/reseller/', 'fa' => '/fa/reseller/'),
    'delete-account' => array('en' => '/delete-account/', 'fa' => '/fa/delete-account/'),
);

$htmlDir = null;
$argv = isset($argv) ? $argv : array();
$i = array_search('--html', $argv, true);
if ($i !== false && isset($argv[$i + 1])) {
    $htmlDir = rtrim($argv[$i + 1], '/\\');
}

$failures = array();
$titles = array();
$checked = 0;

foreach ($locales as $locale) {
    foreach ($pages as $page => $segment) {
        if (isset($oneLocale[$page]) && $oneLocale[$page] !== $locale) {
            continue;
        }
        $label = sprintf('[%s/%s]', $locale, $page);
        $isNoindex = in_array($page, $noindexPages, true);

        if ($htmlDir !== null) {
            $file = $htmlDir . '/' . $locale . '-' . $page . '.html';
            if (!is_file($file)) {
                $failures[] = $label . ' no rendered file at ' . $file;
                continue;
            }
            $html = file_get_contents($file);
        } else {
            $entry = rtrim($root . '/' . ($locale === 'en' ? '' : 'fa/') . $segment, '/') . '/index.php';
            if (!is_file($entry)) {
                $failures[] = $label . ' missing entry file: ' . $entry;
                continue;
            }
            // A child process per page: the pages define the same functions,
            // and it is the only way to catch a fatal in one page alone.
            $html = shell_exec(escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg($entry) . ' 2>&1');
        }

        $checked++;
        if ($html === null || trim($html) === '') {
            $failures[] = $label . ' rendered nothing at all';
            continue;
        }

        // 1. Untranslated keys -- the exact bug this file was written for.
        if (preg_match_all('/⟪([^⟫]+)⟫/u', $html, $m)) {
            foreach (array_unique($m[1]) as $key) {
                $failures[] = $label . ' untranslated key: ' . $key;
            }
        }

        // 2. PHP diagnostics leaking into the page.
        if (preg_match('/\b(Fatal error|Parse error|Warning|Notice|Deprecated)\b:/', $html, $m)) {
            $failures[] = $label . ' PHP ' . $m[1] . ' in output';
        }

        // 3. The document itself: language and direction.
        $dir = $locale === 'fa' ? 'rtl' : 'ltr';
        if (strpos($html, '<html lang="' . $locale . '" dir="' . $dir . '"') === false) {
            $failures[] = $label . ' <html> does not declare lang="' . $locale . '" dir="' . $dir . '"';
        }

        // 4. Title: present, not too long, unique across the site.
        if (!preg_match('/<title>(.+?)<\/title>/s', $html, $m) || trim($m[1]) === '') {
            $failures[] = $label . ' empty or missing <title>';
        } else {
            $t = trim($m[1]);
            if (nxc_len($t) > 60) {
                $failures[] = $label . ' <title> is ' . nxc_len($t) . ' chars, over the ~60 a search result shows before cutting it';
            }
            if (isset($titles[$t])) {
                $failures[] = $label . ' duplicate <title>, same as ' . $titles[$t];
            }
            $titles[$t] = $label;
        }

        // 5. Meta description.
        if (!preg_match('/<meta name="description" content="(.*?)"/s', $html, $m) || trim($m[1]) === '') {
            $failures[] = $label . ' empty or missing meta description';
        } elseif (nxc_len(trim($m[1])) > 160) {
            $failures[] = $label . ' meta description is ' . nxc_len(trim($m[1])) . ' chars, over the ~160 a search result shows';
        }

        // 6. Exactly one h1.
        $h1 = preg_match_all('/<h1[\s>]/i', $html);
        if ($h1 !== 1) {
            $failures[] = $label . ' has ' . $h1 . ' <h1> elements, expected exactly 1';
        }

        // 7a. A noindex page: says so, and claims nothing an indexed page
        //     would (canonical, alternates, structured data). Then the
        //     ads page's word rules, and on to the remaining checks.
        if ($isNoindex) {
            if (strpos($html, '<meta name="robots" content="noindex') === false) {
                $failures[] = $label . ' not marked noindex';
            }
            foreach (array('<link rel="canonical"', '<link rel="alternate" hreflang=', 'application/ld+json') as $needle) {
                if (strpos($html, $needle) !== false) {
                    $failures[] = $label . ' noindex page carries ' . $needle;
                }
            }
            if (in_array($page, $adsPages, true)) {
                $words = nxc_words($html);
                foreach ($adsForbidden as $re) {
                    if (preg_match_all($re, $words, $hit, PREG_OFFSET_CAPTURE)) {
                        foreach ($hit[0] as $h) {
                            $failures[] = $label . ' forbidden on the ads page: "' . $h[0] . '" in "...'
                                . trim(substr($words, max(0, $h[1] - 40), 90)) . '..."';
                        }
                    }
                }
                if (strpos($html, 'og:image') !== false) {
                    $failures[] = $label . ' carries the site\'s social card (its text is the home page\'s message)';
                }
            }
        }

        // 7. Canonical and both hreflang alternates plus x-default, and the
        //    social card for this locale.
        if ($isNoindex) {
            // covered above
        } elseif (strpos($html, '<link rel="canonical"') === false) {
            $failures[] = $label . ' no canonical link';
        }
        foreach ($isNoindex ? array() : array('en', 'fa', 'x-default') as $alt) {
            if (strpos($html, 'hreflang="' . $alt . '"') === false) {
                $failures[] = $label . ' missing hreflang="' . $alt . '"';
            }
        }
        if (!$isNoindex && !preg_match('#<meta property="og:image" content="https://[^"]+/og-' . $locale . '-v\d+\.(?:png|jpg)">#', $html)) {
            $failures[] = $label . ' og:image is not this locale\'s social card';
        }

        // 8. Structured data must parse.
        if (preg_match('/<script type="application\/ld\+json">(.*?)<\/script>/s', $html, $m)) {
            json_decode($m[1]);
            if (json_last_error() !== JSON_ERROR_NONE) {
                $failures[] = $label . ' invalid JSON-LD: ' . json_last_error_msg();
            }
        } elseif (!$isNoindex) {
            $failures[] = $label . ' no JSON-LD';
        }

        // 8b. The ads landing page is reached only from the ads: no other
        //     page links to it (the navigation, the footer).
        if (!in_array($page, $adsPages, true) && strpos($html, 'vpn-app') !== false) {
            $failures[] = $label . ' links to the ads landing page';
        }

        // 9. Images: dimensions and an alt decision.
        if (preg_match_all('/<img\b[^>]*>/i', $html, $imgs)) {
            foreach ($imgs[0] as $img) {
                if (!preg_match('/\balt=/i', $img)) {
                    $failures[] = $label . ' <img> with no alt attribute: ' . nxc_cut($img, 80);
                }
                if (!preg_match('/\bwidth=/i', $img) || !preg_match('/\bheight=/i', $img)) {
                    $failures[] = $label . ' <img> without width/height (layout shift): ' . nxc_cut($img, 80);
                }
            }
        }

        // 10. The CSP allows exactly ONE inline <style> (the page's inlined
        //     stylesheet) and ONE inline script (the loader), each by its
        //     SHA-256. A second one, or any style="" attribute, renders
        //     locally and is silently blocked in production.
        if (preg_match('/<[a-z][^>]*\sstyle=/i', $html)) {
            $failures[] = $label . ' inline style attribute -- blocked by the CSP';
        }
        if (preg_match_all('/<style[\s>]/i', $html) !== 1) {
            $failures[] = $label . ' expected exactly one <style> element';
        }
        $inlineScripts = preg_match_all('/<script(?![^>]*\bsrc=)(?![^>]*type="application\/ld\+json")[^>]*>/i', $html);
        if ($inlineScripts !== 1) {
            $failures[] = $label . ' ' . $inlineScripts . ' inline scripts, expected exactly one (the loader)';
        }
        if (preg_match('/<link[^>]+rel="stylesheet"/i', $html)) {
            $failures[] = $label . ' a stylesheet <link> -- render-blocking; CSS is inlined on purpose';
        }

        // 11. Nothing loads from another origin. Canonical, hreflang and
        //     Open Graph URLs are absolute by necessity and are not loads.
        if (preg_match_all('/<(?:script|img|iframe|source|link)\b[^>]*\b(?:src|href)="(https?:)?\/\/[^"]*"[^>]*>/i', $html, $ext)) {
            foreach ($ext[0] as $tag) {
                if (preg_match('/rel="(canonical|alternate)"/', $tag)) {
                    continue;
                }
                $failures[] = $label . ' loads from another origin: ' . nxc_cut($tag, 100);
            }
        }

        // 12. Every font preloaded is one the inlined CSS actually asks for,
        //     at the same URL -- or it downloads twice.
        if (preg_match_all('/<link rel="preload" href="([^"]+)" as="font"/', $html, $pre)) {
            foreach ($pre[1] as $href) {
                if (strpos($html, 'url(' . $href . ')') === false) {
                    $failures[] = $label . ' preloaded font not used by the inline CSS: ' . $href;
                }
            }
        } else {
            $failures[] = $label . ' no font preload';
        }

        // 13. Forms post where they live. The deletion form once posted to
        //     the home page and every request was discarded.
        if (isset($forms[$page])) {
            $want = $forms[$page][$locale];
            if (!preg_match_all('/<form\b[^>]*\baction="([^"]*)"/i', $html, $fm) || count($fm[1]) !== 1) {
                $failures[] = $label . ' expected exactly one <form>';
            } elseif ($fm[1][0] !== $want) {
                $failures[] = $label . ' form posts to "' . $fm[1][0] . '", expected "' . $want . '"';
            }
            if (strpos($html, 'name="_token"') === false) {
                $failures[] = $label . ' form has no CSRF token';
            }
            if (strpos($html, 'name="company_website"') === false) {
                $failures[] = $label . ' form has no honeypot';
            }
        }
    }
}

// The ads landing page sends a phone straight to its store, and nobody else.
// The store link is what the ads tag counts as a download, so a phone whose
// button quietly went back to /download/ would also stop being counted
// there; and a desktop sent to a phone store would have nothing to install.
if ($htmlDir === null) {
    $adsEntry = $root . '/vpn-app/index.php';
    $play = 'href="https://play.google.com/store/apps/details';
    $appStore = 'href="https://apps.apple.com/';
    $adsVisitors = array(
        'android' => array('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36', 2, 0),
        'iphone' => array('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', 0, 2),
        'windows' => array('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 0, 0),
        'ipad-as-mac' => array('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 0, 0),
        'no-agent' => array('', 0, 0),
    );
    foreach ($adsVisitors as $who => $want) {
        putenv('HTTP_USER_AGENT' . ($want[0] === '' ? '' : '=' . $want[0]));
        $html = (string) shell_exec(escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg($adsEntry) . ' 2>&1');
        $label = '[en/vpn-app as ' . $who . ']';
        if (strpos($html, '</html>') === false) {
            $failures[] = $label . ' did not render';
            continue;
        }
        $gotPlay = substr_count($html, $play);
        $gotStore = substr_count($html, $appStore);
        if ($gotPlay !== $want[1] || $gotStore !== $want[2]) {
            $failures[] = $label . ' store buttons: Google Play ' . $gotPlay . ' (want ' . $want[1]
                . '), App Store ' . $gotStore . ' (want ' . $want[2] . ')';
        }
        // Everyone keeps a way to the full download page.
        if (!preg_match('#<a class="btn btn--primary btn--lg" href="[^"]*/download/"#', $html)) {
            $failures[] = $label . ' the button under the list of devices no longer leads to the download page';
        }
        $words = nxc_words($html);
        foreach ($adsForbidden as $re) {
            if (preg_match($re, $words, $hit)) {
                $failures[] = $label . ' forbidden on the ads page: "' . $hit[0] . '"';
            }
        }
    }
    putenv('HTTP_USER_AGENT');
}

// The sitemap must not list a noindex page.
if ($htmlDir === null) {
    $xml = shell_exec(escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg($root . '/sitemap.php') . ' 2>&1');
    if ($xml === null || strpos($xml, '<urlset') === false) {
        $failures[] = '[sitemap] did not render';
    } else {
        foreach ($noindexPages as $page) {
            if (strpos($xml, '/' . $pages[$page]) !== false) {
                $failures[] = '[sitemap] lists the noindex page ' . $page;
            }
        }
    }
}

echo 'Checked ' . $checked . " page renders.\n";

if ($failures) {
    echo "\nFAILED (" . count($failures) . "):\n";
    foreach ($failures as $f) {
        echo '  - ' . $f . "\n";
    }
    exit(1);
}

echo "All clean.\n";
exit(0);
