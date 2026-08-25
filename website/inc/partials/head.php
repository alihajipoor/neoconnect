<?php
/**
 * Document head and the opening of the body. Every page includes this first
 * and inc/partials/footer.php last.
 *
 * Nothing here loads from another origin. Styles, script, and the favicon are
 * all local files -- see the note at the top of assets/css/site.css for why
 * that is a requirement for this audience rather than a preference.
 */

defined('NX') || exit;

require_once NX_INC . '/partials/icons.php';

$nx_page = nx_page();

// A page may override its metadata by setting these before including this
// file -- the 404 page does, because it borrows the home page's navigation
// but is emphatically not the home page.
$nx_title = isset($NX_TITLE) ? $NX_TITLE : nx_t('meta.' . $nx_page . '.title');
$nx_description = isset($NX_DESCRIPTION)
    ? $NX_DESCRIPTION
    : nx_t('meta.' . $nx_page . '.description');

// Pages excluded from indexing (again, the 404) opt out here rather than
// having their URLs guessed at in robots.txt.
$nx_noindex = !empty($NX_NOINDEX);
?>
<!doctype html>
<html lang="<?php echo nx_esc(nx_locale()); ?>" dir="<?php echo nx_esc(nx_dir()); ?>" class="no-js">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title><?php echo nx_esc($nx_title); ?></title>
<meta name="description" content="<?php echo nx_esc($nx_description); ?>">
<?php // Matches --paper in site.css. The site is light-only: there is no
      // dark mode, no toggle, and no prefers-color-scheme block anywhere. ?>
<meta name="theme-color" content="#F2F1F6">

<?php if ($nx_noindex): ?>
<meta name="robots" content="noindex, follow">
<?php else: ?>
<link rel="canonical" href="<?php echo nx_esc(nx_abs_url($nx_page)); ?>">
<?php
// Tell search engines the two locales are the same page, and point x-default
// at English so an unmatched language lands somewhere sensible.
foreach (array('en', 'fa') as $nx_alt): ?>
<link rel="alternate" hreflang="<?php echo $nx_alt; ?>" href="<?php echo nx_esc(nx_abs_url($nx_page, $nx_alt)); ?>">
<?php endforeach; ?>
<link rel="alternate" hreflang="x-default" href="<?php echo nx_esc(nx_abs_url($nx_page, 'en')); ?>">
<?php endif; ?>

<?php
// Social preview image.
//
// There was none at all before this, which meant every link to this site
// -- and the ones that matter here are Telegram links, where this audience
// actually shares things -- rendered as a bare grey rectangle. A shared
// link with no image is a link that does not get clicked.
//
// ONE card, in Latin script, for both locales. That is a decision rather
// than an oversight -- see the long note in scripts/make-og-image.py.
// Short version: the generator cannot shape Arabic-script text without
// libraqm or arabic-reshaper, neither of which is available, so a Persian
// card would render as unjoined, reversed letterforms on the single
// most-shared image the site has. A correct Latin card serves both
// locales; a broken Persian one serves nobody. The card carries the
// protocol names, which are Latin in either language and are what a
// technical buyer scans for.
//
// A page can still override with $NX_OG_IMAGE, and the per-locale variant
// is a one-line change here if the shaping dependencies ever land.
//
// Absolute URL and no ?v= stamp: every scraper resolves this server-side
// and several cache by exact URL more or less forever, so a stamp that
// changes on redeploy strands the old one in their caches. If the artwork
// is redrawn, rename the file instead.
$nx_og_image = isset($NX_OG_IMAGE)
    ? $NX_OG_IMAGE
    : nx_cfg('base_path', '/') . 'assets/img/og-default.png';
$nx_og_image_abs = rtrim(nx_cfg('site_url', ''), '/') . $nx_og_image;
?>
<meta property="og:type" content="website">
<meta property="og:site_name" content="<?php echo nx_e('brand.name'); ?>">
<meta property="og:title" content="<?php echo nx_esc($nx_title); ?>">
<meta property="og:description" content="<?php echo nx_esc($nx_description); ?>">
<meta property="og:url" content="<?php echo nx_esc(nx_abs_url($nx_page)); ?>">
<meta property="og:locale" content="<?php echo nx_locale() === 'fa' ? 'fa_IR' : 'en_US'; ?>">
<meta property="og:locale:alternate" content="<?php echo nx_locale() === 'fa' ? 'en_US' : 'fa_IR'; ?>">
<meta property="og:image" content="<?php echo nx_esc($nx_og_image_abs); ?>">
<?php // Dimensions let a scraper lay the card out before the image arrives,
      // which is the difference between a card that pops in and one that
      // reflows. They must match the real file. ?>
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:type" content="image/png">
<meta property="og:image:alt" content="<?php echo nx_e('meta.og.image_alt'); ?>">

