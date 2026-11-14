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

    // Security headers the WEB SERVER already adds to every response, so
    // PHP must not send its own copy (inc/headers.php). Two copies of HSTS
    // fail hstspreload.org's checks, and two X-Frame-Options that disagree
    // are flagged by every header scanner.
    //
    // Set for today's host, a shared nginx box whose config is not ours:
    // measured 2026-10-19, it sends exactly these four on every response,
    // PHP pages included. PHP still sends the rest (the CSP, COOP, CORP
    // and Permissions-Policy), which that host does not.
    //
    // Moving to a host that sends none of them: make this array() and PHP
    // sends the full set. After any deploy, look at the headers of a real
    // response -- this list describes a server we do not control.
    'headers_sent_by_server' => array(
        'Strict-Transport-Security',
        'X-Frame-Options',
        'X-Content-Type-Options',
        'Referrer-Policy',
    ),

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
    // The customer area now ships inside this site, at /account/ -- a
    // static React build of the very same screens the Windows and
    // Android apps use, talking straight to the customer API. It needs
    // no PHP, no session and no server runtime, which is what lets it
    // live on ordinary shared hosting alongside these pages.
    //
    // A root-relative path rather than an absolute URL so it follows the
    // site wherever it is hosted, and so a visitor on the Persian pages
    // is not bounced to a different origin mid-journey.
    //
    // Still honours the empty-means-hidden rule: blank this and every
    // sign-in link disappears again, which is the switch to reach for if
    // the account area ever has to be taken down.
    'customer_portal_url' => '/account/',

    'windows_installer_url' => 'https://connect.neoxify.site/api/updates/installer/windows',

    // The Android APK, same arrangement as Windows above: one URL that
    // always resolves to the newest release, so this never needs editing
    // when a version ships. Empty means "not released yet" and the page
    // says so rather than offering a dead button.
    'android_installer_url' => 'https://connect.neoxify.site/api/updates/installer/android',

    // ---------------------------------------------------------------
    // Downloads served from this site (get/index.php)
    // ---------------------------------------------------------------

    // The two installer URLs above are on the control plane's domain,
    // which networks that block VPNs often block too: a visitor there can
    // load this page and still not download. So the buttons point at
    // /get/windows and /get/android on THIS site instead. On a request,
    // the site (which sits outside) asks the URL above where the current
    // release is, keeps one copy of that file in installer_store_dir, and
    // sends the visitor to the copy here. The visitor's browser needs no
    // other host. Still no version number in the site: the answer comes
    // from the same endpoint as before, so a new release shows up by itself.
    //
    // false: the buttons go straight to the URLs above, as before.
    'installer_local_copy' => true,

    // Where the copies live, relative to the site root: a public folder of
    // its own, served as plain static files. NOT inside data/, which the
    // site's .htaccess and the nginx example both deny outright. The web
    // server's user must be able to write to it, and deploys leave it alone.
    'installer_store_dir' => 'dl',

    // The bookkeeping beside the copies (the remembered release answer, the
    // lock, the last failure). Private, so it stays inside data/.
    'installer_state_dir' => 'data/installers',

    // Release files are fetched only from these hosts, over https, and the
    // first answer must start with installer_release_prefix. Anything else
    // is ignored and the button falls back to the URL above.
    'installer_release_hosts' => array(
        'github.com',
        'objects.githubusercontent.com',
        'release-assets.githubusercontent.com',
    ),
    'installer_release_prefix' => 'https://github.com/alihajipoor/neoxify-releases/releases/download/',

    // Refuse anything bigger than this. Today: Windows ~21 MB, Android ~87 MB.
    'installer_max_bytes' => 200 * 1024 * 1024,

    // How long the answer to "where is the current release" is trusted.
    'installer_resolve_ttl' => 600,

    // The iPhone and iPad app, on the App Store. Empty hides the card.
    'ios_app_store_url' => 'https://apps.apple.com/app/id6815764263',

    // The Android app on Google Play, shown beside the direct file. Empty
    // hides the button; the direct file stays either way.
    'android_play_url' => 'https://play.google.com/store/apps/details?id=com.neoxify.mobile',

    // Not read by any page. The Android builds stopped being arm64-only:
    // release-android.yml builds aarch64 and armv7 (the 0.2.40 APK carries
    // lib/arm64-v8a and lib/armeabi-v7a), so the page no longer says 64-bit.
    'android_arm64_only' => false,

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
    // when android-v0.2.5 shipped, iOS when the App Store listing went
    // public (1.0.2, 2026-11-14).
    'platforms_planned' => array('macos'),

    // ---------------------------------------------------------------
    // Release phase
    // ---------------------------------------------------------------

    // Shows a "Beta" badge beside the logo, a line in the hero, and a short
    // explanation on the download page. Set false when the product leaves
    // beta and all three disappear together.
    'beta_enabled' => false,

    // ---------------------------------------------------------------
    // Free trial
    // ---------------------------------------------------------------

    // Whether the site advertises the free trial, on the pricing section and
    // in the FAQ.
    //
    // ON since the panel's trial was switched on (checked 2026-11-14: the
    // panel grants the Trial plan when a new account's email is verified).
    // It was off by default on purpose: free trial mode is a switch in the admin
    // panel (FreeTrialSettings, which itself defaults to disabled) -- if the
    // website promised a trial the panel wasn't granting, people would sign
    // up and get nothing. Turn this on only once the trial is genuinely
    // enabled in the panel, and set the number of days and the data to match
    // the trial plan's own.
    // TURNED ON because you said the trial is running. Do check that
    // FreeTrialSettings is also enabled in the admin panel -- this switch only
    // controls what the website *says*. If the panel's own toggle is still
    // off, people will read the announcement, sign up, and get nothing.
    'free_trial_enabled' => true,
    'free_trial_days' => 7,
    'free_trial_gb' => 10,

    // ---------------------------------------------------------------
    // Launch announcement
    // ---------------------------------------------------------------

    // The popup shown to first-time visitors. Set false to stop it entirely.
    'announcement_enabled' => true,

    // Dismissal is remembered per version. Bump this string when the message
    // changes and everyone who already dismissed it sees the new one once.
    'announcement_version' => '2',

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
