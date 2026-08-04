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

// Above the hero, in the flow. Home page only: it never covers the contact or
// reseller form, because it is not on those pages and never covers anything
// anywhere.
require NX_INC . '/partials/announcement.php';
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

    <!--
      The app, drawn in CSS from the real desktop UI. The macOS window and
      the phone are badged "Soon" on purpose: those clients do not exist yet
      and the download page says so, so the hero must not suggest otherwise.

      One text alternative on the wrapper, everything inside aria-hidden --
      it is an illustration, and reading out two dozen mock UI labels would
      help nobody.
    -->
    <div class="mockup" role="img" aria-label="<?php echo nx_e('home.mockup.alt'); ?>">

      <div class="device device--mac" aria-hidden="true">
        <div class="device__bar">
          <span class="device__dots"><i></i><i></i><i></i></span>
        </div>
        <div class="device__body"></div>
        <span class="device__soon">
          <?php echo nx_e('home.mockup.macos'); ?> · <?php echo nx_e('home.mockup.soon'); ?>
        </span>
      </div>

      <div class="device device--win" aria-hidden="true">
        <div class="device__bar">
          <span class="device__dots"><i></i><i></i><i></i></span>
          <span class="device__title"><?php echo nx_e('home.mockup.windows'); ?></span>
        </div>

        <div class="app">
          <div class="app__head">
            <span class="app__brand">
              <?php /* The real app still ships the old bolt mark -- the site
                       is deliberately ahead of it here, same as the renamed
                       windows_asset in config. Update this if the app's own
                       logo lands as something different. */ ?>
              <span class="app__mark"><?php echo nx_logo_mark(); ?></span>
              <?php echo nx_e('brand.name'); ?>
            </span>
            <?php /* Two control pills, matching the settings + sign-out pair
                     the real Dashboard header now carries. */ ?>
            <span class="app__head-actions" aria-hidden="true"><i></i><i></i></span>
          </div>

          <div class="app__card">
            <div class="app__row">
              <span><?php echo nx_e('home.mockup.subscription'); ?></span>
              <span class="app__pill"><?php echo nx_e('home.mockup.status'); ?></span>
            </div>
            <p class="app__muted"><?php echo nx_e('home.mockup.expires'); ?></p>
            <p class="app__muted"><?php echo nx_e('home.mockup.used'); ?></p>
            <div class="app__meter"><i></i></div>
          </div>

          <div class="app__connect">
            <div class="app__orb"><?php echo nx_e('home.mockup.connected'); ?></div>
          </div>

          <div class="app__loc">
            <?php echo nx_icon('map-pin'); ?>
            <?php echo nx_e('home.mockup.location'); ?>
          </div>
        </div>
      </div>

      <div class="device device--phone" aria-hidden="true">
        <span class="phone__notch"></span>
        <div class="phone__screen">
          <div class="app__orb app__orb--sm"><?php echo nx_e('home.mockup.connected'); ?></div>
        </div>
        <span class="device__soon"><?php echo nx_e('home.mockup.soon'); ?></span>
      </div>

    </div>
  </div>
</section>

<!-- ======================== Assurance strip ===================== -->
<div class="assurance">
  <div class="container assurance__inner">
    <?php
    $nx_assurances = array(
        'encrypted' => 'lock',
        'stable'    => 'activity',
        'noconfig'  => 'file-off',
        'switch'    => 'map-pin',
    );
    foreach ($nx_assurances as $nx_key => $nx_glyph): ?>
      <span class="assurance__item">
        <?php echo nx_icon($nx_glyph); ?>
        <?php echo nx_e('home.assure.' . $nx_key); ?>
      </span>
    <?php endforeach; ?>
  </div>
</div>

