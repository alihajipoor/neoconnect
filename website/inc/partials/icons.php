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

    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none"'
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
    $attrs = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"'
        . ' fill="none" stroke="currentColor" stroke-width="2"'
        . ' stroke-linecap="round" stroke-linejoin="round"'
        . ' aria-hidden="true" focusable="false"';

    if ($class !== '') {
        $attrs .= ' class="' . nx_esc($class) . '"';
    }

    return '<svg ' . $attrs . '>' . $paths[$name] . '</svg>';
}
