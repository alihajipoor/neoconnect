<?php
/**
 * The closing call to action used under content pages: a glass panel with
 * the one primary action and the plans as the alternative.
 *
 * Set $NX_CTA_LEVEL = 'h2' or 'h3' before including, so the heading fits
 * the outline of the page it lands on (default h3: it usually follows a
 * section's own h2).
 */

defined('NX') || exit;

$nx_cta_level = isset($NX_CTA_LEVEL) && in_array($NX_CTA_LEVEL, array('h2', 'h3'), true) ? $NX_CTA_LEVEL : 'h3';
?>
<div class="cta-band glass reveal">
  <span class="cta-band__glow" aria-hidden="true"></span>
  <<?php echo $nx_cta_level; ?> class="h2"><?php echo nx_e('home.cta.title'); ?></<?php echo $nx_cta_level; ?>>
  <p class="lede"><?php echo nx_e('home.cta.body'); ?></p>
  <div class="u-row u-row--center">
    <a class="btn btn--primary btn--lg" href="<?php echo nx_esc(nx_url('download')); ?>">
      <span><?php echo nx_e('home.cta.button'); ?></span>
      <span class="icon-arrow"><?php echo nx_icon('arrow-right'); ?></span>
    </a>
    <a class="btn btn--ghost btn--lg" href="<?php echo nx_esc(nx_url('pricing')); ?>"><?php echo nx_e('home.hero.cta_secondary'); ?></a>
  </div>
</div>
