<?php
/**
 * Site footer plus the close of the document. Pairs with head.php, which
 * opens <main>.
 */

defined('NX') || exit;

$nx_telegram = trim((string) nx_cfg('telegram_url', ''));
$nx_portal_url = trim((string) nx_cfg('customer_portal_url', ''));
?>
</main>

<footer class="site-footer">
  <div class="container">
    <div class="site-footer__grid">

      <div class="site-footer__about">
        <a class="brand" href="<?php echo nx_esc(nx_url('home')); ?>">
          <span class="brand__mark"><?php echo nx_logo_mark(); ?></span>
          <span><?php echo nx_e('brand.name'); ?></span>
        </a>
        <p><?php echo nx_e('footer.note'); ?></p>
      </div>

      <?php
      /* Four columns now rather than three, because Features, Pricing and
         the FAQ became real pages and a footer is where a crawler picks up
         the ones the top bar could not fit. Every internal link on the site
         is reachable from here. */
      ?>
      <div>
        <h2 class="site-footer__title"><?php echo nx_e('footer.product'); ?></h2>
        <ul>
          <li><a href="<?php echo nx_esc(nx_url('features')); ?>"><?php echo nx_e('nav.features'); ?></a></li>
          <li><a href="<?php echo nx_esc(nx_url('pricing')); ?>"><?php echo nx_e('nav.pricing'); ?></a></li>
          <li><a href="<?php echo nx_esc(nx_url('download')); ?>"><?php echo nx_e('nav.download'); ?></a></li>
        </ul>
      </div>

      <div>
        <h2 class="site-footer__title"><?php echo nx_e('footer.resources'); ?></h2>
        <ul>
          <li><a href="<?php echo nx_esc(nx_url('faq')); ?>"><?php echo nx_e('nav.faq'); ?></a></li>
          <li><a href="<?php echo nx_esc(nx_url('contact')); ?>"><?php echo nx_e('nav.contact'); ?></a></li>
          <li><a href="<?php echo nx_esc(nx_url('reseller')); ?>"><?php echo nx_e('nav.reseller'); ?></a></li>
        </ul>
      </div>

      <div>
        <h2 class="site-footer__title"><?php echo nx_e('footer.company'); ?></h2>
        <ul>
          <li><a href="<?php echo nx_esc(nx_url('privacy')); ?>"><?php echo nx_e('nav.privacy'); ?></a></li>
          <li><a href="<?php echo nx_esc(nx_url('delete-account')); ?>"><?php echo nx_e('nav.delete_account'); ?></a></li>
          <?php if ($nx_portal_url !== ''): ?>
            <li><a href="<?php echo nx_esc($nx_portal_url); ?>"><?php echo nx_e('nav.signin'); ?></a></li>
          <?php endif; ?>
          <?php if ($nx_telegram !== ''): ?>
            <li><a href="<?php echo nx_esc($nx_telegram); ?>" rel="noopener">Telegram</a></li>
          <?php endif; ?>
          <?php /* No "source on GitHub" link here by design: the site avoids
                   naming the technology it runs on, and that link led straight
                   to a public repo where all of it is visible. The repo being
                   public still makes it discoverable to anyone who goes
                   looking -- this just stops the site handing it over. */ ?>
        </ul>
      </div>
    </div>

    <div class="site-footer__bottom">
      <p><?php echo nx_e('footer.rights', array('year' => date('Y'))); ?></p>
      <?php echo nx_lang_switch(); ?>
    </div>
  </div>
</footer>

<script src="<?php echo nx_esc(nx_asset('js/site.js')); ?>" defer></script>
</body>
</html>
