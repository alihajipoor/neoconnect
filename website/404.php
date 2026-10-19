<?php
/**
 * Not-found page. On the live host it is reached through the router at the
 * top of index.php, which the shared nginx falls back to for any path it
 * cannot match to a file; ErrorDocument in .htaccess wires it up on Apache.
 *
 * Renders in whichever locale the missing URL was under, so someone who
 * mistypes a Persian address does not suddenly get an English page.
 */

// Guess the locale from the path the visitor actually asked for.
$nx_path = isset($_SERVER['REQUEST_URI']) ? (string) $_SERVER['REQUEST_URI'] : '';
$NX_LOCALE = (strpos($nx_path, '/fa/') !== false || substr($nx_path, -3) === '/fa')
    ? 'fa'
    : 'en';

// Borrow the home page's key so the header renders normally; the metadata is
// overridden below.
$NX_PAGE = 'home';

// Otherwise a missing English URL would redirect an Iranian visitor to the
// Persian home page, losing the 404 and the address they mistyped.
$NX_SKIP_LOCALE_REDIRECT = true;

require __DIR__ . '/inc/bootstrap.php';

$NX_TITLE = nx_t('meta.404.title');
$NX_DESCRIPTION = nx_t('meta.404.description');
$NX_NOINDEX = true;

// Without this the page would be served as a perfectly good 200, and search
// engines would index every mistyped URL on the site.
http_response_code(404);

require NX_INC . '/partials/head.php';
?>

<section class="lost">
  <div class="wrap">
    <div class="page-hero__inner lost__inner">
      <p class="lost__code" data-ltr><?php echo nx_esc(nx_num('404')); ?></p>
      <h1 class="h1"><?php echo nx_e('error.404.title'); ?></h1>
      <p class="lede"><?php echo nx_e('error.404.body'); ?></p>
      <div class="u-row u-row--center u-mt-sm">
        <a class="btn btn--primary" href="<?php echo nx_esc(nx_url('home')); ?>"><?php echo nx_e('error.404.home'); ?></a>
        <a class="btn btn--ghost" href="<?php echo nx_esc(nx_url('download')); ?>"><?php echo nx_e('nav.download'); ?></a>
        <a class="btn btn--ghost" href="<?php echo nx_esc(nx_url('contact')); ?>"><?php echo nx_e('nav.contact'); ?></a>
      </div>
    </div>
  </div>
</section>

<?php require NX_INC . '/partials/footer.php'; ?>
