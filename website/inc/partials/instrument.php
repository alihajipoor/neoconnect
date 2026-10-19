<?php
/**
 * The home page's interactive panel: switch on the kinds of blocking a
 * network does, and watch which connection methods survive.
 *
 * ---------------------------------------------------------------------------
 * IT IS AN ILLUSTRATION, NOT A PROBE. See the long note at the top of
 * inc/content/conditions.php. Nothing here contacts a server or measures
 * anything, the copy underneath says so in both locales, and it must keep
 * saying so.
 * ---------------------------------------------------------------------------
 *
 * EVERYTHING IS RENDERED SERVER-SIDE. With scripting off you still get the
 * complete list of connection methods, each with its transport and the
 * conditions that stop it -- a real, readable table. JavaScript only adds
 * the switching: it toggles classes and rewrites the readout. No content
 * whatsoever depends on the script having run, which is the same rule the
 * rest of the site follows.
 *
 * The strings the script needs are passed as data-* attributes rather than
 * an inline <script> block, because the CSP carries no 'unsafe-inline' and
 * scripts/check-site.php fails the build on any inline script.
 */

defined('NX') || exit;

$nx_protocols = nx_protocols();
$nx_conditions = nx_content('conditions');

if (!$nx_protocols || !$nx_conditions) {
    return;
}

/* Ordered by the client's own try_order, NOT by the order the content file
   happens to list them in.
 *
 * This is what makes the panel demonstrate anything. inc/content/protocols.php
 * lists Stealth (REALITY) first, because that is the order the app's protocol
 * picker shows -- and REALITY is stopped by none of these conditions. Left in
 * that order the top lane survives everything, no handover can ever occur, the
 * handover counter is nailed to zero, and the one thing the panel exists to
 * show never happens.
 *
 * In try_order the client starts on WireGuard, so switching on "UDP blocked"
 * -- far and away the most common thing a visitor will try first -- steps it
 * straight down the list, which is exactly what the real client does. */
usort($nx_protocols, function ($a, $b) {
    $ao = isset($a['try_order']) ? (int) $a['try_order'] : 99;
    $bo = isset($b['try_order']) ? (int) $b['try_order'] : 99;
    if ($ao === $bo) {
        return 0;
    }
    return $ao < $bo ? -1 : 1;
});

/* Strings the script rewrites at runtime. Passed as attributes so both
   locales work without a second copy of the script and without any inline
   JSON block. */
$nx_inst_strings = array(
    'blocked'      => nx_t('home.inst.lane.blocked'),
    'carrying'     => nx_t('home.inst.lane.carrying'),
    'standby'      => nx_t('home.inst.lane.standby'),
    'ready'        => nx_t('home.inst.lane.ready'),
    'flowing'      => nx_t('home.inst.flowing'),
    'flowingrelay' => nx_t('home.inst.flowing_relay'),
    'noroute'      => nx_t('home.inst.no_route'),
    'vopen'        => nx_t('home.inst.verdict.open'),
    'vone'         => nx_t('home.inst.verdict.one'),
    'vmany'        => nx_t('home.inst.verdict.many'),
    'vrelay'       => nx_t('home.inst.verdict.relay'),
    'vdown'        => nx_t('home.inst.verdict.down'),
    'loghand'      => nx_t('home.inst.log.handover'),
    'loglost'      => nx_t('home.inst.log.lost'),
    'lognone'      => nx_t('home.inst.log.none'),
    'logopen'      => nx_t('home.inst.log.open'),
    'logstart'     => nx_t('home.inst.log.start'),
    'logreason'    => nx_t('home.inst.log.reason'),
    'lines'        => nx_t('home.inst.log.lines'),
);

