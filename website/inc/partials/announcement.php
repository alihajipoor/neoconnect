<?php
/**
 * Launch banner.
 *
 * A slim card at the top of the home page hero, not a modal. It sits in the
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

// Deliberately NOT keyed by locale. It used to be, and the result was that
// dismissing the banner in English left it still showing in Persian -- the
// same person, the same message, dismissed once, appearing again. One key
// means dismissed once, dismissed everywhere.
$nx_key = 'nx-announce-' . nx_cfg('announcement_version', '1');
?>
<div class="announce" data-announce data-announce-key="<?php echo nx_esc($nx_key); ?>">
  <span class="tag tag--ok"><?php echo nx_icon($nx_glyph); ?><?php echo nx_e('announce.' . $nx_variant . '.pill', array('days' => nx_num($nx_days))); ?></span>
  <p class="announce__text">
    <b><?php echo nx_e('announce.' . $nx_variant . '.headline'); ?></b>
    <span><?php echo nx_e('announce.' . $nx_variant . '.short'); ?></span>
  </p>
  <?php /* Only the script can remember a dismissal, so without it there is
           no close button rather than one that does nothing. The loader in
           head.php hides the card before the first paint for anyone who
           closed it before, so it never shifts the page. */ ?>
  <button type="button" class="announce__x" data-announce-close data-enhanced-only
          aria-label="<?php echo nx_e('announce.close'); ?>"><?php echo nx_icon('close'); ?></button>
</div>
