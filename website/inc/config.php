<?php
/**
 * Neoxify website configuration.
 *
 * This is the only file you normally need to edit. Everything here is plain
 * data -- no logic, no secrets that can't be regenerated. Prices live in
 * inc/content/plans.php, not here.
 *
 * PHP 7.4 compatible on purpose: this has to run on whatever the shared host
 * happens to provide, so nothing here uses PHP 8-only syntax or functions.
 */

defined('NX') || exit;

return array(

    // ---------------------------------------------------------------
    // Site identity
    // ---------------------------------------------------------------

    // Public origin, no trailing slash. Used for canonical URLs, hreflang
    // alternates, sitemap entries and Open Graph tags. If you serve the site
    // from a different domain, this is the one place to change it.
    //
    // Note the website is on .net while the mail and the admin panel
    // (connect.neoxify.com) are on .com. That split is intentional, but it is
    // why the sender address below needs care.
    'site_url' => 'https://neoxify.net',

    // Where the site lives relative to the web root. '/' means it was
    // unzipped straight into public_html (the normal case). If you ever put
    // it in a subfolder, set '/subfolder/' -- with both slashes.
    'base_path' => '/',

    // ---------------------------------------------------------------
    // Contact
    // ---------------------------------------------------------------

    // Shown publicly on the contact page, for people who would rather email
    // than use a form.
    'contact_email' => 'info@neoxify.com',

    // Where form submissions are delivered.
    'mail_to' => 'info@neoxify.com',

    // Envelope sender -- deliberately on neoxify.NET, not .com.
    //
    // The site runs on the .net webhost, so that host is what actually hands
    // the message to the internet. A receiving server checks SPF against the
    // From domain: if this said @neoxify.com, it would ask whether the .net
    // webhost is authorised to send for neoxify.com, and unless you have
    // explicitly added that host to neoxify.com's SPF record, the answer is
    // no. That is a fast route to the spam folder -- and neoxify.com already
    // has no DKIM, so there is no second signal to fall back on.
    //
    // Using the sending domain here keeps SPF aligned. Mail still lands in
    // info@neoxify.com (mail_to above), and the submitter's own address goes
    // in Reply-To, so replying works normally.
    //
    // Switch this to @neoxify.com only if you have confirmed the .net host is
    // included in neoxify.com's SPF record.
    'mail_from' => 'noreply@neoxify.net',
    'mail_from_name' => 'Neoxify Website',

    // Optional public contact channels. Leave any of these as an empty
    // string to hide it from the footer and contact page entirely.
    'telegram_url' => '',

    // ---------------------------------------------------------------
    // Downloads
    // ---------------------------------------------------------------

    // The Windows download link.
    //
    // This is an endpoint on the control plane that redirects to the current
    // release's installer. Set once; it should never need editing again.
    //
    // It replaced a pinned GitHub release tag, and the reason is worth
    // keeping. A pinned tag is correct until the day it isn't, and nobody
    // goes back to check: this site spent days serving desktop-v0.9.0, a
    // mislabelled release whose payload was the older 0.8.0 build, while the
    // real current version was 0.8.6. Visitors were downloading the worst
    // build we had shipped.
    //
    // GitHub's /releases/latest/download/ shortcut is not the fix either --
    // "latest" spans every tag in the repository, including agent releases,
    // so it breaks the moment a non-desktop release is newer.
    //
    // This endpoint resolves through the same code the in-app updater uses,
    // so the download link and the update path can never disagree about what
    // the current version is.
    //
    // Empty means "not released yet" and the download page says so, rather
    // than linking to something that 404s.
    // .site rather than .com, and that is the whole point: connect.neoxify.com's
    // address was filtered in Iran, so a visitor there could reach this page
    // and still not reach the download. This hostname is on a separate domain
    // behind a CDN, so it is not the same address to block. Either resolves to
    // the newest release -- the endpoint reads the version from the published
    // filename, so this link never needs editing when a version ships.
    // Where a customer signs in, sees their subscription and buys.
    //
    // Not on this site, deliberately. This is a PHP marketing site with no
    // sessions and no calls to the API; the account area lives on the
    // control plane, which already holds the customer database, the auth
    // endpoints and the payment providers. Putting a login form here would
    // mean a second place that handles credentials and holds a token, for
    // no gain -- so the buttons are links, not forms.
    //
    // Empty until that area exists, following the same rule as the Android
    // link below: an unset URL renders no button at all, rather than a
    // button that leads nowhere. Set it and the header, the mobile drawer
    // and the pricing section all gain a sign-in link at once.
    'customer_portal_url' => '',

    'windows_installer_url' => 'https://connect.neoxify.site/api/updates/installer/windows',

    // The Android APK, same arrangement as Windows above: one URL that
    // always resolves to the newest release, so this never needs editing
    // when a version ships. Empty means "not released yet" and the page
    // says so rather than offering a dead button.
    'android_installer_url' => 'https://connect.neoxify.site/api/updates/installer/android',

    // Android builds are arm64-only. That is every phone and tablet sold
    // for years, but it is stated on the page rather than left to fail at
    // install time on something older.
    'android_arm64_only' => true,

    // Optional link to published SHA-256 checksums, shown beside the download.
    //
    // Empty by default and deliberately so: the installer URL above always
    // serves the current release, so any checksum pinned to one release would
    // eventually describe a different file than the one people just
    // downloaded -- worse than no checksum at all. It also keeps the site
    // from advertising where the binaries are hosted. Fill it in only if you
    // publish a checksum list that tracks the current release.
    'windows_checksums_url' => '',

    // The Windows installer is not code-signed yet (a deliberate decision --
    // signing is deferred until closer to public launch). While this is true,
    // the download page explains the SmartScreen warning users will see.
    // Set to false once the installer is signed.
    'windows_unsigned' => true,

    // Platforms that genuinely are not built yet. Listed on the download page
    // as "not available", never as a dead link. Android came off this list
    // when android-v0.2.5 shipped.
    'platforms_planned' => array('macos', 'ios'),

    // ---------------------------------------------------------------
    // Release phase
    // ---------------------------------------------------------------

    // Shows a "Beta" badge beside the logo, a line in the hero, and a short
    // explanation on the download page. Set false when the product leaves
    // beta and all three disappear together.
    'beta_enabled' => true,

    // ---------------------------------------------------------------
    // Free trial
    // ---------------------------------------------------------------

    // Whether the site advertises the free trial, on the pricing section and
    // in the FAQ.
    //
    // Defaults to OFF on purpose. Free trial mode is a switch in the admin
    // panel (FreeTrialSettings, which itself defaults to disabled) -- if the
    // website promised a trial the panel wasn't granting, people would sign
    // up and get nothing. Turn this on only once the trial is genuinely
    // enabled in the panel, and set the number of days to match the trial
    // plan's own duration.
    // TURNED ON because you said the trial is running. Do check that
    // FreeTrialSettings is also enabled in the admin panel -- this switch only
    // controls what the website *says*. If the panel's own toggle is still
    // off, people will read the announcement, sign up, and get nothing.
    'free_trial_enabled' => true,
    'free_trial_days' => 30,

    // ---------------------------------------------------------------
    // Launch announcement
    // ---------------------------------------------------------------

    // The popup shown to first-time visitors. Set false to stop it entirely.
    'announcement_enabled' => true,

    // Dismissal is remembered per version. Bump this string when the message
    // changes and everyone who already dismissed it sees the new one once.
    'announcement_version' => '1',

    // ---------------------------------------------------------------
    // Referral programme
    // ---------------------------------------------------------------

    // Same reasoning as the free trial above: ReferralSettings.enabled
    // defaults to false in the panel, so the site says nothing about
    // referrals until you have actually switched it on there. Advertising a
    // reward scheme that isn't running is a support ticket, not a feature.
    'referrals_enabled' => false,

    // ---------------------------------------------------------------
    // Forms
    // ---------------------------------------------------------------

    // Max submissions allowed from one IP per window, per form.
    'rate_limit_max' => 5,
    'rate_limit_window' => 3600,

    // How long a form's CSRF token stays valid, in seconds. Long enough that
    // someone can genuinely sit and write a message without being rejected.
    'csrf_ttl' => 7200,

    // Minimum seconds between the form rendering and being submitted. Real
    // humans take a few seconds; bots post instantly.
    'form_min_seconds' => 3,
);