$nx_first = $nx_protocols[0];
?>
<div class="inst" id="nx-inst" data-instrument data-relay="0"
  <?php foreach ($nx_inst_strings as $nx_k => $nx_v): ?>
  data-t-<?php echo $nx_k; ?>="<?php echo nx_esc($nx_v); ?>"
  <?php endforeach; ?>
  >

  <?php /* -- the conditions, as a settings group of switches ---------- */ ?>
  <div class="inst__conds card">
    <p class="inst__ttl" id="inst-conds"><?php echo nx_e('home.inst.conditions'); ?></p>

    <div class="inst__list" role="group" aria-labelledby="inst-conds">
      <?php foreach ($nx_conditions as $nx_c):
        $nx_cid = $nx_c['id'];
        $nx_total = !empty($nx_c['total']);
      ?>
        <label class="sw<?php echo $nx_total ? ' sw--total' : ''; ?>">
          <input type="checkbox" role="switch" data-condition="<?php echo nx_esc($nx_cid); ?>"
                 <?php echo !empty($nx_c['relay']) ? 'data-relay-condition' : ''; ?>
                 <?php echo $nx_total ? 'data-total-condition' : ''; ?>>
          <span class="sw__lb">
            <b><?php echo nx_e('cond.' . $nx_cid . '.label'); ?></b>
            <i><?php echo nx_e('cond.' . $nx_cid . '.sub'); ?></i>
          </span>
          <span class="sw__track" aria-hidden="true"></span>
        </label>
      <?php endforeach; ?>
    </div>

    <?php /* Controls for an enhancement, not for content: hidden without
             JavaScript (see .no-js in home.css). */ ?>
    <div class="inst__condfoot" data-enhanced-only>
      <button type="button" class="btn btn--ghost btn--sm" data-inst-random><?php echo nx_e('home.inst.random'); ?></button>
      <button type="button" class="btn btn--quiet btn--sm" data-inst-clear><?php echo nx_e('home.inst.clear'); ?></button>
    </div>
  </div>

  <?php /* -- the methods, as the app's glass list ---------------------- */ ?>
  <div class="inst__lanes-wrap glass">
    <div class="inst__readout">
      <span class="ro ro--carry">
        <i><?php echo nx_e('home.inst.carrying'); ?></i>
        <b data-carry><?php echo nx_e_pick($nx_first['label']); ?> &middot; <span data-ltr><?php echo nx_esc($nx_first['tech']); ?></span></b>
      </span>
      <span class="ro">
        <i><?php echo nx_e('home.inst.handovers'); ?></i>
        <b data-handovers data-ltr><?php echo nx_esc(nx_num('0')); ?></b>
      </span>
      <span class="ro-live">
        <span class="d" aria-hidden="true"></span>
        <span data-live-text><?php echo nx_e('home.inst.flowing'); ?></span>
      </span>
    </div>

    <ol class="lanes" data-lanes>
      <?php $nx_i = 0; foreach ($nx_protocols as $nx_p): $nx_i++;
        $nx_blocked = isset($nx_p['blocked_by']) ? $nx_p['blocked_by'] : array();
      ?>
        <li class="lane<?php echo $nx_i === 1 ? ' is-active' : ''; ?>"
             data-lane="<?php echo nx_esc($nx_p['id']); ?>"
             data-blocked-by="<?php echo nx_esc(implode(' ', $nx_blocked)); ?>">
          <span class="rk" data-ltr aria-hidden="true"><?php echo nx_num(sprintf('%02d', $nx_i)); ?></span>
          <span class="nm">
            <b><?php echo nx_e_pick($nx_p['label']); ?></b>
            <i data-ltr><?php echo nx_esc($nx_p['tech']); ?></i>
          </span>
          <?php /* The transport, NOT a latency figure: no ms anywhere. */ ?>
          <span class="ms" data-ltr><?php echo nx_esc($nx_p['transport']); ?></span>
          <span class="st">
            <b data-lane-status><?php echo nx_e($nx_i === 1 ? 'home.inst.lane.carrying' : 'home.inst.lane.standby'); ?></b>
            <u><?php echo nx_e('home.inst.lane.via_relay'); ?></u>
          </span>
        </li>
      <?php endforeach; ?>
    </ol>
  </div>

  <?php /* -- the console --------------------------------------------- */ ?>
  <div class="inst__console card">
    <p class="inst__ttl">
      <span><?php echo nx_e('home.inst.log'); ?></span>
      <span data-log-count></span>
    </p>
    <?php /* aria-live off: an ambient readout. The verdict below carries
             the same information as plain text, and is a polite live
             region so a change of switch is announced once.
             tabindex="0": once the lines pass max-height the box scrolls,
             and a scrolling region the keyboard cannot reach fails WCAG
             2.1.1. role="log" names what it is; the explicit aria-live
             overrides the polite default that role carries. */ ?>
    <div class="log" data-log role="log" tabindex="0" aria-live="off" aria-label="<?php echo nx_e('home.inst.log_label'); ?>"></div>
    <p class="verdict" data-verdict aria-live="polite"><?php echo nx_e('home.inst.verdict.open'); ?></p>
  </div>
</div>
