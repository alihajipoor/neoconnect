# Neoxify marketing website

Plain PHP, HTML and CSS. No build step, no Composer, no database, no
`mod_rewrite` dependency. Zip it, unzip it into `public_html`, and it works.

This is deliberately **not** part of the pnpm workspace — it is not in
`apps/`, nothing in `pnpm-workspace.yaml` matches it, and neither `turbo` nor
CI touches it. It shares no files with the rest of the monorepo.

## What the site is for

Marketing, download links, Contact Us, and reseller applications. It is not a
customer portal: signup, login, purchase and support all happen inside the
native apps, so there is no auth, no account area and no session state here.

## The 2026-10 redesign: pearl glass

The site wears the look the apps are moving to (owner-approved 2026-10-18):
pearl light by default, "smoked" dark when the visitor's system asks for it,
cobalt for the one primary action, frosted glass only for floating controls
(the header, the app illustration, the form cards), the app's tagline
("Your internet. / Without limits."), and the app's dotted world map with a
light on each country that has servers. Every colour is the app's own token
(`assets/css/base.css` lists them; they come from the app's
`design-system.md`). **Not deployed** -- it is on `claude/website-redesign`
for the owner to look at first.

### The 2026-10-22 rework: a light/dark switch and an identity of its own

Owner feedback on the first pass: no light/dark switch, "the same as you'd
give everyone else", no background but the world map, the old ring instead
of the real logo. What changed, still in the app's language:

- **A light/dark switch** in the header (a button with `aria-pressed`, a
  fixed label, en and fa). It sets a `theme` cookie; `head.php` reads it and
  writes `data-theme` on `<html>`, one `theme-color` and one `color-scheme`,
  so the first paint is already right -- no flash, no script on the way.
  Without the cookie the page follows `prefers-color-scheme`. The dark theme
  is written once in `base.css` as `:root[data-theme="dark"]` rules and
  `nx_css_bundle()` repeats them inside the media query (see the THEMES note
  at the top of `base.css`). Without JavaScript there is no button.
- **The app's glass logo**, the exact files from
  `apps/web-portal/src/auth/` (`assets/img/brand/`), inlined once per page as
  two `<symbol>`s and used by `<use>` in the header, the footer, the home
  hero and the closing card. The favicons, touch icon, `logo-512.png` and the
  social cards (now `-v4`) are rendered from the same file.
- **A living background on every page**: three slow aurora lights over a
  faint grid (`.sky`, fixed, gradients only), and the dotted world with its
  lights and light lines (`inc/partials/world.php`) behind the home hero and
  every page title. Only `transform` and `opacity` animate; all of it stops
  under `prefers-reduced-motion`. No WebGL, no canvas, no animation script.
- **Depth**: cards are layered gradients with a lit rim and a long drop, the
  alternate sections are raised slabs with a line of the brand's light, and
  sections rise into place with CSS scroll-driven animations under
  `@supports (animation-timeline: view())` -- elsewhere they are simply there.
- **The real app**: a real Android screenshot (the Play listing's, 1080 x
  1920, resized to 300/450/600 px WebP in `assets/img/app/`) in a phone,
  lazy-loaded, one per theme.

Honesty notes that come with it:

- The phone is a **real screenshot**, captioned as one: the account, the
  usage and the address on it are a demo account's (the address is a
  documentation range), and the caption says they are examples. The method
  label under the country and the idle light the app draws at the relay
  entry were painted out of it (2026-10-23, see the conventions below). The
  tags floating round it say what the app does for you, never how.
- The map lights say only "there are servers in this country". The light
  lines join the lights west to east: they are drawing, not routes. Nothing
  blinks as if it were measured: on a website there is no evidence about the
  visitor's network to light anything with.

### The 2026-10-23 round: motion, gadgets, an art direction of its own

Owner: push the style further, add transitions and animation, "not plain,
not overwhelming", and nothing that reads as a generated template. What
was added, and the rules it keeps:

