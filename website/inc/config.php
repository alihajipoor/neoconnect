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
    'site_url' => 'https://neoxify.com',

    // Where the site lives relative to the web root. '/' means it was
    // unzipped straight into public_html (the normal case). If you ever put
    // it in a subfolder, set '/subfolder/' -- with both slashes.
    'base_path' => '/',

    // ---------------------------------------------------------------
    // Contact
    // ---------------------------------------------------------------

    // Shown publicly on the contact page, for people who would rather email
    // than use a form.
    'contact_email' => 'support@neoxify.com',

    // Where form submissions are delivered.
    'mail_to' => 'support@neoxify.com',

    // Envelope sender. This MUST be an address on your own domain or SPF
    // alignment breaks and delivery gets worse -- neoxify.com currently has
    // SPF and DMARC but no DKIM, so every bit of alignment matters. The
    // submitter's address goes in Reply-To instead, never in From.
    'mail_from' => 'noreply@neoxify.com',
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
