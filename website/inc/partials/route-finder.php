<?php
/**
 * The route finder: what the app does on a network that is fighting it,
 * drawn as abstract paths from you to the internet.
 *
 * One path lights and meets a wall; it fades and another takes over; the
 * app checks that traffic really flows (a ring turns round the far end);
 * only then does the tick appear and the state read "Connected, checked".
 *
 * WHAT IT MUST NEVER SAY (owner, 2026-10-23): no method's name, no port,
 * no transport, no count of methods, no route or entry point. The paths
 * are abstract and unlabelled, and there are as many as look right, not as
 * many as the app has.
 *
 * Motion: CSS only (transform and opacity, one 12-second cycle). site.js
 * adds .is-run while the figure is on screen and restarts it from the
 * button. Without the script, or under prefers-reduced-motion, the figure
 * simply holds its final frame -- the honest end state.
 *
 * The SVG and the state lines are decoration; the caption says it all in
 * words. In a right-to-left page the drawing mirrors (you on the right).
 */

defined('NX') || exit;

$GLOBALS['nx_rf_seq'] = isset($GLOBALS['nx_rf_seq']) ? $GLOBALS['nx_rf_seq'] + 1 : 1;
$nx_rf = 'rf' . $GLOBALS['nx_rf_seq'];

// Three abstract ways across, 720 x 300; you at (60,150), the internet at
// (660,150). The middle one is the one that meets the wall at x = 392.
$nx_rf_paths = array(
    'a' => 'M60 150C190 34 530 34 660 150',
    'b' => 'M60 150C180 128 290 172 392 150S560 132 660 150',
    'c' => 'M60 150C190 266 530 266 660 150',
);
?>
<figure class="rf" data-route>
  <div class="rf__stage">
    <p class="rf__status" aria-hidden="true">
      <span class="rf__s rf__s--1"><span class="rf__spin"></span><?php echo nx_e('route.state.finding'); ?></span>
      <span class="rf__s rf__s--2"><span class="rf__dot rf__dot--warn"></span><?php echo nx_e('route.state.blocked'); ?></span>
      <span class="rf__s rf__s--3"><span class="rf__spin"></span><?php echo nx_e('route.state.checking'); ?></span>
      <span class="rf__s rf__s--4"><?php echo nx_icon('check'); ?><?php echo nx_e('route.state.done'); ?></span>
    </p>

    <div class="rf__canvas">
    <svg class="rf__svg" viewBox="0 0 720 300" width="720" height="300" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="<?php echo $nx_rf; ?>-g" gradientUnits="userSpaceOnUse" x1="60" y1="0" x2="660" y2="0">
          <stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#22d3ee"/>
        </linearGradient>
        <?php foreach (array('a', 'b') as $nx_k): ?>
          <mask id="<?php echo $nx_rf . '-m' . $nx_k; ?>" maskUnits="userSpaceOnUse" x="0" y="0" width="720" height="300">
            <rect class="rf__wipe rf__wipe--<?php echo $nx_k; ?>" x="40" y="0" width="640" height="300" fill="#fff"/>
          </mask>
        <?php endforeach; ?>
      </defs>

      <?php foreach ($nx_rf_paths as $nx_k => $nx_d): ?>
        <path class="rf__base" d="<?php echo $nx_d; ?>"/>
      <?php endforeach; ?>

      <?php foreach (array('a', 'b') as $nx_k): ?>
        <g class="rf__lit rf__lit--<?php echo $nx_k; ?>" mask="url(#<?php echo $nx_rf . '-m' . $nx_k; ?>)">
          <path class="rf__glow" d="<?php echo $nx_rf_paths[$nx_k]; ?>"/>
          <path class="rf__line" stroke="url(#<?php echo $nx_rf; ?>-g)" d="<?php echo $nx_rf_paths[$nx_k]; ?>"/>
        </g>
      <?php endforeach; ?>

      <g transform="translate(400 150)">
        <g class="rf__wall">
          <rect x="-4" y="-30" width="8" height="60" rx="4"/>
          <path d="M-13 -44l10 10m0 -10l-10 10"/>
        </g>
      </g>

      <g transform="translate(60 150)">
        <circle class="rf__node" r="16"/>
        <circle class="rf__core" r="5"/>
      </g>

      <g transform="translate(660 150)">
        <circle class="rf__ring" r="31"/>
        <circle class="rf__node rf__node--end" r="20"/>
        <g class="rf__tick">
          <circle r="20"/>
          <path d="M-8 1l5 5 11-12"/>
        </g>
      </g>
    </svg>

    <span class="rf__label rf__label--you" aria-hidden="true"><?php echo nx_e('route.you'); ?></span>
    <span class="rf__label rf__label--net" aria-hidden="true"><?php echo nx_e('route.internet'); ?></span>
    </div>
  </div>

  <figcaption class="rf__caption">
    <span><?php echo nx_e('route.caption'); ?></span>
    <button type="button" class="rf__replay" data-route-replay data-enhanced-only><?php echo nx_icon('refresh'); ?><span><?php echo nx_e('route.replay'); ?></span></button>
  </figcaption>
</figure>
