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
    'brand.tagline' => 'Hard to block. Several ways through.',

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
    'lang.en' => 'English',
    'lang.fa' => 'Persian',
    'lang.switch_label' => 'Switch language',

    'footer.product' => 'Product',
    'footer.company' => 'Company',
    'footer.rights' => '© :year Neoxify. All rights reserved.',
    'footer.note' => 'Neoxify is a paid VPN service. Use it within the laws that apply to you.',

    'skip_to_content' => 'Skip to content',

    // -----------------------------------------------------------------
    // Page metadata
    // -----------------------------------------------------------------

    // Rewritten 2026-08. The previous title was "Neoxify — a VPN built for
    // gamers on restricted networks", which sold to the wrong audience
    // (gaming is one segment, not the market) and led on the one claim
    // the product can least substantiate. This one leads with what it
    // actually is and what it actually carries.
    'meta.home.title' => 'Neoxify VPN for networks that block VPNs',
    'meta.home.description' => 'A VPN app for Windows and Android that finds a way to connect on networks that block VPNs. Servers in Europe and Asia. Free trial, no config files.',

    'meta.download.title' => 'Download Neoxify VPN for Windows and Android',
    'meta.download.description' => 'Download the Neoxify VPN app for Windows or Android. The link always gets the latest version. There is no macOS or iOS app yet.',

    'meta.contact.title' => 'Contact Neoxify | Questions and support',
    'meta.contact.description' => 'Ask about plans, payment or anything else. A person reads every message. If you already have an account, support in the app is faster.',

    'meta.privacy.title' => 'Privacy | What Neoxify records and why',
    'meta.privacy.description' => 'What we store for your account, what our servers log, what payment providers see, how long we keep it and how to delete it. We make no no-logs claim.',

    'delete.title' => "Delete your account",
    'delete.subtitle' => 'This removes your Neoxify account and everything in it.',
    'delete.inapp.title' => 'The quickest way is in the app',
    'delete.inapp.body' => 'Open Neoxify, go to Settings, then Account, and choose Delete account. The account is deleted right away. Use the form below only if you have uninstalled the app or can\'t open it.',
    'delete.form.title' => 'Or ask us to delete it',
    'delete.form.body' => 'Enter the email address of the account. Before we delete anything, we email you to confirm, so use an address you can read.',
    'delete.field.email' => 'Account email address',
    'delete.field.message' => "Anything else we should know (optional)",
    'delete.form.submit' => "Request deletion",
    'delete.success.title' => 'Request received',
    'delete.success.body' => 'We\'ll email you to confirm the request and delete the account after you reply. If you hear nothing within two days, contact support.',
    'delete.what.title' => 'What gets deleted',
    'delete.what.body' => 'Your account and sign-in details, your access on every server, and any time left on your plan. You can\'t undo this, and unused paid time is not refunded.',
    'delete.kept.title' => 'What we keep',
    'delete.kept.body' => 'Invoices and payment records, with your personal details removed. The law requires us to keep them for tax, and they no longer identify you.',

    'privacy.title' => 'Privacy',
    'privacy.subtitle' => 'What we collect, why, and what you can ask us to do with it.',
    'privacy.updated' => 'Last updated :date',
    // PHP date() format. Per locale because date('F') only ever produces
    // English month names -- the Persian page was rendering "3 August 2026".
    // A numeric format there avoids depending on the intl extension, which
    // shared hosting may not have.
    'privacy.date_format' => 'j F Y',
    'privacy.contact.title' => 'Contact',
    'privacy.contact.body' => 'Send questions about this page, or requests about your own data, to :email. Write from your account\'s email address so we can act on it.',

    'meta.reseller.title' => 'Become a Neoxify reseller | Sell VPN accounts',
    'meta.reseller.description' => 'For Telegram channels, gaming groups, shops and network admins. We agree terms with each reseller directly. There is no public price list.',

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
    'home.hero.note_available' => 'Available for Windows and Android. No macOS or iOS app yet.',
    'home.hero.note_soon' => 'The Windows app is coming soon. No macOS or iOS app yet.',

    'beta.badge' => 'Beta',
    'beta.hero' => 'In beta and still changing',
    'beta.title' => 'Neoxify is in beta',
    'beta.body' => 'People use it every day, but it\'s still early and things change often. You may run into problems. If something doesn\'t work, tell us through support in the app or the contact form.',

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

    'home.features.updates.title' => 'It updates itself',
    'home.features.updates.body' => 'Install it once. The Windows app then downloads and installs new versions by itself. On Android, you install updates from the download page.',

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
    'home.security.title' => 'What encryption protects',
    'home.security.body' => 'Everything you send is encrypted on your device before it reaches the network, and stays encrypted until it reaches our servers. From there, it travels the internet like any other traffic.',

    'home.security.point1.title' => 'Standard encryption',
    'home.security.point1.body' => 'We use the same well-tested kind of encryption that banks and messaging apps use. We didn\'t invent our own.',

    'home.security.point2.title' => 'Your network can\'t read your traffic',
    'home.security.point2.body' => 'Whoever runs your network can see that an encrypted connection is open. They can\'t see what\'s inside it, such as the sites you visit.',

    'home.security.point3.title' => 'No config to leak',
    'home.security.point3.body' => 'There\'s no config file or link that could end up in a chat by mistake. Your access is tied to your account in the app.',

    'home.security.diagram.you' => 'Your device',
    'home.security.diagram.network' => 'Your network',
    'home.security.diagram.tunnel' => 'Encrypted',
    'home.security.diagram.server' => 'Our servers',
    'home.security.diagram.internet' => 'The internet',
    'home.security.diagram.caption' => 'Simplified. Your network can see that data is moving, but it can\'t read it.',

    // -----------------------------------------------------------------
    // Home — assurance strip and app mockup
    // -----------------------------------------------------------------

    'home.assure.encrypted' => 'Encrypted connection',
    'home.assure.stable' => 'Built to stay up',
    'home.assure.noconfig' => 'No config files',
    'home.assure.switch' => 'Switch location anytime',

    'home.mockup.windows' => 'Windows',
    'home.mockup.mobile' => 'Mobile',
    'home.mockup.macos' => 'macOS',
    'home.mockup.soon' => 'Not yet',
    'home.mockup.subscription' => 'Subscription',
    'home.mockup.status' => 'Your traffic is going through the tunnel',
    'home.mockup.expires' => 'Renews',
    // No "of N GB" any more: Starter and Pro are both unlimited, so a
    // denominator here would invent a cap that no purchasable plan has.
    // This has already been wrong twice by trailing a plan change, which
    // is why it now states only what was used.
    'home.mockup.used' => 'Data used',
    'home.mockup.connected' => 'Connected',
    'home.mockup.location' => 'Change location',

    // -----------------------------------------------------------------
    // Home — pricing
    // -----------------------------------------------------------------

    'home.pricing.eyebrow' => 'Plans',
    'home.pricing.title' => 'Pick a plan',
    'home.pricing.subtitle' => 'You buy a plan in the app. Pay by international card or crypto.',
    'home.pricing.popular' => 'Most popular',
    'home.pricing.per_month' => '/month',
    'home.pricing.per_days' => 'per :days days',
    'home.pricing.cta' => 'Choose plan',
    // Replaces the buy button on a plan whose infrastructure is not live
    // yet -- see 'coming_soon' in inc/content/plans.php.
    'home.pricing.coming_soon' => 'Coming soon',
    'home.pricing.data' => ':amount of data',
    // Matches the app's own "Unlimited" label for a plan with no cap.
    'home.pricing.data_unlimited' => 'Unlimited data',
    'home.pricing.data_period' => ':amount every :days days',
    'home.pricing.connections' => 'Up to :count devices at once',
    // Separate strings rather than an :count that reads "1 devices", and
    // an explicit unlimited case -- without it a plan with no device limit
    // rendered no device line at all, silently dropping the very thing it
    // is selling.
    'home.pricing.connections_one' => 'One device at a time',
    'home.pricing.connections_unlimited' => 'No limit on devices',

    // Only rendered when a plan actually has a speed cap configured. Worded
    // as "up to" because that is what these are -- a ceiling the agent
    // enforces, not a guaranteed throughput we could promise.
    'home.pricing.speed_both' => 'Up to :down Mbit/s down, :up Mbit/s up',
    'home.pricing.speed_down' => 'Up to :down Mbit/s download',
    'home.pricing.speed_up' => 'Up to :up Mbit/s upload',
    // Renamed from all_protocols: the site deliberately does not name the
    // protocols it runs on, and a key called "protocols" invites someone to
    // "fix" the copy by putting them back.
    'home.pricing.all_modes' => 'Every way to connect',
    'home.pricing.all_locations' => 'Every server country',
    'home.pricing.relay_routes' => 'Made for networks that block VPNs',
    'home.pricing.support' => 'Support in the app',
    // Relay-plan perks. The four above are the standard-plan set and two
    // of them are flatly untrue of a relay-only plan -- it is neither
    // "every connection option" nor "every server location", it is one
    // premium path. Saying so is also the sell, since that path is what
    // the higher price buys.
    'home.pricing.relay_only' => 'Backup routes only, not the standard servers',
    'home.pricing.relay_premium' => 'Made for times when connections abroad are cut off',
    'home.pricing.trial' => 'New accounts get a :days-day free trial. No card needed.',
    'home.pricing.note' => 'Prices are in US dollars.',

    // -----------------------------------------------------------------
    // Home — FAQ and closing
    // -----------------------------------------------------------------

    'home.faq.eyebrow' => 'Questions',
    'home.faq.title' => 'Questions before you sign up',

    'home.cta.title' => 'Try it on your network',
    'home.cta.body' => 'Install the app and confirm your email. Then pick a country and connect.',
    'home.cta.button' => 'Download Neoxify',

    // -----------------------------------------------------------------
    // Download
    // -----------------------------------------------------------------

    'download.title' => 'Download Neoxify',
    'download.subtitle' => 'Install one app on each device. Your account, plan and connection are all handled inside it, so there\'s nothing else to install.',

    'download.windows.name' => 'Windows',
    'download.windows.requirements' => 'Windows 10 or 11, 64-bit',
    'download.windows.button' => 'Download for Windows',
    'download.windows.always_current' => 'Always the latest version',
    'download.windows.checksum' => 'SHA-256 checksums',

    'download.unreleased.badge' => 'Coming soon',
    'download.unreleased.title' => 'The Windows installer is not published yet',
    'download.unreleased.body' => 'The Windows installer isn\'t published yet. Send us a message if you\'d like us to tell you when it is.',
    'download.unreleased.cta' => 'Tell me when it\'s out',

    'download.autoupdate.title' => 'Updates',
    'download.autoupdate.android' => 'On Android it works differently. Android doesn\'t let an app replace itself, so when a new version comes out, download it from this page and install it over the old one. Your account and settings stay.',
    'download.autoupdate.body' => 'After you install it, the Windows app checks for new versions and installs them by itself. You don\'t need to come back here for updates.',

    'download.unsigned.title' => 'Windows will show a warning',
    'download.unsigned.body' => 'The installer isn\'t code-signed yet, so the first time you run it, Windows SmartScreen may show a blue "Windows protected your PC" screen. Click More info, then Run anyway. We plan to get a signing certificate before the public launch. Until then, download the app only from this page.',

    'download.steps.title' => 'Installing on Windows',
    'download.steps.1' => 'Run the installer. It installs for your Windows user only and doesn\'t need administrator rights.',
    'download.steps.2' => 'Open Neoxify and sign up, or sign in if you already have an account.',
    'download.steps.3' => 'Confirm your email address with the code we send you.',
    'download.steps.4' => 'Pick a country and connect. The first time, Windows asks for permission to set up the VPN.',


    // --- Android ---------------------------------------------------
    'download.android.name' => 'Android',
    'download.android.requirements' => 'Android 7 or newer, 64-bit',
    'download.android.button' => 'Download for Android',

    'download.android.sideload.title' => 'Your phone will ask before installing',
    'download.android.sideload.body' => 'Android only installs apps from outside Google Play if you allow it. When you open the downloaded file, your phone asks whether to allow installs from your browser. Allow it, then tap Install. The warning is about where the file came from. It doesn\'t mean something is wrong with it.',

    'download.android.steps.title' => 'Installing on Android',
    'download.android.steps.1' => 'Tap the download button, then open the file when it finishes.',
    'download.android.steps.2' => 'Allow your browser to install apps if your phone asks, then tap Install.',
    'download.android.steps.3' => 'Open Neoxify, sign up or sign in, and confirm your email with the code we send you.',
    'download.android.steps.4' => 'Pick a country and connect. Android asks once for permission to set up a VPN. Tap OK.',

    'download.other.title' => 'Other platforms',
    'download.other.body' => 'Not available yet. We won\'t announce a date until the app is ready.',
    'download.other.macos' => 'macOS',
    'download.other.android' => 'Android',
    'download.other.ios' => 'iOS',
    'download.other.status' => 'Not available yet',

    // -----------------------------------------------------------------
    // Contact
    // -----------------------------------------------------------------

    'contact.title' => 'Contact us',
    'contact.subtitle' => 'Write to us about plans, connecting or anything else. A person will reply.',
    'contact.direct.title' => 'Prefer email?',
    'contact.direct.body' => 'Email us at :email.',
    'contact.support.title' => 'Already a customer?',
    'contact.support.body' => 'Use support in the app. We can see your account there, so we can help faster. This form is for everything else.',

    'contact.form.title' => 'Send a message',
    'contact.field.name' => 'Your name',
    'contact.field.email' => 'Email address',
    'contact.field.subject' => 'Subject',
    'contact.field.message' => 'Message',
    'contact.field.message_placeholder' => 'How can we help?',
    'contact.submit' => 'Send message',
    'contact.success.title' => 'Message sent',
    'contact.success.body' => 'Thanks, we got it. We usually reply within a day.',

    // -----------------------------------------------------------------
    // Reseller
    // -----------------------------------------------------------------

    'reseller.title' => 'Become a reseller',
    'reseller.subtitle' => 'We work with people who already have an audience, such as gaming groups, Telegram channels, shops and network admins.',

    'reseller.about.title' => 'How it works',
    'reseller.about.body' => 'We agree terms with each reseller separately. There\'s no fixed price list, because a 50-person gaming clan and a shop that sells accounts every day need different deals. Tell us about your audience and we\'ll come back with an offer.',

    'reseller.steps.1.title' => 'Apply',
    'reseller.steps.1.body' => 'Fill in the form below. The more you tell us about who you\'d sell to, the faster this goes.',
    'reseller.steps.2.title' => 'We get in touch',
    'reseller.steps.2.body' => 'We read every application ourselves and reply to you directly.',
    'reseller.steps.3.title' => 'We agree terms',
    'reseller.steps.3.body' => 'We agree on prices, volumes and how you get paid before anything starts.',

    'reseller.form.title' => 'Apply to resell',
    'reseller.field.name' => 'Your name',
    'reseller.field.email' => 'Email address',
    'reseller.field.telegram' => 'Telegram username',
    'reseller.field.telegram_hint' => 'Optional, but it\'s usually the fastest way to reach you.',
    'reseller.field.country' => 'Country or region',
    'reseller.field.audience' => 'How many people could you reach?',
    'reseller.field.experience' => 'Have you sold VPN or gaming services before?',
    'reseller.field.experience_placeholder' => 'Optional. Tell us what you\'ve done before, if anything.',
    'reseller.field.message' => 'Tell us about your audience',
    'reseller.field.message_placeholder' => 'Who are they, where do you reach them, and what do they use today?',
    'reseller.submit' => 'Send application',
    'reseller.success.title' => 'Application received',
    'reseller.success.body' => 'Thanks, we got your application. We read every one ourselves and will contact you directly.',

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
    'form.error.email' => 'This email address doesn\'t look right.',
    'form.error.too_long' => 'Please keep this under :max characters.',
    'form.error.too_short' => 'Please write at least :min characters.',
    'form.error.expired' => 'This form was open too long and has expired. Please send it again.',
    'form.error.too_fast' => 'That was sent too quickly. Please try again.',
    'form.error.rate_limited' => 'You\'ve sent several messages recently. Please wait a while before sending another.',
    'form.error.generic' => 'We couldn\'t accept this. Please try again.',
    'form.error.delivery' => 'Something went wrong on our side and your message wasn\'t saved. Please email it to :email instead.',

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
    'announce.trial.headline' => 'Your first month is free',
    'announce.trial.short' => 'No card needed. Create an account in the app and start right away.',

    'announce.launch.pill' => 'Out now',
    'announce.launch.headline' => 'Neoxify has launched',
    'announce.launch.short' => 'The Windows app is out now and updates itself.',

    'announce.cta' => 'Get the app',
    'announce.close' => 'Dismiss this message',

    // -----------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------

    'meta.404.title' => 'Page not found | Neoxify',
    'meta.404.description' => 'That page does not exist.',
    'error.404.code' => '404',
    'error.404.title' => 'Page not found',
    'error.404.body' => 'The link may be old, or the address may have a typo. Try one of these pages.',
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

    'meta.delete-account.title' => 'Delete your Neoxify account',
    'meta.delete-account.description' => 'How to delete your Neoxify account and everything in it, from the app or by asking us.',

    // -----------------------------------------------------------------
    // Social preview
    // -----------------------------------------------------------------

    // Describes the card image itself, for someone who cannot see it.
    'meta.og.image_alt' => 'Neoxify. Your internet. Without limits. A VPN app for Windows and Android.',

    // -----------------------------------------------------------------
    // Structured data
    //
    // Read by machines and repeated in search results, so held to the
    // same bar as the visible copy: nothing here that is not checkable
    // against the product.
    // -----------------------------------------------------------------

    'schema.org.description' => 'Neoxify is a paid VPN service for people on networks that block VPNs. Its apps have several ways to connect and pick one that works.',
    'schema.product.description' => 'A VPN plan with several ways to connect, servers in Europe and Asia, and apps for Windows and Android.',
    'schema.app.windows.name' => 'Neoxify for Windows',
    'schema.app.android.name' => 'Neoxify for Android',
    'schema.app.trial' => 'Free trial for new accounts. No payment details needed.',

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
    'common.yes' => 'Included',
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
    'home.hero.subtitle' => 'The app has several ways to connect and finds one that works on your network. It shows Connected only after checking that your traffic gets through.',

    'home.hero.cta_primary' => 'Download the app',
    'home.hero.cta_secondary' => 'Compare plans',

    // -----------------------------------------------------------------
    // Home — stat strip
    //
    // Every one of these numbers is counted from a data file at render
    // time, never typed here. The labels are the only text.
    // -----------------------------------------------------------------

    // -----------------------------------------------------------------
    // Home — protocols teaser
    // -----------------------------------------------------------------

    'home.protocols.eyebrow' => 'Ways to connect',
    'home.protocols.title' => 'Several ways to connect in one app',
    'home.protocols.body' => 'Networks that block VPNs block one kind of connection at a time, and what worked last week may not work today. So the app has several ways to connect, and some of them look like ordinary web browsing.',
    'home.protocols.point1.title' => 'More than one way to connect',
    'home.protocols.point1.body' => 'Each one gets blocked in different situations. When one stops working, another may still get through.',
    'home.protocols.point2.title' => 'It finds one that works',
    'home.protocols.point2.body' => 'The app starts with what is most likely to work on your network. You don\'t need to set anything up.',
    'home.protocols.point3.title' => 'It switches when one stops',
    'home.protocols.point3.body' => 'If your connection is blocked, the app moves to another way and checks that traffic gets through before it says Connected.',
    'home.protocols.link' => 'How it stays connected',

    // -----------------------------------------------------------------
    // Home — locations teaser
    // -----------------------------------------------------------------

    'home.locations.eyebrow' => 'Server countries',
    'home.locations.title' => 'Where our servers are',
    'home.locations.body' => 'Pick a country in the app and change it whenever you like. Server addresses aren\'t built into the app. When we change them, the app gets the new ones by itself, so you never reinstall or import anything.',

    // -----------------------------------------------------------------
    // Home — honest trust section
    //
    // This is the section that would normally hold fabricated badges:
    // "audited", "no logs", "10 million users". None of those are true
    // here, so this says what IS true instead, including the awkward
    // parts. Being the VPN that does not overclaim is a real position,
    // and it is the only one this product can currently defend.
    // -----------------------------------------------------------------

    'home.trust.eyebrow' => 'What to expect',
    'home.trust.title' => 'What we promise, and what we don\'t',
    'home.trust.body' => 'This includes the parts that don\'t make us look good.',

    'home.trust.state.title' => 'It checks before it says Connected',
    'home.trust.state.body' => 'Before it shows Connected, the app checks that your traffic actually reaches the internet through the VPN. If you rely on a VPN, you need to know it\'s working.',

    'home.trust.logs.title' => 'We don\'t claim "no logs"',
    'home.trust.logs.body' => 'Our servers keep connection logs, so we can\'t truthfully say they don\'t. The privacy page explains what is recorded and why.',

    'home.trust.beta.title' => 'It\'s in beta, and the installer isn\'t signed',
    'home.trust.beta.body' => 'People use it every day, but it\'s still early and changes often. Windows shows a warning when you run the installer, because it isn\'t code-signed yet.',

    'home.trust.honest.title' => 'No way to connect works forever',
    'home.trust.honest.body' => 'No one can promise that a particular way to connect will keep working on a network that blocks VPNs. That\'s why the app has several and switches between them by itself.',

    // -----------------------------------------------------------------
    // Home — closing
    // -----------------------------------------------------------------

    'home.pricing.link' => 'Compare all plans',
    'home.faq.link' => 'See all questions',

    // =================================================================
    // Features page
    // =================================================================

    'meta.features.title' => 'Neoxify features | Staying connected, split tunnelling',
    'meta.features.description' => 'The app has several ways to connect and picks one that works on your network. Choose which apps use the VPN. Servers in Europe and Asia.',

    'features.title' => 'What the app does',
    'features.subtitle' => 'Everything on this page works today. If a feature is only on some platforms, we say so.',
    'features.eyebrow' => 'Features',

    'features.protocols.title' => 'Several ways to connect',
    'features.protocols.body' => 'The app has several ways to connect, and some of them look like ordinary web traffic. Networks block them in different situations, which is why having more than one matters. The app picks one that works on your network and moves to another if it stops working.',

    'features.failover.title' => 'If one stops working, it switches and checks again',
    'features.failover.body' => 'If your current way to connect stops getting through, the app moves to another. Before it shows Connected, it checks that traffic reaches the internet through the new connection.',

    'features.split.title' => 'Choose which apps use the VPN',
    'features.split.body' => 'In Custom mode you choose which apps use the VPN, and everything else keeps your normal connection. You choose by app, not by website, so your browser and a game can take different paths.',
    'features.split.platforms' => 'Available on Windows and Android. Not on iOS, because Apple only allows per-app VPN on devices managed by an organisation, so no consumer app can offer it.',

    'features.relay.title' => 'A plan for the most restricted networks',
    'features.relay.body' => 'On some networks, a direct connection abroad doesn\'t hold at all. The Ultimate plan has backup routes made for that.',

    'features.locations.title' => 'Choose a country',
    'features.locations.body' => 'Change the country in the app as often as you like.',

    'features.dns.title' => 'DNS and IPv6 on Windows',
    'features.dns.body' => 'On Windows, the app sets DNS for the VPN itself, so lookups don\'t go out over your normal connection. IPv6 is blocked instead of being sent unprotected, and the app tells you so.',

    'features.usage.title' => 'See how much data you\'ve used',
    'features.usage.body' => 'The app shows how much data your account has used. Renewing or upgrading your plan applies right away, without dropping your connection.',

    'features.support.title' => 'Support inside the app',
    'features.support.body' => 'You message support from inside the app, and we can see your account, so you don\'t have to explain it. For every payment, by card or crypto, you get an invoice you can open and print.',

    'features.uses.eyebrow' => 'Who uses it',
    'features.uses.title' => 'For everyday use on restricted networks',
    'features.uses.body' => 'Most people use it for ordinary things that a restricted network makes hard: reading, watching videos, messaging, working and playing games. Gaming is just one of them.',

    // =================================================================
    // Pricing page
    // =================================================================

    'meta.pricing.title' => 'Neoxify VPN plans and prices',
    'meta.pricing.description' => 'Compare Neoxify plans. Two with unlimited data, and one with backup routes for the most restricted networks. Pay by international card or crypto.',

    'pricing.title' => 'Plans',
    'pricing.subtitle' => 'Every plan includes every way to connect and every server country, unless the plan says otherwise. Buy in the app or in your account area.',

    'pricing.compare.title' => 'Compare the plans',
    'pricing.compare.feature' => 'Features',
    'pricing.compare.hint' => 'Scroll the table sideways to see every plan.',
    'pricing.compare.data' => 'Data',
    'pricing.compare.devices' => 'Devices at once',
    'pricing.compare.routes' => 'Routes',
    'pricing.compare.locations' => 'Countries',
    'pricing.compare.protocols' => 'Ways to connect',
    'pricing.compare.support' => 'In-app support',
    'pricing.compare.routes_standard' => 'Standard',
    'pricing.compare.routes_relay' => 'Backup routes only',
    'pricing.compare.locations_all' => 'All',
    'pricing.compare.locations_relay' => 'Some',
    'pricing.compare.protocols_all' => 'All',

    // Trial, which is granted rather than sold. It exists in the plans
    // table with a price on it, but isPurchasable is false -- it is what a
    // new account starts on, not a tier you buy. Presenting it as a
    // purchasable plan would send people looking for a checkout that does
    // not exist for it.
    'pricing.trial.title' => 'Every new account starts with a free trial',
    'pricing.trial.body' => 'You don\'t need a payment method to start. Create an account in the app, confirm your email and connect. You can see whether it works on your network before you pay anything.',

    'pricing.payment.title' => 'How to pay',
    'pricing.payment.body' => 'Pay by international card or crypto, in the app. Local bank cards aren\'t accepted, so if your card doesn\'t work abroad, pay with crypto. You get an invoice for every payment, which you can open and print.',

    'pricing.refund.title' => 'Before you buy',
    'pricing.refund.body' => 'Use the free trial to check that it works on your network before you pay. We don\'t have a written money-back guarantee, so we won\'t promise one. If something goes wrong, contact support and we\'ll talk it through.',

    'pricing.voucher.title' => 'Bought from a reseller?',
    'pricing.voucher.body' => 'Enter your voucher code in the app or in your account area. A valid code activates the plan right away, with no payment step.',

    // =================================================================
    // FAQ page
    // =================================================================

    'meta.faq.title' => 'Neoxify VPN | Frequently asked questions',
    'meta.faq.description' => 'Answers about devices, payment, data, server countries, blocked networks and voucher codes, before you sign up for Neoxify.',

    'faq.title' => 'Frequently asked questions',
    'faq.subtitle' => 'If your question isn\'t here, use the contact form. A person will reply.',
    'faq.still.title' => 'Didn\'t find your answer?',
    'faq.still.body' => 'Write to us and a person will reply. If you have an account, support in the app is faster, because we can see your account there.',

    // Renamed from 'relay_gaming'. Same plan, same route; the line no
    // longer leads with a gaming claim, for the reason set out in the
    // positioning note above.
    'home.pricing.relay_filtered' => 'For the most restricted networks',


    // -----------------------------------------------------------------
    // Features page — diagrams, examples and remaining labels
    // -----------------------------------------------------------------


    'features.failover.diagram_alt' => 'A blocked connection method, an automatic switch to another, a check that traffic is really flowing, and only then a connected state.',
    'features.failover.step_blocked' => 'Route stops getting through',
    'features.failover.step_switch' => 'Switches method',
    'features.failover.step_verify' => 'Checks traffic really flows',
    'features.failover.step_connected' => 'Reports connected',

    // Categories rather than named applications: naming them would be an
    // endorsement, and every specific name dates.
    'features.split.example.browser.title' => 'Your browser on the VPN',
    'features.split.example.browser.body' => 'Open sites through a server abroad.',
    'features.split.example.game.title' => 'Games on the path that works best',
    'features.split.example.game.body' => 'Put a game on the VPN or leave it on your own connection, whichever works better with that game\'s servers.',
    'features.split.example.stream.title' => 'Streaming apps',
    'features.split.example.stream.body' => 'Put the ones that need another country on the VPN and leave the rest as they are.',
    // The single most searched-for symptom in this market, named by the
    // problem people actually describe rather than by the feature. See the
    // Persian string for this key -- it is the one that matters.
    'features.split.example.bank.title' => 'Local banking and government sites',
    'features.split.example.bank.body' => 'These often refuse foreign addresses, so they may not open with the VPN on. Leave your banking app, or a second browser, off the VPN and they work as usual.',

    'features.relay.link' => 'See the Ultimate plan',

    'features.more.title' => 'More features',

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
    'home.config.title' => 'Just sign in and connect',
    'home.config.body' => 'Many VPN sellers give you a config or subscription link to paste into another app. When the link stops working, you have to ask for a new one. Neoxify is its own app. You sign in, and it gets what it needs and keeps it up to date. There\'s nothing to copy, scan or replace.',
    'home.config.point1' => 'No config or subscription link to import',
    'home.config.point2' => 'No other app to install first',
    'home.config.point3' => 'Server addresses update by themselves',


    // -----------------------------------------------------------------
    // The Ladder rebuild (2026-08): the frame, the interactive panel,
    // the specimen verdicts, the straight-answers block and the close.
    //
    // The instrument copy is deliberately free of any timing, speed or
    // success-rate figure, and home.inst.note states plainly that the
    // panel is an illustration rather than a live status board.
    // -----------------------------------------------------------------

    'rail.tagline' => 'A VPN for filtered networks',
    'home.hero.chip_noconfig' => 'No config files or subscription links',
    'home.hero.chip_locations' => 'Servers in Europe and Asia',
    'home.mockup.disconnect' => 'Disconnect',
    'home.mockup.note' => 'Illustration of the app. The time shown is an example.',
    'home.answers.eyebrow' => 'Fine print',
    'home.answers.title' => 'Things we won\'t claim',
    'home.answers.body' => 'Many VPN sites say these. Here\'s why we don\'t.',
    'home.answers.1.claim' => 'No logs',
    'home.answers.1.lead' => 'Our servers keep connection logs.',
    'home.answers.1.say' => 'Billing records how much data you use, as a number of bytes. The servers also keep the usual operational logs, and these can include connection records. We use them to run the service and fix problems. We don\'t use them to profile you, and we don\'t sell them.',
    'home.answers.2.claim' => 'Undetectable',
    'home.answers.2.lead' => 'No connection is undetectable.',
    'home.answers.2.say' => 'Our connection is hard to tell apart from an ordinary visit to a website. That\'s different from undetectable, and claiming it would give you false confidence.',
    'home.answers.3.claim' => 'Signed installer',
    'home.answers.3.lead' => 'The Windows installer isn\'t signed yet.',
    'home.answers.3.say' => 'The first time you run it, Windows may show a blue “Windows protected your PC” screen. Click More info, then Run anyway. We plan to buy a signing certificate, and this note stays here until we do.',
    'home.answers.4.claim' => 'Works everywhere',
    'home.answers.4.lead' => 'In restricted countries, some ways to connect are often blocked, and none works everywhere.',
    'home.answers.4.say' => 'We keep all of them, because what gets blocked changes from week to week.',
    'home.answers.5.claim' => 'Available on iOS',
    'home.answers.5.lead' => 'There\'s no iOS app.',
    'home.answers.5.say' => 'There are apps for Windows and Android. We won\'t give a date for iOS until the app exists. When it does, it won\'t have Custom mode, because iOS doesn\'t let an app choose which other apps use the VPN.',
    'home.close.eyebrow' => 'Get started',
    'home.close.point1.term' => 'Windows and Android.',
    'home.close.point1.rest' => 'No iOS app yet.',
    'home.close.point2.term' => 'Unsigned installer.',
    'home.close.point2.rest' => 'Windows warns you the first time.',
    'home.close.point3.term' => 'Connection logs are kept.',
    'home.close.point3.rest' => 'We don\'t claim "no logs".',
    'home.close.warn' => 'You don\'t need to pay to start. Every new account begins with a free trial.',

    // 2026-10 pearl-glass redesign. The tagline is the app's own (owner-approved 2026-10-18).
    'nav.main_label' => 'Main',
    'home.hero.kicker' => 'A VPN for restricted networks',
    'home.hero.tagline_1' => 'Your internet.',
    'home.hero.tagline_2' => 'Without limits.',
    'home.locations.legend_exit' => 'Server country',
    'home.security.diagram.alt' => 'Your device connects to our servers over an encrypted connection. From our servers, your traffic goes out to the internet like any other traffic.',

    'delete.or' => 'or',
    'download.platforms_heading' => 'Choose your platform',
    // 2026-10 rework: the theme switch and the app showcase.
    'theme.dark' => 'Dark theme',
    'home.app.eyebrow' => 'The app',
    'home.app.title' => 'Everything is in the app',
    'home.app.body' => 'Sign up, buy a plan, pick a country and talk to support, all in the app. There\'s nothing else to install.',
    'home.app.caption' => 'A real screenshot of the Android app while connected. The account, usage and address in it are examples.',
    'home.app.alt' => 'Screenshot of the Neoxify Android app connected to Germany, with a Disconnect button below a dotted world map.',
    'home.app.alt_dark' => 'Screenshot of the Neoxify Android app in dark theme, connected to Germany, with a Disconnect button below a dotted world map.',
    'home.app.link' => 'See all features',
    'home.app.float.1.title' => 'Finds a way to connect',
    'home.app.float.1.sub' => 'on your network, on its own',
    'home.app.float.2.title' => 'Switches on its own',
    'home.app.float.2.sub' => 'when one way stops working',
    'home.app.float.3.title' => 'Checks first',
    'home.app.float.3.sub' => 'before it says Connected',
    'home.app.float.4.title' => 'Nothing to paste',
    'home.app.float.4.sub' => 'no config files or links',
    // The route finder (inc/partials/route-finder.php). Abstract by rule:
    // never a method, port, transport, route, or a count of any of them.
    'route.you' => 'You',
    'route.internet' => 'The internet',
    'route.state.finding' => 'Looking for a way to connect…',
    'route.state.blocked' => 'Blocked. Trying another way…',
    'route.state.checking' => 'Checking that traffic gets through…',
    'route.state.done' => 'Connected and checked',
    'route.replay' => 'Play again',
    'route.caption' => 'An illustration of what the app does on its own. When one way to connect is blocked, it moves to another, and it says Connected only after checking that traffic gets through.',
    'home.quote' => 'The app says Connected only after your traffic gets through.',
    'home.quote.by' => 'The rule the app follows',
);
