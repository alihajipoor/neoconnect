<?php
/**
 * Not-found page, wired up by ErrorDocument in .htaccess.
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

require __DIR__ . '/inc/bootstrap.php';

$NX_TITLE = nx_t('meta.404.title');
$NX_DESCRIPTION = nx_t('meta.404.description');
$NX_NOINDEX = true;

// Without this the page would be served as a perfectly good 200, and search
// engines would happily index every mistyped URL on the site.
http_response_code(404);

require NX_INC . '/partials/head.php';
?>

<section class="section">
  <div class="container u-center u-narrow">
    <p class="eyebrow u-center-actions">
      <?php echo nx_e('error.404.code'); ?>
    </p>
    <h1><?php echo nx_e('error.404.title'); ?></h1>
    <p class="lead u-narrow u-my-lead">
      <?php echo nx_e('error.404.body'); ?>
    </p>

    <div class="hero__actions u-center-actions">
      <a class="btn btn--primary" href="<?php echo nx_esc(nx_url('home')); ?>">
        <?php echo nx_e('error.404.home'); ?>
      </a>
      <a class="btn btn--ghost" href="<?php echo nx_esc(nx_url('download')); ?>">
        <?php echo nx_e('nav.download'); ?>
      </a>
      <a class="btn btn--ghost" href="<?php echo nx_esc(nx_url('contact')); ?>">
        <?php echo nx_e('nav.contact'); ?>
      </a>
    </div>
  </div>
</section>

<?php require NX_INC . '/partials/footer.php'; ?>
