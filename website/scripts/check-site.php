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
);

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
        $label = sprintf('[%s/%s]', $locale, $page);

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
            if (nxc_len($t) > 70) {
                $failures[] = $label . ' <title> is ' . nxc_len($t) . ' chars, over the ~70 that render in a result';
            }
            if (isset($titles[$t])) {
                $failures[] = $label . ' duplicate <title>, same as ' . $titles[$t];
            }
            $titles[$t] = $label;
        }

        // 5. Meta description.
        if (!preg_match('/<meta name="description" content="(.*?)"/s', $html, $m) || trim($m[1]) === '') {
            $failures[] = $label . ' empty or missing meta description';
        } elseif (nxc_len(trim($m[1])) > 165) {
            $failures[] = $label . ' meta description is ' . nxc_len(trim($m[1])) . ' chars, over the ~165 that render';
        }

        // 6. Exactly one h1.
        $h1 = preg_match_all('/<h1[\s>]/i', $html);
        if ($h1 !== 1) {
            $failures[] = $label . ' has ' . $h1 . ' <h1> elements, expected exactly 1';
        }

        // 7. Canonical and both hreflang alternates plus x-default, and the
        //    social card for this locale.
        if (strpos($html, '<link rel="canonical"') === false) {
            $failures[] = $label . ' no canonical link';
        }
        foreach (array('en', 'fa', 'x-default') as $alt) {
            if (strpos($html, 'hreflang="' . $alt . '"') === false) {
                $failures[] = $label . ' missing hreflang="' . $alt . '"';
            }
        }
        if (!preg_match('#<meta property="og:image" content="https://[^"]+/og-' . $locale . '-v\d+\.png">#', $html)) {
            $failures[] = $label . ' og:image is not this locale\'s social card';
        }

        // 8. Structured data must parse.
        if (preg_match('/<script type="application\/ld\+json">(.*?)<\/script>/s', $html, $m)) {
            json_decode($m[1]);
            if (json_last_error() !== JSON_ERROR_NONE) {
                $failures[] = $label . ' invalid JSON-LD: ' . json_last_error_msg();
            }
        } else {
            $failures[] = $label . ' no JSON-LD';
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
