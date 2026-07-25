<?php
/**
 * Home page template, shared by /index.php and /fa/index.php.
 *
 * Everything visible here comes from inc/lang/*.php, inc/content/plans.php
 * and inc/content/faq.php -- no copy is hardcoded in this file, so the
 * Persian page is a genuine translation rather than a second layout.
 */

defined('NX') || exit;

$nx_plans = nx_content('plans');
$nx_faq = nx_content('faq');
$nx_has_windows = nx_windows_available();

require NX_INC . '/partials/head.php';
?>

<!-- ============================ Hero ============================ -->
<section class="hero">
  <div class="container hero__inner">

    <div>
      <span class="eyebrow"><?php echo nx_e('home.hero.eyebrow'); ?></span>
      <h1>
        <span><?php echo nx_e('home.hero.title'); ?></span>
        <span class="gradient-text"><?php echo nx_e('home.hero.title_accent'); ?></span>
      </h1>
      <p class="lead"><?php echo nx_e('home.hero.subtitle'); ?></p>

      <div class="hero__actions">
        <a class="btn btn--primary btn--lg" href="<?php echo nx_esc(nx_url('download')); ?>">
          <?php echo nx_icon('download'); ?>
          <?php echo $nx_has_windows
              ? nx_e('home.hero.cta_primary')
              : nx_e('home.hero.cta_primary_soon'); ?>
        </a>
        <a class="btn btn--ghost btn--lg" href="#pricing">
          <?php echo nx_e('home.hero.cta_secondary'); ?>
        </a>
      </div>

      <p class="hero__note">
        <?php echo $nx_has_windows
            ? nx_e('home.hero.note_available')
            : nx_e('home.hero.note_soon'); ?>
      </p>
    </div>

    <!-- Decorative only: it illustrates "three protocols, one app" without
         claiming any specific measured figure. -->
    <div class="hero__visual" aria-hidden="true">
      <div class="hero__rows">
        <div class="proto-row">
          <span class="proto-row__dot"></span>
          <span class="proto-row__name">WireGuard</span>
          <span class="proto-row__meta">UDP</span>
        </div>
        <div class="proto-row">
          <span class="proto-row__dot"></span>
          <span class="proto-row__name">VLESS + REALITY</span>
          <span class="proto-row__meta">TCP / TLS</span>
        </div>
        <div class="proto-row">
          <span class="proto-row__dot"></span>
          <span class="proto-row__name">OpenVPN</span>
          <span class="proto-row__meta">UDP / TCP</span>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- ========================== Features ========================== -->
<section class="section" id="features">
  <div class="container">
    <div class="section-head">
      <span class="eyebrow"><?php echo nx_e('home.features.eyebrow'); ?></span>
      <h2><?php echo nx_e('home.features.title'); ?></h2>
    </div>

    <div class="grid grid--3">
      <?php
      $nx_features = array(
          'protocols'  => 'layers',
          'reality'    => 'shield',
          'relay'      => 'route',
          'hotupdate'  => 'activity',
          'locations'  => 'map-pin',
          'usage'      => 'chart',
      );
      foreach ($nx_features as $nx_key => $nx_glyph): ?>
        <article class="card reveal">
          <div class="card__icon"><?php echo nx_icon($nx_glyph); ?></div>
          <h3><?php echo nx_e('home.features.' . $nx_key . '.title'); ?></h3>
          <p><?php echo nx_e('home.features.' . $nx_key . '.body'); ?></p>
        </article>
      <?php endforeach; ?>
    </div>
  </div>
</section>

<!-- ========================== How it works ====================== -->
<section class="section section--tight">
  <div class="container">
    <div class="section-head section-head--center">
      <span class="eyebrow"><?php echo nx_e('home.steps.eyebrow'); ?></span>
      <h2><?php echo nx_e('home.steps.title'); ?></h2>
    </div>

    <div class="grid grid--3">
      <?php for ($nx_i = 1; $nx_i <= 3; $nx_i++): ?>
        <div class="step reveal">
          <div class="step__num"><?php echo $nx_i; ?></div>
          <h3><?php echo nx_e('home.steps.' . $nx_i . '.title'); ?></h3>
          <p><?php echo nx_e('home.steps.' . $nx_i . '.body'); ?></p>
        </div>
      <?php endfor; ?>
    </div>
  </div>
</section>

<!-- ========================== Technology ======================== -->
<section class="section">
  <div class="container">
    <div class="section-head">
      <span class="eyebrow"><?php echo nx_e('home.tech.eyebrow'); ?></span>
      <h2><?php echo nx_e('home.tech.title'); ?></h2>
      <p><?php echo nx_e('home.tech.body'); ?></p>
    </div>

    <div class="grid grid--3">
      <?php foreach (array('wireguard', 'reality', 'openvpn') as $nx_key): ?>
        <article class="card reveal">
          <h3><?php echo nx_e('home.tech.' . $nx_key . '.title'); ?></h3>
          <p><?php echo nx_e('home.tech.' . $nx_key . '.body'); ?></p>
        </article>
      <?php endforeach; ?>
    </div>
  </div>
