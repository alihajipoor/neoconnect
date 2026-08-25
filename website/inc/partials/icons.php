<?php
/**
 * Inline SVG icons.
 *
 * Inlined rather than loaded from a sprite or an icon font on purpose: it is
 * one fewer request, it cannot be blocked, and it inherits currentColor so
 * icons pick up whatever the surrounding component is doing. The shapes match
 * the Lucide set the admin panel already uses, so the two surfaces look
 * related.
 *
 * Icons here are decorative. Callers mark them aria-hidden and put the real
 * meaning in adjacent text.
 */

defined('NX') || exit;

/**
 * The brand mark: a broken ring around a solid centre, in the violet-to-cyan
 * gradient. It deliberately echoes the circular Connect control at the centre
 * of the desktop app.
 *
 * Each call mints a unique gradient id. Inlining the same SVG several times on
 * one page would otherwise repeat an id, which is invalid HTML and leaves the
 * rendering at the mercy of which duplicate the browser resolves first.
 *
 * @param string $class CSS class for the <svg>
 * @return string
 */
function nx_logo_mark($class = '')
{
    static $seq = 0;
    $seq++;
    $id = 'nx-brand-' . $seq;

    // Explicit size, like the other two emitters: CSS scales it per
    // component, but a bare inline SVG with only a viewBox has no intrinsic
    // size and will otherwise fill whatever box it lands in.
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"'
        . ' width="28" height="28" fill="none"'
        . ($class !== '' ? ' class="' . nx_esc($class) . '"' : '')
        . ' aria-hidden="true" focusable="false">'
        . '<defs><linearGradient id="' . $id . '" x1="0" y1="0" x2="1" y2="1">'
        . '<stop offset="0" stop-color="#8b5cf6"/>'
        . '<stop offset="1" stop-color="#22d3ee"/>'
        . '</linearGradient></defs>'
        // r=21 gives a circumference of ~132, so 96 on / 36 off is exactly
        // one stroke and one gap -- change the radius and this must change
        // with it or the gap multiplies.
        . '<circle cx="32" cy="32" r="21" stroke="url(#' . $id . ')" stroke-width="7"'
        . ' stroke-linecap="round" stroke-dasharray="96 36"'
        . ' transform="rotate(-58 32 32)"/>'
        . '<circle cx="32" cy="32" r="8" fill="url(#' . $id . ')"/>'
        . '</svg>';
}

/**
 * Platform glyphs for the download page.
 *
 * Kept apart from nx_icon() because these are solid brand marks rather than
 * stroked UI icons -- they need fill, not stroke, and mixing them into the
 * same set would mean one of the two rendering wrongly.
 *
 * Used nominatively, to say which platform a download is for. That is what
 * they are for, and it is what visitors scan the page looking for.
 *
 * @param string $name  windows | android | apple
 * @param string $class
 * @return string
 */
function nx_platform_icon($name, $class = '')
{
    $paths = array(

        // Four panes, the modern Windows mark.
        'windows' => '<path d="M3 5.6 10.2 4.6v6.9H3zM11.4 4.4 21 3v8.5h-9.6zM3 12.5h7.2v6.9L3 18.4zM11.4 12.5H21V21l-9.6-1.4z"/>',

        // Android robot head: dome, antennae, two eyes knocked out.
        'android' => '<path d="M6.8 8.1c-.5 0-.9.4-.9.9v6.4c0 .5.4.9.9.9h10.4c.5 0 .9-.4.9-.9V9c0-.5-.4-.9-.9-.9z"/>'
            . '<path d="M4.1 9.6c-.6 0-1.1.5-1.1 1.1v3.6c0 .6.5 1.1 1.1 1.1s1.1-.5 1.1-1.1v-3.6c0-.6-.5-1.1-1.1-1.1zM19.9 9.6c-.6 0-1.1.5-1.1 1.1v3.6c0 .6.5 1.1 1.1 1.1s1.1-.5 1.1-1.1v-3.6c0-.6-.5-1.1-1.1-1.1z"/>'
            . '<path d="M8.6 17.1v2.4c0 .6.5 1.1 1.1 1.1s1.1-.5 1.1-1.1v-2.4zM13.2 17.1v2.4c0 .6.5 1.1 1.1 1.1s1.1-.5 1.1-1.1v-2.4z"/>'
            . '<path d="M15.9 4.6l.9-1.6a.2.2 0 0 0-.1-.3.2.2 0 0 0-.3.1l-.9 1.7a6.6 6.6 0 0 0-5 0l-.9-1.7a.2.2 0 0 0-.3-.1.2.2 0 0 0-.1.3l.9 1.6A5 5 0 0 0 7.3 7.4h9.4a5 5 0 0 0-2.8-3zM10 6.2a.5.5 0 1 1 0-1 .5.5 0 0 1 0 1zm4 0a.5.5 0 1 1 0-1 .5.5 0 0 1 0 1z"/>',

        // Apple mark, used for both macOS and iOS.
        'apple' => '<path d="M16.4 12.6c0-2.2 1.8-3.3 1.9-3.4-1-1.5-2.6-1.7-3.2-1.7-1.4-.1-2.7.8-3.3.8-.7 0-1.7-.8-2.8-.8-1.5 0-2.8.8-3.6 2.1-1.5 2.6-.4 6.5 1.1 8.6.7 1 1.6 2.2 2.7 2.2 1.1 0 1.5-.7 2.8-.7 1.3 0 1.6.7 2.8.7 1.2 0 1.9-1 2.6-2.1.8-1.2 1.2-2.4 1.2-2.5 0 0-2.2-.9-2.2-3.2zM14.2 5.9c.6-.7 1-1.7.9-2.7-.9 0-1.9.6-2.5 1.3-.6.6-1 1.6-.9 2.6 1 .1 2-.5 2.5-1.2z"/>',
    );

    if (!isset($paths[$name])) {
        return '';
    }

    // Explicit size for the same reason as nx_icon(): a viewBox alone gives
    // an inline SVG no intrinsic size at all.
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"'
        . ' width="40" height="40"'
        . ' fill="currentColor" stroke="none"'
        . ' class="icon icon--platform' . ($class !== '' ? ' ' . nx_esc($class) : '') . '"'
        . ' aria-hidden="true" focusable="false">' . $paths[$name] . '</svg>';
}

