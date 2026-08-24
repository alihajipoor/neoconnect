<?php
/**
 * XML sitemap.
 *
 * Generated rather than shipped as a static sitemap.xml so the URLs always
 * match config.php's site_url -- a static file would silently advertise the
 * wrong domain the moment the site moved, and moving is a live possibility
 * here: if neoxify.net is ever blocked outright, the site goes up on a
 * mirror domain and everything must follow from one config value.
 *
 * IMPORTANT -- /sitemap.xml MUST REWRITE HERE. Measured on the live site
 * 2026-08-24: https://neoxify.net/sitemap.xml returned 200 with
 * Content-Type: text/html and the *home page* as its body, because nginx
 * never reads the .htaccess rule that was supposed to do the rewrite. A
 * crawler asking for the conventional path got a marketing page and no
 * sitemap at all. See nginx-website.conf.example, which has the rule; it
 * has to actually be deployed.
 */

$NX_LOCALE = 'en';
$NX_PAGE = 'home';

// A sitemap is read by crawlers, not by a person choosing a language, and it
// lists both locales explicitly. Redirecting it would be actively harmful.
$NX_SKIP_LOCALE_REDIRECT = true;

require __DIR__ . '/inc/bootstrap.php';

header('Content-Type: application/xml; charset=UTF-8');

/**
 * Pages in the sitemap, mapped to the template whose modification time
 * stands in for "when did this page last change".
 *
 * lastmod is derived from a real file rather than being date('Y-m-d') --
 * a sitemap that claims every page changed today, every day, is a sitemap
 * a crawler learns to ignore, and it is worse than omitting the field.
 * The template is the right file to watch because the copy lives in the
 * language files and those change with it; when in doubt the value is
 * simply left out.
 */
$nx_pages = array(
    'home'     => 'pages/home.php',
    'features' => 'pages/features.php',
    'pricing'  => 'pages/pricing.php',
    'download' => 'pages/download.php',
    'faq'      => 'pages/faq.php',
    'reseller' => 'pages/reseller.php',
    'contact'  => 'pages/contact.php',
    'privacy'  => 'pages/privacy.php',
    // Unlinked from the navigation, but a real, indexable page: the Play
    // listing's data-safety declaration points at it, and Google checks
    // that the URL resolves. Leaving it out of the sitemap does not hide
    // it, it just makes it slower to find.
    'delete-account' => 'pages/delete-account.php',
);

$nx_locales = array('en', 'fa');

/**
 * Priority is a hint at RELATIVE importance within this one site. It says
 * nothing to Google about competing against anyone else, and setting
 * everything to 1.0 -- the classic mistake -- conveys exactly nothing.
 */
$nx_priority = array(
    'home' => '1.0',
    'pricing' => '0.9',
    'features' => '0.9',
    'download' => '0.9',
    'faq' => '0.7',
    'contact' => '0.6',
    'reseller' => '0.5',
    'privacy' => '0.3',
    'delete-account' => '0.3',
);

echo '<?xml version="1.0" encoding="UTF-8"?>' . "\n";
?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
<?php foreach ($nx_pages as $nx_page => $nx_template): ?>
  <?php
  $nx_file = NX_INC . '/' . $nx_template;
  $nx_lastmod = is_file($nx_file) ? gmdate('Y-m-d', filemtime($nx_file)) : '';
  ?>
  <?php foreach ($nx_locales as $nx_locale): ?>
  <url>
    <loc><?php echo nx_esc(nx_abs_url($nx_page, $nx_locale)); ?></loc>
    <?php
    /* Every URL declares BOTH locales plus x-default, and each one must be
       reciprocal -- the Persian entry has to list the English alternate and
       the reverse, or Google discards the pairing entirely and treats them
       as unrelated duplicates. Emitting them from one loop is what makes
       that structurally true rather than a thing to remember. */
    foreach ($nx_locales as $nx_alt): ?>
    <xhtml:link rel="alternate" hreflang="<?php echo $nx_alt; ?>" href="<?php echo nx_esc(nx_abs_url($nx_page, $nx_alt)); ?>"/>
    <?php endforeach; ?>
    <xhtml:link rel="alternate" hreflang="x-default" href="<?php echo nx_esc(nx_abs_url($nx_page, 'en')); ?>"/>
    <?php if ($nx_lastmod !== ''): ?>
    <lastmod><?php echo $nx_lastmod; ?></lastmod>
    <?php endif; ?>
    <changefreq><?php echo $nx_page === 'home' ? 'weekly' : 'monthly'; ?></changefreq>
    <priority><?php echo isset($nx_priority[$nx_page]) ? $nx_priority[$nx_page] : '0.5'; ?></priority>
  </url>
  <?php endforeach; ?>
<?php endforeach; ?>
</urlset>
