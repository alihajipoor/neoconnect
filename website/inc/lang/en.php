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

    'brand.name' => 'NeoConnect',
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
    'footer.rights' => '© :year NeoConnect. All rights reserved.',
    'footer.note' => 'NeoConnect is a commercial VPN service. Use it in line with the laws that apply to you.',
    'footer.github' => 'Source on GitHub',

    'skip_to_content' => 'Skip to content',

    // -----------------------------------------------------------------
    // Page metadata
    // -----------------------------------------------------------------

    'meta.home.title' => 'NeoConnect — a VPN built for gamers on restricted networks',
    'meta.home.description' => 'WireGuard, VLESS+REALITY and OpenVPN in one app, with relay routes designed for networks that filter VPN traffic. Low latency, no configuration files.',

    'meta.download.title' => 'Download — NeoConnect',
    'meta.download.description' => 'Get the NeoConnect app for Windows. macOS, Android and iOS are in development.',

    'meta.contact.title' => 'Contact — NeoConnect',
    'meta.contact.description' => 'Questions about NeoConnect? Send us a message and we will get back to you.',

    'meta.reseller.title' => 'Become a reseller — NeoConnect',
    'meta.reseller.description' => 'Apply to resell NeoConnect. Terms are agreed individually with every partner.',

    // -----------------------------------------------------------------
    // Home — hero
    // -----------------------------------------------------------------

    'home.hero.eyebrow' => 'Three protocols. One app.',
    'home.hero.title' => 'Low latency. Hard to block.',
    'home.hero.title_accent' => 'Built for gamers.',
    'home.hero.subtitle' => 'NeoConnect runs WireGuard, VLESS+REALITY and OpenVPN across servers we operate ourselves — with routes designed for networks that actively look for VPN traffic and shut it down.',
    'home.hero.cta_primary' => 'Download for Windows',
    'home.hero.cta_primary_soon' => 'See download options',
    'home.hero.cta_secondary' => 'See plans',
    'home.hero.note_available' => 'Windows app available now. macOS, Android and iOS are in development.',
    'home.hero.note_soon' => 'Windows app releasing soon. macOS, Android and iOS are in development.',

    // -----------------------------------------------------------------
    // Home — features
    // -----------------------------------------------------------------

    'home.features.eyebrow' => 'Why NeoConnect',
    'home.features.title' => 'The parts that actually matter when a network is against you',

    'home.features.protocols.title' => 'Three protocols, one account',
    'home.features.protocols.body' => 'WireGuard for raw speed, VLESS+REALITY for when a network is hunting for VPN traffic, OpenVPN when you need the most compatible option available. Switch between them without buying anything extra.',

    'home.features.reality.title' => 'REALITY camouflage',
    'home.features.reality.body' => 'Your connection presents itself as an ordinary HTTPS session to a real, unrelated website. There is no distinctive VPN handshake sitting there waiting to be fingerprinted.',

    'home.features.relay.title' => 'Routes built for restricted networks',
    'home.features.relay.body' => 'Connect to a nearby relay server that chains onward to an exit abroad. You get a first hop your network can actually reach, without giving up the destination you wanted in the first place.',

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
    // Home — technology
    // -----------------------------------------------------------------

    'home.tech.eyebrow' => 'Under the hood',
    'home.tech.title' => 'No invented protocols',
    'home.tech.body' => 'NeoConnect is built on the same proven, open cores the rest of the industry relies on. The engineering effort goes into routing, delivery and keeping your session alive — not into a homemade encryption scheme nobody has reviewed.',

    'home.tech.wireguard.title' => 'WireGuard',
    'home.tech.wireguard.body' => 'A small, modern, heavily audited tunnel. The fastest option when the network in front of you is not filtering aggressively.',

    'home.tech.reality.title' => 'VLESS + REALITY',
    'home.tech.reality.body' => 'Built on Xray-core. Borrows a real website\'s TLS identity so the traffic has nothing unusual to detect. This is the option to reach for when everything else gets blocked.',

    'home.tech.openvpn.title' => 'OpenVPN',
    'home.tech.openvpn.body' => 'The most widely supported VPN protocol there is, with per-account certificates. The dependable fallback when a network mishandles anything newer.',

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
    'home.pricing.all_protocols' => 'All three protocols included',
    'home.pricing.all_locations' => 'Every server location',
    'home.pricing.relay_routes' => 'Relay routes for restricted networks',
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
    'home.cta.button' => 'Get NeoConnect',

    // -----------------------------------------------------------------
    // Download
    // -----------------------------------------------------------------

    'download.title' => 'Download NeoConnect',
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
    'download.steps.2' => 'Open NeoConnect and create your account, or sign in if you already have one.',
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

    'meta.404.title' => 'Page not found — NeoConnect',
    'meta.404.description' => 'That page does not exist.',
    'error.404.code' => '404',
    'error.404.title' => 'That page does not exist',
    'error.404.body' => 'The link may be out of date, or there may be a typo in the address. The pages below definitely work.',
    'error.404.home' => 'Back to the home page',
);
