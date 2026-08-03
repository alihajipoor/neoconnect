<?php
/**
 * Launch announcement popup.
 *
 * Two things keep this honest rather than pushy:
 *
 *  1. It picks its message from the same free-trial switch the rest of the
 *     site uses. With the trial off it falls back to a plain "we're live"
 *     message, so the popup can never promise a free month that the panel
 *     isn't actually granting.
 *  2. It is rendered hidden and only opened by JavaScript, after a short
 *     delay, and only once per person per message version. With scripting
 *     off it never appears at all -- which is the right failure mode for
 *     something that covers the page.
 *
 * Dismissal is stored in localStorage against announcement_version, so
 * bumping that string in config re-shows a changed message to everyone
 * without nagging people about one they already read.
 */

defined('NX') || exit;

if (!nx_cfg('announcement_enabled', false)) {
    return;
}

$nx_trial = nx_free_trial_enabled();
$nx_variant = $nx_trial ? 'trial' : 'launch';
$nx_days = (int) nx_cfg('free_trial_days', 30);

$nx_key = 'nx-announce-' . nx_locale() . '-' . nx_cfg('announcement_version', '1');
?>
<div class="announce" data-announce data-announce-key="<?php echo nx_esc($nx_key); ?>" hidden>
  <div class="announce__backdrop" data-announce-close></div>

  <div class="announce__card" role="dialog" aria-modal="true"
       aria-labelledby="nx-announce-title" aria-describedby="nx-announce-body">

    <button type="button" class="announce__x" data-announce-close
            aria-label="<?php echo nx_e('announce.close'); ?>">
      <?php echo nx_icon('close'); ?>
    </button>

    <div class="announce__glow" aria-hidden="true"></div>

    <div class="announce__head">
      <span class="announce__mark"><?php echo nx_logo_mark(); ?></span>
      <span class="announce__badge"><?php echo nx_e('announce.badge'); ?></span>
    </div>

    <p class="announce__pill">
      <?php echo nx_e('announce.' . $nx_variant . '.pill', array('days' => $nx_days)); ?>
    </p>

    <h2 id="nx-announce-title" class="announce__title">
      <?php echo nx_e('announce.' . $nx_variant . '.headline'); ?>
    </h2>

    <p id="nx-announce-body" class="announce__body">
      <?php echo nx_e('announce.' . $nx_variant . '.body'); ?>
    </p>

    <div class="announce__actions">
      <a class="btn btn--primary btn--lg" href="<?php echo nx_esc(nx_url('download')); ?>">
        <?php echo nx_icon('download'); ?>
        <?php echo nx_e('announce.cta'); ?>
      </a>
      <button type="button" class="btn btn--ghost" data-announce-close>
        <?php echo nx_e('announce.dismiss'); ?>
      </button>
    </div>

    <p class="announce__note">
      <?php echo nx_e('announce.' . $nx_variant . '.note'); ?>
    </p>
  </div>
</div>
