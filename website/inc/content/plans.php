<?php
/**
 * ============================================================================
 *  SET YOUR REAL PRICES HERE BEFORE THE SITE GOES LIVE.
 *
 *  The numbers below are a starting structure, NOT your pricing. Nobody has
 *  confirmed them. Publishing them unchanged would advertise prices your
 *  panel does not charge.
 *
 *  These must match the SubscriptionPlan rows in the admin panel, because
 *  those are what a customer is actually billed. This file is marketing copy
 *  describing them -- it does not drive billing and cannot override it.
 *
 *  RESTRUCTURED 2026-08-12. The ladder is no longer "more money, more
 *  gigabytes" -- it is devices first, then routing:
 *
 *      Starter   unlimited data, 1 device
 *      Pro       unlimited data, 2 devices
 *      Ultimate  30 GB, unlimited devices, RELAY-ONLY (Iran route)
 *
 *  Ultimate deliberately carries the LEAST data for the MOST money, and
 *  that is not a mistake to "fix" later: it sells the route, not the
 *  allowance. Relayed traffic crosses two servers instead of one and the
 *  Iran-side VPS costs more per gigabyte, so 30 GB is what the price
 *  supports.
 *
 *  Ultimate is marked 'coming_soon' because the relay node it needs does
 *  not exist yet. Checked on the live database the day this was written:
 *  all three nodes are STANDALONE (Finland, France, Singapore) and not one
 *  of the 16 routes is relayed. Do not remove that flag until a relay node
 *  is enrolled AND a relayed Route exists.
 *
 *  If you change a plan in the panel, change it here in the same sitting.
 *  Nothing enforces the match -- an earlier drift (Pro advertised 300 GB
 *  while the panel gave 200) went unnoticed for exactly that reason.
 * ============================================================================
 *
 * This is the only file to edit to change plans, prices or what each plan
 * advertises. Names and taglines are inline per locale so adding a plan never
 * means editing three files.
 *
 * Fields:
 *   id             internal key, used for the CSS hook and nothing else
 *   name           display name, per locale
 *   tagline        one line under the name, per locale
 *   price          number, in the currency below
 *   duration_days  billing period; 30 renders as "/month"
 *   data_gb        data cap in GB (1024 renders as "1 TB"), or null for an
 *                  unlimited plan. Mirrors SubscriptionPlan.dataCapBytes,
 *                  which is nullable now that plans can be metered or
 *                  unlimited per plan.
 *   connections    max simultaneous devices, or null to not mention it.
 *                  Maps to SubscriptionPlan.maxConcurrentConnections, which
 *                  is nullable -- leave null unless the plan really sets one.
 *   down_mbps      download speed limit in Mbit/s, or null. Maps to
 *   up_mbps        SubscriptionPlan.maxDownloadMbps / maxUploadMbps.
 *   highlight      true on at most one plan, draws the "most popular" frame
 *
 * A word on the speed fields. In the panel these are a *cap* -- the field is
 * literally labelled "Download limit (Mbit/s)" and the agent enforces it by
 * shaping traffic. They are optional, and a plan with them unset is not
 * throttled at all.
 *
 * So they are null here, and the pricing cards say nothing about speed unless
 * you fill them in. Both failure modes are bad: advertising a limit that does
 * not exist makes your plans look worse than they are, and staying silent
 * about one that does exist is a complaint waiting to happen. Set these to
 * match whatever you actually configured on the SubscriptionPlan rows, or
 * leave them null if you left the plans uncapped.
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
            'highlight' => false,
        ),

        array(
            'id' => 'pro',
            'name' => array('en' => 'Pro', 'fa' => 'حرفه‌ای'),
            /* Data no longer separates Starter from Pro -- both are
               unlimited -- so the device count is the whole difference
               and the tagline says exactly that. */
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
            'highlight' => true,
        ),

        array(
            'id' => 'ultimate',
            /* The odd one out, deliberately: LESS data than the other two
               for more money, because what it sells is the route, not the
               allowance. Traffic on a relayed route crosses two servers
               instead of one -- the Iran-reachable entry and the exit
               abroad -- so every gigabyte costs roughly twice as much to
               carry, and an Iran-region VPS costs more per gigabyte than
               a Finnish one to begin with. 30 GB is what that supports at
               this price.
               'نامحدود' would be an actively wrong Persian name now that
               this is the one metered plan; it is transliterated instead. */
            'name' => array('en' => 'Ultimate', 'fa' => 'آلتیمیت'),

            /* Describes the routing rather than promising an outcome.
               An earlier draft said connecting was "guaranteed, unlike the
               other two" -- dropped on purpose. No VPN can guarantee a
               connection on a filtered network, it is the sentence a
               customer quotes back during a refund argument, and it is the
               kind of absolute claim that draws attention in an app-store
               review. Saying WHY the route holds up is the stronger sell
               and happens to be true. */
            'tagline' => array(
                'en' => 'Routed through our Iran relay — the path built for heavily filtered networks.',
                'fa' => 'از مسیر رله‌ی ایران — مسیری که برای شبکه‌های به‌شدت فیلترشده ساخته شده است.',
            ),
            'price' => 11.99,
            'duration_days' => 30,
            'data_gb' => 30,
            /* null renders as "Unlimited", which is the intent here: no
               device limit at all, in exchange for the metered traffic. */
            'connections' => null,
            'down_mbps' => null,
            'up_mbps' => null,
            'highlight' => false,

            /* Shown, but not sellable. The relay node this plan depends on
               does not exist yet -- every node today is STANDALONE and not
               one route is relayed -- so the card renders with a
               "Coming soon" button instead of a buy link. Taking payment
               for a route we cannot carry would be the worst possible
               version of shipping this early.
               Delete this line the day a relay node is enrolled and a
               relayed Route exists; also flip the plan active in the panel,
               which is what gates the app and the customer portal. */
            'coming_soon' => true,
        ),
    ),
);
