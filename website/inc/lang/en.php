<?php
/**
 * English strings. This is the reference locale -- every other language file
 * is merged over this one, so anything missing elsewhere falls back to real
 * English text rather than showing a visitor a raw key.
 *
 * A note on the copy: every claim here describes something the product
 * actually does. There are deliberately no server counts, uptime percentages,
 * user numbers, or no-logging claims, because none of those are established
 * facts about this system. If you add copy later, hold it to the same bar.
 */

defined('NX') || exit;

return array(

    // -----------------------------------------------------------------
    // Chrome
    // -----------------------------------------------------------------

    'brand.name' => 'Neoxify',
    'brand.tagline' => 'Hard to block. Eight ways through.',

    // Units. Separated from the number so nx_format_data() can put the
    // amount through nx_num() and still name the unit in the reader's own
    // language -- "30 GB" in a Persian sentence came out as "GB 30".
    'unit.gb' => 'GB',
    'unit.tb' => 'TB',

    'nav.home' => 'Home',
    'nav.features' => 'Features',
    'nav.pricing' => 'Plans',
    'nav.download' => 'Download',
    'nav.contact' => 'Contact',
    'nav.reseller' => 'Resellers',
    'nav.privacy' => 'Privacy',
    'nav.delete_account' => 'Delete account',
    'nav.signin' => 'Sign in',
    'nav.cta' => 'Get the app',
    'nav.menu' => 'Menu',
    'nav.close' => 'Close menu',

    'lang.switch' => 'فارسی',
    'lang.switch_label' => 'Switch language',

    'footer.product' => 'Product',
    'footer.company' => 'Company',
    'footer.rights' => '© :year Neoxify. All rights reserved.',
    'footer.note' => 'Neoxify is a commercial VPN service. Use it in line with the laws that apply to you.',

    'skip_to_content' => 'Skip to content',

    // -----------------------------------------------------------------
    // Page metadata
    // -----------------------------------------------------------------

    // Rewritten 2026-08. The previous title was "Neoxify — a VPN built for
    // gamers on restricted networks", which sold to the wrong audience
    // (gaming is one segment, not the market) and led on the one claim
    // the product can least substantiate. This one leads with what it
    // actually is and what it actually carries.
    'meta.home.title' => 'Neoxify — a VPN with eight ways through a filtered network',
    'meta.home.description' => 'WireGuard, OpenVPN, Shadowsocks, VLESS REALITY and four more in one app. Servers in five countries, an Iran relay path, and nothing to import.',

    'meta.download.title' => 'Download Neoxify for Windows and Android — direct installer and APK',
    'meta.download.description' => 'Get the Neoxify app for Windows or Android. Direct download, always the current release. No macOS or iOS app yet.',

    'meta.contact.title' => 'Contact Neoxify — questions before you buy, and support',
    'meta.contact.description' => 'Ask about plans, payment, or whether a connection method will work on your network. Write to us and a person answers. Existing customers get faster help in the app.',

    'meta.privacy.title' => 'Privacy — what Neoxify records, and what it does not',
    'meta.privacy.description' => 'What we hold for your account, what our servers log, what payment providers see, how long it is kept and how to have it deleted. We make no no-logs claim.',

    'delete.title' => "Delete your account",
    'delete.subtitle' => "Remove your Neoxify account and everything on it.",
    'delete.inapp.title' => "Fastest: delete it in the app",
    'delete.inapp.body' => "Open Neoxify, go to Settings, then Account, and choose Delete account. It happens immediately and you do not have to wait for us. This page exists for people who have already uninstalled the app or cannot reach it.",
    'delete.form.title' => "Or request it here",
    'delete.form.body' => "Send us the email address on the account. We will verify the request with you before deleting anything, so the address you give must be one you can receive mail at.",
    'delete.field.email' => "Email address on the account",
    'delete.field.message' => "Anything else we should know (optional)",
    'delete.form.submit' => "Request deletion",
    'delete.success.title' => "Request received",
    'delete.success.body' => "We will email you to confirm it is really you, and delete the account once you reply. If you do not hear from us within a couple of days, please contact support.",
    'delete.what.title' => "What is removed",
    'delete.what.body' => "Your account and sign-in, your connection credentials on every server, and any time remaining on your plan. This cannot be undone, and remaining paid time is not refunded.",
    'delete.kept.title' => "What is kept",
    'delete.kept.body' => "Invoices and payment records, with your personal details removed from them. We are required to keep those for tax purposes; they no longer identify you.",

    'privacy.title' => 'Privacy',
    'privacy.subtitle' => 'What we collect, why we have it, and what you can ask us to do about it. Written to describe what the service actually does, not to fill a page.',
    'privacy.updated' => 'Last updated :date',
    // PHP date() format. Per locale because date('F') only ever produces
    // English month names -- the Persian page was rendering "3 August 2026".
    // A numeric format there avoids depending on the intl extension, which
    // shared hosting may not have.
    'privacy.date_format' => 'j F Y',
    'privacy.contact.title' => 'Contact',
    'privacy.contact.body' => 'Questions about any of this, or a request about your own data, go to :email. Write from the address on your account and we will deal with it.',

    'meta.reseller.title' => 'Become a Neoxify reseller — sell VPN accounts to your own audience',
    'meta.reseller.description' => 'For Telegram channels, gaming communities, local shops and network admins. Terms are agreed individually with every partner, not from a published price list.',

    // -----------------------------------------------------------------
    // Home — hero
    // -----------------------------------------------------------------

    // Must not repeat the headline underneath it -- an earlier version read
    // "Encrypted. Stable. Hard to block." directly above a headline already
    // saying "Hard to block."
    'home.hero.eyebrow' => 'For networks that fight back',
    'home.hero.title' => 'Low latency. Hard to block.',
    'home.hero.title_accent' => 'Built for gamers.',
    'home.hero.subtitle' => 'Your traffic is encrypted the moment it leaves your device, carried across servers we run ourselves, and built to keep working on networks that try hard to shut connections like this down.',
    'home.hero.cta_primary' => 'Download for Windows',
    'home.hero.cta_primary_soon' => 'See download options',
    'home.hero.cta_secondary' => 'See plans',
    // "in development" was an overclaim on both counts. No macOS client
    // exists in any form, and iOS has no VPN code at all -- it is blocked
    // on an Apple *organization* enrolment that cannot begin until a legal
    // entity exists. CI builds an iOS simulator target, which cannot run a
    // tunnel and is not evidence of a client. "Not yet" is the true
    // statement; a date would be a guess.
    'home.hero.note_available' => 'Windows and Android apps out now. There is no macOS or iOS app yet.',
    'home.hero.note_soon' => 'Windows app releasing soon. There is no macOS or iOS app yet.',

    'beta.badge' => 'Beta',
    'beta.hero' => 'In beta — early, and moving fast.',
    'beta.title' => 'Neoxify is in beta',
    'beta.body' => 'The service works and people are using it every day, but it is early. Things change quickly and you may run into rough edges. If something breaks, tell us — support is inside the app, or use the contact form. Hearing about it is the whole point of this phase.',

    // -----------------------------------------------------------------
    // Home — features
    // -----------------------------------------------------------------

    'home.features.eyebrow' => 'Why Neoxify',
    'home.features.title' => 'The parts that actually matter when the network is against you',

    'home.features.encryption.title' => 'Encrypted before it leaves your device',
    'home.features.encryption.body' => 'Everything you send is encrypted on your machine and stays that way across the network to our servers. Whoever is sitting in between — your ISP, the café Wi-Fi, whoever runs the network — sees an encrypted stream and nothing they can read.',

    'home.features.stealth.title' => 'Designed not to stand out',
    'home.features.stealth.body' => 'Your connection is built to look like ordinary everyday web traffic rather than announcing itself as something worth blocking. That is the difference between a connection that survives on a filtered network and one that dies in seconds.',

    'home.features.access.title' => 'More than one way in',
    'home.features.access.body' => 'If the route you are on stops working, you are not stuck with it. Switch to a different one from inside the app and carry on — no new purchase, no reinstall, no waiting for us to fix something.',

    'home.features.hotupdate.title' => 'Plan changes never drop your session',
    'home.features.hotupdate.body' => 'Renewals, upgrades and server-side changes apply to a live connection. Your match does not end because your subscription renewed in the background.',

    'home.features.locations.title' => 'Choose where you come out',
    'home.features.locations.body' => 'Pick a location in the app and change it whenever you like. Server addresses are delivered by our backend, so they can be rotated without you reinstalling or re-importing anything.',

    // Mirrors the app's own wording for the feature ("Custom mode"), so
    // someone who reads this here recognises the switch when they find it in
    // Settings.
    'home.features.custom.title' => 'Choose what goes through it',
    'home.features.custom.body' => 'Custom mode sends only the apps you pick through the tunnel — your game, say — while everything else carries on over your normal connection. Chosen per application, not per website.',

    'home.features.support.title' => 'Help without leaving the app',
    'home.features.support.body' => 'Support is a conversation inside the app, where we can already see your account instead of asking you to describe it. Ask, get on with your day, and pick up the reply when it lands.',

    'home.features.updates.title' => 'It keeps itself current',
    'home.features.updates.body' => 'Install it once. From then on the app updates itself, so you are never hunting a download page for a fix you did not know you needed.',

    'home.features.usage.title' => 'Your data, counted openly',
    'home.features.usage.body' => 'Usage is measured per account and shown in the app, so you always know exactly where you stand against your plan instead of guessing.',

    // -----------------------------------------------------------------
    // Home — how it works
    // -----------------------------------------------------------------

    'home.steps.eyebrow' => 'Getting started',
    'home.steps.title' => 'Three steps, no configuration files',

    'home.steps.1.title' => 'Install the app',
    'home.steps.1.body' => 'Download it and run it. Nothing to import, no config text to paste, no third-party client to set up first.',

    'home.steps.2.title' => 'Create your account',
    'home.steps.2.body' => 'Sign up inside the app and confirm your email with the short code we send. Access is issued once your address is verified.',

    'home.steps.3.title' => 'Pick a location and connect',
    'home.steps.3.body' => 'Choose the server you want and hit connect. Change location whenever you feel like it.',

    // -----------------------------------------------------------------
    // Home — security
    //
    // Deliberately describes what the encryption does for the reader rather
    // than naming the technology behind it. Note what is NOT claimed: not
    // "end-to-end" (a VPN protects the leg between you and our servers, not
    // beyond it), and nothing about logging, which has never been
    // established as a fact about this service.
    // -----------------------------------------------------------------

    'home.security.eyebrow' => 'Security',
    'home.security.title' => 'What "encrypted" actually means here',
    'home.security.body' => 'Plenty of services say "encrypted" and leave it there. Here is the honest version: everything you send is scrambled on your own device before it touches the network, and it stays scrambled the whole way to our servers.',

    'home.security.point1.title' => 'Proven cryptography, not homemade',
    'home.security.point1.body' => 'The encryption protecting your connection is the same well-reviewed, industry-standard kind your bank and your messaging apps rely on. We did not invent our own scheme, and you should be suspicious of anyone who did.',

    'home.security.point2.title' => 'Your network operator learns nothing',
    'home.security.point2.body' => 'Whoever runs the network you are sitting on can tell that you have an encrypted connection open. What travels inside it — the sites, the games, the messages — is not something they can read.',

    'home.security.point3.title' => 'Nothing to paste, nothing to leak',
    'home.security.point3.body' => 'There are no configuration files or subscription links to copy around, share by accident, or leave sitting in a chat. Your access lives in your account, inside the official app.',

    'home.security.diagram.you' => 'Your device',
    'home.security.diagram.network' => 'Your network',
    'home.security.diagram.tunnel' => 'Encrypted',
    'home.security.diagram.server' => 'Our servers',
    'home.security.diagram.internet' => 'The internet',
    'home.security.diagram.caption' => 'Simplified illustration. Your network can see that traffic is flowing, not what it contains.',

    // -----------------------------------------------------------------
    // Home — assurance strip and app mockup
    // -----------------------------------------------------------------

    'home.assure.encrypted' => 'Encrypted connection',
    'home.assure.stable' => 'Built to stay up',
    'home.assure.noconfig' => 'No config files',
    'home.assure.switch' => 'Switch location anytime',

    'home.mockup.alt' => 'The Neoxify app running on Windows, beside the Android app and a macOS window marked as not yet available.',
    'home.mockup.windows' => 'Windows',
    'home.mockup.mobile' => 'Mobile',
    'home.mockup.macos' => 'macOS',
    'home.mockup.soon' => 'Not yet',
    'home.mockup.subscription' => 'Subscription',
    'home.mockup.status' => 'Active',
    'home.mockup.expires' => 'Renews in 24 days',
    // No "of N GB" any more: Starter and Pro are both unlimited, so a
    // denominator here would invent a cap that no purchasable plan has.
    // This has already been wrong twice by trailing a plan change, which
    // is why it now states only what was used.
    'home.mockup.used' => '84 GB used this month',
    'home.mockup.connected' => 'Connected',
    'home.mockup.location' => 'Change location',

    // -----------------------------------------------------------------
    // Home — pricing
    // -----------------------------------------------------------------

    'home.pricing.eyebrow' => 'Plans',
    'home.pricing.title' => 'Straightforward pricing',
    'home.pricing.subtitle' => 'Plans are purchased inside the app — pick one when you sign up. Pay by card or with crypto.',
    'home.pricing.popular' => 'Most popular',
    'home.pricing.per_month' => '/month',
    'home.pricing.per_days' => 'per :days days',
    'home.pricing.cta' => 'Get started',
    // Replaces the buy button on a plan whose infrastructure is not live
    // yet -- see 'coming_soon' in inc/content/plans.php.
    'home.pricing.coming_soon' => 'Coming soon',
    'home.pricing.data' => ':amount of data',
    // Matches the app's own "Unlimited" label for a plan with no cap.
    'home.pricing.data_unlimited' => 'Unlimited data',
    'home.pricing.data_period' => ':amount every :days days',
    'home.pricing.connections' => 'Up to :count devices connected at once',
    // Separate strings rather than an :count that reads "1 devices", and
    // an explicit unlimited case -- without it a plan with no device limit
    // rendered no device line at all, silently dropping the very thing it
    // is selling.
    'home.pricing.connections_one' => 'One device at a time',
    'home.pricing.connections_unlimited' => 'Unlimited devices at once',

    // Only rendered when a plan actually has a speed cap configured. Worded
    // as "up to" because that is what these are -- a ceiling the agent
    // enforces, not a guaranteed throughput we could promise.
    'home.pricing.speed_both' => 'Up to :down Mbit/s down, :up Mbit/s up',
    'home.pricing.speed_down' => 'Up to :down Mbit/s download',
    'home.pricing.speed_up' => 'Up to :up Mbit/s upload',
    // Renamed from all_protocols: the site deliberately does not name the
    // protocols it runs on, and a key called "protocols" invites someone to
    // "fix" the copy by putting them back.
    'home.pricing.all_modes' => 'Every connection option included',
    'home.pricing.all_locations' => 'Every server location',
    'home.pricing.relay_routes' => 'Optimised routes for restricted networks',
    'home.pricing.support' => 'Support directly in the app',
    // Relay-plan perks. The four above are the standard-plan set and two
    // of them are flatly untrue of a relay-only plan -- it is neither
    // "every connection option" nor "every server location", it is one
    // premium path. Saying so is also the sell, since that path is what
    // the higher price buys.
    'home.pricing.relay_only' => 'Relay routes only — not the standard servers',
    'home.pricing.relay_premium' => 'Premium two-hop path through our Iran relay',
    'home.pricing.relay_gaming' => 'Built for low latency on filtered networks',
    'home.pricing.trial' => 'New accounts start with a :days-day free trial — no card required.',
    'home.pricing.note' => 'Prices are in US dollars.',

    // -----------------------------------------------------------------
    // Home — FAQ and closing
    // -----------------------------------------------------------------

    'home.faq.eyebrow' => 'Questions',
    'home.faq.title' => 'Things people ask before signing up',

    'home.cta.title' => 'Ready when you are',
    'home.cta.body' => 'Install the app, verify your email, pick a server. That is the whole setup.',
    'home.cta.button' => 'Get Neoxify',

    // -----------------------------------------------------------------
    // Download
    // -----------------------------------------------------------------

    'download.title' => 'Download Neoxify',
    'download.subtitle' => 'One app per device. It handles accounts, plans and connections itself — there is nothing else to install alongside it.',

    'download.windows.name' => 'Windows',
    'download.windows.requirements' => 'Windows 10 or 11, 64-bit',
    'download.windows.button' => 'Download for Windows',
    'download.windows.always_current' => 'Always the current version',
    'download.windows.checksum' => 'SHA-256 checksums',

    'download.unreleased.badge' => 'Releasing soon',
    'download.unreleased.title' => 'The Windows installer is not published yet',
    'download.unreleased.body' => 'The app is built and tested — we are finishing the release packaging. If you would like to be told the moment it goes out, send us a message and we will let you know.',
    'download.unreleased.cta' => 'Tell me when it is out',

    'download.autoupdate.title' => 'This is the only download you will need',
    'download.autoupdate.android' => 'Android is the exception: the system does not let an app replace itself, so when a new version is out, download it from this page again and install over the top. Your account and settings are kept.',
    'download.autoupdate.body' => 'Once it is installed, the Windows app keeps itself up to date — it checks for new versions and installs them on its own. You will not have to come back to this page for the next release.',

    'download.unsigned.title' => 'About the warning Windows will show you',
    'download.unsigned.body' => 'The installer is not code-signed yet, so Windows SmartScreen may show a blue "Windows protected your PC" screen the first time you run it. Choose More info, then Run anyway. A signing certificate is on the list before public launch. Until then, only ever download from this page — the button here always comes from us.',

    'download.steps.title' => 'Installing on Windows',
    'download.steps.1' => 'Run the installer. It installs for your user account only and does not ask for administrator rights.',
    'download.steps.2' => 'Open Neoxify and create your account, or sign in if you already have one.',
    'download.steps.3' => 'Confirm your email address with the code we send you.',
    'download.steps.4' => 'Choose a location and connect. Windows will ask for permission the first time a tunnel is created.',


    // --- Android ---------------------------------------------------
    'download.android.name' => 'Android',
    'download.android.requirements' => 'Android 7 or newer, 64-bit',
    'download.android.button' => 'Download for Android',

    'download.android.sideload.title' => 'Your phone will ask before installing',
    'download.android.sideload.body' => 'Android only installs apps from outside the Play Store once you allow it. When you open the downloaded file, your phone will ask whether to permit installs from your browser — allow it, then tap Install. The warning is Android being careful about where the file came from, not a sign that anything is wrong with it.',

    'download.android.steps.title' => 'Installing on Android',
    'download.android.steps.1' => 'Tap the download button, then open the file when it finishes.',
    'download.android.steps.2' => 'Allow your browser to install apps if your phone asks, then tap Install.',
    'download.android.steps.3' => 'Open Neoxify, create your account or sign in, and confirm your email with the code we send you.',
    'download.android.steps.4' => 'Choose a location and connect. Android will ask once for permission to create a VPN — tap OK.',

    'download.other.title' => 'Other platforms',
    'download.other.body' => 'Not built yet, and we are not putting a date on either. An app that does not exist is not "coming soon".',
    'download.other.macos' => 'macOS',
    'download.other.android' => 'Android',
    'download.other.ios' => 'iOS',
    'download.other.status' => 'Not available yet',

    // -----------------------------------------------------------------
    // Contact
    // -----------------------------------------------------------------

    'contact.title' => 'Contact us',
    'contact.subtitle' => 'Questions about plans, connections or anything else — write to us and a human will answer.',
    'contact.direct.title' => 'Prefer email?',
    'contact.direct.body' => 'Write to :email directly and we will pick it up.',
    'contact.support.title' => 'Already a customer?',
    'contact.support.body' => 'Support lives inside the app, where we can see your account and actually help. This form is best for everything else.',

    'contact.form.title' => 'Send a message',
    'contact.field.name' => 'Your name',
    'contact.field.email' => 'Email address',
    'contact.field.subject' => 'Subject',
    'contact.field.message' => 'Message',
    'contact.field.message_placeholder' => 'Tell us what you need.',
    'contact.submit' => 'Send message',
    'contact.success.title' => 'Message sent',
    'contact.success.body' => 'Thanks — we have it. We usually reply within a day.',

    // -----------------------------------------------------------------
    // Reseller
    // -----------------------------------------------------------------

    'reseller.title' => 'Become a reseller',
    'reseller.subtitle' => 'We work with people who already have an audience — gaming communities, Telegram channels, local shops, network admins.',

    'reseller.about.title' => 'How this works',
    'reseller.about.body' => 'Reseller terms are agreed individually. We do not publish a fixed price list, because what makes sense for a 50-person clan is not what makes sense for a shop selling accounts every day. Tell us about your audience and we will come back to you with something concrete.',

    'reseller.steps.1.title' => 'Apply',
    'reseller.steps.1.body' => 'Fill in the form below. The more you tell us about who you would be selling to, the faster this goes.',
    'reseller.steps.2.title' => 'We get in touch',
    'reseller.steps.2.body' => 'We read every application personally and reply to you directly. No automated approval, no waiting on a queue.',
    'reseller.steps.3.title' => 'We agree terms',
    'reseller.steps.3.body' => 'Pricing, volumes and how you get paid are settled together before anything starts.',

    'reseller.form.title' => 'Apply to resell',
    'reseller.field.name' => 'Your name',
    'reseller.field.email' => 'Email address',
    'reseller.field.telegram' => 'Telegram username',
    'reseller.field.telegram_hint' => 'Optional, but it is usually the fastest way to reach you.',
    'reseller.field.country' => 'Country or region',
    'reseller.field.audience' => 'How many people could you reach?',
    'reseller.field.experience' => 'Have you sold VPN or gaming services before?',
    'reseller.field.experience_placeholder' => 'Optional. Tell us what you have done before, if anything.',
    'reseller.field.message' => 'Tell us about your audience',
    'reseller.field.message_placeholder' => 'Who are they, where do you reach them, and what are they using today?',
    'reseller.submit' => 'Send application',
    'reseller.success.title' => 'Application received',
    'reseller.success.body' => 'Thanks — we have your application and we read every one personally. Expect to hear from us directly.',

    'reseller.audience.under_100' => 'Fewer than 100',
    'reseller.audience.100_1000' => 'Between 100 and 1,000',
    'reseller.audience.over_1000' => 'More than 1,000',
    'reseller.audience.not_sure' => 'Not sure yet',

    // -----------------------------------------------------------------
    // Forms — shared
    // -----------------------------------------------------------------

    'form.required' => 'required',
    'form.optional' => 'optional',
    'form.choose' => 'Choose one',
    'form.sending' => 'Sending…',
    'form.has_errors' => 'Please check the fields marked below.',

    'form.error.required' => 'This field is required.',
    'form.error.email' => 'That does not look like a valid email address.',
    'form.error.too_long' => 'Please keep this under :max characters.',
    'form.error.too_short' => 'Please write at least :min characters.',
    'form.error.expired' => 'This form was open too long and the security token expired. Please send it again.',
    'form.error.too_fast' => 'That was submitted a little too quickly. Please try once more.',
    'form.error.rate_limited' => 'You have sent several messages recently. Please wait a while before sending another.',
    'form.error.generic' => 'We could not accept that submission. Please try again.',
    'form.error.delivery' => 'Something went wrong on our side and your message was not saved. Please email :email directly so it does not get lost.',

    // Honeypot label -- never seen by a real visitor, but screen readers can
    // reach it, so it needs to say something sensible.
    'form.honeypot' => 'Leave this field empty',

    // -----------------------------------------------------------------
    // Launch announcement
    //
    // Two versions. The trial one only ever renders when the free trial is
    // switched on in config; otherwise the launch one runs, so the popup can
    // never promise a free month that isn't being granted.
    // -----------------------------------------------------------------

    'announce.trial.pill' => ':days days free',
    'announce.trial.headline' => 'Your first month is on us',
    'announce.trial.short' => 'No card and no payment details — create an account in the app and it starts right away.',

    'announce.launch.pill' => 'Out now',
    'announce.launch.headline' => 'Neoxify has launched',
    'announce.launch.short' => 'The Windows app is available now and keeps itself updated from here on.',

    'announce.cta' => 'Get the app',
    'announce.close' => 'Dismiss this message',

    // -----------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------

    'meta.404.title' => 'Page not found — Neoxify',
    'meta.404.description' => 'That page does not exist.',
    'error.404.code' => '404',
    'error.404.title' => 'That page does not exist',
    'error.404.body' => 'The link may be out of date, or there may be a typo in the address. The pages below definitely work.',
    'error.404.home' => 'Back to the home page',

    // =================================================================
    // 2026-08 rebuild — new pages, structured data, honest positioning
    // =================================================================

    // -----------------------------------------------------------------
    // Missing keys that shipped to production as ⟪placeholders⟫
    //
    // Measured on the live site 2026-08-24: /delete-account/ and
    // /fa/delete-account/ both served
    //     <title>⟪meta.delete-account.title⟫</title>
    // and the same in the meta description and both OG tags. The page had
    // strings for its body (delete.title, delete.subtitle) but nobody
    // added the meta.* pair, and nx_t() renders a missing key visibly
    // rather than blank -- which is the right behaviour, and it was
    // shouting into production for months because no page-level test ever
    // looked at a <title>.
    //
    // scripts/check-site-strings.php now fails on any ⟪⟫ reaching a
    // rendered page, so this class of bug cannot ship silently again.
    // -----------------------------------------------------------------

    'meta.delete-account.title' => 'Delete your account — Neoxify',
    'meta.delete-account.description' => 'How to permanently delete your Neoxify account and everything on it, from inside the app or by asking us directly.',

    // -----------------------------------------------------------------
    // Social preview
    // -----------------------------------------------------------------

    // Describes the card image itself, for someone who cannot see it.
    'meta.og.image_alt' => 'Neoxify — a VPN with eight ways to connect, built for heavily filtered networks.',

    // -----------------------------------------------------------------
    // Structured data
    //
    // Read by machines and repeated in search results, so held to the
    // same bar as the visible copy: nothing here that is not checkable
    // against the product.
    // -----------------------------------------------------------------

    'schema.org.description' => 'Neoxify is a commercial VPN service with eight connection methods, built for people on heavily filtered networks.',
    'schema.product.description' => 'A VPN subscription with eight connection methods, servers in five countries plus an Iran relay path, and apps for Windows and Android.',
    'schema.app.windows.name' => 'Neoxify for Windows',
    'schema.app.android.name' => 'Neoxify for Android',
    'schema.app.trial' => 'Free trial for new accounts, no payment method required.',

    // -----------------------------------------------------------------
    // Navigation additions
    // -----------------------------------------------------------------

    'nav.faq' => 'FAQ',
    'nav.support' => 'Support',
    'footer.resources' => 'Resources',
    'footer.legal' => 'Legal',

    // -----------------------------------------------------------------
    // Shared vocabulary
    // -----------------------------------------------------------------

    'locations.city_country' => ':city, :country',
    'common.windows' => 'Windows',
    'common.android' => 'Android',
    'common.yes' => 'Supported',
    'common.no' => 'Not available',
    'common.learn_more' => 'Learn more',

    // -----------------------------------------------------------------
    // Home — hero
    //
    // POSITIONING CHANGE, 2026-08. Read this before reverting it.
    //
    // The previous hero was "Low latency. Hard to block. / Built for
    // gamers." Two problems, one factual and one strategic:
    //
    // 1. FACTUAL. "Low latency" as an end-to-end claim is not currently
    //    supportable. Measured from Tehran, the direct path to Blizzard's
    //    EU servers is 73.7 ms; the closest Neoxify node is 84.6 ms. For
    //    that workload the product ADDS latency, which is what a VPN
    //    normally does -- there is no shorter path than the short path.
    //    What IS supportable, and is the real product, is that the
    //    connection survives a network that is actively breaking it.
    //
    // 2. STRATEGIC. "Built for gamers" was corrected internally on
    //    2026-07-25: gamers are one segment, not the audience. Phones and
    //    general use dominate, and the narrow framing was already skewing
    //    decisions elsewhere in the product.
    //
    // Gaming has NOT been dropped -- it is named as a use case on the
    // features page, without a speed claim attached. The old strings are
    // kept directly below, commented, so reverting is one edit rather
    // than a rewrite. This is the owner's call to make; it is flagged in
    // the handover rather than decided quietly.
    //
    //   'home.hero.title' => 'Low latency. Hard to block.',
    //   'home.hero.title_accent' => 'Built for gamers.',
    //   'brand.tagline' => 'Fast, hard to block, built for gamers.',
    // -----------------------------------------------------------------

    'home.hero.title' => 'When the network fights back,',
    'home.hero.title_accent' => 'this keeps working.',
    'home.hero.subtitle' => 'Eight different ways to connect, servers in five countries, and an app that checks traffic is really flowing before it tells you it is connected. Built for networks that filter hard.',

    'home.hero.cta_primary' => 'Download the app',
    'home.hero.cta_secondary' => 'Compare plans',

    // -----------------------------------------------------------------
    // Home — stat strip
    //
    // Every one of these numbers is counted from a data file at render
    // time, never typed here. The labels are the only text.
    // -----------------------------------------------------------------

    'home.stats.protocols' => 'Ways to connect',
    'home.stats.locations' => 'Server countries',
    'home.stats.platforms' => 'Apps out now',
    'home.stats.platforms_value' => 'Windows + Android',

    // -----------------------------------------------------------------
    // Home — protocols teaser
    // -----------------------------------------------------------------

    'home.protocols.eyebrow' => 'Connection methods',
    'home.protocols.title' => 'Eight ways in, because one is never enough',
    'home.protocols.body' => 'A filtered network does not block "VPNs" — it blocks specific, recognisable patterns, one at a time, and what worked last week can be gone today. So the app carries eight different methods and moves between them. When one stops getting through, you pick another and carry on.',
    'home.protocols.link' => 'See every connection method',

    // -----------------------------------------------------------------
    // Home — locations teaser
    // -----------------------------------------------------------------

    'home.locations.eyebrow' => 'Server locations',
    'home.locations.title' => 'Where your traffic comes out',
    'home.locations.body' => 'Pick a country in the app and change it whenever you like. Server addresses come from our backend rather than being built into the app, so they can be rotated without you reinstalling or importing anything.',
    'home.locations.relay_note' => 'Plus a relay inside Iran — an entry point that hands your traffic on to a server abroad, for networks where a direct connection will not hold. It is a way in, not a place you come out.',

    // -----------------------------------------------------------------
    // Home — honest trust section
    //
    // This is the section that would normally hold fabricated badges:
    // "audited", "no logs", "10 million users". None of those are true
    // here, so this says what IS true instead, including the awkward
    // parts. Being the VPN that does not overclaim is a real position,
    // and it is the only one this product can currently defend.
    // -----------------------------------------------------------------

    'home.trust.eyebrow' => 'Straight answers',
    'home.trust.title' => 'What we will and will not claim',
    'home.trust.body' => 'Most VPN sites make promises nobody checks. Here is where this one stands, including the parts that are not flattering.',

    'home.trust.state.title' => 'The app does not lie about being connected',
    'home.trust.state.body' => 'Before it shows you as connected, it checks that traffic is genuinely reaching the internet through the tunnel. A green light that means nothing is worse than a red one, especially if you are relying on it.',

    'home.trust.logs.title' => 'We do not claim to keep no logs',
    'home.trust.logs.body' => 'Plenty of services advertise a no-logs policy. We are not going to, because our servers do write connection logs, and saying otherwise would be a lie that happens to be popular. Read the privacy page for what is actually recorded and why.',

    'home.trust.beta.title' => 'It is beta, and the installer is unsigned',
    'home.trust.beta.body' => 'People use this every day and it works, but it is early and it changes fast. Windows will warn you about the installer because it is not code-signed yet. We would rather you heard that here than found it out mid-download.',

    'home.trust.honest.title' => 'No route stays open forever',
    'home.trust.honest.body' => 'Nobody can promise a specific connection method will keep working on a filtered network — anyone who does is guessing. That is precisely why you get eight of them and can switch in a couple of taps.',

    // -----------------------------------------------------------------
    // Home — closing
    // -----------------------------------------------------------------

    'home.pricing.link' => 'See full plan comparison',
    'home.faq.link' => 'Read all questions',

    // =================================================================
    // Features page
    // =================================================================

    'meta.features.title' => 'Features — eight VPN protocols and split tunnelling | Neoxify',
    'meta.features.description' => 'WireGuard, OpenVPN, Shadowsocks, VLESS REALITY and four more in one app. Per-app split tunnelling, five server countries and an Iran relay path.',

    'features.title' => 'What is actually in it',
    'features.subtitle' => 'The features below are the ones that exist and work today. Where something only works on one platform, it says so.',
    'features.eyebrow' => 'Features',

    'features.protocols.title' => 'Eight connection methods',
    'features.protocols.body' => 'Each one is a different way of getting your traffic out, and they fail in different circumstances — which is the whole point of carrying more than one. The names in the app describe the trade-off; the technology behind each is listed beside it.',
    'features.protocols.table.method' => 'Method',
    'features.protocols.table.what' => 'When to use it',
    'features.protocols.table.windows' => 'Windows',
    'features.protocols.table.android' => 'Android',
    'features.protocols.note' => 'OpenVPN is the one gap on Android: the client does not carry it. Every other method works on both. iOS and macOS apps do not exist yet, so neither carries any of them.',

    'features.failover.title' => 'It switches when a route dies — and checks before saying so',
    'features.failover.body' => 'If the method you are on stops getting through, the app moves you to another one. What makes that trustworthy rather than cosmetic is the check underneath: it confirms traffic is actually reaching the internet through the new route before it reports success. An indicator that turns green without verifying anything is exactly the bug this was built to fix.',

    'features.split.title' => 'Send only the apps you choose',
    'features.split.body' => 'Custom mode routes the applications you pick through the tunnel and leaves everything else on your normal connection. Chosen per application, not per website — so a browser and a game can genuinely take different paths.',
    'features.split.platforms' => 'Windows and Android. Not available on iOS: Apple restricts per-app VPN to devices managed by an organisation, so no consumer app can offer it. Saying that plainly is better than shipping a switch that quietly does nothing.',

    'features.relay.title' => 'A relay path for the hardest networks',
    'features.relay.body' => 'Some networks will not hold a direct connection abroad at all. The relay route starts at a server inside Iran, which is reachable when foreign addresses are not, and hands your traffic on from there. Two hops instead of one: more reliable where it matters, and slower, because the traffic is travelling further.',

    'features.locations.title' => 'Choose where you come out',
    'features.locations.body' => 'Change country from inside the app as often as you like.',

    'features.dns.title' => 'DNS and IPv6, handled rather than ignored',
    'features.dns.body' => 'On Windows the app sets DNS for the tunnel specifically, so lookups do not leak out over your normal connection. IPv6 is blocked rather than carried — if we cannot protect it, it does not go, and the app tells you that instead of quietly leaking it.',

    'features.usage.title' => 'Your usage, counted openly',
    'features.usage.body' => 'Data use is measured per account and shown in the app, so you always know where you stand against your plan. Plan changes, renewals and upgrades apply to a connection that is already running — nothing drops because your subscription renewed in the background.',

    'features.support.title' => 'Support inside the app',
    'features.support.body' => 'Support is a conversation in the app, where your account is already visible, so nobody has to ask you to describe it. Every payment produces an invoice you can open and print, whether you paid by card or with crypto.',

    'features.uses.eyebrow' => 'Who uses it',
    'features.uses.title' => 'Built for a filtered network, not for one hobby',
    'features.uses.body' => 'Most people here are doing ordinary things that a filtered network makes difficult: reading, watching, messaging, working, playing. The product is general-purpose on purpose — gaming is one use among several, not the whole pitch.',

    // =================================================================
    // Pricing page
    // =================================================================

    'meta.pricing.title' => 'Plans and pricing — Neoxify VPN',
    'meta.pricing.description' => 'Compare Neoxify plans: unlimited-data tiers, device limits, and the relay route built for heavily filtered networks. Pay by international card or crypto.',

    'pricing.title' => 'Plans',
    'pricing.subtitle' => 'Every plan includes all eight connection methods and every server location, unless the plan itself says otherwise. Buy inside the app or in your account area.',

    'pricing.compare.title' => 'Compare the plans',
    'pricing.compare.feature' => 'What you get',
    'pricing.compare.hint' => 'Scroll the table sideways to see every plan.',
    'pricing.compare.data' => 'Data',
    'pricing.compare.devices' => 'Devices at once',
    'pricing.compare.routes' => 'Routes',
    'pricing.compare.locations' => 'Locations',
    'pricing.compare.protocols' => 'Connection methods',
    'pricing.compare.support' => 'In-app support',
    'pricing.compare.routes_standard' => 'Direct',
    'pricing.compare.routes_relay' => 'Iran relay only',
    'pricing.compare.locations_all' => 'All',
    'pricing.compare.locations_relay' => 'Relay path',
    'pricing.compare.protocols_all' => 'All eight',

    // Trial, which is granted rather than sold. It exists in the plans
    // table with a price on it, but isPurchasable is false -- it is what a
    // new account starts on, not a tier you buy. Presenting it as a
    // purchasable plan would send people looking for a checkout that does
    // not exist for it.
    'pricing.trial.title' => 'Every new account starts on a trial',
    'pricing.trial.body' => 'You are not asked for a payment method to begin. Create an account in the app, confirm your email, and you are connected — which means you can find out whether this works on your own network before you spend anything.',

    'pricing.payment.title' => 'How you pay',
    'pricing.payment.body' => 'By international card or with cryptocurrency, both from inside the app. There is no Iranian payment gateway — if you are in Iran, crypto is the route that works. Every payment produces an invoice you can open and print.',

    'pricing.refund.title' => 'Before you buy',
    'pricing.refund.body' => 'There is a free trial, so you can find out whether this works on your own network before paying anything. We do not publish a money-back guarantee, and we are not going to imply one that has not been written down — if something goes wrong, contact support and talk to us.',

    'pricing.voucher.title' => 'Bought from a reseller?',
    'pricing.voucher.body' => 'Redeem your voucher code inside the app or in your account area. A valid code activates the plan straight away, with no payment step.',

    // =================================================================
    // FAQ page
    // =================================================================

    'meta.faq.title' => 'Frequently asked questions — Neoxify VPN',
    'meta.faq.description' => 'Devices, payment, data limits, server locations, filtered networks and vouchers — the questions people ask before signing up to Neoxify.',

    'faq.title' => 'Questions and straight answers',
    'faq.subtitle' => 'If your question is not here, the contact form goes to a person.',
    'faq.still.title' => 'Still stuck?',
    'faq.still.body' => 'Write to us and a human will answer. If you already have an account, support inside the app is faster — we can see your account there instead of asking you to describe it.',

    // Renamed from 'relay_gaming'. Same plan, same route; the line no
    // longer leads with a gaming claim, for the reason set out in the
    // positioning note above.
    'home.pricing.relay_filtered' => 'Built for networks that filter hardest',


    // -----------------------------------------------------------------
    // Features page — diagrams, examples and remaining labels
    // -----------------------------------------------------------------

    'locations.relay_label' => 'Relay entry point',

    'features.failover.diagram_alt' => 'A blocked connection method, an automatic switch to another, a check that traffic is really flowing, and only then a connected state.',
    'features.failover.step_blocked' => 'Route stops getting through',
    'features.failover.step_switch' => 'Switches method',
    'features.failover.step_verify' => 'Checks traffic really flows',
    'features.failover.step_connected' => 'Reports connected',

    // Categories rather than named applications: naming them would be an
    // endorsement, and every specific name dates.
    'features.split.example.browser.title' => 'Your browser, through the tunnel',
    'features.split.example.browser.body' => 'Read and watch what you came for, from a server abroad.',
    'features.split.example.game.title' => 'A game, on whichever path suits it',
    'features.split.example.game.body' => 'Route it through the tunnel or leave it on your own connection — whichever actually works better for that server.',
    'features.split.example.stream.title' => 'Streaming apps, kept separate',
    'features.split.example.stream.body' => 'Send the ones that need a different country, and leave the rest alone.',
    // The single most searched-for symptom in this market, named by the
    // problem people actually describe rather than by the feature. See the
    // Persian string for this key -- it is the one that matters.
    'features.split.example.bank.title' => 'Local banking and government sites',
    'features.split.example.bank.body' => 'These reject foreign addresses, so a full tunnel breaks them. Leave them off the tunnel and they keep working while everything else goes through it.',

    'features.relay.link' => 'See the plan that includes it',
    'features.relay.diagram_alt' => 'Your device connects to a relay inside Iran, which passes the traffic on to a server abroad.',
    'features.relay.you' => 'Your device',
    'features.relay.entry' => 'Relay inside Iran',
    'features.relay.exit' => 'Server abroad',

    'features.more.title' => 'The rest of it',

    'pricing.compare.price' => 'Price',

    // -----------------------------------------------------------------
    // Home — the "no config files" argument
    //
    // This market's unit of trade is the کانفیگ -- a config or
    // subscription link pasted into a third-party client. Neoxify does not
    // work that way, which is a genuine advantage and also the reason the
    // site is invisible to the biggest transactional search cluster there
    // is. The answer is to meet the vocabulary head-on and argue against
    // it honestly, rather than to pretend the word does not exist.
    // -----------------------------------------------------------------

    'home.config.eyebrow' => 'No config files',
    'home.config.title' => 'Nothing to paste, nothing to renew by hand',
    'home.config.body' => 'Most services here sell you a config or a subscription link that you paste into someone else\'s app. It works until the link dies, and then you are back asking for a new one. Neoxify is the app: you sign in, and it fetches what it needs and keeps it current on its own. There is nothing to copy, scan, share by accident, or replace next week.',
    'home.config.point1' => 'No config text or subscription link to import',
    'home.config.point2' => 'No third-party client to install first',
    'home.config.point3' => 'Server addresses refresh by themselves when they change',

);