- **The route finder** (`inc/partials/route-finder.php`), on the home and
  features pages, replacing what the method table gave visually: abstract,
  unlabelled paths from "You" to "The internet"; one lights and meets a
  wall and fades, another takes over, a ring turns while the app checks,
  and only then the tick and "Connected, checked". **No method, port,
  transport, route or count is named or implied** -- the paths are drawing.
  CSS animation (one 13-second cycle), run by `site.js` only while it is
  on screen, with a Play again button. Without the script or under reduced
  motion it shows its final frame.
- **Art direction**: an editorial type scale (page and section titles step
  up to 104/76 px, set tight), section labels as a numbered rule of the
  brand's gradient -- the one accent, used the same way everywhere -- and
  layouts that change shape section to section (5:7 splits, a sticky
  title, a bento, a ledger of hairline rows, one sentence of the product's
  own set large) instead of rows of equal cards. A film grain
  (`assets/img/grain.svg`, 369 bytes) sits on the fixed sky under the glass.
- **Motion and micro-interactions**: cross-document view transitions (the
  header bar and the logo stay put), a scroll-progress hairline on the bar
  (scroll-driven, no script), a light that follows the cursor over cards
  and plans, a slight pointer tilt on the hero logo and the phone, a
  magnetic pull of at most 6 px on the two big primary buttons, a pressed
  state on every button, the FAQ answer settling in when opened, plans
  lifting on hover, and the location map: hover or tab to a light, or
  point at a country in the list, and it lights and names itself.
- **Restraint**: one thing moves per screen. Nothing on a map moves by
  itself any more (no pings, no glints); the notes round the phone are
  still; the hero keeps only the logo's slow orbit.
- **Rules kept**: only `transform` and `opacity` animate; pointer effects
  are for a fine pointer only and write custom properties through the
  CSSOM (the CSP still forbids style attributes); everything stops under
  `prefers-reduced-motion`, and nothing needs JavaScript to be readable.

### Performance, measured not assumed

- **No render-blocking request.** Each page's CSS (`assets/css/base.css` +
  `blocks.css` + the page's own module) is read by `head.php`, stripped of
  comments and inlined in one `<style>`. There is no stylesheet link.
- **At most two font files, preloaded per locale**: Inter Tight + Inter on
  English pages, Vazirmatn alone on Persian ones (see
  `assets/fonts/README.txt`). `font-display: swap`, with metric-matched
  local fallbacks so the swap does not move anything.
- **One tiny inline script** (the "loader") flips `no-js` to `js` before the
  first paint and adds `assets/js/site.js` asynchronously. Nothing on the
  site needs JavaScript.
- **One raster image, below the fold, lazy.** The app screenshot on the
  home page, sized by `srcset` (300/450/600 px WebP, 13-37 KB) and fetched
  only for the theme on screen. Everything else is HTML, CSS and SVG (the
  map as a CSS mask, one cached request for the whole site; the logo as an
  inline sprite).

Lighthouse scores for this branch were measured on a **local preview**,
mobile and desktop, English and Persian -- not on the live host. Since
2026-10-19 that preview imitates the live shared host as measured (its
fallback to `/index.php`, gzip only, its four headers, and static files
with only an ETag and Last-Modified); before that it imitated
`nginx-website.conf.example`, with brotli and a year's cache, which the
host does not have. The numbers and reports are in the branch's write-up,
not here, because they go stale. **After deploying, run PageSpeed
Insights on the live URLs** -- that is the measurement that counts.

**Caching on the live host.** The shared nginx sends fonts, `site.js`,
the map and the images with an ETag and Last-Modified but no
`Cache-Control` or `Expires`, so browsers fall back to heuristic
caching and revalidate sooner than they need to. The files are already
safe to cache for a year (their names or a `?v=` stamp change when they
do). Ask the host operator whether the hosting panel allows **per-site**
directives -- `Cache-Control: public, max-age=31536000, immutable` on
`/assets/` -- and if it does not, accept heuristic caching. Nothing
server-wide.

### Security headers

The live host is a **shared box** (owner, 2026-10-19): it serves other
sites and a hosting panel, and its nginx is not ours to configure. So the
headers come from PHP, `inc/headers.php`, on **every** response it makes
-- pages, redirects, the sitemap and the 404 -- with one rule: **never a
header twice.**

