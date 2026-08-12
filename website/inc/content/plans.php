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
                'en' => 'Enough for regular play sessions.',
                'fa' => 'برای بازی‌های همیشگی کافی است.',
            ),
            'price' => 3.99,
            'duration_days' => 30,
            'data_gb' => 100,
            'connections' => 1,
            'down_mbps' => null,
            'up_mbps' => null,
            'highlight' => false,
        ),

        array(
            'id' => 'pro',
            'name' => array('en' => 'Pro', 'fa' => 'حرفه‌ای'),
            'tagline' => array(
                'en' => 'For daily use across more than one device.',
                'fa' => 'برای استفاده روزانه روی بیش از یک دستگاه.',
            ),
            'price' => 6.99,
            'duration_days' => 30,
            'data_gb' => 300,
            'connections' => 3,
            'down_mbps' => null,
            'up_mbps' => null,
            'highlight' => true,
        ),

        array(
            'id' => 'ultimate',
            'name' => array('en' => 'Ultimate', 'fa' => 'نامحدود'),
            'tagline' => array(
                'en' => 'Headroom you will not have to think about.',
                'fa' => 'آن‌قدر حجم که دیگر به آن فکر نکنید.',
            ),
            'price' => 11.99,
            'duration_days' => 30,
            'data_gb' => 1024,
            'connections' => 5,
            'down_mbps' => null,
            'up_mbps' => null,
            'highlight' => false,
        ),
    ),
);
