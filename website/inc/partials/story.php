<?php
/**
 * The scroll story: the real app, pinned, while four short beats scroll
 * past. The screens are the apps' own -- rendered from apps/mobile and
 * apps/desktop-windows preview.html (sample account, example address) --
 * in four states: not connected, connecting, checking, connected and
 * verified with the country lit.
 *
 * EVERY FRAME IS SCRUBBED before capture: no method or protocol name and
 * no relay UI appears in any of them (owner's rule, 2026-10-23). Re-render
 * them with the same scrub if the apps change.
 *
 * Motion: CSS scroll-driven animations only. Each beat is a view timeline;
 * the screen for that beat fades in over the one before as the beat
 * reaches the middle of the screen. Where that is unsupported, or motion
 * is reduced, the device simply shows the final state -- connected,
 * verified -- and the beats read as plain text.
 *
 * The screenshots are illustration (alt=""): the beats say everything in
 * words, and the caption says what the pictures are.
 */

defined('NX') || exit;

$nx_story_lang = nx_locale() === 'fa' ? 'fa' : 'en';
$nx_story_states = array(1 => 'idle', 2 => 'connecting', 3 => 'checking', 4 => 'connected');
$nx_story_img = function ($app, $theme, $state) use ($nx_story_lang) {
    return nx_asset('img/story/' . $app . '-' . $nx_story_lang . '-' . $theme . '-' . $state . '.webp');
};
?>
<div class="story">
  <div class="story__beats">
    <?php foreach ($nx_story_states as $nx_n => $nx_state): ?>
      <article class="beat beat--<?php echo $nx_n; ?>">
        <span class="beat__state beat__state--<?php echo $nx_state; ?>"><span class="beat__dot" aria-hidden="true"></span><?php echo nx_e('story.' . $nx_n . '.state'); ?></span>
        <h3 class="beat__title"><?php echo nx_e('story.' . $nx_n . '.title'); ?></h3>
        <p class="beat__body"><?php echo nx_e('story.' . $nx_n . '.body'); ?></p>
      </article>
    <?php endforeach; ?>
  </div>

  <figure class="story__stage">
    <div class="story__pin">
      <div class="story__desk">
        <span class="story__bar" aria-hidden="true"><i></i><i></i><i></i></span>
        <div class="story__screens">
          <?php foreach ($nx_story_states as $nx_n => $nx_state): foreach (array('light', 'dark') as $nx_t): ?>
            <img class="shot shot--<?php echo $nx_n; ?> only-<?php echo $nx_t; ?>" src="<?php echo nx_esc($nx_story_img('desk', $nx_t, $nx_state)); ?>"
                 width="944" height="608" loading="lazy" decoding="async" alt="">
          <?php endforeach; endforeach; ?>
        </div>
      </div>
      <div class="story__phone">
        <div class="story__screens">
          <?php foreach ($nx_story_states as $nx_n => $nx_state): foreach (array('light', 'dark') as $nx_t): ?>
            <img class="shot shot--<?php echo $nx_n; ?> only-<?php echo $nx_t; ?>" src="<?php echo nx_esc($nx_story_img('phone', $nx_t, $nx_state)); ?>"
                 width="577" height="1281" loading="lazy" decoding="async" alt="">
          <?php endforeach; endforeach; ?>
        </div>
      </div>
    </div>
    <figcaption class="story__caption"><?php echo nx_e('story.caption'); ?></figcaption>
  </figure>
</div>