</section>

<!-- =========================== Pricing ========================== -->
<section class="section" id="pricing">
  <div class="container">
    <div class="section-head section-head--center">
      <span class="eyebrow"><?php echo nx_e('home.pricing.eyebrow'); ?></span>
      <h2><?php echo nx_e('home.pricing.title'); ?></h2>
      <p><?php echo nx_e('home.pricing.subtitle'); ?></p>
    </div>

    <div class="grid grid--3">
      <?php foreach ($nx_plans['plans'] as $nx_plan):
        $nx_days = (int) $nx_plan['duration_days'];
        $nx_monthly = $nx_days === 30;
        ?>
        <div class="plan-wrap reveal">
          <?php if (!empty($nx_plan['highlight'])): ?>
            <span class="plan__badge"><?php echo nx_e('home.pricing.popular'); ?></span>
          <?php endif; ?>

          <article class="plan<?php echo !empty($nx_plan['highlight']) ? ' plan--featured' : ''; ?>">
            <div class="plan__name"><?php echo nx_esc(nx_pick($nx_plan['name'])); ?></div>
            <p class="plan__tagline"><?php echo nx_esc(nx_pick($nx_plan['tagline'])); ?></p>

            <div class="plan__price">
              <span class="plan__amount"><?php echo nx_esc(nx_price($nx_plan['price'])); ?></span>
              <span class="plan__period">
                <?php echo $nx_monthly
                    ? nx_e('home.pricing.per_month')
                    : nx_e('home.pricing.per_days', array('days' => $nx_days)); ?>
              </span>
            </div>

            <ul class="plan__features">
              <li>
                <?php echo nx_icon('check'); ?>
                <span><?php
                  $nx_amount = nx_format_data($nx_plan['data_gb']);
                  echo $nx_monthly
                      ? nx_e('home.pricing.data', array('amount' => $nx_amount))
                      : nx_e('home.pricing.data_period', array(
                            'amount' => $nx_amount, 'days' => $nx_days));
                ?></span>
              </li>

              <?php if (!empty($nx_plan['connections'])): ?>
                <li>
                  <?php echo nx_icon('check'); ?>
                  <span><?php echo nx_e('home.pricing.connections', array(
                      'count' => (int) $nx_plan['connections'])); ?></span>
                </li>
              <?php endif; ?>

              <?php foreach (array('all_protocols', 'all_locations', 'relay_routes', 'support') as $nx_perk): ?>
                <li>
                  <?php echo nx_icon('check'); ?>
                  <span><?php echo nx_e('home.pricing.' . $nx_perk); ?></span>
                </li>
              <?php endforeach; ?>
            </ul>

            <a class="btn <?php echo !empty($nx_plan['highlight']) ? 'btn--primary' : 'btn--ghost'; ?> btn--block"
               href="<?php echo nx_esc(nx_url('download')); ?>">
              <?php echo nx_e('home.pricing.cta'); ?>
            </a>
          </article>
        </div>
      <?php endforeach; ?>
    </div>

    <?php if (nx_free_trial_enabled()): ?>
      <p class="trial-banner">
        <?php echo nx_e('home.pricing.trial', array(
            'days' => (int) nx_cfg('free_trial_days', 30))); ?>
      </p>
    <?php endif; ?>

    <p class="pricing-note"><?php echo nx_e('home.pricing.note'); ?></p>
  </div>
</section>

<!-- ============================= FAQ ============================ -->
<section class="section section--tight">
  <div class="container">
    <div class="section-head section-head--center">
      <span class="eyebrow"><?php echo nx_e('home.faq.eyebrow'); ?></span>
      <h2><?php echo nx_e('home.faq.title'); ?></h2>
    </div>

    <div class="faq">
      <?php foreach ($nx_faq as $nx_item):
        // Entries can declare a requirement so the site never advertises
        // something that is switched off -- see inc/content/faq.php.
        if (isset($nx_item['requires'])
            && $nx_item['requires'] === 'free_trial'
            && !nx_free_trial_enabled()) {
            continue;
        }
        ?>
        <details>
          <summary><?php echo nx_esc(nx_pick($nx_item['q'])); ?></summary>
          <div class="faq__answer"><?php echo nx_esc(nx_pick($nx_item['a'])); ?></div>
        </details>
      <?php endforeach; ?>
    </div>
  </div>
</section>

<!-- ============================= CTA ============================ -->
<section class="section section--tight">
  <div class="container">
    <div class="cta-band">
      <h2><?php echo nx_e('home.cta.title'); ?></h2>
      <p><?php echo nx_e('home.cta.body'); ?></p>
      <a class="btn btn--primary btn--lg" href="<?php echo nx_esc(nx_url('download')); ?>">
        <?php echo nx_e('home.cta.button'); ?>
        <span class="icon-arrow"><?php echo nx_icon('arrow-right'); ?></span>
      </a>
    </div>
  </div>
</section>

<?php require NX_INC . '/partials/footer.php'; ?>