That nginx already adds four headers to every response, PHP's included
(measured 2026-10-19): `Strict-Transport-Security: max-age=31536000;
includeSubDomains`, `X-Frame-Options: SAMEORIGIN`,
`X-Content-Type-Options: nosniff` and `Referrer-Policy:
strict-origin-when-cross-origin`. `inc/config.php` lists them as
`headers_sent_by_server` and PHP skips exactly those. PHP sends the rest:
`Permissions-Policy`, `Cross-Origin-Opener-Policy`,
`Cross-Origin-Resource-Policy`, and a Content-Security-Policy with **no**
`'unsafe-inline'` and **no** `'unsafe-eval'`: the inline stylesheet and
the loader are each allowed by their SHA-256, computed from the exact
bytes the page emits, plus `'strict-dynamic'`, `object-src 'none'`,
`base-uri 'none'`, `frame-ancestors 'none'`. (`frame-ancestors` is what
current browsers obey, so the host's SAMEORIGIN does not weaken framing
protection.) On a host that sends none of the four, empty the list and
PHP sends the full set, its own HSTS being two years with
`includeSubDomains`.

**HSTS is not preload-ready, on purpose.** The `preload` token is the
signal hstspreload.org acts on, and its form does not check who owns the
domain; inclusion locks HTTPS onto neoxify.net and every name under it in
shipped browsers and takes months to undo. It goes back in (`headers.php`,
`.htaccess`, the nginx example) only when the owner decides to submit,
after confirming every neoxify.net name serves HTTPS -- and the host's own
HSTS header would then need the same change.

**After every deploy, look at the headers of a real response** (a page
and a static file). `headers_sent_by_server` describes a server we do
not control; if the host changes, so must the list.

`.htaccess` unsets PHP's copies and sets the fixed set once, for Apache.
`nginx-website.conf.example` is kept for the day the site has a server of
its own; it is **not** for today's host.

### Structured data

`inc/partials/schema.php` describes only what can be checked against the
product. Two consequences worth knowing before opening Search Console:

- **The two SoftwareApplication nodes will be listed as invalid** in the
  "Software apps" report. Google shows that rich result only with an
  `aggregateRating` or a `review`, and there are no reviews. That stays
  true until real ones exist. Never add a rating to clear the report.
- The Organization and the WebSite are one entity each, on every page in
  both languages: named "Neoxify" with the Persian name as
  `alternateName`. The Product and the apps are described in the page's
  language, under a per-locale `@id`.

## Before it goes live

These need a decision or an action from you. The site runs without them,
but it will say the wrong thing, or less than it could, until they are
done.

| What | Where | Why |
|---|---|---|
| **Check the live responses** | -- | Routing (real 404s, `/sitemap.xml`, `/r/CODE`, `www.` to the apex) is done in PHP and was tested on a preview that imitates the shared host, not on the host. After deploying, check each of those URLs and the headers of a page and a static file. |
| **Download links from Iran** | `inc/config.php` | `windows_installer_url` and `android_installer_url` point at connect.neoxify.site, and neoxify.site is recorded as blocked as a whole in Iran (DNS injection and SNI resets). A visitor there without a VPN reaches the page and the download fails. Serving the installers from neoxify.net itself, or from a domain not blocked there, is your call; either way it stays unverified until testers inside Iran confirm it. |
| **"Without limits." beside capped plans** | `inc/lang/*.php` | The app's tagline, approved 2026-10-18, is the h1 and is on the social cards. On a sales page whose plans are capped (one device, two devices, 30 GB), a reader can take it as a promise. Keep it, or qualify it in the hero lede; the plan copy states the limits plainly either way. |
| **Static caching** | the host | See *Caching on the live host* above: ask whether per-site `Cache-Control` on `/assets/` is allowed. |
| **Real prices** | `inc/content/plans.php` | Reconciled against the panel's `subscription_plans` table on 2026-08-24 — Ultimate was live at the wrong price with a dead button. Nothing enforces the match, so change this file in the same sitting you change a plan in the panel. |
| **Persian review** | `inc/lang/fa.php` | The translation was drafted, not written by a native speaker. Any line you delete falls back to English automatically, so it is safe to remove one you don't like. |
| **Send a real test message** | — | Submit the contact form once on the live host and confirm it reaches `info@neoxify.com` — including checking the spam folder. See the domain-split note below for why this needs verifying rather than assuming. |
| **Feature switches** | `inc/config.php` | `free_trial_enabled` and `referrals_enabled` both default to **off**, because their panel settings do too. Turn each on here only once it is genuinely running in the panel. |