<?php // summary_large_image, not summary: the old value rendered a 120px
      // thumbnail beside the text and wasted a 1200x630 image entirely. ?>
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="<?php echo nx_esc($nx_title); ?>">
<meta name="twitter:description" content="<?php echo nx_esc($nx_description); ?>">
<meta name="twitter:image" content="<?php echo nx_esc($nx_og_image_abs); ?>">
<meta name="twitter:image:alt" content="<?php echo nx_e('meta.og.image_alt'); ?>">

<link rel="icon" href="<?php echo nx_esc(nx_asset('img/favicon.svg')); ?>" type="image/svg+xml">
<?php // PNG fallback for the handful of places that still will not take an
      // SVG favicon -- notably older Safari and most RSS/bookmark tools. ?>
<link rel="icon" href="<?php echo nx_esc(nx_asset('img/favicon-32.png')); ?>" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="<?php echo nx_esc(nx_asset('img/apple-touch-icon.png')); ?>">

<?php
// ---------------------------------------------------------------------
// Font preloads. PER LOCALE, and at most two.
//
// A font discovered only after the stylesheet parses costs a visible
// reflow, so the faces that set the top of the page are preloaded. But
// preloading everything is worse than preloading nothing: it competes
// with the stylesheet for the first round trip, on connections where the
// first round trip is the expensive one.
//
// So each locale preloads only what it actually paints above the fold:
//
//   English  Bricolage Grotesque (the hero headline) and Instrument Sans
//            (the lede and every button). Vazirmatn is NOT preloaded --
//            an English page never renders a Persian glyph, and it is the
//            largest file of the four.
//   Persian  Vazirmatn only. It sets the entire page: html[lang="fa"]
//            swaps --display and --sans to it.
//
// Martian Mono is deliberately NOT preloaded in either locale. It draws
// small tracked labels -- the eyebrow, the readouts -- where a swap is
// barely perceptible and not worth a preload slot.
//
// Deliberately NOT nx_asset(): that appends a ?v= cache-busting stamp,
// and these URLs have to match what the stylesheet's @font-face requests
// character for character, or the browser downloads each font twice.
$nx_base = nx_cfg('base_path', '/') . 'assets/fonts/';

$nx_preload_fonts = nx_locale() === 'fa'
    ? array('vazirmatn-variable.woff2')
    : array('bricolage-grotesque-variable.woff2', 'instrument-sans-variable.woff2');
?>
<?php foreach ($nx_preload_fonts as $nx_f): ?>
<link rel="preload" href="<?php echo nx_esc($nx_base . $nx_f); ?>" as="font" type="font/woff2" crossorigin>
<?php endforeach; ?>
<link rel="stylesheet" href="<?php echo nx_esc(nx_asset('css/site.css')); ?>">
<?php
// Structured data, last in the head so it can read anything set above it.
//
// A noindex page gets none: describing a page to a search engine in the
// same breath as telling it not to index the page is a contradiction, and
// the 404 page has nothing worth describing anyway.
if (!$nx_noindex) {
    require_once NX_INC . '/partials/schema.php';
    nx_render_schema();
}
?>
</head>
<body>

<a class="skip-link" href="#main"><?php echo nx_e('skip_to_content'); ?></a>

<?php
// ---------------------------------------------------------------------
// The frame.
//
// Two fixed hairline rails down the edges and twelve column lines behind
// everything. This is what lets the content run genuinely edge to edge and
// still read as a deliberate layout rather than a missing max-width.
//
// Entirely decorative, so all of it is aria-hidden and none of it is in the
// tab order. Both are display:none below 70rem, where there is no room for
// a frame and the page uses the full width instead.
// ---------------------------------------------------------------------
?>
<?php // Gradient definitions every decorative SVG below refers to.
      // Emitted once, here, so url(#nx-beam) resolves document-wide
      // rather than depending on whichever component renders first. ?>
<?php echo nx_svg_defs(); ?>

<div class="grid-lines" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>

<aside class="rail rail--start" aria-hidden="true">
  <span class="rail__text"><?php echo nx_e('rail.tagline'); ?></span>
</aside>
<aside class="rail rail--end" aria-hidden="true">
  <?php // Height is set by site.js as the visitor scrolls; it starts at zero
        // and simply stays there if the script never runs. ?>
  <span class="rail__prog" data-rail-progress></span>
  <span class="rail__text" data-ltr>neoxify.net</span>
</aside>

<?php require NX_INC . '/partials/header.php'; ?>

<main id="main">
