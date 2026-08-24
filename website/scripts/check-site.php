<?php
/**
 * Pre-deploy check for the Neoxify website.
 *
 * WHY THIS EXISTS. On 2026-08-24 the live site was serving
 *
 *     <title>⟪meta.delete-account.title⟫</title>
 *
 * on two pages, in both languages, and had been for months. The page had
 * body copy; nobody had added its meta.* pair; nx_t() renders a missing key
 * visibly, exactly as designed -- and nothing ever looked at a rendered
 * <title>. A missing string is not a subtle bug, it just needs something to
 * be looking.
 *
 * This renders every page in every locale into a buffer and fails on
 * anything that should never reach a visitor. It needs no web server and no
 * network: it is the same include path a real request takes.
 *
 *     php scripts/check-site.php
 *
 * Exit code 0 if clean, 1 if anything failed -- so it can gate a deploy.
 */

// Rendering many pages in one process means many require calls into files
// that all define the same functions. Each page render therefore happens in
// a child process, which is also the only way to catch a fatal error in one
// page without losing the whole run.

$root = dirname(__DIR__);

/**
 * UTF-8 character count and substring, without mbstring.
 *
 * inc/bootstrap.php goes out of its way not to require the mbstring
 * extension -- shared hosting does not always have it, and the live PHP
 * used to check this very file did not. A check script that needs a
 * heavier runtime than the thing it is checking is a check nobody can run.
 */
function nxc_len($s)
{
    return preg_match_all('/./us', $s);
}

function nxc_cut($s, $n)
{
    if (preg_match('/^.{0,' . (int) $n . '}/us', $s, $m)) {
        return $m[0];
    }
    return $s;
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

$failures = array();
$checked = 0;

foreach ($locales as $locale) {
    foreach ($pages as $page => $segment) {
        $dir = $root . '/' . ($locale === 'en' ? '' : 'fa/') . $segment;
        $entry = rtrim($dir, '/') . '/index.php';

        if (!is_file($entry)) {
            $failures[] = sprintf('[%s/%s] missing entry file: %s', $locale, $page, $entry);
            continue;
        }

        $checked++;

        // Render in a child process. escapeshellarg on the path because
        // Windows dev checkouts live under "Local Settings" style paths with
        // spaces in them.
        $cmd = escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg($entry) . ' 2>&1';
        $html = shell_exec($cmd);

        if ($html === null || trim($html) === '') {
            $failures[] = sprintf('[%s/%s] rendered nothing at all', $locale, $page);
            continue;
        }

        $label = sprintf('[%s/%s]', $locale, $page);

        // 1. Untranslated keys. The exact bug this file was written for.
        if (preg_match_all('/⟪([^⟫]+)⟫/u', $html, $m)) {
            foreach (array_unique($m[1]) as $key) {
                $failures[] = $label . ' untranslated key: ' . $key;
            }
        }

        // 2. PHP diagnostics leaking into the page.
        if (preg_match('/\b(Fatal error|Parse error|Warning|Notice|Deprecated)\b:/', $html, $m)) {
            $failures[] = $label . ' PHP ' . $m[1] . ' in output';
        }

        // 3. A title is not optional, and an empty one is worse than a bad
        //    one because it looks fine in a browser tab.
        if (!preg_match('/<title>(.+?)<\/title>/s', $html, $m) || trim($m[1]) === '') {
            $failures[] = $label . ' empty or missing <title>';
        } elseif (nxc_len(trim($m[1])) > 70) {
            // Not fatal -- Google truncates rather than penalises -- but it
            // means the end of the title is not being read by anyone.
            $failures[] = $label . ' <title> is ' . nxc_len(trim($m[1]))
                . ' chars, over the ~70 that render in a result';
        }

        // 4. Meta description, same reasoning.
        if (!preg_match('/<meta name="description" content="(.*?)"/s', $html, $m)
            || trim($m[1]) === '') {
            $failures[] = $label . ' empty or missing meta description';
        } elseif (nxc_len(trim($m[1])) > 165) {
            $failures[] = $label . ' meta description is ' . nxc_len(trim($m[1]))
                . ' chars, over the ~165 that render';
        }

        // 5. Exactly one h1. Zero is a page with no stated subject; more
        //    than one is a page with several, and both confuse a crawler.
        $h1 = preg_match_all('/<h1[\s>]/i', $html);
        if ($h1 !== 1) {
            $failures[] = $label . ' has ' . $h1 . ' <h1> elements, expected exactly 1';
        }

        // 6. Canonical and both hreflang alternates plus x-default.
        if (strpos($html, '<link rel="canonical"') === false) {
            $failures[] = $label . ' no canonical link';
        }
        foreach (array('en', 'fa', 'x-default') as $alt) {
            if (strpos($html, 'hreflang="' . $alt . '"') === false) {
                $failures[] = $label . ' missing hreflang="' . $alt . '"';
            }
        }

        // 7. The structured data must parse. Invalid JSON-LD is worse than
        //    none: it is a machine-readable claim that cannot be read.
        if (preg_match('/<script type="application\/ld\+json">(.*?)<\/script>/s', $html, $m)) {
            json_decode($m[1]);
            if (json_last_error() !== JSON_ERROR_NONE) {
                $failures[] = $label . ' invalid JSON-LD: ' . json_last_error_msg();
            }
        }

        // 8. Every image needs dimensions and a decision about alt text.
        //    alt="" is a valid decision (decorative); a missing alt is not.
        if (preg_match_all('/<img\b[^>]*>/i', $html, $imgs)) {
            foreach ($imgs[0] as $img) {
                if (!preg_match('/\balt=/i', $img)) {
                    $failures[] = $label . ' <img> with no alt attribute: '
                        . nxc_cut($img, 80);
                }
                if (!preg_match('/\bwidth=/i', $img) || !preg_match('/\bheight=/i', $img)) {
                    $failures[] = $label . ' <img> without width/height (causes layout shift): '
                        . nxc_cut($img, 80);
                }
            }
        }

        // 9. The CSP in the server config forbids inline styles and scripts.
        //    A template that grows one renders fine locally and is silently
        //    dropped in production, which is the worst kind of failure.
        if (preg_match('/<[a-z][^>]*\sstyle=/i', $html)) {
            $failures[] = $label . ' inline style attribute -- blocked by the CSP in production';
        }
        if (preg_match('/<script(?![^>]*\bsrc=)(?![^>]*type="application\/ld\+json")/i', $html)) {
            $failures[] = $label . ' inline <script> -- blocked by the CSP in production';
        }
    }
}

echo "Checked " . $checked . " page renders.\n";

if ($failures) {
    echo "\nFAILED (" . count($failures) . "):\n";
    foreach ($failures as $f) {
        echo '  - ' . $f . "\n";
    }
    exit(1);
}

echo "All clean.\n";
exit(0);