<!-- ========================== Features ========================== -->
<section class="section" id="features">
  <div class="container">
    <div class="section-head">
      <span class="eyebrow"><?php echo nx_e('home.features.eyebrow'); ?></span>
      <h2><?php echo nx_e('home.features.title'); ?></h2>
    </div>

    <div class="grid grid--3">
      <?php
      // Three, deliberately. Nine cards read as a specification sheet and
      // nobody finishes them; the three below are the questions a buyer
      // actually has -- is it private, will it survive my network, and what
      // control do I get.
      //
      // The strings for the others (access, locations, hotupdate, updates,
      // support, usage) are still in inc/lang/*.php, so swapping one in is a
      // one-line change here rather than a rewrite. Several are already said
      // elsewhere anyway: self-updating on the download page, location
      // switching and stability in the assurance strip above.
      $nx_features = array(
          'encryption' => 'lock',
          'stealth'    => 'shield',
          'custom'     => 'layers',
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

    <div class="grid grid--3 steps-grid">
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

<!-- =========================== Security ========================= -->
<section class="section" id="security">
  <div class="container">
    <div class="section-head">
      <span class="eyebrow"><?php echo nx_e('home.security.eyebrow'); ?></span>
      <h2><?php echo nx_e('home.security.title'); ?></h2>
      <p><?php echo nx_e('home.security.body'); ?></p>
    </div>

    <!-- Shows the encrypted leg ending at our servers rather than running
         all the way to the destination, because that is where a VPN's
         protection actually stops. -->
    <div class="reveal">
      <div class="flow">
        <div class="flow__node">
          <?php echo nx_icon('monitor'); ?>
          <span><?php echo nx_e('home.security.diagram.you'); ?></span>
        </div>

        <div class="flow__link">
          <span class="flow__line"></span>
          <span class="flow__tag">
            <?php echo nx_icon('lock'); ?>
            <?php echo nx_e('home.security.diagram.tunnel'); ?>
          </span>
        </div>

        <div class="flow__node">
          <?php echo nx_icon('server'); ?>
          <span><?php echo nx_e('home.security.diagram.server'); ?></span>
        </div>

        <div class="flow__link flow__link--plain">
          <span class="flow__line"></span>
        </div>

        <div class="flow__node flow__node--end">
          <?php echo nx_icon('globe'); ?>
          <span><?php echo nx_e('home.security.diagram.internet'); ?></span>
        </div>
      </div>

      <p class="flow__caption"><?php echo nx_e('home.security.diagram.caption'); ?></p>
    </div>

    <div class="grid grid--3 u-mt-md">
      <?php foreach (array('point1', 'point2', 'point3') as $nx_i => $nx_key):
        $nx_glyphs = array('shield-check', 'lock', 'file-off');
        ?>
        <article class="card reveal">
          <div class="card__icon"><?php echo nx_icon($nx_glyphs[$nx_i]); ?></div>
          <h3><?php echo nx_e('home.security.' . $nx_key . '.title'); ?></h3>
          <p><?php echo nx_e('home.security.' . $nx_key . '.body'); ?></p>
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
                  // A null cap means an unlimited plan, matching the backend's
                  // nullable dataCapBytes -- not a missing value.
                  if (!isset($nx_plan['data_gb']) || $nx_plan['data_gb'] === null) {
                      echo nx_e('home.pricing.data_unlimited');
                  } else {
                      $nx_amount = nx_format_data($nx_plan['data_gb']);
                      echo $nx_monthly
                          ? nx_e('home.pricing.data', array('amount' => $nx_amount))
                          : nx_e('home.pricing.data_period', array(
                                'amount' => $nx_amount, 'days' => $nx_days));
                  }
                ?></span>
              </li>

              <?php if (!empty($nx_plan['connections'])): ?>
                <li>
                  <?php echo nx_icon('check'); ?>
                  <span><?php echo nx_e('home.pricing.connections', array(
                      'count' => (int) $nx_plan['connections'])); ?></span>
                </li>
              <?php endif; ?>

              <?php
              // Speed is a throttle in the panel, not a headline number, and
              // it is optional per plan -- so this line appears only when a
              // cap is genuinely configured. See inc/content/plans.php.
              $nx_down = !empty($nx_plan['down_mbps']) ? (int) $nx_plan['down_mbps'] : 0;
              $nx_up = !empty($nx_plan['up_mbps']) ? (int) $nx_plan['up_mbps'] : 0;
              if ($nx_down || $nx_up): ?>
                <li>
                  <?php echo nx_icon('check'); ?>
                  <span><?php
                    if ($nx_down && $nx_up) {
                        echo nx_e('home.pricing.speed_both',
                            array('down' => $nx_down, 'up' => $nx_up));
                    } elseif ($nx_down) {
                        echo nx_e('home.pricing.speed_down', array('down' => $nx_down));
                    } else {
                        echo nx_e('home.pricing.speed_up', array('up' => $nx_up));
                    }
                  ?></span>
                </li>
              <?php endif; ?>

              <?php foreach (array('all_modes', 'all_locations', 'relay_routes', 'support') as $nx_perk): ?>
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
      <?php
      // Entries can declare a requirement so the site never advertises
      // something that is switched off in the panel -- see inc/content/faq.php.
      $nx_switches = array(
          'free_trial' => nx_free_trial_enabled(),
          'referrals'  => nx_referrals_enabled(),
      );
      foreach ($nx_faq as $nx_item):
        if (isset($nx_item['requires'])) {
            $nx_req = $nx_item['requires'];
            // An unknown requirement hides the entry rather than showing it:
            // failing closed is the safe direction when the claim might not
            // be true.
            if (empty($nx_switches[$nx_req])) {
                continue;
            }
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
