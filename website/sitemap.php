<?php
/**
 * XML sitemap.
 *
 * Generated rather than shipped as a static sitemap.xml so the URLs always
 * match config.php's site_url -- a static file would silently advertise the
 * wrong domain the moment the site moved. .htaccess rewrites /sitemap.xml
 * here where mod_rewrite is available; robots.txt points at this path
 * directly, which works everywhere.
 */

$NX_LOCALE = 'en';
$NX_PAGE = 'home';

require __DIR__ . '/inc/bootstrap.php';

header('Content-Type: application/xml; charset=UTF-8');

$nx_pages = array('home', 'download', 'reseller', 'contact');
$nx_locales = array('en', 'fa');

echo '<?xml version="1.0" encoding="UTF-8"?>' . "\n";
?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
<?php foreach ($nx_pages as $nx_page): ?>
  <?php foreach ($nx_locales as $nx_locale): ?>
  <url>
    <loc><?php echo nx_esc(nx_abs_url($nx_page, $nx_locale)); ?></loc>
    <?php foreach ($nx_locales as $nx_alt): ?>
    <xhtml:link rel="alternate" hreflang="<?php echo $nx_alt; ?>" href="<?php echo nx_esc(nx_abs_url($nx_page, $nx_alt)); ?>"/>
    <?php endforeach; ?>
    <xhtml:link rel="alternate" hreflang="x-default" href="<?php echo nx_esc(nx_abs_url($nx_page, 'en')); ?>"/>
    <changefreq><?php echo $nx_page === 'home' ? 'weekly' : 'monthly'; ?></changefreq>
    <priority><?php echo $nx_page === 'home' ? '1.0' : '0.8'; ?></priority>
  </url>
  <?php endforeach; ?>
<?php endforeach; ?>
</urlset>
