<?php
/**
 * Site footer plus the close of the document. Pairs with head.php, which
 * opens <main>.
 */

defined('NX') || exit;

$nx_telegram = trim((string) nx_cfg('telegram_url', ''));
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

      <div>
        <h4><?php echo nx_e('footer.product'); ?></h4>
        <ul>
          <li><a href="<?php echo nx_esc(nx_url('download')); ?>"><?php echo nx_e('nav.download'); ?></a></li>
          <li><a href="<?php echo nx_esc(nx_url('home')); ?>#pricing"><?php echo nx_e('nav.pricing'); ?></a></li>
          <li><a href="<?php echo nx_esc(nx_url('home')); ?>#features"><?php echo nx_e('nav.features'); ?></a></li>
        </ul>
      </div>

      <div>
        <h4><?php echo nx_e('footer.company'); ?></h4>
        <ul>
          <li><a href="<?php echo nx_esc(nx_url('reseller')); ?>"><?php echo nx_e('nav.reseller'); ?></a></li>
          <li><a href="<?php echo nx_esc(nx_url('contact')); ?>"><?php echo nx_e('nav.contact'); ?></a></li>
          <li><a href="<?php echo nx_esc(nx_url('privacy')); ?>"><?php echo nx_e('nav.privacy'); ?></a></li>
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
      <a class="lang-switch"
         href="<?php echo nx_esc(nx_switch_url()); ?>"
         lang="<?php echo nx_esc(nx_other_locale()); ?>"
         hreflang="<?php echo nx_esc(nx_other_locale()); ?>">
        <?php echo nx_icon('globe'); ?>
        <span><?php echo nx_e('lang.switch'); ?></span>
      </a>
    </div>
  </div>
</footer>

<script src="<?php echo nx_esc(nx_asset('js/site.js')); ?>" defer></script>
</body>
</html>
