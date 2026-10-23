<?php
/**
 * Live mini-widgets: small HTML/CSS recreations of real pieces of the app,
 * in a bento, instead of explanatory cards. Each one moves a little on its
 * own while it is on screen (site.js adds .is-live), and holds still under
 * reduced motion.
 *
 *   speed     the live speed while connected, with its sparkline
 *   apps      per-app routing: generic app tiles and their switches
 *   place     a location going from "Not proven yet" to "Worked here"
 *   theme     the app's own card, turning between light and dark
 *
 * Every figure is an example and says so. No app brand, no method, no
 * route. The mock parts are hidden from assistive technology; each card's
 * title and line say what it shows.
 */

defined('NX') || exit;
?>
<div class="widgets" data-live>
  <article class="wg wg--speed card">
    <div class="wg__mock" aria-hidden="true">
      <div class="sp">
        <div class="sp__row">
          <span class="sp__dir"><?php echo nx_icon('arrow-right', 'sp__down'); ?></span>
          <b class="sp__num" data-ltr><?php echo nx_esc(nx_num('4.2')); ?></b><span class="sp__unit">MB/s</span>
          <span class="sp__up" data-ltr><?php echo nx_icon('arrow-right', 'sp__upi'); ?><?php echo nx_esc(nx_num('0.6')); ?> MB/s</span>
          <span class="wg__ex"><?php echo nx_e('widgets.example'); ?></span>
        </div>
        <div class="sp__chart">
          <svg class="sp__line" viewBox="0 0 800 60" preserveAspectRatio="none" focusable="false">
            <path d="M0 42 C20 38 30 22 50 26 S80 44 100 36 S130 14 150 20 S180 40 200 34 S230 18 250 24 S280 44 300 36 S330 16 350 22 S380 38 400 42 V60 H0Z" class="sp__fill"/><path d="M0 42 C20 38 30 22 50 26 S80 44 100 36 S130 14 150 20 S180 40 200 34 S230 18 250 24 S280 44 300 36 S330 16 350 22 S380 38 400 42 V60 H0Z" class="sp__fill" transform="translate(400 0)"/>
            <path d="M0 42 C20 38 30 22 50 26 S80 44 100 36 S130 14 150 20 S180 40 200 34 S230 18 250 24 S280 44 300 36 S330 16 350 22 S380 38 400 42" class="sp__stroke"/><path d="M0 42 C20 38 30 22 50 26 S80 44 100 36 S130 14 150 20 S180 40 200 34 S230 18 250 24 S280 44 300 36 S330 16 350 22 S380 38 400 42" class="sp__stroke" transform="translate(400 0)"/>
          </svg>
        </div>
      </div>
    </div>
    <h3 class="wg__title"><?php echo nx_e('widgets.speed.title'); ?></h3>
    <p class="wg__line"><?php echo nx_e('widgets.speed.line'); ?></p>
  </article>

  <article class="wg wg--apps card">
    <div class="wg__mock" aria-hidden="true">
      <ul class="ap u-list-reset">
        <?php foreach (array(array('globe', 'a'), array('activity', 'b'), array('monitor', 'c'), array('lock', 'd')) as $nx_i => $nx_a): ?>
          <li class="ap__row ap__row--<?php echo $nx_a[1]; ?>">
            <span class="ap__tile"><?php echo nx_icon($nx_a[0]); ?></span>
            <span class="ap__name"><?php echo nx_e('widgets.apps.' . $nx_a[1]); ?></span>
            <span class="ap__sw"><i class="ap__on"></i><i class="ap__knob"></i></span>
          </li>
        <?php endforeach; ?>
      </ul>
    </div>
    <h3 class="wg__title"><?php echo nx_e('home.features.custom.title'); ?></h3>
    <p class="wg__line"><?php echo nx_e('widgets.apps.line'); ?></p>
  </article>

  <article class="wg wg--place card">
    <div class="wg__mock" aria-hidden="true">
      <div class="pl">
        <?php echo nx_flag_svg('FI'); ?>
        <span class="pl__name"><?php echo nx_esc(nx_pick(array('en' => 'Finland', 'fa' => 'فنلاند'))); ?></span>
        <span class="pl__state">
          <span class="pl__s pl__s--a"><span class="pl__dot"></span><?php echo nx_e('widgets.place.unproven'); ?></span>
          <span class="pl__s pl__s--b"><?php echo nx_icon('check'); ?><?php echo nx_e('widgets.place.worked'); ?></span>
        </span>
      </div>
    </div>
    <h3 class="wg__title"><?php echo nx_e('widgets.place.title'); ?></h3>
    <p class="wg__line"><?php echo nx_e('widgets.place.line'); ?></p>
  </article>

  <article class="wg wg--theme card">
    <div class="wg__mock" aria-hidden="true">
      <div class="tm">
        <?php foreach (array('l', 'd') as $nx_v): ?>
          <div class="tm__card tm__card--<?php echo $nx_v; ?>">
            <span class="tm__word">NEOXIFY</span>
            <span class="tm__chip"><?php echo nx_icon('check'); ?><?php echo nx_e('home.mockup.connected'); ?></span>
            <span class="tm__btn"><?php echo nx_e('home.mockup.disconnect'); ?></span>
          </div>
        <?php endforeach; ?>
      </div>
    </div>
    <h3 class="wg__title"><?php echo nx_e('widgets.theme.title'); ?></h3>
    <p class="wg__line"><?php echo nx_e('widgets.theme.line'); ?></p>
  </article>
</div>