## The download page

The download button points at one URL that should never need editing:

```php
'windows_installer_url' => 'https://connect.neoxify.site/api/updates/installer/windows',
```

That is a control-plane endpoint which redirects to the current release's
installer, resolving through the same code the in-app updater uses. The
download link and the update path therefore cannot disagree about what the
current version is.

**The page holds no version number and no release tag**, deliberately. Anything
printed beside a rolling link can only go stale, and that is not hypothetical
here — read on.

### Why it is not a pinned tag (learned the hard way)

This page originally pinned `desktop-v0.9.0`. Every asset URL was verified
`200` at the time, so it looked correct. It wasn't: that tag was mislabelled
and its payload was the older `0.8.0` build, while the real current release was
`0.8.6`. The site spent days handing every visitor the worst build we had
shipped, and nobody went back to check, because a pinned link that resolves
looks fine forever.

`/releases/latest/download/…` is not the fix either — "latest" spans every tag
in the repository, including agent releases, so it breaks the first time a
non-desktop release is newer.

### Android

Same arrangement, its own endpoint:

```php
'android_installer_url' => 'https://connect.neoxify.site/api/updates/installer/android',
```

**One real difference, and the page reflects it.** The desktop build carries
`tauri-plugin-updater` and updates itself; the Android build does not. So the
Android card says to come back here for new versions, and the "this is the
only download you will need" notice carries an explicit Android exception.
Don't merge those into one cheerful claim unless the Android app gains an
updater.

Android also downloads as an APK rather than a Play Store install, so the page
explains the "allow installs from this source" prompt up front. Somebody who
meets that warning without being told reasonably assumes the file is suspect
and stops.

### Automatic language

Someone in Iran lands on Persian without doing anything; everyone else lands
on English; either can switch and have it stick. `inc/locale.php` decides, in
this order:

1. **An explicit choice.** The language switch sets a `nx_lang` cookie, and
   that beats everything. Overriding someone's stated preference with a guess
   is the one unforgivable behaviour here.
2. **A country header**, if the host or a CDN adds one — `CF-IPCountry` and
   several other common names are checked. Shared hosting often sends none,
   which is why it isn't the only signal. **Putting the site behind Cloudflare
   would make this considerably more accurate**, at no cost to anything else.
3. **`Accept-Language`.** Every browser sends it and it needs no lookup.

Deliberately not used: a third-party geolocation API. The site makes no
external requests, and a blocking call to someone else's server on every page
render — for an audience whose networks are the reason this product exists —
is a bad trade.

Two rules keep the redirect from being irritating, both worth preserving:

- It only redirects **away from the English URLs**, never away from `/fa/`.
  A Persian link someone shared is an explicit request for Persian.
- It stops entirely once the cookie exists.

The redirect is a **302**, never 301: it depends on who is asking, so it must
not be cached as a permanent property of the URL. Responses carry
`Vary: Accept-Language, Cookie` for the same reason. `sitemap.php` and
`404.php` opt out via `$NX_SKIP_LOCALE_REDIRECT`.

**This and the theme cookie are the site's only cookies**, and the privacy
statement describes both (the theme cookie holds `light` or `dark` and is
set only by the switch in the header). It
holds one word, identifies nobody, and needs no consent banner because
remembering a preference someone deliberately asked for is exempt. If you ever
add a second cookie, that page has to change.

### Beta phase

`beta_enabled` drives three things at once — a badge beside the wordmark, a
line in the hero, and an explanation on the download page. Set it to `false`
when the product leaves beta and all three disappear together.

### Other download settings

