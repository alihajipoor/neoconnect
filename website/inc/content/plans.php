<?php
/**
 * ============================================================================
 *  PLAN DATA — RECONCILED AGAINST THE LIVE DATABASE 2026-08-24.
 *
 *  This file used to open with a warning that its prices were a starting
 *  structure nobody had confirmed. They have now been read directly from
 *  the panel's `subscription_plans` table, and two of them were wrong on
 *  the live website:
 *
 *    - Ultimate was advertised at $11.99. It is $9.99.
 *    - Ultimate was advertised as "Coming soon" with a dead button. It is
 *      purchasable and has been since 2026-08-13. The site was refusing
 *      money for a plan that works.
 *
 *  Starter and Pro were already correct.
 *
 *  The live table, for reference (named columns only -- several tables in
 *  that database carry encrypted credential blobs and must never be
 *  selected with *):
 *
 *    name          price  days  dataCap        devices    relayOnly  active  purchasable
 *    Trial          1.00   30   50 GiB         2          false      true    FALSE
 *    Starter        3.99   30   null           1          false      true    true
 *    Pro            6.99   30   null           2          false      true    true
 *    Ultimate       9.99   30   30 GiB         null       TRUE       true    true
 *    Ultimate Max  50.00   30   null           null       false      FALSE   true
 *
 *  TWO PLANS ARE DELIBERATELY ABSENT FROM THE LIST BELOW:
 *
 *  1. Trial -- isPurchasable = false. It is granted to a new account, not
 *     sold. It appears on the pricing page as a paragraph ("every new
 *     account starts on a trial"), never as a card with a buy button,
 *     because there is no checkout behind it.
 *
 *  2. Ultimate Max -- isActive = FALSE while isPurchasable is true. That
 *     combination means a customer could pay $50 for a plan that does not
 *     work, so the website will not list it. This needs an owner decision:
 *     activate it, or stop offering it. It is flagged in the handover.
 *
 *  KEEP THIS FILE MATCHING THE PANEL. Nothing enforces the match, and the
 *  drift above is what that costs. If you change a plan in the panel,
 *  change it here in the same sitting.
 * ============================================================================
 *
 * Fields:
 *   id             internal key, used for the CSS hook and the buy link
 *   name           display name, per locale
 *   tagline        one line under the name, per locale
 *   price          number, in the currency below
 *   duration_days  billing period; 30 renders as "/month"
 *   data_gb        data cap in GB, or null for a genuinely unlimited plan.
 *                  Mirrors SubscriptionPlan.dataCapBytes, which is nullable.
 *   connections    max simultaneous devices, or null for no limit. Mirrors
 *                  SubscriptionPlan.maxConcurrentConnections, also nullable.
 *   down_mbps      download / upload ceilings in Mbit/s, or null. The panel
 *   up_mbps        leaves these unset on every current plan, so no speed
 *                  line renders. Do not fill them in unless the panel
 *                  actually caps the plan -- advertising a limit that does
 *                  not exist makes the plans look worse than they are.
 *   relay_only     true when the plan carries only relayed routes. Drives
 *                  the perks list and the comparison table.
 *   highlight      true on at most one plan, draws the "most popular" frame
 */

defined('NX') || exit;

return array(

    'currency_symbol' => '$',

    'plans' => array(

        array(
            'id' => 'starter',
            'name' => array('en' => 'Starter', 'fa' => 'پایه'),
            'tagline' => array(
                'en' => 'Unlimited data, on one device.',
                'fa' => 'حجم نامحدود، روی یک دستگاه.',
            ),
            'price' => 3.99,
            'duration_days' => 30,
            'data_gb' => null,
            'connections' => 1,
            'down_mbps' => null,
            'up_mbps' => null,
            'relay_only' => false,
            'highlight' => false,
        ),

        array(
            'id' => 'pro',
            /* Data does not separate Starter from Pro -- both are genuinely
               unlimited (dataCapBytes is null, not a large sentinel) -- so
               the device count is the entire difference and the tagline
               says exactly that. */
            'name' => array('en' => 'Pro', 'fa' => 'حرفه‌ای'),
            'tagline' => array(
                'en' => 'Unlimited data, on two devices at once.',
                'fa' => 'حجم نامحدود، روی دو دستگاه هم‌زمان.',
            ),
            'price' => 6.99,
            'duration_days' => 30,
            'data_gb' => null,
            'connections' => 2,
            'down_mbps' => null,
            'up_mbps' => null,
            'relay_only' => false,
            'highlight' => true,
        ),

        array(
            'id' => 'ultimate',
            /* The odd one out, deliberately: LESS data than the other two
               for more money, because what it sells is the route, not the
               allowance. Relayed traffic crosses two servers instead of one
               -- the Iran-reachable entry and the exit abroad -- so every
               gigabyte costs roughly twice as much to carry, and an
               Iran-region VPS costs more per gigabyte than a Finnish one to
               begin with. 30 GiB is what that supports at this price.

               'نامحدود' would be an actively wrong Persian name for the one
               metered plan, so it is transliterated instead. */
            'name' => array('en' => 'Ultimate', 'fa' => 'آلتیمیت'),

            /* Describes the routing rather than promising an outcome. An
               earlier draft said connecting was "guaranteed, unlike the
               other two" -- dropped on purpose. No VPN can guarantee a
               connection on a filtered network, it is the sentence a
               customer quotes back during a refund argument, and it is the
               kind of absolute claim that draws attention in a store
               review. Saying WHY the route holds up is the stronger sell
               and happens to be true. */
            'tagline' => array(
                'en' => 'Routed through our Iran relay — the path built for heavily filtered networks.',
                'fa' => 'از مسیر رله‌ی ایران — مسیری که برای شبکه‌های به‌شدت فیلترشده ساخته شده است.',
            ),
            'price' => 9.99,
            'duration_days' => 30,
            'data_gb' => 30,
            /* null renders as "Unlimited devices", which is the intent: no
               device limit at all, in exchange for the metered traffic. */
            'connections' => null,
            'down_mbps' => null,
            'up_mbps' => null,
            'relay_only' => true,
            'highlight' => false,

            /* Its own perks, because two lines in the default set are the
               opposite of the truth here: this plan is NOT "every
               connection option" and NOT "every server location", it is one
               relay path. Stating the restriction plainly is also the sell
               -- that path is what the price buys. No claim about
               guaranteed connectivity anywhere. */
            'perks' => array('relay_only', 'relay_premium', 'relay_filtered', 'support'),

            /* NOTE: the `coming_soon` flag that used to be here has been
               removed. It was correct when written -- every node was
               standalone and no route was relayed -- but the relay node was
               enrolled and the plan went live on 2026-08-13, and nobody
               came back to this file. The result was a live website showing
               a dead "Coming soon" button on a plan customers could buy. */
        ),
    ),
);