/**
 * @param string $name
 * @param string $class optional CSS class
 * @return string SVG markup, safe to echo directly
 */
function nx_icon($name, $class = '')
{
    $paths = array(

        'globe' => '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/>'
            . '<path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',

        'menu' => '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',

        'close' => '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',

        'check' => '<path d="M20 6 9 17l-5-5"/>',

        // Added for the 2026-08 rebuild: the callout component needs a
        // distinct glyph per severity, and the protocol table needs a
        // "not available" mark that is not just a smaller close button.
        'info' => '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/>'
            . '<path d="M12 8h.01"/>',

        'alert' => '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>'
            . '<path d="M12 9v4"/><path d="M12 17h.01"/>',

        'minus' => '<path d="M5 12h14"/>',

        'shuffle' => '<path d="M16 3h5v5"/><path d="M4 20 21 3"/>'
            . '<path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/>',

        'arrow-right' => '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',

        'download' => '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>'
            . '<path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',

        'shield' => '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',

        'layers' => '<path d="m12 2 10 5-10 5L2 7l10-5z"/><path d="m2 17 10 5 10-5"/>'
            . '<path d="m2 12 10 5 10-5"/>',

        'route' => '<circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/>'
            . '<path d="M9 19h4a4 4 0 0 0 4-4V9a4 4 0 0 1 4-4"/>',

        'activity' => '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',

        'map-pin' => '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/>'
            . '<circle cx="12" cy="10" r="3"/>',

        'chart' => '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/>'
            . '<path d="M8 17v-4"/>',

        'monitor' => '<rect x="2" y="3" width="20" height="14" rx="2"/>'
            . '<path d="M8 21h8"/><path d="M12 17v4"/>',

        'smartphone' => '<rect x="5" y="2" width="14" height="20" rx="2"/>'
            . '<path d="M12 18h.01"/>',

        'laptop' => '<path d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v11H3z"/>'
            . '<path d="M2 20h20"/>',

        'mail' => '<rect x="2" y="4" width="20" height="16" rx="2"/>'
            . '<path d="m2 7 10 6 10-6"/>',

        'users' => '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>'
            . '<circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>',

        'lock' => '<rect x="3" y="11" width="18" height="11" rx="2"/>'
            . '<path d="M7 11V7a5 5 0 0 1 10 0v4"/>',

        'server' => '<rect x="2" y="3" width="20" height="8" rx="2"/>'
            . '<rect x="2" y="13" width="20" height="8" rx="2"/>'
            . '<path d="M6 7h.01"/><path d="M6 17h.01"/>',

        'shield-check' => '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'
            . '<path d="m9 12 2 2 4-4"/>',

        'message' => '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',

        'refresh' => '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',

        'ticket' => '<path d="M3 9V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4z"/>'
            . '<path d="M13 5v14"/>',

        'file-off' => '<path d="M14 2v6h6"/>'
            . '<path d="M15.5 22H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8l6 6v4"/>'
            . '<path d="m17 17 4 4"/><path d="m21 17-4 4"/>',
    );

    if (!isset($paths[$name])) {
        return '';
    }

    // Every icon here is a stroked outline at the Lucide default weight. The
    // brand mark is not one of these -- it has its own gradient and lives in
    // nx_logo_mark() above.
    /* width/height AND the .icon class, always.
       An inline <svg> with only a viewBox has no intrinsic size: as a flex
       item it resolves to the container's width, and as a block it falls
       back to the SVG default of 300x150. Both were happening -- the alert
       glyph beside the unsigned-installer warning measured 331x331 and
       squeezed the sentence next to it down to nothing.

       The attributes give it a correct size before any CSS loads (so there
       is no first-paint jump), and the class lets the stylesheet scale it
       per component with `width:1em` or an explicit size. */
    $attrs = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"'
        . ' width="18" height="18"'
        . ' fill="none" stroke="currentColor" stroke-width="2"'
        . ' stroke-linecap="round" stroke-linejoin="round"'
        . ' aria-hidden="true" focusable="false"'
        . ' class="icon' . ($class !== '' ? ' ' . nx_esc($class) : '') . '"';

    return '<svg ' . $attrs . '>' . $paths[$name] . '</svg>';
}