- `windows_checksums_url` is empty by default. A checksum pinned to one release
  would eventually describe a different file than the one a visitor just
  downloaded — worse than publishing none. Fill it in only if you publish a
  checksum list that tracks the current release. While empty, the link is
  simply not rendered.
- Emptying `windows_installer_url` flips the page back to an honest "not
  released yet" panel with a "tell me when it's ready" link.
- Set `windows_unsigned` to `false` once a signing certificate exists, which
  removes the SmartScreen explainer.

## Deploying

```bash
bash website/make-zip.sh
```

That writes `website/build/neoxify-website.zip` with the files at the archive
root — unzip it inside `public_html` and nothing needs moving afterwards.
Real submissions and the generated secret are excluded from the archive, so
redeploying never overwrites what people have already sent you.

Requirements on the host: PHP 7.4 or newer. That is the whole list.

The script uses `zip` when it exists, then Python's zipfile, then Node
(`scripts/make-zip.mjs`) -- the owner's Windows PC has only the last. All
three write forward-slash entry names and exclude the same files.

**The zip never contains `account/`.** The customer portal at `/account/`
is a separate build (`apps/web-portal`) and ships only through
`scripts/deploy-portal.sh` at the repository root, which backs up the live
portal, swaps the new one in atomically, checks it from outside and rolls
back on a failed check. Unzipping the site leaves the live portal alone;
a portal build sitting in `website/account/` is never shipped by accident.

### Routing, and why it is in PHP

The shared nginx sends any path it cannot match to a file to
`/index.php`, and never reads `.htaccess`. Measured 2026-10-19: unknown
URLs, `/sitemap.xml` and `/r/CODE` all returned the home page with a
200, and `www.neoxify.net` served a full copy. So the top of
`index.php` routes, before anything else: `/` and `/index.php` render
the home page, `/sitemap.xml` requires `sitemap.php`, `/r/CODE` hands
the code to `r/index.php`, and **anything else renders `404.php` with a
404** (in Persian under `/fa/`). `inc/bootstrap.php` 301s any `www.`
host to `site_url`. None of it needs server configuration, and on Apache
`.htaccess` does the same in front of it.

### Previewing on a machine with no PHP

