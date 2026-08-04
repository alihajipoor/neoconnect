<?php
/**
 * Launch banner.
 *
 * An inline strip at the top of the home page, not a modal. It sits in the
 * page flow, so it never covers content, needs no scroll lock or focus
 * management, and is fully visible with JavaScript switched off -- the script
 * only hides it again for someone who has already dismissed it. That is the
 * opposite of the usual popup arrangement, and the right way round: the
 * failure mode is "the message shows", not "the page is blocked".
 *
 * The message follows the same free-trial switch as the rest of the site.
 * With the trial off it falls back to a plain "we're live" line, so this can
 * never advertise a free month the panel is not actually granting.
 *
 * Dismissal is stored against announcement_version, so bumping that string in
 * config re-shows a changed message without nagging people about an old one.
 */

defined('NX') || exit;

if (!nx_cfg('announcement_enabled', false)) {
    return;
}

$nx_trial = nx_free_trial_enabled();
$nx_variant = $nx_trial ? 'trial' : 'launch';
$nx_days = (int) nx_cfg('free_trial_days', 30);
$nx_glyph = $nx_trial ? 'ticket' : 'download';

$nx_key = 'nx-announce-' . nx_locale() . '-' . nx_cfg('announcement_version', '1');
?>
<div class="container banner-wrap">
  <div class="banner" data-announce data-announce-key="<?php echo nx_esc($nx_key); ?>">

    <span class="banner__icon"><?php echo nx_icon($nx_glyph); ?></span>

    <div class="banner__text">
      <p class="banner__title">
        <span class="banner__pill">
          <?php echo nx_e('announce.' . $nx_variant . '.pill', array('days' => $nx_days)); ?>
        </span>
        <span><?php echo nx_e('announce.' . $nx_variant . '.headline'); ?></span>
      </p>
      <p class="banner__body">
        <?php echo nx_e('announce.' . $nx_variant . '.short'); ?>
      </p>
    </div>

    <div class="banner__actions">
      <a class="btn btn--primary" href="<?php echo nx_esc(nx_url('download')); ?>">
        <?php echo nx_e('announce.cta'); ?>
      </a>
      <button type="button" class="banner__x" data-announce-close
              aria-label="<?php echo nx_e('announce.close'); ?>">
        <?php echo nx_icon('close'); ?>
      </button>
    </div>

  </div>
</div>
