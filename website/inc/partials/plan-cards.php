<?php
/**
 * The plan cards, shared by the home page and the pricing page.
 *
 * These two used to carry near-identical copies of this markup, which is
 * exactly how a price ends up correct on one page and stale on the other.
 * One renderer, one set of rules.
 *
 * ---------------------------------------------------------------------------
 * EVERY NUMBER COMES FROM inc/content/plans.php, WHICH IS RECONCILED AGAINST
 * THE PANEL'S subscription_plans TABLE. Nothing here is typed by hand.
 *
 * Two plans are deliberately absent from that file and must stay absent:
 *
 *   Trial        isPurchasable = false. It is granted to a new account, not
 *                sold, so it appears as a paragraph below these cards and
 *                never as a card with a buy button -- there is no checkout
 *                behind it.
 *   Ultimate Max isActive = FALSE while isPurchasable = true, which means a
 *                customer could pay $50 for a plan that does not work. It
 *                must not appear anywhere on this site until that is
 *                resolved.
 *
 * No Mbit/s figures render, because down_mbps/up_mbps are null on every
 * current plan -- the panel does not cap them, and advertising a limit that
 * does not exist makes the plans look worse than they are.
 * ---------------------------------------------------------------------------
 *
 * Set $NX_PLAN_COMPACT = true to drop the tagline (the home page's summary).
 */

defined('NX') || exit;

$nx_plan_data = nx_content('plans');
$nx_compact = !empty($NX_PLAN_COMPACT);

if (empty($nx_plan_data['plans'])) {
    return;
}
?>
<div class="plans">
  <?php foreach ($nx_plan_data['plans'] as $nx_plan):
    $nx_days = (int) $nx_plan['duration_days'];
    $nx_monthly = $nx_days === 30;
    $nx_best = !empty($nx_plan['highlight']);
  ?>
    <article class="plan<?php echo $nx_best ? ' plan--featured' : ''; ?>">

      <?php if ($nx_best): ?>
        <span class="plan__badge"><?php echo nx_e('home.pricing.popular'); ?></span>
      <?php endif; ?>

      <p class="plan__name"><?php echo nx_e_pick($nx_plan['name']); ?></p>

      <div class="plan__price">
        <span class="plan__amount" data-ltr><?php echo nx_esc(nx_price($nx_plan['price'])); ?></span>
        <span class="plan__period">
          <?php echo $nx_monthly
              ? nx_e('home.pricing.per_month')
              : nx_e('home.pricing.per_days', array('days' => nx_num($nx_days))); ?>
        </span>
      </div>

      <?php if (!$nx_compact): ?>
        <p class="plan__tagline"><?php echo nx_e_pick($nx_plan['tagline']); ?></p>
      <?php endif; ?>

      <ul class="plan__features">
        <li>
          <?php echo nx_icon('check'); ?>
          <span><?php
            /* data_gb === null means genuinely unlimited (dataCapBytes is
               null in the panel, not a large sentinel). */
            if (!isset($nx_plan['data_gb']) || $nx_plan['data_gb'] === null) {
                echo nx_e('home.pricing.data_unlimited');
            } else {
                $nx_amount = nx_format_data($nx_plan['data_gb']);
                echo $nx_monthly
                    ? nx_e('home.pricing.data', array('amount' => $nx_amount))
                    : nx_e('home.pricing.data_period', array(
                          'amount' => $nx_amount, 'days' => nx_num($nx_days)));
            }
          ?></span>
        </li>

        <?php
        /* array_key_exists, not isset: connections === null is meaningful
           (no device limit at all) and isset() cannot tell it from absent. */
        if (array_key_exists('connections', $nx_plan)):
            $nx_conn = $nx_plan['connections'];
            if ($nx_conn === null) {
                $nx_conn_text = nx_e('home.pricing.connections_unlimited');
            } elseif ((int) $nx_conn === 1) {
                $nx_conn_text = nx_e('home.pricing.connections_one');
            } else {
                $nx_conn_text = nx_e('home.pricing.connections',
                    array('count' => nx_num((int) $nx_conn)));
            }
        ?>
          <li>
            <?php echo nx_icon('check'); ?>
            <span><?php echo $nx_conn_text; ?></span>
          </li>
        <?php endif; ?>

        <?php
        /* Ultimate carries its own perk list, because two lines in the
           default set are the opposite of the truth for it: that plan is
           NOT "every connection option" and NOT "every server location",
           it is one relay path. Stating the restriction plainly is also
           the sell -- that path is what the price buys. */
        $nx_perks = isset($nx_plan['perks']) && is_array($nx_plan['perks'])
            ? $nx_plan['perks']
            : array('all_modes', 'all_locations', 'relay_routes', 'support');

        foreach ($nx_perks as $nx_perk): ?>
          <li>
            <?php echo nx_icon('check'); ?>
            <span><?php echo nx_e('home.pricing.' . $nx_perk); ?></span>
          </li>
        <?php endforeach; ?>
      </ul>

      <?php
      /* The coming_soon branch stays live even though no plan sets it now.
         It was Ultimate's flag, left set after the plan went purchasable on
         2026-08-13, and the site spent weeks showing a dead button on a plan
         customers could buy. Keep the branch; keep the data honest. */
      if (!empty($nx_plan['coming_soon'])): ?>
        <button class="btn btn--ghost btn--block" type="button" disabled aria-disabled="true">
          <?php echo nx_e('home.pricing.coming_soon'); ?>
        </button>
      <?php else: ?>
        <a class="btn <?php echo $nx_best ? 'btn--primary' : 'btn--ghost'; ?> btn--block"
           href="<?php echo nx_esc(nx_buy_url(isset($nx_plan['id']) ? $nx_plan['id'] : '')); ?>">
          <?php echo nx_e('home.pricing.cta'); ?>
        </a>
      <?php endif; ?>
    </article>
  <?php endforeach; ?>
</div>