The owner's PC has no PHP binary, and Smart App Control may block a freshly
downloaded native one. PHP compiled to WebAssembly runs fine: install
`@php-wasm/node` and `@php-wasm/universal` (npm, 3.x) in a scratch folder
and serve the site through a small Node HTTP server that runs each `.php`
request in the PHP 7.4 runtime (the host's minimum) and **imitates the
live host, not an ideal one**: real files as themselves, trailing-slash
301s, everything else to `/index.php`, the host's four headers added to
every response, gzip only, and no cache headers on static files.
`scripts/dev-router.php` does the same for `php -S`. A preview that does
more than the host -- the routing, say -- passes checks production fails;
that is how the soft-404s went unnoticed. Two quirks of the WebAssembly
runtime, neither a site bug: `flock()` fails on a host-mounted folder
(mount `data/` in memory or the forms report a storage failure), and
`mail()` does nothing.

## Where form submissions go

Both forms store **first**, then email:

- `data/submissions-contact.php`
- `data/submissions-reseller.php`

One JSON object per line. Each file starts with `<?php exit; ?>` so a direct
browser request executes it and returns nothing, and `data/.htaccess` denies
access outright — two independent layers, because a shared host that quietly
ignores `.htaccess` should not be able to leak anyone's message.

> **The live host is one of those.** It is a shared nginx box (owner,
> 2026-10-19) that never reads `.htaccess`, so on the live site the
> guard line is the *only* layer protecting `data/`. The routing and the
> security headers no longer depend on the server -- see *Routing* and
> *Security headers* above.

### The domain split, and why it affects mail

The site is served from **neoxify.net**. Support mail goes to
**info@neoxify.com**. The control plane — admin panel and API both — is on
**connect.neoxify.site**. Three different hosts, one brand.

Two corrections worth stating plainly, because this file previously got
both wrong and a confident wrong note is worse than none:

- **`connect.neoxify.com` does not resolve.** It is not an alias, not a
  redirect, and not a fallback. Anything pointing at it is broken.
- **`panel.neoxify.com` is a different business entirely** — the
  operator's IT-services site. It is not this product's panel and must
  never be treated as a deployment target.

That matters for one thing: the `From:` address on form notifications is
`noreply@neoxify.net`, not `.com`. The .net webhost is what actually sends the
message, and a receiving mail server checks SPF against the `From:` domain — so
a `.com` sender from a `.net` host fails that check unless you have explicitly
added the webhost to `neoxify.com`'s SPF record. With no DKIM on the domain
either, there is no second signal to save it. Mail still *arrives* at
`info@neoxify.com`; only the sender identity differs, and Reply-To still carries
the submitter's address so replying works normally.

Change `mail_from` to `@neoxify.com` only after confirming the .net host is in
`neoxify.com`'s SPF record.

Storing before mailing is deliberate. The mail domain has SPF and DMARC but no
DKIM, and mail is already known to land in spam — treating a sent email as the
record of a submission would mean silently losing real reseller applications.
The file is the source of truth; the email is a notification. A submission is
reported as successful if **either** worked, and shows an honest error with a
fallback address only if both failed.

Spam protection is a honeypot field, a minimum fill time, and a per-IP rate
limit. No CAPTCHA: reCAPTCHA is a blocked third-party request for much of this
audience, and asking Iranian users to solve one is a bad trade.

The site sets no tracking cookies, which is why there is no cookie banner
(the two cookies remember a language or a theme someone chose; see *Automatic
language*).
CSRF uses a self-contained HMAC token instead of a PHP session. IP addresses
are stored only as salted hashes.

## Structure

```
index.php                                         home page, and the router
features/  pricing/  faq/  download/
contact/  reseller/  privacy/  delete-account/    English pages
fa/                                               Persian mirror of all nine
404.php                                           real 404, routed to by index.php
sitemap.php  robots.txt                           /sitemap.xml is routed to the first
inc/bootstrap.php                                 config, locale, helpers
inc/config.php                                    the file you edit
inc/lang/{en,fa}.php                              every string on the site
inc/content/plans.php                             prices — must match the panel
inc/content/{faq,locations}.php                   the rest of the data-shaped copy
inc/pages/                                        page templates, shared by locale
inc/partials/                                     head, header, footer, form fields,
                                                  locations-grid, schema,
                                                  plan-cards, cta-band, world
inc/{form,security}.php                           validate → store → mail
inc/headers.php                                   security headers and the CSP
assets/css/{base,blocks,home,forms}.css           inlined per page by head.php
assets/js/site.js                                 enhancement only, loaded async
assets/fonts/  assets/map/  assets/img/           fonts, the dotted world, icons and
                                                  the two social cards; img/brand/ the app logo,
                                                  img/app/ the app screenshots
scripts/check-site.php                            pre-deploy check, run it
scripts/make-fonts.mjs                            rebuilds the font subsets
scripts/make-og-image.mjs                         renders the social cards (Chrome)
scripts/make-icons.py                             the old raster icons, from brand/ (the
                                                  current ones are rendered from
                                                  assets/img/brand/neoxify-glass-light.svg)
scripts/make-zip.{py,mjs}                         zip fallbacks for make-zip.sh
data/                                             runtime only, never committed
```

Pages are thin: each declares its locale and page key, then includes a shared
template. Adding a language means adding `inc/lang/xx.php` and a directory of
four-line page files — no layout is duplicated.

Features, Pricing and the FAQ became real pages in the 2026-08 rebuild. They
were `#pricing` and `#faq` anchors on the home page, which meant the two most
commercially important destinations on the site could not carry a title, a
description, a canonical or structured data of their own.

### Check it before you ship it

```bash
php scripts/check-site.php
```

Renders all eighteen pages through the same include path a real request takes
and fails on anything that should never reach a visitor — a missing
translation key rendering as `⟪key⟫`, a duplicate title, an over-long meta
description, a missing hreflang or social card, a second inline script or
style (the CSP would block it), a stylesheet link (render-blocking), a
request to another origin, a preloaded font the CSS does not use -- and
**where each form posts**: contact, reseller and delete-account must post to
their own page in their own language, written out literally in the check.
`--html <dir>` checks pages already rendered into a folder, for a machine
whose PHP cannot spawn a child process (the WebAssembly one). It exists because `<title>⟪meta.delete-account.title⟫` was served
on two pages in both languages for months: nothing was ever looking at a
rendered page. Exit code 0 or 1, so it can gate a deploy.

That check renders; it does not lay out. Anything about spacing, wrapping or
direction needs a browser, and the whole site should be walked at 1280, 768
and 375 in **both** languages after any layout change. Three faults shipped
into this branch that only a real render could show: a mobile drawer that
never closed, a nested grid resolving to a 170px column, and "30 GB" arriving
in a Persian sentence as "GB 30".

## Conventions worth keeping

- **Name no protocol, port, transport, route or server — the owner's
  instruction, 2026-10-23.** The 2026-08 rebuild listed every engine with its
  port and showed which kind of blocking stops which one, plus the Iran
  relay. That was reversed: a public list of how the app connects is a
  checklist for a censor. Describe the benefit ("several ways to connect,
  including ones made to look like ordinary web traffic; the app finds the
  one that works and moves when one stops"), never the mechanism. Server
  countries may be named and lit; entry points may not, in words or on the
  map. Plans differ by benefit, not by route. Before a deploy, render every
  page in both locales and grep the HTML, CSS, JS, the social cards and the
  app screenshots for engine names, port numbers, TCP/UDP and relay wording,
  in Latin and in Persian.
  The footer still has no "source on GitHub" link; that part stands.
- **Every claim has to be traceable to something that exists.** No no-logs
  policy (the shipped server config writes an access log), no kill switch, no
  auto-connect, no refund guarantee, no company name or jurisdiction, no
  server count, no uptime figure, no signed installer, and no promise about
  iOS. The download page says an app that does not exist is not "coming
  soon"; anything else on the site that implies otherwise is a bug.
- **No external requests.** No CDN, no Google Fonts, no analytics. Everything
  is local, including the typeface. The audience is largely on networks where
  a third-party request is slow at best and blocked at worst, and a blocked
  font is a visibly broken page.
- **Typefaces: the app's own.** Inter and Inter Tight on English pages,
  Vazirmatn on Persian ones, subset and self-hosted in `assets/fonts/`,
  SIL OFL with the licences beside them. Preloaded in `head.php` with URLs
  that carry no `?v=` stamp (the version is in the file name), so they
  match the `@font-face` requests exactly. See `assets/fonts/README.txt`.
- **The map is the app's**, Natural Earth (public domain) via world-atlas
  (ISC). `assets/map/LICENSE.txt` must stay beside `world-map.svg`.
- **Claims stay honest even in illustrations.** The hero illustration is the
  app drawn in HTML from its own tokens, captioned as an illustration with an
  example time, and it only names a place and a method the content files
  list. The map's lights never blink. The encryption diagram stops the
  protected leg at our servers rather than running it to the destination.
- **No `style=""` attributes and no extra inline scripts.** The CSP allows
  exactly one inline `<style>` (the page's inlined CSS) and one inline script
  (the loader in `head.php`), each by its SHA-256, which `head.php` computes
  from what it emits. Anything else inline renders locally and is blocked in
  production; `check-site.php` fails on it. Use the utility classes at the
  bottom of `assets/css/base.css`.
- **Direction-agnostic CSS.** Layout uses logical properties
  (`margin-inline`, `inset-inline`), so Persian mirrors from `<html dir="rtl">`
  alone. There is no second RTL stylesheet. Avoid `left`/`right` -- except
  for the map and its lights, which are geography and never mirror, and the
  glass rim, which is lit from the physical top left like the app's.
- **PHP 7.4-compatible.** No `match`, no `?->`, no `str_contains`, no named
  arguments — the shared host decides the version, not us.
- **Honest copy.** No server counts, uptime percentages, user numbers, or
  no-logging claims. Every statement on the site describes something the
  product actually does.
