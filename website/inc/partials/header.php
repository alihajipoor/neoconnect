<?php
/**
 * Site header: a floating glass bar with the brand, navigation, language
 * switch, sign-in and the one primary action.
 *
 * The mobile menu is in the markup and OPEN by default. The inline loader
 * in head.php adds .js to <html> before the first paint, and only then does
 * CSS fold it away -- so a phone without JavaScript still has navigation,
 * and a phone with it sees no flash of an open menu and no layout shift.
 */

defined('NX') || exit;

$nx_current = nx_page();

/* Sign-in lives in the customer area at /account/ (a static build of the
 * apps' own screens), not in this PHP site -- see customer_portal_url in
 * config.php. Read once so the bar and the menu cannot disagree. */
$nx_portal = nx_portal_url();

/* Reseller is in the footer, not here: it is for a few partners, and it was
 * taking a slot from Features, which is for everybody. */
$nx_links = array(
    'features' => nx_url('features'),
    'pricing'  => nx_url('pricing'),
    'download' => nx_url('download'),
    'faq'      => nx_url('faq'),
    'contact'  => nx_url('contact'),
);
?>
<header class="site-header">
  <div class="wrap">
    <div class="site-header__bar glass">
      <a class="brand" href="<?php echo nx_esc(nx_url('home')); ?>"<?php
        echo $nx_current === 'home' && empty($GLOBALS['NX_TITLE']) ? ' aria-current="page"' : ''; ?>>
        <span class="brand__mark"><?php echo nx_logo(); ?></span>
        <span class="brand__word" lang="en">Neoxify</span>
        <?php if (nx_beta()): ?>
          <span class="brand__beta"><?php echo nx_e('beta.badge'); ?></span>
        <?php endif; ?>
      </a>

      <nav class="site-nav" aria-label="<?php echo nx_e('nav.main_label'); ?>">
        <?php foreach ($nx_links as $nx_key => $nx_href): ?>
          <a href="<?php echo nx_esc($nx_href); ?>"<?php
            echo $nx_key === $nx_current ? ' aria-current="page"' : ''; ?>><?php echo nx_e('nav.' . $nx_key); ?></a>
        <?php endforeach; ?>
      </nav>

      <div class="header-actions">
        <?php echo nx_lang_switch('lang-switch--bar'); ?>

        <?php /* Light / dark. Only the script can switch it, so without the
                 script there is no button (the theme then follows the
                 system). aria-pressed is right from the server when a cookie
                 says dark, and site.js corrects it for a dark system. */ ?>
        <button type="button" class="theme-toggle" data-theme-toggle data-enhanced-only
                data-cookie-path="<?php echo nx_esc(nx_cfg('base_path', '/')); ?>"
                aria-pressed="<?php echo nx_theme() === 'dark' ? 'true' : 'false'; ?>">
          <span class="i-sun"><?php echo nx_icon('sun'); ?></span>
          <span class="i-moon"><?php echo nx_icon('moon'); ?></span>
          <span class="sr-only"><?php echo nx_e('theme.dark'); ?></span>
        </button>

        <?php if ($nx_portal !== ''): ?>
          <a class="btn btn--quiet btn--sm btn--signin" href="<?php echo nx_esc($nx_portal); ?>"><?php echo nx_e('nav.signin'); ?></a>
        <?php endif; ?>

        <a class="btn btn--primary btn--sm btn--cta" href="<?php echo nx_esc(nx_url('download')); ?>"><?php echo nx_e('nav.cta'); ?></a>

        <button type="button" class="nav-toggle" data-nav-toggle aria-controls="mobile-nav" aria-expanded="false">
          <span class="icon-menu"><?php echo nx_icon('menu'); ?></span>
          <span class="icon-close"><?php echo nx_icon('close'); ?></span>
          <span class="sr-only"><?php echo nx_e('nav.menu'); ?></span>
        </button>
      </div>
    </div>

    <nav class="mobile-nav glass" id="mobile-nav" data-nav-drawer aria-label="<?php echo nx_e('nav.menu'); ?>">
      <a href="<?php echo nx_esc(nx_url('home')); ?>"><?php echo nx_e('nav.home'); ?></a>
      <?php foreach ($nx_links as $nx_key => $nx_href): ?>
        <a href="<?php echo nx_esc($nx_href); ?>"<?php
          echo $nx_key === $nx_current ? ' aria-current="page"' : ''; ?>><?php echo nx_e('nav.' . $nx_key); ?></a>
      <?php endforeach; ?>
      <?php if ($nx_portal !== ''): ?>
        <a href="<?php echo nx_esc($nx_portal); ?>"><?php echo nx_e('nav.signin'); ?></a>
      <?php endif; ?>
      <?php /* On a phone the bar has no room for the language switch, so it
               is here instead (and in the footer). */ ?>
      <div class="mobile-nav__lang"><?php echo nx_lang_switch(); ?></div>
      <a class="btn btn--primary btn--block" href="<?php echo nx_esc(nx_url('download')); ?>"><?php echo nx_e('nav.cta'); ?></a>
    </nav>
  </div>
</header>
