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
    'brand.tagline' => 'Fast, hard to block, built for gamers.',

    'nav.home' => 'Home',
    'nav.features' => 'Features',
    'nav.pricing' => 'Plans',
    'nav.download' => 'Download',
    'nav.contact' => 'Contact',
    'nav.reseller' => 'Resellers',
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

    'meta.home.title' => 'Neoxify — a VPN built for gamers on restricted networks',
    'meta.home.description' => 'Encrypted, low-latency connections built for gaming on networks that filter heavily. One app, several ways to connect, and no configuration files to import.',

    'meta.download.title' => 'Download — Neoxify',
    'meta.download.description' => 'Get the Neoxify app for Windows. macOS, Android and iOS are in development.',

    'meta.contact.title' => 'Contact — Neoxify',
    'meta.contact.description' => 'Questions about Neoxify? Send us a message and we will get back to you.',

    'meta.reseller.title' => 'Become a reseller — Neoxify',
    'meta.reseller.description' => 'Apply to resell Neoxify. Terms are agreed individually with every partner.',

    // -----------------------------------------------------------------
    // Home — hero
    // -----------------------------------------------------------------

    'home.hero.eyebrow' => 'Encrypted. Stable. Hard to block.',
    'home.hero.title' => 'Low latency. Hard to block.',
    'home.hero.title_accent' => 'Built for gamers.',
    'home.hero.subtitle' => 'Your traffic is encrypted the moment it leaves your device, carried across servers we run ourselves, and built to keep working on networks that try hard to shut connections like this down.',
    'home.hero.cta_primary' => 'Download for Windows',
    'home.hero.cta_primary_soon' => 'See download options',
    'home.hero.cta_secondary' => 'See plans',
    'home.hero.note_available' => 'Windows app available now. macOS, Android and iOS are in development.',
    'home.hero.note_soon' => 'Windows app releasing soon. macOS, Android and iOS are in development.',

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

    'home.mockup.alt' => 'The Neoxify app running on Windows, with mobile and macOS versions still in development.',
    'home.mockup.windows' => 'Windows',
    'home.mockup.mobile' => 'Mobile',
    'home.mockup.macos' => 'macOS',
    'home.mockup.soon' => 'Soon',
    'home.mockup.subscription' => 'Subscription',
    'home.mockup.status' => 'Active',
    'home.mockup.expires' => 'Renews in 24 days',
    'home.mockup.used' => '84 GB of 300 GB used',
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
    'home.pricing.data' => ':amount of data',
    'home.pricing.data_period' => ':amount every :days days',
    'home.pricing.connections' => 'Up to :count devices connected at once',
    // Renamed from all_protocols: the site deliberately does not name the
    // protocols it runs on, and a key called "protocols" invites someone to
    // "fix" the copy by putting them back.
    'home.pricing.all_modes' => 'Every connection option included',
    'home.pricing.all_locations' => 'Every server location',
    'home.pricing.relay_routes' => 'Optimised routes for restricted networks',
    'home.pricing.support' => 'Support directly in the app',
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
    'download.subtitle' => 'One installer. The app handles accounts, plans and connections itself — there is nothing else to install alongside it.',

    'download.windows.name' => 'Windows',
    'download.windows.requirements' => 'Windows 10 or 11, 64-bit',
    'download.windows.version' => 'Version :version',
    'download.windows.button' => 'Download for Windows',
    'download.windows.checksum' => 'SHA-256 checksums',

    'download.unreleased.badge' => 'Releasing soon',
    'download.unreleased.title' => 'The Windows installer is not published yet',
    'download.unreleased.body' => 'The app is built and tested — we are finishing the release packaging. If you would like to be told the moment it goes out, send us a message and we will let you know.',
    'download.unreleased.cta' => 'Tell me when it is out',

    'download.unsigned.title' => 'About the warning Windows will show you',
    'download.unsigned.body' => 'The installer is not code-signed yet, so Windows SmartScreen may show a blue "Windows protected your PC" screen the first time you run it. Choose More info, then Run anyway. A signing certificate is on the list before public launch; until then you can verify the download yourself against the published SHA-256 checksum.',

    'download.steps.title' => 'Installing',
    'download.steps.1' => 'Run the installer. It installs for your user account only and does not ask for administrator rights.',
    'download.steps.2' => 'Open Neoxify and create your account, or sign in if you already have one.',
    'download.steps.3' => 'Confirm your email address with the code we send you.',
    'download.steps.4' => 'Choose a location and connect. Windows will ask for permission the first time a tunnel is created.',

    'download.other.title' => 'Other platforms',
    'download.other.body' => 'These are in development. We would rather ship them properly than ship them early.',
    'download.other.macos' => 'macOS',
    'download.other.android' => 'Android',
    'download.other.ios' => 'iOS',
    'download.other.status' => 'In development',

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
    // Errors
    // -----------------------------------------------------------------

    'meta.404.title' => 'Page not found — Neoxify',
    'meta.404.description' => 'That page does not exist.',
    'error.404.code' => '404',
    'error.404.title' => 'That page does not exist',
    'error.404.body' => 'The link may be out of date, or there may be a typo in the address. The pages below definitely work.',
    'error.404.home' => 'Back to the home page',
);