// ---------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------

/**
 * A country flag as inline SVG.
 *
 * NOT the regional-indicator emoji nx_flag() produces, and that is the whole
 * point: Windows ships no flag emoji font at all. Every 🇫🇮 on this site
 * renders there as the bare letters "FI" in a box -- on the platform the
 * desktop client targets, which is to say most of the audience. macOS and
 * most phones show the flag; Windows shows nothing useful, and it looks
 * broken rather than deliberate.
 *
 * Drawn on a 3x2 viewBox so every flag is the same aspect ratio and can be
 * clipped to a rounded rectangle by CSS. These are simplified: a tricolour
 * or a bicolour with the one distinguishing element, at 2.2rem wide, where
 * a faithful coat of arms would be an unreadable smudge and several
 * kilobytes each.
 *
 * Falls back to the emoji for a country not drawn here, so adding a location
 * to inc/content/locations.php degrades rather than breaks.
 *
 * @param string $code ISO 3166-1 alpha-2, any case
 * @return string inline <svg>, or the emoji fallback
 */
function nx_flag_svg($code)
{
    $code = strtoupper(trim((string) $code));

    $flags = array(
        'FI' => '<rect width="3" height="2" fill="#fff"/>'
              . '<rect y=".75" width="3" height=".5" fill="#003580"/>'
              . '<rect x=".9" width=".5" height="2" fill="#003580"/>',

        'FR' => '<rect width="1" height="2" fill="#002654"/>'
              . '<rect x="1" width="1" height="2" fill="#fff"/>'
              . '<rect x="2" width="1" height="2" fill="#ce1126"/>',

        'DE' => '<rect width="3" height=".667" fill="#000"/>'
              . '<rect y=".667" width="3" height=".667" fill="#dd0000"/>'
              . '<rect y="1.334" width="3" height=".666" fill="#ffce00"/>',

        'SG' => '<rect width="3" height="1" fill="#ed2939"/>'
              . '<rect y="1" width="3" height="1" fill="#fff"/>'
              . '<circle cx=".62" cy=".5" r=".3" fill="#fff"/>'
              . '<circle cx=".74" cy=".5" r=".3" fill="#ed2939"/>',

        'TR' => '<rect width="3" height="2" fill="#e30a17"/>'
              . '<circle cx="1.1" cy="1" r=".45" fill="#fff"/>'
              . '<circle cx="1.24" cy="1" r=".36" fill="#e30a17"/>',

        'IR' => '<rect width="3" height=".667" fill="#239f40"/>'
              . '<rect y=".667" width="3" height=".666" fill="#fff"/>'
              . '<rect y="1.333" width="3" height=".667" fill="#da0000"/>',
    );

    if (!isset($flags[$code])) {
        return nx_flag($code);
    }

    return '<svg class="fl" viewBox="0 0 3 2" preserveAspectRatio="none"'
        . ' aria-hidden="true" focusable="false">' . $flags[$code] . '</svg>';
}


// ---------------------------------------------------------------------
// Signal traces
// ---------------------------------------------------------------------

/**
 * A deterministic pseudo-random signal trace, as an SVG path `d`.
 *
 * Drawn in PHP rather than JS so the waveform is in the markup and survives
 * with scripting off. Deterministic on purpose: a trace that reshuffled on
 * every page load would read as data changing, and none of this is data.
 * Purely decorative -- every SVG carrying one is aria-hidden.
 *
 * Lives here, beside the other drawing helpers, rather than in the
 * instrument partial: the specimen cards on the home page use it too, and
 * that partial returns early when there is no protocol data, which would
 * leave the function undefined exactly when the page still needs it.
 *
 * @param int    $seed
 * @param int    $w
 * @param int    $h
 * @param string $kind pulse | tls | noise | regular
 * @return string
 */
