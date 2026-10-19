<?php
/**
 * Pricing page, shared by /pricing/ and /fa/pricing/.
 *
 * A real page rather than an anchor on the home page, so "neoxify pricing"
 * has somewhere to land, with its own title, description, canonical and
 * structured data.
 *
 * The cards come from inc/content/plans.php, which was reconciled against
 * the live subscription_plans table on 2026-08-24. Read that file's header
 * before changing a number here: two plans are deliberately absent, and
 * the reasons matter.
 */

defined('NX') || exit;

$nx_plans = nx_content('plans');
$nx_list = isset($nx_plans['plans']) ? $nx_plans['plans'] : array();

require NX_INC . '/partials/head.php';
?>

<!-- ============================ Hero ============================ -->
<section class="page-hero page-hero--center">
  <div class="wrap">
    <div class="page-hero__inner">
      <span class="eyebrow"><?php echo nx_e('home.pricing.eyebrow'); ?></span>
      <h1 class="h1"><?php echo nx_e('pricing.title'); ?></h1>
      <p class="lede"><?php echo nx_e('pricing.subtitle'); ?></p>
    </div>
  </div>
</section>

<!-- ============================ Cards ===========================
     inc/partials/plan-cards.php, shared with the home page, so a price
     cannot be right on one page and stale on the other. -->
<section class="section section--tight section--flush-top" aria-labelledby="h-plans">
  <div class="wrap">
    <h2 class="sr-only" id="h-plans"><?php echo nx_e('home.pricing.eyebrow'); ?></h2>
    <?php require NX_INC . '/partials/plan-cards.php'; ?>
    <?php if (nx_free_trial_enabled()): ?>
      <p class="trial"><?php echo nx_icon('ticket'); ?><span><?php echo nx_e('home.pricing.trial', array(
          'days' => nx_num((int) nx_cfg('free_trial_days', 30)))); ?></span></p>
    <?php endif; ?>
    <p class="note"><?php echo nx_e('home.pricing.note'); ?></p>
  </div>
</section>

<!-- ======================== Comparison ========================== -->
<section class="section section--alt" aria-labelledby="h-compare">
  <div class="wrap">
    <div class="section-head">
      <h2 class="h2" id="h-compare"><?php echo nx_e('pricing.compare.title'); ?></h2>
    </div>

    <?php /* No sideways scrolling on a phone: below 760px each row becomes
             its label over one small cell per plan, each cell carrying the
             plan's name (data-label). A table that scrolled sideways hid
             the right-most column -- Ultimate -- on touch devices, which
             draw no scrollbar. */ ?>
    <div class="table-wrap reveal">
        <table class="compare">
          <thead>
            <tr>
              <th scope="col"><?php echo nx_e('pricing.compare.feature'); ?></th>
              <?php foreach ($nx_list as $nx_plan): ?>
                <th scope="col"<?php echo !empty($nx_plan['highlight']) ? ' class="is-featured"' : ''; ?>><?php echo nx_esc(nx_pick($nx_plan['name'])); ?></th>
              <?php endforeach; ?>
            </tr>
          </thead>
          <tbody>
            <?php
            /* [label key => callback returning the cell], declared as data so
               a new row is one entry rather than markup repeated per plan --
               which is how a table ends up disagreeing with the cards. */
            $nx_rows = array(
                'pricing.compare.price' => function ($p) {
                    $days = (int) $p['duration_days'];
                    return '<span class="compare__price" data-ltr>' . nx_esc(nx_price($p['price'])) . '</span>'
                        . ' <span class="plan__period">'
                        . ($days === 30
                            ? nx_e('home.pricing.per_month')
                            : nx_e('home.pricing.per_days', array('days' => nx_num($days))))
                        . '</span>';
                },
                'pricing.compare.data' => function ($p) {
                    return (!isset($p['data_gb']) || $p['data_gb'] === null)
                        ? nx_e('home.pricing.data_unlimited')
                        : nx_esc(nx_format_data($p['data_gb']));
                },
                'pricing.compare.devices' => function ($p) {
                    if (!array_key_exists('connections', $p) || $p['connections'] === null) {
                        return nx_e('home.pricing.connections_unlimited');
                    }
                    return nx_esc(nx_num((int) $p['connections']));
                },
                'pricing.compare.routes' => function ($p) {
                    return !empty($p['relay_only'])
                        ? nx_e('pricing.compare.routes_relay')
                        : nx_e('pricing.compare.routes_standard');
                },
                'pricing.compare.locations' => function ($p) {
                    return !empty($p['relay_only'])
                        ? nx_e('pricing.compare.locations_relay')
                        : nx_e('pricing.compare.locations_all');
                },
                'pricing.compare.protocols' => function ($p) {
                    // Every plan carries every method -- the relay plan
                    // differs by ROUTE, not by protocol.
                    return nx_e('pricing.compare.protocols_all');
                },
                'pricing.compare.support' => function ($p) {
                    return '<span class="yes">' . nx_icon('check') . '</span><span class="sr-only">' . nx_e('common.yes') . '</span>';
                },
            );

            foreach ($nx_rows as $nx_label => $nx_cell): ?>
              <tr>
                <th scope="row"><?php echo nx_e($nx_label); ?></th>
                <?php foreach ($nx_list as $nx_plan): ?>
                  <td data-label="<?php echo nx_esc(nx_pick($nx_plan['name'])); ?>"<?php echo !empty($nx_plan['highlight']) ? ' class="is-featured"' : ''; ?>><?php echo $nx_cell($nx_plan); ?></td>
                <?php endforeach; ?>
              </tr>
            <?php endforeach; ?>
          </tbody>
        </table>
    </div>
  </div>
