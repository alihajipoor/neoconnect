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
 * @param string $name
 * @param string $class optional CSS class
 * @return string SVG markup, safe to echo directly
 */
function nx_icon($name, $class = '')
{
    $paths = array(

        // Brand mark -- filled rather than stroked, so it reads as a solid
        // glyph inside the gradient tile.
        'zap' => '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',

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
    );

    if (!isset($paths[$name])) {
        return '';
    }

    // The brand mark is the one filled icon; everything else is a stroked
    // outline at the Lucide default weight.
    $isFilled = $name === 'zap';

    $attrs = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" '
        . ($isFilled
            ? 'fill="currentColor" stroke="none"'
            : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"')
        . ' aria-hidden="true" focusable="false"';

    if ($class !== '') {
        $attrs .= ' class="' . nx_esc($class) . '"';
    }

    return '<svg ' . $attrs . '>' . $paths[$name] . '</svg>';
}
