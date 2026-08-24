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
<meta name="theme-color" content="#0a0a10">

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
// Preloaded because the whole page is set in it, so discovering it only
// after the stylesheet parses costs a visible reflow.
//
// Deliberately NOT nx_asset(): that appends a ?v= cache-busting stamp, and
// the URL here has to match what the stylesheet's @font-face requests
// character for character, or the browser downloads the font twice.
$nx_font = nx_cfg('base_path', '/') . 'assets/fonts/vazirmatn-variable.woff2';
?>
<link rel="preload" href="<?php echo nx_esc($nx_font); ?>" as="font" type="font/woff2" crossorigin>
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

<?php require NX_INC . '/partials/header.php'; ?>

<main id="main">
