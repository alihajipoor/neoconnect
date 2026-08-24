<?php
/**
 * The server-location grid, shared by the home page and the features page.
 *
 * The relay is rendered after the direct locations and styled differently,
 * because it is not the same kind of thing: the five above are places your
 * traffic comes OUT, and the relay is a place it goes IN. Listing it as a
 * sixth tile would be a quietly false claim about where a customer appears
 * to be.
 *
 * Set $NX_SHOW_RELAY = false before including to render only the direct
 * locations.
 */

defined('NX') || exit;

$nx_locs = nx_locations();
if (!$nx_locs) {
    return;
}

$nx_show_relay = !isset($NX_SHOW_RELAY) || $NX_SHOW_RELAY;
$nx_relay = $nx_show_relay ? nx_relay_location() : null;
?>
<ul class="grid grid--auto u-list-reset">
  <?php foreach ($nx_locs as $nx_loc): ?>
    <li class="loc">
      <?php /* aria-hidden: the flag repeats the country name that follows
               it, and a screen reader announcing "flag of Finland Finland"
               helps nobody. Windows renders these as the two letters in a
               box rather than a flag, which is why the name is always
               present as text and never conveyed by the glyph alone. */ ?>
      <span class="loc__flag" aria-hidden="true"><?php echo nx_flag($nx_loc['code']); ?></span>
      <span>
        <span class="loc__name"><?php echo nx_esc(nx_pick($nx_loc['country'])); ?></span>
        <?php if (!empty($nx_loc['city'])): ?>
          <span class="loc__meta"><?php echo nx_esc(nx_pick($nx_loc['city'])); ?></span>
        <?php endif; ?>
      </span>
    </li>
  <?php endforeach; ?>

  <?php if ($nx_relay): ?>
    <li class="loc loc--relay">
      <span class="loc__flag" aria-hidden="true"><?php echo nx_flag($nx_relay['code']); ?></span>
      <span>
        <span class="loc__name"><?php echo nx_esc(nx_pick($nx_relay['country'])); ?></span>
        <span class="loc__meta"><?php echo nx_e('locations.relay_label'); ?></span>
      </span>
    </li>
  <?php endif; ?>
</ul>
