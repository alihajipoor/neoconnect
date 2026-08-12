<?php
/**
 * Site header: brand, navigation, language switch.
 *
 * The mobile drawer is rendered visible and is hidden by JavaScript on load
 * (see assets/js/site.js). That ordering matters -- if it were hidden in the
 * markup and JS never ran, a visitor on a small screen would have no
 * navigation at all.
 */

defined('NX') || exit;

$nx_current = nx_page();

/* Sign-in lives on the control plane, not here -- see `customer_portal_url`
 * in config.php for why. Read once and reused by both the desktop header
 * and the mobile drawer below, so the two cannot disagree about whether
 * the account area exists. */
$nx_portal = (string) nx_cfg('customer_portal_url');

/** page key => href. Pricing is a section of the home page, not its own page. */
$nx_links = array(
    'download' => nx_url('download'),
    'pricing'  => nx_url('home') . '#pricing',
    'reseller' => nx_url('reseller'),
    'contact'  => nx_url('contact'),
);
?>
<header class="site-header">
  <div class="container site-header__inner">

    <a class="brand" href="<?php echo nx_esc(nx_url('home')); ?>">
      <span class="brand__mark"><?php echo nx_logo_mark(); ?></span>
      <span><?php echo nx_e('brand.name'); ?></span>
      <?php if (nx_beta()): ?>
        <span class="brand__beta"><?php echo nx_e('beta.badge'); ?></span>
      <?php endif; ?>
    </a>

    <nav class="site-nav" aria-label="<?php echo nx_e('nav.menu'); ?>">
      <?php foreach ($nx_links as $nx_key => $nx_href): ?>
        <a href="<?php echo nx_esc($nx_href); ?>"<?php
          echo $nx_key === $nx_current ? ' aria-current="page"' : ''; ?>>
          <?php echo nx_e('nav.' . $nx_key); ?>
        </a>
      <?php endforeach; ?>
    </nav>

    <div class="header-actions">
      <a class="lang-switch"
         href="<?php echo nx_esc(nx_switch_url()); ?>"
         lang="<?php echo nx_esc(nx_other_locale()); ?>"
         hreflang="<?php echo nx_esc(nx_other_locale()); ?>"
         aria-label="<?php echo nx_e('lang.switch_label'); ?>">
        <?php echo nx_icon('globe'); ?>
        <span><?php echo nx_e('lang.switch'); ?></span>
      </a>

      <?php if ($nx_portal !== ''): ?>
        <a class="btn btn--ghost" href="<?php echo nx_esc($nx_portal); ?>">
          <?php echo nx_e('nav.signin'); ?>
        </a>
      <?php endif; ?>

      <a class="btn btn--primary" href="<?php echo nx_esc(nx_url('download')); ?>">
        <?php echo nx_e('nav.cta'); ?>
      </a>

      <button type="button" class="nav-toggle" data-nav-toggle
              aria-controls="mobile-nav" aria-expanded="true">
        <span class="icon-menu"><?php echo nx_icon('menu'); ?></span>
        <span class="icon-close"><?php echo nx_icon('close'); ?></span>
        <span class="sr-only"><?php echo nx_e('nav.menu'); ?></span>
      </button>
    </div>
  </div>

  <div class="container">
    <nav class="mobile-nav" id="mobile-nav" data-nav-drawer
         aria-label="<?php echo nx_e('nav.menu'); ?>">
      <a href="<?php echo nx_esc(nx_url('home')); ?>"><?php echo nx_e('nav.home'); ?></a>
      <?php foreach ($nx_links as $nx_key => $nx_href): ?>
        <a href="<?php echo nx_esc($nx_href); ?>"><?php echo nx_e('nav.' . $nx_key); ?></a>
      <?php endforeach; ?>
      <?php if ($nx_portal !== ''): ?>
        <a href="<?php echo nx_esc($nx_portal); ?>"><?php echo nx_e('nav.signin'); ?></a>
      <?php endif; ?>
      <a class="btn btn--primary" href="<?php echo nx_esc(nx_url('download')); ?>">
        <?php echo nx_e('nav.cta'); ?>
      </a>
    </nav>
  </div>
</header>
