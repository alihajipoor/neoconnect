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

<meta property="og:type" content="website">
<meta property="og:site_name" content="<?php echo nx_e('brand.name'); ?>">
<meta property="og:title" content="<?php echo nx_esc($nx_title); ?>">
<meta property="og:description" content="<?php echo nx_esc($nx_description); ?>">
<meta property="og:url" content="<?php echo nx_esc(nx_abs_url($nx_page)); ?>">
<meta property="og:locale" content="<?php echo nx_locale() === 'fa' ? 'fa_IR' : 'en_US'; ?>">
<meta name="twitter:card" content="summary">

<link rel="icon" href="<?php echo nx_esc(nx_asset('img/favicon.svg')); ?>" type="image/svg+xml">
<link rel="stylesheet" href="<?php echo nx_esc(nx_asset('css/site.css')); ?>">
</head>
<body>

<a class="skip-link" href="#main"><?php echo nx_e('skip_to_content'); ?></a>

<?php require NX_INC . '/partials/header.php'; ?>

<main id="main">