</section>

<!-- ==================== Trial, payment, vouchers ================ -->
<section class="section" aria-labelledby="h-buying">
  <div class="wrap">
    <h2 class="sr-only" id="h-buying"><?php echo nx_e('pricing.refund.title'); ?></h2>
    <div class="grid grid--3">
      <?php if (nx_free_trial_enabled()): ?>
        <article class="card pillar reveal">
          <span class="ico"><?php echo nx_icon('shield-check'); ?></span>
          <h3><?php echo nx_e('pricing.trial.title'); ?></h3>
          <p><?php echo nx_e('pricing.trial.body'); ?></p>
        </article>
      <?php endif; ?>
      <article class="card pillar reveal">
        <span class="ico"><?php echo nx_icon('chart'); ?></span>
        <h3><?php echo nx_e('pricing.payment.title'); ?></h3>
        <p><?php echo nx_e('pricing.payment.body'); ?></p>
      </article>
      <article class="card pillar reveal">
        <span class="ico"><?php echo nx_icon('ticket'); ?></span>
        <h3><?php echo nx_e('pricing.voucher.title'); ?></h3>
        <p><?php echo nx_e('pricing.voucher.body'); ?></p>
      </article>
    </div>

    <?php /* The refund position, stated plainly rather than implied. No
             money-back guarantee has ever been written down, so the site
             will not hint at one -- the trial is the honest answer. */ ?>
    <div class="callout u-mt-md">
      <?php echo nx_icon('info'); ?>
      <div>
        <p class="callout__title"><?php echo nx_e('pricing.refund.title'); ?></p>
        <p><?php echo nx_e('pricing.refund.body'); ?></p>
      </div>
    </div>
  </div>
</section>

<!-- ============================= FAQ ============================ -->
<section class="section section--alt" aria-labelledby="h-faq">
  <div class="wrap wrap--prose">
    <div class="section-head section-head--center">
      <h2 class="h2" id="h-faq"><?php echo nx_e('home.faq.title'); ?></h2>
    </div>
    <div class="faq">
      <?php foreach (array_slice(nx_visible_faq(), 0, 5) as $nx_item): ?>
        <details>
          <summary><?php echo nx_esc(nx_pick($nx_item['q'])); ?></summary>
          <div class="faq__answer"><p><?php echo nx_esc(nx_pick($nx_item['a'])); ?></p></div>
        </details>
      <?php endforeach; ?>
    </div>
    <p class="u-center u-mt-md">
      <a class="link" href="<?php echo nx_esc(nx_url('faq')); ?>"><?php echo nx_e('home.faq.link'); ?><?php echo nx_icon('arrow-right'); ?></a>
    </p>
  </div>
</section>

<?php require NX_INC . '/partials/footer.php'; ?>
