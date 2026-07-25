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

    'github_repo' => 'alihajipoor/neoconnect',

    // The Windows client's published release tag, e.g. 'desktop-v0.1.0'.
    //
    // Leave this EMPTY until a desktop-v* tag has actually been pushed and
    // .github/workflows/release-desktop-windows.yml has published its assets.
    // While it is empty the download page honestly says the Windows app is
    // not downloadable yet, instead of linking to a URL that 404s. Fill it in
    // and the real download button, version number and checksum link all
    // switch on -- no other edit needed.
    'windows_release_tag' => '',

    // Asset filename inside that release. Tauri's NSIS bundle names it after
    // the app's productName and version, so this changes with each release.
    //
    // NOTE: this reads "Neoxify_" because the site was renamed ahead of the
    // app. The desktop client's tauri.conf.json still has productName
    // "NeoConnect" at the time of writing, so a release cut today would
    // actually publish NeoConnect_0.1.0_x64-setup.exe. Whatever the bundle
    // genuinely produces is what has to go here -- check the release assets
    // rather than trusting this line.
    'windows_asset' => 'Neoxify_0.1.0_x64-setup.exe',

    // Human-readable version shown on the download page.
    'windows_version' => '0.1.0',

    // The Windows installer is not code-signed yet (a deliberate decision --
    // signing is deferred until closer to public launch). While this is true,
    // the download page explains the SmartScreen warning users will see.
    // Set to false once the installer is signed.
    'windows_unsigned' => true,

    // Platforms that genuinely are not built yet. Listed on the download page
    // as "not available", never as a dead link.
    'platforms_planned' => array('macos', 'android', 'ios'),

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
    'free_trial_enabled' => false,
    'free_trial_days' => 30,

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
