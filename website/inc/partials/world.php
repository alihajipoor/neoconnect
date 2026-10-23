<?php
/**
 * The dotted world with the server lights and the light lines between
 * them: the home hero's backdrop, the backdrop behind every page title,
 * and the map beside the location list.
 *
 * WHAT IT SAYS, AND ALL IT SAYS. A light is a country with servers in it
 * (inc/content/locations.php -- never a server's own position or address;
 * the anchors are one city per country, for display). The lines join the
 * lights west to east: they are drawing, not routes, and nothing here
 * claims a path a packet takes. Entry points are never drawn: a public map
 * of how traffic gets in helps a censor (owner, 2026-10-23). No light
 * ever blinks on/off as if something were measured -- a website has no
 * evidence about the visitor's network to light anything with.
 *
 * Always aria-hidden: the location list says the same thing in words.
 */

defined('NX') || exit;

/**
 * Light anchors, in percent of the map box (left, top). The same numbers
 * position the .lamp--xx classes in assets/css/base.css; change both.
 */
function nx_world_anchors()
{
    return array(
        'fi' => array(55.53, 11.42), 'fr' => array(50.57, 19.63), 'de' => array(52.09, 18.69),
        'tr' => array(57.38, 25.54), 'sg' => array(78.83, 55.93),
        'gb' => array(49.97, 17.66), 'nl' => array(51.16, 17.03), 'us' => array(31.13, 25.76),
        'ae' => array(64.93, 37.64),
    );
}

/**
 * A quadratic arc between two anchors, in the 200 x 82 map space, bowed
 * upward like a flight path.
 */
function nx_world_arc($a, $b)
{
    $ax = $a[0] * 2; $ay = $a[1] * 0.82;
    $bx = $b[0] * 2; $by = $b[1] * 0.82;
    $d = sqrt(($bx - $ax) * ($bx - $ax) + ($by - $ay) * ($by - $ay));
    $cx = ($ax + $bx) / 2;
    $cy = min($ay, $by) - max(2, $d * 0.2);
    $f = function ($n) { return rtrim(rtrim(number_format($n, 2, '.', ''), '0'), '.'); };
    return 'M' . $f($ax) . ' ' . $f($ay) . 'Q' . $f($cx) . ' ' . $f($cy) . ' ' . $f($bx) . ' ' . $f($by);
}

/**
 * @param string $variant hero | page | night (lights only, as stars) | plain (plain: lights, no lines --
 *                        and the one map you can explore: each light is
 *                        focusable, named, and shows its name on hover or
 *                        focus; the list beside it lights it too, site.js)
 * @return string
 */
function nx_world($variant = 'page')
{
    static $seq = 0;
    $seq++;

    $anchors = nx_world_anchors();
    $exits = array();
    $names = array();
    foreach (nx_locations() as $loc) {
        $c = strtolower($loc['code']);
        if (isset($anchors[$c])) {
            $exits[$c] = $anchors[$c];
            $names[$c] = nx_pick($loc['country']);
        }
    }

    $out = '';
    if ($variant !== 'plain' && $variant !== 'night' && count($exits) > 1) {
        // West to east, each light to the next.
        uasort($exits, function ($p, $q) { return $p[0] < $q[0] ? -1 : ($p[0] > $q[0] ? 1 : 0); });
        $pts = array_values($exits);
        $arcs = array();
        for ($i = 1; $i < count($pts); $i++) {
            $arcs[] = nx_world_arc($pts[$i - 1], $pts[$i]);
        }
        $gid = 'nx-link-' . $seq;
        $svg = '<svg class="links" viewBox="0 0 200 82" preserveAspectRatio="none" aria-hidden="true" focusable="false">'
            . '<defs><linearGradient id="' . $gid . '" gradientUnits="userSpaceOnUse" x1="96" y1="0" x2="160" y2="0">'
            . '<stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs>';
        foreach ($arcs as $d) {
            $svg .= '<path class="halo" d="' . $d . '"/>';
        }
        foreach ($arcs as $d) {
            $svg .= '<path class="line" stroke="url(#' . $gid . ')" d="' . $d . '"/>';
        }
        $out .= $svg . '</svg>';
    }

    foreach (array_keys($exits) as $c) {
        if ($variant === 'plain') {
            $out .= '<span class="lamp lamp--' . nx_esc($c) . '" data-cc="' . nx_esc($c) . '" tabindex="0" role="img" aria-label="'
                . nx_esc($names[$c]) . '"><span class="lamp__tip" aria-hidden="true">' . nx_esc($names[$c]) . '</span></span>';
        } else {
            $out .= '<span class="lamp lamp--' . nx_esc($c) . '"></span>';
        }
    }

    if ($variant === 'plain') {
        return '<div class="map map--explore" data-map>' . $out . '</div>';
    }
    $map = '<div class="map" aria-hidden="true">' . $out . '</div>';
    return '<div class="world world--' . nx_esc($variant) . '" aria-hidden="true">' . $map . '</div>';
}
