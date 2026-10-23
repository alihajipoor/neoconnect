<?php
/**
 * The server-location grid, shared by the home page and the features page.
 *
 * Places your traffic comes OUT, and nothing else.
 */

defined('NX') || exit;

$nx_locs = nx_locations();
if (!$nx_locs) {
    return;
}

?>
<ul class="grid grid--auto u-list-reset">
  <?php foreach ($nx_locs as $nx_loc): ?>
    <li class="loc">
      <?php /* aria-hidden: the flag repeats the country name that follows
               it, and a screen reader announcing "flag of Finland Finland"
               helps nobody. Windows renders these as the two letters in a
               box rather than a flag, which is why the name is always
               present as text and never conveyed by the glyph alone. */ ?>
      <?php /* nx_flag_svg, not nx_flag: Windows ships no flag emoji font,
               so the regional-indicator pair renders there as bare letters in
               a box -- on the platform the desktop client targets. */ ?>
      <?php echo nx_flag_svg($nx_loc['code']); ?>
      <span>
        <span class="loc__name"><?php echo nx_esc(nx_pick($nx_loc['country'])); ?></span>
        <?php if (!empty($nx_loc['city'])): ?>
          <span class="loc__meta"><?php echo nx_esc(nx_pick($nx_loc['city'])); ?></span>
        <?php endif; ?>
      </span>
    </li>
  <?php endforeach; ?>

</ul>
