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

## Before it goes live

Four things need a decision from you. The site runs without them, but it will
say the wrong thing until they are done.

| What | Where | Why |
|---|---|---|
| **The nginx config** | `nginx-website.conf.example` | Not optional and not deployed. Without it there is no 404 handler, `/sitemap.xml` serves the home page, the voucher short links do nothing and `www.` serves a duplicate site. See the deploy note below. |
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

**This is the site's only cookie**, and the privacy statement describes it. It
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

## Where form submissions go

Both forms store **first**, then email:

- `data/submissions-contact.php`
- `data/submissions-reseller.php`

One JSON object per line. Each file starts with `<?php exit; ?>` so a direct
browser request executes it and returns nothing, and `data/.htaccess` denies
access outright — two independent layers, because a shared host that quietly
ignores `.htaccess` should not be able to leak anyone's message.

> **The live host is one of those, and it is not shared hosting.**
> neoxify.net is served by nginx, which never reads `.htaccess` at all —
> so on the live site the guard line is the *only* layer, and the CSP,
> the other security headers, `ErrorDocument 404` and the `/r/CODE`
> rewrite are all inert. Measured 2026-08-14 against the running site,
> not assumed: no CSP header on any response, `GET /r/ABCD2345` returns
> the home page with a 200 instead of redirecting, and so does any
> mistyped URL. `nginx-website.conf.example` in this directory is the
> same posture written for nginx; it has to be installed by hand.

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

The site sets **no cookies at all**, which is why there is no cookie banner.
CSRF uses a self-contained HMAC token instead of a PHP session. IP addresses
are stored only as salted hashes.

## Structure

```
index.php  features/  pricing/  faq/  download/
contact/  reseller/  privacy/  delete-account/    English pages
fa/                                               Persian mirror of all nine
404.php                                           real 404, needs the server config
sitemap.php  robots.txt                           /sitemap.xml rewrites to the first
inc/bootstrap.php                                 config, locale, helpers
inc/config.php                                    the file you edit
inc/lang/{en,fa}.php                              every string on the site
inc/content/plans.php                             prices — must match the panel
inc/content/{faq,locations,protocols}.php         the rest of the data-shaped copy
inc/pages/                                        page templates, shared by locale
inc/partials/                                     head, header, footer, form fields,
                                                  locations-grid, protocol-table, schema
inc/{form,security}.php                           validate → store → mail
assets/                                           css, js, fonts, favicon, OG card
scripts/check-site.php                            pre-deploy check, run it
scripts/make-og-image.py                          regenerates the social card
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
description. It exists because `<title>⟪meta.delete-account.title⟫` was served
on two pages in both languages for months: nothing was ever looking at a
rendered page. Exit code 0 or 1, so it can gate a deploy.

That check renders; it does not lay out. Anything about spacing, wrapping or
direction needs a browser, and the whole site should be walked at 1280, 768
and 375 in **both** languages after any layout change. Three faults shipped
into this branch that only a real render could show: a mobile drawer that
never closed, a nested grid resolving to a 170px column, and "30 GB" arriving
in a Persian sentence as "GB 30".

## Conventions worth keeping

- **Name the protocols — this reversed in 2026-08.** The site used to refuse
  to say which engines were behind it, and described everything as "several
  ways to connect". A word-boundary grep of the whole live site for
  `wireguard|openvpn|ikev2|vless|shadowsocks|trojan|reality` returned zero
  hits, and so did one for every country name. Those are the terms a
  technical buyer filters on and the ones they search for, and refusing to
  print them cost the site that entire audience while protecting nothing the
  public repo does not already reveal. `inc/content/protocols.php` now carries
  all eight with their customer-facing labels, and `locations.php` the six
  locations. **VMess is not one of them** — it is in the backend enum but the
  installer does not build it and no node runs it, so it must never appear.
  The footer still has no "source on GitHub" link; that part stands.
- **Every claim has to be traceable to something that exists.** No no-logs
  policy (the shipped Xray config writes an access log), no kill switch, no
  auto-connect, no refund guarantee, no company name or jurisdiction, no
  server count, no uptime figure, no signed installer, and no promise about
  iOS. The download page says an app that does not exist is not "coming
  soon"; anything else on the site that implies otherwise is a bug.
- **No external requests.** No CDN, no Google Fonts, no analytics. Everything
  is local, including the typeface. The audience is largely on networks where
  a third-party request is slow at best and blocked at worst, and a blocked
  font is a visibly broken page.
- **Typeface: Vazirmatn**, self-hosted in `assets/fonts/` as a single variable
  woff2 (~110KB) covering weights 100–900 for both languages. SIL OFL — the
  licence ships beside it and must stay there. It is preloaded in `head.php`
  with a URL that deliberately carries no `?v=` stamp, so it matches the
  `@font-face` request exactly and isn't downloaded twice.
- **Claims stay honest even in illustrations.** The hero mockup is drawn from
  the real desktop app, and the macOS and phone frames carry visible "Soon"
  badges because those clients don't exist yet. The encryption diagram stops
  the protected leg at our servers rather than running it to the destination.
- **No inline styles or scripts.** The CSP in `.htaccess` has no
  `'unsafe-inline'`. Use the utility classes at the bottom of
  `assets/css/site.css`.
- **Direction-agnostic CSS.** Layout uses logical properties
  (`margin-inline`, `inset-inline`), so Persian mirrors from `<html dir="rtl">`
  alone. There is no second RTL stylesheet. Avoid `left`/`right`.
- **PHP 7.4-compatible.** No `match`, no `?->`, no `str_contains`, no named
  arguments — the shared host decides the version, not us.
- **Honest copy.** No server counts, uptime percentages, user numbers, or
  no-logging claims. Every statement on the site describes something the
  product actually does.
