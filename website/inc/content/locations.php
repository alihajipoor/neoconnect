<?php
/**
 * Server locations.
 *
 * ============================================================================
 *  THIS FILE IS A PUBLIC CLAIM. KEEP IT MATCHING THE FLEET.
 *
 *  Until now the site named no location at all, on the principle that an
 *  unverified claim is worse than silence. That principle stands -- what
 *  changed is that the fleet is now recorded rather than assumed, so the
 *  claim can be made honestly.
 *
 *  Source: docs/journal/HANDOVER-2026-08-22.md section 2 ("Fleet state"),
 *  which lists five direct nodes plus one Iran relay, every one of them
 *  live and carrying paying customers.
 *
 *  Rules for editing:
 *    - Add a country here ONLY when a node is actually enrolled and
 *      carrying traffic. A location listed before it exists is the exact
 *      failure this file was written to avoid.
 *    - Remove one the day it is decommissioned. A stale location is a
 *      refund argument.
 *    - City is optional and only filled in where the repo actually
 *      records it. Three of the five are known; guessing the other two
 *      would be inventing detail for the sake of a tidier table.
 * ============================================================================
 *
 * Fields:
 *   code      ISO 3166-1 alpha-2, used for the flag glyph and nothing else
 *   country   display name, per locale
 *   city      display name per locale, or null when the repo does not record it
 *   relay     true for the Iran relay entry -- rendered separately, because
 *             it is not a place you exit from. It is the way IN for the
 *             relay route; traffic still leaves from one of the others.
 */

defined('NX') || exit;

return array(

    'direct' => array(

        array(
            'code' => 'fi',
            'country' => array('en' => 'Finland', 'fa' => 'فنلاند'),
            'city' => null,
        ),

        array(
            'code' => 'fr',
            'country' => array('en' => 'France', 'fa' => 'فرانسه'),
            'city' => null,
        ),

        array(
            'code' => 'de',
            'country' => array('en' => 'Germany', 'fa' => 'آلمان'),
            'city' => array('en' => 'Frankfurt', 'fa' => 'فرانکفورت'),
        ),

        array(
            'code' => 'tr',
            /* "Türkiye" is the country's own preferred English name and the
               one the UN uses. The Persian name is unaffected by that
               change -- it has always been ترکیه. */
            'country' => array('en' => 'Türkiye', 'fa' => 'ترکیه'),
            'city' => array('en' => 'Istanbul', 'fa' => 'استانبول'),
        ),

        array(
            'code' => 'sg',
            'country' => array('en' => 'Singapore', 'fa' => 'سنگاپور'),
            'city' => array('en' => 'Singapore', 'fa' => 'سنگاپور'),
        ),
    ),

    /* The relay entry. Deliberately its own key rather than a sixth row in
       the table above: a visitor reading a list of locations is reading a
       list of places their traffic can COME OUT, and this is not one of
       them. It is an entry point inside Iran that hands traffic on to a
       server abroad -- see inc/content/protocols.php and the relay
       explanation on the features page. */
    'relay' => array(
        'code' => 'ir',
        'country' => array('en' => 'Iran', 'fa' => 'ایران'),
        'city' => null,
    ),
);
