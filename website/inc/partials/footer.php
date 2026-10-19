<?php
/**
 * Site footer plus the close of the document. Pairs with head.php, which
 * opens <main>.
 *
 * Every internal page is linked from here, including the two the top bar
 * does not carry (Reseller, Delete account) -- a footer is where a crawler
 * finds the pages the navigation could not fit.
 */

defined('NX') || exit;

$nx_telegram = trim((string) nx_cfg('telegram_url', ''));
$nx_portal_url = nx_portal_url();
?>
</main>

<footer class="site-footer">
  <div class="wrap">
    <div class="site-footer__grid">

      <div class="site-footer__about">
        <a class="brand" href="<?php echo nx_esc(nx_url('home')); ?>">
          <span class="brand__mark"><?php echo nx_logo_mark(); ?></span>
          <span class="brand__word" lang="en">Neoxify</span>
        </a>
        <p><?php echo nx_e('footer.note'); ?></p>
      </div>

      <div>
        <h2 class="site-footer__title"><?php echo nx_e('footer.product'); ?></h2>
        <ul>
          <li><a href="<?php echo nx_esc(nx_url('features')); ?>"><?php echo nx_e('nav.features'); ?></a></li>
          <li><a href="<?php echo nx_esc(nx_url('pricing')); ?>"><?php echo nx_e('nav.pricing'); ?></a></li>
          <li><a href="<?php echo nx_esc(nx_url('download')); ?>"><?php echo nx_e('nav.download'); ?></a></li>
          <?php if ($nx_portal_url !== ''): ?>
            <li><a href="<?php echo nx_esc($nx_portal_url); ?>"><?php echo nx_e('nav.signin'); ?></a></li>
          <?php endif; ?>
        </ul>
      </div>

      <div>
        <h2 class="site-footer__title"><?php echo nx_e('footer.resources'); ?></h2>
        <ul>
          <li><a href="<?php echo nx_esc(nx_url('faq')); ?>"><?php echo nx_e('nav.faq'); ?></a></li>
          <li><a href="<?php echo nx_esc(nx_url('contact')); ?>"><?php echo nx_e('nav.contact'); ?></a></li>
          <li><a href="<?php echo nx_esc(nx_url('reseller')); ?>"><?php echo nx_e('nav.reseller'); ?></a></li>
          <?php if ($nx_telegram !== ''): ?>
            <li><a href="<?php echo nx_esc($nx_telegram); ?>" rel="noopener">Telegram</a></li>
          <?php endif; ?>
        </ul>
      </div>

      <div>
        <h2 class="site-footer__title"><?php echo nx_e('footer.legal'); ?></h2>
        <ul>
          <li><a href="<?php echo nx_esc(nx_url('privacy')); ?>"><?php echo nx_e('nav.privacy'); ?></a></li>
          <li><a href="<?php echo nx_esc(nx_url('delete-account')); ?>"><?php echo nx_e('nav.delete_account'); ?></a></li>
          <?php /* No "source on GitHub" link here, by design. */ ?>
        </ul>
      </div>
    </div>

    <div class="site-footer__bottom">
      <p><?php echo nx_e('footer.rights', array('year' => nx_num(date('Y')))); ?></p>
      <?php echo nx_lang_switch(); ?>
    </div>
  </div>
</footer>
</body>
</html>
