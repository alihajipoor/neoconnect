<?php
/**
 * Pricing page, shared by /pricing/ and /fa/pricing/.
 *
 * New in the 2026-08 rebuild. Pricing previously existed only as
 * /#pricing, an anchor on the home page -- so it could carry no title of
 * its own, no meta description, no canonical URL and no structured data,
 * and the query "neoxify pricing" had no page to land on. An anchor is not
 * a page.
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
  <div class="container">
    <div class="page-hero__inner">
      <span class="eyebrow"><?php echo nx_e('home.pricing.eyebrow'); ?></span>
      <h1><?php echo nx_e('pricing.title'); ?></h1>
      <p class="lead"><?php echo nx_e('pricing.subtitle'); ?></p>
    </div>
  </div>
</section>

<!-- ============================ Cards ===========================
     Rendered by inc/partials/plan-cards.php, shared with the home page.
     The two pages used to carry near-identical copies of this markup, which
     is exactly how a price ends up correct on one page and stale on the
     other. Every number comes from inc/content/plans.php. -->
<section class="section section--tight">
  <?php require NX_INC . '/partials/plan-cards.php'; ?>

  <div class="container">
    <p class="pricing-note"><?php echo nx_e('home.pricing.note'); ?></p>
  </div>
</section>

<!-- ======================== Comparison ========================== -->
<section class="section section--band">
  <div class="container">
    <div class="section-head">
      <h2><?php echo nx_e('pricing.compare.title'); ?></h2>
    </div>

    <?php /* The table is genuinely too wide for a phone and .compare-scroll
             scrolls it, but a touch device draws no scrollbar, so the
             right-most column -- Ultimate, the plan this page most wants
             read -- simply looked absent. Says so, on small screens only. */ ?>
    <p class="compare-hint"><?php echo nx_e('pricing.compare.hint'); ?></p>

    <div class="table-wrap reveal">
      <div class="compare-scroll">
        <table class="compare">
          <thead>
            <tr>
              <th scope="col"><?php echo nx_e('pricing.compare.feature'); ?></th>
              <?php foreach ($nx_list as $nx_plan): ?>
                <th scope="col"<?php echo !empty($nx_plan['highlight']) ? ' class="is-featured"' : ''; ?>>
                  <?php echo nx_esc(nx_pick($nx_plan['name'])); ?>
                </th>
              <?php endforeach; ?>
            </tr>
          </thead>
          <tbody>
            <?php
            /* Each row is [label key, callback returning the cell text].
               Declared as data so a new row is one entry rather than a
               block of markup repeated per plan -- which is how a
               comparison table ends up with a column that disagrees with
               the card above it. */
            $nx_rows = array(
                'pricing.compare.price' => function ($p) {
                    $days = (int) $p['duration_days'];
                    return '<span class="compare__price">' . nx_esc(nx_price($p['price'])) . '</span>'
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
                    // differs by ROUTE, not by protocol. Stating that
                    // stops the relay column reading as a downgrade in a
                    // way it is not.
                    return nx_e('pricing.compare.protocols_all');
                },
                'pricing.compare.support' => function ($p) {
                    return nx_icon('check');
                },
            );

            foreach ($nx_rows as $nx_label => $nx_cell): ?>
              <tr>
                <th scope="row"><?php echo nx_e($nx_label); ?></th>
                <?php foreach ($nx_list as $nx_plan): ?>
                  <td<?php echo !empty($nx_plan['highlight']) ? ' class="is-featured"' : ''; ?>>
                    <?php echo $nx_cell($nx_plan); ?>
                  </td>
                <?php endforeach; ?>
              </tr>
            <?php endforeach; ?>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</section>

<!-- ==================== Trial, payment, vouchers ================ -->
<section class="section">
  <div class="container">
    <div class="grid grid--3">

      <?php if (nx_free_trial_enabled()): ?>
        <article class="pillar reveal">
          <span class="pillar__icon"><?php echo nx_icon('shield-check'); ?></span>
          <h3><?php echo nx_e('pricing.trial.title'); ?></h3>
          <p><?php echo nx_e('pricing.trial.body'); ?></p>
        </article>
      <?php endif; ?>

      <article class="pillar reveal">
        <span class="pillar__icon"><?php echo nx_icon('chart'); ?></span>
        <h3><?php echo nx_e('pricing.payment.title'); ?></h3>
        <p><?php echo nx_e('pricing.payment.body'); ?></p>
      </article>

      <article class="pillar reveal">
        <span class="pillar__icon"><?php echo nx_icon('ticket'); ?></span>
        <h3><?php echo nx_e('pricing.voucher.title'); ?></h3>
        <p><?php echo nx_e('pricing.voucher.body'); ?></p>
      </article>
    </div>

    <?php
    /* The refund position, stated plainly rather than implied. No
       money-back guarantee has ever been written down for this service,
       so the site will not hint at one -- and the trial is the honest
       answer to "what if it does not work on my network". */
    ?>
    <div class="callout u-mt-lg">
      <?php echo nx_icon('info'); ?>
      <div>
        <p class="callout__title"><?php echo nx_e('pricing.refund.title'); ?></p>
        <p><?php echo nx_e('pricing.refund.body'); ?></p>
      </div>
    </div>
  </div>
</section>

<!-- ============================= FAQ ============================ -->
<section class="section section--band">
  <div class="container container--prose">
    <div class="section-head section-head--center">
      <h2><?php echo nx_e('home.faq.title'); ?></h2>
    </div>

    <div class="faq">
      <?php foreach (array_slice(nx_visible_faq(), 0, 5) as $nx_item): ?>
        <details>
          <summary><?php echo nx_esc(nx_pick($nx_item['q'])); ?></summary>
          <div class="faq__answer"><?php echo nx_esc(nx_pick($nx_item['a'])); ?></div>
        </details>
      <?php endforeach; ?>
    </div>

    <p class="u-center u-mt-lg">
      <a class="section-link" href="<?php echo nx_esc(nx_url('faq')); ?>">
        <?php echo nx_e('home.faq.link'); ?>
        <?php echo nx_icon('arrow-right'); ?>
      </a>
    </p>
  </div>
</section>

<?php require NX_INC . '/partials/footer.php'; ?>