function nx_signal_path($seed, $w, $h, $kind)
{
    $s = $seed;
    $points = array();
    $n = 48;

    for ($i = 0; $i < $n; $i++) {
        // Linear congruential generator: same constants the design used, so
        // the shapes match it exactly.
        $s = ($s * 1103515245 + 12345) & 0x7fffffff;
        $r = $s / 0x7fffffff;

        $x = $i / ($n - 1) * $w;

        if ($kind === 'regular') {
            $y = $h / 2 + sin($i * 0.72) * $h * 0.34 + ($r - 0.5) * $h * 0.05;
        } elseif ($kind === 'pulse') {
            $y = $h / 2 + (($i % 7 < 2) ? $h * 0.36 : -$h * 0.10) + ($r - 0.5) * $h * 0.06;
        } elseif ($kind === 'tls') {
            $y = $h / 2 + sin($i * 0.42) * $h * 0.16 + ($r - 0.5) * $h * 0.30;
        } else {
            $y = $h / 2 + ($r - 0.5) * $h * 0.86;
        }

        $points[] = number_format($x, 1, '.', '') . ',' . number_format($y, 1, '.', '');
    }

    return 'M' . implode(' L', $points);
}

/**
 * The gradient definitions every decorative SVG on the page refers to.
 *
 * Emitted ONCE near the top of <body> by head.php, in a zero-size SVG, so
 * that `stroke="url(#nx-beam)"` resolves anywhere in the document. Defining
 * them inside the component that happens to be first would make every other
 * component depend on that one rendering -- which is how the specimen cards
 * lost their traces the first time round.
 *
 * @return string
 */
function nx_svg_defs()
{
    return '<svg width="0" height="0" class="sr-only" aria-hidden="true" focusable="false"><defs>'
        . '<linearGradient id="nx-brand-grad" x1="0" y1="0" x2="1" y2="1">'
        . '<stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#22d3ee"/>'
        . '</linearGradient>'
        . '<linearGradient id="nx-beam" x1="0" y1="0" x2="1" y2="0">'
        . '<stop offset="0" stop-color="#6D3AE8"/><stop offset="1" stop-color="#0A6E82"/>'
        . '</linearGradient>'
        . '<linearGradient id="nx-orb" x1="0" y1="0" x2="1" y2="1">'
        . '<stop offset="0" stop-color="#10b981"/><stop offset="1" stop-color="#22d3ee"/>'
        . '</linearGradient>'
        . '</defs></svg>';
}


// ---------------------------------------------------------------------
// Language switch
// ---------------------------------------------------------------------

/**
 * The language switch, as a two-option group.
 *
 * Deliberately NOT a single "فارسی" link to the other locale. Two options,
 * with the current one marked aria-current, means a visitor can see which
 * language they are on as well as which one they can move to -- and a
 * screen reader announces it as a choice rather than as an unexplained
 * foreign word.
 *
 * Both options are real links to real per-locale URLs, so this works with
 * scripting off. The inactive one carries ?setlang, which is what records
 * the preference cookie and stops the automatic redirect from overriding
 * the choice on the next page.
 *
 * It links to THE SAME PAGE in the other language, never to the home page.
 *
 * @param string $class extra classes for the wrapper
 * @return string
 */
function nx_lang_switch($class = '')
{
    $out = '<div class="lang-switch' . ($class !== '' ? ' ' . nx_esc($class) : '') . '"'
        . ' role="group" aria-label="' . nx_e('lang.switch_label') . '">';

    $labels = array('en' => 'EN', 'fa' => 'فا');

    foreach (array('en', 'fa') as $code) {
        $isCurrent = ($code === nx_locale());
        $label = '<span lang="' . $code . '">' . nx_esc($labels[$code]) . '</span>'
            . '<span class="sr-only">' . nx_e('lang.' . $code) . '</span>';

        if ($isCurrent) {
            // A link to the page you are already on is noise in the tab
            // order; render the current language as plain text.
            $out .= '<span class="lang-switch__opt is-current" aria-current="true">'
                . $label . '</span>';
        } else {
            $out .= '<a class="lang-switch__opt" href="' . nx_esc(nx_switch_url()) . '"'
                . ' lang="' . $code . '" hreflang="' . $code . '">' . $label . '</a>';
        }
    }

    return $out . '</div>';
}
